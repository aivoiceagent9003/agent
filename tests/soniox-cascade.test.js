import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── Fakes for everything the engine talks to ─────────────────────────────────
// Soniox STT is a websocket, Soniox TTS is fetch, the brain is OpenAI streaming.
// The telephony sink records what the caller would have heard.

// vi.mock factories are hoisted above everything else, so the state they share
// with the tests has to be hoisted with them.
const { sockets, llmScript, llmCalls, rejectEfforts, streamEfforts, transferToHuman } = vi.hoisted(() => ({
  sockets: [], llmScript: [], llmCalls: [],
  rejectEfforts: [],   // reasoning_effort values the fake model refuses with a 400
  streamEfforts: [],   // reasoning_effort sent on each streamed request, refused or not
  transferToHuman: vi.fn(async () => true),
}))

// Only the network half is faked: detect/strip are pure, and a test that reimplements
// them would keep passing after the real ones broke.
vi.mock('../src/services/handoff.js', async (importOriginal) => ({
  ...(await importOriginal()),
  transferToHuman,
}))

vi.mock('ws', async () => {
  const { EventEmitter } = await import('node:events')
  class FakeWS extends EventEmitter {
    static OPEN = 1
    constructor(url) {
      super()
      this.url = url
      this.readyState = 0
      this.sent = []
      sockets.push(this)
      setTimeout(() => { this.readyState = 1; this.emit('open') }, 0)
    }
    send(d) { this.sent.push(d) }
    close() { this.readyState = 3 }
  }
  return { default: FakeWS }
})

// llmScript: one entry per chat.completions.create call — the chunks it streams.
vi.mock('openai', () => ({
  default: class {
    constructor() {
      this.chat = {
        completions: {
          create: async (params) => {
            if (params.stream) streamEfforts.push(params.reasoning_effort ?? null)
            if (params.reasoning_effort && rejectEfforts.includes(params.reasoning_effort)) {
              throw Object.assign(new Error('400 unsupported reasoning_effort'), { status: 400 })
            }
            // The call-start warmup is a non-streamed 1-token request; it is not a turn.
            if (!params.stream) return { usage: { prompt_tokens: 1000, completion_tokens: 1 } }
            llmCalls.push(structuredClone(params.messages))
            const chunks = llmScript.shift() || []
            return (async function* () { for (const c of chunks) yield c })()
          },
        },
      }
    }
  },
}))

vi.mock('../src/services/llm.js', () => ({ buildSystemPrompt: () => 'SYSTEM PROMPT' }))
vi.mock('../src/services/rag.js', () => ({ retrieveKnowledge: vi.fn(async () => 'kb text'), warmupRAG: vi.fn() }))
vi.mock('../src/services/greeting.js', () => ({ resolveGreeting: () => 'Namaste. How can I help you?' }))
vi.mock('../src/services/dnd.js', () => ({ addToDnd: vi.fn(async () => ({ ok: true })) }))
vi.mock('../src/services/whatsapp.js', () => ({ whatsappReady: () => false }))
vi.mock('../src/services/lookups.js', () => ({ runLookup: vi.fn(async () => 'row') }))
vi.mock('../src/services/agent-tools.js', () => ({
  buildAgentTools: () => [{ functionDeclarations: [{ name: 'end_call', description: 'hang up', parameters: { type: 'object', properties: {} } }] }],
  handleSendWhatsapp: vi.fn(),
  noKnowledgeInstruction: () => 'No matching knowledge found.',
  NO_KNOWLEDGE: 'No matching knowledge found.',
}))
// A trace that records what the engine writes to it. The engine only ever writes
// through `set`/`bump`, so the stub can be inert and still be observed — and the
// post-call pipeline reads some of those fields (dominantLanguage feeds the lead
// extractor), which makes them worth asserting rather than discarding.
const traceState = vi.hoisted(() => ({ state: {} }))
vi.mock('../src/services/telemetry.js', () => {
  const span = () => ({ end: () => {} })
  const trace = {
    startedAt: Date.now(),
    state: traceState.state,
    set(k, v) { traceState.state[k] = v; return trace },
    bump(k, by = 1) { traceState.state[k] = (traceState.state[k] || 0) + by; return trace },
    event: () => trace,
    span,
    tenantId: 't1',
  }
  return {
    default: {
      getTrace: () => trace,
      incr: vi.fn(),
      recordLatency: vi.fn(),
      recordServiceEvent: vi.fn(),
    },
  }
})

// ── Helpers ──────────────────────────────────────────────────────────────────
const text = (s) => ({ choices: [{ delta: { content: s } }] })
const stop = () => ({ choices: [{ delta: {}, finish_reason: 'stop' }] })
const usage = () => ({ choices: [], usage: { prompt_tokens: 1200, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 1000 } } })
const toolCall = (name) => [
  { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name, arguments: '{}' } }] } }] },
  { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
]
const tick = (ms = 15) => new Promise(r => setTimeout(r, ms))
/** Wait for a condition instead of guessing how long it takes. */
async function waitFor(cond, { timeout = 2000, step = 10 } = {}) {
  const until = Date.now() + timeout
  while (Date.now() < until) {
    if (cond()) return true
    await tick(step)
  }
  return false
}

let ttsRequests
let holdTts           // when set, TTS responses wait for release()
function installFetch() {
  ttsRequests = []
  globalThis.fetch = vi.fn(async (url, opts) => {
    const body = JSON.parse(opts.body)
    ttsRequests.push(body)
    if (holdTts) await holdTts.promise
    return {
      ok: true,
      body: (async function* () { yield new TextEncoder().encode(`[${body.text}]`) })(),
    }
  })
}

function makeSink() {
  return {
    readyState: 1,
    frames: [],
    send(s) { this.frames.push(JSON.parse(s)) },
    endCall: vi.fn(),
    msRemaining: () => 0,
  }
}
// What the caller heard, in order: the TTS text each audio frame came from.
const heard = (sink) => sink.frames.filter(f => f.event === 'media').map(f => Buffer.from(f.media.payload, 'base64').toString())

function sttSays(ws, words, { final = true, end = true, endMs = 900, language } = {}) {
  const tokens = [{ text: words, is_final: final, end_ms: endMs, ...(language ? { language } : {}) }]
  if (end) tokens.push({ text: '<end>', is_final: true })
  ws.emit('message', Buffer.from(JSON.stringify({ tokens })))
}

let createSonioxCascadeConnection
// Module-level settings (provider, filler) are read at import, so a test that needs
// different ones re-imports the engine after changing the environment.
async function loadEngine(env = {}) {
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v)
  vi.resetModules()
  ;({ createSonioxCascadeConnection } = await import('../src/services/soniox-cascade.js'))
}
beforeEach(async () => {
  vi.stubEnv('SONIOX_API_KEY', 'test-key')
  // These cover the REST fallback. The streaming path, which is the production
  // default, has its own block at the bottom of this file.
  vi.stubEnv('SONIOX_TTS_STREAMING', 'false')
  vi.stubEnv('CASCADE_LOOKUP_FILLER', 'false')   // on in production; tested on its own below
  // These tests drive the engine through the mocked OpenAI SDK, which is the
  // compatibility path (still used by OpenAI tenants). Gemini's NATIVE path speaks raw
  // HTTP and carries the prompt cache; it has its own tests in gemini-native.test.js
  // and gemini-cache.test.js, and a wiring test at the bottom of this file.
  vi.stubEnv('CASCADE_GEMINI_NATIVE', 'false')
  sockets.length = 0
  llmScript.length = 0
  llmCalls.length = 0
  rejectEfforts.length = 0
  streamEfforts.length = 0
  holdTts = null
  installFetch()
  await loadEngine()
})
afterEach(() => vi.unstubAllEnvs())

