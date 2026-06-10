import WebSocket from 'ws'
import 'dotenv/config'

console.log('Testing Deepgram API key:', process.env.DEEPGRAM_API_KEY?.slice(0, 8) + '...')

const ws = new WebSocket('wss://api.deepgram.com/v1/listen?model=nova-2', {
  headers: {
    Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`
  }
})

ws.on('open', () => console.log('✅ Deepgram connected successfully'))
ws.on('error', (e) => console.log('❌ Deepgram error:', e.message))
ws.on('close', (code) => console.log('Closed with code:', code))

// Close after 3 seconds
setTimeout(() => ws.close(), 3000)