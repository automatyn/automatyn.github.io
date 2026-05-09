#!/usr/bin/env bash
# Local SEO Daily runner. Replaces the broken cloud trigger.
# Behaviour:
#   - 1 fresh blog post per run (was 3, dropped for quality).
#   - Hard dedupe vs existing blog/*.html slugs and their H1s.
#   - Topic selection biased to GSC pos 11-30 quick-wins, fallback to evergreen trade-pain.
#   - Forge required for hero image. If unreachable, abort with Telegram alert.
#   - Telegram alert on EVERY failure path. No more silent failures.
#   - Telegram message on success with title + URL.

set -uo pipefail

REPO=/home/marketingpatpat/openclaw
BLOG_DIR="$REPO/blog"
LOG_DIR="$REPO/social-posts/seo-daily-logs"
RUN_TS=$(date -u +%Y-%m-%dT%H-%M-%SZ)
RUN_LOG="$LOG_DIR/$RUN_TS.log"
mkdir -p "$LOG_DIR"

TG_TOKEN='8726414142:AAFQr-8dHxws5g9zZpu6IbjhmoN7b7lf8qc'
TG_CHAT='5904617085'
FORGE_URL='http://100.107.24.7:7860'

tg() {
  local msg="$1"
  curl -s -X POST "https://api.telegram.org/bot${TG_TOKEN}/sendMessage" \
    --data-urlencode "chat_id=${TG_CHAT}" \
    --data-urlencode "text=${msg}" \
    --data-urlencode "disable_web_page_preview=true" >/dev/null 2>&1 || true
}

fail() {
  local reason="$1"
  echo "[FAIL] $reason" | tee -a "$RUN_LOG"
  tg "SEO Daily FAILED $RUN_TS: $reason. Log: $RUN_LOG"
  exit 1
}

log() {
  echo "[$(date -u +%H:%M:%SZ)] $1" | tee -a "$RUN_LOG"
}

log "SEO Daily start. Repo: $REPO. Log: $RUN_LOG"

# Step 1: Forge precheck
log "Checking Forge at $FORGE_URL ..."
forge_code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$FORGE_URL/sdapi/v1/sd-models" || echo "000")
if [ "$forge_code" != "200" ]; then
  fail "Forge unreachable (HTTP $forge_code). Pat's laptop probably rebooted."
fi
log "Forge OK ($forge_code)."

# Step 2: GSC fetch (28d) for quick-win candidates
log "Pulling GSC 28d ..."
GSC_OUT="/tmp/seo-daily-gsc-28d-$RUN_TS.txt"
if ! ( cd "$REPO/saas-api" && timeout 60 node seo/gsc-fetch.js 28 > "$GSC_OUT" 2>>"$RUN_LOG" ); then
  log "GSC fetch failed (continuing without it - falling back to evergreen list)."
  GSC_OUT=""
fi
[ -n "$GSC_OUT" ] && log "GSC saved to $GSC_OUT ($(wc -l < "$GSC_OUT") lines)."

# Step 3: Inventory existing slugs (dedupe set)
SLUG_LIST="/tmp/seo-daily-slugs-$RUN_TS.txt"
( cd "$BLOG_DIR" && ls *.html 2>/dev/null | sed 's/\.html$//' ) > "$SLUG_LIST"
SLUG_COUNT=$(wc -l < "$SLUG_LIST")
log "Existing blog slugs: $SLUG_COUNT (in $SLUG_LIST)"

