import twilio from 'twilio'
import 'dotenv/config'

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
)

const call = await client.calls.create({
  twiml: `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${process.env.NGROK_URL}/media-stream">
      <Parameter name="caller_number" value="+919003503664"/>
    </Stream>
  </Connect>
  <Pause length="30"/>
</Response>`,
  to: '+919003503664',
  from: process.env.TWILIO_PHONE_NUMBER
})

console.log('Test call initiated:', call.sid)