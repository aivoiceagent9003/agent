// Editing the data the agent reads out on a call.
//
// A dataset is not a document — it is the customer's live position. Balances move,
// numbers get typed wrong, accounts open. Until now the only way to change any of
// it was to upload a replacement sheet, which deletes every row first: correcting
// one cell meant exporting thousands of rows and losing anything added since.
//
// The failure these tests exist to prevent is quieter than a crash. A row whose
// search_text disagrees with its contents is stored, visible in the editor, and
// completely invisible to the live call — the caller is told they do not exist.
// So every write path is checked by looking the row up the way a call does.

import { describe, it, expect, beforeEach, vi } from 'vitest'

const TENANT = 'tenant-a'
const OTHER = 'tenant-b'

// ─── An in-memory stand-in for the table ─────────────────────────────────────
// Real enough to be worth asserting against: it honours tenant_id and dataset
// filters, ILIKE substring semantics including escaped wildcards, ordering, and —
// the one that matters most here — PostgREST's ceiling on how many rows a select
// will ever return.
let store = []
let nextId = 1

// Supabase stops sending at 1000 rows. Any code that counts rows client-side is
// therefore silently wrong above that, and reported 1000 for a sheet of 100,000.
// The mock enforces it so that bug fails a test instead of reaching a dashboard.
const PGREST_MAX_ROWS = 1000

function matchIlike(value, pattern) {
  // The service wraps the needle in % and escapes any % or _ the user typed, so
  // a search for "50%" looks for that literal string rather than everything.
  const inner = String(pattern).replace(/^%/, '').replace(/%$/, '')
  const literal = inner.replace(/\\([%_])/g, '$1')
  if (/(^|[^\\])[%_]/.test(inner)) throw new Error('unescaped wildcard reached the database')
  return String(value).toLowerCase().includes(literal.toLowerCase())
}

function builder(op, payload) {
  const s = {
    op, payload, filters: [], gts: [], ilike: null,
    range: null, limitN: null, sort: null, single: false, count: false,
  }

  async function run() {
    let rows = store.filter(r => s.filters.every(([col, val]) => r[col] === val))
    for (const [col, val] of s.gts) rows = rows.filter(r => r[col] > val)
    if (s.ilike) rows = rows.filter(r => matchIlike(r[s.ilike[0]], s.ilike[1]))
    if (s.sort) {
      const [col, asc] = s.sort
      rows = [...rows].sort((a, b) => (a[col] > b[col] ? 1 : a[col] < b[col] ? -1 : 0) * (asc ? 1 : -1))
    }

    if (s.op === 'select') {
      // head: true — the server counts and sends nothing. No ceiling applies.
      if (s.count) return { data: null, count: rows.length, error: null }
      let page = rows
      if (s.range) page = rows.slice(s.range[0], s.range[1] + 1)
      if (s.limitN != null) page = page.slice(0, s.limitN)
      // An unbounded read is truncated, exactly as PostgREST truncates it.
      page = page.slice(0, PGREST_MAX_ROWS)
      return { data: page.map(r => ({ ...r })), count: rows.length, error: null }
    }
    if (s.op === 'insert') {
      // Bulk ingest passes an array of rows; a hand-added row passes one object.
      const incoming = Array.isArray(s.payload) ? s.payload : [s.payload]
      const created = incoming.map(p => ({ id: `row-${nextId++}`, created_at: nextId, ...p }))
      store.push(...created)
      return s.single
        ? { data: { ...created[0] }, error: null }
        : { data: created.map(r => ({ ...r })), error: null }
    }
    if (s.op === 'update') {
      for (const r of rows) Object.assign(r, s.payload)
      return { data: rows.map(r => ({ ...r })), error: null }
    }
    if (s.op === 'delete') {
      store = store.filter(r => !rows.includes(r))
      return { data: rows.map(r => ({ ...r })), error: null }
    }
    return { data: [], error: null }
  }

  // Every method returns the builder, which is itself thenable — so `await
  // …limit(1)` resolves, and `.gt()` can still be chained after it, exactly as
  // the real client allows.
  const b = {
    select: (_cols, opts) => { if (opts?.count) s.count = true; return b },
    eq: (col, val) => { s.filters.push([col, val]); return b },
    gt: (col, val) => { s.gts.push([col, val]); return b },
    ilike: (col, pattern) => { s.ilike = [col, pattern]; return b },
    order: (col, opts) => { s.sort = [col, opts?.ascending !== false]; return b },
    range: (from, to) => { s.range = [from, to]; return b },
    limit: (n) => { s.limitN = n; return b },
    single: () => { s.single = true; return b },
    then: (resolve, reject) => run().then(resolve, reject),
  }
  return b
}

