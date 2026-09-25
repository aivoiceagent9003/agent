import { describe, it, expect } from 'vitest'
import { normalizeForTts, createSentenceChunker, scriptLanguage, dominantScript, applyPronunciations } from '../src/services/tts-text.js'

describe('speech-only name pronunciation', () => {
  it('matches whole names longest first without changing other names', () => {
    const names = { 'Acme': 'ac mee', 'Acme Plus': 'ac mee plus', 'A+B': 'ay plus bee' }
    expect(applyPronunciations('Acme Plus, Acme, AcmeLife, A+B', names)).toBe('ac mee plus, ac mee, AcmeLife, ay plus bee')
  })
  it('uses only the pronunciation for the current script and never cascades replacements', () => {
    const names = { Sanjeevani: { te: 'సంజీవని', hi: 'संजीवनी' }, 'సంజీవని': 'wrong' }
    expect(applyPronunciations('Sanjeevani లో', names)).toBe('సంజీవని లో')
    expect(applyPronunciations('Sanjeevani में', names)).toBe('संजीवनी में')
    expect(applyPronunciations('Sanjeevani plan', names)).toBe('Sanjeevani plan')
  })
  it('separates compound brand names and repairs Telugu honorifics', () => {
    expect(normalizeForTts('HealthShield ఉందిandi. Secure ఇంకా Supreme variants ఉన్నాయి.')).toEqual([
      'Health Shield ఉంది అండి', 'Secure ఇంకా Supreme variants ఉన్నాయి',
    ])
  })
})

// Feed a string to the chunker one character at a time, the way a model streams.
function streamThrough(text, opts) {
  const c = createSentenceChunker(opts)
  const out = []
  for (const ch of text) out.push(...c.push(ch))
  out.push(...c.flush())
  return out
}

describe('createSentenceChunker — sentences leave as soon as they are complete', () => {
  it('emits a sentence the moment its full stop is followed by a space', () => {
    const c = createSentenceChunker()
    expect(c.push('సరే అండి.')).toEqual([])          // not yet: the dot could be a decimal
    expect(c.push(' ఇంకా')).toEqual(['సరే అండి.'])  // a space after it makes it a sentence end
    expect(c.flush()).toEqual(['ఇంకా'])
  })

  it('never splits a decimal, a grouped number, or an abbreviation', () => {
    expect(streamThrough('premium Rs. 15,960 అండి. ratio 98.4 percent. approx. 5 lakh cover.'))
      .toEqual(['premium Rs. 15,960 అండి.', 'ratio 98.4 percent.', 'approx. 5 lakh cover.'])
  })

  it('splits on question marks and the Devanagari danda', () => {
    expect(streamThrough('ఇంకా ఏమైనా కావాలా? मैं चेक करता हूँ। ठीक है'))
      .toEqual(['ఇంకా ఏమైనా కావాలా?', 'मैं चेक करता हूँ।', 'ठीक है'])
  })

  it('ends a sentence at a line break, so list items reach the voice one at a time', () => {
    expect(streamThrough('ఫీచర్లు:\n- ఒకటి.\n- రెండు\nమరింత కావాలా?'))
      .toEqual(['ఫీచర్లు:', '- ఒకటి.', '- రెండు', 'మరింత కావాలా?'])
  })

  it('cuts a run-on sentence at a comma once it grows too long', () => {
    const long = 'Vaayu LifeShield has a big cover, flexible payout options and riders, and the premium stays low for young non smokers who start early'
    const parts = streamThrough(long, { maxChars: 60 })
    expect(parts.length).toBeGreaterThan(1)
    expect(parts.join(' ').replace(/\s+/g, ' ')).toBe(long)
  })
})

describe('scriptLanguage', () => {
  it('reads the language from the script, and romanized text as English', () => {
    expect(scriptLanguage('సరే అండి')).toBe('te')
    expect(scriptLanguage('premium 15960 rupees పడుతుంది')).toBe('te')
    expect(scriptLanguage('मैं चेक करता हूँ')).toBe('hi')
    expect(scriptLanguage('Term life kosam chusthunnara')).toBe('en')
  })
})

// Real agent replies from GSK insurance call logs. The failure being prevented:
// a TTS engine reading a Telugu full stop aloud as "chukka".

