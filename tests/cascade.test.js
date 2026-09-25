import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── Fakes for everything the engine talks to ─────────────────────────────────
// Sarvam STT is a websocket (the real sarvam-stt.js adapter runs over a fake socket),
// Gemini is streamGemini, Telnyx is streamTelnyxSpeech. The telephony sink records
// what the caller would have heard.

// vi.mock factories are hoisted above everything else, so the state they share
// with the tests has to be hoisted with them.
const { sockets, llmScript, llmCalls, llmRequests, tts, cache, transferToHuman } = vi.hoisted(() => ({
  sockets: [], llmScript: [], llmCalls: [], llmRequests: [],
  // requests: every sentence sent to the voice · hold: a promise every render waits on
  // impl: replaces the fake voice for one test · real: run the real Telnyx client
  tts: { requests: [], hold: null, impl: null, real: false },
  // name: what cachedContentFor answers · refuse: Gemini rejects that cache
  cache: { name: null, refuse: false },
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
    constructor(url, opts) {
      super()
      this.url = url
      this.opts = opts
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

// llmScript: one entry per model request — the chunks it streams.
vi.mock('../src/services/gemini-native.js', () => ({
  async *streamGemini({ messages, tools, cachedContent, timing = {} }) {
    llmRequests.push({ cachedContent: cachedContent || null, system: messages[0]?.role === 'system', tools: (tools || []).map(t => t.function.name) })
    timing.sentAt = Date.now()
    if (cachedContent && cache.refuse) {
      throw Object.assign(new Error('Gemini 400: CachedContent not found (or permission denied)'), { status: 400 })
    }
    llmCalls.push(structuredClone(messages))
    const chunks = llmScript.shift() || []
    timing.headersAt = Date.now()
    for (const c of chunks) {
      if (c instanceof Error) throw c
      yield c
    }
  },
}))
vi.mock('../src/services/gemini-cache.js', () => ({
  cachedContentFor: vi.fn(() => cache.name),
  forgetCache: vi.fn(),
}))

// Every sentence comes back as "[its text]", so what the caller heard can be read back.
vi.mock('../src/services/telnyx-tts.js', async (importOriginal) => {
  const real = await importOriginal()
  async function* fake({ text, voice, format, sampleRate, language }) {
    tts.requests.push({ text, voice, format, sampleRate, language })
    if (tts.hold) await tts.hold.promise
    yield Buffer.from(`[${text}]`)
  }
  return { ...real, streamTelnyxSpeech: (o) => (tts.real ? real.streamTelnyxSpeech(o) : (tts.impl || fake)(o)) }
})

vi.mock('../src/services/llm.js', () => ({ buildSystemPrompt: () => 'SYSTEM PROMPT' }))
vi.mock('../src/services/rag.js', () => ({
  retrieveKnowledge: vi.fn(async () => 'kb text'), warmupRAG: vi.fn(),
  knowledgeVocabulary: vi.fn(() => null), whenKnowledgeLoaded: vi.fn(async () => {}),
}))
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
const RAMYA = 'Telnyx.Ultra.cf061d8b-a752-4865-81a2-57570a6e0565'
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
// The per-turn guidance rides as the last user message; these are the caller's own.
const callerTurns = (call) => call.filter(m => m.role === 'user' && !String(m.content).startsWith('THIS TURN'))

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

// Sarvam's side of the socket. A final transcript is how Sarvam ends a turn; its end_s
// includes the silence window, which the adapter takes back off — so endMs here is
// where the caller's last word ended.
function sttSays(ws, words, { final = true, endMs = 900, language } = {}) {
  const lang = language ? { language: `${language}-IN` } : {}
  const msg = final
    ? { event: 'transcript.final', text: words, end_s: String((endMs + 600) / 1000), ...lang }
    : { event: 'transcript.partial', text: words, ...lang }
  ws.emit('message', Buffer.from(JSON.stringify(msg)))
}

let createCascadeConnection
// Module-level settings are read at import, so a test that needs different ones
// re-imports the engine after changing the environment.
async function loadEngine(env = {}) {
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v)
  vi.resetModules()
  ;({ createCascadeConnection } = await import('../src/services/cascade.js'))
}
beforeEach(async () => {
  // Pinned, whatever the developer's .env says.
  vi.stubEnv('SARVAM_API_KEY', 'sk-test')
  vi.stubEnv('TELNYX_API_KEY', 'tx-key')
  vi.stubEnv('GOOGLE_AI_API_KEY', 'g-key')
  vi.stubEnv('TELNYX_TTS_VOICE', '')
  vi.stubEnv('SARVAM_STT_SILENCE_MS', '600')
  vi.stubEnv('SARVAM_STT_MODEL', '')
  vi.stubEnv('SARVAM_STT_MODE', '')
  vi.stubEnv('SARVAM_STT_KEYTERMS', '')
  vi.stubEnv('CASCADE_LLM_MODEL', '')
  vi.stubEnv('GEMINI_EXPLICIT_CACHE', 'true')
  vi.stubEnv('TELNYX_TTS_MAX_CONCURRENT', '3')
  vi.stubEnv('CASCADE_ACK', 'false')   // on in production; tested on its own below
  // The acknowledgement warm-up is a REAL 2.5s timer that renders all 27 lines, and
  // loadEngine() resets the module that remembers it has already run — so every engine
  // a test loads schedules another one. Those fire minutes later, into whatever sink is
  // current, and the test that happens to be running then sees 27 phrases it never
  // asked for. Pushed out of reach here; the tests that want a warm cache set their own.
  vi.stubEnv('CASCADE_ACK_WARM_DELAY_MS', '999999')
  sockets.length = 0
  llmScript.length = 0
  llmCalls.length = 0
  llmRequests.length = 0
  tts.requests = []
  tts.hold = null
  tts.impl = null
  tts.real = false
  cache.name = null
  cache.refuse = false
  for (const k of Object.keys(traceState.state)) delete traceState.state[k]
  // The engine times a round trip to Google at call start; nothing else uses fetch
  // here unless a test installs the real Telnyx client.
  globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, text: async () => '{}' }))
  await loadEngine()
})
afterEach(() => vi.unstubAllEnvs())