// Both STT and TTS are websockets now, so they are told apart by URL rather than by
// the order they happened to be constructed in.
const sttSocket = () => sockets.find(s => s.url.includes('stt-rt'))
// The latest one: a barge-in drops the TTS socket and the next sentence opens another.
const ttsSocket = () => sockets.filter(s => s.url.includes('tts-rt')).at(-1)

async function startCall(sink = makeSink(), onTranscript = vi.fn(), cfg = {}) {
  const onReady = vi.fn()
  const engine = createSonioxCascadeConnection('CA1', { tenant_id: 't1', ...cfg }, sink, 'S1', onTranscript, onReady, '+919000000000')
  await tick()
  return { engine, sink, ws: sttSocket(), onReady, onTranscript }
}

// ── Tests ────────────────────────────────────────────────────────────────────
describe('soniox cascade — session setup', () => {
  it('configures Soniox STT for 8k µ-law with endpoint detection, then signals ready', async () => {
    const { ws, onReady } = await startCall()
    const cfg = JSON.parse(ws.sent[0])
    expect(cfg).toMatchObject({ audio_format: 'mulaw', sample_rate: 8000, num_channels: 1, enable_endpoint_detection: true })
    expect(cfg.language_hints).toEqual(['te', 'hi', 'en'])
    expect(onReady).toHaveBeenCalledOnce()
  })

  it('speaks the greeting sentence by sentence, with no full stops sent to the voice', async () => {
    const { sink } = await startCall()
    await tick()
    expect(ttsRequests.map(r => r.text)).toEqual(['Namaste', 'How can I help you?'])
    expect(heard(sink)).toEqual(['[Namaste]', '[How can I help you?]'])
    expect(ttsRequests[0]).toMatchObject({ audio_format: 'pcm_mulaw', sample_rate: 8000 })
  })
})

describe('soniox cascade — a turn', () => {
  it('answers when Soniox marks the end of the caller turn, streaming sentences to the voice in order', async () => {
    const { ws, sink, onTranscript } = await startCall()
    await waitFor(() => ttsRequests.length > 0)   // the greeting, before we clear it
    sink.frames.length = 0
    ttsRequests.length = 0

    llmScript.push([text('సరే అండి. '), text('ఇంకా ఏమైనా '), text('కావాలా?'), stop(), usage()])
    sttSays(ws, 'term insurance kavali')
    await tick(40)

    expect(llmCalls[0].filter(m => m.role === 'user').at(-1)).toEqual({ role: 'user', content: 'term insurance kavali' })
    expect(ttsRequests.map(r => r.text)).toEqual(['సరే అండి', 'ఇంకా ఏమైనా కావాలా?'])
    expect(ttsRequests.every(r => r.language === 'te')).toBe(true)
    expect(heard(sink)).toEqual(['[సరే అండి]', '[ఇంకా ఏమైనా కావాలా?]'])
    expect(onTranscript).toHaveBeenCalledWith('term insurance kavali', 'user')
    expect(onTranscript).toHaveBeenCalledWith('సరే అండి. ఇంకా ఏమైనా కావాలా?', 'assistant')
  })

  it('does not respond to words the STT has not finished a turn on', async () => {
    const { ws } = await startCall()
    await tick()
    sttSays(ws, 'term insurance', { end: false })
    await tick()
    expect(llmCalls).toHaveLength(0)
  })

  it('plays sentences in order even when a later one is synthesised first', async () => {
    const { ws, sink } = await startCall()
    await tick()
    sink.frames.length = 0
    // First sentence's TTS is slow; the second comes back immediately.
    let releaseFirst
    const firstGate = new Promise(r => { releaseFirst = r })
    globalThis.fetch = vi.fn(async (url, opts) => {
      const body = JSON.parse(opts.body)
      if (body.text === 'One') await firstGate
      return { ok: true, body: (async function* () { yield new TextEncoder().encode(`[${body.text}]`) })() }
    })
    llmScript.push([text('One. Two. '), text('Three.'), stop()])
    sttSays(ws, 'hello there')
    await tick(30)
    expect(heard(sink)).toEqual([])          // nothing may jump the queue
    releaseFirst()
    await tick(30)
    expect(heard(sink)).toEqual(['[One]', '[Two]', '[Three]'])
  })
})

