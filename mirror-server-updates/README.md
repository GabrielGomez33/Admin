# mirror-server updates — Admin Email Broadcasts

Complete, copy-paste-ready files for **mirror-server**. Nothing here is a patch;
each file is the full, final version. Copy each into the matching path inside
your `mirror-server` checkout, then build + deploy as usual.

> These changes are **additive**. They add a new internal admin API, a public
> unsubscribe/webhook surface, and a new PM2 worker. No existing route, table,
> or worker is modified in a behaviour-changing way. The only edits to existing
> files are: `index.ts` (mounts two new routers), `ecosystem.config.js` (adds
> the worker), `package.json` (adds worker scripts), and
> `.github/workflows/ci-cd.yml` (expects 6 processes instead of 5).

## File map

| File in this folder | Copy to (in mirror-server) |
| --- | --- |
| `migrations/014_email_broadcasts.sql` | `migrations/014_email_broadcasts.sql` |
| `middleware/internalAuth.ts` | `middleware/internalAuth.ts` |
| `services/emailService.ts` | `services/emailService.ts` (overwrites — only additive changes) |
| `services/emailBroadcastService.ts` | `services/emailBroadcastService.ts` |
| `controllers/adminEmailController.ts` | `controllers/adminEmailController.ts` |
| `controllers/emailPublicController.ts` | `controllers/emailPublicController.ts` |
| `routes/adminEmail.ts` | `routes/adminEmail.ts` |
| `routes/emailPublic.ts` | `routes/emailPublic.ts` |
| `workers/EmailCampaignWorker.ts` | `workers/EmailCampaignWorker.ts` |
| `index.ts` | `index.ts` (overwrites — adds 2 imports + 2 mounts) |
| `ecosystem.config.js` | `ecosystem.config.js` (overwrites — adds worker) |
| `package.json` | `package.json` (overwrites — adds worker scripts) |
| `.github/workflows/ci-cd.yml` | `.github/workflows/ci-cd.yml` (overwrites — expects 6 procs) |

## Environment variables (add to mirror-server `.env`)

```bash
# Shared secret with admin-server. MUST equal admin-server's MIRROR_INTERNAL_SECRET.
# Generate: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
MIRROR_INTERNAL_SECRET=

# Secret protecting the provider bounce/complaint webhook (x-webhook-secret header
# or ?secret= query). Generate a random value and configure it in Resend/Brevo.
EMAIL_WEBHOOK_SECRET=

# (Optional) dedicated unsubscribe HMAC secret. Falls back to MIRROR_INTERNAL_SECRET.
EMAIL_UNSUBSCRIBE_SECRET=

# Public base used to build unsubscribe links in emails.
EMAIL_PUBLIC_BASE_URL=https://www.theundergroundrailroad.world

# CAN-SPAM physical address shown in every broadcast footer.
EMAIL_PHYSICAL_ADDRESS=The Underground Railroad, <your mailing address>

# (Optional) Reply-To for broadcasts.
EMAIL_REPLY_TO=support@theundergroundrailroad.world

# Sending throughput + batching (sane defaults shown).
EMAIL_SEND_RATE_PER_SEC=8
EMAIL_BATCH_SIZE=50
EMAIL_WORKER_POLL_MS=15000
EMAIL_MAX_ATTACHMENT_BYTES=5242880

# Global dry-run: when true, NO mail is delivered (logs only). Great for staging.
EMAIL_DRY_RUN=false

# (Optional) Max JSON body for the admin email API path (base64 attachments).
EMAIL_JSON_LIMIT=12mb
```

> The existing `EMAIL_PROVIDER` / `EMAIL_API_KEY` (or `RESEND_API_KEY`) /
> `EMAIL_FROM_ADDRESS` / `EMAIL_FROM_NAME` / `APP_URL` used by the transactional
> EmailService are reused as-is.

## Deploy sequence

1. **Apply the migration** (creates 3 tables; idempotent):
   ```bash
   mysql -u <user> -p <database> < migrations/014_email_broadcasts.sql
   ```
2. Copy the files per the map above.
3. Set the new env vars in `.env`.
4. Build + start (the worker is now part of the ecosystem):
   ```bash
   npm run build
   sudo pm2 start ecosystem.config.js   # or: sudo pm2 restart ecosystem.config.js
   sudo pm2 save
   ```
5. (Optional) Point your provider's bounce/complaint webhook at:
   `https://<host>/mirror/api/email/webhook/resend?secret=<EMAIL_WEBHOOK_SECRET>`
   (or `/brevo`).

## API surface added

Internal (admin-server only, `requireInternalSecret`):
`/mirror/api/admin/email/{health, users/search, preview-audience, preview, test,
campaigns [GET/POST], campaigns/:id [GET], campaigns/:id/send, campaigns/:id/cancel}`

Public (ungated, protected by HMAC / webhook secret):
`/mirror/api/email/unsubscribe` (GET + one-click POST), `/mirror/api/email/webhook/:provider`

## Safety properties

- **Idempotent / resumable:** sending is driven by `email_campaign_recipients`
  rows; a worker restart only ever re-processes `pending` rows. No double-sends.
- **Concurrency-safe:** a Redis lock guards per-campaign dispatch.
- **No stored XSS:** content is structured blocks; all operator/user text is
  HTML-escaped; URLs are http(s)-only. There is no raw-HTML block.
- **Compliant:** every broadcast carries a one-click `List-Unsubscribe` header,
  an unsubscribe link, and a physical address. Suppressions are keyed by email
  and survive account deletion. Transactional mail ignores the suppression list.
- **Throttled:** sends are rate-limited (`EMAIL_SEND_RATE_PER_SEC`) and batched.
