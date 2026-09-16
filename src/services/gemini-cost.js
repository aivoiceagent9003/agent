// gemini-cost.js — what a Gemini Live call actually cost.
//
// Google bills a Live session per TURN, and every turn's input is the whole session
// so far: the system prompt, every tool result, all of the caller's audio AND the
// agent's own earlier replies (re-billed as input audio). So cost grows with the
// square of call length, and nothing in the bill tells you which call did it.
//
// Gemini reports this itself: one `usageMetadata` per turn, arriving on the
// turnComplete message, holding that turn's billed tokens split by modality. It is
// per turn, not a running total (verified against gemini-3.1-flash-live-preview), so
// a call's cost is the sum over its turns.
//
// Rates are USD per 1M tokens and default to gemini-3.1-flash-live-preview's list
// price. Override with env when the model or the price changes — the bill is the
// truth, this is an estimate of it.

const num = (v, d) => (Number.isFinite(Number(v)) && String(v).trim() !== '' ? Number(v) : d)

export const RATES = {
  textIn:   num(process.env.GEMINI_PRICE_TEXT_IN, 0.75),
  audioIn:  num(process.env.GEMINI_PRICE_AUDIO_IN, 3.00),
  mediaIn:  num(process.env.GEMINI_PRICE_MEDIA_IN, 1.00),   // image / video
  textOut:  num(process.env.GEMINI_PRICE_TEXT_OUT, 4.50),   // also thinking tokens
  audioOut: num(process.env.GEMINI_PRICE_AUDIO_OUT, 12.00),
}
export const USD_INR = num(process.env.USD_INR, 95.97)

const AUDIO_TOKENS_PER_SEC = 25

function split(details, fallbackTotal) {
  const out = { text: 0, audio: 0, media: 0 }
  if (!Array.isArray(details) || !details.length) {
    out.text = fallbackTotal || 0
    return out
  }
  for (const d of details) {
    const n = Number(d?.tokenCount) || 0
    const m = String(d?.modality || '').toUpperCase()
    if (m === 'AUDIO') out.audio += n
    else if (m === 'IMAGE' || m === 'VIDEO') out.media += n
    else out.text += n
  }
  return out
}

export function createUsageMeter() {
  const t = { turns: 0, textIn: 0, audioIn: 0, mediaIn: 0, textOut: 0, audioOut: 0, peakPrompt: 0 }

  return {
    // Feed every usageMetadata the session sends.
    add(usage) {
      if (!usage) return
      t.turns++
      const input = split(usage.promptTokensDetails, usage.promptTokenCount)
      const output = split(usage.responseTokensDetails, usage.responseTokenCount)
      t.textIn += input.text + (Number(usage.toolUsePromptTokenCount) || 0)
      t.audioIn += input.audio
      t.mediaIn += input.media
      t.textOut += output.text + (Number(usage.thoughtsTokenCount) || 0)
      t.audioOut += output.audio
      t.peakPrompt = Math.max(t.peakPrompt, Number(usage.promptTokenCount) || 0)
    },

    summary() {
      const usd =
        (t.textIn * RATES.textIn + t.audioIn * RATES.audioIn + t.mediaIn * RATES.mediaIn +
         t.textOut * RATES.textOut + t.audioOut * RATES.audioOut) / 1e6
      return {
        ...t,
        // Minutes of audio Google billed as INPUT. Next to the call's real length,
        // this is the re-billing made visible.
        audioInMinutesBilled: +(t.audioIn / AUDIO_TOKENS_PER_SEC / 60).toFixed(1),
        costUsd: +usd.toFixed(4),
        costInr: +(usd * USD_INR).toFixed(2),
        byPartInr: {
          textIn: +((t.textIn * RATES.textIn) / 1e6 * USD_INR).toFixed(2),
          audioIn: +((t.audioIn * RATES.audioIn) / 1e6 * USD_INR).toFixed(2),
          audioOut: +((t.audioOut * RATES.audioOut) / 1e6 * USD_INR).toFixed(2),
          other: +(((t.mediaIn * RATES.mediaIn) + (t.textOut * RATES.textOut)) / 1e6 * USD_INR).toFixed(2),
        },
      }
    },
  }
}
