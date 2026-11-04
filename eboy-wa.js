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

[DATA, AUTH, SESSIONS].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

let makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, delay, Browsers;
try {
  const baileys = await import('@whiskeysockets/baileys');
  makeWASocket = baileys.default ?? baileys.makeWASocket;
  useMultiFileAuthState = baileys.useMultiFileAuthState;
  DisconnectReason = baileys.DisconnectReason;
  fetchLatestBaileysVersion = baileys.fetchLatestBaileysVersion;
  delay = baileys.delay ?? ((ms) => new Promise(r => setTimeout(r, ms)));
  Browsers = baileys.Browsers;
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
  
  await sendWithSticker(mainSock, chatJid, `⏳ Menyiapkan koneksi Badak untuk ${cleanPhone}... (Tunggu 10 detik)`);

  try {
    const sessionDir = path.join(SESSIONS, cleanPhone);
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();

    await delay(10000); 

    const badakSock = makeWASocket({
      version, auth: state, logger: pino({ level: 'silent' }),
      printQRInTerminal: false, browser: Browsers.ubuntu('Chrome'), mobile: false,
      shouldReconnect: () => false
    });

    activeSockets.set(cleanPhone, badakSock);
    badakSock.ev.on('creds.update', saveCreds);
    
    activeDB[cleanPhone] = { phone: cleanPhone, expires: Date.now() + durationMs };
    writeJson(DB.active, activeDB);

    // FITUR UTAMA BADAK: Anti-Kenon (Auto Read) & Logger
    badakSock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const m of messages) {
        if (!m.message || m.key.fromMe) continue;
        const jid = m.key.remoteJid;
        const sender = m.key.participant || jid;
        const text = getText(m);

        if (!logsDB[cleanPhone]) logsDB[cleanPhone] = [];
        logsDB[cleanPhone].push({ time: new Date().toLocaleString('id-ID'), from: sender.split('@')[0], text: text || '[Media]' });
        if (logsDB[cleanPhone].length > 50) logsDB[cleanPhone].shift();
        writeJson(DB.logs, logsDB);

        // ANTI KENON 100%
        try { await badakSock.readMessages([m.key]); } catch {}
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

    // Timer Expired
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
  menuBadak: `[  EBOYGCR BADAK WHATSAPP  ]\n\n---------------------------\n!menu badak ⤵️\n✳️ !BADAK1 [ 62+ ] 30MENIT\n✳️ !BADAK2 [ 62+ ] 5JAM \n✳️ !BADAK3 [ 62+ ] 10JAM\n✳️ !BADAK4 [ 62+ ] 15JAM \n✳️ !BADAK5 [ 62+ ] 30JAM \n✳️ !BADAK6 [ 62+ ] 24JAM \n\n---------------------------\n_Ketik !menu harga untuk melihat harga._`,
  
  menuHarga: `!menu harga ⤵️\nHARGA BADAK 1 : 2K ✅\nHARGA BADAK 2 : 5K ✅\nHARGA BADAK 3 : 8K ✅\nHARGA BADAK 4 : 12K ✅\nHARGA BADAK 5 : 20K ✅\nHARGA BADAK 6 : 30K ✅`,

  info: `!info ⤵️ \n*INFORMASI* : \`\`\`wa lu ga badak bisa gua reff/balikin uang lu aman aja Disni badak gua 100% gacor work\`\`\`\n\n*SYARAT* : \`\`\`JANGAN HAPUS CHAT  || JANGAN HAPUS KONTAK || JANGAN HAPUS NOMOR || JANGAN OTAK ATIK PENGATURAN ATAU TERTAUT  KALO BADAKNYA TIDAK AMPUH SALAH LU KARENA LU OTAK ATIK\`\`\`  \n#owner bisa lihat dari jarak jauh \n#buy 15k sudah permanen \n#owner eboygcr`,
  
  owner: `!owner  ⤵️\n!acc 62+\n!listbadak\n!lihatchatbuyer\n\n100000000% WhatsApp anti blokir anti kenon anti banned anti bobol anti bug anti eror anti delay anti virus anti spam \n\nKebal spam \nKebal kenon \nKebal virus \nKebal virtex \nBuat yang nyata reall work nyata \nNo simulasi \nAll reall nyata work gacor premium buat yang premium modern text premium txt premium`
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
    if (connection === 'open') console.log('\n🪱 Master Bot Badak Eboygcr Online!\n');
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

        // === MENU ===
        if (cmd === '!menu badak') return sendWithSticker(sock, jid, TEXTS.menuBadak);
        if (cmd === '!menu harga') return sendWithSticker(sock, jid, TEXTS.menuHarga);
        if (cmd === '!info') return sendWithSticker(sock, jid, TEXTS.info);
        if (cmd === '!owner') return sendWithSticker(sock, jid, TEXTS.owner);

        // === PAKET SEWA BADAK ===
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

        // === COMMAND OWNER ===
        if (isSenderOwner) {
          if (cmd.startsWith('!acc')) {
            const target = normalizePhone(text.split(/\s+/)[1] || '');
            if (pendingDB[target]) {
              const key = pendingDB[target];
              delete pendingDB[target];
              writeJson(DB.pending, pendingDB);
              await sendWithSticker(sock, jid, `⏳ Meng-ACC pesanan ${target}...`);
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
                chats.slice(-3).forEach(c => {
                  msg += `[${c.time}] ${c.from}: ${c.text}\n`;
                });
                msg += '\n';
              }
              await sendWithSticker(sock, jid, msg);
            }
            continue;
          }
        }
      } catch (e) { console.log('Error:', e.message); }
    }
  });
}

process.on('uncaughtException', (e) => console.log('UNCAUGHT:', e.message));
process.on('unhandledRejection', (e) => console.log('UNHANDLED:', e?.message ?? e));

startMaster();