const sttSocket = () => sockets.filter(s => s.url.includes('api.sarvam.ai')).at(-1)

async function startCall(sink = makeSink(), onTranscript = vi.fn(), cfg = {}) {
  const onReady = vi.fn()
  const engine = createCascadeConnection('CA1', { tenant_id: 't1', ...cfg }, sink, 'S1', onTranscript, onReady, '+919000000000')
  await tick()
  return { engine, sink, ws: sttSocket(), onReady, onTranscript }
}

// ── Tests ────────────────────────────────────────────────────────────────────
describe('cascade — session setup', () => {
  it('listens on Sarvam for 8k µ-law, any language, code-mixed, ending a turn after 600ms of silence', async () => {
    const { ws, onReady } = await startCall()
    const q = Object.fromEntries(new URL(ws.url).searchParams)
    expect(q).toMatchObject({
      model: 'saaras:v3-realtime', mode: 'codemix', language_code: 'auto',
      encoding: 'mulaw', sample_rate: '8000', silence_duration_ms: '600',
    })
    expect(ws.opts.headers['API-SUBSCRIPTION-KEY']).toBe('sk-test')
    expect(onReady).toHaveBeenCalledOnce()
  })

  it('speaks the greeting sentence by sentence through Telnyx, in the Ramya voice, with no full stops', async () => {
    const { sink } = await startCall()
    await tick()
    expect(tts.requests.map(r => r.text)).toEqual(['Namaste', 'How can I help you?'])
    expect(heard(sink)).toEqual(['[Namaste]', '[How can I help you?]'])
    expect(tts.requests[0]).toMatchObject({ voice: RAMYA, format: 'pcm_mulaw', sampleRate: 8000 })
  })

  it('forwards the caller\'s audio to Sarvam as it arrives', async () => {
    const { engine, ws } = await startCall()
    engine.send(Buffer.alloc(160, 0x7f))
    expect(JSON.parse(ws.sent.at(-1))).toEqual({ event: 'audio_input', audio: Buffer.alloc(160, 0x7f).toString('base64') })
  })

  it('spends nothing on the model before the caller has said anything', async () => {
    // The old warm-up sent the whole ~12,000-token prompt on every call to buy a faster
    // first turn. The prompt cache and the connection probe do that job for free.
    await startCall()
    await tick(40)
    expect(llmRequests).toHaveLength(0)
  })

  it('cannot run a call it cannot hear: without a Sarvam key it opens nothing and raises an alert', async () => {
    await loadEngine({ SARVAM_API_KEY: '' })
    const telemetry = (await import('../src/services/telemetry.js')).default
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { sink, engine } = await startCall()
    err.mockRestore()
    expect(sockets).toHaveLength(0)
    expect(tts.requests).toHaveLength(0)
    expect(heard(sink)).toEqual([])
    expect(() => { engine.send(Buffer.alloc(160)); engine.finish() }).not.toThrow()
    expect(telemetry.recordServiceEvent).toHaveBeenCalledWith(expect.objectContaining({ component: 'sarvam_stt', severity: 'critical', kind: 'missing_key' }))
  })
})

describe('cascade — a turn', () => {
  it('answers when Sarvam ends the caller\'s turn, sending sentences to the voice in order', async () => {
    const { ws, sink, onTranscript } = await startCall()
    await waitFor(() => tts.requests.length > 0)   // the greeting, before we clear it
    await tick()
    sink.frames.length = 0
    tts.requests.length = 0

    llmScript.push([text('సరే అండి. '), text('ఇంకా ఏమైనా '), text('కావాలా?'), stop(), usage()])
    sttSays(ws, 'term insurance kavali')
    await tick(40)

    expect(callerTurns(llmCalls[0]).at(-1)).toEqual({ role: 'user', content: 'term insurance kavali' })
    expect(tts.requests.map(r => r.text)).toEqual(['సరే అండి', 'ఇంకా ఏమైనా కావాలా?'])
    expect(tts.requests.every(r => r.language === 'te')).toBe(true)
    expect(heard(sink)).toEqual(['[సరే అండి]', '[ఇంకా ఏమైనా కావాలా?]'])
    expect(onTranscript).toHaveBeenCalledWith('term insurance kavali', 'user')
    expect(onTranscript).toHaveBeenCalledWith('సరే అండి. ఇంకా ఏమైనా కావాలా?', 'assistant')
  })

  it('does not respond to words Sarvam has not finished a turn on', async () => {
    const { ws } = await startCall()
    await tick()
    sttSays(ws, 'term insurance', { final: false })
    await tick()
    expect(llmCalls).toHaveLength(0)
  })

  it('reads the per-turn guidance last, after the caller\'s words', async () => {
    // With the system prompt held in the cache, the guidance cannot live inside it, so it
    // rides at the end of the conversation — the last thing the model reads.
    const { ws } = await startCall()
    await tick()
    llmScript.push([text('Sure.'), stop()])
    sttSays(ws, 'hello there')
    await tick(40)
    expect(llmCalls[0].at(-1).content).toMatch(/^THIS TURN/)
    expect(llmCalls[0][0]).toEqual({ role: 'system', content: expect.stringContaining('SYSTEM PROMPT') })
  })

  it('plays sentences in order even when a later one is synthesised first', async () => {
    const { ws, sink } = await startCall()
    await tick()
    sink.frames.length = 0
    // First sentence's TTS is slow; the second comes back immediately.
    let releaseFirst
    const firstGate = new Promise(r => { releaseFirst = r })
    tts.impl = async function* ({ text: t }) {
      if (t === 'One') await firstGate
      yield Buffer.from(`[${t}]`)
    }
    llmScript.push([text('One. Two. '), text('Three.'), stop()])
    sttSays(ws, 'hello there')
    await tick(30)
    expect(heard(sink)).toEqual([])          // nothing may jump the queue
    releaseFirst()
    await tick(30)
    expect(heard(sink)).toEqual(['[One]', '[Two]', '[Three]'])
  })
})

