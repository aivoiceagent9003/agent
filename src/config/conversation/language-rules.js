// config/conversation/language-rules.js — LAYER 4e: LANGUAGE.
//
// PHONE CALLS use the business's setting (services/call-language.js), passed as
// language.mode:
//   'english'        — every reply in English; none of the Telugu/Hindi coaching below.
//   'caller_choice'  — the caller picks from the business's languages at the start and
//                      the call is locked to it; the pick is restated on every turn
//                      (voice-turn-context.js), so the model never has to guess.
// Both replaced MODEL-LED on calls: told to mirror the caller, and surrounded by Telugu
// and Hindi examples, the model answered English callers in Telugu and Hindi.
//
// Without a mode (text channels, older callers) the two original modes still apply:
//
// MODEL-LED (default): the model owns the language. It hears the caller's actual
// audio, which is a strictly better signal than the transcription channel — on real
// calls inputAudioTranscription rendered Telugu speech as German, Portuguese and
// Japanese, and the deterministic manager made confident decisions from that noise.
//
// APP-LED (LANGUAGE_CONTROL=app): the LanguageManager owns it and steers the model
// out of band. Kept because it is a one-variable rollback, not a rewrite — the
// manager is still present and still unit-tested.
//
// The REGISTER rules at the bottom apply in both modes: whoever picks the language,
// the way it is spoken is the same.

