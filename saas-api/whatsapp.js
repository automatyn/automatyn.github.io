const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, DisconnectReason } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const pino = require('pino');
const path = require('path');
const fs = require('fs');

const AGENTS_DIR = path.join(require('os').homedir(), '.openclaw', 'agents');
const { loadConfig, saveConfig, reloadGateway, withConfigLock } = require('./provision');

// Track active sessions per agent
const activeSessions = new Map();

// Cache the live WA Web version so we don't hit web.whatsapp.com on every pair attempt.
let _waVersionCache = { version: null, fetchedAt: 0 };
async function getCurrentWAWebVersion() {
  const now = Date.now();
  if (_waVersionCache.version && now - _waVersionCache.fetchedAt < 6 * 60 * 60 * 1000) {
    return _waVersionCache.version;
  }
  const https = require('https');
  const body = await new Promise((resolve, reject) => {
    const req = https.get('https://web.whatsapp.com/sw.js', (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error('timeout')));
  });
  const m = body.match(/client_revision\\?":\s*(\d+)/);
  if (!m) throw new Error('client_revision not found in sw.js');
  // Baileys version format: [major, minor, patch]. WA Web uses 2.3000.<rev>.
  const version = [2, 3000, parseInt(m[1], 10)];
  _waVersionCache = { version, fetchedAt: now };
  console.log(`[whatsapp] using WA Web version ${version.join('.')}`);
  return version;
}

function getAuthDir(agentId) {
  return path.join(AGENTS_DIR, agentId, 'whatsapp-auth');
}

/**
 * Start WhatsApp pairing for an agent.
 * Returns a pairing code (8-char string) that user enters on their phone.
 * WhatsApp > Linked Devices > Link with phone number > enter code.
 */
async function startPairingCode(agentId, phoneNumber) {
  // Clean phone number: remove spaces, dashes, plus sign
  let phone = phoneNumber.replace(/[\s\-\+\(\)]/g, '');
  // UK agents commonly type their number with the national 0 prefix (07496...).
  // Baileys forwards that to WhatsApp as-is, WhatsApp rejects the JID, pair fails.
  // Detect a UK national-format number and convert to E.164 (44...).
  // Heuristic: 11 digits starting with "07" looks like a UK mobile in national format.
  if (/^07\d{9}$/.test(phone)) {
    phone = '44' + phone.slice(1);
    console.log(`[whatsapp:${agentId}] normalized UK phone: ${phoneNumber} -> ${phone}`);
  }
  if (!/^\d{10,15}$/.test(phone)) {
    throw new Error('Invalid phone number. Use format: 44XXXXXXXXXX (country code + number, no +)');
  }
  // Numbers starting with 0 are still in national format (other countries) and won't pair.
  if (phone.startsWith('0')) {
    throw new Error('Phone number must include country code (e.g. 44 for UK, no leading 0). You entered something starting with 0.');
  }

  // Kill any existing session for this agent
  await disconnectSession(agentId);

  const authDir = getAuthDir(agentId);
  // Wipe any stale partial auth — leftover creds from a failed prior pair
  // cause Baileys to attempt a "resume" that WhatsApp rejects as "couldn't link device".
  if (fs.existsSync(authDir)) {
    try { fs.rmSync(authDir, { recursive: true, force: true }); } catch {}
  }
  fs.mkdirSync(authDir, { recursive: true, mode: 0o700 });

  const logger = pino({ level: 'debug' }, pino.destination({ dest: '/home/marketingpatpat/openclaw/saas-api/baileys.log', sync: true }));
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  // fetchLatestBaileysVersion() lags behind real WA Web. Use the actual current
  // client_revision from web.whatsapp.com/sw.js, with the cached helper as fallback.
  let version;
  try {
    version = await getCurrentWAWebVersion();
  } catch {
    version = (await fetchLatestBaileysVersion()).version;
  }

  const sock = makeWASocket({
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
    version,
    logger,
    printQRInTerminal: false,
    browser: ['Automatyn', 'Chrome', '1.0'],
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });

  // Save creds on update
  sock.ev.on('creds.update', saveCreds);

  // Pair flow with mid-flight 515 reconnect.
  // Resolve only when the *fully registered* socket reaches 'open' (creds.registered === true).
  const connectionPromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Connection timed out. Please try again.'));
    }, 180000);

    let currentState = state;
    let saw515 = false;
    const onUpdate = (update) => {
      const { connection, lastDisconnect } = update;
      if (connection === 'open') {
        if (currentState.creds.registered) {
          clearTimeout(timeout);
          resolve({ connected: true });
        }
        // else: this is the pre-pair 'open' — wait for 515 reconnect cycle
        return;
      }
      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const errMsg = lastDisconnect?.error?.message || 'connection closed';
        console.log(`[whatsapp:${agentId}] connection close — code=${statusCode} msg=${errMsg} registered=${currentState.creds.registered}`);
        const is515 = statusCode === 515 || statusCode === DisconnectReason.restartRequired;
        if (is515) saw515 = true;
        // Reconnect only on explicit 515, or silent-close that immediately follows
        // a 515 (Baileys' post-restart cycle). Pre-scan silent closes spawn
        // duplicate sockets that fight each other and cause "QR refs attempts ended".
        if (is515 || (!statusCode && saw515 && !currentState.creds.registered)) {
          console.log(`[whatsapp:${agentId}] reconnecting after ${statusCode || 'post-515-silent-close'}`);
          (async () => {
            // Reload state fresh from disk — partial creds were saved during pair
            const reloaded = await useMultiFileAuthState(authDir);
            currentState = reloaded.state;
            const newSock = makeWASocket({
              auth: { creds: reloaded.state.creds, keys: makeCacheableSignalKeyStore(reloaded.state.keys, logger) },
              version, logger,
              printQRInTerminal: false,
              browser: ['Automatyn', 'Chrome', '1.0'],
              syncFullHistory: false,
              markOnlineOnConnect: false,
            });
            newSock.ev.on('creds.update', reloaded.saveCreds);
            newSock.ev.on('connection.update', onUpdate);
            const stored = activeSessions.get(agentId);
            if (stored) stored.sock = newSock;
          })().catch((e) => { clearTimeout(timeout); reject(e); });
          return;
        }
        if (!currentState.creds.registered && !statusCode) {
          // Pre-pair silent close — pairing code becomes stale. User must request a new one.
          console.log(`[whatsapp:${agentId}] socket closed pre-pair, awaiting new pairing-code request`);
          return;
        }
        clearTimeout(timeout);
        reject(new Error(`Pairing failed (${statusCode || 'no-code'}): ${errMsg}`));
      }
    };
    sock.ev.on('connection.update', onUpdate);
  });
  // Swallow unhandled-rejection if the consumer never awaits
  connectionPromise.catch(() => {});

  // Baileys requires the socket to reach 'connecting' state before requestPairingCode.
  // Wait briefly so the request doesn't race the WS handshake.
  await new Promise((r) => setTimeout(r, 1500));
  let pairingCode;
  try {
    pairingCode = await sock.requestPairingCode(phone);
  } catch (err) {
    try { sock.end(); } catch {}
    throw new Error(`Could not request pairing code: ${err.message}`);
  }

  // Store session
  activeSessions.set(agentId, {
    sock,
    connectionPromise,
    phone,
    createdAt: Date.now(),
  });

  return {
    pairingCode,
    message: `Open WhatsApp on your phone > Settings > Linked Devices > Link a Device > Link with phone number instead > Enter code: ${pairingCode}`,
  };
}

