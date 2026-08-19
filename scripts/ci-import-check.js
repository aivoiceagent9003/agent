// scripts/ci-import-check.js — smoke test standing in for a real suite.
//
// There is no test suite yet (Phase 6 of the production plan). Until there is,
// the cheapest check with real value is: does every module still load? That
// catches the broken import, the renamed export, and the syntax error — the class
// of break that otherwise stays invisible until a call comes in and the media
// stream dies at 2am.
//
// index.js and worker.js are excluded because importing them binds a listener and
// starts timers. Everything they import is covered transitively anyway.
//
// Runs with placeholder env vars so it never needs real credentials: modules are
// only imported, never exercised against a live service.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = path.join(ROOT, 'src')

// Enough to satisfy module-level config reads. No real service is contacted.
const PLACEHOLDERS = {
  SUPABASE_URL: 'https://placeholder.supabase.co',
  SUPABASE_ANON_KEY: 'placeholder',
  SUPABASE_SERVICE_ROLE_KEY: 'placeholder',
  OPENAI_API_KEY: 'placeholder',
  GOOGLE_AI_API_KEY: 'placeholder',
  WEBHOOK_SECRET: 'placeholder-webhook-secret',
  CAMPAIGN_RUNNER: 'off',
}
for (const [k, v] of Object.entries(PLACEHOLDERS)) if (!process.env[k]) process.env[k] = v

const SKIP = new Set(['index.js', 'worker.js'].map(f => path.join(SRC, f)))

const files = []
;(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(p)
    else if (entry.name.endsWith('.js')) files.push(p)
  }
})(SRC)

let ok = 0
const failures = []

for (const file of files) {
  const rel = path.relative(ROOT, file)
  if (SKIP.has(file)) {
    console.log(`skip  ${rel}  (binds a listener)`)
    continue
  }
  try {
    await import(pathToFileURL(file).href)
    ok++
  } catch (err) {
    failures.push([rel, err.message.split('\n')[0]])
  }
}

console.log(`\n${ok} module(s) imported cleanly, ${failures.length} failed`)
for (const [file, message] of failures) {
  console.error(`FAIL  ${file}\n      ${message}`)
}

process.exit(failures.length ? 1 : 0)
