// The language state machine.
//
// Its whole job is deciding when NOT to act. Indian callers code-mix constantly —
// Telugu grammar carrying English business nouns, a Hindi sentence with "EMI" and
// "payment" in it — so a detector that moved on every signal would oscillate
// mid-call and answer each turn in a different language. Everything here is about
// resisting that while still obeying a caller who genuinely asks to switch.
//
// No network: `classify` is stubbed per instance, which is also the seam the
// engine relies on. A test that reached the real classifier would be slow, flaky,
// and would bill for tokens.

import { describe, it, expect, beforeEach } from 'vitest'
import { LanguageManager, toCode, toName } from '../src/services/language-manager.js'

// `ai: {}` keeps the constructor from building a real GoogleGenAI client.
// Cooldown defaults to the production value; tests that need a SECOND switch
// pass `{ cooldownMs: 0 }` explicitly, so the cooldown is never disabled silently.
function makeLM(verdicts = [], config = {}) {
  const lm = new LanguageManager({ ai: {}, config })
  const queue = [...verdicts]
  lm.calls = 0
  lm.classify = async () => {
    lm.calls += 1
    return queue.length ? queue.shift() : null
  }
  return lm
}

// A classifier verdict in the current schema.
const say = (language, confidence = 0.95, extra = {}) => ({
  language,
  confidence,
  meaningful: true,
  explicitSwitch: false,
  requestedLanguage: null,
  reason: 'test',
  ...extra,
})

// Establish Telugu and hand back a manager sitting in LOCKED(te). Telugu — not
// English — because once English is committed, Latin text short-circuits before
// the classifier, so a streak test built on an English base would pass while
// testing nothing.
async function lockedTelugu(config = {}) {
  const lm = makeLM([say('te')], config)
  await lm.ingest('naaku moodu bedroom kavali Kokapet lo')
  expect(lm.current).toBe('te')
  return lm
}

describe('canonical representation', () => {
  it('maps every spelling of a language onto one code', () => {
    expect(toCode('Telugu')).toBe('te')
    expect(toCode('telugu')).toBe('te')
    expect(toCode('TE')).toBe('te')
    expect(toCode('te-IN')).toBe('te')
    expect(toCode('Hindi')).toBe('hi')
    expect(toCode('bangla')).toBe('bn')
  })

  it('returns null rather than guessing for unknown values', () => {
    expect(toCode('unknown')).toBeNull()
    expect(toCode('Klingon')).toBeNull()
    expect(toCode('')).toBeNull()
    expect(toCode(null)).toBeNull()
  })

  it('renders display names for prompts', () => {
    expect(toName('te')).toBe('Telugu')
    expect(toName('or')).toBe('Odia')
    expect(toName('zz')).toBeNull()
  })
})

// ─── The spec's numbered cases ──────────────────────────────────────────────

describe('initial language lock', () => {
  it('Test 1 — locks Telugu on a meaningful Telugu utterance', async () => {
    const lm = makeLM([say('te', 0.93)])
    const r = await lm.ingest('Namaskaram sir, nenu loan gurinchi telusukovali.')
    expect(r.action).toBe('init')
    expect(lm.current).toBe('te')
  })

  it('Test 2 — locks English on a meaningful English utterance', async () => {
    const lm = makeLM([say('en', 0.97)])
    const r = await lm.ingest('Hello, I want to know about my loan payment.')
    expect(r.action).toBe('init')
    expect(lm.current).toBe('en')
  })

  it('has no language until something meaningful arrives', () => {
    const lm = makeLM()
    expect(lm.current).toBeNull()
    expect(lm.state).toBe('UNKNOWN')
  })

  it('is not initialised by a greeting, and does not pay for classifying one', async () => {
    const lm = makeLM()
    const r = await lm.ingest('Hello sir')
    expect(r.action).toBe('none')
    expect(r.reason).toBe('filler')
    expect(lm.current).toBeNull()
    expect(lm.calls).toBe(0)
  })

  it('ignores empty and whitespace-only input', async () => {
    const lm = makeLM()
    expect((await lm.ingest('')).reason).toBe('empty')
    expect((await lm.ingest('   ')).reason).toBe('empty')
    expect(lm.calls).toBe(0)
  })

  it('refuses to lock in below the initial-confidence bar', async () => {
    const lm = makeLM([say('hi', 0.4)])
    const r = await lm.ingest('mujhe loan ke baare mein jaanna hai')
    expect(r.action).toBe('none')
    expect(r.reason).toBe('init_confidence_too_low')
    expect(lm.current).toBeNull()
  })
})

