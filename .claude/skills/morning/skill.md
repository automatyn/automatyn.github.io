---
name: morning
description: Daily morning routine — check triggers, generate TikTok carousels, check stats, post content
user_invocable: true
---

# Morning Routine

Run the full daily marketing automation check and content production. Do NOT ask for permission on any step. Execute everything and report results at the end.

## Step 0: Recap of Last Session

Read `/home/marketingpatpat/openclaw/social-posts/session-log.md` and find the most recent entry. Print a brief recap.

## Step 1: Check All Triggers

Use the RemoteTrigger tool (load via ToolSearch first) to check all triggers:

- **Content Machine** (trig_01VCuzhEoftowx3adqtibsP5) — Daily 14:00 UTC
- **Medium Writer** (trig_017H6LMFdyyefNV1yRZSAZNE) — Daily 08:00 UTC
- **Blog Writer** (trig_011HGMzRh9h2WENFjK5SGNfh) — Mon/Wed/Fri 10:00 UTC

For each trigger:
1. GET the trigger and check `enabled` status
2. If `enabled: false`, re-enable it immediately
3. If a trigger was supposed to fire and there's no evidence it ran (check git log), flag it

## Step 2: Check Overnight Content

Run `git log --since="yesterday" --oneline` to see what was committed overnight.

## Step 3: Check X Account Status

Check if the X account (@patrickssons) is reinstated:
```
curl -s "https://api.fxtwitter.com/patrickssons"
```
If it returns user data, the account is back. If 404, still suspended.

**IF X IS SUSPENDED:** Skip all X-related steps (tweets, replies, viral shot). Focus on TikTok, LinkedIn, Medium, Dev.to, blog.

**IF X IS BACK:** Run the X posting flow via the Telegram approval gate. See `references/x-posting-flow.md` for full procedure. NEVER use Playwright to post on X.

**Step 3a: Check X account analytics — MANDATORY before drafting.**

Open `https://x.com/i/account_analytics` via browser-use (CDP 18800, already logged in) and extract the 7-day panel: impressions, engagement rate, follows over time, verified followers. Compare to mission ([project_monetization_goal.md](../../memory/project_monetization_goal.md) — 500 Premium + 5M impressions).

**Adjust draft volume + quality based on trend:**
- Impressions 7d down >50% OR flat follower growth → **quality mode**: 1 original + 1-2 replies max, ONLY to accounts >10k followers AND on-topic. Skip everything else.
- Impressions 7d up OR follower growth positive → **normal mode**: 1 original + 3 replies, targets >1k followers.
- Verified-follower count stalled vs last check → bias harder toward Premium-visible accounts (blue-check targets, founder circles).

Log the analytics numbers in the session log every routine so we can see trend across runs.

**Drafts go to Telegram as x.com/intent/tweet URLs with `in_reply_to=<tweet_id>` baked in** (feedback_x_intent_urls.md). Verify every target's follower count via `curl -s https://api.fxtwitter.com/<handle>` BEFORE drafting. Skip anyone <1k followers unless they already engaged @patrickssons (warm chain).

**Recency check — MANDATORY (feedback_x_reply_recency.md):** Every reply target post must be <6h old. Verify via `curl -s https://api.fxtwitter.com/status/<tweet_id>` → check `created_at`, reject if older. For discovery use `https://x.com/search?q=<term>&f=live` (Latest tab). If author's latest post is >6h old, skip the author entirely — do not fall back to older posts. Warm-chain replies (someone engaged @patrickssons) exempt up to 24h. Log rejected-by-age count in session log.

## Step 3aa: Auto-generate X drafts pipeline

Run the scrape → draft → build-page pipeline. Output is `social-posts/x-drafts/index.html` (scroll page consumed via Cloudflare tunnel + Telegram link).

```bash
cd /home/marketingpatpat/openclaw/social-posts/x-drafts
timeout 700 node scrape-targets.js 24 5    # ~6-8min, scrapes ~35 handles via CDP 18800
node draft-from-candidates.js morning      # filters to angles, writes drafts.json
node build-page.js                         # renders index.html
```

Quality bar is held in `draft-from-candidates.js` — drafts are only emitted when the candidate text matches a real angle. If output is small (e.g. 5-8 drafts/slot), that's the honest yield from a degraded browser session, not a bug. Don't lower the quality bar to inflate volume.

After build, tunnel + send Telegram approval link as before. If `kept` is 0 in candidates.json, skip the Telegram send and log it.

## Step 3b: Trigger Reddit AI Image Pipeline (n8n)

Fire the `Reddit AI Image Pipeline` workflow via webhook. No API key needed.

