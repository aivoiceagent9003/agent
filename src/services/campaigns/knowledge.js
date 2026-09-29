// services/campaigns/knowledge.js — the files an AI campaign talks from.
//
// A campaign about something new (a project launched last week) can't lean on the
// knowledge base, because the knowledge base doesn't know about it yet. So an AI
// campaign chooses where its agent speaks from (config.kb_source):
//   'existing' (default) — the business's knowledge base, like every other call
//   'campaign'           — ONLY the files uploaded to this campaign
//
// Campaign files live in their own tables (sql/campaign-knowledge.sql), searched as
// the knowledge scope `campaign:<id>` (rag.js). Nothing that reads the business's
// knowledge base can see them, so inbound callers never hear about a campaign's
// subject before the business decides they should.
//
// When the campaign finishes, its owners are asked whether to add the files to the
// knowledge base (offerCampaignKnowledge). Adding copies the chunks WITH their
// embeddings: nothing is re-extracted or re-embedded.

import { supabase, supabaseAdmin } from '../../api/db.js'
import { embedChunks, extractKeyterms, mergeKeyterms } from '../../ingest.js'
import { invalidateKnowledge } from '../rag.js'
import { notify } from '../notifications.js'

const BUCKET = 'knowledge-files'
const store = supabaseAdmin || supabase   // same reasoning as services/documents.js
const PAGE = 1000                         // PostgREST's default max rows per request

export const campaignScope = (campaignId) => `campaign:${campaignId}`

const safeName = (filename) => String(filename || 'file').replace(/[^\w.\-]+/g, '_').slice(0, 120)
// Beside the tenant's own knowledge files, under a campaigns/ prefix.
const campaignPath = (tenantId, campaignId, docId, filename) =>
  `${tenantId}/campaigns/${campaignId}/${docId}__${safeName(filename)}`
// Where a file lives once it is part of the knowledge base (services/documents.js).
const knowledgePath = (tenantId, docId, filename) => `${tenantId}/${docId}__${safeName(filename)}`

const DOC_COLUMNS = 'id, filename, mime_type, size_bytes, char_count, chunk_count, status, kb_decision, created_at'

export async function listCampaignDocuments(campaignId) {
  const { data, error } = await supabase.from('campaign_documents')
    .select(DOC_COLUMNS).eq('campaign_id', campaignId).order('created_at', { ascending: false })
  if (error) throw new Error(error.message)
  return data || []
}

/** How many of this campaign's files the agent can actually talk from right now. */
export async function readyCampaignFileCount(campaignId) {
  const { count, error } = await supabase.from('campaign_documents')
    .select('id', { count: 'exact', head: true }).eq('campaign_id', campaignId).eq('status', 'ready')
  if (error) throw new Error(error.message)
  return count || 0
}

/** Names found in this campaign's files — speech-recognition hints for its calls. */
export async function campaignKeyterms(campaignId) {
  const { data, error } = await supabase.from('campaign_documents')
    .select('keyterms').eq('campaign_id', campaignId).eq('status', 'ready')
  if (error) { console.warn(`[CAMPAIGN-KB] keyterms unavailable for ${campaignId}: ${error.message}`); return [] }
  const seen = new Set()
  const out = []
  for (const row of data || []) {
    for (const t of Array.isArray(row.keyterms) ? row.keyterms : []) {
      const k = String(t).toLowerCase()
      if (!seen.has(k)) { seen.add(k); out.push(t) }
    }
  }
  return out.slice(0, 150)
}

/**
 * Add one file to a campaign: keep the original, cut + embed its text into
 * campaign_knowledge. `text` is already extracted (services/extract-text.js).
 */
