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

// ================= KONFIGURASI =================
const VIDEO_MP4 = 'https://www.w3schools.com/html/mov_bbb.mp4'; 
const AUDIO_VN = 'https://cdn.pixabay.com/download/audio/2022/03/15/audio_c8c8a73467.mp3';
const PROFILE_PIC_URL = 'https://cdn.phototourl.com/member/2026-11-04-629ba914-cb53-48e6-b7de-6cda8d2f9199.jpg'; 

[DATA, AUTH, SESSIONS].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

let makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, delay, Browsers, getContentType;
try {
  const baileys = await import('@whiskeysockets/baileys');
  makeWASocket = baileys.default ?? baileys.makeWASocket;
  useMultiFileAuthState = baileys.useMultiFileAuthState;
  DisconnectReason = baileys.DisconnectReason;
  fetchLatestBaileysVersion = baileys.fetchLatestBaileysVersion;
  delay = baileys.delay ?? ((ms) => new Promise(r => setTimeout(r, ms)));
  Browsers = baileys.Browsers;
  getContentType = baileys.getContentType;
} catch (e) {
  console.error('\n❌ Gagal memuat Baileys:', e.message);
  process.exit(1);
}

// ================= UTILS =================
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

// ================= FITUR BYPASS VIEW ONCE =================
async function handleViewOnce(sock, m) {
  try {
    const type = getContentType(m.message);
    if (type === 'viewOnceMessageV2' || type === 'viewOnceMessage') {
      const innerMsg = m.message[type].message;
      const innerType = getContentType(innerMsg);
      
      if (innerType === 'imageMessage' || innerType === 'videoMessage') {
        const buffer = await sock.downloadMediaMessage({ message: innerMsg, key: m.key });
        
        if (innerType === 'imageMessage') {
          await sock.sendMessage(m.key.remoteJid, { image: buffer, caption: `📸 *[Bypass Sekali Lihat]*\n\n${innerMsg.imageMessage.caption || ''}` });
        } else if (innerType === 'videoMessage') {
          await sock.sendMessage(m.key.remoteJid, { video: buffer, caption: `🎥 *[Bypass Sekali Lihat]*\n\n${innerMsg.videoMessage.caption || ''}` });
        }
        return true; 
      }
    }
  } catch (err) {}
  return false;
}

