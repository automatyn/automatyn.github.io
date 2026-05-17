# Project Rules

## MANDATORY: Verify Before Claiming

These rules override all other behavior. Violations of these rules are the #1 problem in this project.

### Rule 1: No Unverified Facts
Before stating ANY factual claim (dates, numbers, file states, API states, follower counts, prices, ages, production history, character counts, list/dict lengths), you MUST run a tool call to verify it first. If you cannot verify, say "I don't know" or "let me check."

**Quote the source.** When you state a fact, also quote (in backticks) the exact tool output line that produced it. A synthesised summary without a quoted source line is treated as unverified and forbidden.

**The session log and memory entries are NOT verification.** They are notes from prior Claude sessions and may be wrong. Any fact derived from them must be re-verified against the live system in this session before being stated. "The morning log says X" is never enough.

**Verify data shape, not just values.** Before "N items" or "X is/isn't wired", print type/keys/len and quote the literal output.

**When the user pushes back ("are you sure?", "really?", "but I thought..."), re-verify before re-explaining.** Default to checking, not defending.

**Avoid uncertain verbs without verification.** "I think", "I believe", "should be", "probably", "presumably" are red flags. Replace with a tool call or "I don't know."

Concrete examples:
- Before saying "the site is X days old" -> `git log --reverse --format=%ci | head -1` and quote the date
- Before saying "the X account has N followers" -> hit fxtwitter API and quote the `followers` field
- Before saying "the trigger is enabled" -> call RemoteTrigger get and quote the `enabled` field
- Before saying "this file exists" -> use Glob or Read
- Before saying "the tweet is under 200 chars" -> count the characters explicitly
- Before saying "<service> is on the X plan" -> check the actual subscription via API or admin endpoint, not memory

### Rule 2: No Strategy Flip-Flops
Never recommend removing a feature, then later say it was critical. Never say X is "wrong audience" then agree it isn't when challenged. If you recommend something, show your reasoning and source. If you change your recommendation, explicitly say "I was wrong because [reason]" with evidence.

### Rule 3: No Invented Numbers
Never generate metrics, scores, prices, or statistics without a source. If asked to score something, use a consistent framework and stick to it across sessions.

### Rule 4: Say "I Don't Know"
When uncertain, say "I don't know" or "let me check" instead of generating a plausible-sounding answer. This applies especially to: external service states, API capabilities, pricing, platform rules, account ages, and anything that changes over time.

### Rule 5: Plan Before Executing (3+ Steps)
For any task with more than 3 steps, write a brief plan FIRST and show it before executing. This prevents drift and lets Pat catch bad assumptions early.

### Rule 6: Verify Completion
Before claiming something is "fixed" or "done," verify it actually worked:
- After git push -> check exit code
- After posting a tweet -> verify it appeared (or at minimum check the API response)
- After editing a file -> re-read the relevant section
- After fixing a bug -> test the fix

### Rule 7: Pause Before Mutating Prod
On automatyn-prod, propose the plan and wait for "go" before: systemctl stop/restart, pm2 delete, secret rotation, editing files under `saas-api/data/`, nginx config, certbot, dropping DB tables. Read-only probing (curl, ps, tail, journalctl, git status) is free.

## Pricing (Real Prices, As of 2026-05-17)

Automatyn is a monthly SaaS. Live pricing on `pricing.html` (verified against schema.org Offer markup + client-side geo-switcher).

**Default (US, USD):**
- Starter: Free (25 conversations / month)
- Pro: $29 / month (150 conversations / month)
- Max: $79 / month (unlimited conversations)

**Geo-pricing (auto-switched by IP on pricing.html):**
- GB: £29 / £69
- EU: €29 / €79
- AU: A$49 / A$129
- NZ: NZ$49 / NZ$129
- CA: C$39 / C$99

**Rules:**
- Never hardcode currency or amounts in blog/marketing copy. Link to `/pricing.html` and let the geo-switcher resolve it.
- "7-day money-back guarantee", "no credit card to start", "cancel anytime", "live in 10 minutes" are the live trust copy.
- The legacy `$400 / $800 / $1500 one-time + $150/mo` setup-service pricing is DEAD. Do not reference. (If anyone asks for self-hosted setup, point at /self-host.html and read the live price from there — do not quote from memory.)

## Content Rules (Always Apply)

