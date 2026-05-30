const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const Tesseract = require('tesseract.js');
const express = require('express');
const app = express();
app.get('/', (req, res) => res.send('Bot is Alive!'));
app.listen(7860, () => console.log('Dummy server running on port 7860'));
process.on('unhandledRejection', e => console.error('⚠️ Rejection:', e.message));
process.on('uncaughtException',  e => console.error('⚠️ Exception:', e.message));

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: { args: ['--no-sandbox', '--disable-setuid-sandbox'], headless: true, timeout: 60000 }
});

// ─────────────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────────────
const safeRead  = (file, fallback) => {
    try { if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
    return fallback;
};
const safeWrite = (file, data) => {
    try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }
    catch(e) { console.error(`❌ Write error [${file}]:`, e.message); }
};

// ─────────────────────────────────────────────────────
//  ANTI-BAN UTILITIES
// ─────────────────────────────────────────────────────
const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

const humanDelay = (minMs = 2000, maxMs = 6000) =>
    new Promise(res => setTimeout(res, randInt(minMs, maxMs)));

const safeSend = async (to, content, options = {}) => {
    try {
        // 1. Simulate reading delay
        await humanDelay(1000, 3000);

        const chat = await client.getChatById(to).catch(() => null);

        if (chat) {
            // 2. Mark account as online
            await client.sendPresenceAvailable().catch(() => {});
            // 3. Mark messages as read
            await chat.sendSeen().catch(() => {});
            // 4. Start typing indicator
            await chat.sendStateTyping().catch(() => {});
        }

        // 5. Typing simulation delay
        await humanDelay(2000, 5000);

        if (chat) {
            // 6. Clear typing indicator
            await chat.clearState().catch(() => {});
        }

        // 7. Tiny pre-send gap
        await humanDelay(500, 1500);

        // 8. Send the message
        return await client.sendMessage(to, content, options);

    } catch (e) {
        log('ERROR', `safeSend failed to ${to}: ${e.message}`);
        return await client.sendMessage(to, content, options);
    }
};

// ─────────────────────────────────────────────────────
//  MESSAGE QUEUE (rate-limiting & sequential processing)
// ─────────────────────────────────────────────────────
const userQueues   = {};
const processingSet = new Set();

const enqueue = (userId, handlerFn) => {
    if (!userQueues[userId]) userQueues[userId] = [];
    userQueues[userId].push(handlerFn);
    drainQueue(userId);
};

const drainQueue = async (userId) => {
    if (processingSet.has(userId)) return;
    processingSet.add(userId);
    while (userQueues[userId] && userQueues[userId].length > 0) {
        const fn = userQueues[userId].shift();
        try { await fn(); } catch (e) { log('ERROR', `Queue handler error for ${userId}: ${e.message}`); }
        await humanDelay(1000, 3000); // Delay between consecutive replies to same user
    }
    processingSet.delete(userId);
};

// ─────────────────────────────────────────────────────
//  LOGGER
// ─────────────────────────────────────────────────────
const LOG_FILE = './bot.log';
const log = (level, msg) => {
    const entry = `[${new Date().toLocaleString('en-IN')}] [${level}] ${msg}`;
    console.log(entry);
    try { fs.appendFileSync(LOG_FILE, entry + '\n'); } catch {}
};

// ─────────────────────────────────────────────────────
//  STATE & LOBBY CONFIG
// ─────────────────────────────────────────────────────
const LOBBY_TYPES = ['mini', 'mega', 'medium', 'competitive', 'live'];
const pendingPayments = {};
const rateLimitMap    = {};
const sessionTimeout  = {};
const antiSpam        = new Set();
let maxSlots          = 24;

let activeModeData = safeRead('./mode.json', { mode: LOBBY_TYPES }).mode;
let activeMode = Array.isArray(activeModeData) ? activeModeData : (activeModeData === 'all' ? [...LOBBY_TYPES] : [activeModeData]);
const saveMode = () => safeWrite('./mode.json', { mode: activeMode });

let links = safeRead('./links.json', {
    mini: 'https://chat.whatsapp.com/xxx',
    mega: 'https://chat.whatsapp.com/yyy',
    medium: 'https://chat.whatsapp.com/zzz',
    competitive: 'https://chat.whatsapp.com/ccc',
    live: 'https://chat.whatsapp.com/vvv'
});
const saveLinks = () => safeWrite('./links.json', links);