vi.mock('../src/api/db.js', () => ({
  supabase: {
    from: () => ({
      select: (cols, opts) => builder('select').select(cols, opts),
      insert: (payload) => builder('insert', payload),
      update: (payload) => builder('update', payload),
      delete: () => builder('delete'),
    }),
  },
}))

const {
  listDatasetRows, createDatasetRow, updateDatasetRow, deleteDatasetRow,
  normalizeRow, datasetColumns, searchTextFor, ingestDataset, runLookup,
  listDatasets, parseSheetFile,
} = await import('../src/services/lookups.js')

const SHEET = [
  { 'Customer ID': 'LN100077', 'Customer Name': 'Ajay Acharya', 'Phone Number': '+91 7185188888', 'Outstanding': '₹1,143,927' },
  { 'Customer ID': 'LN100078', 'Customer Name': 'Rekha Rao', 'Phone Number': '+91 9603859770', 'Outstanding': '₹251,428' },
  { 'Customer ID': 'LN100079', 'Customer Name': 'Imran Qureshi', 'Phone Number': '+91 8332181960', 'Outstanding': '₹98,000' },
]

beforeEach(async () => {
  store = []
  nextId = 1
  await ingestDataset(TENANT, 'loans', SHEET, { replace: false })
  await ingestDataset(OTHER, 'loans', [{ 'Customer ID': 'ZZ1', 'Customer Name': 'Someone Else' }], { replace: false })
})

// The tenant config a live call would use, so a hand-edited row can be looked up
// exactly the way the agent looks it up.
const cfg = {
  tenant_id: TENANT,
  verify_caller_identity: false,
  lookups: [{
    name: 'loan_status',
    parameters: [{ name: 'customer_id' }, { name: 'phone_number' }],
    backend: { type: 'table', dataset: 'loans' },
  }],
}

/** Look the value up the way a call would. @returns the row, or null on a miss. */
async function asAgentWouldFind(args) {
  const out = await runLookup(cfg, 'loan_status', args, { state: { rows: new Map() } })
  return /^No matching record/.test(out) ? null : JSON.parse(out)
}

describe('reading a dataset', () => {
  it('returns the rows with their ids, so a single one can be addressed', async () => {
    const { rows, total } = await listDatasetRows(TENANT, 'loans')
    expect(total).toBe(3)
    expect(rows.every(r => typeof r.id === 'string' && r.id)).toBe(true)
    expect(rows.map(r => r.row['Customer Name'])).toContain('Rekha Rao')
  })

  it('never returns another business’s rows', async () => {
    const { rows, total } = await listDatasetRows(TENANT, 'loans')
    expect(total).toBe(3)
    expect(JSON.stringify(rows)).not.toContain('Someone Else')
  })

  it('searches the same text the live call searches', async () => {
    // The point of the search box: when a client says "it couldn't find my
    // customer", this is where they reproduce it.
    const { rows, total } = await listDatasetRows(TENANT, 'loans', { q: 'Rekha' })
    expect(total).toBe(1)
    expect(rows[0].row['Customer ID']).toBe('LN100078')
  })

  it('treats a typed % as a character, not a wildcard', async () => {
    // Unescaped, "%" matches every row and the client is told their whole sheet
    // contains something it does not.
    const { total } = await listDatasetRows(TENANT, 'loans', { q: '%' })
    expect(total).toBe(0)
  })

  it('pages without lying about the total', async () => {
    const first = await listDatasetRows(TENANT, 'loans', { limit: 2, offset: 0 })
    const second = await listDatasetRows(TENANT, 'loans', { limit: 2, offset: 2 })
    expect(first.rows).toHaveLength(2)
    expect(second.rows).toHaveLength(1)
    expect(first.total).toBe(3)      // the count is of the dataset, not the page
    expect(second.total).toBe(3)
  })

  it('reports columns from the whole sheet, not just the page on screen', async () => {
    // Otherwise the editor's columns would shift as you paged or searched, and a
    // column absent from page one could never be filled in.
    const { columns } = await listDatasetRows(TENANT, 'loans', { limit: 1 })
    expect(columns).toEqual(['Customer ID', 'Customer Name', 'Phone Number', 'Outstanding'])
  })

  it('includes a column that only one row has', async () => {
    await createDatasetRow(TENANT, 'loans', { 'Customer ID': 'LN100080', 'Branch': 'Kukatpally' })
    const { columns } = await listDatasetRows(TENANT, 'loans')
    expect(columns).toContain('Branch')
  })
})

