// scripts/tunnel.js — start the dev tunnel with the right domain, wherever ngrok is.
//
// Two problems this solves, both of which have already cost time:
//
//   1. A bare `ngrok http 3000` allocates a RANDOM url. PUBLIC_HOST and the URLs
//      configured in the Vobiz console both name a reserved domain, so a random
//      tunnel means inbound calls hit a hostname that no longer exists — and the
//      symptom is "calls stopped working", which points nowhere near the tunnel.
//      The domain is read from .env so there is one source of truth rather than a
//      copy pasted into package.json that quietly drifts.
//
//   2. On Windows, a PATH change does not reach shells that were already running,
//      or shells launched from a parent that started before the change — which
//      includes every VS Code terminal until VS Code itself restarts. So instead
//      of requiring a fresh shell, look ngrok up in the usual install locations
//      too.

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import 'dotenv/config'

const PORT = process.env.PORT || 3000
const DOMAIN = (process.env.PUBLIC_HOST || process.env.NGROK_URL || '').trim()

function resolveNgrok() {
  // PATH first — the normal case once the shell is fresh.
  const onPath = process.platform === 'win32' ? 'ngrok.exe' : 'ngrok'

  const candidates = [
    // winget keeps the binary in a versioned package directory.
    path.join(os.homedir(), 'AppData/Local/Microsoft/WinGet/Packages/Ngrok.Ngrok_Microsoft.Winget.Source_8wekyb3d8bbwe/ngrok.exe'),
    path.join(os.homedir(), 'AppData/Local/Microsoft/WinGet/Links/ngrok.exe'),
    'C:/ProgramData/chocolatey/bin/ngrok.exe',
    '/usr/local/bin/ngrok',
    '/opt/homebrew/bin/ngrok',
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return onPath   // let the OS try; we handle ENOENT below
}

if (!DOMAIN) {
  console.error('[TUNNEL] PUBLIC_HOST is not set in .env — refusing to start a tunnel on a random URL.')
  console.error('         Set PUBLIC_HOST to your reserved ngrok domain and try again.')
  process.exit(1)
}

const bin = resolveNgrok()
// --url, not --domain: the latter is deprecated in current ngrok, and there is no
// reason to keep it — ngrok's SERVER refuses any agent below 3.20 on a free
// account, so an agent old enough to need --domain cannot connect at all.
const url = DOMAIN.startsWith('http') ? DOMAIN : `https://${DOMAIN}`
const args = ['http', `--url=${url}`, String(PORT)]

console.log(`[TUNNEL] ${DOMAIN} → localhost:${PORT}`)

const child = spawn(bin, args, { stdio: 'inherit' })

child.on('error', (err) => {
  if (err.code === 'ENOENT') {
    console.error('\n[TUNNEL] ngrok could not be found.\n')
    console.error('  Install it:   winget install ngrok.ngrok')
    console.error('  Then open a NEW terminal — on Windows a PATH change does not reach')
    console.error('  shells that are already running, including VS Code terminals until')
    console.error('  VS Code itself is restarted.\n')
  } else {
    console.error('[TUNNEL] failed to start ngrok:', err.message)
  }
  process.exit(1)
})

child.on('exit', (code) => process.exit(code ?? 0))
