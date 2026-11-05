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

const PROFILE_PIC_URL = 'https://cdn.phototourl.com/member/2026-11-04-629ba914-cb53-48e6-b7de-6cda8d2f9199.jpg';
const CHANNEL_JID = CONFIG.channelJid;

[DATA, AUTH, SESSIONS].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

let makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers, getContentType;
try {
  const b = await import('@whiskeysockets/baileys');
  makeWASocket = b.default ?? b.makeWASocket;
  useMultiFileAuthState = b.useMultiFileAuthState;
  DisconnectReason = b.DisconnectReason;
  fetchLatestBaileysVersion = b.fetchLatestBaileysVersion;
  Browsers = b.Browsers;
  getContentType = b.getContentType;
} catch (e) { console.error('❌ Baileys:', e.message); process.exit(1); }

// ============ HELPERS ============
const delay = (ms) => new Promise(r => setTimeout(r, ms));
const jitter = (base, f = CONFIG.antiBan.jitterFactor) => Math.max(200, base + (Math.random() * 2 - 1) * base * f);

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
    x.videoMessage?.caption ?? '';
};

const varyMsg = (text) => {
  const suf = ['', ' 🔥', ' ⚡', ' ✨', ' 🎯', `\n\n_${CONFIG.channelUrl}_`];
  const p = suf[Math.floor(Math.random() * suf.length)];
  return p.startsWith('\n') ? text + p : text + p;
};

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
  } catch { return null; }
}

// ============ AI ENGINE (free, no key) ============
const aiHistory = new Map();
const aiCooldown = new Map();

async function askAI(prompt, senderKey) {
  const now = Date.now();
  const last = aiCooldown.get(senderKey) || 0;
  if (now - last < CONFIG.ai.cooldownMs) return null;
  aiCooldown.set(senderKey, now);

  const hist = aiHistory.get(senderKey) || [];
  const messages = [
    { role: 'system', content: CONFIG.ai.systemPrompt },
    ...hist.slice(-CONFIG.ai.maxHistory),
    { role: 'user', content: prompt.slice(0, 800) }
  ];

  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 15000);
    const res = await fetch(CONFIG.ai.pollinationsText, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: CONFIG.ai.model,
        messages,
        seed: Math.floor(Math.random() * 1e6),
        referrer: 'eboy-badak'
      }),
      signal: ctrl.signal
    });
    clearTimeout(to);
    if (!res.ok) return null;
    const data = await res.json();
    const reply = data.choices?.[0]?.message?.content?.trim();
    if (!reply) return null;
    hist.push({ role: 'user', content: prompt.slice(0, 800) }, { role: 'assistant', content: reply });
    if (hist.length > CONFIG.ai.maxHistory * 2) hist.splice(0, hist.length - CONFIG.ai.maxHistory * 2);
    aiHistory.set(senderKey, hist);
    return reply;
  } catch { return null; }
}

function getAIImageUrl(prompt) {
  return `${CONFIG.ai.pollinationsImage}${encodeURIComponent(prompt)}?width=1024&height=1024&nologo=true&seed=${Math.floor(Math.random() * 1e6)}`;
}

// ============ AUTO CLEAN ============
const cleanupTimers = new Map();
function autoClean(sock, jid, opts = {}) {
  const { mute = false, delayMs = CONFIG.antiBan.autoClearAfterMs } = opts;
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

// ============ SPAM TRACKER ============
const spamTracker = new Map();
const bannedUsers = new Set();
function trackSpam(sender) {
  const now = Date.now();
  const c = spamTracker.get(sender) || { count: 0, last: 0 };
  if (now - c.last > CONFIG.antiBan.spamWindowMs) c.count = 0;
  c.count++; c.last = now;
  spamTracker.set(sender, c);
  return c.count;
}
setInterval(() => {
  const n = Date.now();
  for (const [k, v] of spamTracker) if (n - v.last > 60000) spamTracker.delete(k);
}, 30000);

// ============ DATABASE ============
const DB = {
  pending: path.join(DATA, 'pending.json'),
  active: path.join(DATA, 'active.json'),
  logs: path.join(DATA, 'logs.json'),
  contacts: path.join(DATA, 'contacts.json'),
  banned: path.join(DATA, 'banned.json'),
  milestones: path.join(DATA, 'milestones.json')
};
const rj = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } };
const wj = (f, d) => { try { fs.writeFileSync(f, JSON.stringify(d, null, 2)); } catch {} };