// ================= UNIVERSAL PREMIUM SENDER (VIDEO + AUDIO + LOADING) =================
async function sendPremiumResponse(sock, jid, text, quotedMsg = null) {
  try {
    // 1. Animasi Loading Edit per detik
    const msg = await sock.sendMessage(jid, { text: `⏳ *[SYSTEM INITIALIZING]*\n> Menyiapkan data...` }, { quoted: quotedMsg });
    const frames = [
      `⏳ *[SYSTEM INITIALIZING]*\n[■■□□□□□□□□] 20%\n> Memuat...`,
      `⏳ *[SYSTEM INITIALIZING]*\n[■■■■■□□□□□] 50%\n> Memproses...`,
      `⏳ *[SYSTEM INITIALIZING]*\n[■■■■■■■■□□] 80%\n> Finalisasi...`,
      `✅ *[SYSTEM READY]*\n[■■■■■■■■■■] 100%\n> Mengirim...`
    ];
    for (let i = 0; i < frames.length; i++) {
      await delay(1000);
      await sock.sendMessage(jid, { text: frames[i], edit: msg.key }).catch(()=>{});
    }
    await delay(300);
    await sock.sendMessage(jid, { delete: msg.key }).catch(()=>{});

    // 2. Kirim Video + Teks
    await sock.sendMessage(jid, { 
      video: { url: VIDEO_MP4 }, 
      caption: text, 
      gifPlayback: true 
    }, { quoted: quotedMsg }).catch(async () => {
      // Fallback jika video gagal
      await sock.sendMessage(jid, { text: text }, { quoted: quotedMsg });
    });

    // 3. Kirim Sound (VN)
    await sock.sendMessage(jid, { 
      audio: { url: AUDIO_VN }, 
      mimetype: 'audio/mp4', 
      ptt: true 
    }, { quoted: quotedMsg }).catch(()=>{});

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

// ================= CHILD BOT (SANG BADAK) =================
const activeSockets = new Map();
const pendingOff = new Map(); // Menyimpan status konfirmasi !off

async function spawnBadak(phone, durationMs, mainSock, chatJid) {
  const cleanPhone = normalizePhone(phone);
  if (activeSockets.has(cleanPhone)) {
    return sendPremiumResponse(mainSock, chatJid, `⚠️ Badak untuk ${cleanPhone} sudah aktif.`);
  }
  
  await sendPremiumResponse(mainSock, chatJid, `⏳ Memproses pembuatan Badak untuk ${cleanPhone}...`);

  try {
    const sessionDir = path.join(SESSIONS, cleanPhone);
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();

    const badakSock = makeWASocket({
      version, auth: state, logger: pino({ level: 'silent' }),
      printQRInTerminal: false, browser: Browsers.ubuntu('Chrome'), mobile: false,
      shouldReconnect: () => false
    });

    activeSockets.set(cleanPhone, badakSock);
    badakSock.ev.on('creds.update', saveCreds);
    
    activeDB[cleanPhone] = { phone: cleanPhone, expires: Date.now() + durationMs };
    writeJson(DB.active, activeDB);

    // ================= FITUR CHILD BOT (SANG BADAK) =================
    badakSock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const m of messages) {
        if (!m.message || m.key.fromMe) continue;
        const jid = m.key.remoteJid;
        const sender = m.key.participant || jid;
        const text = getText(m).trim();
        const cmd = text.toLowerCase();

        // 1. Bypass View Once
        const isVO = await handleViewOnce(badakSock, m);
        if (isVO) continue;

        // 2. Anti Kenon & Logger
        try { await badakSock.readMessages([m.key]); } catch {}
        if (!logsDB[cleanPhone]) logsDB[cleanPhone] = [];
        logsDB[cleanPhone].push({ time: new Date().toLocaleString('id-ID'), from: sender.split('@')[0], text: text || '[Media]' });
        if (logsDB[cleanPhone].length > 50) logsDB[cleanPhone].shift();
        writeJson(DB.logs, logsDB);

        // 3. Menu Badak (!on, !off)
        if (cmd === '!on') {
          const data = activeDB[cleanPhone];
          if (!data) return sendPremiumResponse(badakSock, jid, `❌ Badak tidak aktif.`, m);
          
          const sisaMs = data.expires - Date.now();
          const sisaMenit = Math.max(0, Math.ceil(sisaMs / 60000));
          
          const textOn = `✅ *BADAK SUDAH AKTIF*\n\n🪱 Status: Anti Blokir, Anti Kenon, Anti Banned 100%\n⏳ Sisa Aktif: *${sisaMenit} Menit*\n\n_Sistem berjalan otomatis 24 jam._`;
          await sendPremiumResponse(badakSock, jid, textOn, m);
        } 
        else if (cmd === '!off') {
          pendingOff.set(jid, true);
          const textOff = `⚠️ *KONFIRMASI MATIKAN BADAK*\n\nApakah kamu yakin ingin mematikan Badak ini?\nKetik *!yakin* untuk mematikan.\nKetik *!tidak* untuk membatalkan.`;
          await sendPremiumResponse(badakSock, jid, textOff, m);
        }
        else if (cmd === '!yakin' && pendingOff.has(jid)) {
          pendingOff.delete(jid);
          await sendPremiumResponse(badakSock, jid, `🛑 *BADAK DIMATIKAN*\n\nSesi telah dihapus. Terima kasih telah menyewa.`, m);
          
          setTimeout(async () => {
            try {
              await badakSock.logout();
              await badakSock.end();
            } catch (e) {}
            activeSockets.delete(cleanPhone);
            delete activeDB[cleanPhone];
            writeJson(DB.active, activeDB);
            fs.rmSync(sessionDir, { recursive: true, force: true });
          }, 3000);
        }
        else if (cmd === '!tidak' && pendingOff.has(jid)) {
          pendingOff.delete(jid);
          await sendPremiumResponse(badakSock, jid, `✅ *DIBATALKAN*\n\nBadak tetap aktif.`, m);
        }
        else if (text && !text.startsWith('!')) {
          // Auto Reply Menu Anak
          const menuAnak = `[ 🌐 BADAK PREMIUM 2026 🌐 ]\n\nFitur:\n✳️ !on (Cek Masa Aktif & Status)\n✳️ !off (Matikan Badak)\n\n_1000% WhatsApp tersebut jadi badak anti blokir anti kenon anti banned._`;
          await sendPremiumResponse(badakSock, jid, menuAnak, m);
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
            const code = await badakSock.requestPairingCode(cleanPhone);
            const pretty = code.match(/.{1,4}/g)?.join('-') ?? code;
            
            await mainSock.sendMessage(buyerJid, {
              text: `🔑 *KODE PAIRING*\n\nKode: *${pretty}*\n\nMasukkan kode ini ke menu "Tautkan dengan Nomor Telepon" di WA.`
            });

            await sendPremiumResponse(mainSock, chatJid, `✅ Badak untuk ${cleanPhone} sukses dibuat. QR & Kode Pairing telah dikirim.`);
          } catch (e) {
            await sendPremiumResponse(mainSock, chatJid, `❌ Gagal minta kode pairing: ${e.message}`);
          }
        }
      }

      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        activeSockets.delete(cleanPhone);
        delete activeDB[cleanPhone];
        writeJson(DB.active, activeDB);

        if (code === 401 || code === 428) {
           await sendPremiumResponse(mainSock, chatJid, `❌ Gagal: WhatsApp menolak koneksi (Limit/Error).`);
        } else if (code !== DisconnectReason.loggedOut) {
           setTimeout(() => { spawnBadak(cleanPhone, durationMs, mainSock, chatJid); }, 5000);
        }
      }
    });

    setTimeout(async () => {
      if (activeSockets.has(cleanPhone)) {
        try { await badakSock.end(); } catch {}
        activeSockets.delete(cleanPhone);
        delete activeDB[cleanPhone];
        writeJson(DB.active, activeDB);
        await sendPremiumResponse(mainSock, chatJid, `⏰ Waktu sewa Badak ${cleanPhone} telah habis.`);
      }
    }, durationMs);

  } catch (err) {
    await sendPremiumResponse(mainSock, chatJid, `❌ Sistem Error: ${err.message}`);
  }
}

