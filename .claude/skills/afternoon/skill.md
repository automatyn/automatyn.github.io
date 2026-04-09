---
name: afternoon
description: Midday engagement run — reply to 7 tweets, check triggers, light content check
user_invocable: true
---

# Afternoon Routine

Midday engagement and monitoring run. Do NOT ask for permission. Execute everything and report.

## Step 1: Check Content Machine Trigger

The Content Machine trigger fires at 14:00 UTC daily. Use RemoteTrigger tool (load via ToolSearch) to check trigger `trig_01VCuzhEoftowx3adqtibsP5`:
- Is it still enabled?
- Did it fire? Check git log for new commits in `/social-posts/` since this morning
- If it auto-disabled, re-enable it immediately

## Step 2: Reply to 7 Tweets from Feed

Connect to Chrome browser via Playwright CDP on port 18800. Navigate to https://x.com/home. Scroll through the feed and extract tweets.

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
- MUST be optimised for Automatyn's mission: position Pat as the person who knows how AI agents actually work for small businesses. Reader thinks "this guy knows his stuff, let me check his profile"
- Bridge to AI agent expertise where natural: "the setup file matters more than the model", "most bots fail because nobody wrote the rules", "the configuration is the product", "90 minutes of thinking beats 90 days of coding"
- Do NOT pitch Automatyn directly. Let the profile do the selling.
- Under 200 chars per reply
- Sound human, not like a bot
- Space replies 5-10 minutes apart (use time.sleep(300) to time.sleep(600) between posts, vary randomly)

**HOW TO POST:**
1. Connect to Chrome via CDP: `p.chromium.connect_over_cdp("http://127.0.0.1:18800")`
2. Navigate to tweet URL
3. Grant clipboard: CDP `Browser.grantPermissions` with `clipboardReadWrite`
4. Click reply box `[data-testid="tweetTextarea_0"]`
5. Paste via clipboard + Ctrl+V
6. Click `[data-testid="tweetButtonInline"]` to post
7. Append to reply-log.md

## Step 3: Quick Stats Check

Run yt-dlp to pull @realnataliana TikTok stats:
```
yt-dlp --flat-playlist --dump-json "https://www.tiktok.com/@realnataliana"
```
Report any changes since morning (new views, new likes, new followers).

## Step 4: Report

```
AFTERNOON REPORT — [DATE]
==========================
Content Machine trigger: [status]
Replies posted: [count + handles]
TikTok delta: [any view/like/follower changes]
Next actions: [run /evening later today]
```
