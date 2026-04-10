---
name: morning
description: Daily morning routine — check triggers, post content, generate TikTok carousel, report status
user_invocable: true
---

# Morning Routine

Run the full daily marketing automation check and content production. Do NOT ask for permission on any step. Execute everything and report results at the end.

## Step 0: Recap of Last /evening

Read `/home/marketingpatpat/openclaw/social-posts/session-log.md` and find the most recent `/evening` entry. Print a brief recap:
```
RECAP FROM LAST /evening:
  [summary of what was done: replies posted, stats, carousel prepped, triggers status]
```
If no evening entry exists, skip and note "No previous evening session found."

## Step 1: Check All Triggers

Use the RemoteTrigger tool (load via ToolSearch first) to check all 3 triggers:

- **Content Machine** (trig_01VCuzhEoftowx3adqtibsP5) — Daily 14:00 UTC, 6 tweets + LinkedIn + Dev.to
- **Medium Writer** (trig_017H6LMFdyyefNV1yRZSAZNE) — Daily 08:00 UTC, 2 article drafts
- **Blog Writer** (trig_011HGMzRh9h2WENFjK5SGNfh) — Mon/Wed/Fri 10:00 UTC

For each trigger:
1. GET the trigger and check `enabled` status
2. If `enabled: false`, re-enable it immediately
3. Check `next_run_at` and report when it fires next
4. If a trigger was supposed to fire today and there's no evidence it ran (check git log), flag it

## Step 2: Check Overnight Content

Run `git log --since="yesterday" --oneline` to see what was committed overnight by triggers. Report:
- Did any new blog posts appear in `/blog/`?
- Did any new social posts appear in `/social-posts/`?
- Did any new medium drafts appear in `/medium-drafts/`?

If nothing was committed overnight and triggers were supposed to fire, the triggers failed silently.

## Step 3: Manual Content if Triggers Failed

If the Content Machine trigger didn't fire (no new tweets/LinkedIn/Dev.to from overnight):
1. Write 6 tweets following the bridge-style rules (under 200 chars each, check Postiz API for last 7 days of tweets to avoid duplicates, space 2 hours apart)
2. Write 1 LinkedIn post (1000-1500 chars, no links in body)
3. Write 1 Dev.to article (1000-2000 words, include User-Agent header on publish)
4. Post all via Postiz API and Dev.to API
5. Log everything to `/social-posts/YYYY-MM-DD-*.md`
6. Commit and push

Content rules (MUST follow):
- NEVER use em dashes or hyphens between clauses
- NEVER use: leverage, unlock, seamless, game-changer, revolutionary, cutting-edge, streamline, empower, synergy, optimize, disrupt
- NEVER use tech jargon in tweets: LLM, API, self-hosted, SOUL.md, AGENTS.md, BOOTSTRAP.md, prompt engineering
- No fake prices. Real prices: $400 / $800 / $1500 one-time + $150/mo support
- Mon-Thu: ZERO links in tweets. Friday: one automatyn.co link allowed
- NEVER post tweets seconds apart. Space them 2+ hours via schedule type

Postiz credentials:
- Token: 3991893608a82e890e652dc586fbf227e46d37647533419980e05d3681e7fa26
- X integration: cmnm0tq8603x8so0y5vibctng
- LinkedIn integration: cmnmbgu9r04w4so0ygvvi0ere
- TikTok integration: cmmzd0apq03pmp30yh70b3uti
- Dev.to API key: KRQCYHfgWYgSHLZCBRQ96McQ (include User-Agent: automatyn-bot/1.0 header)

## Step 4: Generate Next TikTok Carousel

