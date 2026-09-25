// tts-text.js — turn what the model WROTE into what the voice should SAY.
//
// TTS engines read punctuation literally in Indic languages: given Telugu text, one
// said "chukka" (dot) for a full stop. Written text also carries things no
// one speaks: "₹15,960", "Rs.", "98.4%", "approx.", "...". Each engine guesses at
// those differently, and a wrong guess is spoken to the caller.
//
// So the text is normalised BEFORE any engine sees it, and split into sentences.
// Pauses then come from sentence boundaries (one TTS request per sentence), not
// from a "." the engine may pronounce. Streaming pipelines want sentence chunks
// anyway: the first sentence can start playing while the model is still writing.
//
// Money, numbers and percentages are rendered in ENGLISH words, matching the speech
// rules the agent already follows (config/conversation/language-rules.js): a
// Telugu speaker says "fifteen thousand rupees", not a textbook Telugu number.

// "15,960" and Indian grouping "1,00,000" → plain digits.
const stripGrouping = (s) => s.replace(/(\d),(?=\d)/g, '$1')

// Scale words that belong to the number before them. Longest spellings first, so
// "లక్షలు" is not matched as "లక్షల" with a stray vowel sign left behind.
const SCALE = 'crores|crore|lakhs|lakh|lacs|lac|thousand|కోట్లు|కోట్ల|కోటి|లక్షలు|లక్షల|లక్ష|వేలు|వేల|करोड़|लाख|हज़ार|हजार'

// A scale word in the caller's script is still said in English on a real call:
// "మూడు పాయింట్ ఐదు కోట్ల" is textbook; "three point five crore" is what people say.
const SCALE_IN_ENGLISH = [
  [/కోట్లు|కోట్ల|కోటి|करोड़/gu, 'crore'],
  [/లక్షలు|లక్షల|లక్ష|लाख/gu, 'lakh'],
  [/వేలు|వేల|हज़ार|हजार/gu, 'thousand'],
]

// ── Numbers as English words ────────────────────────────────────────────────
// A bilingual caller says figures in English mid-sentence. Left as digits, an Indic
// TTS voice reads them as literary numerals — the "dictionary Telugu" nobody speaks.
const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen']
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety']

const under100 = (n) => (n < 20 ? ONES[n] : TENS[Math.floor(n / 10)] + (n % 10 ? ` ${ONES[n % 10]}` : ''))
const under1000 = (n) => (n < 100 ? under100(n) : `${ONES[Math.floor(n / 100)]} hundred${n % 100 ? ` ${under100(n % 100)}` : ''}`)

/** 15960 → "fifteen thousand nine hundred sixty", in Indian scale words. */
export function numberToEnglishWords(n) {
  if (!Number.isFinite(n)) return String(n)
  if (n === 0) return 'zero'
  const parts = []
  let rest = n
  for (const [value, name] of [[1e7, 'crore'], [1e5, 'lakh'], [1000, 'thousand']]) {
    if (rest >= value) {
      parts.push(`${numberToEnglishWords(Math.floor(rest / value))} ${name}`)
      rest %= value
    }
  }
  if (rest) parts.push(under1000(rest))
  return parts.join(' ')
}