/**
 * Start WhatsApp pairing via QR code.
 * Returns a data URL with the QR code image.
 */
async function startQrPairing(agentId) {
  // Kill any existing session for this agent
  await disconnectSession(agentId);

  const authDir = getAuthDir(agentId);
  // Wipe stale partial auth — see startPairingCode for rationale.
  if (fs.existsSync(authDir)) {
    try { fs.rmSync(authDir, { recursive: true, force: true }); } catch {}
  }
  fs.mkdirSync(authDir, { recursive: true, mode: 0o700 });

  const logger = pino({ level: 'debug' }, pino.destination({ dest: '/home/marketingpatpat/openclaw/saas-api/baileys.log', sync: true }));
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  // fetchLatestBaileysVersion() lags behind real WA Web. Use the actual current
  // client_revision from web.whatsapp.com/sw.js, with the cached helper as fallback.
  let version;
  try {
    version = await getCurrentWAWebVersion();
  } catch {
    version = (await fetchLatestBaileysVersion()).version;
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('QR generation timed out. Please try again.'));
    }, 30000);

    const sock = makeWASocket({
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
      version,
      logger,
      printQRInTerminal: false,
      browser: ['Automatyn', 'Chrome', '1.0'],
      syncFullHistory: false,
      markOnlineOnConnect: false,
    });

    sock.ev.on('creds.update', saveCreds);

    // QR pair: reload state from disk on 515 reconnect, only resolve when registered=true.
    let qrCurrentState = state;
    let saw515 = false;
    const connectionPromise = new Promise((connResolve, connReject) => {
      const onUpdate = (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'open') {
          if (qrCurrentState.creds.registered) {
            connResolve({ connected: true });
          }
          return;
        }
        if (connection === 'close') {
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          const errMsg = lastDisconnect?.error?.message || 'connection closed';
          console.log(`[whatsapp:${agentId}] QR close — code=${statusCode} msg=${errMsg} registered=${qrCurrentState.creds.registered}`);
          const is515 = statusCode === 515 || statusCode === DisconnectReason.restartRequired;
          if (is515) saw515 = true;
          // Reconnect only on the explicit 515 from WA, OR on the silent-close that
          // immediately follows a 515 during the post-pair restart cycle.
          // Pre-scan silent closes are NOT a reconnect signal — they spawn duplicate
          // sockets that fight each other and cause "QR refs attempts ended".
          if (is515 || (!statusCode && saw515 && !qrCurrentState.creds.registered)) {
            console.log(`[whatsapp:${agentId}] QR reconnecting after ${statusCode || 'post-515-silent-close'}`);
            (async () => {
              const reloaded = await useMultiFileAuthState(authDir);
              qrCurrentState = reloaded.state;
              const newSock = makeWASocket({
                auth: { creds: reloaded.state.creds, keys: makeCacheableSignalKeyStore(reloaded.state.keys, logger) },
                version, logger,
                printQRInTerminal: false,
                browser: ['Automatyn', 'Chrome', '1.0'],
                syncFullHistory: false,
                markOnlineOnConnect: false,
              });
              newSock.ev.on('creds.update', reloaded.saveCreds);
              newSock.ev.on('connection.update', onUpdate);
              const stored = activeSessions.get(agentId);
              if (stored) stored.sock = newSock;
            })().catch((e) => connReject(e));
            return;
          }
          if (statusCode === DisconnectReason.loggedOut) {
            connReject(new Error('WhatsApp logged out.'));
            activeSessions.delete(agentId);
            try {
              const authDir2 = getAuthDir(agentId);
              if (fs.existsSync(authDir2)) fs.rmSync(authDir2, { recursive: true, force: true });
            } catch {}
          } else if (!qrCurrentState.creds.registered && !statusCode) {
            // Pre-scan silent close from WA. QR becomes stale; user must request a new one.
            // Do NOT reject — that would surface an error before they've even tried.
            console.log(`[whatsapp:${agentId}] QR socket closed pre-scan, awaiting new QR request`);
          } else {
            connReject(new Error(`Pairing failed (${statusCode || 'no-code'}): ${errMsg}`));
          }
        }
      };
      sock.ev.on('connection.update', onUpdate);
    });
    // Attach a swallow-handler so an unawaited rejection never crashes the process.
    connectionPromise.catch(() => {});

    sock.ev.on('connection.update', async (update) => {
      const { qr } = update;
      if (qr) {
        clearTimeout(timeout);
        try {
          const qrDataUrl = await QRCode.toDataURL(qr, { width: 300, margin: 2 });
          activeSessions.set(agentId, {
            sock,
            connectionPromise,
            createdAt: Date.now(),
          });
          resolve({ qrDataUrl, message: 'Scan this QR code with WhatsApp > Linked Devices > Link a Device' });
        } catch (err) {
          reject(err);
        }
      }
    });
  });
}