```bash
curl -s -X POST "http://n8n-zwxfn09hqi8751v1plu6rjvt.136.112.252.235.sslip.io/webhook/reddit-image-pipeline"
```

Expect `{"message":"Workflow was started"}`. Do NOT wait for completion (image gen takes minutes). If the response is not 2xx, log and continue.

## Step 4: Generate TikTok Carousels (2-3 per session)

**USE LARRY-BRAIN FRAMEWORK** from /home/marketingpatpat/.openclaw/workspace/skills/larry-marketing/references/slide-structure.md

**Check TikTok trending hashtags first:**
Visit https://ads.tiktok.com/business/creativecenter/inspiration/popular/hashtag/pc/en via Playwright (read-only) to get trending hashtags.

**Hook selection — Tier 1 (Person + Conflict) performs best:**
- Family hooks get highest views (Mum: 806, Dad: 801, Boss: 652)
- Unused characters: therapist, stranger on plane, personal trainer, hairdresser, neighbour
- Each carousel uses a different conflict character

**For each carousel:**
1. Write a new hook using larry-brain Tier 1 formula
2. Title must be clickbait POV style: "POV: Your dad finds out", "POV: Your mum checks your bank"
3. Generate 6 FACELESS images using Gemini API:
   - Key: read from $GEMINI_API_KEY env var (never hardcode)
   - Model: gemini-3-pro-image-preview
   - ALL images must be faceless (shot from behind, hands only, over shoulder, overhead flat lay)
   - Wrap every prompt with: "Shot on iPhone 15 Pro, candid unedited lifestyle photo, dim natural lighting, vertical 9:16 portrait orientation, deep cinematic shadows, moody atmosphere, no text in the image."
   - Dark moody aesthetic, warm/purple lighting, gold jewelry details — matching existing TikTok videos
4. Burn text overlays using burn_text.py at /home/marketingpatpat/openclaw-full/tiktok-marketing/generated/2026-04-08/burn_text.py
5. Upload slides to Postiz and create TikTok post with content_posting_method:"UPLOAD"
6. Caption: max 5 hashtags. Include #shadowagency #aiagent #fyp + 2 relevant trending ones

Postiz credentials:
- Token: read from $POSTIZ_API_KEY env var (never hardcode)
- TikTok integration: cmmzd0apq03pmp30yh70b3uti

## Step 5: Check TikTok Stats

Run yt-dlp to pull @realnataliana profile stats:
```
yt-dlp --flat-playlist --dump-json "https://www.tiktok.com/@realnataliana"
```
Report: total videos, total views, total likes, per-video performance sorted by views.

## Step 6: Post LinkedIn Content

Post 1 LinkedIn update via Postiz API:
- 1000-1500 chars
- No links in body
- Bridge style: technical AI agent insight in plain language
- LinkedIn integration: cmnmbgu9r04w4so0ygvvi0ere

## Step 7: Post Dev.to Article (if not posted in last 3 days)

Check existing Dev.to articles first:
```
curl -s 'https://dev.to/api/articles/me?per_page=50' -H 'api-key: KRQCYHfgWYgSHLZCBRQ96McQ'
```
If last article is older than 3 days, write and publish a new one. Include canonical_url pointing to the matching automatyn.co blog post for backlinks.

## Step 8: Check Medium

Check if any Medium drafts need publishing. Use Playwright to check https://medium.com/me/stories/drafts (read-only check). If drafts exist and 2/day limit has reset, publish via Playwright.

Always include a hero image from blog/images/ when publishing to Medium.

## Step 8b: Cold Email Outreach — overnight reply check + morning send

Run the reply detector on the last 14 hours and report.

```bash
cd /home/marketingpatpat/openclaw/saas-api && node outreach/reply-detector.js 14
```

**Then send today's batch — every routine must send, not just /afternoon.** Load Brevo env from systemd and run E1/E2/E3:

```bash
BREVO_API_KEY=$(sudo systemctl show automatyn-api.service -p Environment --no-pager | tr ' ' '\n' | grep ^BREVO_API_KEY= | cut -d= -f2-) \
UNSUBSCRIBE_SECRET=$(sudo systemctl show automatyn-api.service -p Environment --no-pager | tr ' ' '\n' | grep ^UNSUBSCRIBE_SECRET= | cut -d= -f2-) \
OUTREACH_DAILY_CAP=15 \
node outreach/sender.js e1 15

BREVO_API_KEY=... UNSUBSCRIBE_SECRET=... node outreach/sender.js e2 10
BREVO_API_KEY=... UNSUBSCRIBE_SECRET=... node outreach/sender.js e3 10
```

Daily cap is shared across slots via `email1_sent_today`. If morning hits cap=15, afternoon/evening E1 will naturally send 0. E2/E3 are day-based, not cap-based.