describe('adding a row by hand', () => {
  it('makes it findable on a call', async () => {
    // The whole feature in one assertion. A row that exists but cannot be found is
    // worse than no row: the caller is told they do not exist.
    await createDatasetRow(TENANT, 'loans', {
      'Customer ID': 'LN100081', 'Customer Name': 'Priya Nair', 'Phone Number': '+91 9876500011',
    })
    expect((await asAgentWouldFind({ customer_id: 'LN100081' }))?.['Customer Name']).toBe('Priya Nair')
    expect((await asAgentWouldFind({ phone_number: '9876500011' }))?.['Customer Name']).toBe('Priya Nair')
  })

  it('stores strings, so a hand-typed row matches like an uploaded one', async () => {
    const { row } = await createDatasetRow(TENANT, 'loans', { 'Customer ID': 12345, 'Active': true })
    expect(row).toEqual({ 'Customer ID': '12345', 'Active': 'true' })
  })

  it('trims what was typed', async () => {
    const { row } = await createDatasetRow(TENANT, 'loans', { 'Customer ID': '  LN100082  ' })
    expect(row['Customer ID']).toBe('LN100082')
    expect((await asAgentWouldFind({ customer_id: 'LN100082' }))).toBeTruthy()
  })

  it('returns the new id so the editor can edit it straight away', async () => {
    const created = await createDatasetRow(TENANT, 'loans', { 'Customer ID': 'LN100083' })
    expect(created.id).toBeTruthy()
    const found = (await listDatasetRows(TENANT, 'loans')).rows.find(r => r.id === created.id)
    expect(found?.row['Customer ID']).toBe('LN100083')
  })
})

describe('correcting a row', () => {
  it('makes it findable by the new value and not the old one', async () => {
    // This is the bug the feature exists to fix and the one it could most easily
    // introduce: update the row and forget search_text, and the agent keeps
    // finding the record by the wrong number forever.
    const { rows } = await listDatasetRows(TENANT, 'loans', { q: 'LN100077' })
    await updateDatasetRow(TENANT, 'loans', rows[0].id, {
      ...rows[0].row, 'Phone Number': '+91 7000000001',
    })
    expect((await asAgentWouldFind({ phone_number: '7000000001' }))?.['Customer Name']).toBe('Ajay Acharya')
    expect(await asAgentWouldFind({ phone_number: '7185188888' })).toBeNull()
  })

  it('replaces rather than merges, so a column can be removed', async () => {
    const { rows } = await listDatasetRows(TENANT, 'loans', { q: 'Imran' })
    const updated = await updateDatasetRow(TENANT, 'loans', rows[0].id, {
      'Customer ID': 'LN100079', 'Customer Name': 'Imran Qureshi',
    })
    expect(updated.row).not.toHaveProperty('Outstanding')
  })

  it('refuses a row belonging to another business', async () => {
    const theirs = store.find(r => r.tenant_id === OTHER)
    expect(await updateDatasetRow(TENANT, 'loans', theirs.id, { 'Customer ID': 'HACKED' })).toBeNull()
    expect(store.find(r => r.id === theirs.id).row['Customer ID']).toBe('ZZ1')
  })

  it('refuses a row id from a different sheet', async () => {
    await ingestDataset(TENANT, 'orders', [{ 'Order ID': 'ORD1' }], { replace: false })
    const order = store.find(r => r.dataset === 'orders')
    expect(await updateDatasetRow(TENANT, 'loans', order.id, { 'Order ID': 'ORD9' })).toBeNull()
  })

  it('reports a row that has since been deleted rather than silently doing nothing', async () => {
    expect(await updateDatasetRow(TENANT, 'loans', 'row-does-not-exist', { a: 'b' })).toBeNull()
  })
})