describe('soniox cascade — lookups', () => {
  it('overlaps independent KB reads and preserves their tool result order', async () => {
    const { retrieveKnowledge } = await import('../src/services/rag.js')
    let releaseFirst
    const first = new Promise(resolve => { releaseFirst = resolve })
    let secondStarted = false
    retrieveKnowledge.mockImplementationOnce(() => first)
    retrieveKnowledge.mockImplementationOnce(async () => { secondStarted = true; return 'Supreme facts' })
    const { ws } = await startCall()
    llmScript.push([
      { choices: [{ delta: { tool_calls: [
        { index: 0, id: 'kb1', function: { name: 'search_knowledge', arguments: '{"query":"Secure"}' } },
        { index: 1, id: 'kb2', function: { name: 'search_knowledge', arguments: '{"query":"Supreme"}' } },
      ] } }] }, stop(),
    ])
    llmScript.push([text('Here are the differences.'), stop()])
    sttSays(ws, 'compare these plans')
    await tick(40)
    const overlapped = secondStarted
    releaseFirst('Secure facts')
    await tick(60)
    expect(overlapped).toBe(true)
    expect(llmCalls[1].filter(m => m.role === 'tool').map(m => [m.tool_call_id, m.content])).toEqual([
      ['kb1', 'Secure facts'], ['kb2', 'Supreme facts'],
    ])
  })

  // These two used to assert that a knowledge search stayed SILENT. That was the old
  // product decision, and measurement is what overturned it: a knowledge turn left the
  // caller with ~4.2s of nothing, because the search has to run and then the model has
  // to be asked a second time with the result. The silence was the only removable part.
  it('says something true while a knowledge search actually runs', async () => {
    // The lines are rendered once per process and only spoken when already rendered,
    // so the warm-up has to have run before a turn can be masked.
    await loadEngine({ CASCADE_ACK: 'true', CASCADE_ACK_WARM_DELAY_MS: '0' })
    const { ws, sink } = await startCall()
    await tick(60)
    sink.frames.length = 0
    llmScript.push(toolCall('search_knowledge'))
    llmScript.push([text('Sanjeevani 2001 లో స్థాపించబడింది.'), stop()])
    sttSays(ws, 'సంజీవని గురించి చెప్తారా?', { language: 'te' })
    await tick(60)
    const spoken = heard(sink)
    expect(spoken).toHaveLength(2)
    // The acknowledgement comes first, in the caller's language, and never claims a result.
    expect(spoken[0]).toMatch(/[ఀ-౿]/)
    expect(spoken[0]).not.toMatch(/2001|రెండు వేల/)
    // …and the real answer follows it, unchanged.
    expect(spoken[1]).toBe('[Sanjeevani two thousand one లో స్థాపించబడింది]')
  })

  it('acknowledges an English caller in English', async () => {
    await loadEngine({ CASCADE_ACK: 'true', CASCADE_ACK_WARM_DELAY_MS: '0' })
    const { ws, sink } = await startCall()
    await tick(60)
    sink.frames.length = 0
    llmScript.push(toolCall('search_knowledge'))
    llmScript.push([text('It was founded in 2001.'), stop()])
    sttSays(ws, 'when was Sanjeevani founded', { language: 'en' })
    await tick(60)
    const spoken = heard(sink)
    expect(spoken).toHaveLength(2)
    expect(spoken[0]).toMatch(/^\[(Sure|Let me|One second)/)
    expect(spoken[1]).toBe('[It was founded in two thousand one]')
  })

  it('stays silent on an ordinary turn that needs no lookup', async () => {
    await loadEngine({ CASCADE_ACK: 'true' })
    const { ws, sink } = await startCall()
    await tick(30)
    sink.frames.length = 0
    llmScript.push([text('Yes, I am doing well.'), stop()])
    sttSays(ws, 'how are you')
    await tick(60)
    // This is the line between masking and filler: no lookup ran, so nothing is said.
    expect(heard(sink)).toEqual(['[Yes, I am doing well]'])
  })

  it('does not talk over a lead-in the model wrote itself', async () => {
    await loadEngine({ CASCADE_ACK: 'true' })
    const { ws, sink } = await startCall()
    await tick(30)
    sink.frames.length = 0
    // The model says its own "let me check" and THEN calls the tool.
    llmScript.push([text('Let me check that for you. '), ...toolCall('search_knowledge')])
    llmScript.push([text('It was founded in 2001.'), stop()])
    sttSays(ws, 'when was Sanjeevani founded', { language: 'en' })
    await tick(60)
    const spoken = heard(sink)
    expect(spoken.some(s => /Sure, let me check|One second/.test(s))).toBe(false)
    expect(spoken[0]).toBe('[Let me check that for you]')
  })

  it('never acknowledges a tool that is instant or ends the call', async () => {
    await loadEngine({ CASCADE_ACK: 'true' })
    const { ws, sink } = await startCall()
    await tick(30)
    sink.frames.length = 0
    llmScript.push(toolCall('end_call'))
    llmScript.push([text('Goodbye.'), stop()])
    sttSays(ws, 'that is all thanks')
    await tick(60)
    expect(heard(sink)).toEqual(['[Goodbye]'])
  })

  it('uses tenant pronunciations only in TTS, preserving the assistant transcript', async () => {
    const { ws, sink, onTranscript } = await startCall(makeSink(), vi.fn(), {
      tts_pronunciations: { Sanjeevani: { te: 'సంజీవని' } },
    })
    await tick(30)
    sink.frames.length = 0
    llmScript.push([text('Sanjeevani HealthShield లో రెండు options ఉన్నాయిandi.'), stop()])
    sttSays(ws, 'సంజీవని గురించి చెప్పండి')
    await tick(60)
    expect(heard(sink)).toEqual(['[సంజీవని Health Shield లో రెండు options ఉన్నాయి అండి]'])
    expect(onTranscript).toHaveBeenCalledWith('Sanjeevani HealthShield లో రెండు options ఉన్నాయిandi.', 'assistant')
  })

  it('plays no filler when the tool is just ending the call', async () => {
    await loadEngine({ CASCADE_LOOKUP_FILLER: 'true' })
    const { ws, sink } = await startCall()
    await tick(30)
    sink.frames.length = 0
    llmScript.push(toolCall('end_call'))
    llmScript.push([text('Thank you andi, bye.'), stop()])
    sttSays(ws, 'ledu thank you')
    await tick(60)
    expect(heard(sink)).toEqual(['[Thank you andi, bye]'])
  })
})

describe('soniox cascade — Gemini brain', () => {
  it('runs a tool call that Gemini ends with finish_reason "stop", not "tool_calls"', async () => {
    // Live test: Gemini's lookup was treated as an empty answer and nothing was said.
    await loadEngine({ CASCADE_LLM_PROVIDER: 'gemini' })
    const { ws, sink } = await startCall()
    await tick()
    sink.frames.length = 0
    llmScript.push([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'search_knowledge', arguments: '{"query":"Sanjeevani"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ])
    llmScript.push([text('Sanjeevani 2001 లో స్టార్ట్ అయింది.'), stop()])
    sttSays(ws, 'సంజీవని ఎప్పుడు స్టార్ట్ అయింది?')
    await tick(60)
    expect(llmCalls[1].some(m => m.role === 'tool' && m.content === 'kb text')).toBe(true)
    expect(heard(sink)).toEqual(['[Sanjeevani two thousand one లో స్టార్ట్ అయింది]'])
  })

  it('falls back to the lowest thinking setting the model accepts, and remembers it', async () => {
    await loadEngine({ CASCADE_LLM_PROVIDER: 'gemini' })
    rejectEfforts.push('none')              // e.g. gemini-3.5-flash-lite
    const { ws, sink } = await startCall()
    await tick()
    llmScript.push([text('Okay one.'), stop()])
    sttSays(ws, 'first question here')
    await tick(40)
    llmScript.push([text('Okay two.'), stop()])
    sttSays(ws, 'second question here')
    await tick(40)
    // The call-start warmup discovers the setting, so no turn wastes a round-trip on it.
    expect(streamEfforts).toEqual(['minimal', 'minimal'])
    expect(heard(sink).slice(-2)).toEqual(['[Okay one]', '[Okay two]'])
  })
})

describe('soniox cascade — Soniox TTS limits', () => {
  it('retries a sentence Soniox refuses with 429 instead of dropping it', async () => {
    // Real call: four sentences were rejected and the caller heard half an answer.
    let refusals = 1
    globalThis.fetch = vi.fn(async (url, opts) => {
      const body = JSON.parse(opts.body)
      if (body.text === 'Two' && refusals-- > 0) return { ok: false, status: 429, text: async () => 'limit' }
      return { ok: true, status: 200, body: (async function* () { yield new TextEncoder().encode(`[${body.text}]`) })() }
    })
    const { ws, sink } = await startCall()
    await tick()
    sink.frames.length = 0
    llmScript.push([text('One. Two. Three.'), stop()])
    sttSays(ws, 'hello there')
    await tick(400)
    expect(heard(sink)).toEqual(['[One]', '[Two]', '[Three]'])
  })

  // Probed against the live account: 3 concurrent streams succeed and the 4th is
  // refused with "Concurrent requests limit for text-to-speech has been exceeded".
  // The cap is per ORGANISATION, so it is shared by every call this process is
  // handling — which is also why the waiting queue is priority-ordered, below.
  it('opens no more TTS requests at once than the organisation allows', async () => {
    const CAP = 3
    let open = 0, peak = 0, release
    const gate = new Promise(r => { release = r })
    globalThis.fetch = vi.fn(async (url, opts) => {
      const body = JSON.parse(opts.body)
      open++; peak = Math.max(peak, open)
      if (body.text.startsWith('A ')) await gate   // hold only this turn's sentences
      return {
        ok: true, status: 200,
        // A request is open until its audio stream is finished or abandoned.
        body: (async function* () { try { yield new TextEncoder().encode(`[${body.text}]`) } finally { open-- } })(),
      }
    })
    const { ws, sink } = await startCall()
    await tick()                 // the greeting plays out completely first
    sink.frames.length = 0
    peak = 0
    llmScript.push([text('A one. A two. A three. A four. A five.'), stop()])
    sttSays(ws, 'tell me everything')
    await tick(40)
    expect(peak).toBe(CAP)       // the cap started; the rest wait for a slot
    release()
    await tick(80)
    expect(peak).toBe(CAP)
    expect(heard(sink)).toEqual(['[A one]', '[A two]', '[A three]', '[A four]', '[A five]'])
  })

  it('lets a waiting first sentence go ahead of a later one already queued', async () => {
    // Two calls share the organisation's slots. Without priority, the second
    // caller's opening line waits behind the tail of the first caller's reply —
    // silence for someone who has heard nothing, to buffer ahead for someone who
    // is already listening.
    const { createSonioxCascadeConnection: connect } = await import('../src/services/soniox-cascade.js')
    const started = []
    let release
    const gate = new Promise(r => { release = r })
    globalThis.fetch = vi.fn(async (url, opts) => {
      const body = JSON.parse(opts.body)
      started.push(body.text)
      if (body.text.startsWith('Hold')) await gate
      return { ok: true, status: 200, body: (async function* () { yield new TextEncoder().encode(`[${body.text}]`) })() }
    })

    // Call A fills every slot and queues more behind them.
    const sinkA = makeSink()
    connect('CA-A', { tenant_id: 't1' }, sinkA, 'S-A', vi.fn(), vi.fn(), '+919000000001')
    await tick()
    const wsA = sockets.filter(s => s.url.includes('stt-rt')).at(-1)
    llmScript.push([text('Hold one. Hold two. Hold three. Hold four. Later five.'), stop()])
    sttSays(wsA, 'tell me everything')
    await tick(40)
    started.length = 0

    // Call B now starts and needs its very first sentence.
    const sinkB = makeSink()
    connect('CA-B', { tenant_id: 't1' }, sinkB, 'S-B', vi.fn(), vi.fn(), '+919000000002')
    await tick(20)
    release()
    await tick(120)

    // B's greeting must not be last in the queue behind A's trailing sentence.
    const firstB = started.findIndex(t => t === 'Namaste')
    const laterA = started.indexOf('Later five')
    expect(firstB).toBeGreaterThanOrEqual(0)
    if (laterA >= 0) expect(firstB).toBeLessThan(laterA)
  })
})

describe('soniox cascade — barge-in', () => {
  it('preserves caller facts and excludes a pending tool exchange after interruption', async () => {
    const { retrieveKnowledge } = await import('../src/services/rag.js')
    let release
    retrieveKnowledge.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const { ws, sink } = await startCall()
    await tick(30)
    sink.frames.length = 0
    llmScript.push(toolCall('search_knowledge'))
    sttSays(ws, 'I am 27, what is the premium?')
    await tick(30)
    llmScript.push([text('You want four crore cover, correct?'), stop()])
    sttSays(ws, 'I want four crore cover')
    await tick(40)
    release('stale one crore quotation')
    await tick(40)
    const history = llmCalls[1]
    expect(history.filter(m => m.role === 'user').map(m => m.content)).toEqual([
      'I am 27, what is the premium?', 'I want four crore cover',
    ])
    expect(history.some(m => m.tool_calls || m.role === 'tool')).toBe(false)
    expect(heard(sink)).toEqual(['[You want four crore cover, correct?]'])
    llmScript.push([text('Thank you.'), stop()])
    sttSays(ws, 'yes that is correct')
    await tick(40)
    expect(JSON.stringify(llmCalls[2])).not.toContain('stale one crore quotation')
  })

  // The greeting's TTS is held back, so the agent is genuinely mid-greeting when the
  // caller speaks.
  function holdGreeting() {
    let release
    holdTts = { promise: new Promise(r => { release = r }) }
    return () => release()
  }

  it('stops the agent and clears the caller buffer when the caller talks over it', async () => {
    const release = holdGreeting()
    const { ws, sink } = await startCall()
    sttSays(ws, 'wait a minute', { final: false, end: false })
    await tick()
    expect(sink.frames.some(f => f.event === 'clear')).toBe(true)
    release()
    await tick()
    expect(heard(sink)).toEqual([])   // the interrupted greeting is never played
  })

  it('treats a one-word "okay" over the agent as listening, not an interruption', async () => {
    const release = holdGreeting()
    const { ws, sink } = await startCall()
    sttSays(ws, 'okay', { final: false, end: false })
    await tick()
    expect(sink.frames.some(f => f.event === 'clear')).toBe(false)
    release()
    await tick()
    expect(heard(sink)).toEqual(['[Namaste]', '[How can I help you?]'])   // greeting carries on
  })
})

describe('soniox cascade — ending the call', () => {
  it('hangs up only after the closing line has been sent to the caller', async () => {
    const { ws, sink } = await startCall()
    await tick()
    llmScript.push(toolCall('end_call'))
    llmScript.push([text('Thank you andi, bye.'), stop()])
    sttSays(ws, 'ledu thank you')
    await tick(40)
    expect(heard(sink).at(-1)).toBe('[Thank you andi, bye]')
    expect(sink.endCall).toHaveBeenCalledOnce()
    // The tool result told the model the call is ending, so its goodbye comes next.
    expect(llmCalls[1].some(m => m.role === 'tool' && /call will end/.test(m.content))).toBe(true)
  })

  it('logs a per-call cost on finish and stops talking to Soniox', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { engine, ws } = await startCall()
    engine.send(Buffer.alloc(8000))   // one second of caller audio
    engine.finish()
    expect(ws.readyState).toBe(3)
    expect(log.mock.calls.some(([m]) => /💰 call cost ≈ ₹/.test(m) && /STT 1s/.test(m) && /chars/.test(m))).toBe(true)
    log.mockRestore()
  })
})

describe('soniox cascade — handing off to a person', () => {
  const HANDOFF_CFG = { handoff_number: '+919111111111', enable_handoff: true }

  beforeEach(() => transferToHuman.mockClear())

  it('transfers the call instead of saying "HANDOFF" out loud', async () => {
    const { ws, sink, onTranscript } = await startCall(makeSink(), vi.fn(), HANDOFF_CFG)
    // Clear the greeting out of the way — but only once it has actually been rendered.
    // A fixed tick is long enough when this file runs alone and not when the whole suite
    // runs in parallel, and then the greeting lands AFTER the reset and shows up in the
    // assertion below as a phantom second sentence.
    await waitFor(() => ttsRequests.length > 0)
    sink.frames.length = 0
    ttsRequests.length = 0

    llmScript.push([text('Let me put you through to the team. '), text('[HANDOFF]'), stop(), usage()])
    sttSays(ws, 'I want to speak to a person')
    // The transfer only fires once the caller has actually heard the sentence, so wait
    // for it rather than for a fixed number of milliseconds.
    await waitFor(() => transferToHuman.mock.calls.length > 0)

    expect(ttsRequests.map(r => r.text)).toEqual(['Let me put you through to the team'])
    expect(heard(sink).join(' ')).not.toMatch(/HANDOFF/i)
    expect(transferToHuman).toHaveBeenCalledWith('CA1', '+919111111111', '+919000000000', expect.objectContaining({ handoff_number: '+919111111111' }))
    expect(onTranscript).toHaveBeenCalledWith('[SYSTEM] Call handed off to human agent')
  })

  it('transfers only after the caller has heard the sentence explaining it', async () => {
    holdTts = {}
    holdTts.promise = new Promise(r => { holdTts.release = r })
    const { ws } = await startCall(makeSink(), vi.fn(), HANDOFF_CFG)
    await tick()

    llmScript.push([text('One moment, connecting you. [HANDOFF]'), stop(), usage()])
    sttSays(ws, 'get me an agent')
    await tick(40)
    // The voice has not delivered a byte yet — transferring now would cut the line
    // before the caller is told what is happening.
    expect(transferToHuman).not.toHaveBeenCalled()

    holdTts.release()
    holdTts = null
    await tick(40)
    expect(transferToHuman).toHaveBeenCalledOnce()
  })

  it('keeps the marker out of the history so the model does not repeat it every turn', async () => {
    const { ws } = await startCall(makeSink(), vi.fn(), HANDOFF_CFG)
    await tick()

    llmScript.push([text('Someone will call you back. [HANDOFF]'), stop(), usage()])
    sttSays(ws, 'I did not understand')
    await tick(40)

    const history = llmCalls.at(-1)
    expect(history.some(m => typeof m.content === 'string' && /HANDOFF/.test(m.content))).toBe(false)
  })

  it('says the sentence but attempts no transfer when the tenant has nowhere to transfer to', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { ws, sink } = await startCall()   // no handoff_number
    await tick()
    sink.frames.length = 0

    llmScript.push([text('I will get this checked. [HANDOFF]'), stop(), usage()])
    sttSays(ws, 'connect me to someone')
    await tick(40)

    expect(heard(sink)).toEqual(['[I will get this checked]'])
    expect(transferToHuman).not.toHaveBeenCalled()
    expect(warn.mock.calls.some(([m]) => /no handoff_number/.test(m))).toBe(true)
    warn.mockRestore()
  })
})

describe('soniox cascade — what language the caller actually spoke', () => {
  it('asks Soniox to tag every token with the language it heard', async () => {
    const { ws } = await startCall()
    expect(JSON.parse(ws.sent[0]).enable_language_identification).toBe(true)
  })

  it('reports English spoken in Telugu letters as the mismatch it is', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { ws } = await startCall()
    await tick()

    llmScript.push([text('Sure.'), stop(), usage()])
    sttSays(ws, 'వాట్ ఇస్ ద నీడ్ టు గో ఫర్ ఏ హ్యాండ్ ఆఫ్', { language: 'en' })
    await tick(40)

    expect(log.mock.calls.some(([m]) => /Caller \(en — written in te script\)/.test(m))).toBe(true)
    log.mockRestore()
  })

  it('still works when the model sends no language on a token', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { ws } = await startCall()
    await tick()

    llmScript.push([text('సరే అండి.'), stop(), usage()])
    sttSays(ws, 'term insurance kavali')
    await tick(40)

    expect(log.mock.calls.some(([m]) => /Caller: "term insurance kavali"/.test(m))).toBe(true)
    log.mockRestore()
  })
})

