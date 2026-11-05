import fs from 'fs';
import path from 'path';
import readline from 'readline/promises';
import { stdin as input, stdout as output } from 'process';
import { fileURLToPath } from 'url';
import pino from 'pino';
import QRCode from 'qrcode';
import express from 'express';
import cors from 'cors';
import { wrapSocket } from 'baileys-antiban';
import { CONFIG } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, 'data');
const AUTH = path.join(__dirname, 'auth');
const SESSIONS = path.join(__dirname, 'sessions');
const PHONE_FILE = path.join(__dirname, 'phone.txt');

// ================= KONFIGURASI =================
const VIDEO_MP4 = 'https://www.w3schools.com/html/mov_bbb.mp4'; 
const AUDIO_VN = 'https://cdn.pixabay.com/download/audio/2022/03/15/audio_c8c8a73467.mp3';
const PROFILE_PIC_URL = 'https://cdn.phototourl.com/member/2026-11-04-629ba914-cb53-48e6-b7de-6cda8d2f9199.jpg'; 

[DATA, AUTH, SESSIONS].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

let makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers, getContentType;
try {
  const baileys = await import('@whiskeysockets/baileys');
  makeWASocket = baileys.default ?? baileys.makeWASocket;
  useMultiFileAuthState = baileys.useMultiFileAuthState;
  DisconnectReason = baileys.DisconnectReason;
  fetchLatestBaileysVersion = baileys.fetchLatestBaileysVersion;
  Browsers = baileys.Browsers;
  getContentType = baileys.getContentType;
} catch (e) {
  console.error('\n❌ Gagal memuat Baileys:', e.message);
  process.exit(1);
}

const delay = (ms) => new Promise(r => setTimeout(r, ms));

const normalizePhone = (raw) => {
  let n = String(raw).replace(/[^0-9]/g, '');
  if (n.startsWith('0')) n = '62' + n.slice(1);
  if (!n.startsWith('62')) n = '62' + n;
  return n;
};

const getText = (m) => {
  const x = m.message ?? {};
  return x.conversation ?? x.extendedTextMessage?.text ?? x.imageMessage?.caption ?? '';
};

const isOwner = (m) => {
  if (m.key.fromMe) return true;
  const ids = [m.key.remoteJid, m.key.participant, m.key.participantAlt, m.key.remoteJidAlt, m.key.senderPn, m.key.participantPn].filter(Boolean);
  return ids.some(id => {
    let num = id.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
    if (num.startsWith('0')) num = '62' + num.slice(1);
    return CONFIG.ownerNumbers.includes(num);
  });
};

// ================= FUNGSI HAPUS CHAT UNTUK BOT =================
async function clearBotChat(sock, jid) {
  try {
    await delay(2500); // Beri waktu 2.5 detik agar pesan sempat terkirim
    await sock.chatModify({ clear: jid }, jid);
  } catch (e) {}
}

// ================= SISTEM ANTI SPAM (MUTE ONLY) =================
const spamTracker = new Map();

async function checkAndPunishSpam(sock, jid, sender) {
  const now = Date.now();
  if (!spamTracker.has(sender)) {
    spamTracker.set(sender, { count: 1, last: now });
    return false;
  }
  
  const data = spamTracker.get(sender);
  if (now - data.last > 10000) { 
    spamTracker.set(sender, { count: 1, last: now });
    return false;
  }

  data.count++;
  data.last = now;

  if (data.count >= 3) {
    spamTracker.delete(sender);
    try {
      await sock.chatModify({ mute: 24 * 60 * 60 * 1000 }, jid); // Mute
      await sock.chatModify({ clear: jid }, jid); // Hapus chat
    } catch (e) {}
    return true; 
  }
  return false;
}