// ── Indic number WORDS → English ────────────────────────────────────────────
// The rules tell the model to write figures in English words. On a real call it
// wrote them in Telugu instead — "ఎనిమిది వేల నాలుగు వందల రూపాయలు" for ₹8,400 —
// which is the textbook register nobody speaks on the phone. Digits alone are not
// enough to catch that, so the words are converted too.
//
// Telugu numbers are compositional (twenty + five), so the whole range is covered.
// Hindi has a distinct word for every number to 99; the common ones are here and
// anything unrecognised is simply left alone.
const INDIC_UNITS = new Map(Object.entries({
  సున్నా: 0, ఒకటి: 1, ఒక్క: 1, ఒక: 1, రెండు: 2, మూడు: 3, నాలుగు: 4, ఐదు: 5, అయిదు: 5,
  ఆరు: 6, ఏడు: 7, ఎనిమిది: 8, తొమ్మిది: 9, పది: 10, పదకొండు: 11, పన్నెండు: 12, పదమూడు: 13,
  పద్నాలుగు: 14, పదిహేను: 15, పదహారు: 16, పదిహేడు: 17, పద్దెనిమిది: 18, పంతొమ్మిది: 19,
  ఇరవై: 20, ముప్పై: 30, ముప్ఫై: 30, నలభై: 40, నలబై: 40, యాభై: 50, ఏభై: 50, అరవై: 60,
  డెబ్బై: 70, డెబ్భై: 70, ఎనభై: 80, ఎనబై: 80, తొంభై: 90, తొంబై: 90,
  शून्य: 0, एक: 1, दो: 2, तीन: 3, चार: 4, पांच: 5, पाँच: 5, छह: 6, छः: 6, सात: 7, आठ: 8,
  नौ: 9, दस: 10, ग्यारह: 11, बारह: 12, तेरह: 13, चौदह: 14, पंद्रह: 15, सोलह: 16, सत्रह: 17,
  अठारह: 18, उन्नीस: 19, बीस: 20, पच्चीस: 25, तीस: 30, चालीस: 40, पचास: 50, साठ: 60,
  सत्तर: 70, अस्सी: 80, नब्बे: 90,
  // Malayalam, Tamil and Kannada are here as a safety net, not because the agent
  // speaks them: asked for a number in words, the model sometimes reaches for a
  // neighbouring alphabet and drops "twenty five" into a Telugu sentence in
  // Malayalam letters, which the voice then cannot read.
  പൂജ്യം: 0, ഒന്ന്: 1, രണ്ട്: 2, മൂന്ന്: 3, നാല്: 4, അഞ്ച്: 5, ആറ്: 6, ഏഴ്: 7, എട്ട്: 8,
  ഒമ്പത്: 9, പത്ത്: 10, ഇരുപത്: 20, ഇരുപത്തി: 20, മുപ്പത്: 30, നാൽപ്പത്: 40, അമ്പത്: 50,
  അറുപത്: 60, എഴുപത്: 70, എൺപത്: 80, തൊണ്ണൂറ്: 90,
  பூஜ்யம்: 0, ஒன்று: 1, இரண்டு: 2, மூன்று: 3, நான்கு: 4, ஐந்து: 5, ஆறு: 6, ஏழு: 7,
  எட்டு: 8, ஒன்பது: 9, பத்து: 10, இருபது: 20, இருபத்தி: 20, முப்பது: 30, நாற்பது: 40,
  ஐம்பது: 50, அறுபது: 60, எழுபது: 70, எண்பது: 80, தொண்ணூறு: 90,
  ಸೊನ್ನೆ: 0, ಒಂದು: 1, ಎರಡು: 2, ಮೂರು: 3, ನಾಲ್ಕು: 4, ಐದು: 5, ಆರು: 6, ಏಳು: 7, ಎಂಟು: 8,
  ಒಂಬತ್ತು: 9, ಹತ್ತು: 10, ಇಪ್ಪತ್ತು: 20, ಮೂವತ್ತು: 30, ನಲವತ್ತು: 40, ಐವತ್ತು: 50, ಅರವತ್ತು: 60,
  ಎಪ್ಪತ್ತು: 70, ಎಂಬತ್ತು: 80, ತೊಂಬತ್ತು: 90,
}))
const INDIC_SCALES = new Map(Object.entries({
  // "నూట" is the combining hundred: నూట ఒకటి is 101, not 100 and 1.
  వంద: 100, వందల: 100, వందలు: 100, నూట: 100, వెయ్యి: 1000, వేయి: 1000, వేల: 1000, వేలు: 1000,
  లక్ష: 1e5, లక్షల: 1e5, లక్షలు: 1e5, కోటి: 1e7, కోట్ల: 1e7, కోట్లు: 1e7,
  सौ: 100, हज़ार: 1000, हजार: 1000, लाख: 1e5, करोड़: 1e7,
  നൂറ്: 100, ആയിരം: 1000, ലക്ഷം: 1e5, കോടി: 1e7,
  நூறு: 100, ஆயிரம்: 1000, லட்சம்: 1e5, கோடி: 1e7,
  ನೂರು: 100, ಸಾವಿರ: 1000, ಲಕ್ಷ: 1e5, ಕೋಟಿ: 1e7,
}))
// "ఒక ప్లాన్" is "a plan", not "one plan" — a lone one is left as it is.
const LONE_ONE = new Set(['ఒక', 'ఒక్క', 'ఒకటి', 'एक'])
// Words that travel with a figure and are said in English too: "three point five
// crore", "eighteen percent", "eight thousand four hundred rupees".
const INDIC_UNIT_WORDS = new Map(Object.entries({
  రూపాయలు: 'rupees', రూపాయల: 'rupees', రూపాయి: 'rupees', రూపాయిలు: 'rupees',
  శాతం: 'percent', పాయింట్: 'point',
  रुपये: 'rupees', रुपए: 'rupees', रुपया: 'rupees', प्रतिशत: 'percent', पॉइंट: 'point',
}))

