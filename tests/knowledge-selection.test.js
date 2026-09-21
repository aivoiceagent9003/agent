import { describe, expect, it } from 'vitest'
import { extractCatalogue, catalogueMatches, catalogueContext, selectDiverseChunks, isOverviewQuery, comparisonAnchors } from '../src/services/knowledge-selection.js'

const firms = Array.from({ length: 10 }, (_, i) => `Firm${i}`)
const contents = firms.flatMap(firm => ['Secure', 'Supreme'].map(variant =>
  `Introduction "${firm} LifeShield ${variant}" is a pure-protection term insurance plan. Key features for this variant.`))
contents.push('Introduction "Firm0 HealthShield Secure" is a health insurance plan.')
const entries = extractCatalogue(contents)

describe('catalogue discovery across a combined brochure', () => {
  it('includes sibling benefit and price evidence even if vectors returned only one variant', () => {
    const basic = 'Firm0 LifeShield Secure premium chart: cover 4 crore, premium 18400. No maturity benefit.'
    const plus = 'Firm0 LifeShield Supreme premium chart: cover 4 crore, premium 35600. Return of premiums benefit.'
    const anchors = comparisonAnchors([...contents, basic, plus], entries, [{ content: contents[0], similarity: .8 }])
    expect(anchors.map(r => r.content)).toEqual([basic, plus])
    expect(anchors.every(r => r.catalogueEvidence)).toBe(true)
  })
  it('finds all twenty term entries even when they share one file', () => {
    const found = catalogueMatches(entries, 'term insurance options best plan')
    expect(found).toHaveLength(20)
    expect(found.map(e => e.name)).toContain('Firm9 LifeShield Supreme')
    expect(found.every(e => !e.name.includes('HealthShield'))).toBe(true)
  })
  it('widens a variant-biased query using evidenced sibling names', () => {
    expect(catalogueMatches(entries, 'Firm0 LifeShield Secure variants').map(e => e.name)).toEqual([
      'Firm0 LifeShield Secure', 'Firm0 LifeShield Supreme',
    ])
  })
  it('does not widen a specific detail query or invent an absent sibling', () => {
    expect(catalogueMatches(entries, 'Firm0 LifeShield Secure').map(e => e.name)).toEqual(['Firm0 LifeShield Secure'])
    expect(catalogueMatches(entries, 'Firm0 HealthShield Secure variants').map(e => e.name)).toEqual(['Firm0 HealthShield Secure'])
  })
  it('deduplicates named introductions and does not extract names from slogans', () => {
    expect(extractCatalogue([...contents, contents[0], 'Best Plan. Secure your future.'])).toHaveLength(21)
  })
  it('labels coverage limitations instead of claiming an exhaustive catalogue', () => {
    const result = catalogueContext(entries, 'term insurance options', { limit: 3 })
    expect(result).toContain('list is truncated')
    expect(result).toContain('not proof of a complete catalogue')
    expect(result.match(/^- /gm)).toHaveLength(3)
    expect(catalogueContext(entries, 'motor insurance options')).toBe('')
  })
  it('selects evidence from different named plans before repeats of one plan', () => {
    const rows = [
      { content: 'Firm0 LifeShield Secure benefits', similarity: .8 },
      { content: 'Firm0 LifeShield Secure exclusions', similarity: .79 },
      { content: 'Firm0 LifeShield Supreme benefits', similarity: .7 },
      { content: 'Firm1 LifeShield Secure benefits', similarity: .6 },
    ]
    expect(selectDiverseChunks(rows, entries, 3).map(r => r.content)).toEqual([
      rows[0].content, rows[2].content, rows[3].content,
    ])
  })
  it('detects legacy broad queries even when the model omits the mode', () => {
    expect(isOverviewQuery('term insurance options best plan')).toBe(true)
    expect(isOverviewQuery('LifeShield Secure variants')).toBe(true)
    expect(isOverviewQuery('term insurance', 'overview')).toBe(true)
    expect(isOverviewQuery('Firm0 LifeShield Secure premium')).toBe(false)
  })
})
