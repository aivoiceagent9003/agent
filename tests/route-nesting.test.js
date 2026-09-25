// A parent route that forgets its Outlet is invisible in every other check.
//
// TanStack's flat file routing makes "app.leads.$id.tsx" a CHILD of "app.leads.tsx".
// If the parent renders a page instead of an <Outlet />, the child never mounts: the
// link works, the URL changes, the route resolves, the guard runs, the queries fire —
// and the parent's own list re-renders. Nothing throws. tsc is happy. The build is
// happy. It reads to a user as "the link is broken" or, as it was reported here, as
// "I can't see lead details on the Business page".
//
// Found twice in one pass: /app/leads (the reported one) and /admin/clients, whose
// "New client" and client-detail links had both been dead for the same reason.
//
// The frontend has no test runner of its own by design — see vitest.config.js — so
// this is a static check over the route filenames, which is all it needs to be.
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'

const DIR = new URL('../frontend/src/routes/', import.meta.url)
const files = readdirSync(DIR).filter(f => f.endsWith('.tsx'))
const routes = new Set(files.map(f => f.replace(/\.tsx$/, '')))

/** Every route file that has a PARENT route file, paired with that parent. */
function nested() {
  const out = []
  for (const f of files) {
    const base = f.replace(/\.tsx$/, '')
    const parts = base.split('.')
    if (parts.length < 2) continue
    const parent = parts.slice(0, -1).join('.')
    // No parent file means flat siblings (work.leads.index + work.leads.$id), which
    // mount independently and need no Outlet from anyone.
    if (routes.has(parent)) out.push({ child: base, parent })
  }
  return out
}

describe('a parent route renders its children', () => {
  const pairs = nested()

  it('finds the nested routes at all, so an empty pass cannot look like a green one', () => {
    expect(pairs.length).toBeGreaterThan(5)
    expect(pairs.map(p => p.child)).toContain('app.leads.$id')
  })

  it.each([...new Set(pairs.map(p => p.parent))])('%s renders an Outlet', (parent) => {
    const text = readFileSync(new URL(`${parent}.tsx`, DIR), 'utf8')
    const kids = pairs.filter(p => p.parent === parent).map(p => p.child)
    expect(text, `${parent}.tsx is the parent of ${kids.join(', ')} but never renders <Outlet />`)
      .toMatch(/<Outlet\s*\/>/)
  })
})