// Telugu glues its case markers straight onto the number word: "వందలకు" is "వందల"
// plus "కు" (to). Matching only whole words ended the run one word early, and a real
// call put "ఏడు వేల ఐదు వందలకు" through the voice as "seven thousand five vandalaku".
const TE_CASE_SUFFIXES = ['నుంచి', 'నుండి', 'కు', 'కి', 'కే', 'కూ', 'లో', 'తో', 'పై', 'గా']

/** The number word inside a token, and whatever grammar was glued to it. */
function splitIndicNumber(token) {
  if (INDIC_UNITS.has(token) || INDIC_SCALES.has(token)) return { base: token, suffix: '' }
  for (const s of TE_CASE_SUFFIXES) {
    if (token.length > s.length && token.endsWith(s)) {
      const base = token.slice(0, -s.length)
      if (INDIC_UNITS.has(base) || INDIC_SCALES.has(base)) return { base, suffix: s }
    }
  }
  return null
}

function indicNumberWordsToEnglish(text) {
  const dominantScript = scriptLanguage(text)
  const parts = String(text).split(/(\s+)/)
  const out = []
  let i = 0
  while (i < parts.length) {
    const token = parts[i]
    if (!splitIndicNumber(token)) {
      out.push(INDIC_UNIT_WORDS.get(token) || token)
      i++
      continue
    }
    // Take the whole run of number words: "ఎనిమిది వేల నాలుగు వందల" is one figure.
    const run = []
    let trailing = ''
    let j = i
    while (j < parts.length) {
      const t = parts[j]
      if (/^\s+$/.test(t)) { j++; continue }
      const m = splitIndicNumber(t)
      if (!m) break
      run.push(m.base)
      j++
      // A case marker closes the figure: "వందలకు ఐదు" is not one number.
      if (m.suffix) { trailing = m.suffix; break }
    }
    if (run.length === 1 && LONE_ONE.has(run[0])) { out.push(parts[i]); i++; continue }

    // Only a FIGURE gets converted. "పది కంపెనీలు" (ten companies) and "రెండు
    // వేరియంట్స్" (two variants) are ordinary spoken Telugu counting; turning those
    // into English mid-sentence is its own kind of wrong. A figure is one with a
    // scale word, one followed by a currency or percent, or a compound like
    // "ఇరవై ఐదు" (twenty five) — which is how ages and amounts are written.
    // A number word in a script this sentence is not written in is the model having
    // reached for the wrong alphabet. The voice cannot read it, so it always converts,
    // figure or not.
    const strayScript = scriptLanguage(run.join('')) !== dominantScript
    const hasScale = run.some(w => INDIC_SCALES.has(w))
    const nextWord = parts.slice(j).find(p => !/^\s*$/.test(p)) || ''
    const unitFollows = INDIC_UNIT_WORDS.has(nextWord) || /^(rupees|percent|crore|lakh|thousand)\b/i.test(nextWord)
    // A compound number reads tens-then-units ("ఇరవై ఐదు"); "రెండు మూడు" (two or
    // three) is two separate counts and must not be added together.
    const isCompound = run.length === 2 && !hasScale &&
      INDIC_UNITS.get(run[0]) >= 20 && INDIC_UNITS.get(run[0]) % 10 === 0 && INDIC_UNITS.get(run[1]) < 10
    if (!strayScript && !hasScale && !unitFollows && !isCompound) {
      out.push(...parts.slice(i, j))
      i = j
      continue
    }

    let total = 0
    let cur = 0
    for (const word of run) {
      if (INDIC_SCALES.has(word)) {
        const scale = INDIC_SCALES.get(word)
        if (scale >= 1000) { total += (cur || 1) * scale; cur = 0 }
        // A second hundred on top of a hundred is the model stuttering, not a figure:
        // it wrote "నూట వంద శాతం" and a caller heard that as 101%. Multiplying would
        // have made it ten thousand percent. The first one is what was meant.
        else if (cur < scale) cur = (cur || 1) * scale
      } else {
        cur += INDIC_UNITS.get(word)
      }
    }
    out.push(numberToEnglishWords(total + cur))
    if (trailing) out.push(' ', trailing)
    // Skip the run, keeping the whitespace that followed it.
    i = j
    if (parts[j - 1] !== undefined && /^\s+$/.test(parts[j] || '')) { /* handled by loop */ }
    out.push(' ')
  }
  return out.join('').replace(/[ \t]{2,}/g, ' ')
}

