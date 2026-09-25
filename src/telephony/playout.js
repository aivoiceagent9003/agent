// telephony/playout.js — how much of the agent's audio the caller has not heard yet.
//
// We push audio to the provider as fast as the model produces it, which is far faster
// than real time. The provider buffers it and plays it out at 8kHz. So at the moment
// the model finishes speaking, several seconds of speech can still be queued at the
// caller's ear.
//
// That matters for exactly one thing: hanging up. Closing the media stream the instant
// the model stops generating cuts the caller off mid-sentence — they lose the goodbye,
// and on a payment or renewal call they may lose the last thing they were told. Neither
// Plivo sends no playback-complete event (Twilio's `mark` has no equivalent
// here), so the only way to know when it is safe to close is to account for it.
//
// The arithmetic is exact: G.711 μ-law at 8kHz mono is one byte per sample, 8000 bytes
// per second, so a byte is an eighth of a millisecond of speech.

const BYTES_PER_MS = 8

/**
 * Tracks when the audio queued so far will finish playing.
 *
 * @param {object} [opts]
 * @param {() => number} [opts.now] clock, injectable so the behaviour is testable
 *        without waiting in real time.
 */
export function createPlayoutTracker({ now = Date.now } = {}) {
  // Wall-clock time at which everything queued so far has been heard. Zero means
  // nothing is outstanding.
  let endsAt = 0

  return {
    /** Audio just handed to the provider. */
    queued(bytes) {
      if (!(bytes > 0)) return
      const t = now()
      // If the buffer already drained, this audio starts playing on arrival rather
      // than queueing behind something that finished long ago. Without this reset a
      // quiet stretch mid-call would make every later estimate too long.
      if (endsAt < t) endsAt = t
      endsAt += bytes / BYTES_PER_MS
    },

    /**
     * The caller interrupted, and the provider was told to discard what it had
     * buffered. Nothing is outstanding any more.
     */
    cleared() { endsAt = 0 },

    /** Milliseconds until the caller has heard everything sent so far. */
    msRemaining() { return Math.max(0, Math.round(endsAt - now())) },
  }
}