describe('code-mixing must not switch the language', () => {
  it('Test 3 — English business nouns inside Telugu grammar', async () => {
    const lm = await lockedTelugu()
    lm.classify = async () => say('te', 0.92)
    const r = await lm.ingest('Sir, naa EMI payment pending undi.')
    expect(r.action).toBe('none')
    expect(lm.current).toBe('te')
  })

  it('Test 4 — an English-heavy question with Telugu grammar', async () => {
    const lm = await lockedTelugu()
    lm.classify = async () => say('te', 0.9)
    await lm.ingest('Account details check cheyyagalara?')
    expect(lm.current).toBe('te')
  })

  it('Test 5 — a bare acknowledgement never reaches the classifier', async () => {
    const lm = await lockedTelugu()
    const before = lm.calls
    const r = await lm.ingest('Okay sir.')
    expect(r.reason).toBe('filler')
    expect(lm.calls).toBe(before)
    expect(lm.current).toBe('te')
  })

  it('Test 10 — a bare English greeting', async () => {
    const lm = await lockedTelugu()
    await lm.ingest('Hello')
    expect(lm.current).toBe('te')
  })

  it('Test 11 — a romanised Hindi filler', async () => {
    const lm = await lockedTelugu()
    const before = lm.calls
    await lm.ingest('Achha, okay.')
    expect(lm.calls).toBe(before)
    expect(lm.current).toBe('te')
  })

  it('Test 16 — Telugu/Hindi mixing stays put while the primary reads Telugu', async () => {
    const lm = await lockedTelugu()
    lm.classify = async () => say('te', 0.85)
    await lm.ingest('Sir mujhe loan status kavali.')
    expect(lm.current).toBe('te')
  })

  it('a string of only English business terms is not evidence of English', async () => {
    const lm = await lockedTelugu()
    const before = lm.calls
    const r = await lm.ingest('EMI payment pending')
    expect(r.reason).toBe('filler')       // no language signal at all
    expect(lm.calls).toBe(before)
    expect(lm.current).toBe('te')
  })
})

describe('implicit switching needs confirmation', () => {
  it('Test 6 — one confident English turn makes a candidate, not a switch', async () => {
    const lm = await lockedTelugu()
    lm.classify = async () => say('en', 0.9)
    const r = await lm.ingest('Can you tell me the payment date?')
    expect(r.action).toBe('none')
    expect(lm.candidateLanguage).toBe('en')
    expect(lm.candidateCount).toBe(1)
    expect(lm.state).toBe('CANDIDATE')
    expect(lm.current).toBe('te')
  })

  it('Test 7 — the second consecutive English turn switches', async () => {
    const lm = await lockedTelugu()
    lm.classify = async () => say('en', 0.9)
    await lm.ingest('Can you tell me the payment date?')
    const r = await lm.ingest('I need to know when I should pay.')
    expect(r.action).toBe('switch')
    expect(r.previousLanguage).toBe('te')
    expect(lm.current).toBe('en')
  })

  it('Test 13 — a genuine Telugu → Hindi move', async () => {
    const lm = await lockedTelugu()
    lm.classify = async () => say('hi', 0.91)
    await lm.ingest('Mujhe apne loan ke baare mein jaanna hai.')
    expect(lm.current).toBe('te')
    await lm.ingest('Kitna amount pending hai?')
    expect(lm.current).toBe('hi')
  })

  it('ignores signals below the switch-confidence bar however many arrive', async () => {
    const lm = await lockedTelugu()
    lm.classify = async () => say('en', 0.61)
    for (let i = 0; i < 5; i++) await lm.ingest('some latin utterance number ' + i)
    expect(lm.current).toBe('te')
    expect(lm.candidateLanguage).toBeNull()
  })

  it('discards a half-built streak when the caller reverts', async () => {
    const lm = await lockedTelugu()
    const seq = [say('hi', 0.95), say('te', 0.95), say('hi', 0.95)]
    let i = 0
    lm.classify = async () => seq[i++]
    await lm.ingest('mujhe do bedroom chahiye')
    await lm.ingest('inka enti cheppandi andi')
    const r = await lm.ingest('mujhe do bedroom chahiye')
    expect(r.action).toBe('none')
    expect(lm.current).toBe('te')
  })

  it('resets the streak when a weak signal interrupts it', async () => {
    const lm = await lockedTelugu()
    const seq = [say('hi', 0.95), say('hi', 0.4), say('hi', 0.95)]
    let i = 0
    lm.classify = async () => seq[i++]
    await lm.ingest('first latin utterance here')
    await lm.ingest('second latin utterance here')
    const r = await lm.ingest('third latin utterance here')
    expect(r.action).toBe('none')
    expect(lm.current).toBe('te')
  })

  it('requires a fresh streak for each subsequent switch', async () => {
    // cooldownMs 0 so this exercises the streak rule, not the cooldown.
    const lm = await lockedTelugu({ cooldownMs: 0 })
    lm.classify = async () => say('hi', 0.95)
    await lm.ingest('first latin utterance here')
    await lm.ingest('second latin utterance here')
    expect(lm.current).toBe('hi')
    lm.classify = async () => say('en', 0.95)
    expect((await lm.ingest('third latin utterance here')).action).toBe('none')
    expect(lm.current).toBe('hi')
    expect((await lm.ingest('fourth latin utterance here')).action).toBe('switch')
    expect(lm.current).toBe('en')
  })
})