describe('deleting a row', () => {
  it('removes it from the sheet and from what a call can find', async () => {
    const { rows } = await listDatasetRows(TENANT, 'loans', { q: 'Rekha' })
    expect(await deleteDatasetRow(TENANT, 'loans', rows[0].id)).toBe(true)
    expect((await listDatasetRows(TENANT, 'loans')).total).toBe(2)
    expect(await asAgentWouldFind({ customer_id: 'LN100078' })).toBeNull()
  })

  it('leaves the other rows alone', async () => {
    const { rows } = await listDatasetRows(TENANT, 'loans', { q: 'Rekha' })
    await deleteDatasetRow(TENANT, 'loans', rows[0].id)
    expect(await asAgentWouldFind({ customer_id: 'LN100077' })).toBeTruthy()
  })

  it('refuses a row belonging to another business', async () => {
    const theirs = store.find(r => r.tenant_id === OTHER)
    expect(await deleteDatasetRow(TENANT, 'loans', theirs.id)).toBe(false)
    expect(store.some(r => r.id === theirs.id)).toBe(true)
  })
})

describe('appending a sheet instead of replacing it', () => {
  it('keeps what is already there', async () => {
    // Replace is right for a fresh export and wrong for "here are this week's new
    // accounts" — which, before this, silently deleted everything else.
    await ingestDataset(TENANT, 'loans', [{ 'Customer ID': 'LN100090', 'Customer Name': 'New Account' }], { replace: false })
    expect((await listDatasetRows(TENANT, 'loans')).total).toBe(4)
    expect(await asAgentWouldFind({ customer_id: 'LN100077' })).toBeTruthy()
  })

  it('still replaces when asked to', async () => {
    await ingestDataset(TENANT, 'loans', [{ 'Customer ID': 'LN100090' }], { replace: true })
    expect((await listDatasetRows(TENANT, 'loans')).total).toBe(1)
  })
})

describe('what a row is allowed to contain', () => {
  it('refuses a list or a nested object', () => {
    // search_text would render these "[object Object]": the row would be stored,
    // shown in the editor, and unfindable on every call.
    expect(() => normalizeRow({ tags: ['a', 'b'] })).toThrow(/single value/)
    expect(() => normalizeRow({ meta: { a: 1 } })).toThrow(/single value/)
  })

  it('refuses a row with nothing in it', () => {
    expect(() => normalizeRow({})).toThrow(/at least one column/)
    expect(() => normalizeRow({ 'Customer ID': '  ' })).toThrow(/entirely empty/)
  })

  it('refuses something that is not a row at all', () => {
    expect(() => normalizeRow(null)).toThrow(/object of column names/)
    expect(() => normalizeRow([1, 2])).toThrow(/object of column names/)
  })

  it('drops an unnamed column instead of storing a blank key', () => {
    expect(normalizeRow({ '': 'orphan', 'Customer ID': 'LN1' })).toEqual({ 'Customer ID': 'LN1' })
  })

  it('caps how much one cell can hold', () => {
    expect(() => normalizeRow({ notes: 'x'.repeat(2001) })).toThrow(/too long/)
  })

  it('caps how many columns a row can have', () => {
    const wide = Object.fromEntries(Array.from({ length: 61 }, (_, i) => [`c${i}`, 'v']))
    expect(() => normalizeRow(wide)).toThrow(/at most 60 columns/)
  })

  it('turns an empty value into an empty string, not the word null', () => {
    // "null" in a cell is what the caller would hear read back to them.
    expect(normalizeRow({ 'Customer ID': 'LN1', 'Co-applicant': null })).toEqual({
      'Customer ID': 'LN1', 'Co-applicant': '',
    })
  })

  it('marks a client mistake so the API can answer 400 without leaking a DB error', () => {
    try {
      normalizeRow({})
      throw new Error('should have thrown')
    } catch (e) {
      expect(e.invalid).toBe(true)
    }
  })
})