1. Read `/home/marketingpatpat/.openclaw/workspace/tiktok-marketing/NEXT_HOOKS.md` for the latest carousel scripts
2. Pick the next PENDING hook (skip any already generated or posted)
3. Generate 6 images using `gemini-3-pro-image-preview` via Gemini API:
   - Key: AIzaSyAClRSDCnpG4eH-roWwpAIHeXRmk26CeG8
   - Endpoint: https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image-preview:generateContent
   - Wrap every prompt with: "Shot on iPhone 15 Pro, candid unedited lifestyle photo, dim natural lighting, raw low-light iPhone photography, vertical 9:16 portrait orientation, deep cinematic shadows, moody atmosphere, no text in the image."
   - If gemini-3-pro rate-limits, fallback to gemini-3.1-flash-image-preview, then imagen-4.0-ultra-generate-001 via predict endpoint, then Pollinations.ai (https://image.pollinations.ai/prompt/...)
4. Burn text overlays using the burn_text.py script at /home/marketingpatpat/openclaw-full/tiktok-marketing/generated/2026-04-08/burn_text.py (uses Roboto-Bold.ttf, subtle shadow, 47% from top, 4.8% width font)
5. Upload all 6 slides to Postiz via POST /public/v1/upload
6. Create TikTok post with type:"now", content_posting_method:"UPLOAD" (sends to TikTok inbox for manual review)
7. Copy final images to gdrive for Pat to review

## Step 5: Check TikTok Stats

Run yt-dlp to pull @realnataliana profile stats:
```
yt-dlp --flat-playlist --dump-json "https://www.tiktok.com/@realnataliana"
```
Report: total videos, total views, total likes, followers, and per-video performance for any new videos since last check.

## Step 6: Scan Trending Topics + Reply to 7 Tweets

**TRENDING SCAN (do this BEFORE writing any replies or tweets):**
Connect to Chrome browser via Playwright CDP on port 18800. Visit these 3 URLs and extract trending topics/keywords:
1. https://x.com/explore/tabs/trending
2. https://x.com/explore/tabs/news
3. https://x.com/explore/tabs/for_you

For each page, extract the visible trending topic names/headlines. Save the top 20 trending topics to a variable. Then when writing replies and the standalone tweet, actively try to piggyback on relevant trending words/topics that can bridge to AI agents, automation, small business, or side hustles. Example: if "OpenAI" or "Stargate" or "remote work" is trending, weave it into a reply naturally.

Not every trend will be relevant. Only use trends that have a natural bridge to the Automatyn mission. Skip politics, wars, sports, celebrity drama unless there's a clean business/AI angle.

**REPLY SCAN:**
Navigate to https://x.com/home. Scroll through the feed and extract tweets.

**DEDUP SYSTEM (CRITICAL):**
Before writing ANY reply, read the reply log at `/home/marketingpatpat/openclaw/social-posts/reply-log.md`. This file tracks every reply you've ever posted. Format per entry:
```
- [DATE] | @handle | status_url | first 60 chars of your reply
```
- Do NOT reply to any tweet URL already in the log
- Do NOT reply to any user you've already replied to in the last 24 hours (check the log dates)
- Do NOT reply to your own tweets (@patrickssons)
- Do NOT reply to ads/promoted tweets
- After posting each reply, IMMEDIATELY append to the log file

**REPLY SELECTION (pick 7):**

PRIORITY TARGETS (these drive 500x more impressions than original tweets):
- TIER 1 (reply to these FIRST): Viral tweets about remote jobs, quitting 9-5, making money, side income, "I quit my job", work from home, passive income, freelancing. These are the highest impression bridges. The Apr 6 spike (11K impressions from ONE reply) came from a trending remote jobs tweet.
- TIER 2: AI agents, chatbots, automation, AI replacing jobs, AI industry news (model launches, tool comparisons)
- TIER 3: Small business struggles (DMs, customer support, hiring VAs), indie hacking
- TIER 4: "Who's building X" or "drop your link" threads, hot takes about work culture

Also search X for trending keywords: "remote work", "quit my job", "side hustle", "passive income", "making money online", "AI jobs". These trending topics get massive reach.

PRIORITY: big accounts (50K+ followers) with fresh tweets (under 1 hour). One reply on a 100K follower account's viral tweet about jobs = more impressions than 100 original tweets.

Skip: ads, crypto, pure memes with no hook, tweets with <100 chars (low engagement potential), tweets older than 2 hours. FRESHNESS IS CRITICAL — 80% of reply impressions happen in the first 30 minutes. Prioritize tweets under 1 hour old. Sort by newest first.

**REPLY STYLE:**
- Maximum controversy optimised for views, followers, conversions
- Contrarian: challenge what people believe
- MUST be optimised for Automatyn's mission: every reply should position Pat as the person who knows how AI agents actually work for small businesses. The reader should think "this guy knows his stuff, let me check his profile"
- Bridge to AI agent setup expertise where natural. Examples of bridges: "the setup file matters more than the model", "most bots fail because nobody wrote the rules", "the configuration is the product", "90 minutes of thinking beats 90 days of coding"
- Do NOT pitch Automatyn directly in replies. Let the profile do the selling. The reply builds authority and curiosity.
- Under 200 chars per reply
- Must sound human, not like a bot
- Space replies 5-10 minutes apart (use time.sleep(300) to time.sleep(600) between Playwright posts, vary randomly so it doesn't look bot-like)

**HOW TO POST (with auto-fix on errors):**

Before ANY Playwright work, run a Chrome health check:
```
ps aux | grep chrome | grep 18800
```
If Chrome is NOT running on port 18800, restart it:
```
/usr/bin/google-chrome-stable --remote-debugging-port=18800 --user-data-dir=/home/marketingpatpat/.openclaw/browser/openclaw/user-data --no-first-run --no-default-browser-check --disable-sync --disable-background-networking --disable-component-update --disable-features=Translate,MediaRouter --disable-session-crashed-bubble --hide-crash-restore-bubble --password-store=basic --disable-dev-shm-usage --disable-blink-features=AutomationControlled --ozone-platform=x11 about:blank &
```
Wait 5 seconds, then proceed.

For EACH reply attempt:
1. Connect to Chrome via CDP: `p.chromium.connect_over_cdp("http://127.0.0.1:18800")`
2. Navigate to tweet URL
3. **CRITICAL SAFETY CHECK: After page loads, verify `page.url` still contains `/status/`. If the URL contains `/compose/` or redirected away from the original tweet, the tweet doesn't exist or is restricted. IMMEDIATELY skip this tweet, close the page, do NOT type anything.**
4. Grant clipboard: CDP `Browser.grantPermissions` with `clipboardReadWrite`
5. Click reply box using ONLY `[data-testid="tweetTextarea_0"]` selector. Do NOT fall back to generic `[contenteditable="true"]` or `[role="textbox"]` because those might match the compose page textbox instead of a reply box.
6. Paste via clipboard + Ctrl+V
7. Click `[data-testid="tweetButtonInline"]` to post. Do NOT fall back to generic button text matching.
8. Append to reply-log.md

**NEVER type into a compose box. NEVER post a new tweet when trying to reply. If anything looks wrong, skip and move on.**

**ERROR RECOVERY (apply to every Playwright step):**
- If CDP connection fails → restart Chrome (command above), wait 5s, retry once
- If reply box not found (`tweetTextarea_0` missing) → X may have changed the selector. Try alternative: `[role="textbox"][contenteditable="true"]`. If still fails, try clicking `[data-testid="reply"]` button first to open the reply modal, then look for the textbox again
- If post button not found (`tweetButtonInline` missing) → try `button` elements with text "Reply" or "Post"
- If clipboard paste fails (permission denied) → fall back to `page.keyboard.type(reply_text)` (slower but no clipboard needed)
- If page.goto times out → skip this tweet, move to next one, log "timeout on [url]"
- If any step throws an unhandled exception → catch it, log the error, skip to next tweet. NEVER let one failed reply crash the entire batch
- After 3 consecutive failures → stop the reply batch, report "Playwright errors, Chrome may need manual restart", continue with remaining non-Playwright steps (stats, logging, etc.)

## Step 7: VIRAL SHOT — 1 Tweet Engineered for 50K+ Impressions

This is NOT a normal tweet. This is a calculated attempt at maximum virality. Different rules.

**VIRAL SHOT FORMULA:**
1. Check the trending topics you scanned in Step 6
2. Pick the ONE trend with the most natural bridge to AI/automation/small business
3. Write a tweet that:
   - Piggybacks on the trending keyword (X boosts tweets mentioning trending terms)
   - Is MAXIMALLY CONTROVERSIAL within that topic (disagree-ers quote-tweet, multiplying reach)
   - Under 200 chars (short = more retweets)
   - Strong opinion, not a question (opinions get quote-tweeted, questions get ignored)
   - Formula: [trending topic] + [contrarian take that makes people uncomfortable] + [one-liner punchline]
4. If NO trend bridges to AI/business, use evergreen viral angles:
   - "MRR is overrated"
   - "Most AI startups are wrappers"
   - "Hiring a VA in 2026 is financial illiteracy"
   - "Your chatbot fails because nobody wrote the rules"
   - "The 9-5 isn't the problem, your side project is"
5. Post via Postiz with type:"now" — immediate, not scheduled. Viral shots must ride the trend window.
6. DO NOT post within 10 minutes of the last reply
7. DO NOT be controversial about wars, politics, religion, or personal attacks. Be controversial about business, AI, work culture, and "make money online"

**GOAL: 50K+ impressions. Most will get 500-2000. One in ten breaks through. That's how you hit 5M in 3 months.**

## Step 8: Post 1 Regular Standalone Tweet

Write and post 1 more standalone tweet (separate from the viral shot). Rules:
- Under 200 chars
- Not a duplicate of anything in last 7 days (check Postiz API first)
- MAXIMUM CONTROVERSY optimised for views, followers, and conversions
- Bridge style: contrarian insight about AI agents for small businesses
- Target audience: small business owners + indie hackers + side hustlers
- DO NOT post within 10 minutes of the viral shot
- DO NOT be controversial about wars, politics, religion, or personal attacks

## Step 9: Report

Print a summary:
```
MORNING REPORT — [DATE]
========================
MONETIZATION PROGRESS:
  Target: 500 Premium followers + 5M impressions (3 months)
  Current followers: [check via fxtwitter API]
  Estimated 3M impressions: [check analytics page]
  Daily impression target: ~62,000/day

Triggers: [enabled/disabled status of all 3]
Overnight content: [what committed]
Manual content: [what I posted if triggers failed]
TikTok carousel: [which hook, pushed to inbox]
TikTok stats: [followers, views, likes]
Replies posted: [count + handles]
Viral shot: [what was posted + trending topic used]
Standalone tweet: [what was posted]
Next actions: [run /afternoon later today]
```

## Step 10: Write Session Log

Append to `/home/marketingpatpat/openclaw/social-posts/session-log.md`:
```
### /morning — [DATE] [TIME UTC]
- Triggers: [status of all 3]
- Content posted: [6 tweets / LinkedIn / Dev.to if manual, or "trigger handled"]
- TikTok: [carousel generated + pushed to inbox, or "skipped"]
- Replies: [count] to [@handle1, @handle2, ...]
- Viral shot: [posted / text summary]
- Standalone tweet: [posted / text summary]
- Impressions today so far: [if available]
- Followers: [current count]
```
Then `git add social-posts/ && git commit -m "log: /morning session" && git push origin main`
