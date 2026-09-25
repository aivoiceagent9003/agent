// cascade-cost.js — what a call on the voice engine (see cascade.js) actually cost.
//
// Nothing here is re-billed per turn — a cost line is a sum of what each piece did:
//   STT  — seconds of caller audio streamed to Sarvam (per hour)
//   LLM  — Gemini prompt + completion tokens actually used; the part of the prompt
//          served from the explicit cache is billed at the cached rate
//   TTS  — characters sent to Telnyx (per billable character — see billableChars)
//
// Audio is counted in BYTES, and bytes only become seconds once you know the format —
// so the caller hands in its audio profile's rates. A phone line is 8000 B/s each way;
// a browser is 32000 in and 48000 out. Rates are list prices, overridable by env —
// the bill is the truth, this estimates it.

// The conversion the rupee figures in the call log are built on. It is a CONSTANT and
// it drifts: override USD_INR when the difference starts to matter. Every ₹ number this
// module prints scales with it.
const USD_INR = Number(process.env.USD_INR) || 95.97

const num = (v, d) => (v !== undefined && String(v).trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : d)

// List prices, USD per 1M tokens, for the Gemini models CASCADE_LLM_MODEL can name. A
// model not listed here is priced as gemini-3.5-flash-lite unless CASCADE_LLM_PRICE_*
// says otherwise, so set those when trying anything new — a wrong rate makes the cost
// line lie.
const DEFAULT_MODEL = 'gemini-3.5-flash-lite'
const LLM_LIST_PRICES = {
  // 3.5-flash-lite does no IMPLICIT caching (probed against the native API); what shows
  // as cached on its cost line is the explicit cache cascade.js creates per tenant.
  'gemini-3.5-flash-lite': { in: 0.30, cachedIn: 0.03, out: 2.50 },
  'gemini-3.1-flash-lite': { in: 0.25, cachedIn: 0.025, out: 1.50 },
  'gemini-2.5-flash-lite': { in: 0.10, cachedIn: 0.01, out: 0.40 },
}

// Every rate above was read off the provider's own pricing page. When you add one,
// go and read it — do not reconstruct it from memory. The cost line is only worth
// having if it is right, and a plausible wrong number is worse than no number.
const warnedModels = new Set()

/**
 * What the carrier charges for a call of this length.
 *
 * Block pricing rounds UP, because that is what the carrier does — a call one second
 * into a block pays for the whole block.
 *
 * @param {object} rates  from ratesFor()
 * @param {number} callMinutes  wall-clock length of the call
 */
export function telephonyCost(rates, callMinutes = 0) {
  const mins = callMinutes > 0 ? callMinutes : 0
  if (!mins) return 0
  if (rates.telephonyInrPerBlock > 0 && rates.telephonyBlockSeconds > 0) {
    const blocks = Math.ceil((mins * 60) / rates.telephonyBlockSeconds)
    return +(blocks * rates.telephonyInrPerBlock).toFixed(2)
  }
  return +((rates.telephonyInrPerMin || 0) * mins).toFixed(2)
}

/**
 * Characters as a per-character voice bills them: code points, with combining marks —
 * a Telugu vowel sign or virama riding on its letter — not counted. Measured against
 * Telnyx's own billing records: English 60 → 60, Telugu 36 → 23, mixed 51 → 43. Counting
 * .length instead over-billed a real Telugu call by 29% (1,581 against 1,225 billed).
 */
export function billableChars(text) {
  let n = 0
  for (const c of String(text || '')) if (!/\p{M}/u.test(c)) n++
  return n
}

