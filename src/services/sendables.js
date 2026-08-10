// services/sendables.js — files the agent SENDS to customers (WhatsApp), stored
// separately from the knowledge base.
//
// Why separate from documents.js: a knowledge document exists to be *read by the
// agent* — it must have extractable text, it gets chunked + embedded, and deleting
// it changes what the agent knows. A sendable is the opposite: it exists to be
// *handed to the customer as-is*. A glossy image-only brochure PDF is a perfectly
// good sendable but a useless knowledge doc, and mixing the two means every
// brochure upload pollutes the agent's knowledge (and image-only ones fail
// outright). So: raw bytes in, raw bytes out, no ingestion.
//
// A client who wants a file to do BOTH uploads it in both places — that's rare and
// explicit, which is better than one upload silently doing two jobs.
//
// Bucket is shared with knowledge (no extra Supabase setup) but the path is
// prefixed `<tenant>/whatsapp/` so the two never collide.

import { supabase, supabaseAdmin } from '../api/db.js'

const BUCKET = 'knowledge-files'
const store = supabaseAdmin || supabase

function storagePath(tenantId, id, filename) {
  const safe = String(filename || 'file').replace(/[^\w.\-]+/g, '_').slice(0, 120)
  return `${tenantId}/whatsapp/${id}__${safe}`
}

// List a tenant's sendable documents (newest first).
export async function listSendables(tenantId) {
  if (!tenantId) return []
  const { data, error } = await supabase
    .from('whatsapp_documents')
    .select('id, topic, filename, mime_type, size_bytes, storage_path, created_at')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false })
  if (error) throw new Error(error.message)
  return data || []
}

// Store one file. `topic` is what callers ask for ("My Home Apas", "Menu",
// "Price list") — it's how the agent picks this file over the others.
export async function createSendable(tenantId, { topic, filename, mimeType, buffer }) {
  if (!tenantId) throw new Error('tenantId required')
  if (!buffer?.length) throw new Error('No file uploaded')

  const { data: row, error: iErr } = await supabase
    .from('whatsapp_documents')
    .insert({
      tenant_id: tenantId,
      topic: String(topic || '').trim(),
      filename: filename || 'document.pdf',
      mime_type: mimeType || null,
      size_bytes: buffer.length,
    })
    .select('id')
    .single()
  if (iErr || !row) throw new Error(iErr?.message || 'Could not save document')

  const path = storagePath(tenantId, row.id, filename)
  const { error: sErr } = await store.storage.from(BUCKET).upload(path, buffer, {
    contentType: mimeType || 'application/octet-stream',
    upsert: true,
  })
  // Without the bytes the row is useless (nothing to send) — roll it back rather
  // than leaving a document that silently fails on every call.
  if (sErr) {
    await supabase.from('whatsapp_documents').delete().eq('id', row.id)
    throw new Error(`Storage upload failed: ${sErr.message}`)
  }

  await supabase.from('whatsapp_documents').update({ storage_path: path }).eq('id', row.id)
  return { id: row.id, topic, filename, storage_path: path }
}

// Rename the topic of an existing document (the file itself doesn't change).
export async function updateSendable(tenantId, id, { topic }) {
  if (!tenantId || !id) return { success: false }
  const { error } = await supabase
    .from('whatsapp_documents')
    .update({ topic: String(topic || '').trim() })
    .eq('id', id)
    .eq('tenant_id', tenantId)
  if (error) throw new Error(error.message)
  return { success: true }
}

export async function deleteSendable(tenantId, id) {
  if (!tenantId || !id) return { success: false }
  const { data: row } = await supabase
    .from('whatsapp_documents')
    .select('storage_path')
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .single()
  if (!row) return { success: false, error: 'not found' }

  const { error } = await supabase.from('whatsapp_documents').delete().eq('id', id).eq('tenant_id', tenantId)
  if (error) throw new Error(error.message)
  if (row.storage_path) await store.storage.from(BUCKET).remove([row.storage_path]).catch(() => {})
  return { success: true }
}

// Short-lived signed URL — WhatsApp fetches the file from this link.
export async function getSendableUrl(tenantId, id, expiresIn = 600) {
  if (!tenantId || !id) return null
  const { data: row } = await supabase
    .from('whatsapp_documents')
    .select('storage_path')
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .single()
  if (!row?.storage_path) return null
  const { data, error } = await store.storage.from(BUCKET).createSignedUrl(row.storage_path, expiresIn)
  if (error) {
    console.error('[SENDABLE] signed url error:', error.message)
    return null
  }
  return data?.signedUrl || null
}

// Pick the document matching what the caller asked about, so "Avali", "My Home
// Avali" and "I want the menu" all land on the right file.
//
// The hard rule: NEVER send a file the caller didn't ask for. Sending the wrong
// document is worse than sending none — the customer gets the wrong information
// AND the agent tells them it sent the right one, so nobody notices. So if the
// caller names something we don't have, we return null and the agent says so.
const STOPWORDS = new Set(['the', 'a', 'an', 'my', 'our', 'your', 'for', 'in', 'at', 'of', 'to', 'me', 'us', 'and', 'want', 'need', 'send', 'please', 'details', 'detail', 'info', 'information', 'document', 'file', 'copy'])

// Words that describe the KIND of file rather than which one. Stripped only from
// the caller's request when deciding whether they named something unknown — a
// business whose document really is called "Price list" still matches on them.
const GENERIC = new Set(['brochure', 'brochures', 'catalogue', 'catalog', 'pdf', 'doc', 'docs',
  'plan', 'plans', 'floorplan', 'floorplans', 'floor', 'layout', 'layouts', 'sheet', 'deck',
  'presentation', 'share', 'get', 'give', 'about', 'on', 'over', 'whatsapp', 'it', 'this', 'that'])

function tokens(s) {
  return String(s).toLowerCase().split(/[^a-z0-9]+/).filter((t) => t && !STOPWORDS.has(t))
}

// Returns the matching row ({ id, filename, … }), or null if we have nothing that
// matches — the caller asked for something we don't stock, or it's ambiguous.
export async function resolveSendable(tenantId, topic) {
  const list = await listSendables(tenantId).catch(() => [])
  if (!list.length) return null

  const asked = tokens(topic)
  if (!asked.length) return list.length === 1 ? list[0] : null   // no subject named
  const askedSet = new Set(asked)

  const docs = list.map((d) => ({ row: d, toks: new Set(tokens(d.topic)) }))
  const known = new Set(docs.flatMap((x) => [...x.toks]))

  // Did the caller name something none of our documents mention? "Apas" against a
  // library holding only "My Home Akara" lands here — the shared word "home" would
  // otherwise score a false match and ship the wrong brochure.
  const unknown = asked.filter((t) => !known.has(t) && !GENERIC.has(t))
  if (unknown.length) return null

  let best = null, bestScore = 0
  for (const { row, toks } of docs) {
    const score = [...toks].filter((t) => askedSet.has(t)).length
    if (score > bestScore) { bestScore = score; best = row }
  }
  // Nothing scored: only safe to guess when there's a single document to guess at.
  return best || (list.length === 1 ? list[0] : null)
}