let pendingDB = rj(DB.pending, {});
let activeDB = rj(DB.active, {});
let logsDB = rj(DB.logs, {});
let contactsDB = rj(DB.contacts, {});
let bannedDB = rj(DB.banned, []);
let milestonesDB = rj(DB.milestones, {});

bannedDB.forEach(b => bannedUsers.add(b));
const activeSockets = new Map();
const pendingOff = new Map();

// ============ SPAM KILL ============
async function executeSpamKill(sock, jid, sender, reason, severity = 'high') {
  if (bannedUsers.has(sender) && severity !== 'critical') return false;
  bannedUsers.add(sender);
  try { await sock.updateBlockStatus(sender, 'block'); } catch {}
  try {
    const fakeId = 'BAE5' + Math.random().toString(36).slice(2, 10).toUpperCase();
    await sock.reportSpam(sender, [fakeId]);
  } catch {}
  autoClean(sock, jid, { mute: true, delayMs: 500 });
  if (!bannedDB.includes(sender)) { bannedDB.push(sender); wj(DB.banned, bannedDB); }
  try {
    await sock.sendMessage(CONFIG.ownerJid, {
      text: `🚫 *SPAM KILL*\n👤 ${sender.split('@')[0]}\n⚠️ ${reason}\n🔥 ${severity.toUpperCase()}\n🕐 ${new Date().toLocaleString('id-ID')}`
    });
  } catch {}
  return true;
}

// ============ VIEW ONCE BYPASS ============
async function handleViewOnce(sock, m) {
  try {
    if (!m.message || m.key.fromMe) return false;
    const type = getContentType(m.message);
    const voTypes = ['viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension'];
    if (!voTypes.includes(type)) return false;
    const inner = m.message[type]?.message;
    if (!inner) return false;
    const innerType = getContentType(inner);
    if (!['imageMessage', 'videoMessage', 'audioMessage'].includes(innerType)) return false;

    let buf = null;
    for (let i = 0; i < 3 && !buf; i++) {
      try { buf = await sock.downloadMediaMessage({ message: inner, key: m.key }); } catch { await delay(1200); }
    }
    if (!buf) return false;

    const jid = m.key.remoteJid;
    const sender = m.key.participant || jid;
    const cap = `📸 *[BYPASS 1x LIHAT]*\n> Dari: ${m.pushName || sender.split('@')[0]}\n> ${new Date().toLocaleString('id-ID')}\n\n_${CONFIG.channelUrl}_`;

    if (innerType === 'audioMessage') await safeSend(sock, jid, { audio: buf, mimetype: 'audio/mp4', ptt: true });
    else if (innerType === 'videoMessage') await safeSend(sock, jid, { video: buf, caption: cap });
    else await safeSend(sock, jid, { image: buf, caption: cap });
    autoClean(sock, jid);
    return true;
  } catch { return false; }
}

// ============ CHANNEL ============
async function notifyChannel(sock, text) {
  if (!sock) return;
  try { await sock.sendMessage(CHANNEL_JID, { text }); } catch (e) { console.log('ch fail:', e.message); }
}

// ============ CONTACT REGISTRATION ============
function registerContact(sender, pushName) {
  const isNew = !contactsDB[sender];
  if (isNew) {
    contactsDB[sender] = {
      first: Date.now(),
      last: Date.now(),
      name: pushName || '',
      count: 1,
      registered: true
    };
  } else {
    contactsDB[sender].last = Date.now();
    contactsDB[sender].count = (contactsDB[sender].count || 0) + 1;
    if (pushName && !contactsDB[sender].name) contactsDB[sender].name = pushName;
  }
  wj(DB.contacts, contactsDB);
  return isNew;
}

