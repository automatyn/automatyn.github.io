# Outreach — UK plumber cold email system

Built as Node scripts in the saas-api process space. No n8n dependency. Data lives in `data/leads.json`.

## Pipeline

```
ingest.js       → pulls plumbers from Google Places, upserts to leads.json
enrich-emails.js → scrapes each website for contact emails
personalise.js  → Claude (you) runs WebSearch per lead, writes intro_line via `set`
sender.js e1    → sends Email 1 to ready leads (day 0)
sender.js e2    → sends Email 2 to leads past day 3
sender.js e3    → sends Email 3 (breakup) to leads past day 5
reply-detector.js → scans Gmail inbox, marks replies + bounces
daily-stats.js  → nightly report email to patricksson@gmail.com
```

Server (`server.js`) exposes `GET /u` and `GET /api/unsubscribe` — both take `?e=<email>&t=<hmac>` and mark the lead unsubscribed.

## One-time environment setup

Add to systemd `automatyn-api.service`:

```
Environment=GOOGLE_PLACES_API_KEY=...
Environment=BREVO_API_KEY=...               # outbound sender (see note below)
Environment=UNSUBSCRIBE_SECRET=...          # any strong random string, keep stable
Environment=OUTREACH_DAILY_CAP=15           # bump to 30 after week 1
Environment=OUTREACH_REPORT_TO=patricksson@gmail.com
Environment=OUTREACH_SENDER_EMAIL=patrick@automatyn.co    # optional, default patrick@automatyn.co
Environment=OUTREACH_SENDER_NAME="Patrick from Automatyn" # optional
Environment=GMAIL_OAUTH_CLIENT_ID=...       # for reply-detector only
Environment=GMAIL_OAUTH_CLIENT_SECRET=...
Environment=GMAIL_OAUTH_REFRESH_TOKEN=...
```

**Why Brevo, not Gmail SMTP:** `patrick@automatyn.co` is a Cloudflare Email Routing alias, not a real Google mailbox — Gmail SMTP app-password auth fails (535 BadCredentials). Brevo accepts the verified `automatyn.co` domain. Replies still route back through Cloudflare → Pat's Gmail inbox. Outbound logs live at `app.brevo.com/statistics/transactional` (NOT Gmail Sent folder).

`sudo systemctl daemon-reload && sudo systemctl restart automatyn-api.service` after editing.

Scripts are run manually or from systemd timers — they do not need the server running, they hit the JSON file directly.

## Daily loop (manual until scheduled)

```bash
cd /home/marketingpatpat/openclaw/saas-api

# Once a week — refresh the lead pool
node outreach/ingest.js London,Manchester,Leeds

# Before any send day — fill missing emails
node outreach/enrich-emails.js 100

# Personalisation (Claude runs this — see below)
node outreach/personalise.js list 20
# ... Claude does research, then for each:
node outreach/personalise.js set <lead_id> "One-sentence hook."

# Send today's batch (always dry-run first time)
node outreach/sender.js dry e1 3
node outreach/sender.js e1 15

# Follow-ups (run daily)
node outreach/sender.js e2
node outreach/sender.js e3

# Evening — replies + bounces + stats
node outreach/reply-detector.js 24
node outreach/daily-stats.js
```

## How Claude does personalisation

Claude Code (this assistant) is the personalisation worker. Sequence per day:

1. Run `node outreach/personalise.js list 20` → receive JSON with lead id, business_name, city, website, rating, review_count.
2. For each lead: use WebSearch / WebFetch to learn one specific fact — a recent review theme, speciality on their site, year established, area covered, Gas Safe reg, etc.
3. Write ONE sentence (under 25 words) that references the specific fact without sounding like a chatbot template.
4. Save it: `node outreach/personalise.js set <id> "…"`.

Rules for the intro line — strict:

- One sentence, under 25 words.
- Mention something real and specific.
- Never "I hope this email finds you well" or "Love what you're doing".
- Never claim to be a customer or to have used them.
- Read it aloud. If it sounds like a human, ship it.

Examples that passed:

> Saw you've been covering Croydon and South London for over a decade — that's a lot of boilers.
> Noticed the five-star streak on Google for emergency callouts in N1.
> Your site mentions specialising in unvented cylinders, which is niche in Manchester.

## Volume + cadence

- Week 1: `OUTREACH_DAILY_CAP=15` — 15 new leads/day get Email 1
- Week 2+: `OUTREACH_DAILY_CAP=30`
- Follow-ups uncapped (they only go to people already contacted)
- Between-send jitter: 45–90 seconds (sender.js handles this)

## Unsubscribe flow

Every email has `List-Unsubscribe` header (one-click in Gmail) and a footer link:
`https://automatyn.co/u?e=<email>&t=<hmac16>`

The token is `hmac-sha256(email, UNSUBSCRIBE_SECRET).slice(0,16)`. If the secret changes, old tokens break — so keep it stable.

## Stopping follow-ups

A lead is removed from the queue if any of these are true:

- `replied` — set by reply-detector.js when they email back
- `unsubscribed` — set by `/u` endpoint
- `bounced` — set by sender on SMTP 550 or by reply-detector on mailer-daemon