describe('soniox cascade — how much evidence one search returns', () => {
  it('asks for enough chunks that the answer is not split across two round-trips', async () => {
    // Measured against the live catalogue: the premium the model wanted was absent
    // from 3 chunks and present in 6, and the miss cost a whole extra model round.
    const { retrieveKnowledge } = await import('../src/services/rag.js')
    retrieveKnowledge.mockClear()
    const { ws } = await startCall()
    await tick()

    llmScript.push(toolCall('search_knowledge'))
    llmScript.push([text('Thirty nine thousand nine hundred rupees.'), stop(), usage()])
    sttSays(ws, 'premium enta')
    await tick(40)

    expect(retrieveKnowledge).toHaveBeenCalledWith('t1', expect.any(String), 6, expect.any(Object))
  })
})

describe('soniox cascade — streaming TTS (the production path)', () => {
  // Drives the fake Soniox TTS socket: config + text in, base64 audio back out.
  function ttsSaid(ws, streamId, text, { end = true } = {}) {
    ws.emit('message', Buffer.from(JSON.stringify({ stream_id: streamId, audio: Buffer.from(`[${text}]`).toString('base64') })))
    if (end) ws.emit('message', Buffer.from(JSON.stringify({ stream_id: streamId, audio_end: true })))
  }
  // Everything the engine has written to the TTS socket, parsed.
  const sent = (ws) => ws.sent.map(s => JSON.parse(s))
  // Answer the greeting so the agent is idle — otherwise the next caller turn is a
  // barge-in, which drops the socket and opens a new one.
  async function settleGreeting() {
    const tts = ttsSocket()
    for (const c of sent(tts).filter(m => m.api_key)) ttsSaid(tts, c.stream_id, 'greeting')
    await tick(30)
    return ttsSocket()
  }
  const textFor = (ws, id) => sent(ws).filter(m => m.stream_id === id && m.text !== undefined && m.text !== '').map(m => m.text).join('')

  beforeEach(async () => {
    vi.stubEnv('SONIOX_TTS_STREAMING', 'true')
    sockets.length = 0
    await loadEngine()
  })

  it('opens one socket for the whole call and configures a stream per sentence', async () => {
    await startCall()
    await tick()
    const tts = ttsSocket()
    expect(tts).toBeTruthy()
    expect(sockets.filter(s => s.url.includes('tts-rt'))).toHaveLength(1)

    const configs = sent(tts).filter(m => m.api_key)
    expect(configs.length).toBeGreaterThanOrEqual(1)
    expect(configs[0]).toMatchObject({ model: 'tts-rt-v2', audio_format: 'pcm_mulaw', sample_rate: 8000 })
    // Greeting is two sentences → two streams, each with its own id.
    expect(new Set(configs.map(c => c.stream_id)).size).toBe(configs.length)
  })

  it('sends an opening clause before the sentence is finished, on the same stream', async () => {
    const { ws } = await startCall()
    await tick()
    const tts = await settleGreeting()
    tts.sent.length = 0

    // A long first sentence, exactly the shape that cost 800ms on a real call.
    llmScript.push([
      text('25 ఏళ్ల వయసులో 5 కోట్ల కవర్ కోసం Prithvi LifeShield Supreme ప్లాన్ తీసుకుంటే, '),
      text('ఇండికేటివ్ యాన్యువల్ ప్రీమియం 39,900 రూపాయలు వస్తుంది.'),
      stop(), usage(),
    ])
    sttSays(ws, 'premium enta')
    await tick(40)

    const configs = sent(tts).filter(m => m.api_key)
    expect(configs).toHaveLength(1)                     // one sentence, one stream
    const id = configs[0].stream_id
    const pushes = sent(tts).filter(m => m.stream_id === id && m.text)
    expect(pushes.length).toBeGreaterThan(1)            // clause first, then the rest
    // The clause went out before the closing text arrived.
    expect(pushes[0].text).toMatch(/Prithvi/)
    expect(pushes[0].text).not.toMatch(/39/)
    // Nothing was lost or duplicated, and the figure is still spoken in English.
    expect(textFor(tts, id)).toMatch(/thirty nine thousand nine hundred/)
    expect(sent(tts).some(m => m.stream_id === id && m.text_end === true)).toBe(true)
  })

  it('never breaks a sentence inside a digit group', async () => {
    const { ws } = await startCall()
    await tick()
    const tts = await settleGreeting()
    tts.sent.length = 0

    llmScript.push([text('The indicative annual premium is 39,900 rupees before tax.'), stop(), usage()])
    sttSays(ws, 'how much')
    await tick(40)

    const id = sent(tts).filter(m => m.api_key).at(-1).stream_id
    for (const m of sent(tts).filter(m => m.stream_id === id && m.text)) {
      expect(m.text).not.toMatch(/39$/)     // "39," must never be the tail of a push
    }
  })

  it('plays streamed audio to the caller in order', async () => {
    const { ws, sink } = await startCall()
    await tick()
    const tts = ttsSocket()
    // Answer the greeting's streams so the queue drains.
    for (const c of sent(tts).filter(m => m.api_key)) ttsSaid(tts, c.stream_id, 'greeting')
    await tick(30)
    sink.frames.length = 0
    tts.sent.length = 0

    llmScript.push([text('First. '), text('Second.'), stop(), usage()])
    sttSays(ws, 'go on')
    await tick(40)
    const ids = sent(tts).filter(m => m.api_key).map(c => c.stream_id)
    expect(ids).toHaveLength(2)
    // Answer the SECOND one first — playback must still be in order.
    ttsSaid(tts, ids[1], 'two')
    await tick(20)
    ttsSaid(tts, ids[0], 'one')
    await tick(40)
    expect(heard(sink)).toEqual(['[one]', '[two]'])
  })

  it('drops the socket on barge-in so cancelled speech is not still being generated', async () => {
    const { ws, sink } = await startCall()
    await tick()
    const tts = ttsSocket()
    for (const c of sent(tts).filter(m => m.api_key)) ttsSaid(tts, c.stream_id, 'greeting')
    await tick(30)

    llmScript.push([text('This is a long answer the caller talks over.'), stop(), usage()])
    sttSays(ws, 'tell me')
    await tick(40)
    expect(tts.readyState).toBe(1)

    sttSays(ws, 'actually wait', { end: false })
    await tick(20)
    expect(tts.readyState).toBe(3)                       // closed, not left generating
    expect(sink.frames.some(f => f.event === 'clear')).toBe(true)

    // The next sentence opens a fresh socket rather than dying.
    llmScript.push([text('Of course.'), stop(), usage()])
    sttSays(ws, 'go ahead now')
    await tick(40)
    expect(sockets.filter(s => s.url.includes('tts-rt')).length).toBe(2)
  })

  it('does not leave the caller waiting forever when the voice errors', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { ws, sink } = await startCall()
    await tick()
    const tts = ttsSocket()
    for (const c of sent(tts).filter(m => m.api_key)) ttsSaid(tts, c.stream_id, 'greeting')
    await tick(30)
    tts.sent.length = 0

    llmScript.push([text('Something.'), stop(), usage()])
    sttSays(ws, 'anything')
    await tick(40)
    const id = sent(tts).filter(m => m.api_key).at(-1).stream_id
    tts.emit('message', Buffer.from(JSON.stringify({ stream_id: id, error_code: 500, error_message: 'boom' })))
    await tick(40)

    // The turn finished rather than hanging on an item that never completes.
    expect(err.mock.calls.some(([m]) => /TTS stream/.test(m))).toBe(true)
    err.mockRestore()
  })

  it('still honours SONIOX_TTS_STREAMING=false', async () => {
    vi.stubEnv('SONIOX_TTS_STREAMING', 'false')
    sockets.length = 0
    await loadEngine()
    const { sink } = await startCall()
    await tick()
    expect(sockets.some(s => s.url.includes('tts-rt'))).toBe(false)
    expect(heard(sink)).toEqual(['[Namaste]', '[How can I help you?]'])
  })
})