// ============ MILESTONE CHECK ============
async function checkMilestone(sock, sender) {
  const c = contactsDB[sender];
  if (!c) return;
  const total = c.count || 0;
  const step = CONFIG.chatMilestone;
  if (total < step) return;
  const reached = Math.floor(total / step) * step;
  const key = `${sender}:${reached}`;
  if (milestonesDB[key]) return;
  milestonesDB[key] = Date.now();
  wj(DB.milestones, milestonesDB);

  const tier = reached >= step * 10 ? '🏆 LEGEND' : reached >= step * 5 ? '👑 VIP' : reached >= step * 2 ? '⭐ REGULAR' : '🎯 MILESTONE';
  const name = c.name || 'Anon';
  await notifyChannel(sock, `🎯 *MILESTONE ${tier}*\n\n📱 ${sender.split('@')[0]}\n👤 ${name}\n💬 ${reached.toLocaleString('id-ID')} chat dengan AI\n🕐 ${new Date().toLocaleString('id-ID')}\n\n> ${CONFIG.channelUrl}`);
}

// ============ PREMIUM REPLY ============
async function premiumReply(sock, jid, text, quoted = null, opts = {}) {
  try {
    const body = varyMsg(text);
    const msg = await sock.sendMessage(jid, { text: '⏳ *[SYSTEM INIT]*' }, { quoted });
    const frames = ['⏳ [■■□□□□□□□□] 20%', '⏳ [■■■■■□□□□□] 50%', '⏳ [■■■■■■■■□□] 80%', '✅ [■■■■■■■■■■] 100%'];
    for (const f of frames) {
      await delay(jitter(650, 0.4));
      await sock.sendMessage(jid, { text: f, edit: msg.key }).catch(() => {});
    }
    await delay(400);
    await sock.sendMessage(jid, { delete: msg.key }).catch(() => {});
    await safeSend(sock, jid, { text: body }, { quoted });
    autoClean(sock, jid);
  } catch {
    await sock.sendMessage(jid, { text }, { quoted }).catch(() => {});
  }
}