export async function addCampaignDocument(tenantId, campaignId, { filename, mimeType, buffer, text }) {
  if (!text?.trim()) throw new Error('No text to ingest')

  const { data: doc, error: dErr } = await supabase.from('campaign_documents').insert({
    tenant_id: tenantId, campaign_id: campaignId,
    filename: filename || 'Untitled', mime_type: mimeType || null,
    size_bytes: buffer?.length ?? null, char_count: text.length, status: 'processing',
  }).select('id').single()
  if (dErr || !doc) throw new Error(dErr?.message || 'Could not save this file')

  let path = null
  if (buffer?.length) {
    path = campaignPath(tenantId, campaignId, doc.id, filename)
    const { error } = await store.storage.from(BUCKET).upload(path, buffer, {
      contentType: mimeType || 'application/octet-stream', upsert: true,
    })
    if (error) { console.error('[CAMPAIGN-KB] storage upload failed:', error.message); path = null }
  }

  // Same rule as documents.js: a failure must not leave the file stuck on
  // 'processing', looking like it will start working any moment.
  try {
    const rows = (await embedChunks(text)).map(({ content, embedding }) => ({
      tenant_id: tenantId, campaign_id: campaignId, document_id: doc.id, content, embedding,
    }))
    if (!rows.length) throw new Error('This file had no readable text')
    const { error } = await supabase.from('campaign_knowledge').insert(rows)
    if (error) throw new Error(`Could not save this file's text: ${error.message}`)
    await supabase.from('campaign_documents')
      .update({ storage_path: path, chunk_count: rows.length, status: 'ready' }).eq('id', doc.id)
    invalidateKnowledge(campaignScope(campaignId))

    // The names in the file, so the agent hears the new project's name correctly.
    // Background, like the knowledge base does it; a missing hint is not a failure.
    extractKeyterms(text)
      .then(terms => terms.length && supabase.from('campaign_documents').update({ keyterms: terms }).eq('id', doc.id))
      .catch(() => {})

    return { id: doc.id, filename, chunk_count: rows.length }
  } catch (e) {
    await supabase.from('campaign_documents')
      .update({ storage_path: path, chunk_count: 0, status: 'error' }).eq('id', doc.id)
    throw e
  }
}

export async function deleteCampaignDocument(campaignId, docId) {
  const { data: doc } = await supabase.from('campaign_documents')
    .select('id, storage_path').eq('id', docId).eq('campaign_id', campaignId).maybeSingle()
  if (!doc) return false
  // Chunks first, explicitly: the live database cannot be assumed to have the
  // cascade (see the note in services/documents.js).
  await supabase.from('campaign_knowledge').delete().eq('document_id', doc.id)
  await supabase.from('campaign_documents').delete().eq('id', doc.id)
  if (doc.storage_path) await store.storage.from(BUCKET).remove([doc.storage_path]).catch(() => {})
  invalidateKnowledge(campaignScope(campaignId))
  return true
}

/** Remove every file of a campaign that is being deleted. */
export async function deleteAllCampaignDocuments(campaignId) {
  const { data: docs } = await supabase.from('campaign_documents').select('storage_path').eq('campaign_id', campaignId)
  const paths = (docs || []).map(d => d.storage_path).filter(Boolean)
  if (paths.length) await store.storage.from(BUCKET).remove(paths).catch(() => {})
  await supabase.from('campaign_knowledge').delete().eq('campaign_id', campaignId)
  await supabase.from('campaign_documents').delete().eq('campaign_id', campaignId)
  invalidateKnowledge(campaignScope(campaignId))
}

async function allChunks(documentId) {
  const rows = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase.from('campaign_knowledge')
      .select('content, embedding').eq('document_id', documentId).order('id').range(from, from + PAGE - 1)
    if (error) throw new Error(error.message)
    rows.push(...data)
    if (data.length < PAGE) return rows
  }
}

const asVector = (e) => (typeof e === 'string' ? JSON.parse(e) : e)

/**
 * A duplicated campaign copies its config — including kb_source 'campaign' — so it
 * needs the files too, or its agent would set out knowing nothing.
 */
export async function copyCampaignDocuments(tenantId, fromCampaignId, toCampaignId) {
  const { data: docs } = await supabase.from('campaign_documents')
    .select('*').eq('campaign_id', fromCampaignId).eq('status', 'ready')
  for (const d of docs || []) {
    const { data: copy, error } = await supabase.from('campaign_documents').insert({
      tenant_id: tenantId, campaign_id: toCampaignId, filename: d.filename, mime_type: d.mime_type,
      size_bytes: d.size_bytes, char_count: d.char_count, chunk_count: d.chunk_count,
      keyterms: d.keyterms || [], status: 'processing',
    }).select('id').single()
    if (error || !copy) { console.error('[CAMPAIGN-KB] copy failed:', error?.message); continue }

    let path = null
    if (d.storage_path) {
      path = campaignPath(tenantId, toCampaignId, copy.id, d.filename)
      const { error: sErr } = await store.storage.from(BUCKET).copy(d.storage_path, path)
      if (sErr) path = null
    }
    const chunks = await allChunks(d.id)
    const { error: cErr } = chunks.length
      ? await supabase.from('campaign_knowledge').insert(chunks.map(c => ({
          tenant_id: tenantId, campaign_id: toCampaignId, document_id: copy.id,
          content: c.content, embedding: asVector(c.embedding),
        })))
      : { error: null }
    await supabase.from('campaign_documents')
      .update({ storage_path: path, status: cErr ? 'error' : 'ready' }).eq('id', copy.id)
  }
}

