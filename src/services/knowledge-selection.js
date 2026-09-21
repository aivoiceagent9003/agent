// Catalogue discovery complements nearest-neighbour retrieval. A single uploaded
// brochure may contain dozens of products, so document diversity is not enough.
// Only explicit named introductions are indexed; never infer names from prose.
export function isOverviewQuery(query, mode) {
  if (mode === 'overview') return true
  return /\b(options?|variants?|alternatives?|recommend\w*|best|compare|comparison|differences?|list|catalogue|catalog|which plans|available plans)\b/i.test(query)
}

const STOP = new Set('a an the for of in on to and or me our your their with what which are is do you have available all any some best plan plans option options variant variants alternative alternatives recommend recommendation recommendations compare comparison difference differences list catalogue catalog details about insurance'.split(' '))
const words = text => String(text).toLowerCase().match(/[a-z0-9]+/g) || []

export function extractCatalogue(contents) {
  const entries = new Map()
  for (const content of contents) {
    for (const match of content.matchAll(/\bIntroduction\s+["“]([^"”\n]{3,160})["”]/gi)) {
      const name = match[1].trim()
      const key = name.toLowerCase()
      if (!entries.has(key)) entries.set(key, { name, content: content.slice(match.index) })
    }
  }
  return [...entries.values()]
}

export function catalogueMatches(entries, query) {
  let terms = [...new Set(words(query).filter(w => !STOP.has(w)))]
  // A variants question can accidentally carry the variant the assistant just
  // recommended. Widen only when the indexed names prove sibling variants exist.
  if (/\bvariants?\b/i.test(query)) {
    const siblingSuffixes = new Set()
    const families = new Map()
    for (const entry of entries) {
      const tokens = words(entry.name)
      const suffix = tokens.pop()
      const family = tokens.join(' ')
      if (!family) continue
      if (!families.has(family)) families.set(family, new Set())
      families.get(family).add(suffix)
    }
    for (const [family, suffixes] of families) {
      if (suffixes.size > 1 && words(family).some(w => terms.includes(w))) {
        for (const suffix of suffixes) siblingSuffixes.add(suffix)
      }
    }
    terms = terms.filter(w => !siblingSuffixes.has(w))
  }
  // Explicit category/name words must be present. Do not turn a term-insurance
  // request into a health catalogue just because both mention insurance.
  return entries.filter(entry => {
    const tokens = new Set(words(entry.content))
    return terms.every(w => tokens.has(w))
  })
}

export function selectDiverseChunks(rows, entries, count = 6) {
  const selected = []
  const usedNames = new Set()
  const usedText = new Set()
  const deferred = []
  for (const row of rows) {
    if (usedText.has(row.content)) continue
    usedText.add(row.content)
    const lower = row.content.toLowerCase()
    const names = entries.filter(e => lower.includes(e.name.toLowerCase())).map(e => e.name)
    if (names.length && names.every(n => usedNames.has(n))) { deferred.push(row); continue }
    selected.push(row)
    names.forEach(n => usedNames.add(n))
    if (selected.length === count) return selected
  }
  return [...selected, ...deferred].slice(0, count)
}

// A comparison needs evidence for siblings, not six nearly identical introductions
// from six companies. Pull one useful, named excerpt for each of a sibling pair
// directly from the indexed corpus, even when one missed the vector shortlist.
export function comparisonAnchors(contents, entries, rankedRows) {
  const lead = rankedRows.flatMap(row => entries.filter(e =>
    row.content.toLowerCase().includes(e.name.toLowerCase()))).find(entry => {
    const family = entry.name.split(/\s+/).slice(0, -1).join(' ').toLowerCase()
    return family && entries.some(other => other !== entry &&
      other.name.split(/\s+/).slice(0, -1).join(' ').toLowerCase() === family)
  })
  if (!lead) return []
  const family = lead.name.split(/\s+/).slice(0, -1).join(' ').toLowerCase()
  const siblings = entries.filter(e => e.name.split(/\s+/).slice(0, -1).join(' ').toLowerCase() === family)
  const informative = content =>
    (/premium chart|pricing|price|cost/i.test(content) ? 4 : 0) +
    (/benefit|payout|cover|feature/i.test(content) ? 2 : 0) +
    (/return|refund|waiver/i.test(content) ? 1 : 0)
  return siblings.slice(0, 2).flatMap(entry => {
    const candidates = contents.filter(content => content.toLowerCase().includes(entry.name.toLowerCase()))
      .sort((a, b) => informative(b) - informative(a))
    return candidates[0] ? [{ content: candidates[0], similarity: 0, catalogueEvidence: true }] : []
  })
}

export function catalogueContext(entries, query, { limit = 40, truncated = false } = {}) {
  const matches = catalogueMatches(entries, query)
  if (!matches.length) return ''
  const names = matches.slice(0, limit).map(e => `- ${e.name}`).join('\n')
  return `CATALOGUE DISCOVERY — named entries matching this request\n${names}\n` +
    `These are product/variant names, not necessarily separate companies. This is an index of explicit named introductions, not proof of a complete catalogue. ` +
    `${truncated || matches.length > limit ? 'The index or displayed list is truncated. ' : ''}` +
    `Do not present the first detail excerpt as the only available plan or the best one. Compare only supported benefits; retrieve missing details before recommending.\n\n`
}