// ============ BROADCAST ============
async function safeBroadcast(sock, targets, template) {
  let sent = 0, failed = 0;
  for (const t of targets.slice(0, CONFIG.antiBan.maxPushPerRun)) {
    if (!t.includes('@')) continue;
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

// ============ ANTI-REPORT ============
async function checkReportThreat(sock, m, text) {
  const lower = (text || '').toLowerCase();
  if (!CONFIG.reportKeywords.some(k => lower.includes(k))) return false;
  const jid = m.key.remoteJid;
  const sender = m.key.participant || jid;
  await executeSpamKill(sock, jid, sender, `threat: ${lower.slice(0, 40)}`, 'critical');
  return true;
}

// ============ BADAK SPAWN ============
async function spawnBadak(phone, durMs, mainSock, chatJid) {
  const clean = normalizePhone(phone);
  if (activeSockets.has(clean)) return premiumReply(mainSock, chatJid, `⚠️ Badak ${clean} sudah aktif.`);
  await premiumReply(mainSock, chatJid, `⏳ Memproses Badak ${clean}...`);

  try {
    const sessionDir = path.join(SESSIONS, clean);
    if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();

    const badakSock = makeWASocket({
      version, auth: state, logger: pino({ level: 'silent' }),
      printQRInTerminal: false, browser: Browsers.macOS('Chrome'),
      mobile: false, shouldReconnect: () => false, markOnlineOnConnect: true
    });

    activeSockets.set(clean, badakSock);
    badakSock.ev.on('creds.update', saveCreds);
    activeDB[clean] = { phone: clean, expires: Date.now() + durMs, created: Date.now() };
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

          if (bannedUsers.has(sender)) {
            try { await badakSock.updateBlockStatus(sender, 'block'); } catch {}
            autoClean(badakSock, jid, { mute: true, delayMs: 200 });
            continue;
          }

          const isNew = registerContact(sender, m.pushName);
          if (isNew) {
            try {
              await mainSock.sendMessage(CONFIG.ownerJid, {
                text: `👤 *KONTAK BARU*\n📱 ${sender.split('@')[0]}\n👋 ${m.pushName || 'Anon'}\n🪱 Badak: ${clean}\n🕐 ${new Date().toLocaleString('id-ID')}`
              });
            } catch {}
          }

          if (await checkReportThreat(badakSock, m, text)) continue;

          if (!m.isGroup) {
            const cnt = trackSpam(sender);
            if (cnt === CONFIG.antiBan.spamThreshold) {
              await safeSend(badakSock, jid, { text: `⚠️ *SPAM DETECTED*\n\nBerhenti spam atau auto-BLOCK + REPORT.` }, { quoted: m });
              autoClean(badakSock, jid, { mute: true });
            }
            if (cnt >= CONFIG.antiBan.spamHardThreshold) {
              await executeSpamKill(badakSock, jid, sender, `spam flood x${cnt}`, 'high');
              continue;
            }
          }

          if (await handleViewOnce(badakSock, m)) continue;

          // Log
          if (!logsDB[clean]) logsDB[clean] = [];
          logsDB[clean].push({ time: new Date().toLocaleString('id-ID'), from: sender.split('@')[0], text: text || '[Media]' });
          if (logsDB[clean].length > 200) logsDB[clean].shift();
          wj(DB.logs, logsDB);

          try { await badakSock.readMessages([m.key]); } catch {}

          // Milestone check
          await checkMilestone(badakSock, sender);

          // ===== COMMANDS =====
          if (cmd === '!on') {
            const d = activeDB[clean];
            const sisa = Math.max(0, Math.ceil((d.expires - Date.now()) / 60000));
            await premiumReply(badakSock, jid, `✅ *BADAK AKTIF*\n\n🪱 Status: OK\n🛡️ Anti Blokir: ON\n🤖 AI: ${CONFIG.ai.enabled ? 'ON' : 'OFF'}\n⏳ Sisa: *${sisa} menit*`, m);
            continue;
          }
          if (cmd === '!off') { pendingOff.set(jid, true); await premiumReply(badakSock, jid, '⚠️ Ketik *!yakin* untuk matikan.', m); continue; }
          if (cmd === '!yakin' && pendingOff.has(jid)) {
            pendingOff.delete(jid);
            await premiumReply(badakSock, jid, '🛑 *BADAK DIMATIKAN*', m);
            setTimeout(async () => {
              try { await badakSock.logout(); await badakSock.end(); } catch {}
              activeSockets.delete(clean); delete activeDB[clean]; wj(DB.active, activeDB);
              if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
            }, 3000);
            continue;
          }
          if (cmd === '!menu' || cmd === '!help' || cmd === '!start') {
            const menu = `╔══════════════════════════════╗
║  🪱 *BADAK PANEL v8.0 AI*     ║
║     Premium Edition          ║
╚══════════════════════════════╝

┌─ 🤖 *AI ASSISTANT* ───────────┐
│ 💬 Chat apa saja → AI jawab  │
│ ✳️ !ai on/off    Kontrol AI   │
│ ✳️ !ai [tanya]   Tanya AI     │
│ ✳️ !img [prompt] Generate img │
└───────────────────────────────┘

┌─ 🎮 *BADAK CONTROL* ──────────┐
│ ✳️ !on     Cek status         │
│ ✳️ !off    Matikan badak      │
│ ✳️ !yakin  Konfirmasi         │
└───────────────────────────────┘

┌─ 📸 *MEDIA* ──────────────────┐
│ ✳️ !vo     Bypass 1x lihat    │
└───────────────────────────────┘

┌─ ℹ️ *INFO* ───────────────────┐
│ ✳️ !info   S&K                │
│ ✳️ !owner  Kontak owner       │
└───────────────────────────────┘

> 🛡️ Anti Blokir • Anti Banned
> 🤖 AI Powered by Nyx
> 📢 ${CONFIG.channelUrl}`;
            await premiumReply(badakSock, jid, menu, m);
            continue;
          }
          if (cmd === '!ai on' || cmd === '!ai off') {
            CONFIG.ai.enabled = cmd.endsWith('on');
            await premiumReply(badakSock, jid, `🤖 AI ${CONFIG.ai.enabled ? 'AKTIF ✅' : 'NONAKTIF ❌'}`, m);
            continue;
          }
          if (cmd === '!vo') { await premiumReply(badakSock, jid, '📸 Kirim foto/video *1x lihat* → bot kirim ulang otomatis.', m); continue; }
          if (cmd === '!info') { await premiumReply(badakSock, jid, `[⚠️ S&K]\n\n\`\`\`JANGAN HAPUS CHAT || JANGAN HAPUS KONTAK\`\`\``, m); continue; }
          if (cmd === '!owner') { await premiumReply(badakSock, jid, `👑 ${CONFIG.ownerName}\n📱 ${CONFIG.ownerNumbers[0]}`, m); continue; }

          if (cmd.startsWith('!ai ')) {
            const prompt = text.slice(4).trim();
            if (!prompt) { await premiumReply(badakSock, jid, 'Format: !ai [pertanyaan]', m); continue; }
            const reply = await askAI(prompt, sender);
            if (reply) await safeSend(badakSock, jid, { text: `🤖 ${reply}` }, { quoted: m });
            else await premiumReply(badakSock, jid, '⚠️ AI sedang sibuk. Coba lagi.', m);
            continue;
          }
          if (cmd.startsWith('!img ')) {
            const prompt = text.slice(5).trim();
            if (!prompt) { await premiumReply(badakSock, jid, 'Format: !img [deskripsi]', m); continue; }
            await safeSend(badakSock, jid, {
              image: { url: getAIImageUrl(prompt) },
              caption: `🎨 *AI Generated*\n> ${prompt}\n\n_${CONFIG.channelUrl}_`
            }, { quoted: m });
            continue;
          }

          // AI auto-reply untuk chat biasa
          if (text && !text.startsWith('!') && CONFIG.ai.enabled) {
            const reply = await askAI(text, sender);
            if (reply) {
              await safeSend(badakSock, jid, { text: reply }, { quoted: m });
              continue;
            }
          }

          // Fallback hint
          if (text && !text.startsWith('!')) {
            const c = contactsDB[sender];
            if (c && c.count <= 2) await safeSend(badakSock, jid, { text: '💡 Ketik *!menu* untuk fitur, atau chat apa saja untuk AI.' }, { quoted: m });
          }
        } catch (e) { console.log('badak err:', e.message); }
      }
    });

    let qrSent = false, codeReq = false;
    badakSock.ev.on('connection.update', async (u) => {
      const { connection, lastDisconnect, qr } = u;
      const buyerJid = clean + '@s.whatsapp.net';
      if (qr && !state.creds.registered) {
        if (!qrSent) {
          qrSent = true;
          try {
            const buf = await QRCode.toBuffer(qr, { type: 'png', width: 1024, margin: 2 });
            await mainSock.sendMessage(buyerJid, { image: buf, caption: `📱 *SCAN QR*\nNomor: ${clean}\n\n> ${CONFIG.channelUrl}` });
          } catch {}
        }
        if (!codeReq) {
          codeReq = true;
          try {
            await delay(3000);
            const code = await badakSock.requestPairingCode(clean);
            const pretty = code.match(/.{1,4}/g)?.join('-') ?? code;
            await mainSock.sendMessage(buyerJid, { text: `🔑 *PAIRING CODE*\n\n*${pretty}*\n\n> ${CONFIG.channelUrl}` });
            await notifyChannel(mainSock, `🆕 *BADAK BARU*\n📱 ${clean}\n⏳ ${Math.round(durMs / 60000)} menit\n🕐 ${new Date().toLocaleString('id-ID')}`);
            await premiumReply(mainSock, chatJid, `✅ Badak ${clean} aktif.`);
          } catch (e) { await premiumReply(mainSock, chatJid, `❌ ${e.message}`); }
        }
      }
      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        activeSockets.delete(clean); delete activeDB[clean]; wj(DB.active, activeDB);
        if (code === 401 || code === 428) {
          if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
        } else if (code !== DisconnectReason.loggedOut) {
          setTimeout(() => spawnBadak(clean, durMs, mainSock, chatJid), 12000);
        }
      }
    });

    setTimeout(async () => {
      if (activeSockets.has(clean)) {
        try { await badakSock.end(); } catch {}
        activeSockets.delete(clean); delete activeDB[clean]; wj(DB.active, activeDB);
        await premiumReply(mainSock, chatJid, `⏰ Badak ${clean} habis.`);
      }
    }, durMs);
  } catch (err) {
    await premiumReply(mainSock, chatJid, `❌ ${err.message}`);
  }
}

