// The language hysteresis state machine.
//
// Its whole job is deciding when NOT to act. Indian callers code-mix constantly —
// Telugu grammar carrying English nouns, a Hindi sentence with "booking" and "EMI"
// in it — so a detector that switched on every signal would oscillate mid-call and
// the agent would answer each turn in a different language. Everything here is
// about resisting that while still obeying a caller who genuinely asks to switch.
//
// No network: `classify` is stubbed per instance, which is also the seam the engine
// itself relies on. A test that reached the real classifier would be slow, flaky,
// and would bill for tokens.

import { describe, it, expect, beforeEach } from 'vitest'
import { LanguageManager } from '../src/services/language-manager.js'

// `ai: {}` keeps the constructor from building a real GoogleGenAI client.
function makeLM(verdicts = []) {
  const lm = new LanguageManager({ ai: {} })
  const queue = [...verdicts]
  lm.calls = 0
  lm.classify = async () => {
    lm.calls += 1
    return queue.length ? queue.shift() : null
  }
  return lm
}

const say = (language, confidence = 0.95, extra = {}) => ({
  language,
  confidence,
  is_substantive: true,
  explicit_switch: false,
  requested_language: null,
  ...extra,
})

describe('initialisation', () => {
  it('has no language until the first substantive utterance', () => {
    expect(makeLM().current).toBeNull()
  })

  it('takes its language from the first substantive utterance', async () => {
    const lm = makeLM([say('Hindi')])
    expect(await lm.ingest('mujhe teen BHK chahiye Kokapet mein')).toBe('Hindi')
    expect(lm.current).toBe('Hindi')
    expect(lm.lastDecision.reason).toBe('init')
  })

  it('is not initialised by a greeting', async () => {
    const lm = makeLM()
    expect(await lm.ingest('hello')).toBeNull()
    expect(lm.current).toBeNull()
    // Filler must not even reach the classifier — it would be a paid call per hello.
    expect(lm.calls).toBe(0)
  })

  it('ignores empty and whitespace-only input', async () => {
    const lm = makeLM()
    expect(await lm.ingest('')).toBeNull()
    expect(await lm.ingest('   ')).toBeNull()
    expect(lm.calls).toBe(0)
  })
})

describe('script detection (no classifier)', () => {
  it('commits immediately on a run of Devanagari', async () => {
    const lm = makeLM()
    expect(await lm.ingest('मुझे तीन बीएचके चाहिए')).toBe('Hindi')
    expect(lm.calls).toBe(0)
    expect(lm.lastDecision.source).toBe('unicode')
  })

  it('commits immediately on a run of Telugu script', async () => {
    const lm = makeLM()
    expect(await lm.ingest('నాకు మూడు బెడ్‌రూమ్ కావాలి')).toBe('Telugu')
    expect(lm.calls).toBe(0)
  })

  it('does not let a single stray glyph decide the language', async () => {
    // Borrowed words and one-off characters must not flip a conversation.
    const lm = makeLM([say('English')])
    await lm.ingest('the price is ३ crore')
    expect(lm.lastDecision.source).not.toBe('unicode')
  })
})

describe('explicit switch requests', () => {
  it('switches at once, with no classifier call and no streak', async () => {
    const lm = makeLM([say('English')])
    await lm.ingest('I am looking for a flat in Kokapet')
    expect(lm.current).toBe('English')
    const before = lm.calls
    expect(await lm.ingest('please speak in Hindi')).toBe('Hindi')
    expect(lm.current).toBe('Hindi')
    expect(lm.calls).toBe(before) // parsed locally
    expect(lm.lastDecision.source).toBe('explicit_request')
  })

  it('honours a romanised Indic request form', async () => {
    const lm = makeLM([say('English')])
    await lm.ingest('I want a three bedroom flat')
    expect(await lm.ingest('telugu lo matladandi')).toBe('Telugu')
    expect(lm.current).toBe('Telugu')
  })

  it('honours a request written in Devanagari', async () => {
    const lm = makeLM([say('English')])
    await lm.ingest('I want a three bedroom flat')
    expect(await lm.ingest('हिंदी में बात कीजिए')).toBe('Hindi')
  })

  it('stays silent when asked for the language already in use', async () => {
    const lm = makeLM([say('English')])
    await lm.ingest('I want a three bedroom flat')
    // Nothing to steer — but it must not be treated as a switch either.
    expect(await lm.ingest('please speak in English')).toBeNull()
    expect(lm.current).toBe('English')
  })

  it('can initialise straight from an explicit request', async () => {
    const lm = makeLM()
    expect(await lm.ingest('please speak in Tamil')).toBe('Tamil')
    expect(lm.current).toBe('Tamil')
  })
})

