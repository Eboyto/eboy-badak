import fs from 'fs';
import path from 'path';
import readline from 'readline/promises';
import { stdin as input, stdout as output } from 'process';
import { fileURLToPath } from 'url';
import pino from 'pino';
import QRCode from 'qrcode';
import express from 'express';
import cors from 'cors';
import { CONFIG } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, 'data');
const AUTH = path.join(__dirname, 'auth');
const SESSIONS = path.join(__dirname, 'sessions');
const PHONE_FILE = path.join(__dirname, 'phone.txt');

const VIDEO_MP4 = 'https://www.w3schools.com/html/mov_bbb.mp4';
const AUDIO_VN = 'https://cdn.pixabay.com/download/audio/2022/03/15/audio_c8c8a73467.mp3';
const PROFILE_PIC_URL = 'https://cdn.phototourl.com/member/2026-11-04-629ba914-cb53-48e6-b7de-6cda8d2f9199.jpg';
const CHANNEL_JID = CONFIG.channelJid;

[DATA, AUTH, SESSIONS].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

let makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers, getContentType, jidNormalizedUser;
try {
  const b = await import('@whiskeysockets/baileys');
  makeWASocket = b.default ?? b.makeWASocket;
  useMultiFileAuthState = b.useMultiFileAuthState;
  DisconnectReason = b.DisconnectReason;
  fetchLatestBaileysVersion = b.fetchLatestBaileysVersion;
  Browsers = b.Browsers;
  getContentType = b.getContentType;
  jidNormalizedUser = b.jidNormalizedUser;
} catch (e) { console.error('❌ Baileys:', e.message); process.exit(1); }

// ===== ANTI-BAN HELPERS =====
const delay = (ms) => new Promise(r => setTimeout(r, ms));
const jitter = (base, f = CONFIG.antiBan.jitterFactor) =>
  Math.max(200, base + (Math.random() * 2 - 1) * base * f);

async function typingBurst(sock, jid, len = 50) {
  try {
    await sock.sendPresenceUpdate('composing', jid);
    await delay(jitter(Math.min(CONFIG.antiBan.typingMaxMs, len * 30 + 600)));
    await sock.sendPresenceUpdate('paused', jid);
  } catch {}
}

async function safeSend(sock, jid, content, opts = {}) {
  try {
    await typingBurst(sock, jid, (content.text || content.caption || '').length);
    return await sock.sendMessage(jid, content, opts);
  } catch {
    return sock.sendMessage(jid, content, opts).catch(() => null);
  }
}

const varyMsg = (text) => {
  const suffixes = ['', ' 🔥', ' ⚡', ' ✨', ' 🎯', `\n\n_${CONFIG.channelUrl}_`];
  const pick = suffixes[Math.floor(Math.random() * suffixes.length)];
  return pick.startsWith('\n') ? text + pick : text + pick;
};

const normalizePhone = (raw) => {
  let n = String(raw || '').replace(/[^0-9]/g, '');
  if (!n) return '';
  if (n.startsWith('0')) n = '62' + n.slice(1);
  if (!n.startsWith('62')) n = '62' + n;
  return n;
};

const getText = (m) => {
  const x = m.message ?? {};
  return x.conversation ?? x.extendedTextMessage?.text ?? x.imageMessage?.caption ??
    x.videoMessage?.caption ?? x.buttonsResponseMessage?.selectedButtonId ??
    x.listResponseMessage?.singleSelectReply?.selectedRowId ?? '';
};

// ===== AUTO CLEAN =====
const cleanupTimers = new Map();
function scheduleAutoClean(sock, jid, { mute = false, delayMs = CONFIG.antiBan.autoClearAfterMs } = {}) {
  if (cleanupTimers.has(jid)) clearTimeout(cleanupTimers.get(jid));
  const t = setTimeout(async () => {
    cleanupTimers.delete(jid);
    try {
      if (mute) await sock.chatModify({ mute: 31536000000 }, jid).catch(() => {});
      await sock.chatModify({ clear: jid }, jid).catch(() => {});
    } catch {}
  }, delayMs);
  cleanupTimers.set(jid, t);
}
const autoCleanChat = (sock, jid, opts) => scheduleAutoClean(sock, jid, opts);

// ===== SPAM TRACKER =====
const spamTracker = new Map();
function trackSpam(sender) {
  const now = Date.now();
  const cur = spamTracker.get(sender) || { count: 0, last: 0 };
  if (now - cur.last > CONFIG.antiBan.spamWindowMs) cur.count = 0;
  cur.count++;
  cur.last = now;
  spamTracker.set(sender, cur);
  return cur.count;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of spamTracker) if (now - v.last > 60000) spamTracker.delete(k);
}, 30000);

