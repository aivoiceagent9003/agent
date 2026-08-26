// Alert delivery.
//
// This module is called from the alert tick and from the crash handler, which
// makes its failure modes unusually consequential: a notifier that throws takes
// down the thing it was reporting, and one that spams gets muted — after which it
// is worse than having none, because everyone believes it works.
//
// Config is read at module load, so each behaviour is imported into a fresh module
// registry with its own environment via vi.resetModules().

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const ORIGINAL_ENV = { ...process.env }

async function loadNotify(env = {}) {
  vi.resetModules()
  for (const k of ['ALERT_WEBHOOK_URL', 'ALERT_EMAIL_TO', 'ALERT_MIN_SEVERITY', 'ALERT_COOLDOWN_MS', 'ALERT_SEND_TIMEOUT_MS']) {
    delete process.env[k]
  }
  Object.assign(process.env, env)
  // email.js is stubbed so nothing here can touch a real SMTP server.
  vi.doMock('../src/services/email.js', () => ({
    emailReady: () => true,
    sendEmail: vi.fn(async () => ({ ok: true })),
  }))
  return import('../src/services/notify.js')
}

beforeEach(() => {
  vi.restoreAllMocks()
})

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
  vi.unstubAllGlobals()
})

describe('configuration', () => {
  it('reports itself unconfigured when neither channel is set', async () => {
    const { notifyConfigured } = await loadNotify()
    expect(notifyConfigured).toBe(false)
  })

  it('reports itself configured with only a webhook', async () => {
    const { notifyConfigured } = await loadNotify({ ALERT_WEBHOOK_URL: 'https://hooks.example/x' })
    expect(notifyConfigured).toBe(true)
  })

  it('reports itself configured with only email', async () => {
    const { notifyConfigured } = await loadNotify({ ALERT_EMAIL_TO: 'ops@example.com' })
    expect(notifyConfigured).toBe(true)
  })

  it('does not send, or throw, when unconfigured', async () => {
    const { notify } = await loadNotify()
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const r = await notify({ title: 'something broke', severity: 'critical' })
    expect(r.skipped).toBe('not_configured')
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('delivery', () => {
  it('posts JSON carrying a Slack-compatible text field', async () => {
    const { notify } = await loadNotify({ ALERT_WEBHOOK_URL: 'https://hooks.example/x' })
    const calls = []
    vi.stubGlobal('fetch', async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) })
      return { ok: true, status: 200 }
    })
    const r = await notify({ title: 'Gemini errors spiking', body: '12 in 60s', severity: 'critical' })
    expect(r.sent).toContain('webhook')
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://hooks.example/x')
    // `text` is what Slack renders; the structured fields serve other receivers.
    expect(calls[0].body.text).toContain('Gemini errors spiking')
    expect(calls[0].body.severity).toBe('critical')
    expect(calls[0].body.title).toBe('Gemini errors spiking')
  })

  it('names the environment so several deployments are tellable apart', async () => {
    const { notify } = await loadNotify({ ALERT_WEBHOOK_URL: 'https://hooks.example/x' })
    let body
    vi.stubGlobal('fetch', async (_u, init) => { body = JSON.parse(init.body); return { ok: true, status: 200 } })
    await notify({ title: 'CPU high', severity: 'critical' })
    expect(body.text).toMatch(/^\[.+\/.+\]/)
    expect(body.environment).toBeTruthy()
  })

  it('sends email when addresses are configured', async () => {
    const { notify } = await loadNotify({ ALERT_EMAIL_TO: 'ops@example.com,cto@example.com' })
    const r = await notify({ title: 'Disk full', severity: 'critical' })
    expect(r.sent).toContain('email')
  })

  it('uses both channels at once when both are configured', async () => {
    const { notify } = await loadNotify({
      ALERT_WEBHOOK_URL: 'https://hooks.example/x',
      ALERT_EMAIL_TO: 'ops@example.com',
    })
    vi.stubGlobal('fetch', async () => ({ ok: true, status: 200 }))
    const r = await notify({ title: 'Everything is on fire', severity: 'critical' })
    expect(r.sent).toEqual(expect.arrayContaining(['webhook', 'email']))
  })
})