describe('normalizeForTts — punctuation is never handed to the voice', () => {
  it('splits Telugu sentences and drops the full stops', () => {
    expect(normalizeForTts('సరే అండి. GSK ఇన్సూరెన్స్ కి కాల్ చేసినందుకు థాంక్యూ. బాయ్.'))
      .toEqual(['సరే అండి', 'GSK ఇన్సూరెన్స్ కి కాల్ చేసినందుకు థాంక్యూ', 'బాయ్'])
  })

  it('treats a full stop glued to the next word as a sentence end', () => {
    expect(normalizeForTts('అవునండి.ఇందులో రైడర్స్ కూడా ఉన్నాయి.'))
      .toEqual(['అవునండి', 'ఇందులో రైడర్స్ కూడా ఉన్నాయి'])
  })

  it('handles the Devanagari danda like a full stop', () => {
    expect(normalizeForTts('मैं अभी चेक करता हूँ। एक मिनट।')).toEqual(['मैं अभी चेक करता हूँ', 'एक मिनट'])
  })

  it('keeps a question mark for intonation by default, and can drop it', () => {
    expect(normalizeForTts('ఇంకా ఏమైనా కావాలా?')).toEqual(['ఇంకా ఏమైనా కావాలా?'])
    expect(normalizeForTts('ఇంకా ఏమైనా కావాలా?', { keepQuestionMark: false })).toEqual(['ఇంకా ఏమైనా కావాలా'])
  })
})

describe('normalizeForTts — money, decimals and percentages are spoken, not read', () => {
  it('turns every rupee spelling into spoken English rupees', () => {
    expect(normalizeForTts('premium ₹15,960 పడుతుంది')).toEqual(['premium fifteen thousand nine hundred sixty rupees పడుతుంది'])
    expect(normalizeForTts('Rs.8,400 అండి')).toEqual(['eight thousand four hundred rupees అండి'])
    expect(normalizeForTts('Rs 8,400 అండి')).toEqual(['eight thousand four hundred rupees అండి'])
    expect(normalizeForTts('INR 1,00,000 cover')).toEqual(['one lakh rupees cover'])
  })

  it('never lets a decimal point split a sentence', () => {
    expect(normalizeForTts('claim settlement ratio 98.4% అండి. ఇంకా డౌట్స్ ఉన్నాయా?'))
      .toEqual(['claim settlement ratio ninety eight point four percent అండి', 'ఇంకా డౌట్స్ ఉన్నాయా?'])
  })

  it('drops the dot from abbreviations instead of ending the sentence there', () => {
    expect(normalizeForTts('approx. 15,960 rupees. Dr. Rao will call.'))
      .toEqual(['approx fifteen thousand nine hundred sixty rupees', 'Dr Rao will call'])
  })

  it('puts "rupees" after a crore or lakh, never between the number and its scale', () => {
    // Real call: "₹5 కోట్ల" was spoken as "5 rupees కోట్ల".
    expect(normalizeForTts('₹5 కోట్ల వరకు కవర్')).toEqual(['five crore rupees వరకు కవర్'])
    expect(normalizeForTts('₹2 crore cover')).toEqual(['two crore rupees cover'])
    expect(normalizeForTts('Rs.50 లక్షలు')).toEqual(['fifty lakh rupees'])
    expect(normalizeForTts('₹15,960 పడుతుంది')).toEqual(['fifteen thousand nine hundred sixty rupees పడుతుంది'])
  })

  it('removes Indian digit grouping everywhere', () => {
    expect(normalizeForTts('sum assured 2,00,00,000')).toEqual(['sum assured two crore'])
  })
})

