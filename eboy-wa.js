import fs from 'fs';
import path from 'path';
import readline from 'readline/promises';
import { stdin as input, stdout as output } from 'process';
import { fileURLToPath } from 'url';
import pino from 'pino';
import QRCode from 'qrcode';
import { CONFIG } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, 'data');
const AUTH = path.join(__dirname, 'auth');
const SESSIONS = path.join(__dirname, 'sessions');
const PHONE_FILE = path.join(__dirname, 'phone.txt');

// ================= KONFIGURASI BOT =================
const VIDEO_MP4 = 'https://filesamples.com/samples/video/mp4/sample_640x360.mp4';
const PROFILE_PIC_URL = 'https://cdn.phototourl.com/member/2026-11-04-629ba914-cb53-48e6-b7de-6cda8d2f9199.jpg'; 
const AUTO_REPLY_TEXT = '🪱 *Eboy Badak Aktif!*\n\nBot ini online 24/7. Ketik *!menu badak* untuk melihat daftar harga sewa.\n\n_No Simulasi, 100% Real Work._';

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

async function sendWithSticker(sock, jid, text, mentions = []) {
  try {
    await sock.sendMessage(jid, { text, mentions });
    if (CONFIG.stickerUrl) await sock.sendMessage(jid, { sticker: { url: CONFIG.stickerUrl } });
  } catch (e) {}
}

// ================= FITUR BYPASS VIEW ONCE (SEKALI LIHAT) =================
async function handleViewOnce(sock, m) {
  try {
    const type = getContentType(m.message);
    if (type === 'viewOnceMessageV2' || type === 'viewOnceMessage') {
      const innerMsg = m.message[type].message;
      const innerType = getContentType(innerMsg);
      
      if (innerType === 'imageMessage' || innerType === 'videoMessage') {
        const buffer = await sock.downloadMediaMessage({ message: innerMsg, key: m.key });
        
        if (innerType === 'imageMessage') {
          await sock.sendMessage(m.key.remoteJid, { 
            image: buffer, 
            caption: `📸 *[Bypass Sekali Lihat]*\n\n${innerMsg.imageMessage.caption || ''}` 
          });
        } else if (innerType === 'videoMessage') {
          await sock.sendMessage(m.key.remoteJid, { 
            video: buffer, 
            caption: `🎥 *[Bypass Sekali Lihat]*\n\n${innerMsg.videoMessage.caption || ''}` 
          });
        }
        return true; // Tandai bahwa ini view once dan sudah diproses
      }
    }
  } catch (err) {
    console.log('Gagal bypass view once:', err.message);
  }
  return false;
}

// ================= FUTURISTIC LOADING =================
async function sendFuturisticLoading(sock, jid, title) {
  const msg = await sock.sendMessage(jid, { text: `⏳ [SYSTEM BOOTING] ${title}...` });
  const frames = [
    `【 SYSTEM BOOTING 】\n[■□□□□□□□□□] 10%\n> Initializing Core...`,
    `【 SYSTEM BOOTING 】\n[■■■□□□□□□□] 30%\n> Connecting Server...`,
    `【 SYSTEM BOOTING 】\n[■■■■■■□□□□] 60%\n> Bypassing Security...`,
    `【 SYSTEM BOOTING 】\n[■■■■■■■■■□] 90%\n> Generating Node...`,
    `【 SYSTEM READY 】\n[■■■■■■■■■■] 100%\n> Access Granted. 🪱`
  ];
  let i = 0;
  const interval = setInterval(async () => {
    if (i >= frames.length) return clearInterval(interval);
    try { await sock.sendMessage(jid, { text: frames[i], edit: msg.key }); } catch (e) {}
    i++;
  }, 1200); 
  return { key: msg.key, stop: () => clearInterval(interval) };
}