// ===== SPAM-KILL: auto block + auto report + auto mute =====
const bannedUsers = new Set();
const reportLog = [];
async function executeSpamKill(sock, jid, sender, reason, severity = 'high') {
  const key = sender;
  if (bannedUsers.has(key) && severity !== 'critical') return false;
  bannedUsers.add(key);

  // 1. Block user
  try { await sock.updateBlockStatus(sender, 'block'); } catch {}

  // 2. Report user to WA
  try {
    const spamMsgId = 'BAE5' + Math.random().toString(36).slice(2, 10).toUpperCase();
    await sock.reportSpam(sender, [spamMsgId]);
  } catch {}

  // 3. Mute + clear chat
  autoCleanChat(sock, jid, { mute: true, delayMs: 500 });

  // 4. Log
  reportLog.push({ at: Date.now(), sender, jid, reason, severity });
  if (reportLog.length > 200) reportLog.shift();

  // 5. Notify owner
  try {
    await sock.sendMessage(CONFIG.ownerJid, {
      text: `🚫 *SPAM KILL EXECUTED*\n\n👤 Target: ${sender.split('@')[0]}\n📱 Chat: ${jid}\n⚠️ Reason: ${reason}\n🔥 Severity: ${severity.toUpperCase()}\n🕐 ${new Date().toLocaleString('id-ID')}\n\n> Auto-block ✓ Auto-report ✓ Auto-mute ✓`
    });
  } catch {}

  return true;
}

// ===== VIEW ONCE BYPASS =====
async function handleViewOnce(sock, m) {
  try {
    if (!m.message || m.key.fromMe) return false;
    const type = getContentType(m.message);
    const voTypes = ['viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension'];
    if (!voTypes.includes(type)) return false;

    const wrapper = m.message[type];
    const inner = wrapper?.message;
    if (!inner) return false;

    const innerType = getContentType(inner);
    if (!['imageMessage', 'videoMessage', 'audioMessage'].includes(innerType)) return false;

    let buffer = null;
    for (let i = 0; i < 3 && !buffer; i++) {
      try {
        buffer = await sock.downloadMediaMessage({ message: inner, key: m.key });
      } catch { await delay(1200 + Math.random() * 800); }
    }
    if (!buffer) return false;

    const jid = m.key.remoteJid;
    const sender = m.key.participant || jid;
    const cap = `📸 *[BYPASS SEKALI LIHAT]*\n> Dari: ${m.pushName || sender.split('@')[0]}\n> ${new Date().toLocaleString('id-ID')}\n\n_${CONFIG.channelUrl}_`;

    if (innerType === 'audioMessage') await safeSend(sock, jid, { audio: buffer, mimetype: 'audio/mp4', ptt: true });
    else if (innerType === 'videoMessage') await safeSend(sock, jid, { video: buffer, caption: cap });
    else await safeSend(sock, jid, { image: buffer, caption: cap });

    autoCleanChat(sock, jid);
    return true;
  } catch { return false; }
}

// ===== CHANNEL NOTIFIER =====
async function notifyChannel(sock, text) {
  if (!sock) return;
  try { await sock.sendMessage(CHANNEL_JID, { text: varyMsg(text) }); }
  catch (e) { console.log('channel notify skip:', e.message); }
}

// ===== PREMIUM SENDER =====
async function sendPremiumResponse(sock, jid, text, quotedMsg = null, opts = {}) {
  try {
    const body = varyMsg(text);
    const msg = await sock.sendMessage(jid, { text: '⏳ *[SYSTEM INIT]*\n> Menyiapkan...' }, { quoted: quotedMsg });
    const frames = [
      '⏳ *[SYSTEM INIT]*\n[■■□□□□□□□□] 20%',
      '⏳ *[SYSTEM INIT]*\n[■■■■■□□□□□] 50%',
      '⏳ *[SYSTEM INIT]*\n[■■■■■■■■□□] 80%',
      '✅ *[READY]*\n[■■■■■■■■■■] 100%'
    ];
    for (const f of frames) {
      await delay(jitter(750, 0.4));
      await sock.sendMessage(jid, { text: f, edit: msg.key }).catch(() => {});
    }
    await delay(400);
    await sock.sendMessage(jid, { delete: msg.key }).catch(() => {});

    if (opts.asText) {
      await safeSend(sock, jid, { text: body }, { quoted: quotedMsg });
    } else {
      await safeSend(sock, jid, { video: { url: VIDEO_MP4 }, caption: body, gifPlayback: true }, { quoted: quotedMsg })
        .catch(() => safeSend(sock, jid, { text: body }, { quoted: quotedMsg }));
      await delay(jitter(900));
      await safeSend(sock, jid, { audio: { url: AUDIO_VN }, mimetype: 'audio/mp4', ptt: true }, { quoted: quotedMsg }).catch(() => {});
    }
    autoCleanChat(sock, jid);
  } catch {
    await sock.sendMessage(jid, { text }, { quoted: quotedMsg }).catch(() => {});
  }
}

