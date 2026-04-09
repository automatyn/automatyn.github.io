---
name: evening
description: End-of-day run — final replies, daily stats, prep tomorrow's carousel, daily summary
user_invocable: true
---

# Evening Routine

End-of-day wrap-up. Final engagement, stats, and prep for tomorrow. Do NOT ask for permission. Execute everything and report.

## Step 0: Recap of Last /afternoon

Read `/home/marketingpatpat/openclaw/social-posts/session-log.md` and find the most recent `/afternoon` entry. Print a brief recap:
```
RECAP FROM LAST /afternoon:
  [summary: trigger status, replies count, TikTok delta, trending topics]
```
If no afternoon entry exists, skip and note "No previous afternoon session found."

## Step 1: Scan Trending Topics + Reply to 7 Tweets

**TRENDING SCAN (do this BEFORE writing any replies):**
Connect to Chrome browser via Playwright CDP on port 18800. Visit these 3 URLs and extract trending topics:
1. https://x.com/explore/tabs/trending
2. https://x.com/explore/tabs/news
3. https://x.com/explore/tabs/for_you

Extract top 20 trending topics. Use relevant ones as piggyback hooks in replies where there's a natural bridge to AI agents / automation / small business.

**REPLY SCAN:**
Navigate to https://x.com/home. Scroll through the feed and extract tweets.

**DEDUP SYSTEM (CRITICAL):**
Before writing ANY reply, read the reply log at `/home/marketingpatpat/openclaw/social-posts/reply-log.md`.
- Do NOT reply to any tweet URL already in the log
- Do NOT reply to any user you've already replied to in the last 24 hours
- Do NOT reply to your own tweets (@patrickssons)
- Do NOT reply to ads/promoted tweets
- After posting each reply, IMMEDIATELY append to the log file
- Format: `- [DATE] | @handle | status_url | first 60 chars of your reply`

**REPLY SELECTION (pick 7):**
Filter for tweets relevant to Automatyn's mission:
- AI agents, chatbots, automation
- Small business struggles (DMs, customer support, hiring VAs)
- Side hustles, passive income, indie hacking
- AI industry news (model launches, tool comparisons)
- "Who's building X" or "drop your link" threads
- Hot takes about work culture, 9-5, entrepreneurship

Skip: ads, crypto, pure memes, tweets <100 chars, tweets older than 48 hours, anyone already replied to today.

**REPLY STYLE:**
- MAXIMUM CONTROVERSY optimised for reach, views, followers, and conversions
- Contrarian: challenge what people believe
- MUST be optimised for Automatyn's mission: position Pat as the person who knows how AI agents actually work for small businesses
- Bridge to AI agent expertise where natural
- Do NOT pitch Automatyn directly. Let the profile do the selling.
- Under 200 chars per reply
- Sound human, not like a bot
- Space replies 5-10 minutes apart (use time.sleep(300) to time.sleep(600), vary randomly)

**HOW TO POST:**
1. Connect to Chrome via CDP: `p.chromium.connect_over_cdp("http://127.0.0.1:18800")`
2. Navigate to tweet URL
3. Grant clipboard: CDP `Browser.grantPermissions` with `clipboardReadWrite`
4. Click reply box `[data-testid="tweetTextarea_0"]`
5. Paste via clipboard + Ctrl+V
6. Click `[data-testid="tweetButtonInline"]` to post
7. Append to reply-log.md

## Step 2: Full Daily Stats + Monetization Tracking

