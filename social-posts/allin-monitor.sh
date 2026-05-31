#!/bin/bash
# All-In Podcast monitor. Daily check (episode drops Thu-Sun). On a NEW episode:
# download audio -> whisper transcribe -> claude -p highlights -> Telegram.
# Built 2026-05-31. Every piece verified before wiring: RSS detect, ffmpeg pull,
# local whisper (no API key, sidesteps the OPENAI-paid-bot-only rule), claude -p,
# @automatyntweetbot push. No YouTube bot-check (uses the libsyn audio feed).
set -uo pipefail
DIR=/home/marketingpatpat/openclaw/social-posts
LOG=$DIR/allin-monitor.log
STATE=$DIR/allin-monitor-state.json   # { last_guid, last_title }
FEED='https://rss.libsyn.com/shows/254861/destinations/1928300.xml'
UA='AutomatynPodcastMonitor/1.0'
WORK=/tmp/allin-monitor
# Read the Telegram token from the x-drafts pipeline at runtime (do not hardcode
# the secret in a committed file). Same @automatyntweetbot bot + chat.
TG_TOKEN=$(grep -oP "const TG_TOKEN = '\K[^']+" "$DIR/x-drafts/firehose-pipeline.js")
TG_CHAT=$(grep -oP "const TG_CHAT = '\K[^']+" "$DIR/x-drafts/firehose-pipeline.js")
ts(){ date -u "+%Y-%m-%dT%H:%M:%SZ"; }
mkdir -p "$WORK"
echo "[$(ts)] allin-monitor start" >> "$LOG"

# 1. Read latest episode from the feed
META=$(curl -s --max-time 30 -A "$UA" "$FEED" | node -e '
let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{
  const item=d.split("<item>")[1]||"";
  const t=((item.match(/<title>(?:<!\[CDATA\[)?([^\]<]+)/)||[])[1]||"").trim();
  const audio=(item.match(/<enclosure[^>]+url="([^"]+)"/)||[])[1]||"";
  const link=(item.match(/<link>([^<]+)/)||[])[1]||"";
  // stable id: prefer guid, else the audio filename
  let gid=(item.match(/<guid[^>]*>([^<]+)/)||[])[1]||"";
  if(!gid) gid=(audio.split("/").pop()||"").split("?")[0];
  process.stdout.write(JSON.stringify({title:t,audio,link,gid}));
})')
GID=$(echo "$META" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>process.stdout.write((JSON.parse(d).gid||"")))')
TITLE=$(echo "$META" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>process.stdout.write((JSON.parse(d).title||"")))')
AUDIO=$(echo "$META" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>process.stdout.write((JSON.parse(d).audio||"")))')
LINK=$(echo "$META" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>process.stdout.write((JSON.parse(d).link||"")))')

if [ -z "$GID" ] || [ -z "$AUDIO" ]; then echo "[$(ts)] feed parse failed, exit" >> "$LOG"; exit 1; fi

# 2. Already processed this episode? then nothing to do.
LAST=$(node -e 'try{process.stdout.write((require("'$STATE'").last_guid||""))}catch{process.stdout.write("")}' 2>/dev/null)
if [ "$GID" = "$LAST" ]; then echo "[$(ts)] no new episode (latest: $TITLE)" >> "$LOG"; exit 0; fi
echo "[$(ts)] NEW EPISODE: $TITLE" >> "$LOG"

# 3. Download + transcribe (full episode; slow but weekly + background)
ffmpeg -y -i "$AUDIO" -ar 16000 -ac 1 "$WORK/ep.wav" >> "$LOG" 2>&1
if [ ! -s "$WORK/ep.wav" ]; then echo "[$(ts)] audio download failed" >> "$LOG"; exit 1; fi
echo "[$(ts)] transcribing with whisper (base)..." >> "$LOG"
timeout 5400 whisper "$WORK/ep.wav" --model base --language en --output_format txt --output_dir "$WORK" >> "$LOG" 2>&1
TRANSCRIPT="$WORK/ep.txt"
if [ ! -s "$TRANSCRIPT" ]; then echo "[$(ts)] transcription failed" >> "$LOG"; exit 1; fi
WORDS=$(wc -w < "$TRANSCRIPT")
echo "[$(ts)] transcript ready ($WORDS words)" >> "$LOG"

# 4. Summarize with claude -p (feed transcript via stdin; cap length for the prompt)
SUMMARY=$(head -c 60000 "$TRANSCRIPT" | claude -p "This is a transcript of the latest All-In Podcast episode titled \"$TITLE\". Write a tight highlights report for Pat: lead with a one-line TLDR, then 5-8 bullet KEY TAKEAWAYS (the actual arguments/predictions/numbers, not fluff), then a one-line 'why it matters'. No em-dashes. Plain text, no markdown headers. Under 1500 chars total." 2>>"$LOG")
if [ -z "$SUMMARY" ]; then echo "[$(ts)] summary failed" >> "$LOG"; exit 1; fi

# 5. Push to Telegram
MSG=$(printf "NEW All-In episode\n\n%s\n\n%s\n\n%s" "$TITLE" "$SUMMARY" "$LINK")
node -e '
const https=require("https");
const body=JSON.stringify({chat_id:"'$TG_CHAT'",text:process.argv[1],disable_web_page_preview:true});
const req=https.request({hostname:"api.telegram.org",path:"/bot'$TG_TOKEN'/sendMessage",method:"POST",headers:{"Content-Type":"application/json","Content-Length":Buffer.byteLength(body)}},r=>{let d="";r.on("data",c=>d+=c);r.on("end",()=>console.log(r.statusCode===200?"pushed ok":"push fail "+d.slice(0,120)));});
req.on("error",e=>console.log("push err "+e.message));req.write(body);req.end();
' "$MSG" >> "$LOG" 2>&1

# 6. Record state so we never re-send this episode
node -e 'require("fs").writeFileSync("'$STATE'",JSON.stringify({last_guid:"'"$GID"'",last_title:process.argv[1],processed_at:"'"$(ts)"'"},null,2))' "$TITLE"
echo "[$(ts)] allin-monitor done, pushed: $TITLE" >> "$LOG"
# Clean up ALL temp files (audio + transcript + any chunks) to save VM space.
rm -f "$WORK"/ep.wav "$WORK"/ep.txt "$WORK"/*.wav "$WORK"/*.txt 2>/dev/null