// ===== DATABASE =====
const DB = {
  pending: path.join(DATA, 'pending.json'),
  active: path.join(DATA, 'active.json'),
  logs: path.join(DATA, 'logs.json'),
  contacts: path.join(DATA, 'contacts.json'),
  banned: path.join(DATA, 'banned.json')
};
const rj = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } };
const wj = (f, d) => { try { fs.writeFileSync(f, JSON.stringify(d, null, 2)); } catch {} };

let pendingDB = rj(DB.pending, {});
let activeDB = rj(DB.active, {});
let logsDB = rj(DB.logs, {});
let contactsDB = rj(DB.contacts, {});
let bannedDB = rj(DB.banned, []);

bannedDB.forEach(b => bannedUsers.add(b));

const activeSockets = new Map();
const pendingOff = new Map();

// ===== ANTI-REPORT (threat detection) =====
async function checkReportThreat(sock, m, text) {
  const lower = (text || '').toLowerCase();
  if (!CONFIG.reportKeywords.some(k => lower.includes(k))) return false;
  const jid = m.key.remoteJid;
  const sender = m.key.participant || jid;

  // CRITICAL: auto-kill
  await executeSpamKill(sock, jid, sender, `threat detected: ${lower.slice(0, 40)}`, 'critical');
  return true;
}

// ===== PUSH / BROADCAST =====
async function safeBroadcast(sock, targets, template) {
  let sent = 0, failed = 0;
  const list = targets.slice(0, CONFIG.antiBan.maxPushPerRun);
  for (const t of list) {
    if (!t || !t.includes('@')) continue;
    try {
      const body = varyMsg(template);
      await typingBurst(sock, t, body.length);
      await sock.sendMessage(t, { text: body });
      sent++;
    } catch { failed++; }
    await delay(jitter((CONFIG.antiBan.pushMinGapMs + CONFIG.antiBan.pushMaxGapMs) / 2, 0.3));
  }
  return { sent, failed };
}