describe('search_text, derived in exactly one place', () => {
  it('flattens every value of the row', () => {
    expect(searchTextFor({ a: 'LN100077', b: 'Ajay' })).toBe('ln100077 ajay')
  })

  it('is what a bulk upload and a hand-added row both get', async () => {
    await createDatasetRow(TENANT, 'loans', { 'Customer ID': 'LN100084', 'Customer Name': 'Test' })
    const added = store.find(r => r.row?.['Customer ID'] === 'LN100084')
    expect(added.search_text).toBe(searchTextFor(added.row))
    const uploaded = store.find(r => r.row?.['Customer ID'] === 'LN100077')
    expect(uploaded.search_text).toBe(searchTextFor(uploaded.row))
  })
})

describe('datasetColumns', () => {
  it('keeps the sheet’s own column order', () => {
    expect(datasetColumns([{ row: { b: 1, a: 2, c: 3 } }])).toEqual(['b', 'a', 'c'])
  })

  it('unions across rows without repeating', () => {
    expect(datasetColumns([{ row: { a: 1, b: 2 } }, { row: { b: 3, c: 4 } }])).toEqual(['a', 'b', 'c'])
  })

  it('survives an empty dataset', () => {
    expect(datasetColumns([])).toEqual([])
    expect(datasetColumns()).toEqual([])
  })
})

describe('reading an uploaded file', () => {
  // The type check on the upload route accepts .xlsx, but the only parser was the
  // CSV one, so an Excel file was decoded as UTF-8 text and fed to it. A zip
  // container does not fail that — it parses. This is what that produced, and
  // because upload replaces, it took the place of the client's real data.
  const excelBuffer = async (rows) => {
    const XLSX = (await import('xlsx')).default || (await import('xlsx'))
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Sheet1')
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
  }

  it('reads an Excel file as the rows it actually contains', async () => {
    const buf = await excelBuffer([
      { 'Customer ID': 'LN100077', 'Customer Name': 'Ajay Acharya', 'Phone Number': '+91 7185188888' },
      { 'Customer ID': 'LN100078', 'Customer Name': 'Rekha Rao', 'Phone Number': '+91 9603859770' },
    ])
    const rows = await parseSheetFile(buf, 'loans.xlsx', '')
    expect(rows).toHaveLength(2)
    expect(rows[0]['Customer Name']).toBe('Ajay Acharya')
    expect(Object.keys(rows[0])).toEqual(['Customer ID', 'Customer Name', 'Phone Number'])
  })

  it('does not mistake the zip container for column names', async () => {
    const buf = await excelBuffer([{ 'Customer ID': 'LN100077' }])
    const rows = await parseSheetFile(buf, 'loans.xlsx', '')
    expect(JSON.stringify(rows)).not.toMatch(/PK|workbook\.xml|_rels/)
  })

  it('recognises Excel by mime type when the name has no extension', async () => {
    const buf = await excelBuffer([{ 'Customer ID': 'LN100077' }])
    const mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    expect(await parseSheetFile(buf, 'upload', mime)).toHaveLength(1)
  })

  it('stores Excel numbers as the strings matching compares', async () => {
    // A value stored as the number 96212 by one client and "96,212" by the next is
    // a lookup that works for one of them.
    const buf = await excelBuffer([{ 'Customer ID': 100077, 'EMI': 96212 }])
    const rows = await parseSheetFile(buf, 'loans.xlsx', '')
    expect(rows[0]).toEqual({ 'Customer ID': '100077', 'EMI': '96212' })
  })

  it('still reads a plain CSV', async () => {
    const csv = 'Customer ID,Customer Name\nLN100077,Ajay Acharya\n'
    const rows = await parseSheetFile(Buffer.from(csv, 'utf8'), 'loans.csv', 'text/csv')
    expect(rows).toEqual([{ 'Customer ID': 'LN100077', 'Customer Name': 'Ajay Acharya' }])
  })

  it('makes an Excel row findable on a call once ingested', async () => {
    const buf = await excelBuffer([{ 'Customer ID': 'LN100099', 'Customer Name': 'Excel Person' }])
    await ingestDataset(TENANT, 'loans', await parseSheetFile(buf, 'loans.xlsx', ''), { replace: false })
    expect((await asAgentWouldFind({ customer_id: 'LN100099' }))?.['Customer Name']).toBe('Excel Person')
  })
})

