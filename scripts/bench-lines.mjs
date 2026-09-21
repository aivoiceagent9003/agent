// scripts/bench-lines.mjs — the shared corpus for the STT/TTS bench scripts.
//
// Every line is a REAL agent reply or caller utterance from a GSK insurance call
// log. They are chosen to cover the cases that actually decide the engine choice:
// Telugu script, romanized Tinglish, English business words and rupee amounts
// inside a Telugu sentence, Hinglish, and plain English.
export const LINES = [
  { id: '1-telugu-script', lang: 'te-IN', script: 'telugu', text: 'వేవర్ ఆఫ్ ప్రీమియం రైడర్ అంటే, ఒకవేళ పాలసీదారునికి ఏదైనా ప్రమాదం జరిగి పని చేయలేని పరిస్థితి వస్తే, అప్పుడు కట్టాల్సిన ప్రీమియమ్స్ అన్నీ రద్దవుతాయండి.' },
  { id: '2-tinglish-roman', lang: 'te-IN', script: 'roman', text: 'Term life insurance kosam chusthunnara? Mana daggarayite Vaayu LifeShield Secure, Amrit LifeShield Secure options unnayandi.' },
  { id: '3-mixed-numbers', lang: 'te-IN', script: 'roman', text: 'Mee age 25 years, 2 crores sum assured ki, Supreme plan premium approx 15,960 rupees padthundhi andi. Taxes extra.' },
  { id: '4-hinglish', lang: 'hi-IN', script: 'roman', text: 'Premium details chahie na aapko sir? Main abhi check karke batata hoon.' },
  { id: '5-greeting-en', lang: 'en-IN', script: 'latin', text: 'Namaste, I am Aruna from GSK insurance. How can I help you?' },
  // English-only tier (Case 1): what a Deepgram-only stack would have to handle.
  { id: '6-english-quote', lang: 'en-IN', script: 'latin', text: 'For a two crore cover at age twenty five, the annual premium is fifteen thousand nine hundred and sixty rupees, excluding taxes.' },
]

// ── English-only tier (Case 1: Cartesia STT + TTS) ──────────────────────────
// A greeting scoring 0% WER does not prove an English stack works. What breaks STT
// on an insurance call is the specific stuff: rupee amounts, policy and customer
// IDs, plan and company names, phone numbers, percentages and dates — the exact
// tokens that must be right or the agent quotes the wrong figure. Indian-accented
// English is the default for these callers, so the audio is rendered with an
// en-IN voice, not a US one.
export const ENGLISH = [
  { id: 'en-01-greeting', lang: 'en-IN', text: 'Namaste, I am Aruna from GSK Insurance. How can I help you?' },
  { id: 'en-02-premium-digits', lang: 'en-IN', text: 'For a two crore cover at age twenty five, the annual premium is 15,960 rupees, excluding taxes.' },
  { id: 'en-03-premium-words', lang: 'en-IN', text: 'Your yearly premium comes to fifteen thousand nine hundred and sixty rupees, plus eighteen percent GST.' },
  { id: 'en-04-plan-names', lang: 'en-IN', text: 'We have Vaayu LifeShield Secure, Amrit LifeShield Supreme and Bharat Suraksha Assurance term plans.' },
  { id: 'en-05-policy-id', lang: 'en-IN', text: 'Could you confirm your customer ID? It should look like LN1000077 or PB204513.' },
  { id: 'en-06-phone-number', lang: 'en-IN', text: 'Is your registered mobile number nine one nine zero zero three five zero three six six four?' },
  { id: 'en-07-caller-question', lang: 'en-IN', text: 'I am looking for a term plan for my father, he is fifty eight years old and a non smoker.' },
  { id: 'en-08-claim-ratio', lang: 'en-IN', text: 'Our claim settlement ratio is ninety eight point four percent for the financial year twenty twenty five.' },
  { id: 'en-09-riders', lang: 'en-IN', text: 'You can add critical illness, accidental death benefit and waiver of premium riders.' },
  { id: 'en-10-callback', lang: 'en-IN', text: 'Can someone call me back tomorrow after six in the evening? My name is Rajesh Kumar.' },
]