describe('Slack formatting', () => {
  const SLACK = 'https://hooks.slack.com/services/T000/B000/xxxx'

  async function capture(url, args) {
    const { notify } = await loadNotify({ ALERT_WEBHOOK_URL: url })
    let body
    vi.stubGlobal('fetch', async (_u, init) => { body = JSON.parse(init.body); return { ok: true, status: 200 } })
    await notify({ severity: 'critical', force: true, ...args })
    return body
  }

  it('sends a coloured attachment to a Slack webhook', async () => {
    const body = await capture(SLACK, { title: 'Gemini errors spiking', body: '12 in 60s' })
    expect(body.attachments).toHaveLength(1)
    expect(body.attachments[0].color).toBe('#d32f2f')
    expect(body.attachments[0].title).toBe('Gemini errors spiking')
  })

  it('colours a resolve green rather than by the original severity', async () => {
    // The alert's severity is still "critical" when it clears. Painting the
    // recovery red is how people stop trusting the channel.
    const body = await capture(SLACK, { title: 'RESOLVED: Gemini errors spiking', body: 'Cleared after 180s.' })
    expect(body.attachments[0].color).toBe('#388e3c')
    expect(body.attachments[0].fields.find((f) => f.title === 'Severity').value).toBe('resolved')
    expect(body.text).toContain('✅')
  })

  it('keeps `text` a complete summary, since it is the phone preview', async () => {
    const body = await capture(SLACK, { title: 'CPU usage high', body: 'CPU at 96%' })
    expect(body.text).toContain('CPU usage high')
    expect(body.text).toMatch(/\[.+\/.+\]/)
    expect(body.text).toContain('🚨')
  })

  it('wraps the body in a code block so stack traces stay readable', async () => {
    const body = await capture(SLACK, { title: 'CRASH', body: 'Error: boom\n    at foo (bar.js:1)' })
    expect(body.attachments[0].text.startsWith('```')).toBe(true)
    expect(body.attachments[0].text).toContain('at foo (bar.js:1)')
  })

  it('truncates a very long body rather than having Slack reject the message', async () => {
    const body = await capture(SLACK, { title: 'CRASH', body: 'x'.repeat(10_000) })
    expect(body.attachments[0].text.length).toBeLessThan(2600)
  })

  it('does NOT send Slack attachments to a non-Slack webhook', async () => {
    // A generic receiver gets the flat shape it can parse; Discord would reject a
    // payload built around `attachments`.
    const body = await capture('https://hooks.example/generic', { title: 'CPU usage high', body: 'CPU at 96%' })
    expect(body.attachments).toBeUndefined()
    expect(body.title).toBe('CPU usage high')
    expect(body.severity).toBe('critical')
    expect(body.content).toContain('CPU usage high') // Discord
  })
})

describe('severity filtering', () => {
  it('drops anything below the configured minimum', async () => {
    const { notify } = await loadNotify({ ALERT_WEBHOOK_URL: 'https://hooks.example/x', ALERT_MIN_SEVERITY: 'critical' })
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)
    for (const sev of ['info', 'warning', 'error']) {
      expect((await notify({ title: `t-${sev}`, severity: sev })).skipped).toBe('below_min_severity')
    }
    expect(fetchSpy).not.toHaveBeenCalled()
    expect((await notify({ title: 'real one', severity: 'critical' })).sent).toContain('webhook')
  })

  it('honours a lower threshold when asked', async () => {
    const { notify } = await loadNotify({ ALERT_WEBHOOK_URL: 'https://hooks.example/x', ALERT_MIN_SEVERITY: 'warning' })
    vi.stubGlobal('fetch', async () => ({ ok: true, status: 200 }))
    expect((await notify({ title: 'a warning', severity: 'warning' })).sent).toContain('webhook')
    expect((await notify({ title: 'an info', severity: 'info' })).skipped).toBe('below_min_severity')
  })
})

