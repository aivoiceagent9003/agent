// Standalone test for Sarvam WebSocket TTS — run with: node test-tts-ws.js
// This isolates the TTS WebSocket to confirm the protocol works before
// integrating into the call pipeline

import WebSocket from 'ws'
import 'dotenv/config'
import { writeFileSync } from 'fs'

const TTS_WS_URL = 'wss://api.sarvam.ai/text-to-speech/ws?model=bulbul:v3&send_completion_event=true'

const ws = new WebSocket(TTS_WS_URL, {
  headers: { 'api-subscription-key': process.env.SARVAM_API_KEY }
})

const chunks = []

ws.on('open', () => {
  console.log('✅ WS open')

  // 1. Config
  ws.send(JSON.stringify({
    type: 'config',
    data: {
      target_language_code: 'en-IN',
      speaker: 'priya',
      speech_sample_rate: 8000,
      output_audio_codec: 'mulaw',
    }
  }))
  console.log('→ sent config')

  // 2. Text
  ws.send(JSON.stringify({
    type: 'text',
    data: { text: 'Hello, how can I help you today?' }
  }))
  console.log('→ sent text')

  // 3. Flush
  ws.send(JSON.stringify({ type: 'flush' }))
  console.log('→ sent flush')
})

ws.on('message', (data) => {
  // Log the RAW message structure so we see the exact format
  const str = data.toString()
  let msg
  try {
    msg = JSON.parse(str)
  } catch {
    console.log('← non-JSON message, length:', str.length)
    return
  }

  console.log('← message type:', msg.type, '| keys:', Object.keys(msg.data || {}))

  if (msg.type === 'audio' && msg.data?.audio) {
    chunks.push(Buffer.from(msg.data.audio, 'base64'))
    console.log(`  audio chunk: ${msg.data.audio.length} base64 chars`)
  }

  if (msg.type === 'event') {
    console.log('  EVENT:', JSON.stringify(msg.data))
    // Save and exit
    if (chunks.length > 0) {
      const full = Buffer.concat(chunks)
      writeFileSync('test_output.mulaw', full)
      console.log(`💾 Saved ${full.length} bytes to test_output.mulaw`)
    }
    ws.close()
  }
})

ws.on('error', (err) => console.error('❌ Error:', err.message))
ws.on('close', (code) => {
  console.log('WS closed:', code)
  console.log(`Total chunks: ${chunks.length}`)
  process.exit(0)
})

// Safety timeout
setTimeout(() => {
  console.log('⏱️ Timeout — closing')
  ws.close()
}, 10000)