// ===== SPAWN CHILD BADAK =====
async function spawnBadak(phone, durationMs, mainSock, chatJid) {
  const cleanPhone = normalizePhone(phone);
  if (activeSockets.has(cleanPhone)) {
    return sendPremiumResponse(mainSock, chatJid, `⚠️ Badak untuk ${cleanPhone} sudah aktif.`);
  }
  await sendPremiumResponse(mainSock, chatJid, `⏳ Memproses Badak untuk ${cleanPhone}...`);

  try {
    const sessionDir = path.join(SESSIONS, cleanPhone);
    if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();

    const badakSock = makeWASocket({
      version, auth: state, logger: pino({ level: 'silent' }),
      printQRInTerminal: false, browser: Browsers.macOS('Chrome'),
      mobile: false, shouldReconnect: () => false, markOnlineOnConnect: true
    });

    activeSockets.set(cleanPhone, badakSock);
    badakSock.ev.on('creds.update', saveCreds);
    activeDB[cleanPhone] = { phone: cleanPhone, expires: Date.now() + durationMs, created: Date.now() };
    wj(DB.active, activeDB);

    badakSock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const m of messages) {
        try {
          if (!m.message || m.key.fromMe) continue;
          const jid = m.key.remoteJid;
          if (!jid) continue;
          const sender = m.key.participant || jid;
          const text = getText(m).trim();
          const cmd = text.toLowerCase();

          // Already banned?
          if (bannedUsers.has(sender)) {
            try { await badakSock.updateBlockStatus(sender, 'block'); } catch {}
            autoCleanChat(badakSock, jid, { mute: true, delayMs: 200 });
            continue;
          }

          // Track contact
          if (!contactsDB[sender]) contactsDB[sender] = { first: Date.now(), name: m.pushName || '', count: 0 };
          contactsDB[sender].last = Date.now();
          contactsDB[sender].count = (contactsDB[sender].count || 0) + 1;
          wj(DB.contacts, contactsDB);

          // Anti-report threat detection (CRITICAL KILL)
          if (await checkReportThreat(badakSock, m, text)) continue;

          // Spam guard
          if (!m.isGroup) {
            const cnt = trackSpam(sender);
            if (cnt === CONFIG.antiBan.spamThreshold) {
              // Warning first
              await safeSend(badakSock, jid, {
                text: `⚠️ *SPAM DETECTED*\n\nKamu mengirim pesan terlalu cepat. Berhenti atau otomatis di-BLOCK + di-REPORT ke WhatsApp.\n\n> ${CONFIG.channelUrl}`
              }, { quoted: m }).catch(() => {});
              autoCleanChat(badakSock, jid, { mute: true });
            }
            if (cnt >= CONFIG.antiBan.spamHardThreshold) {
              await executeSpamKill(badakSock, jid, sender, `spam flood (${cnt}x in ${CONFIG.antiBan.spamWindowMs / 1000}s)`, 'high');
              bannedDB.push(sender);
              wj(DB.banned, bannedDB);
              continue;
            }
          }

          // View once bypass
          if (await handleViewOnce(badakSock, m)) continue;

          try { await badakSock.readMessages([m.key]); } catch {}

          // Logs
          if (!logsDB[cleanPhone]) logsDB[cleanPhone] = [];
          logsDB[cleanPhone].push({
            time: new Date().toLocaleString('id-ID'),
            from: sender.split('@')[0],
            name: m.pushName || '',
            text: text || '[Media]'
          });
          if (logsDB[cleanPhone].length > 100) logsDB[cleanPhone].shift();
          wj(DB.logs, logsDB);

          // Commands
          if (cmd === '!on') {
            const d = activeDB[cleanPhone];
            if (!d) { await sendPremiumResponse(badakSock, jid, '❌ Badak tidak aktif.', m); continue; }
            const sisa = Math.max(0, Math.ceil((d.expires - Date.now()) / 60000));
            await sendPremiumResponse(badakSock, jid,
              `✅ *BADAK SUDAH AKTIF*\n\n🪱 Status: Anti Blokir 99999999%\n🛡️ Anti Banned: ON\n🚫 Anti Kenon: ON\n🎯 Anti Spam: ACTIVE\n⏳ Sisa Aktif: *${sisa} Menit*`, m);
          }
          else if (cmd === '!off') {
            pendingOff.set(jid, true);
            await sendPremiumResponse(badakSock, jid, '⚠️ *KONFIRMASI MATIKAN BADAK*\n\nKetik *!yakin* untuk mematikan.', m);
          }
          else if (cmd === '!yakin' && pendingOff.has(jid)) {
            pendingOff.delete(jid);
            await sendPremiumResponse(badakSock, jid, '🛑 *BADAK DIMATIKAN*', m);
            setTimeout(async () => {
              try { await badakSock.logout(); await badakSock.end(); } catch {}
              activeSockets.delete(cleanPhone);
              delete activeDB[cleanPhone];
              wj(DB.active, activeDB);
              if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
            }, 3000);
          }
          else if (cmd === '!menu' || cmd === '!help' || cmd === '!start') {
            const menu =
`╔══════════════════════════════╗
║  🪱 *BADAK USER PANEL*        ║
║     Premium Edition v6.0     ║
╚══════════════════════════════╝

┌─ 🤖 *BADAK CONTROL* ──────────┐
│ ✳️ !on      Cek status        │
│ ✳️ !off     Matikan badak     │
│ ✳️ !yakin   Konfirmasi        │
└───────────────────────────────┘

┌─ 🎯 *MEDIA TOOLS* ────────────┐
│ ✳️ !vo      Bypass 1x lihat   │
└───────────────────────────────┘

┌─ ℹ️ *INFO* ───────────────────┐
│ ✳️ !info    S&K               │
│ ✳️ !owner   Kontak owner      │
└───────────────────────────────┘

> 🛡️ Anti Blokir • Anti Banned
> 🚫 Anti Kenon • Anti Spam Report
> 📢 ${CONFIG.channelUrl}`;
            await sendPremiumResponse(badakSock, jid, menu, m);
          }
          else if (cmd === '!vo') {
            await sendPremiumResponse(badakSock, jid, '📸 Kirim foto/video *1x lihat* ke chat ini, bot kirim ulang tanpa batas.', m);
          }
          else if (cmd === '!info') {
            await sendPremiumResponse(badakSock, jid,
              `[ ⚠️ S&K ]\n\n\`\`\`JANGAN HAPUS CHAT || JANGAN HAPUS KONTAK || JANGAN OTAK ATIK PENGATURAN\`\`\`\n\n> _Badak tidak ampuh = salah lu sendiri._\n\n📢 ${CONFIG.channelUrl}`, m);
          }
          else if (cmd === '!owner') {
            await sendPremiumResponse(badakSock, jid,
              `👑 *OWNER PANEL*\n\n🧑 ${CONFIG.ownerName}\n📱 ${CONFIG.ownerNumbers[0]}\n\n📢 ${CONFIG.channelUrl}`, m);
          }
          else if (text && !text.startsWith('!')) {
            if (contactsDB[sender].count <= 2) {
              await safeSend(badakSock, jid, { text: '💡 Ketik *!menu* untuk lihat fitur.' }, { quoted: m });
            }
          }
        } catch (e) { console.log('badak msg error:', e.message); }
      }
    });

    let qrSent = false, codeRequested = false;

    badakSock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      const buyerJid = cleanPhone + '@s.whatsapp.net';

      if (qr && !state.creds.registered) {
        if (!qrSent) {
          qrSent = true;
          try {
            const qrBuf = await QRCode.toBuffer(qr, { type: 'png', width: 1024, margin: 2 });
            await mainSock.sendMessage(buyerJid, {
              image: qrBuf,
              caption: `📱 *SCAN QR CODE*\nScan di WA nomor ${cleanPhone}\n\n> ${CONFIG.channelUrl}`
            });
          } catch {}
        }
        if (!codeRequested) {
          codeRequested = true;
          try {
            await delay(3000);
            const code = await badakSock.requestPairingCode(cleanPhone);
            const pretty = code.match(/.{1,4}/g)?.join('-') ?? code;
            await mainSock.sendMessage(buyerJid, {
              text: `🔑 *KODE PAIRING*\n\nKode: *${pretty}*\n\nMasukkan ke menu "Tautkan dengan Nomor Telepon".\n\n> ${CONFIG.channelUrl}`
            });
            await notifyChannel(mainSock,
              `🆕 *BADAK AKTIF*\n\n📱 Nomor: ${cleanPhone}\n⏳ Durasi: ${Math.round(durationMs / 60000)} menit\n🕐 ${new Date().toLocaleString('id-ID')}\n\n> ${CONFIG.channelUrl}`);
            await sendPremiumResponse(mainSock, chatJid, `✅ Badak untuk ${cleanPhone} sukses dibuat.`);
          } catch (e) {
            await sendPremiumResponse(mainSock, chatJid, `❌ Gagal pairing: ${e.message}`);
          }
        }
      }

      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        activeSockets.delete(cleanPhone);
        delete activeDB[cleanPhone];
        wj(DB.active, activeDB);
        if (code === 401 || code === 428) {
          fs.rmSync(sessionDir, { recursive: true, force: true });
          await sendPremiumResponse(mainSock, chatJid, '❌ Gagal: WA menolak koneksi. Sesi dibersihkan.');
        } else if (code !== DisconnectReason.loggedOut) {
          setTimeout(() => spawnBadak(cleanPhone, durationMs, mainSock, chatJid), 12000);
        }
      }
    });

    setTimeout(async () => {
      if (activeSockets.has(cleanPhone)) {
        try { await badakSock.end(); } catch {}
        activeSockets.delete(cleanPhone);
        delete activeDB[cleanPhone];
        wj(DB.active, activeDB);
        await sendPremiumResponse(mainSock, chatJid, `⏰ Waktu sewa Badak ${cleanPhone} telah habis.`);
      }
    }, durationMs);
  } catch (err) {
    await sendPremiumResponse(mainSock, chatJid, `❌ Sistem Error: ${err.message}`);
  }
}