let settings = safeRead('./settings.json', { 
    miniPrice: '25', megaPrice: '30', mediumPrice: '40', competitivePrice: '50', livePrice: '60' 
});
const saveSettings = () => safeWrite('./settings.json', settings);

const MAG_UPI_IDS     = ['8823827920@okbizaxis', '8823827920', 'mag esports', 'magesports', 'mag_esports'];
const VALID_AMOUNTS   = ['25', '30', '32', '35', '40', '50', '60', '100'];
const OCR_MIN_CONF    = 35;
const AUTO_VERIFY_MIN = 7;

// ─────────────────────────────────────────────────────
//  RATE LIMITER & SESSION
// ─────────────────────────────────────────────────────
const RATE_LIMIT  = 5;
const RATE_WINDOW = 60 * 1000;

const isRateLimited = (userId) => {
    const now = Date.now();
    if (!rateLimitMap[userId]) rateLimitMap[userId] = [];
    rateLimitMap[userId] = rateLimitMap[userId].filter(t => now - t < RATE_WINDOW);
    if (rateLimitMap[userId].length >= RATE_LIMIT) return true;
    rateLimitMap[userId].push(now);
    return false;
};

const SESSION_TTL = 5 * 60 * 1000;
const touchSession = (userId) => {
    if (sessionTimeout[userId]) clearTimeout(sessionTimeout[userId]);
    sessionTimeout[userId] = setTimeout(() => {
        if (pendingPayments[userId]) {
            delete pendingPayments[userId];
            log('INFO', `Session expired: ${userId}`);
            enqueue(userId, async () => {
                await safeSend(userId, '⌛ *Session timeout ho gayi.*\nDobara screenshot bhejo to restart karo.');
            });
        }
    }, SESSION_TTL);
};

const clearSession = (userId) => {
    if (sessionTimeout[userId]) clearTimeout(sessionTimeout[userId]);
    delete sessionTimeout[userId];
    delete pendingPayments[userId];
};

// ─────────────────────────────────────────────────────
//  SLOT HELPERS & FOMO
// ─────────────────────────────────────────────────────
const readRecords      = () => safeRead('./records.json', []);
const getSlotCount     = (type) => readRecords().filter(r => r.lobbyType?.toLowerCase() === type?.toLowerCase()).length;
const isSlotsAvailable = (type) => getSlotCount(type) < maxSlots;

const saveRecord = (teamName, number, lobbyType, utr = 'N/A', amount = 'N/A') => {
    const records = readRecords();
    records.push({ teamName, number: `+${number}`, lobbyType, utr, amount, timestamp: new Date().toLocaleString('en-IN') });
    safeWrite('./records.json', records);
    log('INFO', `✅ Registered: ${teamName} | ${lobbyType} | +${number}`);
};

const removeRecord = (number) => {
    const records  = readRecords();
    const filtered = records.filter(r => r.number !== `+${number}` && r.number !== number);
    safeWrite('./records.json', filtered);
};

const isDuplicateUTR = (utr) => {
    if (!utr || utr === 'N/A') return false;
    return readRecords().some(r => r.utr === utr);
};

const getStats = () => {
    const records = readRecords();
    const stats = { total: records.length };
    LOBBY_TYPES.forEach(t => stats[t] = records.filter(r => r.lobbyType?.toLowerCase() === t).length);
    return stats;
};

const getFomoText = (slotsLeft) => {
    if (slotsLeft === 0) return `🛑 *FULL HOGAYA*`;
    if (slotsLeft <= 3)  return `🔥 *SIRF ${slotsLeft} SLOT BAKI HAI!*`;
    return `⚡ *Bohot kam slots baki hain!*`;
};

// ─────────────────────────────────────────────────────
//  OCR ENGINE
// ─────────────────────────────────────────────────────
let _ocrWorker = null;
const getOCRWorker = async () => {
    if (!_ocrWorker) {
        _ocrWorker = await Tesseract.createWorker('eng', 1, { logger: () => {} });
        await _ocrWorker.setParameters({ tessedit_pageseg_mode: '11', preserve_interword_spaces: '1' });
    }
    return _ocrWorker;
};
const resetOCRWorker = async () => { try { if (_ocrWorker) await _ocrWorker.terminate(); } catch {} _ocrWorker = null; };

