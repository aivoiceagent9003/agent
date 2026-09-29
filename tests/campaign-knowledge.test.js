import { beforeEach, describe, expect, it, vi } from 'vitest'

// When a campaign that talked from its own files is finished, its owner is asked
// whether to add them to the knowledge base. Adding must carry the files over exactly
// as the campaign used them — same text, same embeddings — without paying to extract
// and embed them a second time; and it must not happen for a "keep" answer.
const state = vi.hoisted(() => ({ tables: {}, seq: 0, copies: [] }))

// An in-memory stand-in for the supabase-js query builder: enough of select / insert /
// update / delete with eq / is / in filters to run the real service code against.
vi.mock('../src/api/db.js', () => {
  function from(table) {
    const conds = []
    let op = 'select', payload = null, single = false
    const q = {
      select() { return q },
      insert(rows) { op = 'insert'; payload = rows; return q },
      update(patch) { op = 'update'; payload = patch; return q },
      delete() { op = 'delete'; return q },
      eq(c, v) { conds.push(r => r[c] === v); return q },
      is(c, v) { conds.push(r => (r[c] ?? null) === v); return q },
      in(c, vs) { conds.push(r => vs.includes(r[c])); return q },
      order() { return q }, range() { return q }, limit() { return q },
      single() { single = true; return q }, maybeSingle() { single = true; return q },
      then(resolve, reject) { return Promise.resolve(run()).then(resolve, reject) },
    }
    function run() {
      const t = (state.tables[table] ||= [])
      const match = r => conds.every(f => f(r))
      if (op === 'insert') {
        const rows = (Array.isArray(payload) ? payload : [payload]).map(r => ({ id: `${table}-${++state.seq}`, ...r }))
        t.push(...rows)
        return { data: single ? rows[0] : rows, error: null }
      }
      if (op === 'update') {
        const rows = t.filter(match)
        rows.forEach(r => Object.assign(r, payload))
        return { data: single ? rows[0] : rows, error: null }
      }
      if (op === 'delete') {
        state.tables[table] = t.filter(r => !match(r))
        return { data: null, error: null }
      }
      const rows = t.filter(match)
      return { data: single ? (rows[0] ?? null) : rows, count: rows.length, error: null }
    }
    return q
  }
  const storage = { from: () => ({
    copy: async (a, b) => { state.copies.push([a, b]); return { error: null } },
    upload: async () => ({ error: null }), remove: async () => ({}),
  }) }
  return { supabase: { from, storage }, supabaseAdmin: null }
})
const ingest = vi.hoisted(() => ({ embedChunks: vi.fn(), extractKeyterms: vi.fn(async () => []), mergeKeyterms: vi.fn(async () => {}) }))
vi.mock('../src/ingest.js', () => ingest)
const rag = vi.hoisted(() => ({ invalidateKnowledge: vi.fn() }))
vi.mock('../src/services/rag.js', () => rag)
const notifications = vi.hoisted(() => ({ notify: vi.fn(async () => []) }))
vi.mock('../src/services/notifications.js', () => notifications)

const kb = await import('../src/services/campaigns/knowledge.js')

beforeEach(() => {
  vi.clearAllMocks()
  state.seq = 0
  state.copies = []
  state.tables = {
    campaign_documents: [
      { id: 'cd1', tenant_id: 't1', campaign_id: 'c1', filename: 'skyline.pdf', mime_type: 'application/pdf',
        size_bytes: 1000, char_count: 900, storage_path: 't1/campaigns/c1/cd1__skyline.pdf',
        keyterms: ['Skyline Towers'], status: 'ready', kb_decision: null },
      // Not ready: it never worked, so there is nothing to offer.
      { id: 'cd2', tenant_id: 't1', campaign_id: 'c1', filename: 'broken.pdf', status: 'error', kb_decision: null },
    ],
    campaign_knowledge: [
      // pgvector columns come back from PostgREST as strings.
      { id: 'ck1', campaign_id: 'c1', document_id: 'cd1', content: 'Skyline Towers: 3BHK from 1.2 crore.', embedding: '[0.1,0.2]' },
      { id: 'ck2', campaign_id: 'c1', document_id: 'cd1', content: 'Possession in March 2028.', embedding: '[0.3,0.4]' },
    ],
    documents: [],
    knowledge_base: [],
    profiles: [
      { id: 'owner1', tenant_id: 't1', tenant_role: 'owner', status: 'active' },
      { id: 'agent1', tenant_id: 't1', tenant_role: 'agent', status: 'active' },
      { id: 'owner-other', tenant_id: 't2', tenant_role: 'owner', status: 'active' },
    ],
  }
})