Pull open events from Brevo (last 48h) so open rate is up-to-date:

```bash
BREVO_API_KEY=$(sudo systemctl show automatyn-api.service -p Environment --no-pager | tr ' ' '\n' | grep ^BREVO_API_KEY= | cut -d= -f2-) \
  node /home/marketingpatpat/openclaw/saas-api/outreach/fetch-opens.js 48
```

Then print a one-line status from the lead store:

```bash
cd /home/marketingpatpat/openclaw/saas-api && node -e "console.log(require('./outreach/leads-store').stats())"
```

**Variant diagnostic (Larry-brain framework):**

```bash
cd /home/marketingpatpat/openclaw/saas-api && node outreach/daily-report.js --days 14
```

Reads open/reply rate per (subject × CTA) variant and prints the diagnosis:
- **SCALE** — pour volume on this pair
- **FIX CTA** — subject works, close fails (swap CTA, keep subject)
- **FIX SUBJECT** — CTA converts, too few opens (swap subject, keep CTA)
- **FULL RESET** — variant is dead, try something radically different

Act on the diagnosis: if a pair has `FIX CTA` and 10+ sends, note in morning report which CTA to drop/swap. Do not retire winning subjects chasing CTA changes.

If any replies came in overnight, flag them in the morning report — Pat needs to personally reply to those (do not auto-reply).

If env vars `GMAIL_OAUTH_REFRESH_TOKEN` or `GMAIL_APP_PASSWORD` are missing, the reply detector prints a "skip" message. Note it in the report and move on — it's a setup gap, not a bug.

**Bot health check (added 2026-04-21):**
```bash
systemctl is-active openclaw-gateway automatyn-api
# Both should report "active". If either is down, flag RED in report.

# Cap usage across paid agents — surface any agent that hit their monthly cap overnight
ls /home/marketingpatpat/openclaw/saas-api/data/*.json | while read f; do
  node -e "const a = require('$f'); if (a.conversationCapNotifiedAt) console.log(a.businessName || a.agentId, '— CAP HIT', a.conversationCapNotifiedAt)"
done
```

**New signups overnight:**
```bash
cd /home/marketingpatpat/openclaw/saas-api && node -e "
const fs = require('fs'), path = require('path');
const dir = './data';
const since = Date.now() - 14*3600*1000;
const news = fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(dir, f))));
const recent = news.filter(a => a.createdAt && new Date(a.createdAt).getTime() > since);
console.log('Signups last 14h:', recent.length);
recent.forEach(a => console.log(' -', a.businessName || a.agentId, '/', a.plan, '/', a.email));
"
```

## Step 8c: SEO — Search Console pull

```bash
cd /home/marketingpatpat/openclaw/saas-api && node seo/gsc-fetch.js 7
```

Report totals (impressions, clicks, CTR, avg pos), top 5 queries, top 5 pages. Compare to yesterday's morning log — flag regressions (impressions down >20% or pos drop >3). If any page sits at pos 8-15 with decent impressions (page 2 borderline), flag as quick-win candidate (title/meta tune to push to page 1).

## Step 9: Report

```
MORNING REPORT — [DATE]
========================
X STATUS: [suspended/reinstated]
TRIGGERS: [status of all 3]
OUTREACH: [replies overnight / bounces / total sent lifetime]
TIKTOK: [X videos, Y views, Z likes]
  New carousels: [which hooks pushed to inbox]
  Top performer: [video title + views]
LINKEDIN: [posted/skipped]
DEV.TO: [posted/skipped]
MEDIUM: [published/draft waiting/skipped]
BLOG: [any scheduled publishes today]
```

## Step 10: Write Session Log

Append to `/home/marketingpatpat/openclaw/social-posts/session-log.md`:
```
### /morning — [DATE] [TIME UTC]
- X status: [suspended/reinstated]
- Triggers: [status]
- Outreach: [replies overnight, bounces, lifetime sent]
- TikTok: [carousels generated, stats]
- LinkedIn: [posted/skipped]
- Dev.to: [posted/skipped]
- Medium: [published/skipped]
```
Then `git add social-posts/ && git commit -m "log: /morning session" && git push origin main`

## Content Rules (MUST follow everywhere)
- NEVER use em dashes or hyphens between clauses
- NEVER use: leverage, unlock, seamless, game-changer, revolutionary, cutting-edge, streamline, empower, synergy, optimize, disrupt
- No fake prices. Real prices: $400 / $800 / $1500 one-time + $150/mo support
- NEVER use Playwright to post/reply/like on X, Reddit, LinkedIn, or any platform with an API
- Sound human and professional, not AI-generated