// ===== API SERVER =====
let globalSock = null;
const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(__dirname));

app.post('/api/register', async (req, res) => {
  const { phone, packageId } = req.body || {};
  const cleanPhone = normalizePhone(phone);
  const paket = CONFIG.paket[packageId];
  if (!cleanPhone || !paket) return res.json({ status: false, msg: 'Data tidak valid.' });
  if (activeSockets.has(cleanPhone)) return res.json({ status: false, msg: 'Nomor sudah aktif.' });

  try {
    const sessionDir = path.join(SESSIONS, cleanPhone);
    if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();

    const badakSock = makeWASocket({
      version, auth: state, logger: pino({ level: 'silent' }),
      printQRInTerminal: false, browser: Browsers.macOS('Chrome'),
      mobile: false, shouldReconnect: () => false
    });
    activeSockets.set(cleanPhone, badakSock);
    badakSock.ev.on('creds.update', saveCreds);

    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        try { badakSock.end(); } catch {}
        activeSockets.delete(cleanPhone);
        if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
        res.json({ status: false, msg: 'Timeout: WhatsApp tidak respon.' });
      }
    }, 45000);

    badakSock.ev.on('connection.update', async (update) => {
      const { qr } = update;
      if (qr && !state.creds.registered && !resolved) {
        resolved = true;
        clearTimeout(timeout);
        try {
          await delay(3000);
          const qrBase64 = await QRCode.toDataURL(qr, { width: 1024, margin: 2 });
          const code = await badakSock.requestPairingCode(cleanPhone);
          const pretty = code.match(/.{1,4}/g)?.join('-') ?? code;

          activeDB[cleanPhone] = { phone: cleanPhone, expires: Date.now() + paket.durMs, created: Date.now(), packageId };
          wj(DB.active, activeDB);

          if (globalSock) {
            await notifyChannel(globalSock,
              `🎉 *PENDAFTARAN BARU*\n\n📱 Nomor: ${cleanPhone}\n📦 Paket: ${paket.label}\n💰 Harga: Rp ${paket.harga}\n🕐 ${new Date().toLocaleString('id-ID')}\n\n> ${CONFIG.channelUrl}`);
          }
          res.json({ status: true, qr: qrBase64, code: pretty });
        } catch (err) {
          activeSockets.delete(cleanPhone);
          fs.rmSync(sessionDir, { recursive: true, force: true });
          res.json({ status: false, msg: 'WhatsApp Limit. Tunggu 15 menit / ganti nomor.' });
        }
      }
    });
  } catch (err) {
    res.json({ status: false, msg: err.message });
  }
});