export function ratesFor(model = DEFAULT_MODEL) {
  // A model nobody has priced would otherwise report a confident number that was never
  // true. Say so once.
  if (model && !LLM_LIST_PRICES[model] && !process.env.CASCADE_LLM_PRICE_IN && !warnedModels.has(model)) {
    warnedModels.add(model)
    console.warn(
      `[COST] no list price for "${model}" — the cost line is being estimated at ${DEFAULT_MODEL} rates ` +
      `and will be WRONG. Add it to LLM_LIST_PRICES, or set CASCADE_LLM_PRICE_IN/_CACHED_IN/_OUT.`
    )
  }
  const list = LLM_LIST_PRICES[model] || LLM_LIST_PRICES[DEFAULT_MODEL]
  return {
    // Saaras v3 realtime, $0.30 an hour of audio as listed (2026-09).
    sttPerHour: num(process.env.SARVAM_STT_PRICE_PER_HOUR, 0.30),
    // Telnyx Ultra, $0.000032 per billable character — see billableChars. Seconds of
    // speech are still counted and reported, but they cost nothing on their own.
    ttsPerChar: num(process.env.TELNYX_TTS_PRICE_PER_CHAR, 0.000032),
    llmIn: num(process.env.CASCADE_LLM_PRICE_IN, list.in),
    llmCachedIn: num(process.env.CASCADE_LLM_PRICE_CACHED_IN, list.cachedIn),
    llmOut: num(process.env.CASCADE_LLM_PRICE_OUT, list.out),
    // The carrier bills separately and in RUPEES. Without it the cost line reads lower
    // than the real bill, which is how an estimate stops being trusted.
    //
    // Carriers bill in BLOCKS, not in minutes: Plivo's India inbound rate is ₹0.19 per
    // 30 seconds, charged on every block a call touches. A 31-second call costs two
    // blocks. Pricing that as a per-minute rate understates every call, and understates
    // short ones worst — a 35-second call is ₹0.38 of carrier against ₹0.22 if you
    // divide the same rate out per minute, which is 73% light on the line that already
    // has the thinnest margin.
    //
    // TELEPHONY_INR_PER_MIN is kept for a carrier that genuinely bills per second or
    // per minute; when a block rate is set it wins.
    telephonyInrPerMin: num(process.env.TELEPHONY_INR_PER_MIN, 0),
    telephonyInrPerBlock: num(process.env.TELEPHONY_INR_PER_BLOCK, 0),
    telephonyBlockSeconds: num(process.env.TELEPHONY_BLOCK_SECONDS, 30),
  }
}

export const CASCADE_RATES = ratesFor(DEFAULT_MODEL)

// A phone line is 8kHz µ-law in both directions — one byte per sample, so 8000 bytes
// a second. A browser is neither: it sends 16kHz PCM16 (32000 B/s) and is sent back
// 24kHz PCM16 (48000 B/s). Billing browser audio at the µ-law rate does not look wrong,
// it just reads 4× the STT and 6× the TTS, which is how a demo call invoices ₹15 of
// TTS for two minutes of speech. Callers pass their profile's rates; the default keeps
// the telephony numbers exactly where they were.
const MULAW_BYTES_PER_SEC = 8000

/**
 * @param {object} [rates]  price list, from ratesFor()
 * @param {{sttBytesPerSecond?: number, ttsBytesPerSecond?: number}} [audio]
 */
export function createCascadeMeter(rates = CASCADE_RATES, audio = {}) {
  const sttBps = Number(audio.sttBytesPerSecond) > 0 ? Number(audio.sttBytesPerSecond) : MULAW_BYTES_PER_SEC
  const ttsBps = Number(audio.ttsBytesPerSecond) > 0 ? Number(audio.ttsBytesPerSecond) : MULAW_BYTES_PER_SEC
  const u = { sttBytes: 0, ttsBytes: 0, ttsChars: 0, llmCalls: 0, promptTokens: 0, cachedTokens: 0, completionTokens: 0 }

  return {
    addSttAudio(bytes) { u.sttBytes += bytes > 0 ? bytes : 0 },
    addTtsAudio(bytes) { u.ttsBytes += bytes > 0 ? bytes : 0 },
    addTtsChars(n) { u.ttsChars += n > 0 ? n : 0 },
    /** A `usage` object from the last chunk of a Gemini stream (see gemini-native.js). */
    addLlmUsage(usage) {
      if (!usage) return
      u.llmCalls++
      u.promptTokens += Number(usage.prompt_tokens) || 0
      u.cachedTokens += Number(usage.prompt_tokens_details?.cached_tokens) || 0
      u.completionTokens += Number(usage.completion_tokens) || 0
    },

    /** @param {number} [callMinutes] wall-clock length, for the telephony line. */
    summary(callMinutes = 0) {
      const sttSec = u.sttBytes / sttBps
      const ttsSec = u.ttsBytes / ttsBps
      const uncached = Math.max(0, u.promptTokens - u.cachedTokens)
      const usd = {
        stt: (sttSec / 3600) * rates.sttPerHour,
        tts: u.ttsChars * rates.ttsPerChar,
        llm: (uncached * rates.llmIn + u.cachedTokens * rates.llmCachedIn + u.completionTokens * rates.llmOut) / 1e6,
      }
      const total = usd.stt + usd.tts + usd.llm
      const inr = (x) => +(x * USD_INR).toFixed(2)
      const telephonyInr = telephonyCost(rates, callMinutes)
      return {
        ...u,
        sttSeconds: +sttSec.toFixed(1),
        ttsSeconds: +ttsSec.toFixed(1),
        costUsd: +total.toFixed(4),
        costInr: inr(total),
        telephonyInr,
        allInInr: +(inr(total) + telephonyInr).toFixed(2),
        byPartInr: { stt: inr(usd.stt), llm: inr(usd.llm), tts: inr(usd.tts), telephony: telephonyInr },
      }
    },
  }
}