/**
 * Check if WhatsApp pairing was successful.
 */
async function checkPairingStatus(agentId) {
  const session = activeSessions.get(agentId);
  if (!session) {
    // Check if fully connected — require registered=true AND me.id (half-paired = registered:false)
    const authDir = getAuthDir(agentId);
    if (isWhatsAppConnected(agentId)) {
      try {
        const creds = JSON.parse(fs.readFileSync(path.join(authDir, 'creds.json'), 'utf-8'));
        return { connected: true, phone: creds.me.id.split(':')[0] };
      } catch {}
    }
    return { connected: false, message: 'No active pairing session. Start a new one.' };
  }

  try {
    // Check with a short timeout
    const result = await Promise.race([
      session.connectionPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('still_waiting')), 1000)),
    ]);

    // Connected! Disconnect our session so OpenClaw gateway can take over
    await disconnectSession(agentId);

    // Register WhatsApp channel with OpenClaw gateway
    registerWhatsAppWithGateway(agentId);

    return { connected: true };
  } catch (err) {
    if (err.message === 'still_waiting') {
      return { connected: false, message: 'Waiting for you to scan/enter the code...' };
    }
    return { connected: false, message: err.message };
  }
}

/**
 * Disconnect and clean up a session.
 */
async function disconnectSession(agentId) {
  const session = activeSessions.get(agentId);
  if (session) {
    try {
      session.sock.end();
    } catch (e) {
      // ignore
    }
    activeSessions.delete(agentId);
  }
}