/** Years are said differently from amounts: 1998 is "nineteen ninety eight". */
function yearWords(n) {
  if (n >= 2000 && n <= 2009) return `two thousand${n % 2000 ? ` ${under100(n % 2000)}` : ''}`
  const hi = Math.floor(n / 100)
  const lo = n % 100
  if (lo === 0) return `${under100(hi)} hundred`
  return `${under100(hi)} ${lo < 10 ? `oh ${ONES[lo]}` : under100(lo)}`
}

// Optional tenant-owned pronunciations change only speech, never transcripts,
// search queries or product identifiers. Match whole names, longest first, once.
// Shape: { "Sanjeevani": { te: "సంజీవని", hi: "संजीवनी" } }.
// 29 → "twenty ninth": only the last word changes form.
const ORDINAL_LAST = { one: 'first', two: 'second', three: 'third', five: 'fifth', eight: 'eighth', nine: 'ninth', twelve: 'twelfth' }
function ordinalWords(n) {
  const words = numberToEnglishWords(n).split(' ')
  const last = words.pop()
  words.push(ORDINAL_LAST[last] || (last.endsWith('y') ? `${last.slice(0, -1)}ieth` : `${last}th`))
  return words.join(' ')
}

export function applyPronunciations(input, pronunciations) {
  const text = String(input || '')
  if (!pronunciations || typeof pronunciations !== 'object' || Array.isArray(pronunciations)) return text
  const lang = scriptLanguage(text)
  const entries = Object.entries(pronunciations).flatMap(([name, value]) => {
    const spoken = typeof value === 'string' ? value : value?.[lang]
    return name.trim() && typeof spoken === 'string' && spoken.trim()
      ? [[name, spoken.trim()]] : []
  }).sort((a, b) => b[0].length - a[0].length)
  if (!entries.length) return text
  const replacements = new Map(entries.map(([name, spoken]) => [name.toLowerCase(), spoken]))
  const escaped = entries.map(([name]) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}\\p{M}])(?:${escaped.join('|')})(?![\\p{L}\\p{N}\\p{M}])`, 'giu')
  return text.replace(pattern, name => replacements.get(name.toLowerCase()))
}

export function normalizeForTts(input, { keepQuestionMark = true, pronunciations } = {}) {
  let t = String(input || '')

  t = applyPronunciations(t, pronunciations)
  // Compound display names need a word boundary for speech: HealthShield -> Health Shield.
  t = t.replace(/([a-z])([A-Z][a-z])/g, '$1 $2')
  // Repair the mixed-script honorific seen in live replies: "ఉందిandi".
  if (scriptLanguage(t) === 'te') {
    t = t.replace(/([\u0C00-\u0C7F])andi\b/gi, '$1 అండి')
    t = t.replace(/\bandi\b/gi, 'అండి').replace(/\bgaru\b/gi, 'గారు')
  }

  // List formatting the model was told not to use, and on a real call used anyway:
  // "- అదనపు రైడర్స్" went to the voice with its hyphen.
  t = t.replace(/^[ \t]*(?:[-•*]|\d+[.)])[ \t]+/gm, '')

  // Money: ₹15,960 · Rs.15,960 · Rs 15,960 · INR 15,960  →  15960 rupees
  // A scale word belongs to the number, so the currency goes after it. On a real call
  // "₹5 కోట్ల" (5 crore) was spoken as "5 rupees కోట్ల".
  t = t.replace(
    new RegExp(`(?:₹|\\bRs\\.?|\\bINR)[ \\t]*(\\d[\\d,]*(?:\\.\\d+)?)([ \\t]*(?:${SCALE}))?`, 'giu'),
    (_, n, scale) => `${stripGrouping(n)}${scale ? ' ' + scale.trim() : ''} rupees`,
  )
  t = stripGrouping(t)

  // "3.5 కోట్ల" → "3.5 crore": the scale word is said in English too.
  for (const [pattern, english] of SCALE_IN_ENGLISH) {
    t = t.replace(new RegExp(`(\\d[\\d.]*[ \\t]*)(?:${pattern.source})`, 'gu'), `$1${english}`)
  }

  // Decimals before sentence splitting, so "98.4" never looks like a full stop.
  t = t.replace(/(\d)\s*%/g, '$1 percent')
  t = t.replace(/(\d)\.(\d+)/g, (_, integerEnd, fraction) =>
    `${integerEnd} point ${[...fraction].map(d => ONES[Number(d)]).join(' ')}`)

  // Figures the model wrote in the caller's own words ("ఎనిమిది వేల నాలుగు వందల").
  t = indicNumberWordsToEnglish(t)

  // Ordinals, before the rule below mistakes "29th" for an identifier and reads it a
  // digit at a time: a real call said "two nine th August". The \b in front keeps a
  // code with letters before its digits (LN12th) out of this.
  t = t.replace(/\b(\d{1,4})(?:st|nd|rd|th)\b/gi, (_, n) => ordinalWords(Number(n)))

  // Every remaining figure becomes English words, so the voice never reads a digit.
  t = t.replace(/\d+/g, (num, offset, whole) => {
    const before = whole[offset - 1] || ''
    const after = whole[offset + num.length] || ''
    const isMoney = /^[ \t]*rupees/i.test(whole.slice(offset + num.length))
    // Part of an identifier (LN1000077), or a long run such as a phone number: every
    // digit separately, which is what the speech rules require anyway. An amount is
    // never spelled out that way — 2,00,00,000 is "two crore", not eight digits.
    const inCode = /[A-Za-z]/.test(before) || /[A-Za-z]/.test(after)
    if (inCode || (num.length >= 9 && !isMoney)) {
      const digits = num.split('').map(d => ONES[Number(d)]).join(' ')
      // Keep the identifier's letters and digits apart: "LN one zero", not "LNone".
      return `${/[A-Za-z]/.test(before) ? ' ' : ''}${digits}${/[A-Za-z]/.test(after) ? ' ' : ''}`
    }
    const n = Number(num)
    const isYear = n >= 1900 && n <= 2099 && !isMoney
    return isYear ? yearWords(n) : numberToEnglishWords(n)
  })

  // Abbreviations whose dot is not a sentence end.
  t = t.replace(/\b(approx|Mr|Mrs|Ms|Dr|No|vs|etc|Ltd|Pvt|St)\./gi, '$1')
  t = t.replace(/\be\.g\./gi, 'for example').replace(/\bi\.e\./gi, 'that is')

  // Ellipsis is a hesitation, not three dots. (Horizontal space only throughout —
  // a line break is a sentence boundary and must survive to the split below.)
  t = t.replace(/[ \t]*(?:\.{2,}|…)[ \t]*/g, ', ')

  // Symbols nobody says aloud.
  t = t.replace(/[ \t]*&[ \t]*/g, ' and ')
  t = t.replace(/[*_#"“”‘’()[\]{}<>|~^`]/g, ' ')
  t = t.replace(/[ \t]*[:;][ \t]*/g, ', ')
  t = t.replace(/(\p{L})[ \t]*[-–—][ \t]*(\p{L})/gu, '$1 $2')

  // A full stop glued to the next word ("అండి.ఇంకా") is still a sentence end.
  t = t.replace(/([.!?।])(?=\p{L})/gu, '$1 ')

  const sentences = t
    .split(/\n+/)
    .flatMap(line => line.split(/(?<=[.!?।])\s+/u))
    .map(s => s.replace(/\s+/g, ' ').trim())
    // The pause comes from the chunk boundary; the mark itself is what gets spoken.
    .map(s => s.replace(keepQuestionMark ? /[.!।]+$/u : /[.!?।]+$/u, '').trim())
    .map(s => s.replace(/^[,\s]+|[,\s]+$/g, ''))
    .filter(s => /[\p{L}\p{N}]/u.test(s))

  return sentences
}

