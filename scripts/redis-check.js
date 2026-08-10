// scripts/redis-check.js — verify the campaign REDIS_URL is reachable.
//
// Run from your own terminal (uses your real network, not any sandbox):
//   node scripts/redis-check.js
//
// It resolves DNS, opens a raw TCP socket, then does a real Redis PING/SET/GET
// over BOTH plain and TLS, and prints exactly what works so we know whether it's
// an allowlist, a TLS requirement, or a bad URL.

import 'dotenv/config'
import net from 'node:net'
import dns from 'node:dns/promises'
import IORedis from 'ioredis'

const url = process.env.REDIS_URL
if (!url) { console.error('❌ REDIS_URL not set in .env'); process.exit(1) }

const u = new URL(url)
const host = u.hostname
const port = Number(u.port || 6379)
console.log(`Testing ${host}:${port}\n`)

// 1) DNS
try { console.log('DNS   ✅', JSON.stringify(await dns.lookup(host, { all: true }))) }
catch (e) { console.log('DNS   ❌', e.code) }

// 2) raw TCP
await new Promise((res) => {
  const s = net.connect({ host, port })
  const t = setTimeout(() => { console.log('TCP   ⚠️  timeout (port blocked by firewall)'); s.destroy(); res() }, 7000)
  s.on('connect', () => { console.log('TCP   ✅ socket open'); clearTimeout(t); s.end(); res() })
  s.on('error', (e) => { console.log('TCP   ❌', e.code); clearTimeout(t); res() })
})

// 3) Redis handshake — plain, then TLS
async function tryRedis(label, opts) {
  const r = new IORedis(url, { maxRetriesPerRequest: null, connectTimeout: 8000, retryStrategy: () => null, ...opts })
  let err = ''
  r.on('error', (e) => { err = e.code || e.message })
  try {
    const pong = await r.ping()
    await r.set('campaign:health', 'ok', 'EX', 30)
    const got = await r.get('campaign:health')
    const ver = ((await r.info('server')).match(/redis_version:(\S+)/) || [])[1]
    await r.quit()
    console.log(`${label} ✅ PING=${pong} GET=${got} redis=${ver}`)
    return true
  } catch (e) {
    try { r.disconnect() } catch {}
    console.log(`${label} ❌ ${err || e.message}`)
    return false
  }
}

const plain = await tryRedis('REDIS ', {})
let tls = false
if (!plain) tls = await tryRedis('REDISS', { tls: { servername: host, rejectUnauthorized: false } })

console.log('')
if (plain) console.log('🎉 Connected. Your REDIS_URL works — run `npm run worker`.')
else if (tls) console.log('🎉 Connected over TLS. Change REDIS_URL scheme from redis:// to rediss:// in .env, then `npm run worker`.')
else console.log('⚠️  Reachable at TCP but Redis refused. Fix in your Redis provider console:\n   • add your IP to the allowlist (or allow 0.0.0.0/0 for testing)\n   • confirm the database is active\n   • check whether TLS is required (use rediss://)')
process.exit(0)
