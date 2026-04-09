---
name: morning
description: Daily morning routine — check triggers, post content, generate TikTok carousel, report status
user_invocable: true
---

# Morning Routine

Run the full daily marketing automation check and content production. Do NOT ask for permission on any step. Execute everything and report results at the end.

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

## Step 6: Reply to 7 Tweets from Feed

Connect to Chrome browser via Playwright CDP on port 18800. Navigate to https://x.com/home. Scroll through the feed and extract tweets.

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
Filter feed tweets for relevance to Automatyn's mission. Reply-worthy tweets are about:
- AI agents, chatbots, automation
- Small business struggles (DMs, customer support, hiring VAs)
- Side hustles, passive income, indie hacking
- AI industry news (model launches, tool comparisons)
- "Who's building X" or "drop your link" threads
- Hot takes about work culture, 9-5, entrepreneurship

Skip: ads, crypto, pure memes with no hook, tweets with <100 chars (low engagement potential), tweets older than 48 hours.

**REPLY STYLE:**
- Maximum controversy optimised for views, followers, conversions
- Contrarian: challenge what people believe
- MUST be optimised for Automatyn's mission: every reply should position Pat as the person who knows how AI agents actually work for small businesses. The reader should think "this guy knows his stuff, let me check his profile"
- Bridge to AI agent setup expertise where natural. Examples of bridges: "the setup file matters more than the model", "most bots fail because nobody wrote the rules", "the configuration is the product", "90 minutes of thinking beats 90 days of coding"
- Do NOT pitch Automatyn directly in replies. Let the profile do the selling. The reply builds authority and curiosity.
- Under 200 chars per reply
- Must sound human, not like a bot
- Space replies 5-10 minutes apart (use time.sleep(300) to time.sleep(600) between Playwright posts, vary randomly so it doesn't look bot-like)

**HOW TO POST:**
1. Connect to Chrome via CDP: `p.chromium.connect_over_cdp("http://127.0.0.1:18800")`
2. Navigate to tweet URL
3. Grant clipboard: CDP `Browser.grantPermissions` with `clipboardReadWrite`
4. Click reply box `[data-testid="tweetTextarea_0"]`
5. Paste via clipboard + Ctrl+V
6. Click `[data-testid="tweetButtonInline"]` to post
7. Append to reply-log.md

## Step 7: Post 1 Fresh Standalone Tweet

Write and post 1 standalone tweet. Rules:
- Under 200 chars
- Not a duplicate of anything in last 7 days (check Postiz API first)
- MAXIMUM CONTROVERSY. The tweet must be provocative enough to get angry replies, quote tweets, and debate. Controversy drives reach on X.
- Optimised for views, followers, and conversions to Automatyn
- Bridge style: contrarian insight about AI agents that challenges what people believe. Formula: [thing most people think] + [why they're wrong] + [implication that makes them uncomfortable]
- Target audience: small business owners + indie hackers + side hustlers
- The tweet should make people think "wait, is he right?" — not just agree or just disagree
- DO NOT post within 10 minutes of any other tweet
- DO NOT be controversial about wars, politics, religion, or personal attacks. Be controversial about business, AI, work culture, and the "make money online" space

## Step 8: Report

Print a summary:
```
MORNING REPORT — [DATE]
========================
Triggers: [enabled/disabled status of all 3]
Overnight content: [what committed]
Manual content: [what I posted if triggers failed]
TikTok carousel: [which hook, pushed to inbox]
TikTok stats: [followers, views, likes]
Replies posted: [count + handles]
Standalone tweet: [what was posted]
Next actions: [run /afternoon later today]
```