describe('soniox cascade — streaming TTS stays inside the concurrency cap', () => {
  const sent = (ws) => ws.sent.map(s => JSON.parse(s))
  const configs = (ws) => sent(ws).filter(m => m.api_key)
  const audioEnd = (ws, id) => ws.emit('message', Buffer.from(JSON.stringify({ stream_id: id, audio_end: true })))

  beforeEach(async () => {
    vi.stubEnv('SONIOX_TTS_STREAMING', 'true')
    vi.stubEnv('SONIOX_TTS_MAX_CONCURRENT', '2')
    sockets.length = 0
    await loadEngine()
  })

  // Leaves the agent idle, so the next caller turn is a turn and not a barge-in
  // (a barge-in drops the socket, which makes stream counting meaningless).
  async function settled() {
    const tts = ttsSocket()
    for (const c of configs(tts)) audioEnd(tts, c.stream_id)
    await tick(30)
    tts.sent.length = 0
    return tts
  }

  it('never opens more streams at once than the organisation allows', async () => {
    // A real call: a five-sentence reply opened five streams at once, Soniox 429'd
    // most of them, and the caller heard a reply with holes in it.
    const { ws } = await startCall()
    await tick(30)
    const tts = await settled()

    llmScript.push([text('One. '), text('Two. '), text('Three. '), text('Four. '), text('Five.'), stop(), usage()])
    sttSays(ws, 'tell me everything')
    await tick(60)

    expect(configs(tts).length).toBeGreaterThan(0)
    expect(configs(tts).length).toBeLessThanOrEqual(2)
  })

  it('gives the slot back when a stream finishes, so the next sentence can start', async () => {
    const { ws } = await startCall()
    await tick(30)
    const tts = await settled()

    llmScript.push([text('One. '), text('Two. '), text('Three.'), stop(), usage()])
    sttSays(ws, 'tell me everything')
    await tick(60)
    const firstTwo = configs(tts).map(c => c.stream_id)
    expect(firstTwo).toHaveLength(2)

    for (const id of firstTwo) audioEnd(tts, id)
    await tick(60)
    expect(configs(tts).length).toBe(3)        // the third sentence got a slot
  })

  it('says a sentence again when Soniox refuses it with a 429', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { ws } = await startCall()
    await tick(30)
    const tts = ttsSocket()
    const first = configs(tts)[0]

    tts.emit('message', Buffer.from(JSON.stringify({
      stream_id: first.stream_id, error_code: 429, error_message: 'Concurrent requests limit',
    })))
    await tick(500)

    // A NEW stream carrying the same words, rather than a silent gap in the reply.
    const retried = configs(tts).filter(c => c.stream_id !== first.stream_id)
    expect(retried.length).toBeGreaterThan(0)
    const replayed = sent(tts).filter(m => m.stream_id === retried.at(-1).stream_id && m.text)
    expect(replayed.map(m => m.text).join('')).toContain('Namaste')
    err.mockRestore()
  })
})