// Abbreviations whose trailing dot must not end a sentence mid-stream.
const ABBREV_END = /\b(?:Rs|Mr|Mrs|Ms|Dr|No|vs|etc|approx|Ltd|Pvt|St|e\.g|i\.e)\.$/i

/**
 * Cuts a token stream into sentences AS IT ARRIVES, so the first sentence can go to
 * TTS while the model is still writing the rest. That is the latency win of a
 * cascaded pipeline: the caller hears sentence one without waiting for sentence
 * three to be generated.
 *
 * A sentence ends at . ! ? or । FOLLOWED BY WHITESPACE — so "98.4" and "15,960"
 * never split, and neither does "Rs." or "approx." A run-on with no punctuation is
 * cut at a comma or space once it passes maxChars, so one long sentence cannot
 * hold up the first audio indefinitely.
 */
export function createSentenceChunker({ maxChars = 220 } = {}) {
  let buf = ''
  return {
    push(token) {
      buf += String(token || '')
      const out = []
      for (;;) {
        // A line break ends a sentence too — models put one before a list item.
        const re = /[.!?।]+(?=\s)|\n+/gu
        let cut = -1
        let m
        while ((m = re.exec(buf))) {
          const end = m.index + m[0].length
          if (m[0].startsWith('.') && ABBREV_END.test(buf.slice(0, end))) continue
          cut = end
          break
        }
        if (cut !== -1) {
          out.push(buf.slice(0, cut).trim())
          buf = buf.slice(cut)
          continue
        }
        // A run-on with no punctuation at all still has to start playing.
        if (buf.length > maxChars) {
          const at = Math.max(buf.lastIndexOf(', ', maxChars), buf.lastIndexOf(' ', maxChars))
          if (at > 40) { out.push(buf.slice(0, at + 1).trim()); buf = buf.slice(at + 1); continue }
        }
        break
      }
      return out.filter(Boolean)
    },
    /** Whatever is left once the stream ends. */
    flush() {
      const s = buf.trim()
      buf = ''
      return s ? [s] : []
    },
  }
}