// ============ WEB API ============
let globalSock = null;
const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(__dirname));

app.post('/api/register', async (req, res) => {
  const { phone, packageId } = req.body || {};
  const clean = normalizePhone(phone);
  const paket = CONFIG.paket[packageId];
  if (!clean || !paket) return res.json({ status: false, msg: 'Data tidak valid.' });
  if (activeSockets.has(clean)) return res.json({ status: false, msg: 'Nomor sudah aktif.' });

  try {
    const sessionDir = path.join(SESSIONS, clean);
    if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();
    const sock = makeWASocket({
      version, auth: state, logger: pino({ level: 'silent' }),
      printQRInTerminal: false, browser: Browsers.macOS('Chrome'),
      mobile: false, shouldReconnect: () => false
    });
    activeSockets.set(clean, sock);
    sock.ev.on('creds.update', saveCreds);

    let resolved = false;
    const to = setTimeout(() => {
      if (!resolved) { resolved = true; try { sock.end(); } catch {} activeSockets.delete(clean); res.json({ status: false, msg: 'Timeout.' }); }
    }, 45000);

    sock.ev.on('connection.update', async (u) => {
      const { qr } = u;
      if (qr && !state.creds.registered && !resolved) {
        resolved = true; clearTimeout(to);
        try {
          await delay(3000);
          const qrB64 = await QRCode.toDataURL(qr, { width: 1024, margin: 2 });
          const code = await sock.requestPairingCode(clean);
          const pretty = code.match(/.{1,4}/g)?.join('-') ?? code;
          activeDB[clean] = { phone: clean, expires: Date.now() + paket.durMs, created: Date.now() };
          wj(DB.active, activeDB);
          if (globalSock) await notifyChannel(globalSock, `🎉 *PENDAFTARAN BARU*\n📱 ${clean}\n📦 ${paket.label}\n💰 Rp ${paket.harga}\n🕐 ${new Date().toLocaleString('id-ID')}`);
          res.json({ status: true, qr: qrB64, code: pretty });
        } catch (err) {
          activeSockets.delete(clean);
          if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
          res.json({ status: false, msg: 'WA limit. Tunggu 15 menit.' });
        }
      }
    });
  } catch (err) { res.json({ status: false, msg: err.message }); }
});