describe('explicit requests win immediately', () => {
  it('Test 8 — "English lo matladandi please"', async () => {
    const lm = await lockedTelugu()
    const before = lm.calls
    const r = await lm.ingest('English lo matladandi please.')
    expect(r.action).toBe('switch')
    expect(r.reason).toBe('explicit_request')
    expect(lm.current).toBe('en')
    expect(lm.calls).toBe(before)   // parsed locally, no model call
  })

  it('Test 9 — "Hindi mein baat kijiye"', async () => {
    const lm = await lockedTelugu()
    const r = await lm.ingest('Hindi mein baat kijiye.')
    expect(r.action).toBe('switch')
    expect(lm.current).toBe('hi')
  })

  it('handles the plain English phrasings', async () => {
    for (const phrase of ['Can you speak English?', 'Please talk to me in English', 'English please']) {
      const lm = await lockedTelugu()
      await lm.ingest(phrase)
      expect(lm.current, phrase).toBe('en')
    }
  })

  it('honours a request written in native script', async () => {
    const lm = await lockedTelugu()
    await lm.ingest('हिंदी में बात कीजिए')
    expect(lm.current).toBe('hi')
  })

  it('can establish the language straight from a request', async () => {
    const lm = makeLM()
    const r = await lm.ingest('please speak in Tamil')
    expect(r.action).toBe('init')
    expect(lm.current).toBe('ta')
  })

  it('does not treat a request for the language already in use as a switch', async () => {
    const lm = await lockedTelugu()
    const r = await lm.ingest('telugu lo matladandi')
    expect(r.action).toBe('none')
    expect(lm.current).toBe('te')
  })

  it('bypasses the cooldown', async () => {
    const lm = await lockedTelugu({ cooldownMs: 60_000 })
    await lm.ingest('Hindi mein baat kijiye.')
    expect(lm.current).toBe('hi')
    await lm.ingest('English please')       // still inside the cooldown window
    expect(lm.current).toBe('en')
  })

  it('defers to the classifier when two languages are named, rather than guessing', async () => {
    // "Telugu, not Hindi" — a regex cannot tell the wanted language from the
    // rejected one, and guessing here once locked exactly the wrong one.
    const lm = await lockedTelugu()
    expect(lm.parseSwitchTarget('Telugu lo matladandi, Hindi lo kadu')).toBeNull()
    lm.classify = async () => say('te', 0.95, { explicitSwitch: true, requestedLanguage: 'te' })
    await lm.ingest('Telugu lo matladandi, Hindi lo kadu')
    expect(lm.current).toBe('te')
  })

  it('does not read a passing mention of a language as a request', async () => {
    const lm = await lockedTelugu()
    lm.classify = async () => say('te', 0.9)
    expect(lm.looksLikeSwitchRequest('I filled the English form yesterday')).toBe(false)
    await lm.ingest('I filled the English form yesterday')
    expect(lm.current).toBe('te')
  })
})

