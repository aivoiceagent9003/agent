// cascade-cost.js — what a cascaded (STT → LLM → TTS) call actually cost.
//
// Nothing here is re-billed per turn — a cost line is a sum of what each piece did:
//   STT  — seconds of caller audio streamed (Soniox real-time, per hour)
//   TTS  — seconds of speech generated (Soniox TTS, per hour of output audio)
//   LLM  — prompt + completion tokens actually used; OpenAI discounts the part of
//          the prompt it served from cache, and the system prompt is that part
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

// List prices for the brains that have been measured, USD per 1M tokens. A model not
// listed here is priced as gpt-4o-mini unless CASCADE_LLM_PRICE_* says otherwise, so
// set those when trying anything new — a wrong rate makes the cost line lie.
const LLM_LIST_PRICES = {
  'gpt-4o-mini': { in: 0.15, cachedIn: 0.075, out: 0.60 },
  // Note for whoever reads the cost line: 3.5-flash-lite reports "0 cached" on every
  // call and that is NOT a bug in the meter. Probed against the native API, this model
  // does no implicit caching at all, while 3.1-flash-lite and 2.5-flash-lite on the
  // same prompt cache 80-93%. The cachedIn rate below is therefore dead weight here.
  'gemini-3.5-flash-lite': { in: 0.30, cachedIn: 0.03, out: 2.50 },
  'gemini-3.1-flash-lite': { in: 0.25, cachedIn: 0.025, out: 1.50 },
  'gemini-2.5-flash-lite': { in: 0.10, cachedIn: 0.01, out: 0.40 },
  // Benchmarked as migration candidates. The cached rate matters more than the headline
  // one here: on a live call gpt-4.1-mini served 80% of the prompt from cache (83,072 of
  // 103,806 tokens) while gemini-3.5-flash-lite served none.
  'gpt-4.1-mini': { in: 0.40, cachedIn: 0.10, out: 1.60 },
  'gpt-4.1-nano': { in: 0.10, cachedIn: 0.025, out: 0.40 },
}

// Every rate above was read off the provider's own pricing page. When you add one,
// go and read it — do not reconstruct it from memory. The cost line is only worth
// having if it is right, and a plausible wrong number is worse than no number.
const warnedModels = new Set()

export function ratesFor(model) {
  // A model nobody has priced is silently billed as gpt-4o-mini, which can be off by
  // an order of magnitude in either direction. Say so once, rather than let a call
  // report a confident number that was never true.
  if (model && !LLM_LIST_PRICES[model] && !process.env.CASCADE_LLM_PRICE_IN && !warnedModels.has(model)) {
    warnedModels.add(model)
    console.warn(
      `[COST] no list price for "${model}" — the cost line is being estimated at gpt-4o-mini rates ` +
      `and will be WRONG. Add it to LLM_LIST_PRICES, or set CASCADE_LLM_PRICE_IN/_CACHED_IN/_OUT.`
    )
  }
  const list = LLM_LIST_PRICES[model] || LLM_LIST_PRICES['gpt-4o-mini']
  return {
    // $0.12/hr is Soniox's published real-time STT rate. The TTS figure is NOT a
    // published per-hour rate — Soniox bills TTS by tokens ($4.00 per 1M input text,
    // $21.50 per 1M output audio) and $0.70/hr assumes roughly 30,000 audio tokens to
    // the hour. A voice or language that packs tokens differently moves this, so the
    // TTS line is the softest number in the summary.
    sttPerHour: num(process.env.SONIOX_STT_PRICE_PER_HOUR, 0.12),
    ttsPerHour: num(process.env.SONIOX_TTS_PRICE_PER_HOUR, 0.70),
    llmIn: num(process.env.CASCADE_LLM_PRICE_IN, list.in),
    llmCachedIn: num(process.env.CASCADE_LLM_PRICE_CACHED_IN, list.cachedIn),
    llmOut: num(process.env.CASCADE_LLM_PRICE_OUT, list.out),
    // The carrier bills separately and in RUPEES per minute. Without it the cost line
    // reads lower than the real bill, which is how an estimate stops being trusted.
    telephonyInrPerMin: num(process.env.TELEPHONY_INR_PER_MIN, 0),
  }
}

export const CASCADE_RATES = ratesFor('gpt-4o-mini')

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
    /** An OpenAI `usage` object, from the final chunk of a streamed completion. */
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
        tts: (ttsSec / 3600) * rates.ttsPerHour,
        llm: (uncached * rates.llmIn + u.cachedTokens * rates.llmCachedIn + u.completionTokens * rates.llmOut) / 1e6,
      }
      const total = usd.stt + usd.tts + usd.llm
      const inr = (x) => +(x * USD_INR).toFixed(2)
      const telephonyInr = +((rates.telephonyInrPerMin || 0) * (callMinutes || 0)).toFixed(2)
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