describe('soniox cascade — the tenant chooses the voice', () => {
  const sent = (ws) => ws.sent.map(s => JSON.parse(s))

  beforeEach(async () => {
    vi.stubEnv('SONIOX_TTS_STREAMING', 'true')
    vi.stubEnv('SONIOX_TTS_VOICE', 'Adrian')
    sockets.length = 0
    await loadEngine()
  })

  it('uses the tenant\'s own voice, including a cloned one, over the server default', async () => {
    const clone = 'b3b44c31-d781-40c1-a140-ad374ab299d7'
    await startCall(makeSink(), vi.fn(), { tts_voice: clone })
    await tick(30)
    for (const cfg of sent(ttsSocket()).filter(m => m.api_key)) expect(cfg.voice).toBe(clone)
  })

  it('falls back to the server default when the tenant has not picked one', async () => {
    await startCall()
    await tick(30)
    expect(sent(ttsSocket()).find(m => m.api_key).voice).toBe('Adrian')
  })

  it('does not mistake a Gemini Live voice for a Soniox one', async () => {
    // `voice` holds a Gemini voice name for tenants on the other engine. Passing
    // "Kore" to Soniox is a 400 in the middle of a call.
    await startCall(makeSink(), vi.fn(), { voice: 'Kore' })
    await tick(30)
    expect(sent(ttsSocket()).find(m => m.api_key).voice).toBe('Adrian')
  })
})

describe('soniox cascade — audio from an abandoned turn never reaches the caller', () => {
  // Barge-in aborts the model and clears the queue, but Soniox can still hand us
  // audio it had already started generating for the turn the caller talked over.
  // The last gate before the caller's ear is sendAudio, and this is what it is for.
  function ttsSaid(ws, streamId, text, { end = true } = {}) {
    ws.emit('message', Buffer.from(JSON.stringify({ stream_id: streamId, audio: Buffer.from(`[${text}]`).toString('base64') })))
    if (end) ws.emit('message', Buffer.from(JSON.stringify({ stream_id: streamId, audio_end: true })))
  }
  const sent = (ws) => ws.sent.map(s => JSON.parse(s))

  beforeEach(async () => {
    vi.stubEnv('SONIOX_TTS_STREAMING', 'true')
    sockets.length = 0
    await loadEngine()
  })

  it('drops audio that arrives for a turn the caller has already talked past', async () => {
    const { ws, sink } = await startCall()
    await tick()
    // Settle the greeting so the next turn is a clean one, not a barge-in.
    const greetTts = ttsSocket()
    for (const c of sent(greetTts).filter(m => m.api_key)) ttsSaid(greetTts, c.stream_id, 'greeting')
    await tick(30)

    llmScript.push([text('The premium is 39,900 rupees.'), stop()])
    sttSays(ws, 'what is the premium')
    await tick(30)
    sink.frames.length = 0

    // The caller interrupts with real words, which aborts turn 2.
    llmScript.push([text('Yes, four crore.'), stop()])
    sttSays(ws, 'actually four crore cover', { final: false, end: false })
    await tick(20)

    // Soniox now delivers audio for the ABANDONED turn on the old socket.
    const stale = sockets.filter(s => s.url.includes('tts-rt'))[0]
    for (const c of sent(stale).filter(m => m.api_key)) ttsSaid(stale, c.stream_id, 'STALE-39900')
    await tick(30)

    expect(heard(sink).join(' ')).not.toContain('STALE-39900')
  })

  it('still plays the audio of the turn that is actually live', async () => {
    const { ws, sink } = await startCall()
    await tick()
    const greetTts = ttsSocket()
    for (const c of sent(greetTts).filter(m => m.api_key)) ttsSaid(greetTts, c.stream_id, 'greeting')
    await tick(30)
    sink.frames.length = 0

    llmScript.push([text('The premium is 39,900 rupees.'), stop()])
    sttSays(ws, 'what is the premium')
    await tick(30)
    const tts = ttsSocket()
    for (const c of sent(tts).filter(m => m.api_key)) ttsSaid(tts, c.stream_id, 'live-answer')
    await tick(30)

    expect(heard(sink).join(' ')).toContain('live-answer')
  })
})