describe('Test 12 — cooldown after a switch', () => {
  it('refuses a second implicit switch inside the cooldown window', async () => {
    const lm = await lockedTelugu({ cooldownMs: 7000 })
    lm.classify = async () => say('hi', 0.95)
    await lm.ingest('mujhe loan ke baare mein jaanna hai')
    await lm.ingest('kitna amount pending hai bhai')
    expect(lm.current).toBe('hi')
    expect(lm.state).toBe('COOLDOWN')

    lm.classify = async () => say('en', 0.99)
    const a = await lm.ingest('what is the payment date')
    const b = await lm.ingest('please tell me the amount')
    expect(a.reason).toBe('cooldown')
    expect(b.reason).toBe('cooldown')
    expect(lm.current).toBe('hi')
  })
})

describe('script handling', () => {
  it('Test 14 — romanised Telugu is Telugu, not English', async () => {
    const lm = makeLM([say('te', 0.94)])
    await lm.ingest('Nenu naa loan payment gurinchi telusukovali.')
    expect(lm.current).toBe('te')
  })

  it('Test 15 — romanised Hindi is Hindi, not English', async () => {
    const lm = makeLM([say('hi', 0.94)])
    await lm.ingest('Mujhe mere loan ka payment status jaana hai.')
    expect(lm.current).toBe('hi')
  })

  it('commits an unambiguous script immediately, with no classifier call', async () => {
    const lm = makeLM()
    const r = await lm.ingest('నాకు మూడు బెడ్‌రూమ్ కావాలి')
    expect(r.action).toBe('init')
    expect(lm.current).toBe('te')
    expect(lm.calls).toBe(0)
  })

  it('does NOT treat Devanagari as proof of Hindi — Marathi shares the script', async () => {
    // The regression that filed Telugu calls as Hindi: script used to commit at
    // 0.97 with no verification. Devanagari must now be classified.
    const lm = makeLM([say('hi', 0.93)])
    await lm.ingest('मुझे तीन बीएचके चाहिए')
    expect(lm.calls).toBe(1)
    expect(lm.current).toBe('hi')
  })

  it('will not switch on garbled Devanagari the classifier cannot read', async () => {
    // Real failure: the transcription channel rendered Telugu speech as Devanagari
    // nonsense, twice in a row, and flipped an 11-turn Telugu call to Hindi.
    const lm = await lockedTelugu()
    lm.classify = async () => say('unknown', 0.2, { meaningful: false })
    await lm.ingest('ले ले फोन पर टाइम।')
    await lm.ingest('मैं तो फोन पे दे देना ना तुमको प्रीमियम')
    expect(lm.current).toBe('te')
  })

  it('makes even an unambiguous foreign script earn a confirmation', async () => {
    const lm = await lockedTelugu()
    const r = await lm.ingest('எனக்கு மூன்று படுக்கையறை வேண்டும்')
    expect(r.action).toBe('none')
    expect(lm.candidateLanguage).toBe('ta')
    expect(lm.current).toBe('te')
  })

  it('treats script matching the current language as free confirmation', async () => {
    const lm = await lockedTelugu()
    const before = lm.calls
    const r = await lm.ingest('నాకు ధర తెలుసుకోవాలి అండి')
    expect(r.reason).toBe('script_matches_current')
    expect(lm.calls).toBe(before)
  })

  it('does not let a single stray glyph decide the language', async () => {
    const lm = makeLM([say('en', 0.9)])
    await lm.ingest('the price is ३ crore please tell me')
    expect(lm.lastResult.reason).not.toContain('script')
  })
})

describe('oscillation resistance', () => {
  it('never switches when the caller alternates every single turn', async () => {
    const lm = await lockedTelugu()
    const alternating = ['hi', 'en', 'hi', 'en', 'hi', 'en']
    let i = 0
    lm.classify = async () => say(alternating[i++], 0.95)
    const actions = []
    for (let n = 0; n < alternating.length; n++) {
      actions.push((await lm.ingest('latin utterance number ' + n)).action)
    }
    expect(actions.every((a) => a === 'none')).toBe(true)
    expect(lm.current).toBe('te')
  })
})

