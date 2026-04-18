const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, DisconnectReason } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const pino = require('pino');
const path = require('path');
const fs = require('fs');

const AGENTS_DIR = path.join(require('os').homedir(), '.openclaw', 'agents');
const { loadConfig, saveConfig, reloadGateway, withConfigLock } = require('./provision');

// Track active sessions per agent
const activeSessions = new Map();

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
  const phone = phoneNumber.replace(/[\s\-\+\(\)]/g, '');
  if (!/^\d{10,15}$/.test(phone)) {
    throw new Error('Invalid phone number. Use format: 44XXXXXXXXXX (country code + number, no +)');
  }

  // Kill any existing session for this agent
  await disconnectSession(agentId);

  const authDir = getAuthDir(agentId);
  fs.mkdirSync(authDir, { recursive: true, mode: 0o700 });

  const logger = pino({ level: 'silent' });
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();

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

  // Create a promise that resolves when connected or fails
  const connectionPromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Connection timed out. Please try again.'));
    }, 60000);

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect } = update;
      if (connection === 'open') {
        clearTimeout(timeout);
        resolve({ connected: true });
      }
      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        if (statusCode === DisconnectReason.loggedOut) {
          clearTimeout(timeout);
          reject(new Error('WhatsApp logged out. Please try again.'));
        }
      }
    });
  });

  // Request pairing code
  const pairingCode = await sock.requestPairingCode(phone);

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
  fs.mkdirSync(authDir, { recursive: true, mode: 0o700 });

  const logger = pino({ level: 'silent' });
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();

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

    // Create connection promise for later checking
    const connectionPromise = new Promise((connResolve, connReject) => {
      sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'open') {
          connResolve({ connected: true });
        }
        if (connection === 'close') {
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          if (statusCode === DisconnectReason.loggedOut) {
            connReject(new Error('WhatsApp logged out.'));
          }
        }
      });
    });

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
    // Check if already connected (auth files exist)
    const authDir = getAuthDir(agentId);
    const credsFile = path.join(authDir, 'creds.json');
    if (fs.existsSync(credsFile)) {
      const creds = JSON.parse(fs.readFileSync(credsFile, 'utf-8'));
      if (creds.me?.id) {
        return { connected: true, phone: creds.me.id.split(':')[0] };
      }
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
  if (fs.existsSync(credsFile)) {
    try {
      const creds = JSON.parse(fs.readFileSync(credsFile, 'utf-8'));
      return !!creds.me?.id;
    } catch (e) {
      return false;
    }
  }
  return false;
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
      authDir: authDir,
      dmPolicy: 'pairing',
      agent: agentId,
    };

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
        authDir: authDir,
        dmPolicy: 'pairing',
        agent: agentId,
      };
    } else {
      delete config.channels.whatsapp.accounts[agentId];
    }

    config.meta.lastTouchedAt = new Date().toISOString();
    saveConfig(config);

    if (!reloadGateway()) {
      throw new Error('Gateway reload failed. Your change was saved but may not take effect until the gateway restarts.');
    }
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
