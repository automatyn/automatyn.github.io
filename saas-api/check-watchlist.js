#!/usr/bin/env node
// Reads watchlist.json, derives activity signals from biz-*.json + api.log,
// posts Telegram alerts on state changes (signup -> WA connect -> first conv)
// AND on stuck/drop-off risk (active session but no WA connect, silence > 24h, etc).
// Run from /morning, /afternoon, /evening.

const fs = require('fs');
const path = require('path');
const https = require('https');
const readline = require('readline');

const TG_TOKEN = '8726414142:AAFQr-8dHxws5g9zZpu6IbjhmoN7b7lf8qc';
const TG_CHAT = '5904617085';
const wlPath = path.join(__dirname, 'watchlist.json');
const dataDir = path.join(__dirname, 'data');
const apiLog = path.join(__dirname, 'logs', 'api.log');

function tgSend(text) {
  return new Promise((resolve) => {
    const body = `chat_id=${TG_CHAT}&text=${encodeURIComponent(text)}&parse_mode=HTML`;
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${TG_TOKEN}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => { res.on('data', () => {}); res.on('end', resolve); });
    req.on('error', () => resolve());
    req.write(body); req.end();
  });
}

// Scan api.log for this agentId. Returns { lastHit, hits24h, hitsLastHr, qrPolls24h, distinctPaths }.
async function readActivity(agentId) {
  if (!fs.existsSync(apiLog)) return { lastHit: null, hits24h: 0, hitsLastHr: 0, qrPolls24h: 0, paths: new Set() };
  const now = Date.now();
  const day = 24 * 3600 * 1000;
  const hr = 3600 * 1000;
  const stat = { lastHit: null, hits24h: 0, hitsLastHr: 0, qrPolls24h: 0, paths: new Set() };
  const rl = readline.createInterface({ input: fs.createReadStream(apiLog), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.includes(agentId)) continue;
    let row; try { row = JSON.parse(line); } catch { continue; }
    if (!row.ts || !row.path) continue;
    const t = Date.parse(row.ts);
    if (isNaN(t)) continue;
    if (now - t > day) continue;
    stat.hits24h++;
    if (now - t < hr) stat.hitsLastHr++;
    if (row.path.includes('/whatsapp/')) stat.qrPolls24h++;
    stat.paths.add(row.path.replace(/biz-[a-f0-9]+/, ':id'));
    if (!stat.lastHit || t > stat.lastHit) stat.lastHit = t;
  }
  return stat;
}

function ageStr(ms) {
  if (ms == null) return 'never';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s/60)}m ago`;
  if (s < 86400) return `${Math.floor(s/3600)}h ago`;
  return `${Math.floor(s/86400)}d ago`;
}

(async () => {
  const wl = JSON.parse(fs.readFileSync(wlPath, 'utf8'));
  let changed = false;

  for (const lead of wl.leads) {
    const bizPath = path.join(dataDir, `${lead.agentId}.json`);
    if (!fs.existsSync(bizPath)) continue;
    const biz = JSON.parse(fs.readFileSync(bizPath, 'utf8'));
    const act = await readActivity(lead.agentId);
    const now = Date.now();
    const cur = {
      whatsappConnected: !!biz.whatsappConnected,
      conversationCount: biz.conversationCount || 0,
      lastHit: act.lastHit,
      hits24h: act.hits24h,
      hitsLastHr: act.hitsLastHr,
      qrPolls24h: act.qrPolls24h
    };
    const prev = lead.last_state || {};
    const events = [];

    // State transitions
    if (cur.whatsappConnected && !prev.whatsappConnected) events.push('🟢 connected WhatsApp');
    if (cur.conversationCount > (prev.conversationCount || 0)) {
      events.push(`💬 +${cur.conversationCount - (prev.conversationCount||0)} new conversation(s) (now ${cur.conversationCount})`);
    }

    // Activity signals
    const wasActiveRecently = prev.lastHit && (now - prev.lastHit < 3600000);
    const nowSilent = !cur.lastHit || (now - cur.lastHit > 3600000);
    const becameActive = cur.lastHit && (now - cur.lastHit < 1800000) && (!prev.lastHit || (now - prev.lastHit > 3600000));

    if (becameActive) events.push(`👀 site traffic resumed (last visitor ${ageStr(now - cur.lastHit)} ago, ${cur.hitsLastHr} hits/hr)`);

    // Stuck signals (only if NOT connected)
    if (!cur.whatsappConnected) {
      // Heavy QR polling but not connected = scanning struggle
      if (cur.qrPolls24h > 30 && cur.qrPolls24h > (prev.qrPolls24h||0) + 20) {
        events.push(`⚠️ heavy QR polling (${cur.qrPolls24h} hits/24h) but WA still not connected — possibly stuck on scan`);
      }
      // Silence > 24h after signup = drop-off risk
      const signupAge = now - Date.parse(biz.createdAt || lead.addedAt);
      if (signupAge > 24*3600*1000 && (!cur.lastHit || (now - cur.lastHit) > 24*3600*1000) && !prev.dropoff_alerted) {
        events.push(`🟡 DROP-OFF RISK: signed up ${ageStr(signupAge)}, last seen ${ageStr(now - (cur.lastHit||0))}, never connected WA`);
        cur.dropoff_alerted = true;
      }
    }

    // Connected but zero conversations after 48h = setup-but-no-traffic
    if (cur.whatsappConnected && cur.conversationCount === 0) {
      const connAge = now - Date.parse(lead.last_changed_at || biz.updatedAt);
      if (connAge > 48*3600*1000 && !prev.no_traffic_alerted) {
        events.push(`🟡 connected ${ageStr(connAge)} but zero conversations — funnel into agent not live?`);
        cur.no_traffic_alerted = true;
      }
    }

    if (events.length) {
      const summary = `📋 ${lead.businessName} (${lead.email})\n${events.join('\n')}\n\nactivity: ${cur.hits24h}/24h, ${cur.hitsLastHr}/hr, last ${ageStr(now - (cur.lastHit||0))}\nstate: WA=${cur.whatsappConnected} conv=${cur.conversationCount}`;
      await tgSend(summary);
      lead.last_state = cur;
      lead.last_changed_at = new Date().toISOString();
      changed = true;
      console.log(`[${lead.agentId}] ${events.join(' / ')}`);
    } else {
      // Always update activity counters silently so deltas stay accurate
      lead.last_state = { ...prev, ...cur };
      changed = true;
      console.log(`[${lead.agentId}] no alert (wa=${cur.whatsappConnected}, conv=${cur.conversationCount}, hits24h=${cur.hits24h}, last=${ageStr(now - (cur.lastHit||0))})`);
    }
  }

  if (changed) fs.writeFileSync(wlPath, JSON.stringify(wl, null, 2));
})();