/**
 * Check if an agent has WhatsApp connected (from saved auth).
 */
function isWhatsAppConnected(agentId) {
  const authDir = getAuthDir(agentId);
  const credsFile = path.join(authDir, 'creds.json');
  if (!fs.existsSync(credsFile)) return false;
  try {
    const creds = JSON.parse(fs.readFileSync(credsFile, 'utf-8'));
    if (!creds.me?.id) return false;
    // Pair is real once Baileys has saved at least one pre-key file.
    // 'registered' flips later but full handshake is done by then.
    const files = fs.readdirSync(authDir);
    return files.some((f) => f.startsWith('pre-key-'));
  } catch {
    return false;
  }
}

/**
 * Register WhatsApp channel with OpenClaw gateway config.
 * After pairing, we hand off to OpenClaw to handle messages.
 */
function registerWhatsAppWithGateway(agentId) {
  const authDir = getAuthDir(agentId);

  return withConfigLock(() => {
    const config = loadConfig();

    if (!config.channels) config.channels = {};
    if (!config.channels.whatsapp) {
      config.channels.whatsapp = { enabled: true, accounts: {} };
    }
    if (!config.channels.whatsapp.accounts) {
      config.channels.whatsapp.accounts = {};
    }

    config.channels.whatsapp.accounts[agentId] = {
      enabled: true,
      name: agentId,
      authDir: authDir,
      dmPolicy: 'open',
      allowFrom: ['*'],
      groupPolicy: 'open',
      debounceMs: 0,
    };

    if (!Array.isArray(config.bindings)) config.bindings = [];
    config.bindings = config.bindings.filter(
      (b) => !(b?.match?.channel === 'whatsapp' && b?.match?.accountId === agentId)
    );
    config.bindings.push({
      type: 'route',
      agentId,
      match: { channel: 'whatsapp', accountId: agentId },
    });

    config.meta.lastTouchedAt = new Date().toISOString();
    saveConfig(config);

    if (!reloadGateway()) {
      console.error(`Gateway reload failed after registering WhatsApp for ${agentId}`);
    } else {
      console.log(`WhatsApp channel registered for agent ${agentId}`);
    }
  });
}

/**
 * Fully unpair WhatsApp: disconnect session, delete auth files, remove from gateway config.
 */
async function unpairWhatsApp(agentId) {
  // 1. Kill active session
  await disconnectSession(agentId);

  // 2. Delete auth directory
  const authDir = getAuthDir(agentId);
  if (fs.existsSync(authDir)) {
    fs.rmSync(authDir, { recursive: true, force: true });
  }

  // 3. Remove from gateway config (locked to prevent concurrent writes)
  await withConfigLock(() => {
    const config = loadConfig();
    if (config.channels?.whatsapp?.accounts?.[agentId]) {
      delete config.channels.whatsapp.accounts[agentId];
      config.meta.lastTouchedAt = new Date().toISOString();
      saveConfig(config);
      reloadGateway();
      console.log(`WhatsApp unpaired for agent ${agentId}`);
    }
  });
}

/**
 * Set bot active/paused in gateway config.
 * When paused, the WhatsApp account is removed from gateway so the bot stops responding.
 * When activated, it's re-added.
 */
function setBotActive(agentId, active) {
  const authDir = getAuthDir(agentId);
  const credsFile = path.join(authDir, 'creds.json');

  // Can only activate if WhatsApp auth exists
  if (active && !fs.existsSync(credsFile)) {
    throw new Error('WhatsApp not connected. Pair first.');
  }

  return withConfigLock(() => {
    const config = loadConfig();
    if (!config.channels) config.channels = {};
    if (!config.channels.whatsapp) config.channels.whatsapp = { enabled: true, accounts: {} };
    if (!config.channels.whatsapp.accounts) config.channels.whatsapp.accounts = {};

    if (active) {
      config.channels.whatsapp.accounts[agentId] = {
        enabled: true,
        name: agentId,
        authDir: authDir,
        dmPolicy: 'open',
        allowFrom: ['*'],
        groupPolicy: 'open',
        debounceMs: 0,
      };
    } else {
      delete config.channels.whatsapp.accounts[agentId];
    }

    config.meta.lastTouchedAt = new Date().toISOString();
    saveConfig(config);

    if (!reloadGateway()) {
      console.error('[whatsapp] setBotActive: gateway reload failed (config saved, will apply on next restart)');
      return { ok: true, reloaded: false };
    }
    return { ok: true, reloaded: true };
  });
}

module.exports = {
  startPairingCode,
  startQrPairing,
  checkPairingStatus,
  disconnectSession,
  isWhatsAppConnected,
  unpairWhatsApp,
  setBotActive,
};
