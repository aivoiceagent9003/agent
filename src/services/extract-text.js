// services/extract-text.js — plain text out of an uploaded knowledge file.
//
// Shared by the knowledge base upload (api/agent.js) and campaign files
// (api/campaigns.js), so a file that works in one works in the other. Callers must
// have run the upload allow-list (api/uploads.js) first: this trusts the type.
//
//   PDF   → pdf-parse        DOCX → mammoth
//   image → OpenAI vision    everything else → treat as UTF-8 text

import OpenAI from 'openai'
import 'dotenv/config'

const ai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

export async function extractTextFromFile(file) {
  const name = (file.originalname || '').toLowerCase()
  const mime = file.mimetype || ''
  const buf = file.buffer

  if (mime === 'application/pdf' || name.endsWith('.pdf')) {
    const { PDFParse } = await import('pdf-parse')
    const parser = new PDFParse({ data: buf })
    const result = await parser.getText()
    return result?.text || ''
  }

  if (name.endsWith('.docx') ||
      mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    const mammoth = (await import('mammoth')).default
    const { value } = await mammoth.extractRawText({ buffer: buf })
    return value || ''
  }

  if (mime.startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp)$/.test(name)) {
    // OCR via a vision model — handles scanned docs, screenshots, photos.
    const dataUrl = `data:${mime || 'image/png'};base64,${buf.toString('base64')}`
    const completion = await ai.chat.completions.create({
      model: process.env.OPENAI_VISION_MODEL || 'gpt-4o-mini',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'Extract ALL text and useful information from this image as plain text for a knowledge base — include prices, names, numbers, and details. Output only the extracted text, no commentary.' },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      }],
      max_tokens: 1500,
    })
    return completion.choices[0]?.message?.content || ''
  }

  // .txt / .md / .csv / .json / unknown → best-effort UTF-8
  return buf.toString('utf8')
}
