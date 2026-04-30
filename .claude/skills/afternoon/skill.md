---
name: afternoon
description: Midday run — generate TikTok carousels, check triggers, post content, check stats
user_invocable: true
---

# Afternoon Routine

Midday content production and monitoring. Do NOT ask for permission. Execute everything and report.

## Step 0: Recap of Last /morning

Read `/home/marketingpatpat/openclaw/social-posts/session-log.md` and find the most recent `/morning` entry. Print a brief recap.

## Step 1: Check Content Machine Trigger

The Content Machine trigger fires at 14:00 UTC daily. Use RemoteTrigger tool (load via ToolSearch) to check trigger `trig_01VCuzhEoftowx3adqtibsP5`:
- Is it still enabled?
- Did it fire? Check git log for new commits since this morning
- If it auto-disabled, re-enable it immediately

## Step 2: Check X Account Status

```
curl -s "https://api.fxtwitter.com/patrickssons"
```
If 404, still suspended. Skip X steps. If user data returned, account is back.

**IF X IS BACK:** Run the X posting flow via the Telegram approval gate. See `references/x-posting-flow.md` for full procedure. NEVER use Playwright.

**Check x.com/i/account_analytics first (mandatory).** Open via browser-use CDP 18800, extract 7-day impressions, engagement rate, follows-over-time, verified followers. Log to session log. Adjust draft volume:
- Impressions down >50% OR flat follows → **quality mode**: 1-2 replies max to accounts >10k on-topic.
- Trend flat or up → **normal mode**: 0-1 originals + 2-3 replies, targets >1k.

Verify every target's follower count via `curl -s https://api.fxtwitter.com/<handle>` before drafting. Skip <1k unless warm chain. Drafts go as `x.com/intent/tweet?in_reply_to=<tweet_id>&text=...` URLs.

**Recency check — MANDATORY (feedback_x_reply_recency.md):** Reply target post must be <6h old. Verify via `curl -s https://api.fxtwitter.com/status/<tweet_id>` → check `created_at`, reject older. Use `x.com/search?...&f=live` (Latest) for discovery. Skip author entirely if latest post >6h old. Warm-chain exempt up to 24h. Log rejected-by-age count.

## Step 2aa: Dual-channel X reply pipeline (15 API + 15 scrape = 30/slot)

See /morning skill Step 3aa for full procedure. Same flow:

```bash
cd /home/marketingpatpat/openclaw/social-posts/x-drafts
X_BEARER_TOKEN='<see reference_x_api_keys.md>' node scrape-via-api.js 15 24   # API source (~$0.07)
timeout 700 node scrape-targets.js 24 5                                       # Browser scrape source (free)
```

Then draft 15 reply-bait replies per source (all questions to author, <200c, no em dashes, no AI buzzwords) and send each as Telegram message to @automatyntweetbot with intent URL button. Verify <6h age + >1k followers per target. If either source returns 0, skip and log.

## Step 2b: Trigger Reddit AI Image Pipeline (n8n)

Fire the `Reddit AI Image Pipeline` workflow via webhook. No API key needed.

```bash
curl -s -X POST "http://n8n-zwxfn09hqi8751v1plu6rjvt.136.112.252.235.sslip.io/webhook/reddit-image-pipeline"
```

Expect `{"message":"Workflow was started"}`. Do NOT wait for completion. On error, log and continue.

## Step 3: Generate TikTok Carousels (2-3 per session)

**USE LARRY-BRAIN FRAMEWORK** from /home/marketingpatpat/.openclaw/workspace/skills/larry-marketing/references/slide-structure.md

**Check TikTok trending hashtags first:**
Visit https://ads.tiktok.com/business/creativecenter/inspiration/popular/hashtag/pc/en via Playwright (read-only).

**Hook selection — Tier 1 (Person + Conflict) performs best:**
- Family hooks get highest views (Mum: 806, Dad: 801, Boss: 652)
- Use a different conflict character than morning session
- Clickbait POV title: "POV: Your therapist sees your income", "POV: Your neighbour finds out"

**For each carousel:**
1. Write hook using larry-brain Tier 1 formula
2. Generate 6 FACELESS images using Gemini API:
   - Key: read from $GEMINI_API_KEY env var (never hardcode)
   - Model: gemini-3-pro-image-preview
   - ALL faceless (behind, hands, overhead, over shoulder)
   - Dark moody aesthetic matching existing TikTok videos
3. Burn text overlays using burn_text.py at /home/marketingpatpat/openclaw-full/tiktok-marketing/generated/2026-04-08/burn_text.py
4. Upload to Postiz and create TikTok post (content_posting_method:"UPLOAD")
5. Caption: max 5 hashtags. Clickbait POV title.