describe('failure behaviour — never destabilise', () => {
  it('keeps the current language when the classifier throws', async () => {
    const lm = await lockedTelugu()
    lm.classify = async () => { throw new Error('503 model overloaded') }
    const r = await lm.ingest('inka enti cheppandi andi')
    expect(r.reason).toBe('classifier_failed')
    expect(lm.current).toBe('te')
  })

  it('keeps the current language when the classifier returns nothing', async () => {
    const lm = await lockedTelugu()
    lm.classify = async () => null
    expect((await lm.ingest('inka enti cheppandi andi')).reason).toBe('classifier_malformed')
    expect(lm.current).toBe('te')
  })

  it('keeps the current language on an unrecognised verdict', async () => {
    const lm = await lockedTelugu()
    lm.classify = async () => say('Klingon', 0.99)
    expect((await lm.ingest('inka enti cheppandi andi')).reason).toBe('unknown_language')
    expect(lm.current).toBe('te')
  })

  it('backs off instead of retrying a failing classifier every turn', async () => {
    const lm = await lockedTelugu()
    let attempts = 0
    lm.classify = async () => { attempts += 1; throw new Error('503') }
    await lm.ingest('first latin utterance here')
    expect(attempts).toBe(1)
    await lm.ingest('second latin utterance here')
    expect(attempts).toBe(1)   // suppressed by the backoff window
    expect(lm.current).toBe('te')
  })
})

describe('classifier frugality', () => {
  it('does not classify Latin text once English is established', async () => {
    const lm = makeLM([say('en')])
    await lm.ingest('I am looking for a flat in Kokapet')
    const after = lm.calls
    await lm.ingest('what is the price of it')
    await lm.ingest('and what is the size')
    expect(lm.calls).toBe(after)
    expect(lm.current).toBe('en')
  })

  it('does classify Latin text while an Indic language is established', async () => {
    const lm = await lockedTelugu()
    const after = lm.calls
    await lm.ingest('what is the price of it')
    expect(lm.calls).toBeGreaterThan(after)
  })
})

describe('call-level reporting', () => {
  it('files the call under the dominant language, not the last one', async () => {
    // A late mis-detection must cost one vote, not rewrite the whole call.
    const lm = await lockedTelugu({ cooldownMs: 0 })
    lm.classify = async () => say('te', 0.9)
    for (let i = 0; i < 8; i++) await lm.ingest('telugu utterance number ' + i)
    lm.classify = async () => say('hi', 0.95)
    await lm.ingest('hindi utterance one here')
    await lm.ingest('hindi utterance two here')
    expect(lm.current).toBe('hi')
    expect(lm.dominant).toBe('te')
  })
})

describe('guessLanguage (synchronous, for text we authored)', () => {
  let lm
  beforeEach(() => { lm = makeLM() })

  it('reads Indic script directly', () => {
    expect(lm.guessLanguage('मुझे तीन बीएचके चाहिए')).toBe('hi')
    expect(lm.guessLanguage('నాకు మూడు బెడ్‌రూమ్ కావాలి')).toBe('te')
  })

  it('treats Latin text as English', () => {
    expect(lm.guessLanguage('Namaste, I am Priya from Acme.')).toBe('en')
  })

  it('returns null for empty text', () => {
    expect(lm.guessLanguage('')).toBeNull()
  })
})

describe('shouldGate — only for synchronous decisions', () => {
  it('gates a locally-parsed explicit request', async () => {
    const lm = await lockedTelugu()
    expect(lm.shouldGate('English lo matladandi')).toBe(true)
  })

  it('gates an unambiguous foreign script', async () => {
    const lm = await lockedTelugu()
    expect(lm.shouldGate('எனக்கு மூன்று படுக்கையறை வேண்டும்')).toBe(true)
  })

  it('does NOT gate ambiguous Devanagari — that needs the classifier', async () => {
    const lm = await lockedTelugu()
    expect(lm.shouldGate('मुझे तीन बीएचके चाहिए')).toBe(false)
  })

  it('does NOT gate Latin text, which would just add dead air', async () => {
    const lm = await lockedTelugu()
    expect(lm.shouldGate('what is the price of it')).toBe(false)
  })

  it('does not gate filler', async () => {
    const lm = await lockedTelugu()
    expect(lm.shouldGate('okay sir')).toBe(false)
  })
})
