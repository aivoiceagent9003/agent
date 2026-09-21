// gemini-cache.js — hold a tenant's system prompt on Google's side instead of sending
// it again on every turn.
//
// The hot prompt is ~10,900 tokens (system rules + tool schemas) and it is IDENTICAL on
// every request of every call for a tenant. Sending it each time is most of the LLM
// bill: on a real 3-minute call, 137,100 input tokens for 9 requests.
//
// Two kinds of caching exist and only one of them works here:
//
//   IMPLICIT — the provider notices a repeated prefix by itself. Measured against the
//              native API, this does NOT fire on gemini-3.5-flash-lite: three identical
//              ~9,900-token requests returned zero cached tokens every time, while
//              2.5-flash-lite and 3.1-flash-lite on the same harness cached 80-93%.
//   EXPLICIT — you create a cache object and reference it. This DOES work on
//              3.5-flash-lite: 9,915 of 9,921 tokens, from the first request.
//
// So the saving is real but it has to be asked for. Measured: input cost drops ~63%
// (cached tokens bill at $0.03/1M against $0.30/1M) for ~138ms of extra first-token
// latency, which is roughly what the compatibility endpoint was costing us anyway.
//
// Two things this module is careful about:
//
//   Storage is billed by the hour, whether or not anyone calls. At $1.00 per 1M tokens
//   per hour a 10,900-token cache costs ~$0.011/hour, so caches are created ON DEMAND
//   with a short TTL and simply allowed to lapse when a tenant goes quiet. Holding one
//   open for every tenant around the clock would spend more than it saves.
//
//   A cache is keyed by the CONTENT it holds. Change the prompt or the tool list and the
//   key changes, so a stale cache can never be silently used against a new prompt — the
//   failure that would be hardest to notice and worst to have.

import { createHash } from 'node:crypto'
import telemetry from './telemetry.js'

const API = 'https://generativelanguage.googleapis.com/v1beta'
// Long enough to cover a call and the gap before the next one; short enough that an
// idle tenant stops being billed quickly. Google's minimum is 60s.
const TTL_SECONDS = Number(process.env.GEMINI_CACHE_TTL_SECONDS || 900)
// Re-create when this close to expiry rather than risk a mid-call miss.
const REFRESH_MARGIN_MS = 60_000
const ENABLED = process.env.GEMINI_EXPLICIT_CACHE !== 'false'

const caches = new Map()   // key → { name, expiresAt, tokens, creating }

const keyFor = (model, system, tools) =>
  createHash('sha256').update(`${model}\u0000${system}\u0000${JSON.stringify(tools || [])}`).digest('hex').slice(0, 32)

/**
 * The cache name to attach to a request, or null to send the prompt inline.
 *
 * NEVER throws and never blocks a turn: a cache that is still being created, or that
 * failed to create, returns null and the caller sends the prompt the normal way. The
 * worst case is the bill we already have, not a broken call.
 *
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {string} opts.model            e.g. 'gemini-3.5-flash-lite'
 * @param {string} opts.system           the full system instruction to hold
 * @param {object[]} [opts.tools]        Gemini functionDeclarations, cached alongside
 * @returns {string|null} e.g. 'cachedContents/abc123'
 */
export function cachedContentFor({ apiKey, model, system, tools }) {
  if (!ENABLED || !apiKey || !model || !system) return null
  const key = keyFor(model, system, tools)
  const entry = caches.get(key)

  if (entry?.name && entry.expiresAt - Date.now() > REFRESH_MARGIN_MS) return entry.name

  // Expiring, expired, or absent: start (or restart) a creation and use the old name
  // meanwhile if it is still valid. One creation in flight per key.
  if (!entry?.creating) startCreate(key, { apiKey, model, system, tools })
  return entry?.name && entry.expiresAt > Date.now() ? entry.name : null
}

function startCreate(key, { apiKey, model, system, tools }) {
  const prev = caches.get(key) || {}
  const creating = (async () => {
    try {
      const body = {
        model: `models/${model}`,
        systemInstruction: { parts: [{ text: system }] },
        ttl: `${TTL_SECONDS}s`,
      }
      // Tool schemas are ~1000 tokens and just as static as the prompt.
      if (tools?.length) body.tools = [{ functionDeclarations: tools }]

      const res = await fetch(`${API}/cachedContents?key=${apiKey}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(`${res.status}: ${JSON.stringify(json).slice(0, 160)}`)

      const tokens = json.usageMetadata?.totalTokenCount || 0
      caches.set(key, {
        name: json.name,
        // Trust our own TTL rather than parsing expireTime: if the clocks disagree we
        // want to refresh early, not late.
        expiresAt: Date.now() + TTL_SECONDS * 1000,
        tokens,
        creating: null,
      })
      console.log(`[GEMINI] 🗄️  cached ${tokens} prompt tokens for ${TTL_SECONDS}s (${json.name.split('/').pop()})`)
      telemetry.incr('gemini_cache_created')
    } catch (e) {
      // Leave any still-valid previous entry in place; just stop trying for a moment.
      caches.set(key, { ...prev, creating: null })
      console.warn(`[GEMINI] cache create failed, sending the prompt inline: ${e.message}`)
      telemetry.incr('gemini_cache_errors')
    }
  })()
  caches.set(key, { ...prev, creating })
}

/** Drop a cache Google has already rejected, so the next turn rebuilds it. */
export function forgetCache(name) {
  for (const [key, entry] of caches) if (entry.name === name) caches.set(key, { ...entry, name: null, expiresAt: 0 })
}

/** Release every cache this process holds. Storage bills by the hour until they lapse. */
export async function releaseCaches(apiKey) {
  const names = [...caches.values()].map(e => e.name).filter(Boolean)
  caches.clear()
  await Promise.allSettled(names.map(n =>
    fetch(`${API}/${n}?key=${apiKey}`, { method: 'DELETE' })))
  return names.length
}

/** For tests and the cost line. */
export function cacheStats() {
  const live = [...caches.values()].filter(e => e.name && e.expiresAt > Date.now())
  return { entries: live.length, tokens: live.reduce((n, e) => n + (e.tokens || 0), 0) }
}