const SCRIPTS = [['te', /[ఀ-౿]/g], ['hi', /[ऀ-ॿ]/g], ['ta', /[஀-௿]/g], ['kn', /[ಀ-೿]/g], ['ml', /[ഀ-ൿ]/g], ['bn', /[ঀ-৿]/g]]

/**
 * Which script MOST of a sentence is written in — a different question from
 * scriptLanguage, which answers "which voice reads this" and so takes the first
 * Indic script it sees. "ఓకే. Then I will go with Supreme variant" is English with a
 * Telugu interjection: the voice needs the Telugu one, but the sentence is English.
 */
export function dominantScript(text) {
  const s = String(text || '')
  let best = 'en'
  let bestN = (s.match(/[A-Za-z]/g) || []).length
  for (const [lang, re] of SCRIPTS) {
    const n = (s.match(re) || []).length
    if (n > bestN) { best = lang; bestN = n }
  }
  return best
}

/** Which language a sentence is written in, from its script. Romanized text reads as English. */
export function scriptLanguage(text) {
  const s = String(text || '')
  if (/[ఀ-౿]/.test(s)) return 'te'
  if (/[ऀ-ॿ]/.test(s)) return 'hi'
  if (/[஀-௿]/.test(s)) return 'ta'
  if (/[ಀ-೿]/.test(s)) return 'kn'
  if (/[ഀ-ൿ]/.test(s)) return 'ml'
  if (/[ঀ-৿]/.test(s)) return 'bn'
  return 'en'
}