describe('cascade — the prompt cache', () => {
  it('sends only the conversation when Google holds the prompt', async () => {
    cache.name = 'cachedContents/abc'
    const { ws, sink } = await startCall()
    await tick()
    sink.frames.length = 0
    llmScript.push([text('Sure.'), stop()])
    sttSays(ws, 'hello there')
    await tick(40)
    expect(llmRequests.at(-1)).toMatchObject({ cachedContent: 'cachedContents/abc', system: false })
    expect(heard(sink)).toEqual(['[Sure]'])
  })

  it('answers inline when Google no longer recognises the cache, instead of failing the turn', async () => {
    // This fallback existed before and could never run: it wrapped the CALL in try/catch,
    // and a generator does nothing until it is read — so the refusal surfaced in the turn
    // loop, and the caller heard "Sorry, could you say that again?".
    cache.name = 'cachedContents/expired'
    cache.refuse = true
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { ws, sink } = await startCall()
    await tick()
    sink.frames.length = 0
    llmScript.push([text('It is 39,900 rupees.'), stop()])
    sttSays(ws, 'what is the premium')
    await tick(40)
    warn.mockRestore()
    const { forgetCache } = await import('../src/services/gemini-cache.js')
    expect(llmRequests.map(r => [r.cachedContent, r.system])).toEqual([['cachedContents/expired', false], [null, true]])
    expect(forgetCache).toHaveBeenCalledWith('cachedContents/expired')
    expect(heard(sink)).toEqual(['[It is thirty nine thousand nine hundred rupees]'])
  })

  it('never retries a reply that had already started, which would say its start twice', async () => {
    cache.name = 'cachedContents/abc'
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { ws, sink } = await startCall()
    await tick()
    sink.frames.length = 0
    llmScript.push([text('Your premium. '), new Error('stream reset')])
    sttSays(ws, 'what is the premium')
    await tick(40)
    err.mockRestore()
    expect(llmRequests).toHaveLength(1)
    expect(heard(sink)).toEqual(['[Your premium]', '[Sorry, could you say that again?]'])
  })
})