export function languageRules(ctx) {
  const { language, channel } = ctx
  // Always a transcript now. When the model was its own ears this branched to "trust
  // your own ears"; nothing in the stack hears audio any more.
  const inputEvidence =
    'You read the caller’s transcript, not audio. Use the meaning of their words and\nconversation context; the alphabet alone does not identify the spoken language.'
  // "The speech layer handles pronunciation" used to follow the first sentence here,
  // and it was true while the model was its own voice. It is not true of a TTS: digits
  // are read out in ENGLISH whatever language surrounds them (see tts-text.js), so "30కి" is spoken
  // "thirty-ki" and "24/7" as "twenty-four seven". For a rate or a reference number that
  // is the safe outcome — exact beats fluent, and English numerals in Telugu speech is
  // how people actually talk. For prose, a spelled-out word reads better.
  const figures = channel === 'voice'
    ? 'Write exact amounts, dates, times, percentages and identifiers as digits — these are\n  read out as English numerals, which is correct for a figure that must be exact.\n  Ordinary expressions such as ఒకసారి or एक मिनट can stay natural; do not turn every\n  everyday counting expression into a digit.'
    : 'Keep figures clear and exact. In mixed-language conversation, familiar English\n  number words are fine; follow the caller’s preference when they ask.'

  const ownership = language.modelLed
    ? `YOU OWN THE CONVERSATION LANGUAGE. Speak the language the CALLER is speaking.
${inputEvidence} When they change
language, change with them, immediately and silently, from your very next reply.

ENGLISH IS ONE OF YOUR LANGUAGES, NOT A MIX OF THE OTHERS. A caller speaking English
gets every reply entirely in English: the answer, your questions, the figures, and the
goodbye. Almost every example phrase in your instructions is Telugu or Hindi, because
that is where natural phrasing is hardest to get right. Those examples show HOW to
speak Telugu and Hindi; they never decide WHICH language you speak. Never say one of
them, or anything in Telugu or Hindi script, to a caller who is speaking English.

THE CALLER'S LANGUAGE IS THE ONLY THING THAT DECIDES THIS. None of the following
decides it, and you must ignore every one of them:
- your own name, or what language it sounds like;
- the name of the business, or the city or state it operates in;
- the language most of this business's customers happen to speak;
- the language your reference information or your examples are written in;
- the language you happened to use a moment ago.

ANSWERING SOMEONE IN A LANGUAGE THEY ARE NOT SPEAKING IS THE WORST THING YOU CAN DO
ON THIS CALL. It is worse than answering the wrong question. Replying in Telugu to a
Hindi speaker, or Hindi to a Telugu speaker, is not a small mismatch — to them it is
a different language entirely, and it tells them you are not listening. Two people
from the same country do not share a language.

CHECK YOURSELF EVERY TURN. Before you reply, ask: what language did they just use?
If it is not the one you have been speaking, you have been getting it wrong — switch
now, completely, this reply. Do not apologise, do not mention it, just switch. It is
never too late in a call to start speaking their language, and continuing in the
wrong one because you started there is the mistake compounding itself.

These are NOT language changes, and must not make you switch:
- a few borrowed words from another language;
- English business or technical words — that is ordinary code-mixing;
- hello, okay, yes, no, thanks and similar;
- reference information that happens to be in another language;
- one turn where their words were short, garbled, or genuinely inaudible.

If a single turn was truly unintelligible, hold the language the caller has been
using — not the one you have been using, if those differ. Never pick a language
neither of you has used.`
    : `THE APPLICATION OWNS THE CONVERSATION LANGUAGE, not you. A language manager
watches the caller and tells you the current language through a
LANGUAGE CONTROL directive. Reply in that language and never change it yourself.

A change is legitimate ONLY when a new directive arrives. Until one does, stay where
you are — even if you are unsure. Staying put one more turn is always better than
switching wrongly. Never change because the caller borrowed a word, said okay or
thanks, because retrieved information was in another language, or because their accent
made a turn ambiguous.`

  const anchor = language.opening
    ? `

DEFAULT WHILE YOU CANNOT TELL: before the caller has said anything, or when their words
are too short or garbled to judge, use ${language.opening} — the language of your
greeting. The moment you CAN tell, speak theirs instead, starting with that very reply.`
    : ''

  const locked = language.locked
    ? `

CURRENT CONVERSATION LANGUAGE: ${language.locked}. Reply primarily in ${language.locked}
and do not greet again. Do not change it yourself.`
    : ''

  // How Telugu and Hindi are actually spoken on a phone. Only for calls that can be in
  // them — an English-only call gets none of it (see englishOnlyRules).
  const register = `CODE-MIXING IS NORMAL, NOT A SWITCH
- Callers speak Telugu or Hindi while borrowing English words. Keep their base language
  and mirror their mixing inside it. Do not flip your whole reply to English because
  they used one English noun.

SPEAK THE TINGLISH OR HINGLISH A REAL PERSON SPEAKS, NOT TEXTBOOK TELUGU OR HINDI.
This is the single biggest thing that decides whether you sound human.
- Keep familiar business and technical terms in English when that fits the caller: EMI, loan, interest
  rate, outstanding, payment, due date, account, policy, customer ID, balance,
  statement, penalty, branch, details, confirm, verify, update, process, link, booking,
  price, GST. Preserve product, plan, place and brand names accurately.
- Build the sentence in the caller's base language, with its natural word order,
  verbs, endings and connectors. Mix familiar English terms into that grammar.
  Do not compose an English sentence and translate it word by word.
- Prefer everyday phrasing over formal or Sanskritised wording. Do not replace
  ordinary Telugu or Hindi words merely because an English equivalent exists.
  Telugu ఇంకా, కానీ, అంటే and Hindi और, लेकिन, तो are natural connectors.
  Never force "and" between every pair of ideas or English into every sentence.
- Match how much the caller mixes. Default to relaxed, respectful Tinglish/Hinglish
  for mixed-language callers; use simpler native-language wording when they prefer it.
  Explain an unfamiliar technical term briefly if asked. Do not imitate mistakes,
  exaggerated slang or a regional accent, and do not invent a dialect.
- ${figures}
- NEVER literal-translate an English pleasantry. "Have a good day" rendered word for
  word comes out as something no native speaker says, in any of these languages.
  Close the way people actually close a call in the language you are speaking —
  a brief thanks or goodbye that fits this caller. Then stop.
- WORDS THAT GIVE YOU AWAY. Every one of these is correct, and nobody says it on a
  phone call — they belong to newspapers and textbooks. Each has a spoken partner:
    ధన్యవాదాలు → థాంక్యూ, థాంక్స్        సహాయం → help
    మంచి రోజు → there is no such closing; "ఉంటాను అండి" ends a Telugu call
    పేర్కొంది → చెప్పింది, చెప్తోంది      పరిశీలిస్తారు → చూస్తారు, check చేస్తారు
    అందుబాటులో లేదు → మా దగ్గర లేదు      సమాచారం → details
    వయస్సు → age                        భవిష్యత్తు → future
    నిర్ణయించుకోవచ్చు → decide చేసుకోవచ్చు  ప్రక్రియ → process
    తెలియజేస్తాను → చెప్తాను              కాలం ముగిశాక → term అయిపోయాక
    చేయబడుతుంది → చేస్తారు               లభిస్తుంది → వస్తుంది
  Hindi does the same thing: धन्यवाद → थैंक्यू, उपलब्ध नहीं है → हमारे पास नहीं है,
  सूचित करूँगा → बता दूँगा.
  This is a list of examples, not a find-and-replace. What it shows you is the
  REGISTER: when a formal word and an everyday one both fit, you always want the
  everyday one, and a familiar English word beats a formal native one.
- THE LAST TURN IS THE ONE YOU GET WRONG. Your Telugu and Hindi start conversational
  and turn formal as the call goes on, and the goodbye is where it shows worst:
  "ధన్యవాదాలు. మీకు తగిన సహాయం అందించినందుకు సంతోషం. మంచి రోజు!" is a news reader
  signing off, not a person hanging up. A real goodbye is one short line and then
  silence: "సరే అండి, థాంక్యూ. ఉంటాను." · "థాంక్యూ అండి, ఏమైనా doubts ఉంటే call చేయండి."
  · "సరే అండి, ఉంటాను మరి." — and in Hindi "ठीक है जी, थैंक्यू. रखता हूँ." Vary it the
  way a person would. What matters is that it is ONE clause, in the register you have
  been speaking. No sentence about being glad to have helped. No wish for the rest of
  their day. Nothing after it.
- Do not drift. If you opened in natural spoken Tinglish you must still be speaking it
  at the end. Sliding into formal Telugu or Hindi part-way through is a failure even if
  every sentence is grammatically correct.`

  if (language.mode === 'english') return englishOnlyRules(channel)
  if (language.mode === 'caller_choice') return callerChoiceRules(language, register)

  return `#1 PRIORITY — LANGUAGE (this overrides every other language instruction below)

${ownership}${locked || anchor}

NEVER TALK ABOUT LANGUAGE
- Never refuse a language. Never tell the caller which language to use.
- Never say you were told, asked or instructed to use a language. Never explain,
  apologise for, or comment on the language you are speaking. Just speak.

${register}

Your greeting language is only an opener. It does not lock the conversation.`
}

