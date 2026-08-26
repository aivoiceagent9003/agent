import { defineConfig } from 'vitest/config'

// Node environment: everything under test is server-side. The frontend has its own
// toolchain (tsc + vite build) and is not covered here.
//
// No global setup file and no shared mocks on purpose. The units worth testing in
// this codebase are pure — audio conversion, phone normalisation, the language
// state machine, working-hours arithmetic — and tests that reach for the network
// or the database are the ones that rot. Where a test genuinely needs Supabase, it
// stubs the one call it depends on, in that file, where it can be seen.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
    // A hung test is worse than a failing one: it stalls CI without saying why.
    testTimeout: 10_000,
    hookTimeout: 10_000,
    reporters: ['default'],
  },
})