describe('the two-signal streak', () => {
  // Deliberately established as TELUGU, not English. Once English is committed,
  // Latin text short-circuits before the classifier (see "classifier frugality"),
  // so a streak test built on an English base would never reach the streak code at
  // all — it would pass while testing nothing. An Indic current language is the
  // state in which Latin input is genuinely ambiguous and gets classified.
  let lm
  beforeEach(async () => {
    lm = makeLM([say('Telugu')])
    await lm.ingest('naaku moodu bedroom kavali Kokapet lo')
    expect(lm.current).toBe('Telugu')
  })

  it('does not switch on a single confident signal', async () => {
    lm.classify = async () => say('Hindi', 0.95)
    expect(await lm.ingest('mujhe do bedroom chahiye')).toBeNull()
    expect(lm.current).toBe('Telugu')
  })

  it('switches on the second consecutive confident signal', async () => {
    lm.classify = async () => say('Hindi', 0.95)
    await lm.ingest('mujhe do bedroom chahiye')
    expect(await lm.ingest('price kya hai')).toBe('Hindi')
    expect(lm.current).toBe('Hindi')
    expect(lm.lastDecision.reason).toBe('streak')
  })

  it('ignores signals below the confidence threshold entirely', async () => {
    lm.classify = async () => say('Hindi', 0.5)
    for (let i = 0; i < 5; i++) await lm.ingest('kuch bhi bolo')
    expect(lm.current).toBe('Telugu')
  })

  it('discards a half-built streak when the caller reverts', async () => {
    // Telugu → one Hindi signal → back to Telugu → one Hindi signal.
    // Two Hindi signals in total, but never consecutive, so no switch.
    const seq = [say('Hindi', 0.95), say('Telugu', 0.95), say('Hindi', 0.95)]
    let i = 0
    lm.classify = async () => seq[i++]
    await lm.ingest('mujhe do bedroom chahiye')
    await lm.ingest('inka enti cheppandi')
    expect(await lm.ingest('mujhe do bedroom chahiye')).toBeNull()
    expect(lm.current).toBe('Telugu')
  })

  it('resets the streak when a weak signal interrupts it', async () => {
    const seq = [say('Hindi', 0.95), say('Hindi', 0.4), say('Hindi', 0.95)]
    let i = 0
    lm.classify = async () => seq[i++]
    await lm.ingest('one utterance')
    await lm.ingest('two utterance')
    expect(await lm.ingest('three utterance')).toBeNull()
    expect(lm.current).toBe('Telugu')
  })

  it('requires a fresh streak for each subsequent switch', async () => {
    lm.classify = async () => say('Hindi', 0.95)
    await lm.ingest('first utterance')
    await lm.ingest('second utterance')
    expect(lm.current).toBe('Hindi')
    // Hindi is also non-English, so Latin input is still classified. One English
    // signal must not be enough the second time either.
    lm.classify = async () => say('English', 0.95)
    expect(await lm.ingest('third utterance')).toBeNull()
    expect(lm.current).toBe('Hindi')
    expect(await lm.ingest('fourth utterance')).toBe('English')
  })
})

describe('oscillation resistance', () => {
  it('never switches when the caller alternates every single turn', async () => {
    // The failure this whole machine exists to prevent: the agent changing
    // language every turn until the call is unusable. Based on Telugu so the
    // classifier is actually consulted each turn.
    const lm = makeLM([say('Telugu')])
    await lm.ingest('naaku moodu bedroom kavali')
    const alternating = ['Hindi', 'English', 'Hindi', 'English', 'Hindi', 'English']
    let i = 0
    lm.classify = async () => say(alternating[i++], 0.95)
    const steers = []
    for (let n = 0; n < alternating.length; n++) steers.push(await lm.ingest('utterance number ' + n))
    expect(steers.every((s) => s === null)).toBe(true)
    expect(lm.current).toBe('Telugu')
  })
})

describe('classifier degradation', () => {
  it('keeps the current language when the classifier throws', async () => {
    const lm = makeLM([say('Telugu')])
    await lm.ingest('naaku moodu bedroom kavali')
    expect(lm.current).toBe('Telugu')
    lm.classify = async () => { throw new Error('503 model overloaded') }
    expect(await lm.ingest('inka enti')).toBeNull()
    expect(lm.current).toBe('Telugu') // never destabilise on failure
  })

  it('keeps the current language when the classifier returns nothing', async () => {
    const lm = makeLM([say('Telugu'), null])
    await lm.ingest('naaku moodu bedroom kavali')
    expect(await lm.ingest('inka enti')).toBeNull()
    expect(lm.current).toBe('Telugu')
  })

  it('backs off from the classifier after a failure instead of retrying every turn', async () => {
    // Under a provider outage this is the difference between one failed call per
    // turn and a stampede against a service already in trouble.
    const lm = makeLM([say('Telugu')])
    await lm.ingest('naaku moodu bedroom kavali')
    let attempts = 0
    lm.classify = async () => { attempts += 1; throw new Error('503') }
    await lm.ingest('first latin utterance')
    expect(attempts).toBe(1)
    await lm.ingest('second latin utterance')
    expect(attempts).toBe(1) // suppressed by the backoff window
    expect(lm.current).toBe('Telugu')
  })
})

describe('classifier frugality in steady state', () => {
  it('does not classify Latin text once English is established', async () => {
    // Latin text on an English call carries no switch signal, so paying for a
    // classification on every turn would be pure cost.
    const lm = makeLM([say('English')])
    await lm.ingest('I am looking for a flat')
    const after = lm.calls
    await lm.ingest('what is the price')
    await lm.ingest('and the size')
    expect(lm.calls).toBe(after)
    expect(lm.current).toBe('English')
  })

  it('does classify Latin text while an Indic language is established', async () => {
    // Here Latin text IS ambiguous — it may mean the caller moved to English.
    const lm = makeLM([say('Telugu')])
    await lm.ingest('naaku moodu bedroom kavali')
    const after = lm.calls
    await lm.ingest('what is the price')
    expect(lm.calls).toBeGreaterThan(after)
  })
})

describe('guessLanguage (synchronous, used for the opening line)', () => {
  it('reads Indic script directly', () => {
    const lm = makeLM()
    expect(lm.guessLanguage('मुझे तीन बीएचके चाहिए')).toBe('Hindi')
    expect(lm.guessLanguage('నాకు మూడు బెడ్‌రూమ్ కావాలి')).toBe('Telugu')
  })

  it('treats Latin text as English', () => {
    // Sound for text WE authored — nobody writes a greeting in romanised Telugu.
    expect(makeLM().guessLanguage('Namaste, I am Priya from Acme.')).toBe('English')
  })
})
