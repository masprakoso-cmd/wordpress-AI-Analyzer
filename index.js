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
import qrcode from 'qrcode';

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
const qrCodes = {}; // simpan QR per nomor

// ── HALAMAN STATUS + QR CODE ─────────────────────────────────
app.get('/', async (req, res) => {
  let html = `
  <html><head><meta charset="utf-8">
  <meta http-equiv="refresh" content="15">
  <title>Jelajahnesia WA Connector</title>
  <style>
    body{font-family:sans-serif;background:#0a0e1a;color:#e2e8f0;padding:30px}
    h1{color:#f59e0b}h2{color:#94a3b8;font-size:14px}
    .card{background:#111827;border:1px solid #1e2d45;border-radius:12px;padding:20px;margin:16px 0;display:inline-block;margin-right:20px;vertical-align:top}
    .online{color:#10b981;font-weight:bold}.offline{color:#ef4444}.waiting{color:#f59e0b}
    img{border-radius:8px}
    .note{color:#64748b;font-size:12px;margin-top:8px}
  </style></head>
  <body>
  <h1>Jelajahnesia AI Connector</h1>
  <h2>Halaman ini auto-refresh setiap 15 detik</h2>`;

  for (const n of NUMBERS) {
    const status = connections[n.id]?.status || 'disconnected';
    const statusClass = status === 'connected' ? 'online' : status === 'connecting' ? 'waiting' : 'offline';
    const statusText  = status === 'connected' ? '✅ Terhubung' : status === 'connecting' ? '⏳ Menunggu Scan...' : '❌ Terputus';

    html += `<div class="card">
      <h2>${n.label}</h2>
      <p class="${statusClass}">${statusText}</p>`;

    if (qrCodes[n.id] && status !== 'connected') {
      try {
        const qrDataUrl = await qrcode.toDataURL(qrCodes[n.id]);
        html += `<br><img src="${qrDataUrl}" width="250" height="250"><br>
        <p class="note">Scan dengan WA nomor ${n.brand}</p>`;
      } catch(e) {
        html += `<p>QR tidak bisa ditampilkan</p>`;
      }
    }

    html += `</div>`;
  }

  html += `</body></html>`;
  res.send(html);
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(CONFIG.PORT, () => {
  console.log(`Server berjalan di port ${CONFIG.PORT}`);
  console.log(`Buka URL Railway untuk lihat QR code\n`);
});

// ── START SEMUA KONEKSI ──────────────────────────────────────
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
    printQRInTerminal: false,
    browser: [`Jelajahnesia-${brand}`, 'Chrome', '1.0'],
    markOnlineOnConnect: false,
  });

  connections[id].sock = sock;
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      qrCodes[id] = qr;
      console.log(`[${label}] QR baru tersedia - buka URL Railway untuk scan`);
    }

    if (connection === 'close') {
      connections[id].status = 'disconnected';
      const shouldReconnect = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut : true;
      console.log(`[${label}] Terputus. Reconnect: ${shouldReconnect}`);
      if (shouldReconnect) setTimeout(() => startWhatsApp(numConfig), 5000);
    }

    if (connection === 'open') {
      connections[id].status = 'connected';
      delete qrCodes[id];
      console.log(`[${label}] Terhubung!`);
    }
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
        const from = isGroup
          ? msg.key.participant?.replace('@s.whatsapp.net', '')
          : msg.key.remoteJid?.replace('@s.whatsapp.net', '');
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
