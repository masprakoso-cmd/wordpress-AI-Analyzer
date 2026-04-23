// ============================================================
// JELAJAHNESIA WHATSAPP AI CONNECTOR — MULTI NUMBER
// Node.js + Baileys — Deploy di Railway
// Mendukung banyak nomor WA sekaligus
// ============================================================

const { default: makeWASocket, useMultiFileAuthState,
        DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const express  = require('express');
const axios    = require('axios');
const pino     = require('pino');
const fs       = require('fs');
const path     = require('path');

// ── KONFIGURASI MULTI NUMBER ─────────────────────────────────
// Tambah/kurangi nomor di sini
// brand: nama brand untuk ditampilkan di dashboard
const NUMBERS = [
  {
    id:     'pegibromo',
    brand:  'Pegibromo',
    label:  '🏔️ Pegibromo',
  },
  {
    id:     'jelajahnesia',
    brand:  'Jelajahnesia',
    label:  '✈️ Jelajahnesia',
  },
  // Tambah nomor lain di sini jika perlu:
  // {
  //   id:    'brand3',
  //   brand: 'Brand 3',
  //   label: '🌴 Brand 3',
  // },
];

const CONFIG = {
  WP_WEBHOOK_URL:    process.env.WP_WEBHOOK_URL || 'https://jelajahnesia.id/wp-json/ai-analyzer/v1/webhook',
  WEBHOOK_SECRET:    process.env.WEBHOOK_SECRET || 'jelajahnesia2024secret',
  PORT:              process.env.PORT || 3000,
  IGNORE_GROUPS:     process.env.IGNORE_GROUPS !== 'false',
  MIN_MESSAGE_LENGTH: 3,
};

// ── EXPRESS SERVER ───────────────────────────────────────────
const app = express();
app.use(express.json());

// Status semua koneksi
const connections = {};

app.get('/', (req, res) => {
  const status = NUMBERS.map(n => ({
    id:     n.id,
    brand:  n.brand,
    status: connections[n.id]?.status || 'disconnected',
  }));
  res.json({ service: 'Jelajahnesia WA Multi Connector', connections: status });
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Endpoint untuk cek status per nomor
app.get('/status/:id', (req, res) => {
  const conn = connections[req.params.id];
  res.json(conn ? { id: req.params.id, status: conn.status } : { error: 'not found' });
});

app.listen(CONFIG.PORT, () => {
  console.log(`✅ Server berjalan di port ${CONFIG.PORT}`);
  console.log(`📱 Akan menghubungkan ${NUMBERS.length} nomor WA...\n`);
});

// ── START SEMUA KONEKSI ──────────────────────────────────────
async function startAll() {
  for (const numConfig of NUMBERS) {
    // Delay 3 detik antar koneksi agar tidak bentrok
    await new Promise(r => setTimeout(r, 3000));
    startWhatsApp(numConfig);
  }
}

// ── BAILEYS CONNECTION PER NOMOR ─────────────────────────────
async function startWhatsApp(numConfig) {
  const { id, brand, label } = numConfig;

  // Folder auth terpisah per nomor
  const authFolder = path.join(__dirname, 'auth_info', id);
  if (!fs.existsSync(authFolder)) fs.mkdirSync(authFolder, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authFolder);
  const { version } = await fetchLatestBaileysVersion();

  connections[id] = { status: 'connecting' };

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: true,
    browser: [`Jelajahnesia-${brand}`, 'Chrome', '1.0'],
    markOnlineOnConnect: false,
  });

  connections[id].sock = sock;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log(`\n📱 [${label}] SCAN QR CODE INI:`);
      console.log(`Buka WA nomor ${brand} → Perangkat Tertaut → Tautkan Perangkat\n`);
    }

    if (connection === 'close') {
      connections[id].status = 'disconnected';
      const shouldReconnect = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut
        : true;

      console.log(`⚠️ [${label}] Terputus. Reconnect: ${shouldReconnect}`);
      if (shouldReconnect) setTimeout(() => startWhatsApp(numConfig), 5000);
    }

    if (connection === 'open') {
      connections[id].status = 'connected';
      console.log(`✅ [${label}] Terhubung!`);
    }
  });

  // ── HANDLE PESAN MASUK PER NOMOR ──────────────────────────
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      try {
        if (msg.key.fromMe) continue;

        const msgTime = msg.messageTimestamp * 1000;
        if (Date.now() - msgTime > 30000) continue;

        const isGroup = msg.key.remoteJid?.endsWith('@g.us') || false;
        if (CONFIG.IGNORE_GROUPS && isGroup) continue;

        const body = extractMessageText(msg);
        if (!body || body.length < CONFIG.MIN_MESSAGE_LENGTH) continue;

        const from = isGroup
          ? msg.key.participant?.replace('@s.whatsapp.net', '')
          : msg.key.remoteJid?.replace('@s.whatsapp.net', '');

        const pushName = msg.pushName || '';

        console.log(`📨 [${label}] ${pushName || from}: "${body.substring(0, 40)}..."`);

        // Kirim ke WordPress + info brand/nomor
        await sendToWordPress({
          id:        msg.key.id,
          from:      from,
          to:        sock.user?.id?.split(':')[0] || '',
          pushName:  pushName,
          body:      body,
          isGroup:   isGroup,
          direction: 'in',
          timestamp: msg.messageTimestamp,
          // INFO TAMBAHAN MULTI NUMBER:
          account_id:    id,
          account_brand: brand,
          account_label: label,
        });

      } catch (err) {
        console.error(`❌ [${label}] Error:`, err.message);
      }
    }
  });
}

// ── EKSTRAK TEKS PESAN ───────────────────────────────────────
function extractMessageText(msg) {
  const m = msg.message;
  if (!m) return null;
  return m.conversation
    || m.extendedTextMessage?.text
    || m.imageMessage?.caption
    || m.videoMessage?.caption
    || m.documentMessage?.caption
    || m.buttonsResponseMessage?.selectedDisplayText
    || m.listResponseMessage?.title
    || null;
}

// ── KIRIM KE WORDPRESS ───────────────────────────────────────
async function sendToWordPress(payload) {
  try {
    const res = await axios.post(CONFIG.WP_WEBHOOK_URL, payload, {
      headers: {
        'Content-Type':    'application/json',
        'X-Webhook-Secret': CONFIG.WEBHOOK_SECRET,
      },
      timeout: 15000,
    });
    console.log(`✅ WordPress: ${res.status}`);
  } catch (err) {
    console.error('❌ Gagal kirim ke WordPress:', err.message);
  }
}

// ── START ────────────────────────────────────────────────────
startAll().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
