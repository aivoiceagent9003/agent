// services/documents.js — Document-level knowledge management.
//
// A "document" is one uploaded file (or one pasted block) a client added to their
// knowledge base. Each document's raw bytes live in Supabase Storage (bucket
// 'knowledge-files'); its extracted text is chunked + embedded into knowledge_base
// with chunk.document_id pointing back here.
//
// This gives clients what they couldn't do before: SEE their uploaded files, get
// a download link, and DELETE a file — which cascades to remove exactly that
// file's chunks (FK ON DELETE CASCADE in sql/documents.sql) and its Storage object.
//
// All functions take tenantId and scope every query to it, so a client can only
// ever touch their own documents.

import { supabase, supabaseAdmin } from '../api/db.js'
import { ingestText } from '../ingest.js'
import { invalidateKnowledge } from './rag.js'

const BUCKET = 'knowledge-files'

// Storage writes use the service-role client so they bypass Storage RLS (access
// is gated by our requireClient/requireAdmin middleware instead). Falls back to
// the anon client if the service key isn't set — uploads then need a bucket policy.
const store = supabaseAdmin || supabase

// <tenant_id>/<doc_id>__<sanitized-filename> — keeps each tenant's files isolated
// by prefix and avoids collisions between documents with the same name.
function storagePath(tenantId, docId, filename) {
  const safe = String(filename || 'file').replace(/[^\w.\-]+/g, '_').slice(0, 120)
  return `${tenantId}/${docId}__${safe}`
}

// Create a document from an uploaded file or a pasted block.
//   { filename, mimeType?, buffer?, text, source }
// `buffer` is the raw file bytes (omit for pasted text). `text` is the already-
// extracted plain text to chunk + embed.
export async function createDocument(tenantId, { filename, mimeType, buffer, text, source = 'upload' }) {
  if (!tenantId) throw new Error('tenantId required')
  if (!text?.trim()) throw new Error('No text to ingest')

  // 1. Insert the document row first so we have an id to build the storage path.
  const { data: doc, error: dErr } = await supabase
    .from('documents')
    .insert({
      tenant_id: tenantId,
      filename: filename || 'Untitled',
      mime_type: mimeType || null,
      size_bytes: buffer?.length ?? null,
      source,
      char_count: text.length,
      status: 'processing',
    })
    .select('id')
    .single()
  if (dErr || !doc) throw new Error(dErr?.message || 'Could not create document')
  const docId = doc.id

  // 2. Upload the raw file to Storage (pasted text has no buffer → skip).
  let path = null
  if (buffer && buffer.length) {
    path = storagePath(tenantId, docId, filename)
    const { error: sErr } = await store.storage.from(BUCKET).upload(path, buffer, {
      contentType: mimeType || 'application/octet-stream',
      upsert: true,
    })
    if (sErr) {
      console.error('[DOC] storage upload failed:', sErr.message)
      path = null  // keep the document/chunks even if Storage failed
    }
  }

  // 3. Chunk + embed the text, linked to this document.
  //
  // A failure here must not leave the row stuck on 'processing' forever: the file
  // is already in Storage and the row already exists, so an unmarked failure shows
  // up in the client's document list as a file that is permanently "processing"
  // and answers nothing. Mark it and re-throw so the route reports the real reason.
  let chunks_added
  try {
    ;({ chunks_added } = await ingestText(tenantId, text, source, { documentId: docId }))
  } catch (e) {
    await supabase
      .from('documents')
      .update({ storage_path: path, chunk_count: 0, status: 'error' })
      .eq('id', docId)
    throw e
  }

  // 4. Finalize the row.
  await supabase
    .from('documents')
    .update({ storage_path: path, chunk_count: chunks_added, status: 'ready' })
    .eq('id', docId)

  return { id: docId, filename, chunk_count: chunks_added, storage_path: path }
}

// List a tenant's documents (newest first). No embeddings/bytes — UI-friendly.
export async function listDocuments(tenantId) {
  if (!tenantId) return []
  const { data, error } = await supabase
    .from('documents')
    .select('id, filename, mime_type, size_bytes, source, char_count, chunk_count, status, created_at')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false })
  if (error) throw new Error(error.message)
  return data || []
}

// Delete one document: removes the row (chunks cascade via FK) and the Storage
// object. Scoped to the tenant so a client can't delete another tenant's file.
export async function deleteDocument(tenantId, docId) {
  if (!tenantId || !docId) return { success: false }

  const { data: doc } = await supabase
    .from('documents')
    .select('storage_path')
    .eq('id', docId)
    .eq('tenant_id', tenantId)
    .single()
  if (!doc) return { success: false, error: 'not found' }

  // Delete this document's chunks explicitly. A FK with ON DELETE CASCADE would
  // do this automatically, but the live DB currently has no foreign keys, so we
  // remove them here to avoid orphaned chunks. Harmless once the FK is added
  // (sql/constraints.sql) — the chunks are already gone by then.
  await supabase
    .from('knowledge_base')
    .delete()
    .eq('document_id', docId)
    .eq('tenant_id', tenantId)
  invalidateKnowledge(tenantId)

  const { error } = await supabase
    .from('documents')
    .delete()
    .eq('id', docId)
    .eq('tenant_id', tenantId)
  if (error) throw new Error(error.message)

  if (doc.storage_path) {
    await store.storage.from(BUCKET).remove([doc.storage_path]).catch(() => {})
  }
  return { success: true }
}

// A short-lived signed URL so the client can view/download their original file.
export async function getDocumentUrl(tenantId, docId, expiresIn = 300) {
  if (!tenantId || !docId) return null
  const { data: doc } = await supabase
    .from('documents')
    .select('storage_path')
    .eq('id', docId)
    .eq('tenant_id', tenantId)
    .single()
  if (!doc?.storage_path) return null
  const { data, error } = await store.storage
    .from(BUCKET)
    .createSignedUrl(doc.storage_path, expiresIn)
  if (error) {
    console.error('[DOC] signed url error:', error.message)
    return null
  }
  return data?.signedUrl || null
}

// Clear ALL of a tenant's knowledge: delete every document (chunks cascade) and
// remove their Storage objects, plus any legacy chunks that predate documents
// (document_id is null, so the cascade never reaches them).
export async function clearAllDocuments(tenantId) {
  if (!tenantId) return { success: false }

  const { data: docs } = await supabase
    .from('documents')
    .select('storage_path')
    .eq('tenant_id', tenantId)

  const paths = (docs || []).map(d => d.storage_path).filter(Boolean)
  if (paths.length) {
    await store.storage.from(BUCKET).remove(paths).catch(() => {})
  }

  await supabase.from('documents').delete().eq('tenant_id', tenantId)
  // Legacy chunks with no document_id aren't cascaded — remove them too.
  await supabase.from('knowledge_base').delete().eq('tenant_id', tenantId)
  invalidateKnowledge(tenantId)

  return { success: true }
}