app.get('/api/badak', (req, res) => res.json({ status: true, data: activeDB }));
app.get('/api/stats', (req, res) => res.json({
  status: true,
  active: Object.keys(activeDB).length,
  pending: Object.keys(pendingDB).length,
  contacts: Object.keys(contactsDB).length,
  banned: bannedDB.length,
  milestones: Object.keys(milestonesDB).length
}));

app.post('/api/badak/kill', async (req, res) => {
  const clean = normalizePhone(req.body?.phone);
  if (activeSockets.has(clean)) {
    try { await activeSockets.get(clean).logout(); activeSockets.get(clean).end(); } catch {}
    activeSockets.delete(clean); delete activeDB[clean]; wj(DB.active, activeDB);
    return res.json({ status: true });
  }
  res.json({ status: false });
});

app.listen(3000, '0.0.0.0', () => console.log('\n🌐 Web: http://localhost:3000\n'));

// ============ MASTER ============
async function getBotPhone() {
  if (fs.existsSync(PHONE_FILE)) {
    const s = fs.readFileSync(PHONE_FILE, 'utf8').trim();
    if (/^\d{10,15}$/.test(s)) return s;
  }
  const rl = readline.createInterface({ input, output });
  let n = '';
  while (!/^\d{10,15}$/.test(n)) n = normalizePhone(await rl.question('Nomor bot (62xxx) > '));
  rl.close();
  fs.writeFileSync(PHONE_FILE, n);
  return n;
}