Postiz credentials:
- Token: read from $POSTIZ_API_KEY env var (never hardcode)
- TikTok integration: cmmzd0apq03pmp30yh70b3uti

## Step 4: Check TikTok Stats

```
yt-dlp --flat-playlist --dump-json "https://www.tiktok.com/@realnataliana"
```
Report views, likes, top performers. Compare with morning stats.

## Step 5: Post LinkedIn (if not posted in morning)

Post 1 LinkedIn update via Postiz if morning didn't post one.
- LinkedIn integration: cmnmbgu9r04w4so0ygvvi0ere

## Step 6: Check TikTok DMs

Remind Pat to check TikTok DMs for potential leads. If someone asks "is this real?" or "how does this work?", reply as Natalia (happy customer), not as the founder:
- "Yeah! I got mine set up by this guy who does it for small businesses. Want me to send you his details?"

## Step 6b: Cold Email Outreach — daily send

This is the main daily driver for new business. Run every afternoon.

```bash
cd /home/marketingpatpat/openclaw/saas-api
```

**Preflight:**
1. `node -e "console.log(require('./outreach/leads-store').stats())"` — show pool size
2. If `with_email - email1_sent_total < 30`: run enrichment to top up
   ```bash
   node outreach/enrich-emails.js 100
   ```
3. If `personalised - email1_sent_total < 15`: need more personalised leads. Run:
   ```bash
   node outreach/personalise.js list 20
   ```
   Then for each returned lead, WebSearch the business_name + city, write one specific sentence (under 25 words, no generic openers, no "I hope this finds you well"). Save each with:
   ```bash
   node outreach/personalise.js set <lead_id> "<your sentence>"
   ```
   Personalisation rules and examples: see saas-api/outreach/README.md.

**Send Email 1 (fresh leads):**
- First-ever run: do a dry-run of 3 and show Pat the output before live-sending
  ```bash
  node outreach/sender.js dry e1 3
  ```
- Once Pat has approved the copy once, live send respects the daily cap (OUTREACH_DAILY_CAP, default 15)
  ```bash
  node outreach/sender.js e1
  ```

**Volume ramp schedule (deliverability):**
- Apr 22-24 (now-Fri): cap 15/day — baseline reputation building
- Apr 25-30: bump cap to 25/day — only if bounces <2% and unsubs <1/day stay clean
- May 1+: step to 40/day if trailing 7-day metrics hold. Never jump more than ~70% in a single step.
- Update `OUTREACH_DAILY_CAP` in systemd env and restart automatyn-api to change.

**Send follow-ups (uncapped, only go to already-contacted leads):**
```bash
node outreach/sender.js e2   # Day 3 follow-up
node outreach/sender.js e3   # Day 5 breakup
```

Sender routes via **Brevo** (not Gmail SMTP) — sends do NOT appear in Gmail Sent folder. Check `app.brevo.com/statistics/transactional` for delivery/open/click logs. Replies still land in Pat's Gmail via Cloudflare routing of `patrick@automatyn.co`.

If `BREVO_API_KEY` is not set, sender throws. That's a setup blocker — stop and report to Pat, do not retry.

**Bot health sanity check (run before sending):**
```bash
# Confirm gateway is up and OpenAI key works — 1 free smoke test, no real customer
curl -s http://127.0.0.1:3001/api/health 2>&1 | head -5
systemctl is-active openclaw-gateway automatyn-api
```
If either is down, STOP outreach — don't send leads to a broken product. Report to Pat.

## Step 7: Report

```
AFTERNOON REPORT — [DATE]
===========================
X STATUS: [suspended/reinstated]
TRIGGERS: Content Machine [status]
OUTREACH: E1 sent today: [n] / cap [N]; E2 [n]; E3 [n]; new replies [n]; pool [personalised-ready/with_email/total]
TIKTOK: [videos, views, likes]
  New carousels: [hooks pushed]
  Top performer: [title + views]
  DMs: [any new leads?]
LINKEDIN: [posted/skipped]
```

## Step 8: Write Session Log

Append to `/home/marketingpatpat/openclaw/social-posts/session-log.md` and commit/push.

## Content Rules (MUST follow everywhere)
- NEVER use em dashes
- NEVER use banned words (leverage, unlock, seamless, etc.)
- No fake prices. Real: $400 / $800 / $1500 + $150/mo
- NEVER use Playwright to post/reply/like on any platform with an API
- Sound human and professional, not AI-generated