app.get('/api/badak', (req, res) => res.json({ status: true, data: activeDB }));

app.get('/api/banned', (req, res) => res.json({ status: true, data: bannedDB, count: bannedDB.length }));

app.post('/api/badak/kill', async (req, res) => {
  const { phone } = req.body || {};
  const cleanPhone = normalizePhone(phone);
  if (activeSockets.has(cleanPhone)) {
    try { await activeSockets.get(cleanPhone).logout(); activeSockets.get(cleanPhone).end(); } catch {}
    activeSockets.delete(cleanPhone);
    delete activeDB[cleanPhone];
    wj(DB.active, activeDB);
    return res.json({ status: true, msg: 'Badak dihapus.' });
  }
  res.json({ status: false, msg: 'Tidak ditemukan.' });
});

app.listen(3000, '0.0.0.0', () => console.log('\n🌐 Web Daftar Badak: http://localhost:3000\n'));

// ===== MASTER BOT =====
async function getBotPhone() {
  if (fs.existsSync(PHONE_FILE)) {
    const saved = fs.readFileSync(PHONE_FILE, 'utf8').trim();
    if (/^\d{10,15}$/.test(saved)) return saved;
  }
  const rl = readline.createInterface({ input, output });
  let n = '';
  while (!/^\d{10,15}$/.test(n)) {
    const ans = await rl.question('Nomor bot utama (62xxx) > ');
    n = normalizePhone(ans);
  }
  rl.close();
  fs.writeFileSync(PHONE_FILE, n);
  return n;
}

const TEXTS = {
  menuPusat:
`[ 🌐 EBOYGCR BADAK 2026 🌐 ]

◢◤ *MENU PUSAT* ◥◣
✳️ !badak1 [62+] 30MENIT (2K)
✳️ !badak2 [62+] 5JAM (5K)
✳️ !badak3 [62+] 10JAM (8K)
✳️ !badak4 [62+] 15JAM (12K)
✳️ !badak5 [62+] 20JAM (20K)
✳️ !badak6 [62+] 24JAM (25K)

> 🛡️ Anti Blokir • Anti Banned • Anti Kenon
> 📢 ${CONFIG.channelUrl}`,

  menuHarga:
`[ 💎 EBOYGCR PREMIUM PRICELIST 💎 ]

╭─────────────────────╮
│ ⚡ 30 MENIT  ─  2K   │
│ ⚡ 5 JAM     ─  5K   │
│ ⚡ 10 JAM    ─  8K   │
│ ⚡ 15 JAM    ─  12K  │
│ ⚡ 20 JAM    ─  20K  │
│ 👑 24 JAM    ─  25K  │
╰─────────────────────╯

✨ Anti Blokir 99999999%
✨ Anti Banned • Anti Kenon
✨ Anti Spam Report

> 📢 ${CONFIG.channelUrl}`,

  info:
`[ ⚠️ S&K ]

\`\`\`JANGAN HAPUS CHAT || JANGAN HAPUS KONTAK || JANGAN OTAK ATIK PENGATURAN\`\`\`

> _KALO BADAKNYA TIDAK AMPUH SALAH LU KARENA LU OTAK ATIK!_

📢 ${CONFIG.channelUrl}`,

  owner:
`[ 👑 OWNER PANEL ]

🧑 Owner: ${CONFIG.ownerName}
📱 Nomor: ${CONFIG.ownerNumbers[0]}

*COMMANDS OWNER:*
✳️ !acc 62+
✳️ !listbadak
✳️ !lihatchatbuyer
✳️ !kickbadak 62+
✳️ !stats
✳️ !push [pesan]
✳️ !listbanned

📢 ${CONFIG.channelUrl}`
};