// ================= WEB SERVER =================
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname)); 
app.get('/api/badak', (req, res) => { res.json({ status: true, data: activeDB }); });
app.post('/api/badak/kill', async (req, res) => {
  const { phone } = req.body;
  const cleanPhone = normalizePhone(phone);
  if (activeSockets.has(cleanPhone)) {
    try { await activeSockets.get(cleanPhone).logout(); activeSockets.get(cleanPhone).end(); } catch (e) {}
    activeSockets.delete(cleanPhone);
    delete activeDB[cleanPhone];
    writeJson(DB.active, activeDB);
    return res.json({ status: true, msg: 'Badak berhasil dihapus.' });
  }
  res.json({ status: false, msg: 'Badak tidak ditemukan.' });
});
app.listen(3000, '0.0.0.0', () => { console.log('\n🌐 Web Dashboard: http://localhost:3000\n'); });

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
  menuPusat: `[ 🌐 EBOYGCR BADAK 2026 🌐 ]\n\n◢◤ MENU PUSAT ◥◣\n✳️ !badak1 [62+] 30MENIT (2K)\n✳️ !badak2 [62+] 5JAM (5K)\n✳️ !badak3 [62+] 10JAM (8K)\n✳️ !badak4 [62+] 15JAM (12K)\n✳️ !badak5 [62+] 30JAM (20K)\n✳️ !badak6 [62+] 24JAM (30K)\n\n> _Ketik !menu harga untuk list harga._\n> _Ketik !info untuk S&K._`,
  menuHarga: `[ 💎 PREMIUM PRICELIST 2026 💎 ]\n\n⚡ BADAK 1 : 2K ✅\n⚡ BADAK 2 : 5K ✅\n⚡ BADAK 3 : 8K ✅\n⚡ BADAK 4 : 12K ✅\n⚡ BADAK 5 : 20K ✅\n⚡ BADAK 6 : 30K ✅`,
  info: `[ ⚠️ SYARAT & KETENTUAN ⚠️ ]\n\n*INFORMASI* : \n\`\`\`wa lu ga badak bisa gua reff/balikin uang lu aman aja Disni badak gua 100% gacor work\`\`\`\n\n*SYARAT* : \n\`\`\`JANGAN HAPUS CHAT || JANGAN HAPUS KONTAK || JANGAN HAPUS NOMOR || JANGAN OTAK ATIK PENGATURAN ATAU TERTAUT\`\`\`\n\n> _KALO BADAKNYA TIDAK AMPUH SALAH LU KARENA LU OTAK ATIK!_`,
  owner: `[ 👑 OWNER PANEL 2026 👑 ]\n\n!acc 62+\n!listbadak\n!lihatchatbuyer\n\n> 100000000% WhatsApp anti blokir anti kenon anti banned.`
};