describe('cascade — lookups', () => {
  it('runs a tool call that Gemini ends with finish_reason "stop", not "tool_calls"', async () => {
    // Live test: Gemini's lookup was treated as an empty answer and nothing was said.
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

  it('stops re-sending an old knowledge result once the call has moved on', async () => {
    // Six catalogue chunks used to ride along on every later turn of the call, and only
    // the system prompt is cached — so each lookup slowed every turn after it.
    const { retrieveKnowledge } = await import('../src/services/rag.js')
    const catalogue = 'Supreme variant premium table. '.repeat(80)
    retrieveKnowledge.mockImplementationOnce(async () => catalogue)
    const { ws } = await startCall()
    await tick()
    llmScript.push(toolCall('search_knowledge'))
    llmScript.push([text('It is 39,900 rupees.'), stop()])
    sttSays(ws, 'what is the premium')
    await tick(80)
    for (const q of ['and for my wife', 'is tax included', 'okay send details']) {
      llmScript.push([text('Sure.'), stop()])
      sttSays(ws, q)
      await tick(80)
    }
    const toolContent = (call) => call.find(m => m.role === 'tool')?.content || ''
    expect(llmCalls).toHaveLength(5)
    expect(toolContent(llmCalls[3])).toContain('Supreme variant')      // two turns on: still there
    expect(toolContent(llmCalls[4])).not.toContain('Supreme variant')  // three turns on: gone
    expect(llmCalls[4]).toContainEqual({ role: 'assistant', content: 'It is 39,900 rupees.' })
  })

  it('asks for enough chunks that the answer is not split across two round-trips', async () => {
    // Measured against the live catalogue: the premium the model wanted was absent
    // from 3 chunks and present in 6, and the miss cost a whole extra model round.
    const { retrieveKnowledge } = await import('../src/services/rag.js')
    const { ws } = await startCall()
    await tick()
    llmScript.push(toolCall('search_knowledge'))
    llmScript.push([text('Thirty nine thousand nine hundred rupees.'), stop(), usage()])
    sttSays(ws, 'premium enta')
    await tick(40)
    expect(retrieveKnowledge).toHaveBeenCalledWith('t1', expect.any(String), 6, expect.any(Object))
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
})

// These used to assert that a knowledge search stayed SILENT. That was the old product
// decision, and measurement is what overturned it: a knowledge turn left the caller
// with ~4.2s of nothing, because the search has to run and then the model has to be
// asked a second time with the result. The silence was the only removable part.
describe('cascade — saying something while a slow lookup runs', () => {
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
    await loadEngine({ CASCADE_ACK: 'true', CASCADE_ACK_WARM_DELAY_MS: '0' })
    const { ws, sink } = await startCall()
    await tick(60)
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
    await loadEngine({ CASCADE_ACK: 'true', CASCADE_ACK_WARM_DELAY_MS: '0' })
    const { ws, sink } = await startCall()
    await tick(60)
    sink.frames.length = 0
    llmScript.push(toolCall('end_call'))
    llmScript.push([text('Goodbye.'), stop()])
    sttSays(ws, 'that is all thanks')
    await tick(60)
    expect(heard(sink)).toEqual(['[Goodbye]'])
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

  it('drops the acknowledgement when the caller talks over it', async () => {
    // An acknowledgement is queued audio like any other, so barge-in has to cancel it.
    // If it did not, the caller would be interrupted by "let me check" after they had
    // already moved on — the exact ghost-speech this system is supposed to prevent.
    await loadEngine({ CASCADE_ACK: 'true' })
    const { ws, sink } = await startCall()
    await tick(30)
    sink.frames.length = 0
    tts.hold = { promise: new Promise(() => {}) }   // no TTS ever returns: ack is pending
    llmScript.push(toolCall('search_knowledge'))
    llmScript.push([text('It was founded in 2001.'), stop()])
    sttSays(ws, 'when was Sanjeevani founded', { language: 'en' })
    await tick(30)
    sttSays(ws, 'actually never mind', { final: false })
    await tick(30)
    expect(sink.frames.some(f => f.event === 'clear')).toBe(true)
    expect(heard(sink)).toEqual([])
  })

  it('keeps the acknowledgement out of the conversation the model sees', async () => {
    // It is something this code said to cover a delay, not something the agent
    // decided to say. In the history it would look like the model's own words and
    // could be imitated on later turns.
    await loadEngine({ CASCADE_ACK: 'true', CASCADE_ACK_WARM_DELAY_MS: '0' })
    const { ws, onTranscript } = await startCall()
    await tick(60)
    llmScript.push(toolCall('search_knowledge'))
    llmScript.push([text('It was founded in 2001.'), stop()])
    sttSays(ws, 'when was Sanjeevani founded', { language: 'en' })
    await tick(60)
    const spokenToCaller = onTranscript.mock.calls.filter(c => c[1] === 'assistant').map(c => c[0])
    expect(spokenToCaller).toEqual(['It was founded in 2001.'])
    expect(JSON.stringify(llmCalls.at(-1))).not.toMatch(/Sure, let me check|One second, let me check/)
  })
})

describe('cascade — the voice', () => {
  it('uses the tenant\'s own Telnyx voice over the default', async () => {
    const sindhu = 'Telnyx.Ultra.07bc462a-c644-49f1-baf7-82d5599131be'
    await startCall(makeSink(), vi.fn(), { tts_voice: sindhu })
    await tick(30)
    expect(tts.requests.map(r => r.voice)).toEqual([sindhu, sindhu])
  })

  it('does not hand Telnyx a voice from an earlier engine, which it would refuse mid-call', async () => {
    // Tenants set up before Telnyx carry Soniox names ("Ishita") in tts_voice, and older
    // ones a Gemini Live name ("Kore") in voice.
    await startCall(makeSink(), vi.fn(), { tts_voice: 'Ishita', voice: 'Kore' })
    await tick(30)
    expect(tts.requests.map(r => r.voice)).toEqual([RAMYA, RAMYA])
  })

  it('retries a sentence Telnyx refuses with 429 instead of dropping it', async () => {
    let refusals = 1
    tts.impl = async function* ({ text: t }) {
      if (t === 'Two' && refusals-- > 0) throw Object.assign(new Error('Telnyx TTS 429: rate limited'), { status: 429 })
      yield Buffer.from(`[${t}]`)
    }
    const { ws, sink } = await startCall()
    await tick()
    sink.frames.length = 0
    llmScript.push([text('One. Two. Three.'), stop()])
    sttSays(ws, 'hello there')
    await tick(400)
    expect(heard(sink)).toEqual(['[One]', '[Two]', '[Three]'])
  })

  it('raises ONE critical alert when Telnyx refuses on balance, not one per sentence', async () => {
    // There is no second voice. A 402 means every sentence of every call is about to go
    // silent, which is somebody's phone ringing — once, not twice a sentence.
    tts.impl = async function* () { throw Object.assign(new Error('Telnyx TTS 402: insufficient balance'), { status: 402 }) }
    const telemetry = (await import('../src/services/telemetry.js')).default
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { ws, sink } = await startCall()
    await tick(30)
    llmScript.push([text('One. Two.'), stop()])
    sttSays(ws, 'hello there')
    await tick(60)
    err.mockRestore()
    expect(heard(sink)).toEqual([])
    const alerts = telemetry.recordServiceEvent.mock.calls.map(c => c[0]).filter(e => e.component === 'telnyx_tts')
    expect(alerts).toEqual([expect.objectContaining({ severity: 'critical', kind: 'tts_balance' })])
    // …and the call is still running: the model was asked, it was the voice that failed.
    expect(llmRequests).toHaveLength(1)
  })

  it('opens no more TTS requests at once than the limit allows', async () => {
    const CAP = 3
    let open = 0, peak = 0, release
    const gate = new Promise(r => { release = r })
    tts.impl = async function* ({ text: t }) {
      open++; peak = Math.max(peak, open)
      try {
        if (t.startsWith('A ')) await gate   // hold only this turn's sentences
        yield Buffer.from(`[${t}]`)
      } finally { open-- }
    }
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
    // Calls share the process's slots. Without priority, the second caller's opening
    // line waits behind the tail of the first caller's reply — silence for someone who
    // has heard nothing, to buffer ahead for someone who is already listening.
    const started = []
    let release
    const gate = new Promise(r => { release = r })
    tts.impl = async function* ({ text: t }) {
      started.push(t)
      if (t.startsWith('Hold')) await gate
      yield Buffer.from(`[${t}]`)
    }
    // Call A fills every slot and queues more behind them.
    createCascadeConnection('CA-A', { tenant_id: 't1' }, makeSink(), 'S-A', vi.fn(), vi.fn(), '+919000000001')
    await tick()
    llmScript.push([text('Hold one. Hold two. Hold three. Hold four. Later five.'), stop()])
    sttSays(sttSocket(), 'tell me everything')
    await tick(40)
    started.length = 0

    // Call B now starts and needs its very first sentence.
    createCascadeConnection('CA-B', { tenant_id: 't1' }, makeSink(), 'S-B', vi.fn(), vi.fn(), '+919000000002')
    await tick(20)
    release()
    await tick(120)

    const firstB = started.findIndex(t => t === 'Namaste')
    const laterA = started.indexOf('Later five')
    expect(firstB).toBeGreaterThanOrEqual(0)
    if (laterA >= 0) expect(firstB).toBeLessThan(laterA)
  })

  it('reports how long sentences waited for a TTS slot', async () => {
    // The limit is shared by every call in the process, so a single call's log cannot
    // show contention. These counters are the only place it is visible.
    const { ttsQueueStats } = await import('../src/services/cascade.js')
    expect(ttsQueueStats()).toMatchObject({
      limit: 3,
      activeStreams: expect.any(Number),
      queueDepth: expect.any(Number),
      firstSentenceQueueWaitMs: expect.any(Number),
      laterSentenceQueueWaitMs: expect.any(Number),
    })
  })
})

describe('cascade — the real Telnyx client, end to end', () => {
  // Ultra returns MP3; the fake returns a real one (0.5s of tone, 8kHz mono) so the
  // decode into the caller's µ-law runs for real.
  const MP3 = require('node:fs').readFileSync(require('node:path').join(__dirname, 'fixtures', 'tone-8k.mp3'))
  let telnyx
  const mediaBytes = (sink) => sink.frames.filter(f => f.event === 'media').reduce((n, f) => n + Buffer.from(f.media.payload, 'base64').length, 0)

  beforeEach(() => {
    tts.real = true
    telnyx = []
    globalThis.fetch = vi.fn(async (url, opts) => {
      if (!String(url).includes('api.telnyx.com')) return { ok: true, status: 200, text: async () => '{}' }
      telnyx.push(JSON.parse(opts.body))
      return { ok: true, status: 200, body: (async function* () { yield MP3 })() }
    })
  })

  it('speaks the greeting through Ultra, decoded to 8kHz µ-law, in the Ramya voice', async () => {
    const { sink } = await startCall()
    await waitFor(() => mediaBytes(sink) >= 8000)
    expect(mediaBytes(sink)).toBe(8000)                     // two sentences × 0.5s of 8kHz µ-law
    expect(telnyx.map(b => b.text)).toEqual(['Namaste', 'How can I help you?'])
    expect(telnyx[0]).toMatchObject({ voice: RAMYA, voice_settings: { sampling_rate: 8000, language_boost: 'English' } })
  })

  it('boosts Telugu for a Telugu sentence', async () => {
    const { ws, sink } = await startCall()
    await waitFor(() => mediaBytes(sink) >= 8000)
    telnyx.length = 0
    llmScript.push([text('సరే అండి. '), text('ఇంకా ఏమైనా కావాలా?'), stop(), usage()])
    sttSays(ws, 'term insurance kavali')
    await waitFor(() => telnyx.length === 2)
    expect(telnyx.map(b => b.voice_settings.language_boost)).toEqual(['Telugu', 'Telugu'])
  })
})

describe('cascade — barge-in', () => {
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
    expect(callerTurns(history).map(m => m.content)).toEqual([
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
    tts.hold = { promise: new Promise(r => { release = r }) }
    return () => release()
  }

  it('stops the agent and clears the caller buffer when the caller talks over it', async () => {
    const release = holdGreeting()
    const { ws, sink } = await startCall()
    sttSays(ws, 'wait a minute', { final: false })
    await tick()
    expect(sink.frames.some(f => f.event === 'clear')).toBe(true)
    release()
    await tick()
    expect(heard(sink)).toEqual([])   // the interrupted greeting is never played
  })

  it('treats a one-word "okay" over the agent as listening, not an interruption', async () => {
    const release = holdGreeting()
    const { ws, sink } = await startCall()
    sttSays(ws, 'okay', { final: false })
    await tick()
    expect(sink.frames.some(f => f.event === 'clear')).toBe(false)
    release()
    await tick()
    expect(heard(sink)).toEqual(['[Namaste]', '[How can I help you?]'])   // greeting carries on
  })

  it('never plays the answer to a question the caller has already talked past', async () => {
    const { ws, sink } = await startCall()
    await tick(30)
    // The answer's voice is slow to come back…
    let release
    tts.hold = { promise: new Promise(r => { release = r }) }
    llmScript.push([text('The premium is 39,900 rupees.'), stop()])
    sttSays(ws, 'what is the premium')
    await tick(30)
    sink.frames.length = 0
    // …the caller interrupts with real words, and only then does it arrive.
    sttSays(ws, 'actually four crore cover', { final: false })
    await tick(20)
    release()
    await tick(30)
    expect(heard(sink).join(' ')).not.toContain('39,900')
    expect(heard(sink).join(' ')).not.toContain('thirty nine thousand')
  })
})

describe('cascade — ending the call', () => {
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

  // end_call is declared on every call and the prompt asks for it, and the model does
  // not use it: replaying five goodbyes across three languages, 0/15. Both real calls
  // ended because the CALLER hung up. So the reply itself is read as the decision the
  // tool was supposed to carry.
  it('hangs up when the agent says goodbye without calling end_call', async () => {
    const { ws, sink } = await startCall()
    await tick()
    llmScript.push([text('సరే అండి, థాంక్యూ. ఉంటాను.'), stop()])
    sttSays(ws, 'ledu thank you')
    await tick(40)
    expect(sink.endCall).toHaveBeenCalledOnce()
  })

  it('does not hang up on a closing-sounding line that still asks something', async () => {
    const { ws, sink } = await startCall()
    await tick()
    llmScript.push([text('థాంక్యూ అండి, ఇంకేమైనా doubts ఉన్నాయా?'), stop()])
    sttSays(ws, 'sare andi')
    await tick(40)
    expect(sink.endCall).not.toHaveBeenCalled()
  })

  // "బై ది వే" is "by the way", and the agent's answer to it is not a goodbye however
  // much the caller's turn sounds like one — which is why this matches the AGENT.
  it('does not hang up when the caller says something that merely contains "bye"', async () => {
    const { ws, sink } = await startCall()
    await tick()
    llmScript.push([text('Riders కూడా ఉన్నాయి అండి, వాటి details చెప్తాను.'), stop()])
    sttSays(ws, 'బై ది వే, riders ఏమైనా ఉన్నాయా')
    await tick(40)
    expect(sink.endCall).not.toHaveBeenCalled()
  })

  it('never hangs up on the greeting', async () => {
    const { sink } = await startCall({ ...makeSink() }, vi.fn(), { greeting: 'నమస్కారం అండి. ఉంటాను.' })
    await tick(40)
    expect(sink.endCall).not.toHaveBeenCalled()
  })

  it('logs a per-call cost on finish and stops listening', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { engine, ws } = await startCall()
    engine.send(Buffer.alloc(8000))   // one second of caller audio
    engine.finish()
    expect(ws.readyState).toBe(3)
    expect(log.mock.calls.some(([m]) => /💰 call cost ≈ ₹/.test(m) && /STT 1s/.test(m) && /chars/.test(m))).toBe(true)
    log.mockRestore()
  })

  it('does not answer a transcript that arrives after the call ended', async () => {
    // Closing the STT socket is not instant. A final transcript landing after finish()
    // used to run a whole turn — LLM tokens and a TTS render, spent on a caller who has
    // hung up, and after the cost line that would have counted them was printed.
    const { ws, engine } = await startCall()
    await tick(30)
    engine.finish()
    llmScript.push([text('Nobody is listening.'), stop()])
    sttSays(ws, 'hello?', { endMs: 400 })
    await tick(60)
    expect(llmRequests).toHaveLength(0)
  })
})

describe('cascade — handing off to a person', () => {
  const HANDOFF_CFG = { handoff_number: '+919111111111', enable_handoff: true }

  beforeEach(() => transferToHuman.mockClear())

  it('transfers the call instead of saying "HANDOFF" out loud', async () => {
    const { ws, sink, onTranscript } = await startCall(makeSink(), vi.fn(), HANDOFF_CFG)
    // Clear the greeting out of the way — but only once it has actually been rendered.
    await waitFor(() => tts.requests.length > 1)
    await tick()
    sink.frames.length = 0
    tts.requests.length = 0

    llmScript.push([text('Let me put you through to the team. '), text('[HANDOFF]'), stop(), usage()])
    sttSays(ws, 'I want to speak to a person')
    // The transfer only fires once the caller has actually heard the sentence.
    await waitFor(() => transferToHuman.mock.calls.length > 0)

    expect(tts.requests.map(r => r.text)).toEqual(['Let me put you through to the team'])
    expect(heard(sink).join(' ')).not.toMatch(/HANDOFF/i)
    expect(transferToHuman).toHaveBeenCalledWith('CA1', '+919111111111', '+919000000000', expect.objectContaining({ handoff_number: '+919111111111' }))
    expect(onTranscript).toHaveBeenCalledWith('[SYSTEM] Call handed off to human agent')
  })

  it('transfers only after the caller has heard the sentence explaining it', async () => {
    const { ws } = await startCall(makeSink(), vi.fn(), HANDOFF_CFG)
    await tick(30)
    let release
    tts.hold = { promise: new Promise(r => { release = r }) }
    llmScript.push([text('One moment, connecting you. [HANDOFF]'), stop(), usage()])
    sttSays(ws, 'get me an agent')
    await tick(40)
    // The voice has not delivered a byte yet — transferring now would cut the line
    // before the caller is told what is happening.
    expect(transferToHuman).not.toHaveBeenCalled()
    release()
    await tick(40)
    expect(transferToHuman).toHaveBeenCalledOnce()
  })

  it('keeps the marker out of the history so the model does not repeat it every turn', async () => {
    const { ws } = await startCall(makeSink(), vi.fn(), HANDOFF_CFG)
    await tick()
    llmScript.push([text('Someone will call you back. [HANDOFF]'), stop(), usage()])
    sttSays(ws, 'I did not understand')
    await tick(40)
    llmScript.push([text('Sure.'), stop()])
    sttSays(ws, 'hello?')
    await tick(40)
    expect(llmCalls.at(-1).some(m => typeof m.content === 'string' && /HANDOFF/.test(m.content))).toBe(false)
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

describe('cascade — what language the caller actually spoke', () => {
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

  it('still works when Sarvam sends no language', async () => {
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

// The post-call extractor is handed trace.state.dominantLanguage. Without it, it infers
// the call's language from the text, and that inference filed Telugu calls as Hindi
// often enough to matter.
describe('cascade — the language the lead extractor is told', () => {
  it('records what Sarvam HEARD, not the script it wrote', async () => {
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
    const { ws } = await startCall()
    llmScript.push([text('Sare.'), stop()])
    sttSays(ws, 'చెప్పండి', { language: 'te' })
    await tick(40)
    expect(traceState.state.dominantLanguage).toBe('te')   // no finish() called
  })

  it('stays unset when Sarvam identified nothing', async () => {
    // Better an honest null — the extractor has a documented fallback for it — than
    // a confident guess nobody can trace back to a measurement.
    const { ws } = await startCall()
    llmScript.push([text('Sare.'), stop()])
    sttSays(ws, 'hello')
    await tick(40)
    expect(traceState.state.dominantLanguage).toBeUndefined()
  })
})

describe('cascade — the tenant\'s product names reach the STT', () => {
  it('tells Sarvam the product names when the call connects', async () => {
    const rag = await import('../src/services/rag.js')
    rag.knowledgeVocabulary.mockReturnValue(['Vaayu', 'LifeShield', 'Supreme'])
    const { ws } = await startCall(makeSink(), vi.fn(), { business_name: 'GSK insurance' })
    expect(new URL(ws.url).searchParams.get('prompt'))
      .toBe('Phone call to GSK insurance. Product names you may hear: Vaayu, LifeShield, Supreme.')
  })

  it('sends them mid-call when the knowledge was still loading at connect', async () => {
    const rag = await import('../src/services/rag.js')
    let loaded
    rag.knowledgeVocabulary.mockReturnValue(null)
    rag.whenKnowledgeLoaded.mockReturnValue(new Promise(r => { loaded = r }))
    const { ws } = await startCall(makeSink(), vi.fn(), { business_name: 'GSK insurance' })
    expect(new URL(ws.url).searchParams.has('prompt')).toBe(false)
    rag.knowledgeVocabulary.mockReturnValue(['Kavach', 'Secure'])
    loaded()
    await tick()
    const updates = ws.sent.map(x => JSON.parse(x)).filter(m => m.event === 'config.update')
    expect(updates).toEqual([{ event: 'config.update', prompt: 'Phone call to GSK insurance. Product names you may hear: Kavach, Secure.' }])
  })
})

describe('cascade — the latency it reports is the latency the caller felt', () => {
  // The whole optimisation effort rests on this number being real. speechEnd is NOT
  // "when we got the transcript" — it is the end of the caller's last word in AUDIO
  // time, translated back into wall-clock time using when that byte range was actually
  // sent. Audio buffered while the socket opened is flushed in one burst, so a fixed
  // offset would run fast and quietly flatter every measurement.
  it('measures from when the caller stopped speaking, not from when we noticed', async () => {
    const { ws, engine } = await startCall()
    await tick()
    // A second of caller audio the way Plivo sends it: 20ms, 160-byte µ-law frames.
    // end 400ms falls at byte 3200 — a moment that ALREADY HAPPENED by the time the
    // turn ends. A correct measurement has to reach back to it.
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
    const perceived = Number(/PERCEIVED (\d+)ms/.exec(block)?.[1])
    expect(Number.isFinite(perceived)).toBe(true)
    expect(perceived).toBeGreaterThan(300)
    expect(block).toContain('ENDPOINTING')
  })

  it('keeps the per-turn breakdown on the trace, not only in the console', async () => {
    // The console line was the ONLY record of where a turn's wait went, so a slow call
    // could not be explained after the fact. The trace is what reaches call_traces.
    const { ws, engine } = await startCall()
    await tick()
    for (let i = 0; i < 50; i++) { engine.send(Buffer.alloc(160, 0x7f)); await tick(1) }
    llmScript.push([text('The premium is 39,900 rupees.'), stop()])
    sttSays(ws, 'what is the premium', { endMs: 400, language: 'en' })
    await tick(60)
    const legs = traceState.state.turnLegs
    expect(legs).toHaveLength(1)
    expect(legs[0]).toMatchObject({ rounds: 1, lang: 'en' })
    expect(legs[0].perceived).toBeGreaterThan(300)
    expect(Number.isFinite(legs[0].ENDPOINTING)).toBe(true)
    expect(Number.isFinite(legs[0].LLM_TTFT)).toBe(true)
    expect(Number.isFinite(legs[0].TTS)).toBe(true)
    expect(legs[0].overAgent).toBeUndefined()
  })

  it('splits the model\'s first token into its parts, and lays the whole turn out as a timeline', async () => {
    const { ws, engine } = await startCall()
    await tick()
    for (let i = 0; i < 50; i++) { engine.send(Buffer.alloc(160, 0x7f)); await tick(1) }
    const log = vi.spyOn(console, 'log')
    llmScript.push([text('The premium is 39,900 rupees.'), stop(), usage()])
    sttSays(ws, 'what is the premium', { endMs: 400 })
    await tick(60)
    const lines = log.mock.calls.map(c => String(c[0]))
    log.mockRestore()
    const round = lines.find(l => l.includes('LLM round 1'))
    expect(round).toMatch(/first token \d+ms = build \d+/)
    expect(round).toContain('in 1200 tok (1000 cached, 200 new')
    expect(round).toContain('thinking 0')
    const timeline = lines.find(l => l.includes('TIMELINE'))
    expect(timeline).toMatch(/endpoint \+\d+ → model asked \+\d+ → first token \+\d+ → sentence to voice \+\d+ → voice first byte \+\d+ → caller hears answer \+\d+/)
    const llm = traceState.state.turnLegs.at(-1).llm
    expect(llm).toHaveLength(1)
    expect(llm[0]).toMatchObject({ in: 1200, cached: 1000 })
    expect(Number.isFinite(llm[0].build)).toBe(true)
    expect(Number.isFinite(llm[0].wait)).toBe(true)
  })

  it('marks a turn the caller spoke while the agent was still audible', async () => {
    let audible = 0
    const sink = { ...makeSink(), msRemaining: () => audible }
    const { ws, engine } = await startCall(sink)
    await tick()
    for (let i = 0; i < 50; i++) { engine.send(Buffer.alloc(160, 0x7f)); await tick(1) }
    audible = 800
    llmScript.push([text('Sure.'), stop()])
    sttSays(ws, 'wait wait one question', { endMs: 400 })
    audible = 0
    await tick(60)
    expect(traceState.state.turnLegs?.at(-1)?.overAgent).toBe(true)
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

describe('cascade — a browser is not a phone line', () => {
  // The marketing demo and the builder's test call run this same engine, but the
  // listener is on a laptop speaker, not a handset.
  it('asks for proper audio when the listener is a browser', async () => {
    const { ws } = await startCall(makeSink(), vi.fn(), { audio_io: 'pcm' })
    const q = new URL(ws.url).searchParams
    expect([q.get('encoding'), q.get('sample_rate')]).toEqual(['linear16', '16000'])
    await tick(30)
    expect(tts.requests[0]).toMatchObject({ format: 'pcm_s16le', sampleRate: 24000 })
  })

  // speechEnd comes from audio time mapped back onto wall time, and that conversion is
  // bytes-per-millisecond: 8 on a phone line, 32 from a browser. Reading it at 8 for a
  // browser does not throw — the lookup just lands on a chunk from early in the call,
  // so the reported wait grows with the call itself. On a real demo it climbed 14s →
  // 121s over six turns and named ENDPOINTING the bottleneck every time.
  //
  // The assertion that matters is the UPPER bound. A lower bound passes with the bug.
  async function endpointingFor(audioIo, bytesPerFrame, endMs) {
    const { ws, engine } = await startCall(makeSink(), vi.fn(), audioIo ? { audio_io: audioIo } : {})
    await tick()
    const startedStreaming = Date.now()
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
    const { endpointing, streamedMs } = await endpointingFor('pcm', 640, 990)
    expect(Number.isFinite(endpointing)).toBe(true)
    expect(endpointing).toBeLessThan(streamedMs / 2)
  })

  it('still anchors it correctly on a phone line', async () => {
    const { endpointing, streamedMs } = await endpointingFor(null, 160, 990)
    expect(Number.isFinite(endpointing)).toBe(true)
    expect(endpointing).toBeLessThan(streamedMs / 2)
  })

  it('bills browser audio at the browser\'s sample rates', async () => {
    // 8kHz µ-law rates on a 16k call read 4× the STT. A demo call once invoiced ₹15 for
    // speech, of which roughly ₹10 was arithmetic.
    const log = vi.spyOn(console, 'log')
    const { engine } = await startCall(makeSink(), vi.fn(), { audio_io: 'pcm' })
    await tick(30)
    engine.send(Buffer.alloc(32000 * 5))   // 5 seconds of caller audio
    engine.finish()
    const cost = log.mock.calls.map(c => String(c[0])).find(l => l.includes('call cost'))
    log.mockRestore()
    expect(cost).toMatch(/STT 5(\.0)?s/)
  })
})

describe('cascade — the voice rules never hand the model a fact to repeat', () => {
  // The digits rule once showed "98.4 percent" as a formatting example, and on a real
  // GSK call the agent told the caller the company's claim settlement ratio was 98.4
  // percent. That figure is in no knowledge chunk and no tenant setting — only there.
  it('uses no rate- or ratio-like example, and says the examples are format only', async () => {
    const { VOICE_OUTPUT_RULES } = await import('../src/services/cascade.js')
    expect(VOICE_OUTPUT_RULES).not.toMatch(/\d+(?:\.\d+)?\s*(?:percent|%)/i)
    expect(VOICE_OUTPUT_RULES).toMatch(/format only/i)
  })
})