describe('normalizeForTts — figures are spoken in English, never as digits', () => {
  it('says an amount the way a caller says it', () => {
    // A Telugu voice reads bare digits as literary numerals — the "dictionary Telugu"
    // no one speaks. These must reach the voice as English words.
    expect(normalizeForTts('₹15,960 పడుతుంది')).toEqual(['fifteen thousand nine hundred sixty rupees పడుతుంది'])
    expect(normalizeForTts('premium 8400 rupees')).toEqual(['premium eight thousand four hundred rupees'])
  })

  it('says "three point five crore", including when the scale word is in Telugu', () => {
    expect(normalizeForTts('3.5 crore cover')).toEqual(['three point five crore cover'])
    expect(normalizeForTts('₹3.5 కోట్ల వరకు')).toEqual(['three point five crore rupees వరకు'])
    expect(normalizeForTts('50 లక్షల కవర్')).toEqual(['fifty lakh కవర్'])
  })

  it('says a percentage and a year the way people say them', () => {
    expect(normalizeForTts('claim ratio 98.4%')).toEqual(['claim ratio ninety eight point four percent'])
    expect(normalizeForTts('1998 లో స్థాపించబడింది')).toEqual(['nineteen ninety eight లో స్థాపించబడింది'])
    expect(normalizeForTts('2001 లో')).toEqual(['two thousand one లో'])
    expect(normalizeForTts('2025 లో')).toEqual(['twenty twenty five లో'])
  })

  it('preserves every decimal digit, including leading and trailing zeros', () => {
    expect(normalizeForTts('Interest rate 14.07 percent')).toEqual(['Interest rate fourteen point zero seven percent'])
    expect(normalizeForTts('Rate 12.50%.')).toEqual(['Rate twelve point five zero percent'])
    expect(normalizeForTts('₹8400.05')).toEqual(['eight thousand four hundred point zero five rupees'])
  })

  it('keeps conversational grammar and everyday counts in mixed-language replies', () => {
    expect(normalizeForTts('ఈ plan లో రెండు options ఉన్నాయి. Payment చేశారా?')).toEqual([
      'ఈ plan లో రెండు options ఉన్నాయి', 'Payment చేశారా?',
    ])
    expect(normalizeForTts('इस plan में दो options हैं. Payment हो गया?')).toEqual([
      'इस plan में दो options हैं', 'Payment हो गया?',
    ])
  })

  it('converts a figure the model wrote in Telugu words, which is what it actually does', () => {
    // Verbatim from a live call. The amount was right; the register was textbook
    // Telugu that no caller uses out loud.
    const reply = 'ఇరవై ఐదు సంవత్సరాల వయసుకి, రెండు కోట్ల కవర్‌కి వార్షిక ప్రీమియం ఎనిమిది వేల నాలుగు వందల రూపాయలు అవుతుంది.'
    expect(normalizeForTts(reply)).toEqual([
      'twenty five సంవత్సరాల వయసుకి, two crore కవర్‌కి వార్షిక ప్రీమియం eight thousand four hundred rupees అవుతుంది',
    ])
  })

  it('says "three point five crore" when the model wrote it in Telugu', () => {
    expect(normalizeForTts('మూడు పాయింట్ ఐదు కోట్ల కవర్')).toEqual(['three point five crore కవర్'])
    expect(normalizeForTts('ఐదు కోట్ల వరకు')).toEqual(['five crore వరకు'])
  })

  it('rescues a number the model wrote in the wrong alphabet entirely', () => {
    // Verbatim from a live call: asked for "twenty five" in words, the model dropped
    // Malayalam letters into a Telugu sentence and the voice read gibberish.
    expect(normalizeForTts('ഇരുപത്തി അഞ്ച് సంవత్సరాల వయస్సు')).toEqual(['twenty five సంవత్సరాల వయస్సు'])
    // A lone counting word normally stays, but not when it is in an alphabet this
    // sentence is not written in — there it is the model's mistake, not speech.
    expect(normalizeForTts('నా వయసు இருபது సంవత్సరాలు')).toEqual(['నా వయసు twenty సంవత్సరాలు'])
  })

  it('converts the whole premium sentence from that call', () => {
    const reply = 'ఒక కోటి రూపాయల సమ్ అష్యూర్డ్‌కి నాలుగు వేల రెండు వందల రూపాయల వార్షిక ప్రీమియం అవుతుంది.'
    expect(normalizeForTts(reply)).toEqual([
      'one crore rupees సమ్ అష్యూర్డ్‌కి four thousand two hundred rupees వార్షిక ప్రీమియం అవుతుంది',
    ])
    expect(normalizeForTts('ఇరవై ఒకటి వేల రూపాయల ప్రీమియం')).toEqual(['twenty one thousand rupees ప్రీమియం'])
  })

  it('leaves ordinary counting in the caller\'s language — only figures convert', () => {
    // Real call: "పది కంపెనీలు" (ten companies) became "ten కంపెనీస్", which is not
    // how anyone speaks. A figure has a scale word, a currency, or is a compound.
    expect(normalizeForTts('మొత్తం పది కంపెనీస్ ఉన్నాయి')).toEqual(['మొత్తం పది కంపెనీస్ ఉన్నాయి'])
    expect(normalizeForTts('రెండు వేరియంట్స్ ఉన్నాయి')).toEqual(['రెండు వేరియంట్స్ ఉన్నాయి'])
    expect(normalizeForTts('రెండు మూడు రోజులు')).toEqual(['రెండు మూడు రోజులు'])   // not "five"
  })

  it('converts Hindi number words too', () => {
    expect(normalizeForTts('आठ हज़ार चार सौ रुपये लगेंगे')).toEqual(['eight thousand four hundred rupees लगेंगे'])
  })

  it('leaves "ఒక ప్లాన్" alone — that is "a plan", not "one plan"', () => {
    expect(normalizeForTts('ఒక ప్లాన్ ఉంది అండి')).toEqual(['ఒక ప్లాన్ ఉంది అండి'])
  })

  it('reads identifiers and phone numbers digit by digit', () => {
    expect(normalizeForTts('customer ID LN1000077')).toEqual(['customer ID LN one zero zero zero zero seven seven'])
    expect(normalizeForTts('number 919003503664')).toEqual(['number nine one nine zero zero three five zero three six six four'])
  })

  it('leaves a four-digit amount as an amount, not a year', () => {
    expect(normalizeForTts('₹1,950 only')).toEqual(['one thousand nine hundred fifty rupees only'])
  })
})