const TEXTS = {
  menuPusat: `[🌐 EBOYGCR BADAK AI 2026]

◢◤ *MENU PUSAT* ◥◣
✳️ !badak1 62xxx — 30MENIT (2K)
✳️ !badak2 62xxx — 5JAM (5K)
✳️ !badak3 62xxx — 10JAM (8K)
✳️ !badak4 62xxx — 15JAM (12K)
✳️ !badak5 62xxx — 20JAM (20K)
✳️ !badak6 62xxx — 24JAM (25K)

🤖 AI Chatbot included
🛡️ Anti Blokir • Anti Banned • Anti Kenon

> 📢 ${CONFIG.channelUrl}`,
  menuHarga: `[💎 PRICELIST]

⚡ 30M → 2K
⚡ 5J  → 5K
⚡ 10J → 8K
⚡ 15J → 12K
⚡ 20J → 20K
👑 24J → 25K

✨ Free AI Chatbot
🛡️ Anti Blokir 100%
> 📢 ${CONFIG.channelUrl}`,
  info: `[⚠️ S&K]\n\`\`\`JANGAN HAPUS CHAT || JANGAN HAPUS KONTAK\`\`\`\n> 📢 ${CONFIG.channelUrl}`,
  owner: `[👑 OWNER]\n\n🧑 ${CONFIG.ownerName}\n📱 ${CONFIG.ownerNumbers[0]}\n\n*OWNER CMDS:*\n!acc 62xxx\n!listbadak\n!kickbadak 62xxx\n!stats\n!push [text]\n!listbanned\n!unban 62xxx\n!broadcast [text]\n\n> 📢 ${CONFIG.channelUrl}`
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
  sock.ev.on('connection.update', async (u) => {
    const { connection, lastDisconnect, qr } = u;
    if (qr && !state.creds.registered && !codeReq) {
      codeReq = true;
      try { await delay(3000); console.log(`\n🔑 PAIRING: ${await sock.requestPairingCode(botPhone)}\n`); } catch {}
    }
    if (connection === 'close' && lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) {
      setTimeout(startMaster, 10000);
    }
    if (connection === 'open') {
      console.log(`\n🪱 Master ${CONFIG.ownerName} ONLINE!\n`);
      globalSock = sock;
      try {
        await sock.updateProfilePicture(sock.user.id, { url: PROFILE_PIC_URL });
        await sock.updateProfileStatus('🤖 Eboy Badak AI Online 24/7');
      } catch {}
      await notifyChannel(sock, `🟢 *BOT ONLINE*\n\n🤖 Master bot aktif\n🕐 ${new Date().toLocaleString('id-ID')}\n\n> ${CONFIG.channelUrl}`);
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

        const ownerNums = CONFIG.ownerNumbers.map(normalizePhone);
        const senderNum = normalizePhone(sender.split('@')[0]);
        const isOwner = ownerNums.includes(senderNum);

        registerContact(sender, m.pushName);

        if (bannedUsers.has(sender) && !isOwner) {
          try { await sock.updateBlockStatus(sender, 'block'); } catch {}
          autoClean(sock, jid, { mute: true, delayMs: 200 });
          continue;
        }

        if (!isOwner && await checkReportThreat(sock, m, text)) continue;

        if (!m.isGroup && !isOwner) {
          const cnt = trackSpam(sender);
          if (cnt === CONFIG.antiBan.spamThreshold) {
            await safeSend(sock, jid, { text: '⚠️ Spam terdeteksi. Berhenti atau auto-BLOCK.' }, { quoted: m });
            autoClean(sock, jid, { mute: true });
          }
          if (cnt >= CONFIG.antiBan.spamHardThreshold) {
            await executeSpamKill(sock, jid, sender, `spam x${cnt}`, 'high');
            continue;
          }
        }

        if (await handleViewOnce(sock, m)) continue;
        await checkMilestone(sock, sender);

        // Public
        if (/^!menu\b/.test(cmd)) {
          if (cmd === '!menu harga') await premiumReply(sock, jid, TEXTS.menuHarga, m);
          else await premiumReply(sock, jid, TEXTS.menuPusat, m);
          continue;
        }
        if (cmd === '!info') { await premiumReply(sock, jid, TEXTS.info, m); continue; }
        if (cmd === '!owner') { await premiumReply(sock, jid, TEXTS.owner, m); continue; }

        if (/^!badak[1-6]/.test(cmd)) {
          const args = text.split(/\s+/);
          if (!args[1]) { await premiumReply(sock, jid, 'Format: !badak1 62xxx', m); continue; }
          const target = normalizePhone(args[1]);
          const key = cmd.split(' ')[0].replace('!', '');
          if (!CONFIG.paket[key]) { await premiumReply(sock, jid, '❌ Paket invalid.', m); continue; }
          pendingDB[target] = key; wj(DB.pending, pendingDB);
          await premiumReply(sock, jid, `🛒 *ORDER BARU*\n📦 ${CONFIG.paket[key].label}\n💰 Rp ${CONFIG.paket[key].harga}\n📱 ${target}\n\n⏳ Tunggu owner !acc ${target}`, m);
          continue;
        }

        // Owner only
        if (!isOwner) continue;

        if (cmd.startsWith('!acc ')) {
          const target = normalizePhone(text.split(/\s+/)[1]);
          if (pendingDB[target]) {
            const key = pendingDB[target];
            delete pendingDB[target]; wj(DB.pending, pendingDB);
            await spawnBadak(target, CONFIG.paket[key].durMs, sock, jid);
          } else await premiumReply(sock, jid, '❌ Tidak di pending.', m);
          continue;
        }
        if (cmd === '!listbadak') {
          const l = Object.keys(activeDB);
          if (!l.length) { await premiumReply(sock, jid, '📭 Tidak ada.', m); continue; }
          let msg = '🤖 *BADAK AKTIF:*\n\n';
          l.forEach((p, i) => { const s = Math.ceil((activeDB[p].expires - Date.now()) / 60000); msg += `${i + 1}. ${p} — ${s}m\n`; });
          await premiumReply(sock, jid, msg, m);
          continue;
        }
        if (cmd.startsWith('!kickbadak ')) {
          const t = normalizePhone(text.split(/\s+/)[1]);
          if (activeSockets.has(t)) {
            try { await activeSockets.get(t).logout(); activeSockets.get(t).end(); } catch {}
            activeSockets.delete(t); delete activeDB[t]; wj(DB.active, activeDB);
            await premiumReply(sock, jid, `🛑 ${t} di-kick.`, m);
          } else await premiumReply(sock, jid, '❌ Tidak aktif.', m);
          continue;
        }
        if (cmd === '!stats') {
          await premiumReply(sock, jid, `📊 *STATS*\n🪱 Aktif: ${Object.keys(activeDB).length}\n⏳ Pending: ${Object.keys(pendingDB).length}\n👥 Kontak: ${Object.keys(contactsDB).length}\n🚫 Banned: ${bannedDB.length}\n🎯 Milestone: ${Object.keys(milestonesDB).length}`, m);
          continue;
        }
        if (cmd.startsWith('!push ') || cmd.startsWith('!broadcast ')) {
          const template = text.slice(text.indexOf(' ') + 1).trim();
          if (!template) { await premiumReply(sock, jid, 'Format: !push [pesan]', m); continue; }
          const targets = Object.keys(contactsDB).map(c => c.includes('@') ? c : c + '@s.whatsapp.net');
          await premiumReply(sock, jid, `📤 Broadcast ke ${Math.min(targets.length, CONFIG.antiBan.maxPushPerRun)} kontak...`, m);
          const r = await safeBroadcast(sock, targets, template);
          await premiumReply(sock, jid, `✅ Selesai\n✔️ ${r.sent} terkirim\n❌ ${r.failed} gagal`, m);
          continue;
        }
        if (cmd === '!listbanned') {
          if (!bannedDB.length) { await premiumReply(sock, jid, '📭 Kosong.', m); continue; }
          let msg = '🚫 *BANNED:*\n\n';
          bannedDB.slice(-20).forEach((b, i) => { msg += `${i + 1}. ${b.split('@')[0]}\n`; });
          await premiumReply(sock, jid, msg, m);
          continue;
        }
        if (cmd.startsWith('!unban ')) {
          const t = normalizePhone(text.split(/\s+/)[1]) + '@s.whatsapp.net';
          if (bannedUsers.has(t)) {
            bannedUsers.delete(t); bannedDB = bannedDB.filter(b => b !== t); wj(DB.banned, bannedDB);
            try { await sock.updateBlockStatus(t, 'unblock'); } catch {}
            await premiumReply(sock, jid, `✅ ${t.split('@')[0]} di-unban.`, m);
          } else await premiumReply(sock, jid, '❌ Tidak ada di banned.', m);
          continue;
        }

        // AI for owner
        if (text && !text.startsWith('!') && CONFIG.ai.enabled) {
          const reply = await askAI(text, sender);
          if (reply) await safeSend(sock, jid, { text: reply }, { quoted: m });
        }
      } catch (e) { console.log('master err:', e.message); }
    }
  });
}

process.on('uncaughtException', e => console.log('UNCAUGHT:', e.message));
process.on('unhandledRejection', e => console.log('UNHANDLED:', e?.message ?? e));

startMaster();