describe('the list of sheets', () => {
  it('reports each sheet once, with its row count', async () => {
    const sheets = await listDatasets(TENANT)
    expect(sheets).toHaveLength(1)
    expect(sheets[0]).toMatchObject({ dataset: 'loans', rows: 3 })
  })

  it('reports when the sheet was last uploaded', async () => {
    const [sheet] = await listDatasets(TENANT)
    expect(sheet.updated_at).toBeTruthy()
  })

  it('does not read the row contents to build the list', async () => {
    // A tenant with a hundred thousand rows would otherwise pull their whole
    // dataset into memory to render a list of two names.
    const [sheet] = await listDatasets(TENANT)
    expect(sheet).not.toHaveProperty('row')
    expect(sheet).not.toHaveProperty('columns')
  })

  it('separates sheets rather than pooling them', async () => {
    await ingestDataset(TENANT, 'orders', [{ 'Order ID': 'ORD1' }], { replace: false })
    const sheets = await listDatasets(TENANT)
    expect(sheets.map(s => s.dataset).sort()).toEqual(['loans', 'orders'])
    expect(sheets.find(s => s.dataset === 'orders').rows).toBe(1)
  })

  it('never counts another business’s rows', async () => {
    const sheets = await listDatasets(TENANT)
    expect(sheets.reduce((n, s) => n + s.rows, 0)).toBe(3)
  })

  it('is empty for a tenant with nothing uploaded', async () => {
    expect(await listDatasets('tenant-with-nothing')).toEqual([])
  })
})

describe('a sheet bigger than the database will hand back at once', () => {
  // Reported from production: 100,000 rows uploaded, Supabase confirmed holding
  // them, and the dashboard said 1,000. That is exactly where PostgREST stops
  // sending, and the count was being computed by counting the rows it sent.
  const bulk = (dataset, n, prefix) =>
    ingestDataset(TENANT, dataset, Array.from({ length: n }, (_, i) => ({
      'Customer ID': `${prefix}${String(i).padStart(6, '0')}`,
      'Customer Name': `Person ${i}`,
    })), { replace: true })

  it('counts every row, not just the first thousand', async () => {
    await bulk('big', 2500, 'BIG')
    const sheet = (await listDatasets(TENANT)).find(s => s.dataset === 'big')
    expect(sheet.rows).toBe(2500)
  })

  it('is exact right at the boundary', async () => {
    await bulk('big', 1001, 'BIG')
    const sheet = (await listDatasets(TENANT)).find(s => s.dataset === 'big')
    expect(sheet.rows).toBe(1001)
  })

  it('does not hide a small sheet behind a large one', async () => {
    // The worse half of the same bug. Reducing over the first 1000 rows returned,
    // all of which belong to the big sheet, drops the small one from the client's
    // dashboard entirely — it looks deleted.
    await bulk('aaa_big', 2000, 'BIG')
    await ingestDataset(TENANT, 'zzz_small', [{ 'Customer ID': 'SMALL1' }], { replace: true })
    const names = (await listDatasets(TENANT)).map(s => s.dataset)
    expect(names).toContain('zzz_small')
    expect(names).toContain('aaa_big')
  })

  it('finds every sheet regardless of where its name sorts', async () => {
    for (const name of ['m_mid', 'a_first', 'z_last']) {
      await ingestDataset(TENANT, name, [{ 'Customer ID': name }], { replace: true })
    }
    const names = (await listDatasets(TENANT)).map(s => s.dataset)
    for (const name of ['a_first', 'm_mid', 'z_last']) expect(names).toContain(name)
  })

  it('never pulls the rows themselves in to build the list', async () => {
    // The count must come from the database. If a sheet's rows are being read to
    // produce it, a large tenant pays for their whole dataset on every page load.
    await bulk('big', 3000, 'BIG')
    const sheets = await listDatasets(TENANT)
    for (const s of sheets) expect(s).not.toHaveProperty('row')
  })

  it('still reports when a large sheet was last uploaded', async () => {
    await bulk('big', 1500, 'BIG')
    const sheet = (await listDatasets(TENANT)).find(s => s.dataset === 'big')
    expect(sheet.updated_at).toBeTruthy()
  })

  it('reports the paged row list’s total from the database too', async () => {
    await bulk('big', 1800, 'BIG')
    const { rows, total } = await listDatasetRows(TENANT, 'big', { limit: 25 })
    expect(rows).toHaveLength(25)
    expect(total).toBe(1800)
  })
})

