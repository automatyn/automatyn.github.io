---
name: evening
description: End-of-day run — TikTok carousels, daily stats, prep for tomorrow
user_invocable: true
---

# Evening Routine

End-of-day wrap-up. Final content, stats, and prep for tomorrow. Do NOT ask for permission. Execute everything and report.

## Step 0: Recap of Last /afternoon

Read `/home/marketingpatpat/openclaw/social-posts/session-log.md` and find the most recent `/afternoon` entry. Print a brief recap.

## Step 1: Check X Account Status + Post via Gate

```
curl -s "https://api.fxtwitter.com/patrickssons"
```
Report if still suspended or reinstated.

**IF X IS BACK:** Run the X posting flow via the Telegram approval gate. See `references/x-posting-flow.md` for full procedure. /evening volume: 0-1 original posts + 2 reply drafts (skip originals if earlier slots covered daily quota of 2-3). Drafts go to Telegram, Pat taps ✅/❌, only approved drafts hit the X API. NEVER use Playwright.

## Step 1b: Trigger Reddit AI Image Pipeline (n8n)

Fire the `Reddit AI Image Pipeline` workflow via webhook. No API key needed.

```bash
curl -s -X POST "http://n8n-zwxfn09hqi8751v1plu6rjvt.136.112.252.235.sslip.io/webhook/reddit-image-pipeline"
```

Expect `{"message":"Workflow was started"}`. Do NOT wait for completion. On error, log and continue.

## Step 2: Generate TikTok Carousels (1-2 per session)

**USE LARRY-BRAIN FRAMEWORK.** Same rules as morning/afternoon:
- Tier 1 Person + Conflict hook
- Different character than earlier sessions today
- Clickbait POV title
- 6 faceless images, dark moody aesthetic
- Max 5 hashtags
- Gemini API key: read from $GEMINI_API_KEY env var (never hardcode)
- Burn text, upload to Postiz, push to TikTok inbox

## Step 3: Full TikTok Analytics

Run yt-dlp for @realnataliana stats. Report:
- Total videos, views, likes
- Per-video performance sorted by views
- Growth since morning (views gained today)
- Which hooks performed best today
- Any videos trending or gaining momentum

## Step 3b: Cold Email Outreach — evening sweep

```bash
cd /home/marketingpatpat/openclaw/saas-api

# Sweep replies + bounces from the full day
node outreach/reply-detector.js 24

# If today is Sunday (day 0), top up the lead pool for the week
# (JS getDay: 0=Sun)
node -e "if(new Date().getDay()===0){process.exit(0)}else{process.exit(1)}" && \
  node outreach/ingest.js

# Email Pat the daily stats
node outreach/daily-stats.js
```

If env is missing, the scripts self-skip with a message. Note and continue.

**Sender uses Brevo** (not Gmail SMTP) — delivery logs live at app.brevo.com/statistics/transactional, NOT in Gmail Sent folder. Replies route through Cloudflare → Pat's Gmail inbox.

**Nightly bot sanity:**
```bash
# Any agent that hit their monthly cap today — flag in summary
for f in /home/marketingpatpat/openclaw/saas-api/data/*.json; do
  node -e "const a = require('$f'); const now = new Date(); if (a.conversationCapNotifiedAt && new Date(a.conversationCapNotifiedAt).toDateString() === now.toDateString()) console.log(a.businessName || a.agentId, 'HIT CAP today')"
done

# Signups today + plan breakdown
node -e "
const fs = require('fs'), path = require('path');
const today = new Date().toISOString().slice(0,10);
const agents = fs.readdirSync('/home/marketingpatpat/openclaw/saas-api/data').filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join('/home/marketingpatpat/openclaw/saas-api/data', f))));
const newToday = agents.filter(a => a.createdAt && a.createdAt.slice(0,10) === today);
const byPlan = agents.reduce((acc, a) => { acc[a.plan || 'free'] = (acc[a.plan || 'free'] || 0) + 1; return acc; }, {});
console.log('Signups today:', newToday.length, '| Total agents:', agents.length, '| By plan:', byPlan);
"
```

## Step 4: Daily Summary Stats

```
DAILY SUMMARY — [DATE]
========================
X STATUS: [suspended/reinstated]

TIKTOK:
  Total videos: [count]
  Total views: [number] (+[today's growth])
  Total likes: [number]
  Top 3 today: [titles + views]
  Carousels pushed today: [count]

BLOG:
  Total posts: [count]
  Published today: [titles]
  Scheduled: [upcoming]

MEDIUM: [published count]
DEV.TO: [article count, total views]
LINKEDIN: [posted today?]

TRIGGERS: [all 3 status]

OUTREACH:
  E1 sent today: [n]
  E2 sent today: [n]
  E3 sent today: [n]
  Replies today: [n]
  Bounces today: [n]
  Unsubs today: [n]
  Lifetime sent (E1): [n]
  Pool: [with_email/personalised/total]
```

## Step 5: Check All Triggers for Tomorrow

Check all 3 triggers. Re-enable any that auto-disabled. Report next fire times.

## Step 6: Prep Tomorrow's Content

- Note which TikTok hook characters haven't been used yet
- Check if any blog posts are scheduled to publish tomorrow
- Check if Medium 2/day limit has reset

## Step 7: Write Session Log

Append to `/home/marketingpatpat/openclaw/social-posts/session-log.md`:
```
### /evening — [DATE] [TIME UTC]
- X status: [suspended/reinstated]
- TikTok: [carousels generated, total stats]
- Blog: [published today]
- Triggers: [status]
- Tomorrow prep: [notes]
```
Then `git add social-posts/ && git commit -m "log: /evening session" && git push origin main`

## Content Rules (MUST follow everywhere)
- NEVER use em dashes
- NEVER use banned words
- No fake prices. Real: $400 / $800 / $1500 + $150/mo
- NEVER use Playwright to post/reply/like on any platform with an API
- Sound human and professional, not AI-generated