# Step 4: Build the agent prompt with all context inlined
PROMPT_FILE="/tmp/seo-daily-prompt-$RUN_TS.md"
{
  cat <<'PROMPT_HEAD'
You are the local SEO Daily writer for automatyn.co. ONE blog post per run. Quality over quantity.

You have full filesystem access. Cwd is /home/marketingpatpat/openclaw. The blog repo is the same directory; pushes go to https://github.com/automatyn/automatyn.github.io (the live GH Pages site automatyn.co).

CRITICAL RULES:
- Write exactly ONE blog post (not three).
- DEDUPE FIRST. Read the existing-slugs list below. Reject any topic where a near-duplicate slug exists. If you suspect overlap, Read the candidate's H1 to confirm.
- BUYER INTENT ONLY. The reader must be a UK service-business owner (plumber, electrician, salon, dentist, clinic, accountant, locksmith, vet, gym, restaurant) considering whether to BUY an AI receptionist / WhatsApp bot for their business. NOT someone trying to make money with AI, NOT a developer, NOT an AI hobbyist.
- TOPIC TIERS (pick the highest tier that has fresh angle):
  Tier 1 (highest priority): "AI receptionist for [vertical/city]", "WhatsApp bot for [vertical]", "[Cost / setup / ROI] of AI receptionist UK", "Hiring receptionist vs AI receptionist", "After-hours phone for UK trades"
  Tier 2: "Missed call cost for UK [vertical]", "Speed of reply moat for UK SMB", "WhatsApp Business vs WhatsApp API for [vertical]"
  Tier 3 (only if dedupe forbids tiers 1-2): general AI-receptionist explainers
- BANNED TOPICS (reject immediately, do NOT write): passive income, AI side hustles, autonomous agent revenue, "make money with AI", "best AI agency", AI coding tools (Codex/Cursor/Claude Code), Anthropic-vs-OpenAI takes, generic "what is an AI agent". Those are off-ICP and have been NOINDEXed on the site already.
- Style: read /home/marketingpatpat/openclaw/blog_style.md before writing if it exists. Match the dark-theme/Tailwind/Inter template used in /home/marketingpatpat/openclaw/blog/whatsapp-bot-plumber-2026.html (read it for structure).
- Length: 1500-2000 words, PAS or problem-led structure. UK references (pounds, postcodes, UK trade language).
- Schema: Article + FAQPage + BreadcrumbList JSON-LD.
- Internal links MANDATORY: 4 minimum, all to existing buyer-intent blogs in /blog/ (read the blog directory to pick the closest topical neighbours). One MUST point to /pricing.html. One MUST point to a comparison post (hiring-vs-ai or vs-phone-answering). Topical authority cluster matters — link generously between trade-pain blogs.
- Hero image via Forge http://100.107.24.7:7860 JuggernautXL. Generate ONE image, save normalized to 1344x768 JPEG at /home/marketingpatpat/openclaw/blog/<slug>.jpg. Also generate one secondary image if it improves the post; otherwise skip. Visually audit the result by reading the saved JPEG (you have multimodal). If the image has text/watermarks/garbled hands/wrong subject, regenerate with a different prompt up to 2 retries. If still bad after 3 tries, STOP the post and report failure.
- NO em dashes anywhere. NO banned words: leverage, unlock, seamless, game-changer, revolutionary, cutting-edge, streamline, empower, synergy, optimize, disrupt.
- NO hardcoded prices in body text. Real Automatyn prices: £400 / £800 / £1500 one-off + £150/mo support. Link out to /pricing.html for specifics.
- Skip the founder section.
- Canonical: https://automatyn.co/blog/<slug>.html
- File output: /home/marketingpatpat/openclaw/blog/<slug>.html

After writing the post:
1. Update /home/marketingpatpat/openclaw/blog/index.html: add a new card at position 1 mirroring the existing card structure for that file. Do NOT remove old cards.
2. Update /home/marketingpatpat/openclaw/index.html (homepage): if it has a "latest blogs" block, replace the oldest of the visible 3 with the new one. If you cannot find that block, skip and note in the report.
3. Update /home/marketingpatpat/openclaw/sitemap.xml: append <url><loc>https://automatyn.co/blog/<slug>.html</loc><lastmod>YYYY-MM-DD</lastmod></url> with today's date.
4. IndexNow ping: read /home/marketingpatpat/openclaw/indexnow-*.txt or ai-plugin.json to find the IndexNow key. POST { host, key, urlList: [the new URL] } to https://api.indexnow.org/indexnow.
5. git add the changed files (blog/<slug>.html, blog/<slug>.jpg, optional secondary image, blog/index.html, index.html, sitemap.xml). Commit with message "feat(blog): <H1 title>". Push origin main.

Report: at the very end, output a single line in this exact format so the wrapper script can parse it:
RESULT slug=<slug> title=<title> commit=<short-hash> url=https://automatyn.co/blog/<slug>.html

If you abort for any reason (Forge image rejected 3 times, dedupe collision found late, schema validation failed) output:
RESULT abort=<one-line-reason>

Do NOT ask for permission at any step. Do NOT use Playwright. Do NOT skip the dedupe check.

PROMPT_HEAD

  echo "=== EXISTING BLOG SLUGS (HARD DEDUPE) ==="
  cat "$SLUG_LIST"
  echo
  if [ -n "$GSC_OUT" ] && [ -s "$GSC_OUT" ]; then
    echo "=== GSC LAST 28D (rank quick-wins by pos 11-30 with impressions) ==="
    cat "$GSC_OUT"
    echo
  fi

  cat <<'PROMPT_FOOT'
=== EVERGREEN TRADE-PAIN FALLBACK TOPICS (only if GSC has no clean quick-win) ===
- WhatsApp Business API vs AI receptionist for UK small business 2026
- AI receptionist vs phone answering service: which is cheaper?
- Do I need WhatsApp Business to use an AI receptionist?
- Can AI really handle customer calls without sounding robotic?
- AI receptionist for UK trades: what setup actually costs in 2026
- How long does an AI receptionist take to install for a small business?
- Voicemail to WhatsApp: catching missed calls without picking up
- Hiring a receptionist vs AI receptionist: real numbers for a UK plumber

Pick whichever is freshest and not slug-duplicated. If GSC shows a page already ranks pos 11-30 for a query, write a NEW post that targets a related but distinct query (do not cannibalise the ranking page).

START NOW.
PROMPT_FOOT
} > "$PROMPT_FILE"

