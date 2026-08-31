// api/uploads.js — upload allow-listing.
//
// Before this, any file type reached extractTextFromFile, and anything the type
// checks there didn't match fell through to "treat as UTF-8 text" or to the vision
// OCR path — meaning an arbitrary binary could be posted straight into a paid
// vision model. Size caps existed; type checks did not.
//
// Two gates, because neither alone is enough:
//   1. fileFilter — checks the declared MIME type and the extension. Runs before
//      the body is buffered, so it rejects cheaply, but both values are supplied
//      by the client and can simply be lied about.
//   2. sniff()    — checks magic bytes on the buffer AFTER upload. This is the one
//      that actually holds, because the client does not control the file contents.

import multer from 'multer'
import path from 'path'

// kind → { exts, mimes, magic }
// magic is a list of byte prefixes; an empty list means the format has no reliable
// signature (plain text) and can only be checked by decoding.
const TYPES = {
  pdf:  { exts: ['.pdf'],  mimes: ['application/pdf'], magic: [[0x25, 0x50, 0x44, 0x46]] },              // %PDF
  docx: {
    exts: ['.docx'],
    mimes: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    magic: [[0x50, 0x4b, 0x03, 0x04], [0x50, 0x4b, 0x05, 0x06]],                                        // PK zip
  },
  xlsx: {
    exts: ['.xlsx', '.xls'],
    mimes: [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel',
    ],
    magic: [[0x50, 0x4b, 0x03, 0x04], [0x50, 0x4b, 0x05, 0x06], [0xd0, 0xcf, 0x11, 0xe0]],              // zip or legacy OLE
  },
  csv:  { exts: ['.csv'],  mimes: ['text/csv', 'application/csv', 'text/plain'], magic: [] },
  txt:  { exts: ['.txt', '.md'], mimes: ['text/plain', 'text/markdown'], magic: [] },
  png:  { exts: ['.png'],  mimes: ['image/png'],  magic: [[0x89, 0x50, 0x4e, 0x47]] },
  jpeg: { exts: ['.jpg', '.jpeg'], mimes: ['image/jpeg'], magic: [[0xff, 0xd8, 0xff]] },
}

// Named bundles so each route states its intent rather than listing formats.
export const KINDS = {
  knowledge: ['pdf', 'docx', 'xlsx', 'csv', 'txt', 'png', 'jpeg'],
  // Contact lists come from documents as well as spreadsheets, but never images —
  // there is no path that OCRs a contact list.
  contacts:  ['pdf', 'docx', 'xlsx', 'csv', 'txt'],
  tabular:   ['xlsx', 'csv', 'txt'],
  sendable:  ['pdf', 'png', 'jpeg'],
}

function matches(kind, ext, mime) {
  const t = TYPES[kind]
  if (!t) return false
  // Extension is the primary signal; a matching MIME with a missing/renamed
  // extension is also accepted, since browsers are inconsistent about both.
  return t.exts.includes(ext) || t.mimes.includes(mime)
}

function hasMagic(kind, buf) {
  const t = TYPES[kind]
  if (!t || !t.magic.length) return null   // nothing to check for this format
  return t.magic.some(sig => sig.every((b, i) => buf[i] === b))
}

// A buffer that decodes as text without replacement characters or NULs. Used for
// the formats that have no signature — this is what stops an .exe renamed to .csv.
function looksLikeText(buf) {
  const sample = buf.subarray(0, 4096)
  if (sample.includes(0x00)) return false
  const decoded = new TextDecoder('utf-8', { fatal: false }).decode(sample)
  const bad = (decoded.match(/�/g) || []).length
  return bad / Math.max(decoded.length, 1) < 0.01
}

/**
 * Verify an uploaded buffer really is one of the allowed kinds.
 * Returns { ok: true, kind } or { ok: false, error }.
 */
export function sniff(file, allowed) {
  const buf = file?.buffer
  if (!buf || !buf.length) return { ok: false, error: 'File is empty.' }

  const ext = path.extname(file.originalname || '').toLowerCase()
  const mime = (file.mimetype || '').split(';')[0].trim()

  const candidates = allowed.filter(k => matches(k, ext, mime))
  if (!candidates.length) {
    return { ok: false, error: `${ext || mime || 'That file type'} isn't supported. Allowed: ${allowed.join(', ')}.` }
  }

  for (const kind of candidates) {
    const m = hasMagic(kind, buf)
    if (m === true) return { ok: true, kind }
    if (m === null && looksLikeText(buf)) return { ok: true, kind }
  }

  return {
    ok: false,
    error: `This file's contents don't match its ${ext ? ext + ' extension' : 'declared type'}. It may be renamed or corrupted.`,
  }
}

/**
 * Build a multer instance that rejects disallowed types up front.
 *   makeUpload({ limitMb: 15, kinds: KINDS.knowledge })
 */
export function makeUpload({ limitMb, kinds }) {
  return multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: limitMb * 1024 * 1024, files: 1 },
    fileFilter(_req, file, cb) {
      const ext = path.extname(file.originalname || '').toLowerCase()
      const mime = (file.mimetype || '').split(';')[0].trim()
      if (kinds.some(k => matches(k, ext, mime))) return cb(null, true)
      cb(Object.assign(
        new Error(`${ext || mime || 'That file type'} isn't supported. Allowed: ${kinds.join(', ')}.`),
        { status: 400, isUploadType: true },
      ))
    },
  })
}

/**
 * Express error handler for multer failures. Without it, an oversized or rejected
 * upload surfaces as a generic 500 with a stack trace instead of telling the user
 * what was wrong with their file.
 */
export function uploadErrorHandler(err, _req, res, next) {
  if (!err) return next()
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'That file is too large.' })
  }
  if (err.isUploadType || err.code === 'LIMIT_UNEXPECTED_FILE') {
    return res.status(400).json({ error: err.message })
  }
  return next(err)
}