async function startMaster() {
  const botPhone = await getBotPhone();
  const { state, saveCreds } = await useMultiFileAuthState(AUTH);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version, auth: state, logger: pino({ level: 'silent' }),
    printQRInTerminal: false, browser: Browsers.ubuntu('Chrome'), mobile: false
  });

  sock.ev.on('creds.update', saveCreds);
  let codeReq = false;

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr && !state.creds.registered && !codeReq) {
      codeReq = true;
      try {
        const code = await sock.requestPairingCode(botPhone);
        console.log(`\nKODE PAIRING BOT UTAMA: ${code}\n`);
      } catch (e) {}
    }
    if (connection === 'close') {
      if (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) {
        setTimeout(startMaster, 3000);
      }
    }
    if (connection === 'open') {
      console.log('\n🪱 Master Bot Badak Eboygcr Online!\n');
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
        const text = getText(m).trim();
        const cmd = text.toLowerCase();
        const isSenderOwner = isOwner(m);

        const isVO = await handleViewOnce(sock, m);
        if (isVO) continue;

        // ================= MASTER BOT MENU =================
        if (cmd === '!menu badak' || cmd === '!menu' || cmd === '!start') return sendPremiumResponse(sock, jid, TEXTS.menuPusat, m);
        if (cmd === '!menu harga') return sendPremiumResponse(sock, jid, TEXTS.menuHarga, m);
        if (cmd === '!info') return sendPremiumResponse(sock, jid, TEXTS.info, m);
        if (cmd === '!owner') return sendPremiumResponse(sock, jid, TEXTS.owner, m);

        // ================= PAKET SEWA =================
        if (cmd.startsWith('!badak1') || cmd.startsWith('!badak2') || cmd.startsWith('!badak3') || cmd.startsWith('!badak4') || cmd.startsWith('!badak5') || cmd.startsWith('!badak6')) {
          const args = text.split(/\s+/);
          if (!args[1]) { 
            return sendPremiumResponse(sock, jid, 'Format: !badak1 6281234567890', m);
          }
          
          const targetPhone = normalizePhone(args[1]);
          let key = cmd.split(' ')[0].replace('!', '');
          const paket = CONFIG.paket[key];

          if (isSenderOwner) {
            await spawnBadak(targetPhone, paket.durMs, sock, jid);
          } else {
            pendingDB[targetPhone] = key;
            writeJson(DB.pending, pendingDB);
            const caption = `🛒 *PESANAN DIBUAT*\n\nPaket: ${paket.label}\nHarga: Rp ${paket.harga}\nNomor: ${targetPhone}\n\nTunggu Owner mengetik !acc ${targetPhone}.`;
            await sendPremiumResponse(sock, jid, caption, m);
          }
          continue;
        }

        // ================= COMMAND OWNER =================
        if (isSenderOwner) {
          if (cmd.startsWith('!acc')) {
            const target = normalizePhone(text.split(/\s+/)[1] || '');
            if (pendingDB[target]) {
              const key = pendingDB[target];
              delete pendingDB[target];
              writeJson(DB.pending, pendingDB);
              await spawnBadak(target, CONFIG.paket[key].durMs, sock, jid);
            } else {
              await sendPremiumResponse(sock, jid, `❌ Nomor ${target} tidak ada di daftar tunggu.`, m);
            }
            continue;
          }

          if (cmd === '!listbadak') {
            const list = Object.keys(activeDB);
            if (list.length === 0) {
              await sendPremiumResponse(sock, jid, 'Belum ada Badak yang aktif.', m);
            } else {
              let msg = '🤖 *LIST BADAK AKTIF:*\n\n';
              list.forEach((phone, i) => {
                const sisa = Math.ceil((activeDB[phone].expires - Date.now()) / 60000);
                msg += `${i+1}. ${phone} (Sisa: ${sisa} menit)\n`;
              });
              await sendPremiumResponse(sock, jid, msg, m);
            }
            continue;
          }

          if (cmd === '!lihatchatbuyer') {
            if (Object.keys(logsDB).length === 0) {
              await sendPremiumResponse(sock, jid, 'Belum ada chat dari buyer.', m);
            } else {
              let msg = '📝 *LOG CHAT BUYER TERBARU:*\n\n';
              for (const [phone, chats] of Object.entries(logsDB)) {
                msg += `📱 *Nomor: ${phone}*\n`;
                chats.slice(-3).forEach(c => { msg += `[${c.time}] ${c.from}: ${c.text}\n`; });
                msg += '\n';
              }
              await sendPremiumResponse(sock, jid, msg, m);
            }
            continue;
          }
        }

        // ================= AUTO REPLY (BUKAN COMMAND) =================
        if (text && !text.startsWith('!')) {
           await sendPremiumResponse(sock, jid, TEXTS.menuPusat, m);
        }

      } catch (e) { console.log('Error:', e.message); }
    }
  });
}

process.on('uncaughtException', (e) => console.log('UNCAUGHT:', e.message));
process.on('unhandledRejection', (e) => console.log('UNHANDLED:', e?.message ?? e));

startMaster();