/** Files that are ready and whose owner has not yet said whether to keep them. */
export async function pendingKnowledgeOffer(campaignId) {
  const { data, error } = await supabase.from('campaign_documents')
    .select('id, filename').eq('campaign_id', campaignId).eq('status', 'ready').is('kb_decision', null)
  if (error) return []
  return data || []
}

/**
 * The owner's answer to "add this campaign's files to your knowledge base?".
 *   add=true  → each file becomes a knowledge-base document, chunks + embeddings
 *               copied as they are; the campaign keeps its own copy.
 *   add=false → recorded, so they are not asked again.
 * Returns { added, kept }.
 */
export async function decideCampaignKnowledge(tenantId, campaignId, add) {
  const { data: pending, error } = await supabase.from('campaign_documents')
    .select('*').eq('campaign_id', campaignId).eq('status', 'ready').is('kb_decision', null)
  if (error) throw new Error(error.message)
  if (!pending?.length) return { added: 0, kept: 0 }

  if (!add) {
    await supabase.from('campaign_documents').update({ kb_decision: 'kept' }).in('id', pending.map(d => d.id))
    return { added: 0, kept: pending.length }
  }

  let added = 0
  const terms = []
  for (const d of pending) {
    const chunks = await allChunks(d.id)
    const { data: kbDoc, error: dErr } = await supabase.from('documents').insert({
      tenant_id: tenantId, filename: d.filename, mime_type: d.mime_type, size_bytes: d.size_bytes,
      source: d.storage_path ? 'upload' : 'paste', char_count: d.char_count, status: 'processing',
    }).select('id').single()
    if (dErr || !kbDoc) throw new Error(dErr?.message || 'Could not add this file to the knowledge base')

    // Its own copy of the original, so deleting it from either place leaves the other.
    let path = null
    if (d.storage_path) {
      path = knowledgePath(tenantId, kbDoc.id, d.filename)
      const { error: sErr } = await store.storage.from(BUCKET).copy(d.storage_path, path)
      if (sErr) { console.error('[CAMPAIGN-KB] storage copy failed:', sErr.message); path = null }
    }

    const { error: cErr } = await supabase.from('knowledge_base').insert(chunks.map(c => ({
      tenant_id: tenantId, content: c.content, embedding: asVector(c.embedding), source: 'campaign', document_id: kbDoc.id,
    })))
    if (cErr) {
      await supabase.from('documents').update({ storage_path: path, chunk_count: 0, status: 'error' }).eq('id', kbDoc.id)
      throw new Error(`Could not add ${d.filename} to the knowledge base: ${cErr.message}`)
    }
    await supabase.from('documents').update({ storage_path: path, chunk_count: chunks.length, status: 'ready' }).eq('id', kbDoc.id)
    await supabase.from('campaign_documents').update({ kb_decision: 'added', kb_document_id: kbDoc.id }).eq('id', d.id)
    terms.push(...(Array.isArray(d.keyterms) ? d.keyterms : []))
    added++
  }
  invalidateKnowledge(tenantId)
  if (terms.length) await mergeKeyterms(tenantId, terms)
  console.log(`[CAMPAIGN-KB] campaign ${campaignId}: ${added} file(s) added to the knowledge base`)
  return { added, kept: 0 }
}

/**
 * Ask whether to keep a finished campaign's files: a bell notification to the owners
 * and whoever created the campaign. The campaign page shows the same question with
 * the buttons. Never throws — finishing a campaign must not fail over a notification.
 */
export async function offerCampaignKnowledge(campaign) {
  try {
    if (!campaign?.id || campaign.config?.kb_source !== 'campaign') return
    const pending = await pendingKnowledgeOffer(campaign.id)
    if (!pending.length) return
    const { data: owners } = await supabase.from('profiles').select('id')
      .eq('tenant_id', campaign.tenant_id).eq('tenant_role', 'owner').eq('status', 'active')
    const files = pending.length === 1 ? `"${pending[0].filename}"` : `${pending.length} files`
    await notify([...(owners || []).map(o => o.id), campaign.created_by], {
      tenantId: campaign.tenant_id,
      kind: 'campaign',
      title: `Campaign "${campaign.name}" is finished`,
      body: `Its calls talked from ${files}, which ${pending.length === 1 ? "isn't" : "aren't"} in your knowledge base. Add ${pending.length === 1 ? 'it' : 'them'} so every call can use ${pending.length === 1 ? 'it' : 'them'}?`,
      link: `/campaigns/${campaign.id}`,
    })
  } catch (e) {
    console.error('[CAMPAIGN-KB] could not ask about keeping campaign files:', e.message)
  }
}