describe('normalizeForTts — other written-only marks', () => {
  it('turns an ellipsis into a pause, not three dots', () => {
    expect(normalizeForTts('రైడర్స్ ఉన్నాయి... క్రిటికల్ ఇల్నెస్.')).toEqual(['రైడర్స్ ఉన్నాయి, క్రిటికల్ ఇల్నెస్'])
  })

  it('turns a bulleted list into plain spoken sentences', () => {
    // The shape gpt-4o-mini actually produced on a real call.
    const reply = 'ముఖ్యమైన ఫీచర్లు:\n- ఫ్లెక్సిబుల్ పేమెంట్ ఆప్షన్స్: లంప్ సమ్.\n- అదనపు రైడర్స్: క్రిటికల్ ఇల్నెస్.\n\nమీకు మరింత సమాచారం కావాలా?'
    expect(normalizeForTts(reply)).toEqual([
      'ముఖ్యమైన ఫీచర్లు',
      'ఫ్లెక్సిబుల్ పేమెంట్ ఆప్షన్స్, లంప్ సమ్',
      'అదనపు రైడర్స్, క్రిటికల్ ఇల్నెస్',
      'మీకు మరింత సమాచారం కావాలా?',
    ])
    expect(normalizeForTts('1. Secure plan\n2) Supreme plan')).toEqual(['Secure plan', 'Supreme plan'])
  })

  it('strips markdown and brackets the model sometimes emits', () => {
    expect(normalizeForTts('**Vaayu LifeShield** (Supreme) plan')).toEqual(['Vaayu Life Shield Supreme plan'])
  })

  it('never returns empty or punctuation-only chunks', () => {
    expect(normalizeForTts('... . ! ?')).toEqual([])
    expect(normalizeForTts('')).toEqual([])
    expect(normalizeForTts(null)).toEqual([])
  })
})

describe('dominantScript', () => {
  it('calls a sentence English when most of it is English, whatever it opens with', () => {
    // Real transcript: Soniox rendered this correctly, first-script matching did not.
    expect(dominantScript('ఆహ్, ఓకే. Then I will go with Supreme variant then.')).toBe('en')
  })

  it('calls a Telugu sentence Telugu even when it borrows English words', () => {
    expect(dominantScript('HealthShield Secure ప్లాన్ గురించి చెప్పండి అండి, నాకు details కావాలి')).toBe('te')
  })

  it('catches English transliterated into Telugu letters as Telugu script', () => {
    expect(dominantScript('సో, వాట్ ఇస్ ద నీడ్ టు గో ఫర్ ఏ హ్యాండ్ ఆఫ్')).toBe('te')
  })

  it('is not scriptLanguage: the voice still needs the Telugu one for a mixed line', () => {
    const mixed = 'ఓకే. Then I will go with Supreme variant then.'
    expect(dominantScript(mixed)).toBe('en')
    expect(scriptLanguage(mixed)).toBe('te')
  })

  it('treats empty and romanized text as English', () => {
    expect(dominantScript('')).toBe('en')
    expect(dominantScript('term insurance kavali andi')).toBe('en')
  })
})

