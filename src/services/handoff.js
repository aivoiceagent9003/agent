
// When the AI can't help, transfer the live call to a human agent's phone.

import twilio from 'twilio'
import 'dotenv/config'

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
)

// ─── Handoff intent detection ─────────────────────────────────────────────────
// Layer 1: explicit keywords (instant, no LLM needed)

const HANDOFF_KEYWORDS = [
  // English
  'human', 'agent', 'representative', 'real person', 'speak to someone',
  'talk to someone', 'manager', 'supervisor', 'customer service',
  'transfer me', 'connect me', 'real agent', 'live agent',
  // Hindi (romanized + script)
  'इंसान', 'व्यक्ति', 'एजेंट', 'manager se baat',
  // Telugu
  'మనిషి', 'వ్యక్తి', 'ఏజెంట్',
]

// Detect if the caller's transcript explicitly asks for a human
export function detectHandoffKeyword(transcript) {
  const lower = transcript.toLowerCase()
  return HANDOFF_KEYWORDS.some(kw => lower.includes(kw.toLowerCase()))
}

// Layer 2: LLM signal detection
// The LLM is instructed to emit [HANDOFF] when it decides it cannot help.
// We strip the token before speaking and use it as the transfer trigger.
export function detectHandoffSignal(llmReply) {
  return /\[HANDOFF\]/i.test(llmReply)
}

export function stripHandoffSignal(text) {
  return text.replace(/\[HANDOFF\]/gi, '').trim()
}

// ─── Perform the warm transfer ────────────────────────────────────────────────
// Redirects the LIVE call to new TwiML that <Dial>s the human number.
// This automatically ends the Media Stream and connects the caller to the human.

export async function transferToHuman(callSid, handoffNumber, callerNumber) {
  try {
    console.log(`[HANDOFF] 🔀 Transferring call ${callSid} → ${handoffNumber}`)

    // TwiML that dials the human agent.
    // callerId must be a Twilio number you own (the number the caller dialed).
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Aditi">Please hold while I connect you to a team member.</Say>
  <Dial callerId="${process.env.TWILIO_PHONE_NUMBER}" timeout="30">
    <Number>${handoffNumber}</Number>
  </Dial>
  <Say voice="Polly.Aditi">Sorry, no one is available right now. Please try again later. Goodbye.</Say>
  <Hangup/>
</Response>`

    // Redirect the live call to this new TwiML via REST API
    await twilioClient.calls(callSid).update({ twiml })

    console.log(`[HANDOFF] ✅ Transfer initiated for ${callSid}`)
    return true

  } catch (err) {
    console.error('[HANDOFF] ❌ Transfer failed:', err.message)
    return false
  }
}