// ================= BYPASS VIEW ONCE =================
async function handleViewOnce(sock, m) {
  try {
    const type = getContentType(m.message);
    if (type === 'viewOnceMessageV2' || type === 'viewOnceMessage') {
      const innerMsg = m.message[type].message;
      const innerType = getContentType(innerMsg);
      if (innerType === 'imageMessage' || innerType === 'videoMessage') {
        const buffer = await sock.downloadMediaMessage({ message: innerMsg, key: m.key });
        await delay(2000);
        if (innerType === 'imageMessage') {
          await sock.sendMessage(m.key.remoteJid, { image: buffer, caption: `📸 *[Bypass Sekali Lihat]*` });
        } else if (innerType === 'videoMessage') {
          await sock.sendMessage(m.key.remoteJid, { video: buffer, caption: `🎥 *[Bypass Sekali Lihat]*` });
        }
        // Hapus chat setelah kirim bypass
        clearBotChat(sock, m.key.remoteJid);
        return true; 
      }
    }
  } catch (err) {}
  return false;
}

// ================= UNIVERSAL PREMIUM SENDER =================
async function sendPremiumResponse(sock, jid, text, quotedMsg = null, isOwnerMsg = false) {
  try {
    const msg = await sock.sendMessage(jid, { text: `⏳ *[SYSTEM INITIALIZING]*\n> Menyiapkan data...` }, { quoted: quotedMsg });
    const frames = [
      `⏳ *[SYSTEM INITIALIZING]*\n[■■□□□□□□□□] 20%\n> Memuat...`,
      `⏳ *[SYSTEM INITIALIZING]*\n[■■■■■□□□□□] 50%\n> Memproses...`,
      `⏳ *[SYSTEM INITIALIZING]*\n[■■■■■■■■□□] 80%\n> Finalisasi...`,
      `✅ *[SYSTEM READY]*\n[■■■■■■■■■■] 100%\n> Mengirim...`
    ];
    for (let i = 0; i < frames.length; i++) {
      await delay(800 + Math.random() * 400);
      await sock.sendMessage(jid, { text: frames[i], edit: msg.key }).catch(()=>{});
    }
    await delay(500);
    await sock.sendMessage(jid, { delete: msg.key }).catch(()=>{});

    await sock.sendMessage(jid, { video: { url: VIDEO_MP4 }, caption: text, gifPlayback: true }, { quoted: quotedMsg }).catch(async () => {
      await sock.sendMessage(jid, { text: text }, { quoted: quotedMsg });
    });

    await delay(1000);
    await sock.sendMessage(jid, { audio: { url: AUDIO_VN }, mimetype: 'audio/mp4', ptt: true }, { quoted: quotedMsg }).catch(()=>{});

    // HAPUS CHAT BOT JIKA BUKAN OWNER
    if (!isOwnerMsg) {
      clearBotChat(sock, jid); 
    }
  } catch (e) {
    await sock.sendMessage(jid, { text: text }, { quoted: quotedMsg });
  }
}

// ================= DATABASE =================
const DB = {
  pending: path.join(DATA, 'pending.json'),
  active: path.join(DATA, 'active.json'),
  logs: path.join(DATA, 'logs.json')
};
const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } };
const writeJson = (f, d) => { try { fs.writeFileSync(f, JSON.stringify(d, null, 2)); } catch {} };

let pendingDB = readJson(DB.pending, {});
let activeDB = readJson(DB.active, {});
let logsDB = readJson(DB.logs, {});

const activeSockets = new Map();
const pendingOff = new Map();