describe('Telugu number words with grammar glued on', () => {
  const say = (t) => normalizeForTts(t).join(' ')

  it('reads through a case marker instead of stopping the figure short', () => {
    // Real call: came out of the voice as "seven thousand five vandalaku".
    expect(say('ఏడు వేల ఐదు వందలకు పైగా నెట్‌వర్క్ హాస్పిటల్స్'))
      .toBe('seven thousand five hundred కు పైగా నెట్‌వర్క్ హాస్పిటల్స్')
  })

  it('handles the other case markers a figure picks up', () => {
    expect(say('ఇరవై ఐదు వేలలో')).toBe('twenty five thousand లో')
    expect(say('రెండు లక్షల నుంచి')).toBe('two lakh నుంచి')
  })

  it('does not let a case marker glue two separate figures into one', () => {
    expect(say('ఐదు వందలకు ఆరు వందలు')).toBe('five hundred కు six hundred')
  })

  it('reads నూట as the combining hundred', () => {
    expect(say('నూట ఒకటి శాతం')).toBe('one hundred one percent')
  })

  it('takes a doubled hundred as the one figure meant, not a multiplication', () => {
    // Real call: the model wrote "నూట వంద శాతం" and the caller asked "101%?".
    expect(say('నూట వంద శాతం ఎన్‌సీబీ')).toBe('one hundred percent ఎన్‌సీబీ')
  })

  it('leaves the figures it already got right alone', () => {
    expect(say('ఏడు వేల డెబ్బై రూపాయలు')).toBe('seven thousand seventy rupees')
    expect(say('పన్నెండు వేల ఏడు వందల అరవై రూపాయలు')).toBe('twelve thousand seven hundred sixty rupees')
  })

  it('still refuses to convert ordinary counting', () => {
    expect(say('మొత్తం పది కంపెనీలు ఉన్నాయి')).toBe('మొత్తం పది కంపెనీలు ఉన్నాయి')
    expect(say('రెండు వేరియంట్స్ ఉన్నాయి')).toBe('రెండు వేరియంట్స్ ఉన్నాయి')
  })
})

describe('the voice is handed whole sentences', () => {
  const feed = (chunker, text) => {
    const out = []
    for (const ch of text) out.push(...chunker.push(ch))
    return out
  }

  it('never cuts at a comma inside a sentence', () => {
    const c = createSentenceChunker()
    expect(feed(c, 'అవును అండి, మన దగ్గర చాలా options ఉన్నాయి, నిజంగా చాలా మంచివి, ')).toEqual([])
  })

  it('leaves a figure intact rather than cutting inside it', () => {
    // "39,900" holds a comma that is not a clause boundary, and a Telugu number
    // phrase read in halves is read wrong.
    const c = createSentenceChunker()
    expect(feed(c, 'ప్రీమియం 39,900 రూపాయలు అవుతుంది అండి. ')).toEqual(['ప్రీమియం 39,900 రూపాయలు అవుతుంది అండి.'])
  })
})

describe('normalizeForTts — ordinals', () => {
  // A real call said "two nine th August": the digits touching "th" were taken for an
  // identifier and read one at a time.
  it('says a date the way a person does', () => {
    expect(normalizeForTts('29th August, 2001 అంటే').join(' ')).toBe('twenty ninth August, two thousand one అంటే')
  })
  it('handles every ordinal ending', () => {
    const say = (t) => normalizeForTts(t).join(' ')
    expect(['1st', '2nd', '3rd', '4th', '11th', '12th', '21st', '30th', '100th'].map(say)).toEqual([
      'first', 'second', 'third', 'fourth', 'eleventh', 'twelfth', 'twenty first', 'thirtieth', 'one hundredth',
    ])
  })
  it('still reads an identifier a digit at a time', () => {
    expect(normalizeForTts('LN12th').join(' ')).toBe('LN one two th')
  })
})