describe('soniox cascade — the latency it reports is the latency the caller felt', () => {
  // The whole optimisation effort rests on this number being real. speechEnd is NOT
  // "when we got the transcript" — it is Soniox's own end_ms for the caller's last
  // word, translated back into wall-clock time using when that byte range was
  // actually sent. Audio buffered while the socket opened is flushed in one burst,
  // so a fixed offset would run fast and quietly flatter every measurement.
  it('measures from when the caller stopped speaking, not from when we noticed', async () => {
    const { ws, engine } = await startCall()
    await tick()

    // Feed a second of caller audio the way Plivo does: 20ms, 160-byte µ-law frames.
    // 8000 bytes = 1000ms of audio, so end_ms 400 falls at byte 3200 — a moment that
    // ALREADY HAPPENED by the time the endpoint arrives. A correct measurement has to
    // reach back to it; one that timed from "now" would report roughly zero.
    for (let i = 0; i < 50; i++) {
      engine.send(Buffer.alloc(160, 0x7f))
      await tick(1)
    }

    const log = vi.spyOn(console, 'log')
    llmScript.push([text('The premium is 39,900 rupees.'), stop()])
    sttSays(ws, 'what is the premium', { endMs: 400 })
    await tick(60)

    const block = log.mock.calls.map(c => String(c[0])).find(l => l.includes('PERCEIVED'))
    log.mockRestore()
    expect(block).toBeTruthy()

    // A real number, not "?" — and it must reflect the ~600ms of audio that was sent
    // AFTER the caller's last word, not the few milliseconds since the <end> token.
    const perceived = Number(/PERCEIVED (\d+)ms/.exec(block)?.[1])
    expect(Number.isFinite(perceived)).toBe(true)
    expect(perceived).toBeGreaterThan(300)
    expect(block).toContain('ENDPOINTING')
  })

  it('names the slowest leg of the turn, so a slow call says what to go and fix', async () => {
    const { retrieveKnowledge } = await import('../src/services/rag.js')
    retrieveKnowledge.mockImplementationOnce(async () => {
      await new Promise(r => setTimeout(r, 120))   // a genuinely slow knowledge search
      return 'the premium is 39,900'
    })
    const { ws } = await startCall()
    await tick()
    const log = vi.spyOn(console, 'log')

    llmScript.push(toolCall('search_knowledge'))
    llmScript.push([text('It is 39,900 rupees.'), stop()])
    sttSays(ws, 'what is the premium')
    await tick(250)

    const block = log.mock.calls.map(c => String(c[0])).filter(l => l.includes('bottleneck')).at(-1)
    log.mockRestore()
    expect(block).toContain('bottleneck RAG')
  })
})

describe('soniox cascade — masking a slow lookup does not weaken anything else', () => {
  it('drops the acknowledgement when the caller talks over it', async () => {
    // An acknowledgement is queued audio like any other, so barge-in has to cancel it.
    // If it did not, the caller would be interrupted by "let me check" after they had
    // already moved on — the exact ghost-speech this system is supposed to prevent.
    await loadEngine({ CASCADE_ACK: 'true' })
    const { ws, sink } = await startCall()
    await tick(30)
    sink.frames.length = 0

    holdTts = { promise: new Promise(() => {}) }   // no TTS ever returns: ack is pending
    llmScript.push(toolCall('search_knowledge'))
    llmScript.push([text('It was founded in 2001.'), stop()])
    sttSays(ws, 'when was Sanjeevani founded', { language: 'en' })
    await tick(30)

    sttSays(ws, 'actually never mind', { final: false, end: false })
    await tick(30)
    expect(sink.frames.some(f => f.event === 'clear')).toBe(true)
    expect(heard(sink)).toEqual([])
  })

  it('reports how long sentences waited for one of the organisation\'s TTS slots', async () => {
    // The cap is shared by every call in the process, so a single call's log cannot
    // show contention. These counters are the only place it is visible.
    const { ttsQueueStats } = await import('../src/services/soniox-cascade.js')
    const stats = ttsQueueStats()
    expect(stats).toMatchObject({
      limit: 3,
      activeStreams: expect.any(Number),
      queueDepth: expect.any(Number),
      firstSentenceQueueWaitMs: expect.any(Number),
      laterSentenceQueueWaitMs: expect.any(Number),
    })
  })

  it('keeps the acknowledgement out of the conversation the model sees', async () => {
    // It is something this code said to cover a delay, not something the agent
    // decided to say. In the history it would look like the model's own words and
    // could be imitated on later turns.
    await loadEngine({ CASCADE_ACK: 'true' })
    const { ws, onTranscript } = await startCall()
    await tick(30)
    llmScript.push(toolCall('search_knowledge'))
    llmScript.push([text('It was founded in 2001.'), stop()])
    sttSays(ws, 'when was Sanjeevani founded', { language: 'en' })
    await tick(60)

    const spokenToCaller = onTranscript.mock.calls.filter(c => c[1] === 'assistant').map(c => c[0])
    expect(spokenToCaller).toEqual(['It was founded in 2001.'])
    // …and the next model request must not contain it either.
    const lastRequest = JSON.stringify(llmCalls.at(-1))
    expect(lastRequest).not.toMatch(/Sure, let me check|One second, let me check/)
  })
})