async function startMaster() {
  const botPhone = await getBotPhone();
  const { state, saveCreds } = await useMultiFileAuthState(AUTH);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version, auth: state, logger: pino({ level: 'silent' }),
    printQRInTerminal: false, browser: Browsers.macOS('Chrome'),
    mobile: false, markOnlineOnConnect: true
  });

  sock.ev.on('creds.update', saveCreds);
  let codeReq = false;

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr && !state.creds.registered && !codeReq) {
      codeReq = true;
      try {
        await delay(3000);
        const code = await sock.requestPairingCode(botPhone);
        console.log(`\n🔑 KODE PAIRING BOT UTAMA: ${code}\n`);
      } catch {}
    }
    if (connection === 'close') {
      if (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) {
        setTimeout(startMaster, 10000);
      }
    }
    if (connection === 'open') {
      console.log(`\n🪱 Master Bot ${CONFIG.ownerName} Online!\n`);
      globalSock = sock;
      try {
        await sock.updateProfilePicture(sock.user.id, { url: PROFILE_PIC_URL });
        await sock.updateProfileStatus('🪱 Eboy Badak Online 24/7 | Anti Banned');
      } catch {}
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const m of messages) {
      try {
        if (!m.message || m.key.fromMe) continue;
        const jid = m.key.remoteJid;
        if (!jid) continue;
        const sender = m.key.participant || jid;
        const text = getText(m).trim();
        const cmd = text.toLowerCase();

        // Owner only? Check
        const ownerNums = CONFIG.ownerNumbers.map(normalizePhone);
        const senderNum = normalizePhone(sender.split('@')[0]);
        const isOwner = ownerNums.includes(senderNum);

        // Track contact
        if (!contactsDB[sender]) contactsDB[sender] = { first: Date.now(), name: m.pushName || '', count: 0 };
        contactsDB[sender].last = Date.now();
        contactsDB[sender].count = (contactsDB[sender].count || 0) + 1;
        wj(DB.contacts, contactsDB);

        // Banned?
        if (bannedUsers.has(sender)) {
          try { await sock.updateBlockStatus(sender, 'block'); } catch {}
          autoCleanChat(sock, jid, { mute: true, delayMs: 200 });
          continue;
        }

        // Anti-report on master too
        if (!isOwner && await checkReportThreat(sock, m, text)) continue;

        // Spam guard
        if (!m.isGroup && !isOwner) {
          const cnt = trackSpam(sender);
          if (cnt === CONFIG.antiBan.spamThreshold) {
            await safeSend(sock, jid, {
              text: `⚠️ *SPAM DETECTED*\n\nBerhenti spam atau otomatis di-BLOCK + di-REPORT ke WhatsApp.\n\n> ${CONFIG.channelUrl}`
            }, { quoted: m }).catch(() => {});
            autoCleanChat(sock, jid, { mute: true });
          }
          if (cnt >= CONFIG.antiBan.spamHardThreshold) {
            await executeSpamKill(sock, jid, sender, `spam flood (master)`, 'high');
            bannedDB.push(sender);
            wj(DB.banned, bannedDB);
            continue;
          }
        }

        // View once bypass (master juga bisa)
        if (await handleViewOnce(sock, m)) continue;

        // ===== PUBLIC COMMANDS =====
        if (cmd === '!menu badak' || cmd === '!menu' || cmd === '!start')
          { await sendPremiumResponse(sock, jid, TEXTS.menuPusat, m); continue; }
        if (cmd === '!menu harga')
          { await sendPremiumResponse(sock, jid, TEXTS.menuHarga, m); continue; }
        if (cmd === '!info')
          { await sendPremiumResponse(sock, jid, TEXTS.info, m); continue; }
        if (cmd === '!owner')
          { await sendPremiumResponse(sock, jid, TEXTS.owner, m); continue; }

        if (/^!badak[1-6]/.test(cmd)) {
          const args = text.split(/\s+/);
          if (!args[1]) { await sendPremiumResponse(sock, jid, 'Format: !badak1 6281234567890', m); continue; }
          const target = normalizePhone(args[1]);
          const key = cmd.split(' ')[0].replace('!', '');
          const paket = CONFIG.paket[key];
          if (!paket) { await sendPremiumResponse(sock, jid, '❌ Paket tidak valid.', m); continue; }
          pendingDB[target] = key;
          wj(DB.pending, pendingDB);
          await sendPremiumResponse(sock, jid,
            `🛒 *PESANAN DIBUAT*\n\n📦 Paket: ${paket.label}\n💰 Harga: Rp ${paket.harga}\n📱 Nomor: ${target}\n\n⏳ Tunggu Owner konfirmasi.\n\n> ${CONFIG.channelUrl}`, m);
          continue;
        }

        // ===== OWNER COMMANDS =====
        if (!isOwner) continue;

        if (cmd.startsWith('!acc')) {
          const target = normalizePhone(text.split(/\s+/)[1] || '');
          if (pendingDB[target]) {
            const key = pendingDB[target];
            delete pendingDB[target];
            wj(DB.pending, pendingDB);
            await spawnBadak(target, CONFIG.paket[key].durMs, sock, jid);
          } else {
            await sendPremiumResponse(sock, jid, `❌ Nomor ${target} tidak ada di daftar tunggu.`, m);
          }
          continue;
        }

        if (cmd === '!listbadak') {
          const list = Object.keys(activeDB);
          if (!list.length) { await sendPremiumResponse(sock, jid, '📭 Belum ada Badak aktif.', m); continue; }
          let msg = '🤖 *LIST BADAK AKTIF:*\n\n';
          list.forEach((p, i) => {
            const sisa = Math.ceil((activeDB[p].expires - Date.now()) / 60000);
            msg += `${i + 1}. ${p} (Sisa: ${sisa} menit)\n`;
          });
          msg += `\n> ${CONFIG.channelUrl}`;
          await sendPremiumResponse(sock, jid, msg, m);
          continue;
        }

        if (cmd.startsWith('!kickbadak')) {
          const target = normalizePhone(text.split(/\s+/)[1] || '');
          if (activeSockets.has(target)) {
            try { await activeSockets.get(target).logout(); activeSockets.get(target).end(); } catch {}
            activeSockets.delete(target);
            delete activeDB[target];
            wj(DB.active, activeDB);
            await sendPremiumResponse(sock, jid, `🛑 Badak ${target} di-kick.`, m);
          } else {
            await sendPremiumResponse(sock, jid, `❌ ${target} tidak aktif.`, m);
          }
          continue;
        }

        if (cmd === '!lihatchatbuyer') {
          const list = Object.keys(logsDB);
          if (!list.length) { await sendPremiumResponse(sock, jid, '📭 Belum ada log.', m); continue; }
          let msg = '📨 *LOG CHAT BUYER*\n\n';
          for (const phone of list.slice(0, 5)) {
            msg += `📱 *${phone}* (${logsDB[phone].length} pesan)\n`;
            logsDB[phone].slice(-3).forEach(l => {
              msg += `  • [${l.time}] ${l.name || l.from}: ${(l.text || '').slice(0, 40)}\n`;
            });
            msg += '\n';
          }
          msg += `> ${CONFIG.channelUrl}`;
          await sendPremiumResponse(sock, jid, msg, m);
          continue;
        }

        if (cmd === '!stats') {
          const activeCount = Object.keys(activeDB).length;
          const pendingCount = Object.keys(pendingDB).length;
          const bannedCount = bannedDB.length;
          await sendPremiumResponse(sock, jid,
            `📊 *BOT STATISTICS*\n\n🪱 Badak Aktif: ${activeCount}\n⏳ Pending Order: ${pendingCount}\n🚫 Banned Users: ${bannedCount}\n👥 Total Kontak: ${Object.keys(contactsDB).length}\n\n> ${CONFIG.channelUrl}`, m);
          continue;
        }

        if (cmd.startsWith('!push ')) {
          const template = text.slice(6).trim();
          if (!template) { await sendPremiumResponse(sock, jid, 'Format: !push [pesan promosi]', m); continue; }
          const targets = Object.keys(contactsDB).map(c => c.includes('@') ? c : c + '@s.whatsapp.net');
          await sendPremiumResponse(sock, jid, `📤 Broadcast dimulai ke ${Math.min(targets.length, CONFIG.antiBan.maxPushPerRun)} kontak...`, m);
          const result = await safeBroadcast(sock, targets, template);
          await sendPremiumResponse(sock, jid,
            `✅ *BROADCAST SELESAI*\n\n✔️ Terkirim: ${result.sent}\n❌ Gagal: ${result.failed}\n\n> ${CONFIG.channelUrl}`, m);
          continue;
        }

        if (cmd === '!listbanned') {
          if (!bannedDB.length) { await sendPremiumResponse(sock, jid, '📭 Tidak ada user banned.', m); continue; }
          let msg = '🚫 *LIST BANNED USERS:*\n\n';
          bannedDB.slice(-20).forEach((b, i) => { msg += `${i + 1}. ${b.split('@')[0]}\n`; });
          msg += `\n> ${CONFIG.channelUrl}`;
          await sendPremiumResponse(sock, jid, msg, m);
          continue;
        }

        if (cmd === '!unban') {
          const target = normalizePhone(text.split(/\s+/)[1] || '');
          const targetJid = target + '@s.whatsapp.net';
          if (bannedUsers.has(targetJid)) {
            bannedUsers.delete(targetJid);
            bannedDB = bannedDB.filter(b => b !== targetJid);
            wj(DB.banned, bannedDB);
            try { await sock.updateBlockStatus(targetJid, 'unblock'); } catch {}
            await sendPremiumResponse(sock, jid, `✅ ${target} di-unban.`, m);
          } else {
            await sendPremiumResponse(sock, jid, `❌ ${target} tidak ada di list banned.`, m);
          }
          continue;
        }

        if (text && !text.startsWith('!')) {
          await sendPremiumResponse(sock, jid, TEXTS.menuPusat, m);
        }
      } catch (e) { console.log('master msg error:', e.message); }
    }
  });
}

process.on('uncaughtException', (e) => console.log('UNCAUGHT:', e.message));
process.on('unhandledRejection', (e) => console.log('UNHANDLED:', e?.message ?? e));

startMaster();