describe('adding a finished campaign\'s files to the knowledge base', () => {
  it('copies every chunk with its embedding under a new knowledge-base document', async () => {
    const r = await kb.decideCampaignKnowledge('t1', 'c1', true)
    expect(r).toEqual({ added: 1, kept: 0 })

    const [doc] = state.tables.documents
    expect(doc).toMatchObject({ tenant_id: 't1', filename: 'skyline.pdf', status: 'ready', chunk_count: 2 })
    expect(state.tables.knowledge_base).toEqual([
      expect.objectContaining({ tenant_id: 't1', document_id: doc.id, content: 'Skyline Towers: 3BHK from 1.2 crore.', embedding: [0.1, 0.2] }),
      expect.objectContaining({ tenant_id: 't1', document_id: doc.id, content: 'Possession in March 2028.', embedding: [0.3, 0.4] }),
    ])
  })

  it('does not extract or embed anything again', async () => {
    await kb.decideCampaignKnowledge('t1', 'c1', true)
    expect(ingest.embedChunks).not.toHaveBeenCalled()
  })

  it('makes the next call see it, and teaches recognition its names', async () => {
    await kb.decideCampaignKnowledge('t1', 'c1', true)
    expect(rag.invalidateKnowledge).toHaveBeenCalledWith('t1')
    expect(ingest.mergeKeyterms).toHaveBeenCalledWith('t1', ['Skyline Towers'])
  })

  it('gives the knowledge base its own copy of the original file', async () => {
    // Deleting the file from either place must not break the other.
    await kb.decideCampaignKnowledge('t1', 'c1', true)
    const [doc] = state.tables.documents
    expect(state.copies).toEqual([['t1/campaigns/c1/cd1__skyline.pdf', `t1/${doc.id}__skyline.pdf`]])
    expect(doc.storage_path).toBe(`t1/${doc.id}__skyline.pdf`)
  })

  it('records the answer so the owner is not asked again', async () => {
    await kb.decideCampaignKnowledge('t1', 'c1', true)
    expect(state.tables.campaign_documents.find(d => d.id === 'cd1')).toMatchObject({ kb_decision: 'added' })
    expect(await kb.pendingKnowledgeOffer('c1')).toEqual([])
    expect(await kb.decideCampaignKnowledge('t1', 'c1', true)).toEqual({ added: 0, kept: 0 })
    expect(state.tables.documents).toHaveLength(1)
  })

  it('leaves the campaign its own copy', async () => {
    await kb.decideCampaignKnowledge('t1', 'c1', true)
    expect(state.tables.campaign_knowledge).toHaveLength(2)
  })
})

describe('keeping the files in the campaign only', () => {
  it('adds nothing to the knowledge base and stops asking', async () => {
    expect(await kb.decideCampaignKnowledge('t1', 'c1', false)).toEqual({ added: 0, kept: 1 })
    expect(state.tables.documents).toEqual([])
    expect(state.tables.knowledge_base).toEqual([])
    expect(rag.invalidateKnowledge).not.toHaveBeenCalled()
    expect(await kb.pendingKnowledgeOffer('c1')).toEqual([])
  })
})

describe('asking the owner when the campaign finishes', () => {
  const finished = { id: 'c1', tenant_id: 't1', name: 'Skyline launch', created_by: 'manager1', config: { kb_source: 'campaign' } }

  it("notifies the business's owners and whoever created the campaign", async () => {
    await kb.offerCampaignKnowledge(finished)
    expect(notifications.notify).toHaveBeenCalledTimes(1)
    const [ids, body] = notifications.notify.mock.calls[0]
    expect(ids).toEqual(expect.arrayContaining(['owner1', 'manager1']))
    expect(ids).not.toContain('agent1')
    expect(ids).not.toContain('owner-other')
    expect(body).toMatchObject({ tenantId: 't1', link: '/campaigns/c1' })
    expect(body.body).toContain('skyline.pdf')
  })

  it('stays quiet for a campaign that talked from the knowledge base', async () => {
    await kb.offerCampaignKnowledge({ ...finished, config: { kb_source: 'existing' } })
    expect(notifications.notify).not.toHaveBeenCalled()
  })

  it('stays quiet once the owner has answered', async () => {
    await kb.decideCampaignKnowledge('t1', 'c1', false)
    await kb.offerCampaignKnowledge(finished)
    expect(notifications.notify).not.toHaveBeenCalled()
  })
})