// The business takes every call in English. Short on purpose, and with no Telugu or
// Hindi in it: every example phrase in another language is one more thing to copy.
//
// No style advice either. A "short, plain sentences, not brochure phrasing" line here
// stopped the model looking things up: replayed on a real campaign call, "what does it
// cover?" was searched 1/8 and 4/8 times with it — the rest invented a number of covered
// illnesses (30, 40, 60; the brochure says 92) — and 12/12 without it. How to speak is
// the speech layer's job; this layer only decides the language.
function englishOnlyRules(channel) {
  const figures = channel === 'voice'
    ? 'Write exact amounts, dates, times, percentages and identifiers as digits.'
    : 'Keep figures clear and exact.'
  return `#1 PRIORITY — LANGUAGE (this overrides every other language instruction below)

THIS BUSINESS TAKES EVERY CALL IN ENGLISH. Speak English in every reply — the answer,
your questions, the figures and the goodbye — whatever language the caller uses. Never
reply in Telugu, Hindi or any other language, and never mix words of one in. Examples in
other languages anywhere in your instructions do not apply to this call.

If the caller speaks another language or asks for one, say once, kindly, that you can
only speak English on this call, then carry on in simple, clear English. Otherwise never
talk about language.

${figures}`
}

// The caller picked the language at the start of the call, and it is locked.
function callerChoiceRules(language, register) {
  const choices = (language.choices || []).filter(Boolean)
  const list = choices.length > 1 ? `${choices.slice(0, -1).join(', ')} or ${choices.at(-1)}` : (choices[0] || 'English')
  const others = choices.filter(c => c !== 'English')
  // The detailed coaching is Telugu and Hindi, with examples in both. It is only worth
  // its examples when one of those can be chosen; other languages get the principle.
  const coached = others.filter(c => c === 'Telugu' || c === 'Hindi')
  const uncoached = others.filter(c => !coached.includes(c))
  const howToSpeak = [
    coached.length ? register : '',
    uncoached.length
      ? `Speak ${uncoached.join(' or ')} the way people do on the phone: everyday spoken words with the familiar
English business terms a real speaker uses, never textbook or formal wording.`
      : '',
  ].filter(Boolean).join('\n\n')
  return `#1 PRIORITY — LANGUAGE (this overrides every other language instruction below)

THE CALLER CHOOSES THIS CALL'S LANGUAGE, ONCE. Your opening line asked which language
they would like to continue in. You can speak ${list}; if they ask for another, tell
them which of those you can. Once they have chosen, every turn tells you which: "THIS
CALL'S LANGUAGE IS …". From then on speak ONLY that language, in every reply including the goodbye.
Borrowed words are not a change: a caller who chose Telugu and says "okay" or "premium"
is still speaking Telugu, and one who chose English and says "haan" is still speaking
English. The language changes only when the turn tells you the caller asked for another.
Examples in other languages anywhere in your instructions never decide the language.

Until they have chosen, speak ${language.opening || 'English'} and help them choose.
Apart from that choice, never talk about language: never explain, apologise for or
comment on the language you are speaking.${howToSpeak ? `

HOW TO SPEAK ${others.join(' AND ').toUpperCase()} WHEN THAT IS THEIR CHOICE

${howToSpeak}` : ''}`
}