const extractUTR = (text) => {
    const patterns = [ /\b(T\d{11})\b/i, /UTR[:\s#]*([A-Z0-9]{10,22})/i, /Ref(?:erence)?\.?\s*(?:No\.?|ID|Number)?[:\s]*([A-Z0-9]{8,22})/i, /Transaction\s*(?:ID|No\.?|Ref\.?)[:\s]*([A-Z0-9]{8,22})/i, /UPI\s*(?:Ref(?:\.?\s*No)?|Txn\.?|ID)[:\s]*([A-Z0-9]{8,22})/i, /\b([A-Z]{2,4}\d{9,14})\b/, /\b(\d{12})\b/, /\b(\d{16})\b/ ];
    for (const pat of patterns) { const m = text.match(pat); if (m && m[1] && m[1].length >= 8) return m[1].toUpperCase(); }
    return null;
};

const extractAmount = (rawText) => {
    const text = rawText.replace(/,/g, '');
    const labeled = [ /(?:Amount\s*(?:Paid)?|Paid|Total(?:\s*Amount)?|Payment)[:\s]*(?:₹|Rs\.?|INR)?\s*(\d+(?:\.\d{1,2})?)/i, /(?:₹|Rs\.?|INR)\s*(\d+(?:\.\d{1,2})?)/i ];
    for (const pat of labeled) { const m = text.match(pat); if (m) return String(parseInt(m[1], 10)); }
    for (const m of text.matchAll(/\b(\d{2,4})\.0{1,2}\b/g)) if (VALID_AMOUNTS.includes(m[1])) return m[1];
    for (const m of text.matchAll(/\b(\d{2,4})\b/g))        if (VALID_AMOUNTS.includes(m[1])) return m[1];
    return null;
};

const hasRecentDate = (lowerText) => {
    const MONTHS = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
    const now = new Date();
    for (const offset of [0, -1]) {
        const d = new Date(now); d.setDate(d.getDate() + offset);
        const day = String(d.getDate()); const mon = MONTHS[d.getMonth()]; const mm = String(d.getMonth() + 1); const mmPad = mm.padStart(2, '0');
        if (!lowerText.includes(day)) continue;
        if ([mon, `/${mm}/`, `-${mm}-`, `/${mmPad}/`, `-${mmPad}-`].some(s => lowerText.includes(s))) return true;
    }
    return false;
};

const analyzeOCR = (rawText, utr, amount) => {
    const t = rawText.toLowerCase();
    const toMag = MAG_UPI_IDS.some(id => t.includes(id.toLowerCase()));
    const checks = {
        hasSuccess:    { w: 3, pass: /success|paid|completed|approved|received|payment\s*done/i.test(t) },
        hasDate:       { w: 2, pass: hasRecentDate(t) },
        hasUPI:        { w: 2, pass: /upi|phonepe|gpay|google\s*pay|paytm|bhim/i.test(t) },
        hasUTR:        { w: 2, pass: !!utr },
        isValidAmount: { w: 2, pass: !!(amount && VALID_AMOUNTS.includes(amount)) },
        hasMagEsports: { w: 1, pass: toMag },
    };
    const earned = Object.values(checks).reduce((s, c) => s + (c.pass ? c.w : 0), 0);
    const status = (checks.hasSuccess.pass && earned >= AUTO_VERIFY_MIN) ? '✅ AUTO-VERIFIED' : (checks.hasSuccess.pass && earned >= 4) ? '⚠️ PARTIAL MATCH' : '❌ FAKE/OLD';
    return { status };
};

const isInvalidName = (name) => {
    const lower = name.toLowerCase().trim();
    const bad   = ['ok','done','yes','ha','hmm','ho gaya','hi','hello','bhai','bro','qr','pay','payment','ss','screenshot','mera','slot','book','jaldi','please','plz','team','naam','name'];
    if (lower.length < 2 || bad.includes(lower) || /^[\d\s\W_]+$/.test(lower) || /^(.)\1{2,}$/.test(lower)) return true;
    return false;
};

// ─────────────────────────────────────────────────────
//  MESSAGING HELPERS
// ─────────────────────────────────────────────────────
const getWelcomeMessage = () => {
    let msg = `🎮 *MAG ESPORTS — LOBBY REGISTRATION*\n━━━━━━━━━━━━━━━━━━━━\n\nKonsi lobby leni hai?\n\n`;
    if (activeMode.length === 0) return `🚫 *MAG ESPORTS*\nAbhi koi lobby active nahi hai. Thodi der baad try karein.`;

    activeMode.forEach(t => {
        const slotsLeft = maxSlots - getSlotCount(t);
        const fomo = getFomoText(slotsLeft);
        msg += `🔹 *${t.toUpperCase()} LOBBY*\n   💰 Price      : *₹${settings[`${t}Price`]}*\n   🎟️ Status     : ${fomo}\n\n`;
    });
    
    let sample = activeMode[0].charAt(0).toUpperCase() + activeMode[0].slice(1);
    msg += `━━━━━━━━━━━━━━━━━━━━\n👉 Apna lobby type likh kar bhejo (eg. *${sample}*)\n━━━━━━━━━━━━━━━━━━━━`;
    return msg;
};

const sendLobbyInfo = async (to, lobbyType) => {
    const typeKey   = lobbyType.toLowerCase();
    const price     = settings[`${typeKey}Price`];
    const slotsLeft = maxSlots - getSlotCount(typeKey);
    const fomo      = getFomoText(slotsLeft);

    await safeSend(to, `🔹 *${lobbyType.toUpperCase()} LOBBY*\n━━━━━━━━━━━━━━━━━━━━\n💰 Entry Fee  : *₹${price}*\n🎟️ Status     : ${fomo}\n━━━━━━━━━━━━━━━━━━━━\n👇 QR scan karke *₹${price}* pay karo\naur payment ka screenshot bhejo.`);

    if (fs.existsSync('./qr.png')) {
        const qrImg = MessageMedia.fromFilePath('./qr.png');
        await safeSend(to, qrImg, { caption: `📲 Scan & Pay *₹${price}* → Screenshot bhejo` });
    } else {
        await safeSend(to, `⚠️ QR image abhi available nahi. Admin se contact karo.`);
    }
};

const processVerification = async (msg, teamName, lobbyType, paymentData) => {
    const { media, status, utr, amount } = paymentData;
    const cleanNumber = await getRealNumber(msg);
    const displayNum  = `+${cleanNumber}`;
    const rawId       = msg.from;
    const link        = links[lobbyType.toLowerCase()];

    if (status === '✅ AUTO-VERIFIED') {
        if (isDuplicateUTR(utr)) {
            await sendAdminMedia(media, `⚠️ DUPLICATE UTR BLOCKED!\nTeam: *${teamName}*\nLobby: *${lobbyType}*\nNumber: ${displayNum}\nID: ${rawId}\nUTR: ${utr}\n\nReply *ok* to force approve or *ban* to deny.`);
            return safeSend(rawId, "⚠️ Payment already used lag raha hai. Admin check karega.");
        }
        saveRecord(teamName, cleanNumber, lobbyType, utr || 'N/A', amount || 'N/A');
        await safeSend(rawId, `✅ *PAYMENT VERIFIED!*\nTeam  : *${teamName}*\nLobby : *${lobbyType}*\n━━━━━━━━━━━━━━━━━━━━\n🔗 Group join karo 👇\n${link}`);
        await sendAdminMedia(media, `✅ AUTO-VERIFIED\nTeam: *${teamName}*\nLobby: *${lobbyType}*\nNumber: ${displayNum}\nID: ${rawId}\nUTR: ${utr || 'N/A'}\n\nReply *ban* to revoke.`);
    } else {
        await sendAdminMedia(media, `🚨 MANUAL CHECK REQUIRED\nTeam: *${teamName}*\nLobby: *${lobbyType}*\nNumber: ${displayNum}\nID: ${rawId}\nStatus: ${status}\nUTR: ${utr || 'Not found'}\n\nReply *ok* to approve or *ban* to deny.`);
        await safeSend(rawId, `⏳ *Payment manual check pe gaya.*\nAdmin verify karega. Thoda wait karo. 🙏`);
    }
};

const getRealNumber = async (msg) => { try { const c = await msg.getContact(); if (c?.number?.length >= 10) return c.number; } catch {} return msg.from.split('@')[0]; };
// Admin log messages are instant (bypasses safeSend)
const sendAdminMedia = async (media, caption) => { try { await client.sendMessage(client.info.wid._serialized, media, { caption }); } catch {} };

// ─────────────────────────────────────────────────────
//  CLIENT EVENTS
// ─────────────────────────────────────────────────────
client.on('qr',    qr => qrcode.generate(qr, { small: true }));
client.on('ready', ()  => log('INFO', '✅ BOT READY'));
client.on('auth_failure', m => log('ERROR', `Auth failed: ${m}`));
client.on('disconnected', reason => { log('WARN', `Disconnected: ${reason}. Reinitializing in 5s...`); setTimeout(() => client.initialize(), 5000); });

// ─────────────────────────────────────────────────────
//  MESSAGE HANDLER
// ─────────────────────────────────────────────────────
client.on('message_create', async msg => {
    try {
        const rawText   = msg.body.trim();
        const textLower = rawText.toLowerCase();
        const cmd       = textLower.split(/\s+/)[0];
        const isAdmin   = msg.fromMe || msg.from === '100334781354038@lid' || msg.from === client.info.wid._serialized;

        // ══════════════════════════════════════════
        //  ADMIN BLOCK (Instant execution, No Queue)
        // ══════════════════════════════════════════
        if (isAdmin) {
            if (cmd === '.setlink') {
                const parts = rawText.split(/\s+/); const type = parts[1]?.toLowerCase(); const linkMatch = rawText.match(/https?:\/\/[^\s]+/i);
                if (linkMatch && LOBBY_TYPES.includes(type)) { links[type] = linkMatch[0]; saveLinks(); return msg.reply(`✅ *${type.toUpperCase()}* link updated.`); }
                return msg.reply(`⚠️ Usage: .setlink <${LOBBY_TYPES.join('/')}> <link>`);
            }
            if (cmd === '.setprice') {
                const parts = rawText.split(/\s+/); const type = parts[1]?.toLowerCase(); const price = parts[2];
                if (LOBBY_TYPES.includes(type) && price) { settings[`${type}Price`] = price; saveSettings(); return msg.reply(`✅ ${type.toUpperCase()} price: ₹${price}`); }
                return msg.reply(`⚠️ Usage: .setprice <${LOBBY_TYPES.join('/')}> <amount>`);
            }
            if (cmd === '.list') {
                const records = readRecords(); if (!records.length) return msg.reply('📋 No registrations yet.');
                let out = `📋 *SLOTLIST*\n\n`;
                LOBBY_TYPES.forEach(t => {
                    const list = records.filter(r => r.lobbyType?.toLowerCase() === t);
                    if (list.length) {
                        out += `🔹 *${t.toUpperCase()} (${list.length}/${maxSlots})*\n`;
                        list.forEach((r, i) => out += `${i+1}. ${r.teamName}\n`);
                        out += `\n`;
                    }
                });
                return msg.reply(out.trim());
            }
            if (cmd === '.clear') { safeWrite('./records.json', []); return msg.reply('🧹 Slotlist cleared.'); }
            if (cmd === '.stats') {
                const s = getStats(); 
                let statMsg = `📊 *BOT STATS*\n━━━━━━━━━━━━━━━\nTotal Registered : ${s.total}\n`;
                LOBBY_TYPES.forEach(t => statMsg += `${t.toUpperCase()} Slots : ${s[t]}/${maxSlots}\n`);
                statMsg += `\nActive Modes : ${activeMode.map(m => m.toUpperCase()).join(', ')}\n━━━━━━━━━━━━━━━`;
                return msg.reply(statMsg);
            }
            if (cmd === '.setslots') {
                const n = parseInt(rawText.split(/\s+/)[1]); if (!isNaN(n) && n > 0) { maxSlots = n; return msg.reply(`✅ Max slots per lobby: *${n}*`); }
            }
            if (cmd === '.setmode') {
                const args = textLower.split(/\s+/).slice(1);
                if (args.length === 0) return msg.reply(`⚠️ Usage: .setmode <all / mini mega live competitive ...>`);
                
                if (args.includes('all')) {
                    activeMode = [...LOBBY_TYPES];
                } else {
                    const validTypes = args.filter(a => LOBBY_TYPES.includes(a));
                    if (validTypes.length === 0) return msg.reply(`⚠️ Invalid input. Available: ${LOBBY_TYPES.join(', ')}`);
                    activeMode = [...new Set(validTypes)]; 
                }
                saveMode(); 
                return msg.reply(`✅ *Open Lobbies: ${activeMode.map(m => m.toUpperCase()).join(', ')}*`);
            }
            if (msg.hasQuotedMsg && (cmd === 'ok' || cmd === 'ban')) {
                const body = (await msg.getQuotedMessage()).body || '';
                const targetId = (body.match(/ID:\s*(\S+)/) || [])[1];
                const cleanNumber = (body.match(/Number:\s*\+?(\d+)/) || [])[1] || (targetId ? targetId.split('@')[0] : null);
                if (targetId) {
                    const teamName = (body.match(/Team:\s*\*?([^\n*]+)\*?/) || [])[1]?.trim() || 'Unknown';
                    const lobbyType = (body.match(/Lobby:\s*\*?([^\n*]+)\*?/i) || [])[1]?.trim() || 'Mini';
                    if (cmd === 'ok') {
                        saveRecord(teamName, cleanNumber, lobbyType, 'N/A', 'N/A');
                        enqueue(targetId, async () => {
                            await safeSend(targetId, `✅ *VERIFIED BY ADMIN!*\nTeam: *${teamName}*\n🔗 Link: ${links[lobbyType.toLowerCase()]}`);
                        });
                        return msg.reply(`✅ Approved: ${teamName}`);
                    }
                    if (cmd === 'ban') {
                        if (body.includes('AUTO-VERIFIED')) removeRecord(cleanNumber);
                        enqueue(targetId, async () => {
                            await safeSend(targetId, `🚫 *Payment Rejected!*\nSahi screenshot bhejo ya admin se contact karo.`);
                        });
                        return msg.reply(`🚫 Rejected: ${teamName}`);
                    }
                }
            }
            const adminCmds = ['.setlink','.setprice','.list','.clear','.stats','.setslots','.setmode','ok','ban'];
            if (!adminCmds.includes(cmd)) return;
        }

        // ══════════════════════════════════════════
        //  PLAYER BLOCK (Enqueued & Anti-Ban Active)
        // ══════════════════════════════════════════
        enqueue(msg.from, async () => {
            if (isRateLimited(msg.from)) {
                return safeSend(msg.from, '🚦 Bahut saare messages bhej rahe ho. Thoda ruko.');
            }

            // ── Pending States ──
            if (pendingPayments[msg.from]?.state === 'AWAITING_LOBBY') {
                const pData = pendingPayments[msg.from]; touchSession(msg.from);
                
                const foundType = LOBBY_TYPES.find(t => textLower.includes(t));
                if (!foundType) return safeSend(msg.from, `⚠️ Lobby select karo. Available: *${activeMode.map(m => m.charAt(0).toUpperCase() + m.slice(1)).join('*, *')}*`);
                
                if (!activeMode.includes(foundType)) return safeSend(msg.from, `🚫 *${foundType.toUpperCase()} lobby abhi close hai.*\n👉 Open Lobbies: *${activeMode.map(m => m.toUpperCase()).join(', ')}*`);
                
                const lobbyType = foundType.charAt(0).toUpperCase() + foundType.slice(1);
                if (!isSlotsAvailable(lobbyType)) { clearSession(msg.from); return safeSend(msg.from, `😔 *${lobbyType} lobby full ho gayi!*`); }
                
                pData.lobbyType = lobbyType; pData.state = 'AWAITING_TEAM_NAME'; touchSession(msg.from);
                return safeSend(msg.from, `✅ *${lobbyType} Lobby* select ki!\n\nApna *Team Name* bhejo:`);
            }
            if (pendingPayments[msg.from]?.state === 'AWAITING_TEAM_NAME') {
                const pData = pendingPayments[msg.from]; touchSession(msg.from);
                if (isInvalidName(rawText)) return safeSend(msg.from, '⚠️ Ek proper *Team Name* bhejo.');
                if (!isSlotsAvailable(pData.lobbyType)) { clearSession(msg.from); return safeSend(msg.from, `🛑 *${pData.lobbyType} lobby full ho gayi!*`); }
                clearSession(msg.from); return await processVerification(msg, rawText, pData.lobbyType, pData);
            }

            // ── Screenshot ──
            if (msg.hasMedia) {
                const media = await msg.downloadMedia();
                if (!media?.mimetype?.startsWith('image/')) return safeSend(msg.from, '🛑 Sirf *payment screenshot image* bhejo.');
                await safeSend(msg.from, '⏳ Screenshot check ho raha hai...');
                try {
                    const buffer = Buffer.from(media.data, 'base64');
                    const { data: { text, confidence } } = await (await getOCRWorker()).recognize(buffer);
                    let statusObj = analyzeOCR(text, extractUTR(text), extractAmount(text));
                    if (Math.round(confidence) < OCR_MIN_CONF) statusObj.status = '⚠️ LOW IMAGE QUALITY';
                    const pData = { media, status: statusObj.status, utr: extractUTR(text), amount: extractAmount(text), state: 'AWAITING_LOBBY' };
                    
                    const anySlots = activeMode.some(t => isSlotsAvailable(t));
                        
                    if (!anySlots) return safeSend(msg.from, `🛑 Abhi ki sabhi open lobbies full ho chuki hain!`);
                    pendingPayments[msg.from] = pData; touchSession(msg.from);
                    return safeSend(msg.from, `✅ *Screenshot receive ho gaya!*\nKaunsi lobby leni hai?\n👉 Type: *${activeMode.map(m => m.charAt(0).toUpperCase() + m.slice(1)).join('*, *')}*`);
                } catch (e) {
                    await resetOCRWorker();
                    pendingPayments[msg.from] = { media, status: '❌ OCR FAILED', state: 'AWAITING_LOBBY' }; touchSession(msg.from);
                    return safeSend(msg.from, `⚠️ Screenshot check me error aayi.\nKaunsi lobby leni hai?\n👉 Type: *${activeMode.map(m => m.charAt(0).toUpperCase() + m.slice(1)).join('*, *')}*`);
                }
            }

            // ── SMART KEYWORD AI ENGINE ──
            if (!msg.hasMedia && !pendingPayments[msg.from] && rawText.length > 0) {
                
                const asksQR = /qr|scan|pay|upi|kese|kaise|bhejo|number|send/i.test(textLower);
                const foundLobby = LOBBY_TYPES.find(t => 
                    textLower.includes(t) || 
                    settings[`${t}Price`].toString().split('/').some(p => textLower.includes(p.trim()))
                );

                if (foundLobby || asksQR) {
                    if (antiSpam.has(msg.from)) return;
                    antiSpam.add(msg.from); setTimeout(() => antiSpam.delete(msg.from), 4000);

                    let targetLobby = foundLobby ? foundLobby.toLowerCase() : null;
                    
                    if (!targetLobby && activeMode.length === 1) {
                        targetLobby = activeMode[0];
                    }

                    if (targetLobby) {
                        if (!activeMode.includes(targetLobby)) return safeSend(msg.from, `🚫 *${targetLobby.toUpperCase()}* abhi close hai.\n👉 Open Lobbies: *${activeMode.map(m => m.toUpperCase()).join(', ')}*`);
                        if (!isSlotsAvailable(targetLobby)) return safeSend(msg.from, `😔 *${targetLobby.toUpperCase()} lobby full ho gayi!*`);
                        return await sendLobbyInfo(msg.from, targetLobby);
                    } else {
                        if (fs.existsSync('./qr.png')) {
                            const qrImg = MessageMedia.fromFilePath('./qr.png');
                            let priceText = "";
                            activeMode.forEach(t => priceText += `🔹 *${t.charAt(0).toUpperCase() + t.slice(1)}:* ₹${settings[`${t}Price`]}\n`);
                            return safeSend(msg.from, `👇 *SCAN & PAY*\n\n${priceText}\nPay karke screenshot bhejein.`, { media: qrImg });
                        } else {
                            return safeSend(msg.from, '⚠️ QR image missing.');
                        }
                    }
                }

                // 3. Fallback Welcome Message
                const welcomeRegex = /\b(hi|hello|hey|menu|book|slot|slots|register|tourney|tournament|\?|help|details)\b/i;
                if (welcomeRegex.test(textLower)) {
                    if (antiSpam.has(msg.from)) return;
                    antiSpam.add(msg.from); setTimeout(() => antiSpam.delete(msg.from), 5000);
                    return safeSend(msg.from, getWelcomeMessage());
                }
            }
        }); // End of enqueue

    } catch (e) {
        log('ERROR', `Handler error: ${e.message}`);
    }
});

client.initialize();