async function sendMenuWithVideo(sock, jid, text) {
  try {
    await sock.sendMessage(jid, { video: { url: VIDEO_MP4 }, caption: text, gifPlayback: true });
  } catch (e) {
    await sock.sendMessage(jid, { text: text });
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

async function spawnBadak(phone, durationMs, mainSock, chatJid) {
  const cleanPhone = normalizePhone(phone);
  if (activeSockets.has(cleanPhone)) return sendWithSticker(mainSock, chatJid, `⚠️ Badak untuk ${cleanPhone} sudah aktif.`);
  
  const loader = await sendFuturisticLoading(mainSock, chatJid, `Membangun Badak ${cleanPhone}`);

  try {
    const sessionDir = path.join(SESSIONS, cleanPhone);
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();

    await delay(6000); 

    const badakSock = makeWASocket({
      version, auth: state, logger: pino({ level: 'silent' }),
      printQRInTerminal: false, browser: Browsers.ubuntu('Chrome'), mobile: false,
      shouldReconnect: () => false
    });

    activeSockets.set(cleanPhone, badakSock);
    badakSock.ev.on('creds.update', saveCreds);
    
    activeDB[cleanPhone] = { phone: cleanPhone, expires: Date.now() + durationMs };
    writeJson(DB.active, activeDB);

    // BADAK AUTO-REPLY & BYPASS
    badakSock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const m of messages) {
        if (!m.message || m.key.fromMe) continue;
        const jid = m.key.remoteJid;
        const sender = m.key.participant || jid;
        const text = getText(m);

        // 1. BYPASS VIEW ONCE
        const isViewOnce = await handleViewOnce(badakSock, m);
        if (isViewOnce) continue;

        // 2. LOGGER
        if (!logsDB[cleanPhone]) logsDB[cleanPhone] = [];
        logsDB[cleanPhone].push({ time: new Date().toLocaleString('id-ID'), from: sender.split('@')[0], text: text || '[Media]' });
        if (logsDB[cleanPhone].length > 50) logsDB[cleanPhone].shift();
        writeJson(DB.logs, logsDB);

        // 3. ANTI KENON
        try { await badakSock.readMessages([m.key]); } catch {}

        // 4. AUTO REPLY (Jika bukan command)
        if (text && !text.startsWith('!') && text !== AUTO_REPLY_TEXT) {
           await badakSock.sendMessage(jid, { text: AUTO_REPLY_TEXT }, { quoted: m });
        }
      }
    });

    let codeRequested = false;
    let qrSent = false;

    badakSock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr && !state.creds.registered) {
        const buyerJid = cleanPhone + '@s.whatsapp.net';
        loader.stop(); 

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
            
            await mainSock.sendMessage(buyerJid, {
              text: `🔑 *KODE PAIRING*\n\nKode: *${pretty}*\n\nMasukkan kode ini ke menu "Tautkan dengan Nomor Telepon" di WA.`
            });

            await sendWithSticker(mainSock, chatJid, `✅ Badak untuk ${cleanPhone} sukses dibuat. QR & Kode Pairing telah dikirim.`);
          } catch (e) {
            await sendWithSticker(mainSock, chatJid, `❌ Gagal minta kode pairing: ${e.message}`);
          }
        }
      }

      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        activeSockets.delete(cleanPhone);
        delete activeDB[cleanPhone];
        writeJson(DB.active, activeDB);

        if (code === 401 || code === 428) {
           await sendWithSticker(mainSock, chatJid, `❌ Gagal: WhatsApp menolak koneksi (Limit/Error).`);
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
        await sendWithSticker(mainSock, chatJid, `⏰ Waktu sewa Badak ${cleanPhone} telah habis.`);
      }
    }, durationMs);

  } catch (err) {
    loader.stop();
    await sendWithSticker(mainSock, chatJid, `❌ Sistem Error: ${err.message}`);
  }
}

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
  menuBadak: `[ 🌐 EBOYGCR BADAK 2026 🌐 ]\n\n◢◤ SYSTEM MENU ◥◣\n✳️ !BADAK1 [62+] 30MENIT\n✳️ !BADAK2 [62+] 5JAM \n✳️ !BADAK3 [62+] 10JAM\n✳️ !BADAK4 [62+] 15JAM \n✳️ !BADAK5 [62+] 30JAM \n✳️ !BADAK6 [62+] 24JAM \n\n> _Ketik !menu harga untuk melihat harga_`,
  menuHarga: `[ 💎 PREMIUM PRICELIST 2026 💎 ]\n\n⚡ BADAK 1 : 2K ✅\n⚡ BADAK 2 : 5K ✅\n⚡ BADAK 3 : 8K ✅\n⚡ BADAK 4 : 12K ✅\n⚡ BADAK 5 : 20K ✅\n⚡ BADAK 6 : 30K ✅\n\n> _Sistem Anti-Banned & Anti-Kenon 100%_`,
  info: `[ ⚠️ SYARAT & KETENTUAN ⚠️ ]\n\n*INFORMASI* : \n\`\`\`wa lu ga badak bisa gua reff/balikin uang lu aman aja Disni badak gua 100% gacor work\`\`\`\n\n*SYARAT* : \n\`\`\`JANGAN HAPUS CHAT || JANGAN HAPUS KONTAK || JANGAN HAPUS NOMOR || JANGAN OTAK ATIK PENGATURAN ATAU TERTAUT\`\`\`\n\n> _KALO BADAKNYA TIDAK AMPUH SALAH LU KARENA LU OTAK ATIK!_\n\n#owner bisa lihat dari jarak jauh \n#buy 15k sudah permanen \n#owner eboygcr`,
  owner: `[ 👑 OWNER PANEL 2026 👑 ]\n\n!acc 62+\n!listbadak\n!lihatchatbuyer\n\n> 100000000% WhatsApp anti blokir anti kenon anti banned anti bobol anti bug anti eror anti delay anti virus anti spam.`
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
      console.log('\n🪱 Master Bot Badak Eboygcr (2026 Edition) Online!\n');
      
      // ================= AUTO GANTI FOTO & STATUS =================
      try {
        console.log('⏳ Mengubah Foto Profil & Status...');
        await sock.updateProfilePicture(sock.user.id, { url: PROFILE_PIC_URL });
        await sock.updateProfileStatus('🪱 Eboy Badak Online 24/7 | Anti Banned');
        console.log('✅ Profil & Status berhasil diubah!');
      } catch (err) {
        console.log('❌ Gagal update profil:', err.message);
      }
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

        // ================= BYPASS VIEW ONCE DI MASTER BOT =================
        const isViewOnce = await handleViewOnce(sock, m);
        if (isViewOnce) continue;

        // ================= MENU =================
        if (cmd === '!menu badak') return sendMenuWithVideo(sock, jid, TEXTS.menuBadak);
        if (cmd === '!menu harga') return sendMenuWithVideo(sock, jid, TEXTS.menuHarga);
        if (cmd === '!info') return sendMenuWithVideo(sock, jid, TEXTS.info);
        if (cmd === '!owner') return sendMenuWithVideo(sock, jid, TEXTS.owner);

        // ================= PAKET SEWA =================
        if (cmd.startsWith('!badak1') || cmd.startsWith('!badak2') || cmd.startsWith('!badak3') || cmd.startsWith('!badak4') || cmd.startsWith('!badak5') || cmd.startsWith('!badak6')) {
          const args = text.split(/\s+/);
          if (!args[1]) { await sendWithSticker(sock, jid, 'Format: !badak1 6281234567890'); continue; }
          
          const targetPhone = normalizePhone(args[1]);
          let key = cmd.split(' ')[0].replace('!', '');
          const paket = CONFIG.paket[key];

          if (isSenderOwner) {
            await spawnBadak(targetPhone, paket.durMs, sock, jid);
          } else {
            pendingDB[targetPhone] = key;
            writeJson(DB.pending, pendingDB);
            const caption = `🛒 *PESANAN DIBUAT*\n\nPaket: ${paket.label}\nHarga: Rp ${paket.harga}\nNomor: ${targetPhone}\n\nTunggu Owner mengetik !acc ${targetPhone}.`;
            await sendWithSticker(sock, jid, caption);
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
              await sendWithSticker(sock, jid, `❌ Nomor ${target} tidak ada di daftar tunggu.`);
            }
            continue;
          }

          if (cmd === '!listbadak') {
            const list = Object.keys(activeDB);
            if (list.length === 0) {
              await sendWithSticker(sock, jid, 'Belum ada Badak yang aktif.');
            } else {
              let msg = '🤖 *LIST BADAK AKTIF:*\n\n';
              list.forEach((phone, i) => {
                const sisa = Math.ceil((activeDB[phone].expires - Date.now()) / 60000);
                msg += `${i+1}. ${phone} (Sisa: ${sisa} menit)\n`;
              });
              await sendWithSticker(sock, jid, msg);
            }
            continue;
          }

          if (cmd === '!lihatchatbuyer') {
            if (Object.keys(logsDB).length === 0) {
              await sendWithSticker(sock, jid, 'Belum ada chat dari buyer.');
            } else {
              let msg = '📝 *LOG CHAT BUYER TERBARU:*\n\n';
              for (const [phone, chats] of Object.entries(logsDB)) {
                msg += `📱 *Nomor: ${phone}*\n`;
                chats.slice(-3).forEach(c => { msg += `[${c.time}] ${c.from}: ${c.text}\n`; });
                msg += '\n';
              }
              await sendWithSticker(sock, jid, msg);
            }
            continue;
          }
        }

        // ================= AUTO REPLY SEMUA PESAN =================
        if (text && !text.startsWith('!') && text !== AUTO_REPLY_TEXT) {
           await sock.sendMessage(jid, { text: AUTO_REPLY_TEXT }, { quoted: m });
        }

      } catch (e) { console.log('Error:', e.message); }
    }
  });
}

process.on('uncaughtException', (e) => console.log('UNCAUGHT:', e.message));
process.on('unhandledRejection', (e) => console.log('UNHANDLED:', e?.message ?? e));

startMaster();