// ================= CHILD BOT =================
async function spawnBadak(phone, durationMs, mainSock, chatJid) {
  const cleanPhone = normalizePhone(phone);
  if (activeSockets.has(cleanPhone)) return sendPremiumResponse(mainSock, chatJid, `⚠️ Badak untuk ${cleanPhone} sudah aktif.`, null, true);
  
  await sendPremiumResponse(mainSock, chatJid, `⏳ Memproses pembuatan Badak untuk ${cleanPhone}...`, null, true);

  try {
    const sessionDir = path.join(SESSIONS, cleanPhone);
    if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();

    const rawSock = makeWASocket({
      version, auth: state, logger: pino({ level: 'silent' }),
      printQRInTerminal: false, browser: Browsers.macOS('Desktop'), mobile: false, shouldReconnect: () => false
    });

    const badakSock = wrapSocket(rawSock, {
      groupOpGuard: { limits: { add: { max: 3, windowMs: 600_000 } } },
      legitimacySignals: { typoProbability: 0.02, presenceUpdateChance: 0.4 }
    });

    activeSockets.set(cleanPhone, badakSock);
    badakSock.ev.on('creds.update', saveCreds);
    
    activeDB[cleanPhone] = { phone: cleanPhone, expires: Date.now() + durationMs };
    writeJson(DB.active, activeDB);

    badakSock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const m of messages) {
        if (!m.message || m.key.fromMe) continue;
        const jid = m.key.remoteJid;
        const sender = m.key.participant || jid;
        const text = getText(m).trim();
        const cmd = text.toLowerCase();

        if (!m.isGroup) {
           const isSpamming = await checkAndPunishSpam(badakSock, jid, sender);
           if (isSpamming) continue; 
        }

        const isVO = await handleViewOnce(badakSock, m);
        if (isVO) continue;

        try { await badakSock.readMessages([m.key]); } catch {}
        
        if (!logsDB[cleanPhone]) logsDB[cleanPhone] = [];
        logsDB[cleanPhone].push({ time: new Date().toLocaleString('id-ID'), from: sender.split('@')[0], text: text || '[Media]' });
        if (logsDB[cleanPhone].length > 50) logsDB[cleanPhone].shift();
        writeJson(DB.logs, logsDB);

        if (cmd === '!on') {
          const data = activeDB[cleanPhone];
          if (!data) return sendPremiumResponse(badakSock, jid, `❌ Badak tidak aktif.`, m, true);
          const sisaMenit = Math.max(0, Math.ceil((data.expires - Date.now()) / 60000));
          await sendPremiumResponse(badakSock, jid, `✅ *BADAK SUDAH AKTIF*\n\n🪱 Status: Anti Blokir, Anti Kenon, Anti Banned 100%\n⏳ Sisa Aktif: *${sisaMenit} Menit*`, m, true);
        } 
        else if (cmd === '!off') {
          pendingOff.set(jid, true);
          await sendPremiumResponse(badakSock, jid, `⚠️ *KONFIRMASI MATIKAN BADAK*\n\nKetik *!yakin* untuk mematikan.`, m, true);
        }
        else if (cmd === '!yakin' && pendingOff.has(jid)) {
          pendingOff.delete(jid);
          await sendPremiumResponse(badakSock, jid, `🛑 *BADAK DIMATIKAN*`, m, true);
          setTimeout(async () => {
            try { await badakSock.logout(); await badakSock.end(); } catch (e) {}
            activeSockets.delete(cleanPhone);
            delete activeDB[cleanPhone];
            writeJson(DB.active, activeDB);
            fs.rmSync(sessionDir, { recursive: true, force: true });
          }, 3000);
        }
        else if (text && !text.startsWith('!')) {
          await sendPremiumResponse(badakSock, jid, `[ 🌐 BADAK PREMIUM 2026 🌐 ]\n\nFitur:\n✳️ !on (Cek Status)\n✳️ !off (Matikan)`, m, false); 
        }
      }
    });

    let codeRequested = false;
    let qrSent = false;

    badakSock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr && !state.creds.registered) {
        const buyerJid = cleanPhone + '@s.whatsapp.net';
        if (!qrSent) {
          qrSent = true;
          try {
            const qrBuffer = await QRCode.toBuffer(qr, { type: 'png', width: 1024, margin: 2 });
            await mainSock.sendMessage(buyerJid, { image: qrBuffer, caption: `📱 *SCAN QR CODE*\nScan QR ini di WA nomor ${cleanPhone}.` });
          } catch (e) {}
        }
        if (!codeRequested) {
          codeRequested = true;
          try {
            await delay(3000); 
            const code = await badakSock.requestPairingCode(cleanPhone);
            const pretty = code.match(/.{1,4}/g)?.join('-') ?? code;
            await mainSock.sendMessage(buyerJid, { text: `🔑 *KODE PAIRING*\n\nKode: *${pretty}*\n\nMasukkan kode ke menu "Tautkan dengan Nomor Telepon".` });
            await sendPremiumResponse(mainSock, chatJid, `✅ Badak untuk ${cleanPhone} sukses dibuat.`, null, true);
          } catch (e) {
            await sendPremiumResponse(mainSock, chatJid, `❌ Gagal minta kode pairing: ${e.message}`, null, true);
          }
        }
      }

      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        activeSockets.delete(cleanPhone);
        delete activeDB[cleanPhone];
        writeJson(DB.active, activeDB);
        
        if (code === 401 || code === 428) {
           fs.rmSync(sessionDir, { recursive: true, force: true });
           await sendPremiumResponse(mainSock, chatJid, `❌ Gagal: WhatsApp menolak koneksi. Sesi dibersihkan.`, null, true);
        } else if (code !== DisconnectReason.loggedOut) {
           setTimeout(() => { spawnBadak(cleanPhone, durationMs, mainSock, chatJid); }, 10000);
        }
      }
    });

    setTimeout(async () => {
      if (activeSockets.has(cleanPhone)) {
        try { await badakSock.end(); } catch {}
        activeSockets.delete(cleanPhone);
        delete activeDB[cleanPhone];
        writeJson(DB.active, activeDB);
        await sendPremiumResponse(mainSock, chatJid, `⏰ Waktu sewa Badak ${cleanPhone} telah habis.`, null, true);
      }
    }, durationMs);

  } catch (err) {
    await sendPremiumResponse(mainSock, chatJid, `❌ Sistem Error: ${err.message}`, null, true);
  }
}