**X MONETIZATION PROGRESS (CRITICAL — check every evening):**
Connect to Chrome via Playwright CDP. Navigate to https://x.com/i/account_analytics
1. Click "3M" button to see 3-month view
2. Screenshot and read the total impression count
3. Also check follower count via fxtwitter: `curl -s "https://api.fxtwitter.com/patrickssons"`
4. Report progress toward:
   - 500 Premium followers (target)
   - 5,000,000 impressions in 3 months (target)
   - Daily impression rate vs required ~62,000/day
   - Days remaining in current 3-month window
   - Projected date to hit 5M at current rate (be honest, even if it's far away)

**TikTok:**
Run yt-dlp --flat-playlist --dump-json "https://www.tiktok.com/@realnataliana"
Report: total videos, followers, total likes, per-video view counts.

**X/Twitter:**
Check Postiz API for all posts from today:
```
GET /public/v1/posts?startDate=[today]T00:00:00Z&endDate=[tomorrow]T00:00:00Z&display=week
```
Report: how many tweets posted, states (PUBLISHED/ERROR/QUEUE), any failures.

**Blog:**
Check git log for any new blog commits today. Report which posts went live.

## Step 3: Prep Tomorrow's TikTok Carousel

1. Read NEXT_HOOKS.md at `/home/marketingpatpat/.openclaw/workspace/tiktok-marketing/NEXT_HOOKS.md`
2. Identify the next ungenerated hook
3. Generate 6 images using gemini-3-pro-image-preview (fallback chain: gemini-3.1-flash-image-preview → imagen-4.0-ultra-generate-001 → Pollinations.ai)
   - Key: AIzaSyAClRSDCnpG4eH-roWwpAIHeXRmk26CeG8
   - Prompt prefix: "Shot on iPhone 15 Pro, candid unedited lifestyle photo, dim natural lighting, raw low-light iPhone photography, vertical 9:16 portrait orientation, deep cinematic shadows, moody atmosphere, no text in the image."
4. Burn text overlays using burn_text.py (Roboto-Bold, subtle shadow, 47% from top)
5. Upload to Postiz and push to TikTok inbox (type:"now", content_posting_method:"UPLOAD")
6. Copy finals to gdrive for Pat to review in the morning
7. Mark hook as GENERATED in NEXT_HOOKS.md

This way Pat wakes up with a carousel already in TikTok inbox, ready to review and publish.

## Step 4: Check All Triggers for Tomorrow

Use RemoteTrigger tool to verify all 3 triggers are enabled:
- Content Machine (trig_01VCuzhEoftowx3adqtibsP5)
- Medium Writer (trig_017H6LMFdyyefNV1yRZSAZNE)
- Blog Writer (trig_011HGMzRh9h2WENFjK5SGNfh)

Re-enable any that auto-disabled. Report next fire times.

## Step 5: Commit and Push Daily Logs

```
git add social-posts/
git commit -m "content: daily log [DATE]"
git push origin main
```

## Step 6: Daily Summary Report

```
DAILY SUMMARY — [DATE]
========================
CONTENT PRODUCED:
  Blog posts: [count + titles]
  Tweets: [count standalone + count replies = total]
  LinkedIn: [count]
  Dev.to: [count]
  TikTok carousels: [count generated + count posted]
  Medium drafts: [count]

ENGAGEMENT:
  Total replies posted today: [count from reply-log.md for today]
  TikTok followers: [current] (delta: [+/-])
  TikTok total views: [current] (delta: [+/-])

TRIGGERS:
  Content Machine: [status, next fire]
  Medium Writer: [status, next fire]
  Blog Writer: [status, next fire]

TOMORROW PREP:
  TikTok carousel: [which hook, status]
  Triggers: [all enabled Y/N]

MONETIZATION PROGRESS:
  Followers: [current] / 500 Premium target
  3M impressions: [current] / 5,000,000 target
  Daily avg impressions: [current] / 62,000 needed
  Projected milestone date: [at current rate]
  Top performing tweet today: [which one + impression count if visible]

PRIORITY REMINDER:
  Two parallel goals:
  1. Get a paying client (DMs + calls booked via automatyn.co)
  2. Hit X monetization (500 Premium followers + 5M impressions)
  Every reply, tweet, and viral shot serves both goals.
```

## Step 7: Write Session Log

Append to `/home/marketingpatpat/openclaw/social-posts/session-log.md`:
```
### /evening — [DATE] [TIME UTC]
- Replies: [count] to [@handle1, @handle2, ...]
- TikTok stats: [followers, total views, total likes]
- X stats: [followers, 3M impressions estimate]
- Tomorrow's carousel: [which hook, status]
- Triggers: [all 3 status + next fire times]
- Total replies today: [sum from all 3 sessions via reply-log.md]
- Monetization: [followers]/500, [impressions]/5M
```
Then `git add social-posts/ && git commit -m "log: /evening session" && git push origin main`