describe('soniox cascade — an acknowledgement is only worth saying if it is free', () => {
  beforeEach(async () => {
    vi.stubEnv('SONIOX_TTS_STREAMING', 'false')
    sockets.length = 0
  })

  it('stays silent rather than make the caller wait for the line to be synthesised', async () => {
    // Measured on a real call: the first knowledge turn arrived before the background
    // warm-up had run, the line took ~1.7s to render, and the answer — already ready —
    // queued behind it for 1470ms while only 663ms of silence was saved. Speaking cost
    // the caller more than staying quiet, which is the one outcome this must never have.
    await loadEngine({ CASCADE_ACK: 'true', CASCADE_ACK_WARM_DELAY_MS: '999999' })
    const { ws, sink } = await startCall()
    await tick(30)
    sink.frames.length = 0

    llmScript.push(toolCall('search_knowledge'))
    llmScript.push([text('It was founded in 2001.'), stop()])
    sttSays(ws, 'when was Sanjeevani founded', { language: 'en' })
    await tick(60)

    // Nothing but the answer — no half-second of dead queue in front of it.
    expect(heard(sink)).toEqual(['[It was founded in two thousand one]'])
  })

  it('masks the next turn once the line has been rendered', async () => {
    await loadEngine({ CASCADE_ACK: 'true', CASCADE_ACK_WARM_DELAY_MS: '0' })
    const { ws, sink } = await startCall()
    await tick(60)              // the warm-up renders every line
    sink.frames.length = 0

    llmScript.push(toolCall('search_knowledge'))
    llmScript.push([text('It was founded in 2001.'), stop()])
    sttSays(ws, 'when was Sanjeevani founded', { language: 'en' })
    await tick(60)

    const spoken = heard(sink)
    expect(spoken).toHaveLength(2)
    expect(spoken[0]).toMatch(/^\[(Sure|Let me|One second)/)
    expect(spoken[1]).toBe('[It was founded in two thousand one]')
  })
})

describe('soniox cascade — a browser is not a phone line', () => {
  // The marketing demo and the builder's test call run this same engine, but the
  // listener is on a laptop speaker, not a handset. Pushing them through an 8kHz
  // telephony codec would be degrading the audio for no reason — Soniox speaks
  // 24kHz PCM as readily as µ-law.
  beforeEach(async () => {
    vi.stubEnv('SONIOX_TTS_STREAMING', 'false')
    sockets.length = 0
    await loadEngine()
  })

  it('asks Soniox for telephony audio on a phone call', async () => {
    const { ws } = await startCall()
    expect(JSON.parse(ws.sent[0])).toMatchObject({ audio_format: 'mulaw', sample_rate: 8000 })
    await tick(30)
    expect(ttsRequests[0]).toMatchObject({ audio_format: 'pcm_mulaw', sample_rate: 8000 })
  })

  it('asks for proper audio when the listener is a browser', async () => {
    const { ws } = await startCall(makeSink(), vi.fn(), { audio_io: 'pcm' })
    expect(JSON.parse(ws.sent[0])).toMatchObject({ audio_format: 'pcm_s16le', sample_rate: 16000 })
    await tick(30)
    expect(ttsRequests[0]).toMatchObject({ audio_format: 'pcm_s16le', sample_rate: 24000 })
  })

  // speechEnd comes from Soniox's audio-time end_ms mapped back onto wall time, and that
  // conversion is bytes-per-millisecond: 8 on a phone line, 32 from a browser. Reading
  // it at 8 for a browser does not throw — the lookup just lands on a chunk from early
  // in the call, so the reported wait grows with the call itself. On a real demo it
  // climbed 14s → 121s over six turns and named ENDPOINTING the bottleneck every time.
  //
  // The assertion that matters is the UPPER bound. A lower bound passes with the bug.
  async function endpointingFor(audioIo, bytesPerFrame, endMs) {
    const { ws, engine } = await startCall(makeSink(), vi.fn(), audioIo ? { audio_io: audioIo } : {})
    await tick()
    const startedStreaming = Date.now()
    // 1s of caller audio, as 20ms frames, spread over real wall time.
    for (let i = 0; i < 50; i++) { engine.send(Buffer.alloc(bytesPerFrame)); await tick(4) }
    const streamedMs = Date.now() - startedStreaming

    const log = vi.spyOn(console, 'log')
    llmScript.push([text('Yes.'), stop()])
    sttSays(ws, 'hello there', { endMs })
    await tick(60)
    const block = log.mock.calls.map(c => String(c[0])).find(l => l.includes('ENDPOINTING'))
    log.mockRestore()
    return { endpointing: Number(/ENDPOINTING (\d+)ms/.exec(block)?.[1]), streamedMs }
  }

  it('anchors the wait to the end of the caller\'s speech on a browser call', async () => {
    // end_ms 990 is the last frame sent, so the caller stopped speaking as the stream
    // ended: the wait is what happened AFTER that, not the length of the stream.
    const { endpointing, streamedMs } = await endpointingFor('pcm', 640, 990)
    expect(Number.isFinite(endpointing)).toBe(true)
    expect(endpointing).toBeLessThan(streamedMs / 2)
  })

  it('still anchors it correctly on a phone line', async () => {
    // 20ms of 8kHz µ-law is 160 bytes. Guards the rate the telephony path has always
    // used, which is the one the endpoint benchmarks were measured against.
    const { endpointing, streamedMs } = await endpointingFor(null, 160, 990)
    expect(Number.isFinite(endpointing)).toBe(true)
    expect(endpointing).toBeLessThan(streamedMs / 2)
  })

  it('bills browser audio at the browser\'s sample rates', async () => {
    // 8kHz µ-law rates on a 16k/24k call read 4× the STT and 6× the TTS. A demo call
    // invoiced ₹15 for TTS, of which roughly ₹10 was arithmetic.
    const log = vi.spyOn(console, 'log')
    const { engine } = await startCall(makeSink(), vi.fn(), { audio_io: 'pcm' })
    await tick(30)
    engine.send(Buffer.alloc(32000 * 5))   // 5 seconds of caller audio
    engine.finish()
    const cost = log.mock.calls.map(c => String(c[0])).find(l => l.includes('call cost'))
    log.mockRestore()
    expect(cost).toMatch(/STT 5(\.0)?s/)
  })

  it('does not answer a transcript that arrives after the call ended', async () => {
    // Closing the STT socket is not instant. A final <end> landing after finish() used
    // to run a whole turn — LLM tokens and a TTS render, spent on a caller who has hung
    // up, and after the cost line that would have counted them was already printed.
    const { ws, engine } = await startCall(makeSink(), vi.fn(), { audio_io: 'pcm' })
    await tick(30)
    engine.finish()
    const before = llmScript.length
    llmScript.push([text('Nobody is listening.'), stop()])
    sttSays(ws, 'hello?', { endMs: 400 })
    await tick(60)
    expect(llmScript.length).toBe(before + 1)   // untouched: no turn was started
  })
})

describe('soniox cascade — the language the lead extractor is told', () => {
  // The post-call extractor is handed trace.state.dominantLanguage. Without it, it
  // infers the call's language from the text, and that inference filed Telugu calls
  // as Hindi often enough to matter. The old speech-to-speech engine fed the field
  // from a LanguageManager; when that engine was deleted nothing wrote it, and the
  // failure was invisible — leads kept being created, just with the wrong language.
  beforeEach(async () => {
    vi.stubEnv('SONIOX_TTS_STREAMING', 'false')
    for (const k of Object.keys(traceState.state)) delete traceState.state[k]
    sockets.length = 0
    await loadEngine()
  })

  it('records what Soniox HEARD, not the script it wrote', async () => {
    const { ws } = await startCall()
    llmScript.push([text('Sare.'), stop()])
    sttSays(ws, 'నాకు రెండు BHK కావాలి', { language: 'te' })
    await tick(40)
    expect(traceState.state.dominantLanguage).toBe('te')
  })

  it('follows the call when the caller settles into another language', async () => {
    // Weighted by how much was actually said, so one English word in a Telugu call
    // does not flip the lead's language.
    const { ws } = await startCall()
    llmScript.push([text('Ok.'), stop()], [text('Ok.'), stop()])
    sttSays(ws, 'ok', { language: 'en', endMs: 400 })
    await tick(30)
    sttSays(ws, 'నాకు రెండు BHK ఇల్లు కావాలి అండి', { language: 'te', endMs: 900 })
    await tick(40)
    expect(traceState.state.dominantLanguage).toBe('te')
  })

  it('is set during the call, not at hangup', async () => {
    // Calls do not always reach a clean teardown. A lead with no language because the
    // caller dropped mid-sentence is the case this exists to avoid.
    const { ws } = await startCall()
    llmScript.push([text('Sare.'), stop()])
    sttSays(ws, 'చెప్పండి', { language: 'te' })
    await tick(40)
    expect(traceState.state.dominantLanguage).toBe('te')   // no finish() called
  })

  it('stays unset when Soniox identified nothing', async () => {
    // Better an honest null — the extractor has a documented fallback for it — than
    // a confident guess nobody can trace back to a measurement.
    const { ws } = await startCall()
    llmScript.push([text('Sare.'), stop()])
    sttSays(ws, 'hello')   // no language on the token
    await tick(40)
    expect(traceState.state.dominantLanguage).toBeUndefined()
  })
})