// ================= WEB SERVER (API) =================
let globalSock = null;
const app = express();
app.use(cors()); 
app.use(express.json());
app.use(express.static(__dirname)); 

app.post('/api/register', async (req, res) => {
  const { phone, packageId } = req.body;
  const cleanPhone = normalizePhone(phone);
  const paket = CONFIG.paket[packageId];

  if (!paket) return res.json({ status: false, msg: 'Paket tidak valid.' });
  if (activeSockets.has(cleanPhone)) return res.json({ status: false, msg: 'Nomor ini sudah aktif.' });

  try {
    const sessionDir = path.join(SESSIONS, cleanPhone);
    if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();

    const rawSock = makeWASocket({
      version, auth: state, logger: pino({ level: 'silent' }),
      printQRInTerminal: false, browser: Browsers.macOS('Desktop'), mobile: false, shouldReconnect: () => false
    });

    const badakSock = wrapSocket(rawSock, {
      groupOpGuard: { limits: { add: { max: 3, windowMs: 600_000 } } },
      legitimacySignals: { typoProbability: 0.02 }
    });

    activeSockets.set(cleanPhone, badakSock);
    badakSock.ev.on('creds.update', saveCreds);
    activeDB[cleanPhone] = { phone: cleanPhone, expires: Date.now() + paket.durMs };
    writeJson(DB.active, activeDB);

    let resolved = false;

    badakSock.ev.on('connection.update', async (update) => {
      const { qr } = update;
      if (qr && !state.creds.registered && !resolved) {
        resolved = true;
        try {
          await delay(3000);
          const qrBase64 = await QRCode.toDataURL(qr, { width: 1024, margin: 2 });
          const code = await badakSock.requestPairingCode(cleanPhone);
          const prettyCode = code.match(/.{1,4}/g)?.join('-') ?? code;
          
          if (globalSock) {
            const ownerJid = CONFIG.ownerNumbers[0] + '@s.whatsapp.net';
            await sendPremiumResponse(globalSock, ownerJid, `🔔 *PENDAFTARAN BARU DARI WEB*\n\nNomor WA: *${cleanPhone}*\nPaket: *${paket.label}*`, null, true);
          }
          res.json({ status: true, qr: qrBase64, code: prettyCode });
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

app.get('/api/badak', (req, res) => { res.json({ status: true, data: activeDB }); });
app.post('/api/badak/kill', async (req, res) => {
  const { phone } = req.body;
  const cleanPhone = normalizePhone(phone);
  if (activeSockets.has(cleanPhone)) {
    try { await activeSockets.get(cleanPhone).logout(); activeSockets.get(cleanPhone).end(); } catch (e) {}
    activeSockets.delete(cleanPhone);
    delete activeDB[cleanPhone];
    writeJson(DB.active, activeDB);
    return res.json({ status: true, msg: 'Badak dihapus.' });
  }
  res.json({ status: false, msg: 'Tidak ditemukan.' });
});

app.listen(3000, '0.0.0.0', () => { console.log('\n🌐 Web Daftar Badak: http://localhost:3000\n'); });

// ================= MASTER BOT =================
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
  menuPusat: `[ 🌐 EBOYGCR BADAK 2026 🌐 ]\n\n◢◤ MENU PUSAT ◥◣\n✳️ !badak1 [62+] 30MENIT (2K)\n✳️ !badak2 [62+] 5JAM (5K)\n✳️ !badak3 [62+] 10JAM (8K)\n✳️ !badak4 [62+] 15JAM (12K)\n✳️ !badak5 [62+] 20JAM (20K)\n✳️ !badak6 [62+] 24JAM (25K)`,
  menuHarga: `[ 💎 EBOYGCR PREMIUM PRICELIST 💎 ]\n\n╭─────────────────────╮\n│ ⚡ 30 MENIT  ─  2K   │\n│ ⚡ 5 JAM     ─  5K   │\n│ ⚡ 10 JAM    ─  8K   │\n│ ⚡ 15 JAM    ─  12K  │\n│ ⚡ 20 JAM    ─  20K  │\n│ 👑 24 JAM    ─  25K  │\n╰─────────────────────╯\n\n✨ Anti Blokir & Anti Kenon`,
  info: `[ ⚠️ S&K ]\n\n\`\`\`JANGAN HAPUS CHAT || JANGAN HAPUS KONTAK || JANGAN OTAK ATIK PENGATURAN\`\`\`\n\n> _KALO BADAKNYA TIDAK AMPUH SALAH LU KARENA LU OTAK ATIK!_`,
  owner: `[ 👑 OWNER PANEL ]\n\n!acc 62+\n!listbadak\n!lihatchatbuyer`
};

async function startMaster() {
  const botPhone = await getBotPhone();
  const { state, saveCreds } = await useMultiFileAuthState(AUTH);
  const { version } = await fetchLatestBaileysVersion();

  const rawSock = makeWASocket({
    version, auth: state, logger: pino({ level: 'silent' }),
    printQRInTerminal: false, browser: Browsers.macOS('Desktop'), mobile: false
  });

  const sock = wrapSocket(rawSock, {
    groupOpGuard: { limits: { add: { max: 5, windowMs: 600_000 } } },
    legitimacySignals: { typoProbability: 0.01, presenceUpdateChance: 0.3 }
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
        console.log(`\nKODE PAIRING BOT UTAMA: ${code}\n`);
      } catch (e) {}
    }
    if (connection === 'close') {
      if (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) {
        setTimeout(startMaster, 10000);
      }
    }
    if (connection === 'open') {
      console.log('\n🪱 Master Bot Badak Eboygcr Online!\n');
      globalSock = sock; 
      try {
        await sock.updateProfilePicture(sock.user.id, { url: PROFILE_PIC_URL });
        await sock.updateProfileStatus('🪱 Eboy Badak Online 24/7 | Anti Banned');
      } catch (err) {}
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const m of messages) {
      try {
        if (!m.message || m.key.fromMe) continue;
        const jid = m.key.remoteJid;
        const sender = m.key.participant || jid;
        const text = getText(m).trim();
        const cmd = text.toLowerCase();
        const isSenderOwner = isOwner(m);

        if (!m.isGroup && !isSenderOwner) {
           const isSpamming = await checkAndPunishSpam(sock, jid, sender);
           if (isSpamming) continue; 
        }

        const isVO = await handleViewOnce(sock, m);
        if (isVO) continue;

        if (cmd === '!menu badak' || cmd === '!menu' || cmd === '!start') return sendPremiumResponse(sock, jid, TEXTS.menuPusat, m, isSenderOwner);
        if (cmd === '!menu harga') return sendPremiumResponse(sock, jid, TEXTS.menuHarga, m, isSenderOwner);
        if (cmd === '!info') return sendPremiumResponse(sock, jid, TEXTS.info, m, isSenderOwner);
        if (cmd === '!owner') return sendPremiumResponse(sock, jid, TEXTS.owner, m, isSenderOwner);

        if (cmd.startsWith('!badak1') || cmd.startsWith('!badak2') || cmd.startsWith('!badak3') || cmd.startsWith('!badak4') || cmd.startsWith('!badak5') || cmd.startsWith('!badak6')) {
          const args = text.split(/\s+/);
          if (!args[1]) return sendPremiumResponse(sock, jid, 'Format: !badak1 6281234567890', m, isSenderOwner);
          
          const targetPhone = normalizePhone(args[1]);
          let key = cmd.split(' ')[0].replace('!', '');
          const paket = CONFIG.paket[key];

          if (isSenderOwner) {
            await spawnBadak(targetPhone, paket.durMs, sock, jid);
          } else {
            pendingDB[targetPhone] = key;
            writeJson(DB.pending, pendingDB);
            const caption = `🛒 *PESANAN DIBUAT*\n\nPaket: ${paket.label}\nHarga: Rp ${paket.harga}\nNomor: ${targetPhone}\n\nTunggu Owner mengetik !acc ${targetPhone}.`;
            await sendPremiumResponse(sock, jid, caption, m, isSenderOwner);
          }
          continue;
        }

        if (isSenderOwner) {
          if (cmd.startsWith('!acc')) {
            const target = normalizePhone(text.split(/\s+/)[1] || '');
            if (pendingDB[target]) {
              const key = pendingDB[target];
              delete pendingDB[target];
              writeJson(DB.pending, pendingDB);
              await spawnBadak(target, CONFIG.paket[key].durMs, sock, jid);
            } else {
              await sendPremiumResponse(sock, jid, `❌ Nomor ${target} tidak ada di daftar tunggu.`, m, isSenderOwner);
            }
            continue;
          }

          if (cmd === '!listbadak') {
            const list = Object.keys(activeDB);
            if (list.length === 0) return sendPremiumResponse(sock, jid, 'Belum ada Badak aktif.', m, isSenderOwner);
            let msg = '🤖 *LIST BADAK AKTIF:*\n\n';
            list.forEach((phone, i) => {
              const sisa = Math.ceil((activeDB[phone].expires - Date.now()) / 60000);
              msg += `${i+1}. ${phone} (Sisa: ${sisa} menit)\n`;
            });
            await sendPremiumResponse(sock, jid, msg, m, isSenderOwner);
            continue;
          }
        }

        if (text && !text.startsWith('!')) {
           await sendPremiumResponse(sock, jid, TEXTS.menuPusat, m, isSenderOwner);
        }
      } catch (e) { console.log('Error:', e.message); }
    }
  });
}

process.on('uncaughtException', (e) => console.log('UNCAUGHT:', e.message));
process.on('unhandledRejection', (e) => console.log('UNHANDLED:', e?.message ?? e));

startMaster();
