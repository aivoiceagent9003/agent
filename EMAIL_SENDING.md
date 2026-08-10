# Email Sending — Setup

Vocera sends three transactional emails, all over plain SMTP through
[src/services/email.js](src/services/email.js):

| Email | Trigger |
|---|---|
| Welcome | signup / first Google login / invite accepted |
| Team invite | owner invites an employee on `/app/team` |
| Password reset | `/forgot-password` (via Supabase, not SMTP) |

**Nothing breaks when SMTP is unconfigured** — `sendEmail` logs a warning and
returns `false`. Invites still work; the owner copies the join link from the Team
page instead. Configure SMTP to make delivery automatic.

---

## Which provider?

The deciding question is **do you own a domain yet**, because most providers will
only send to arbitrary recipients once you've verified one.

| | Domain needed? | Free tier | Sends to anyone? | Good for |
|---|---|---|---|---|
| **Gmail + App Password** | No | ~500/day | **Yes** | No domain yet — start here |
| **Brevo** | No (verify a single address) | 300/day | **Yes** | More headroom, still no domain |
| **Resend** | Yes, for real recipients | 3,000/month | Only after domain verification | Once you own a domain |

Resend's `onboarding@resend.dev` sender works instantly but **only delivers to your
own signup address** — useless for inviting actual employees. Don't start there
without a domain.

---

## Start here: Gmail + App Password (no domain, 5 minutes)

Sends to anyone, costs nothing, and the `"Sunrise Realty via Vocera"` display name
works correctly (see the note below).

### 1. Create an App Password

1. Enable **2-Step Verification** on the Google account — App Passwords don't exist without it
2. Google Account → **Security → App passwords** → generate one
3. Copy the 16-character value (shown once, spaces don't matter)

### 2. Add to `.env`

```bash
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=you@gmail.com
SMTP_PASS=abcdefghijklmnop           # the 16-char App Password, NOT your login password
EMAIL_FROM=Vocera <you@gmail.com>    # the address MUST be the same Gmail account
APP_URL=http://localhost:8080        # must match where the dashboard runs
```

`EMAIL_FROM`'s address has to match `SMTP_USER`. Gmail rewrites a `From` address
that doesn't belong to the authenticated account — that's the one thing that would
break the sender identity.

### 3. Verify

```bash
node scripts/test-email.js                    # config only, sends nothing
node scripts/test-email.js you@gmail.com      # actually send
```

The script prints the resolved config with secrets masked, shows the exact
From/Reply-To/subject, then sends. The link in the test email is a fake token, so
opening it correctly says "invite link is no longer valid" — that proves delivery,
not the invite flow.

### 4. Restart the backend

`.env` is read at boot, so `npm run dev` needs a restart to pick it up.

### Does the display name survive Gmail?

Yes. Gmail rewrites the `From` **address** when it doesn't match the authenticated
account, but keeps the display name. Because `sendEmail()` changes only the display
name and keeps `addressOf(EMAIL_FROM)` — your Gmail address — the header arrives as:

```
From: "Sunrise Realty via Vocera" <you@gmail.com>
```

Recipients may see Gmail's own "via gmail.com" hint, which disappears once you move
to a verified domain.

### Gmail's limits

- ~500 recipients/day (Google may throttle bursts well below that)
- No bounce/open reporting
- Personal-domain mail is more likely to hit Promotions or spam

Fine for development and early pilots. Move to a domain before onboarding paying
customers.

---

## More headroom without a domain: Brevo

Brevo verifies a **single sender address** rather than a whole domain, so a plain
Gmail address works as the sender and it still delivers to anyone.

1. Sign up at [brevo.com](https://www.brevo.com)
2. **Senders & IPs → Senders → Add a sender** → enter your email → click the
   confirmation link they send you
3. **SMTP & API → SMTP** → copy the SMTP key

```bash
SMTP_HOST=smtp-relay.brevo.com
SMTP_PORT=587
SMTP_USER=your-brevo-login@example.com
SMTP_PASS=xsmtpsib-xxxxxxxxxxxx        # the SMTP key, not your account password
EMAIL_FROM=Vocera <your-verified-sender@gmail.com>
```

300/day free, with delivery and bounce dashboards Gmail doesn't give you.

---

## Later: your own domain (before paying customers)

A domain is ~₹700–1,200/year (Cloudflare Registrar sells at cost; Namecheap and
GoDaddy are fine). You'll want one for the product anyway.

Once you have it, on Resend or Brevo:

1. **Domains → Add Domain**, enter e.g. `vocera.in`
2. Add the SPF `TXT` and DKIM `CNAME` records at your registrar
3. Wait for verification (minutes to an hour)
4. Update one line:

```bash
EMAIL_FROM=Vocera <hello@vocera.in>
```

No code changes. This is also what removes the "via gmail.com" hint and gets you
out of spam folders reliably.

---

## Also required: password reset

`/forgot-password` goes through **Supabase Auth**, not your SMTP. One config step:

> Supabase Dashboard → Authentication → URL Configuration → **Redirect URLs**
> Add: `http://localhost:8080/reset-password` (and your production URL)

Without it Supabase refuses the redirect and the emailed reset link dead-ends.

Supabase's own free SMTP is rate-limited to a few emails per hour. For production,
set the same Resend credentials under **Authentication → SMTP Settings**.

---

## How multi-tenant sending works

All mail leaves from **one platform address**. The client's identity rides in the
display name, subject, and Reply-To:

```
From:     "Sunrise Realty via Vocera" <hello@vocera.in>
Reply-To: madhusudhan@sunriserealty.in
Subject:  Madhusudhan invited you to Sunrise Realty on Vocera
```

**Never set `From` to the client's own domain.** You don't control their SPF or DKIM
keys, so:

- SPF fails — your server isn't authorised for their domain
- DKIM fails — you can't sign as a domain you have no keys for
- DMARC `p=reject` (common at banks and enterprises) causes hard **rejection**, not
  spam-foldering

One client's misconfiguration would also poison your sending reputation for
everyone. If a client eventually requires their own domain, that's a separate
feature: per-tenant domain verification, where they add DNS records and you send
through a provider supporting multiple verified domains.

### Header-injection safety

Display names are built from tenant-supplied business names, so `safeDisplayName()`
strips CR/LF, quotes, and backslashes and caps length at 78. Without it a business
name of `Evil\r\nBcc: everyone@…` would let a client inject arbitrary mail headers.
The envelope address is always the platform's, regardless of input.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `SMTP not configured — skipping` | One of `SMTP_HOST` / `SMTP_USER` / `SMTP_PASS` is missing. All three are required. |
| `Invalid login` (Gmail) | Used the account password. Needs a 16-char **App Password** with 2-Step Verification on. |
| `Invalid login` (Resend) | `SMTP_USER` must be the literal string `resend`, not your email. |
| Resend: `You can only send testing emails to your own address` | No verified domain yet. Use Gmail or Brevo instead. |
| Gmail: sender shows your address, not the business | Expected — only the display name is per-tenant. A verified domain fixes the rest. |
| Connection times out | Wrong port — 587 is STARTTLS, 465 is implicit TLS. The code picks `secure` from the port automatically. |
| Email sends, link is wrong host | `APP_URL` is wrong. The join link is built from it in `inviteUrl()`. |
| Reset link dead-ends | `/reset-password` not in Supabase's Redirect URLs. |
| Delivered to spam | Sending from an unverified domain. Complete step 4. |