describe('de-duplication', () => {
  it('suppresses a repeat of the same key inside the cooldown', async () => {
    // The flapping-threshold case: without this, one unstable metric sends until
    // the mailbox is unusable and the next real alert is invisible.
    const { notify } = await loadNotify({ ALERT_WEBHOOK_URL: 'https://hooks.example/x', ALERT_COOLDOWN_MS: '60000' })
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)
    await notify({ title: 'CPU high', severity: 'critical', key: 'alert:cpu_high' })
    for (let i = 0; i < 5; i++) {
      expect((await notify({ title: 'CPU high', severity: 'critical', key: 'alert:cpu_high' })).skipped).toBe('cooldown')
    }
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('does not let one alert suppress a different one', async () => {
    const { notify } = await loadNotify({ ALERT_WEBHOOK_URL: 'https://hooks.example/x', ALERT_COOLDOWN_MS: '60000' })
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)
    await notify({ title: 'CPU high', severity: 'critical', key: 'alert:cpu_high' })
    await notify({ title: 'Memory high', severity: 'critical', key: 'alert:memory_high' })
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('allows the send again once the cooldown has passed', async () => {
    const { notify } = await loadNotify({ ALERT_WEBHOOK_URL: 'https://hooks.example/x', ALERT_COOLDOWN_MS: '10' })
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)
    await notify({ title: 'CPU high', severity: 'critical', key: 'k' })
    await new Promise((r) => setTimeout(r, 25))
    await notify({ title: 'CPU high', severity: 'critical', key: 'k' })
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('falls back to the title as the key', async () => {
    const { notify } = await loadNotify({ ALERT_WEBHOOK_URL: 'https://hooks.example/x', ALERT_COOLDOWN_MS: '60000' })
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)
    await notify({ title: 'same title', severity: 'critical' })
    await notify({ title: 'same title', severity: 'critical' })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })
})

describe('force (the crash path)', () => {
  it('bypasses both the severity filter and the cooldown', async () => {
    // A crash must never be the thing that gets suppressed, and a crash-looping
    // process is exactly when every restart is worth knowing about.
    const { notify } = await loadNotify({
      ALERT_WEBHOOK_URL: 'https://hooks.example/x',
      ALERT_MIN_SEVERITY: 'critical',
      ALERT_COOLDOWN_MS: '600000',
    })
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)
    for (let i = 0; i < 3; i++) {
      await notify({ title: 'CRASH', body: 'stack', severity: 'info', force: true, key: 'crash' })
    }
    expect(fetchSpy).toHaveBeenCalledTimes(3)
  })
})

describe('never throws', () => {
  it('survives a webhook that returns an error status', async () => {
    const { notify } = await loadNotify({ ALERT_WEBHOOK_URL: 'https://hooks.example/x' })
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 500 }))
    const r = await notify({ title: 'x', severity: 'critical' })
    expect(r.sent).not.toContain('webhook')
  })

  it('survives a webhook that rejects outright', async () => {
    const { notify } = await loadNotify({ ALERT_WEBHOOK_URL: 'https://hooks.example/x' })
    vi.stubGlobal('fetch', async () => { throw new Error('ECONNREFUSED') })
    await expect(notify({ title: 'x', severity: 'critical' })).resolves.toBeTruthy()
  })

  it('still delivers by email when the webhook fails', async () => {
    // One dead channel must not take the other with it.
    const { notify } = await loadNotify({
      ALERT_WEBHOOK_URL: 'https://hooks.example/x',
      ALERT_EMAIL_TO: 'ops@example.com',
    })
    vi.stubGlobal('fetch', async () => { throw new Error('ECONNREFUSED') })
    const r = await notify({ title: 'x', severity: 'critical' })
    expect(r.sent).toEqual(['email'])
  })

  it('ignores a call with no title rather than sending an empty alert', async () => {
    const { notify } = await loadNotify({ ALERT_WEBHOOK_URL: 'https://hooks.example/x' })
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    expect((await notify({})).skipped).toBe('no_title')
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
