#!/bin/bash
# VM-side X reply drafter. Replaces the broken cloud trigger (which ran on a
# GitHub clone that could not see the gitignored, VM-only candidate files).
# This runs where the candidates actually live, drives `claude -p` to draft,
# then pushes via firehose-pipeline.js with SKIP_DRAFTER=1.
#
# Pat's settings (2026-05-30): keep the 100k follower floor, target ~40 quality
# replies/day. Run a few times daily via systemd timer.
set -uo pipefail
cd /home/marketingpatpat/openclaw/social-posts/x-drafts
LOG=/home/marketingpatpat/openclaw/social-posts/vm-drafter.log
ts(){ date -u "+%Y-%m-%dT%H:%M:%SZ"; }
echo "[$(ts)] vm-drafter start" >> "$LOG"

# 1. Build the qualifying candidate list (100k floor, <6h, on-audience, undrafted)
CANDS=$(node -e '
const fs=require("fs");
let c=[];for(const f of ["firehose-candidates.json","candidates-search.json","candidates-browser.json"]){try{(JSON.parse(fs.readFileSync(f,"utf8")).candidates||[]).forEach(x=>c.push(x))}catch{}}
const hf=(()=>{try{return JSON.parse(fs.readFileSync("handle-followers.json","utf8"))}catch{return{}}})();
const sent=(()=>{try{return new Set(JSON.parse(fs.readFileSync("/home/marketingpatpat/openclaw/social-posts/firehose-sent.json","utf8")).ids||[])}catch{return new Set()}})();
const drafted=(()=>{try{return new Set((JSON.parse(fs.readFileSync("drafts.json","utf8")).drafts||[]).filter(x=>x.type==="reply").map(x=>x.tweet_id))}catch{return new Set()}})();
const q=c.filter(x=>{const f=x.author_followers||hf[(x.handle||"").toLowerCase()]?.followers||0;const t=(x.text||"").toLowerCase();return f>=100000&&(x.age_hours||99)<6&&!sent.has(x.tweet_id)&&!drafted.has(x.tweet_id)&&!/cointelegraph|crypto|airdrop|coinbase|\$[a-z]{2,5}\b|levelsio/i.test((x.handle||"")+" "+t)&&(x.text||"").length>50;});
const u=[...new Map(q.map(x=>[x.tweet_id,x])).values()].slice(0,8);
process.stdout.write(JSON.stringify(u.map(x=>({tweet_id:x.tweet_id,handle:x.handle,followers:x.author_followers||hf[(x.handle||"").toLowerCase()]?.followers,text:(x.text||"").slice(0,400)}))));
')
N=$(echo "$CANDS" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{console.log((JSON.parse(d)||[]).length)}catch{console.log(0)}})')
echo "[$(ts)] qualifying candidates: $N" >> "$LOG"
if [ "$N" = "0" ]; then echo "[$(ts)] nothing to draft, exit clean" >> "$LOG"; exit 0; fi

# 2. Draft via claude -p. Output STRICT json array of {tweet_id,handle,draft}.
PROMPT="You are the X reply drafter for @patrickssons. Below is a JSON array of candidate tweets. For EACH, write ONE bend-back reply. Voice: 50-180 chars, under 200 hard cap. Reuse the OP's own frame/number and invert or sharpen it. One dry jab or insight, no qualifier, no 'Real question:' stems, no em-dashes, no hashtags, no links. Audience is devs/founders/indie/SaaS. Do NOT pitch any product. Make it a conversation-starter that invites a reply back. Output ONLY a JSON array, no prose, no code fence: [{\"tweet_id\":\"...\",\"handle\":\"...\",\"draft\":\"...\"}]. Candidates: $CANDS"

RAW=$(echo "$PROMPT" | timeout 180 claude -p 2>>"$LOG")
echo "[$(ts)] claude -p returned ${#RAW} chars" >> "$LOG"

# 3. Parse claude output, append valid drafts to drafts.json
ADDED=$(node -e '
const fs=require("fs");
let raw=process.argv[1]||"";
// strip any code fence or stray prose: grab the first [...] block
const m=raw.match(/\[[\s\S]*\]/); if(!m){console.log(0);process.exit(0);}
let arr; try{arr=JSON.parse(m[0]);}catch{console.log(0);process.exit(0);}
const b=(()=>{try{return JSON.parse(fs.readFileSync("drafts.json","utf8"))}catch{return{drafts:[]}}})();
b.drafts=b.drafts||[];
let added=0;
for(const d of arr){
  if(!d||!d.tweet_id||!d.draft)continue;
  if((d.draft||"").length>200)continue;
  if(/—|–/.test(d.draft))continue;
  const id="r-"+d.tweet_id;
  if(b.drafts.some(x=>x.id===id))continue;
  b.drafts.push({id,type:"reply",draft:d.draft,target_url:"https://x.com/i/web/status/"+d.tweet_id,tweet_id:d.tweet_id,target_handle:d.handle||""});
  added++;
}
fs.writeFileSync("drafts.json",JSON.stringify(b,null,2));
console.log(added);
' "$RAW")
echo "[$(ts)] drafts added to drafts.json: $ADDED" >> "$LOG"

# 4. Push. SKIP_DRAFTER so the keyword drafter does not overwrite our drafts;
# SKIP_SCRAPE because the firehose systemd timer already scrapes every 30 min
# (re-scraping here is slow and unnecessary).
SKIP_DRAFTER=1 SKIP_SCRAPE=1 node firehose-pipeline.js --max=8 >> "$LOG" 2>&1
echo "[$(ts)] vm-drafter done" >> "$LOG"