log "Prompt assembled at $PROMPT_FILE ($(wc -l < "$PROMPT_FILE") lines)"

# Step 5: Run claude in headless mode
log "Invoking claude --print ..."
AGENT_OUT="/tmp/seo-daily-agent-$RUN_TS.out"
# Capture pre-state so we can diff after
git -C "$REPO" rev-parse HEAD > "/tmp/seo-daily-headbefore-$RUN_TS"
HEAD_BEFORE=$(cat "/tmp/seo-daily-headbefore-$RUN_TS")

cd "$REPO"
# Use sonnet-4-6 for daily runs (faster + cheaper than opus); keep 30 min budget
timeout 1800 claude --print \
  --model claude-sonnet-4-6 \
  --permission-mode bypassPermissions \
  --add-dir "$REPO" \
  < "$PROMPT_FILE" > "$AGENT_OUT" 2>>"$RUN_LOG"
AGENT_RC=$?
log "Agent exit code: $AGENT_RC. Output: $AGENT_OUT ($(wc -l < "$AGENT_OUT") lines)"

if [ $AGENT_RC -ne 0 ]; then
  log "Agent failed or timed out (rc=$AGENT_RC). Tail of output:"
  tail -30 "$AGENT_OUT" | tee -a "$RUN_LOG"
  fail "Agent run failed (rc=$AGENT_RC). See $RUN_LOG."
fi

# Step 6: Verify the agent actually produced commits
HEAD_AFTER=$(git -C "$REPO" rev-parse HEAD)
if [ "$HEAD_BEFORE" = "$HEAD_AFTER" ]; then
  log "No new commit. Tail of agent output:"
  tail -30 "$AGENT_OUT" | tee -a "$RUN_LOG"
  fail "Agent ran but produced 0 commits. Check $AGENT_OUT for the abort reason."
fi
log "New commit: $HEAD_AFTER"

# Step 7: Parse RESULT line
RESULT_LINE=$(grep -E '^RESULT ' "$AGENT_OUT" | tail -1)
if [ -z "$RESULT_LINE" ]; then
  log "No RESULT line found in agent output. Tail:"
  tail -30 "$AGENT_OUT" | tee -a "$RUN_LOG"
  fail "Agent committed something but did not emit RESULT line. Manual check needed."
fi
log "Result line: $RESULT_LINE"

if echo "$RESULT_LINE" | grep -q "abort="; then
  fail "Agent aborted: $RESULT_LINE"
fi

SLUG=$(echo "$RESULT_LINE" | sed -nE 's/.*slug=([^ ]+).*/\1/p')
TITLE=$(echo "$RESULT_LINE" | sed -nE 's/.*title=(.+) commit=.*/\1/p')
URL=$(echo "$RESULT_LINE" | sed -nE 's|.*url=(\S+).*|\1|p')

if [ -z "$SLUG" ] || [ -z "$URL" ]; then
  fail "RESULT line malformed: $RESULT_LINE"
fi

# Step 8: Verify the URL is going to be live (file exists in commit)
if [ ! -f "$BLOG_DIR/$SLUG.html" ]; then
  fail "RESULT claims slug=$SLUG but $BLOG_DIR/$SLUG.html does not exist."
fi

# Step 9: Push (agent should have pushed, but double check)
if ! git -C "$REPO" push origin main 2>&1 | tee -a "$RUN_LOG" | grep -qE 'up-to-date|main -> main'; then
  log "Push failed or no-op. Continuing - agent may have pushed already."
fi

tg "SEO Daily OK $RUN_TS: $TITLE -> $URL"
log "DONE. $TITLE -> $URL"
exit 0