describe('the stand-in itself', () => {
  // Guards the tests above. If this mock ever stops truncating, every assertion
  // about large sheets silently becomes vacuous — the old counting code would
  // pass them. So the ceiling is asserted directly.
  it('truncates an unbounded read at a thousand rows, as PostgREST does', async () => {
    const { supabase } = await import('../src/api/db.js')
    await ingestDataset(TENANT, 'big', Array.from({ length: 1500 }, (_, i) => ({ id: `R${i}` })), { replace: true })
    const { data } = await supabase.from('lookup_rows').select('dataset').eq('tenant_id', TENANT).eq('dataset', 'big')
    expect(data).toHaveLength(1000)
  })

  it('does not truncate a head count', async () => {
    const { supabase } = await import('../src/api/db.js')
    await ingestDataset(TENANT, 'big', Array.from({ length: 1500 }, (_, i) => ({ id: `R${i}` })), { replace: true })
    const { count } = await supabase.from('lookup_rows')
      .select('id', { count: 'exact', head: true }).eq('tenant_id', TENANT).eq('dataset', 'big')
    expect(count).toBe(1500)
  })
})

describe('a lookup pointed at a sheet that does not exist', () => {
  // The most expensive failure this system has had. 100,000 correct rows sat in a
  // sheet named after the uploaded file while the lookup searched a sheet named
  // "Loan Status" that had never existed. Every call missed, and the log said
  // "→ miss", which reads as "that customer isn't in your data".
  const misconfigured = {
    tenant_id: TENANT,
    verify_caller_identity: false,
    lookups: [{
      name: 'loan_status',
      parameters: [{ name: 'customer_id' }],
      backend: { type: 'table', dataset: 'Loan Status' },   // nothing was uploaded here
    }],
  }

  it('misses every caller, however correct the data is', async () => {
    const out = await runLookup(misconfigured, 'loan_status', { customer_id: 'LN100077' }, { state: { rows: new Map() } })
    expect(out).toMatch(/^No matching record/)
  })

  it('says in the log that the sheet is empty, not that the caller is unknown', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await runLookup(misconfigured, 'loan_status', { customer_id: 'LN100077' }, { state: { rows: new Map() } })
    const said = warn.mock.calls.flat().join(' ')
    expect(said).toContain('Loan Status')
    expect(said).toMatch(/NO rows/)
    expect(said).toMatch(/never uploaded|renamed/)
    warn.mockRestore()
  })

  it('stays quiet when the sheet exists and the caller genuinely is not in it', async () => {
    // The warning must mean something. Firing it on an ordinary miss would train
    // everyone to ignore it.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await runLookup(cfg, 'loan_status', { customer_id: 'LN999999' }, { state: { rows: new Map() } })
    expect(warn.mock.calls.flat().join(' ')).not.toMatch(/NO rows/)
    warn.mockRestore()
  })

  it('finds the caller once the lookup points at the sheet that holds them', async () => {
    const fixed = { ...misconfigured, lookups: [{ ...misconfigured.lookups[0], backend: { type: 'table', dataset: 'loans' } }] }
    const out = await runLookup(fixed, 'loan_status', { customer_id: 'LN100077' }, { state: { rows: new Map() } })
    expect(JSON.parse(out)['Customer Name']).toBe('Ajay Acharya')
  })
})
