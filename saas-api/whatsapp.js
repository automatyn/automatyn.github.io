const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, DisconnectReason } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const pino = require('pino');
const path = require('path');
const fs = require('fs');

const AGENTS_DIR = path.join(require('os').homedir(), '.openclaw', 'agents');

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
  fs.mkdirSync(authDir, { recursive: true });

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
  fs.mkdirSync(authDir, { recursive: true });

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

module.exports = {
  startPairingCode,
  startQrPairing,
  checkPairingStatus,
  disconnectSession,
  isWhatsAppConnected,
};
