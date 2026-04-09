---
name: afternoon
description: Midday engagement run — reply to 7 tweets, check triggers, light content check
user_invocable: true
---

# Afternoon Routine

Midday engagement and monitoring run. Do NOT ask for permission. Execute everything and report.

## Step 0: Recap of Last /morning

Read `/home/marketingpatpat/openclaw/social-posts/session-log.md` and find the most recent `/morning` entry. Print a brief recap:
```
RECAP FROM LAST /morning:
  [summary: triggers checked, content posted, TikTok carousel, replies count, viral shot, tweet]
```
If no morning entry exists, skip and note "No previous morning session found."

## Step 1: Check Content Machine Trigger

The Content Machine trigger fires at 14:00 UTC daily. Use RemoteTrigger tool (load via ToolSearch) to check trigger `trig_01VCuzhEoftowx3adqtibsP5`:
- Is it still enabled?
- Did it fire? Check git log for new commits in `/social-posts/` since this morning
- If it auto-disabled, re-enable it immediately

## Step 2: Scan Trending Topics + Reply to 7 Tweets

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

Skip: ads, crypto, pure memes, tweets <100 chars, tweets older than 2 hours, anyone already replied to today. FRESHNESS IS CRITICAL — prioritize tweets under 1 hour old. Sort by newest first.

**REPLY STYLE:**
- MAXIMUM CONTROVERSY optimised for reach, views, followers, and conversions
- Contrarian: challenge what people believe
- MUST be optimised for Automatyn's mission: position Pat as the person who knows how AI agents actually work for small businesses. Reader thinks "this guy knows his stuff, let me check his profile"
- Bridge to AI agent expertise where natural: "the setup file matters more than the model", "most bots fail because nobody wrote the rules", "the configuration is the product", "90 minutes of thinking beats 90 days of coding"
- Do NOT pitch Automatyn directly. Let the profile do the selling.
- Under 200 chars per reply
- Sound human, not like a bot
- Space replies 5-10 minutes apart (use time.sleep(300) to time.sleep(600) between posts, vary randomly)

**HOW TO POST (with auto-fix on errors):**

Before ANY Playwright work, run a Chrome health check:
```
ps aux | grep chrome | grep 18800
```
If Chrome is NOT running, restart it:
```
/usr/bin/google-chrome-stable --remote-debugging-port=18800 --user-data-dir=/home/marketingpatpat/.openclaw/browser/openclaw/user-data --no-first-run --no-default-browser-check --disable-sync --disable-background-networking --disable-component-update --disable-features=Translate,MediaRouter --disable-session-crashed-bubble --hide-crash-restore-bubble --password-store=basic --disable-dev-shm-usage --disable-blink-features=AutomationControlled --ozone-platform=x11 about:blank &
```
Wait 5 seconds, then proceed.

For EACH reply:
1. Connect to Chrome via CDP: `p.chromium.connect_over_cdp("http://127.0.0.1:18800")`
2. Navigate to tweet URL
3. **CRITICAL SAFETY CHECK: After page loads, verify `page.url` still contains `/status/`. If URL contains `/compose/` or redirected away, SKIP immediately. Do NOT type anything.**
4. Grant clipboard: CDP `Browser.grantPermissions` with `clipboardReadWrite`
5. Click reply box using ONLY `[data-testid="tweetTextarea_0"]`. No generic fallbacks.
6. Paste via clipboard + Ctrl+V
7. Click `[data-testid="tweetButtonInline"]` to post. No generic fallbacks.
8. Append to reply-log.md

**NEVER type into a compose box. NEVER post a new tweet when trying to reply.**

**ERROR RECOVERY:**
- CDP connection fails → restart Chrome, wait 5s, retry once
- Reply box not found → try `[role="textbox"][contenteditable="true"]`, or click `[data-testid="reply"]` first
- Post button not found → try `button` with text "Reply" or "Post"
- Clipboard fails → fall back to `page.keyboard.type(reply_text)`
- Page timeout → skip tweet, move to next
- Any unhandled exception → catch, log, skip to next tweet
- 3 consecutive failures → stop reply batch, report error, continue other steps

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

## Step 5: Write Session Log

Append to `/home/marketingpatpat/openclaw/social-posts/session-log.md`:
```
### /afternoon — [DATE] [TIME UTC]
- Content Machine trigger: [fired / failed / re-enabled]
- Replies: [count] to [@handle1, @handle2, ...]
- TikTok delta: [any changes]
- Trending topics used: [list]
```
Then `git add social-posts/ && git commit -m "log: /afternoon session" && git push origin main`
