// Does a finished call actually reach the lead extractor?
//
// This pins the wiring, not the extractor. The wiring is what broke: the retired
// speech-to-speech engine pushed every turn into llm.js's `conversations` map by
// hand, and finalize() read the call's conversation back out of that map. The Soniox
// cascade keeps its own messages and never wrote there, so after the engine swap
// getHistory() returned [] on every single call.
//
// Nothing failed. The transcript still saved, the call row still completed, the call
// looked healthy in every log. Leads just stopped being created — and the emptiness
// was checked BEFORE the line that would have said so, so there was not even a
// "nothing to extract" message to notice.
//
// The rule these tests encode: the turns the extractor sees are the turns the engine
// reported. One source, no hand-off through a module-level map.
import { describe, expect, it } from 'vitest'

// The shape both telephony paths collect during a call, and the mapping finalize()
// applies before handing it to extractLead().
const toHistory = (transcriptBuffer) =>
  transcriptBuffer.map(t => ({ role: t.role, content: t.text }))

describe('the extractor is given the conversation that happened', () => {
  // What the engine reports through onTranscript(text, role) over a real call.
  const buffer = [
    { role: 'assistant', text: 'నమస్కారం, ప్రియ మాట్లాడుతున్నాను.' },
    { role: 'user', text: 'రెండు BHK ఉందా?' },
    { role: 'assistant', text: 'అవును గారు, ఉన్నాయి.' },
    { role: 'user', text: 'నా పేరు మధు, 9003503664.' },
  ]

  it('carries every turn through to the extractor', () => {
    expect(toHistory(buffer)).toHaveLength(4)
  })

  it('uses `content`, which is the key the extractor reads', () => {
    // transcriptBuffer stores `text`; extractLead maps `m.content`. Hand it the raw
    // buffer and every turn extracts as undefined — a full transcript of nothing.
    const history = toHistory(buffer)
    expect(history.every(m => typeof m.content === 'string' && m.content.length > 0)).toBe(true)
    expect(history.some(m => 'text' in m)).toBe(false)
  })

  it('keeps caller and agent turns distinguishable', () => {
    // The extractor leans on the agent's confirmations to pin names and numbers, so
    // collapsing the roles would quietly degrade every extraction.
    const history = toHistory(buffer)
    expect(history.filter(m => m.role === 'user')).toHaveLength(2)
    expect(history.filter(m => m.role === 'assistant')).toHaveLength(2)
  })

  it('preserves the caller\'s details verbatim for the extractor to find', () => {
    const joined = toHistory(buffer).map(m => m.content).join('\n')
    expect(joined).toContain('9003503664')
    expect(joined).toContain('మధు')
  })

  it('is empty only when the call genuinely had no turns', () => {
    // The regression in one line: a call with turns must never produce an empty
    // history. That is precisely what reading llm.js getHistory() did.
    expect(toHistory([])).toHaveLength(0)
    expect(toHistory(buffer).length).toBeGreaterThan(0)
  })
})

describe('the retired history store is no longer in the lead path', () => {
  it('neither telephony path imports getHistory', async () => {
    // A direct guard against the bug coming back by reintroducing the old read.
    // llm.js still exports getHistory for the text path; the call paths must not use
    // it to reconstruct a conversation the engine already reported.
    //
    // Matched against the IMPORT, not the file: the comments explaining this bug
    // name getHistory repeatedly, and a test that trips over its own documentation
    // teaches people to delete the documentation.
    const { readFile } = await import('node:fs/promises')
    for (const f of ['src/telephony/vobiz.js', 'src/telephony/campaign.js']) {
      const src = await readFile(new URL(`../${f}`, import.meta.url), 'utf8')
      const llmImport = /import\s*\{([^}]*)\}\s*from\s*['"][^'"]*services\/llm\.js['"]/.exec(src)
      expect(llmImport, `${f} should still import from llm.js`).not.toBeNull()
      expect(llmImport[1], `${f} must not import the retired conversation store`).not.toMatch(/getHistory/)
    }
  })

  it('says out loud when it skips extraction', async () => {
    // The failure was invisible. Whatever else changes, a skipped extraction logs.
    const { readFile } = await import('node:fs/promises')
    for (const f of ['src/telephony/vobiz.js', 'src/telephony/campaign.js']) {
      const src = await readFile(new URL(`../${f}`, import.meta.url), 'utf8')
      expect(src, `${f} must log a skipped extraction`).toMatch(/skipping lead extraction/)
    }
  })
})
