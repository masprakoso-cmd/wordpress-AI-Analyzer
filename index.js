import makeWASocket, { 
  useMultiFileAuthState, 
  DisconnectReason, 
  fetchLatestBaileysVersion 
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import express from 'express';
import axios from 'axios';
import pino from 'pino';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const NUMBERS = [
  { id: 'pegibromo',    brand: 'Pegibromo',    label: 'Pegibromo' },
  { id: 'jelajahnesia', brand: 'Jelajahnesia', label: 'Jelajahnesia' },
];

const CONFIG = {
  WP_WEBHOOK_URL:     process.env.WP_WEBHOOK_URL || 'https://jelajahnesia.id/wp-json/ai-analyzer/v1/webhook',
  WEBHOOK_SECRET:     process.env.WEBHOOK_SECRET || 'jelajahnesia2024secret',
  PORT:               process.env.PORT || 3000,
  IGNORE_GROUPS:      process.env.IGNORE_GROUPS !== 'false',
  MIN_MESSAGE_LENGTH: 3,
};

const app = express();
app.use(express.json());
const connections = {};

app.get('/', (req, res) => {
  res.json({ service: 'Jelajahnesia WA Connector', connections: NUMBERS.map(n => ({ id: n.id, status: connections[n.id]?.status || 'disconnected' })) });
});
app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.listen(CONFIG.PORT, () => console.log(`Server berjalan di port ${CONFIG.PORT}`));

async function startAll() {
  for (const numConfig of NUMBERS) {
    await new Promise(r => setTimeout(r, 3000));
    startWhatsApp(numConfig);
  }
}

async function startWhatsApp(numConfig) {
  const { id, brand, label } = numConfig;
  const authFolder = path.join(__dirname, 'auth_info', id);
  if (!fs.existsSync(authFolder)) fs.mkdirSync(authFolder, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authFolder);
  const { version } = await fetchLatestBaileysVersion();

  connections[id] = { status: 'connecting' };

  const sock = makeWASocket({
    version, auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: true,
    browser: [`Jelajahnesia-${brand}`, 'Chrome', '1.0'],
    markOnlineOnConnect: false,
  });

  connections[id].sock = sock;
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) console.log(`\n[${label}] SCAN QR CODE INI di WhatsApp -> Perangkat Tertaut\n`);
    if (connection === 'close') {
      connections[id].status = 'disconnected';
      const shouldReconnect = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut : true;
      console.log(`[${label}] Terputus. Reconnect: ${shouldReconnect}`);
      if (shouldReconnect) setTimeout(() => startWhatsApp(numConfig), 5000);
    }
    if (connection === 'open') { connections[id].status = 'connected'; console.log(`[${label}] Terhubung!`); }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      try {
        if (msg.key.fromMe) continue;
        if (Date.now() - msg.messageTimestamp * 1000 > 30000) continue;
        const isGroup = msg.key.remoteJid?.endsWith('@g.us') || false;
        if (CONFIG.IGNORE_GROUPS && isGroup) continue;
        const body = msg.message?.conversation || msg.message?.extendedTextMessage?.text || msg.message?.imageMessage?.caption || null;
        if (!body || body.length < CONFIG.MIN_MESSAGE_LENGTH) continue;
        const from = isGroup ? msg.key.participant?.replace('@s.whatsapp.net', '') : msg.key.remoteJid?.replace('@s.whatsapp.net', '');
        console.log(`[${label}] ${msg.pushName || from}: "${body.substring(0, 50)}"`);
        await axios.post(CONFIG.WP_WEBHOOK_URL, {
          id: msg.key.id, from, pushName: msg.pushName || '',
          body, isGroup, direction: 'in', timestamp: msg.messageTimestamp,
          account_id: id, account_brand: brand, account_label: label,
        }, { headers: { 'Content-Type': 'application/json', 'X-Webhook-Secret': CONFIG.WEBHOOK_SECRET }, timeout: 15000 });
        console.log(`WordPress: OK`);
      } catch (err) { console.error(`[${label}] Error:`, err.message); }
    }
  });
}

startAll().catch(err => { console.error('Fatal:', err); process.exit(1); });