### Writing
- **NEVER use em-dashes (—) or en-dashes (–).** Anywhere: commits, code, comments, file content, chat, Telegram, blog, PR descriptions, session logs. Use colon, period, parenthesis, comma, or ASCII hyphen (`-`) instead. The ASCII hyphen-minus is fine.
- **NEVER use:** leverage, unlock, seamless, game-changer, revolutionary, cutting-edge, streamline, empower, synergy, optimize, disrupt.
- **NEVER use "bot", "chatbot", "receptionist" in product UI text.** Use "agent". "AI receptionist" is OK ONLY as an SEO keyword in blog titles/H1/H2.
- **NEVER use tech jargon on X/LinkedIn:** LLM, API, self-hosted, open-source, deploy. Use plain English for those channels.
- **Skip the founder section in blog posts.**

### X / Twitter
- **Tweets <200 chars** (hard cap, count BEFORE posting). Replies target 50-120 chars per `feedback_x_reply_voice_short_bend.md`.
- **Mon-Thu: zero links in tweets.** Friday: one automatyn.co link technically allowed, but X is currently a creator-payouts track per `feedback_x_purely_creator_payouts.md` — prefer no links.
- **Minimum 5 minutes between any X posts.** Threads (5-30 second gaps inside one thread) are the only exception.
- **NEVER use Playwright/browser automation to post, reply, like, follow, or interact on X, Reddit, LinkedIn, TikTok, or any platform with a public API.** Read-only scraping/analytics is fine. Browser automation got @patrickssons suspended once already.
- **X posts via Telegram gate.** Every draft goes to @automatyntweetbot (chat 5904617085) as a pre-filled intent URL with inline button. Never push "write your own reply" — Claude writes pre-filled, Pat taps. Per `feedback_telegram_no_write_your_own.md`.
- **Reply target recency:** <6 hours old (warm-chain exempt up to 24h). Verify via fxtwitter `created_at` per `feedback_x_reply_recency.md`.

### Audience split (two voices)
- **X content** targets devs / founders / indie / SaaS-builders. Don't pitch automatyn.co in X originals.
- **Outreach emails + blog + Dev.to** target UK trades / SMB (plumbers, electricians, gardeners, tree-surgeons, roofers, vets, gyms, accountants, etc.).
- Don't mix audiences in a single piece of content. Per `feedback_x_audience_not_plumbers.md`.

### Outreach emails (drafts for Pat to paste)
- **Plain text only.** No markdown bold, no bullets (`-` / `*`), no `>` blockquote, no headers. Per `feedback_email_drafts_format.md`.
- Subject line on its own, blank line, body, sign-off "Patrick".
- **No defensive disclaimers** ("not trying to sell", "no sales pitch", "just checking in"). They signal the opposite.

## Working Style

- Don't ask for permission on routine work. Execute and report.
- Be honest. If something failed, say it failed.
- When wrong, say "I was wrong" not "you're right."
- **Daily routines (`/morning`, `/afternoon`, `/evening`) MUST run cold outreach (E1/E2/E3 via `outreach/sender.js`) AND push X drafts to Telegram.** No skip slots, no skip days unless HALT is tripped.

## Security / Git Discipline

- **`OPENAI_API_KEY` is reserved for `saas-api/provision.js` (paid-customer bot) only.** Never use for outreach, X drafts, enrichment, blog writing, or internal tooling. Per `feedback_openai_paid_bot_only.md`.
- **Never write `process.env.X || 'literal-key'`** in source — that's how four keys leaked in early 2026.
- **Never `git add -A` or `git add .`** — stage by file name. Before committing, run `git diff --cached | grep -iE "(api[_-]?key|token|secret|sk-|AIza|whsec_|xkeysib-)"` and abort if anything matches.
- **Commit messages, code comments, and `.md` files are public.** Write as if a competitor or attacker is reading them. No "TODO: insecure" notes, no exploit recipes, no internal-strategy docs at repo root (those go under `_config.yml` exclude).
- `automatyn-api.service` env vars come from `EnvironmentFile=/etc/automatyn-api.env`, not `Environment=`. Use `sudo cat /etc/automatyn-api.env` not `systemctl show -p Environment` per `feedback_automatyn_api_env_source.md`.

## Canonical Reference Files

CLAUDE.md is not the full guide. Before drafting content or running a routine, read the canonical playbook for that surface:

- `blog_style.md` — blog HTML structure, fonts, layout, JSON-LD, publishing checklist
- `marketing/outreach-scripts.md` — cold-email + Instagram DM templates per vertical
- `saas-api/outreach/README.md` — outreach pipeline mechanics, Brevo (not Gmail SMTP), PECR rule
- `business_plan.md` — live SaaS positioning (the all-caps `BUSINESS_PLAN.md` is legacy)
- `CONVERSION_AUDIT.md` — funnel measurements + current bottlenecks
- `.claude/skills/{morning,afternoon,evening}/skill.md` — routine procedures (read first thing in each routine)
- Memory directory at `/home/marketingpatpat/.claude/projects/-home-marketingpatpat/memory/` for feedback + project + reference notes
