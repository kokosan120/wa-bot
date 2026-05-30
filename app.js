const express = require('express');
const app = express();
app.get('/', (req, res) => res.send('MAG Bot is running!'));
app.listen(process.env.PORT || 7860, () => console.log('Web server is ready!'));

const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const Tesseract = require('tesseract.js');
const cron = require('node-cron');
const crypto = require('crypto');
const mongoose = require('mongoose');

process.on('unhandledRejection', e => console.error('⚠️ Rejection:', e.message));
process.on('uncaughtException',  e => console.error('⚠️ Exception:', e.message));

// ─────────────────────────────────────────────────────
//  ANTI-BAN UTILITIES
// ─────────────────────────────────────────────────────
const randInt    = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const humanDelay = (minMs = 2000, maxMs = 6000) => new Promise(res => setTimeout(res, randInt(minMs, maxMs)));

const safeSend = async (to, content, options = {}) => {
    try {
        await humanDelay(1000, 3000);
        const chat = await client.getChatById(to).catch(() => null);
        if (chat) {
            await client.sendPresenceAvailable().catch(() => {});
            await chat.sendSeen().catch(() => {});
            await chat.sendStateTyping().catch(() => {});
        }
        await humanDelay(2000, 5000);
        if (chat) await chat.clearState().catch(() => {});
        await humanDelay(500, 1500);
        return await client.sendMessage(to, content, options);
    } catch (e) {
        log('ERROR', `safeSend failed to ${to}: ${e.message}`);
        return await client.sendMessage(to, content, options);
    }
};

// ─────────────────────────────────────────────────────
//  MESSAGE QUEUE
// ─────────────────────────────────────────────────────
const userQueues    = {};
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
        try { await fn(); } catch (e) { log('ERROR', `Queue error for ${userId}: ${e.message}`); }
        await humanDelay(1000, 3000);
    }
    processingSet.delete(userId);
};

// ─────────────────────────────────────────────────────
//  MONGODB SETUP
// ─────────────────────────────────────────────────────
const MONGO_URI = 'mongodb+srv://tinyji6887_db_user:magbot123@cluster0.zu7kwc5.mongodb.net/Magbotpaid?retryWrites=true&w=majority';
mongoose.connect(MONGO_URI)
    .then(() => console.log('✅ Connected to MongoDB (Magbotpaid)!'))
    .catch(err => console.error('❌ MongoDB Connection Error:', err));

const teamSchema = new mongoose.Schema({
    teamName: String, number: String, lobbyType: String,
    utr: String, amount: String, imgHash: String, timestamp: String
});
const DailyRecord = mongoose.model('Dailylobby', teamSchema, 'Dailylobby');

const sessionSchema = new mongoose.Schema({
    phone: String, mediaPath: String, status: String,
    isAuto: Boolean, utr: String, amount: String, imgHash: String,
    state: String, lobbyType: String,
    createdAt: { type: Date, default: Date.now, expires: 600 }
});
const TempSession = mongoose.model('TempSession', sessionSchema, 'TempSession');

let localRecords = [];
DailyRecord.find({}).then(data => {
    localRecords = data;
    console.log(`✅ Loaded ${localRecords.length} teams from Database.`);
});

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: { args: ['--no-sandbox', '--disable-setuid-sandbox'], headless: true, timeout: 60000 }
});

const safeRead  = (file, fallback) => { try { if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')); } catch {} return fallback; };
const safeWrite = (file, data)     => { try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch(e) {} };

const LOG_FILE = './bot.log';
const log = (level, msg) => {
    const entry = `[${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}] [${level}] ${msg}`;
    console.log(entry);
    try { fs.appendFileSync(LOG_FILE, entry + '\n'); } catch {}
};

const rateLimitMap   = {};
const antiSpam       = new Set();
const seenUsers      = new Set();
const completedUsers = new Set();
const qrReminders    = {};
let maxSlots         = 24;

// ─────────────────────────────────────────────────────
//  SETTINGS
//  Lobbies are fully dynamic — admin sets name, price,
//  matches, link, emoji via commands. Default = 3 lobbies.
// ─────────────────────────────────────────────────────
let activeMode = safeRead('./mode.json', { mode: 'both' }).mode;
const saveMode = () => safeWrite('./mode.json', { mode: activeMode });

/*
 * lobbies.json  — array of lobby objects (order matters for menu)
 * Each lobby:  { id, name, price, matches, emoji, link }
 *   id      — internal key used everywhere (lowercase, no spaces)
 *   name    — display name shown to users (admin sets via .setlobbyname)
 *   price   — entry fee string e.g. "20" or "20/25"
 *   matches — number of matches e.g. "4"
 *   emoji   — single emoji shown in menu
 *   link    — WhatsApp group invite link
 */
const DEFAULT_LOBBIES = [
    { id: 'mini', name: 'Mini', price: '20/25', matches: '4', emoji: '🟡', link: 'https://chat.whatsapp.com/xxx' },
    { id: 'mega', name: 'Mega', price: '35/45', matches: '6', emoji: '🔵', link: 'https://chat.whatsapp.com/yyy' },
    { id: 'live', name: 'Live', price: '55',    matches: '6', emoji: '🔴', link: 'https://chat.whatsapp.com/zzz' },
];

let lobbies = safeRead('./lobbies.json', DEFAULT_LOBBIES);
// Backfill any missing keys on old saves
lobbies = lobbies.map(l => ({
    id: l.id, name: l.name || l.id,
    price: l.price || '0', matches: l.matches || '4',
    emoji: l.emoji || '🎮', link: l.link || ''
}));
const saveLobbies = () => safeWrite('./lobbies.json', lobbies);

// Legacy settings kept for OCR / scrim name / time
let settings = safeRead('./settings.json', { scrimName: 'MAG ESPORTS', lobbyTime: '9 PM', closedLobbies: [] });
if (!settings.closedLobbies) settings.closedLobbies = [];
const saveSettings = () => safeWrite('./settings.json', settings);

// ── Mode: which lobby IDs are active ─────────────────
// 'all' = every lobby; 'both' = first two; specific id = only that one
// 'minilive' = first + third (legacy alias)
const getActiveLobbies = () => {
    if (activeMode === 'all')                 return lobbies;
    if (activeMode === 'both')                return lobbies.slice(0, 2);
    if (activeMode === 'minilive')            return [lobbies[0], lobbies[2]].filter(Boolean);
    const found = lobbies.find(l => l.id === activeMode);
    return found ? [found] : lobbies.slice(0, 2);
};

const lobbyById     = (id) => lobbies.find(l => l.id === id.toLowerCase());
const lobbyInMode   = (id) => getActiveLobbies().some(l => l.id === id.toLowerCase());

const MAG_UPI_IDS = [
    '8823827920@okbizaxis', '8823827920', 'mag esports', 'magesports', 'mag_esports',
    'mac esports', 'maq esports', '882382792o', 'chetan bhul', 'chetan'
];
const OCR_MIN_CONF = 30;

const getValidPrices = () => lobbies.flatMap(l => (l.price || '').match(/\d+/g) || []);

const saveSession  = async (phone, data) => { data.createdAt = new Date(); await TempSession.findOneAndUpdate({ phone }, data, { upsert: true }); };
const clearSession = async (phone) => { await TempSession.deleteOne({ phone }); };

const setQrReminder = (userId) => {
    if (qrReminders[userId]) clearTimeout(qrReminders[userId]);
    qrReminders[userId] = setTimeout(async () => {
        const pData = await TempSession.findOne({ phone: userId });
        if (!pData || pData.state === 'AWAITING_TEAM_NAME') { delete qrReminders[userId]; return; }
        try {
            await safeSend(userId,
                `🚨 *FINAL REMINDER!* 🚨\n\nBhai aapne slot manga tha par abhi tak screenshot nahi bheja.\n\n` +
                `⚡ *Sirf kuch LAST SLOTS bache hain!* ⚡\n` +
                `Jaldi pay karke screenshot bhejo warna slot cancel ho jayega!\n\nFast kro bhai ⏳`
            );
        } catch (e) {}
        delete qrReminders[userId];
    }, 5 * 60 * 1000);
};
const clearQrReminder = (userId) => { if (qrReminders[userId]) { clearTimeout(qrReminders[userId]); delete qrReminders[userId]; } };

const isRateLimited = (userId) => {
    const now = Date.now();
    if (!rateLimitMap[userId]) rateLimitMap[userId] = [];
    rateLimitMap[userId] = rateLimitMap[userId].filter(t => now - t < 60000);
    if (rateLimitMap[userId].length >= 10) return true;
    rateLimitMap[userId].push(now);
    return false;
};

const readRecords      = () => localRecords;
const getSlotCount     = (id) => readRecords().filter(r => r.lobbyType?.toLowerCase() === id?.toLowerCase()).length;
const isSlotsAvailable = (id) => {
    if (settings.closedLobbies.includes(id.toLowerCase())) return false;
    return getSlotCount(id) < maxSlots;
};

const saveRecord = (teamName, number, lobbyType, utr = 'N/A', amount = 'N/A', imgHash = 'N/A') => {
    const istTimestamp = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
    const doc = { teamName, number: `+${number}`, lobbyType, utr, amount, imgHash, timestamp: istTimestamp };
    localRecords.push(doc);
    new DailyRecord(doc).save().catch(e => log('ERROR', 'MongoDB Save Error: ' + e));
};

const removeRecord = (number) => {
    const numStr = String(number).startsWith('+') ? number : `+${number}`;
    localRecords = localRecords.filter(r => r.number !== numStr && r.number !== number);
    DailyRecord.deleteMany({ $or: [{ number: numStr }, { number: number }] }).catch(e => log('ERROR', 'DB Del Error: ' + e));
};

const isDuplicateUTR  = (utr)  => { if (!utr || utr === 'N/A') return false; return readRecords().some(r => r.utr === utr); };
const isDuplicateHash = (hash) => { if (!hash || hash === 'N/A') return false; return readRecords().some(r => r.imgHash === hash); };
const isDuplicateTeam = (teamName, lobbyId) => readRecords().some(r =>
    r.lobbyType?.toLowerCase() === lobbyId.toLowerCase() &&
    r.teamName.toLowerCase().trim() === teamName.toLowerCase().trim()
);

const getStats = () => {
    const records = readRecords();
    const out = { total: records.length };
    lobbies.forEach(l => { out[l.id] = records.filter(r => r.lobbyType?.toLowerCase() === l.id).length; });
    return out;
};

// ─────────────────────────────────────────────────────
//  OCR
// ─────────────────────────────────────────────────────
let _ocrWorker = null;
const getOCRWorker = async () => {
    if (!_ocrWorker) {
        _ocrWorker = await Tesseract.createWorker('eng', 1, { logger: () => {} });
        await _ocrWorker.setParameters({ tessedit_pageseg_mode: '11', preserve_interword_spaces: '1', user_defined_dpi: '300' });
    }
    return _ocrWorker;
};
const resetOCRWorker = async () => { try { if (_ocrWorker) await _ocrWorker.terminate(); } catch {} _ocrWorker = null; };

const checkDateStatus = (lowerText) => {
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const formatD = (d) => {
        const day = d.getDate(); const dayPad = String(day).padStart(2, '0');
        const mon = d.toLocaleString('en-US', { month: 'short' }).toLowerCase();
        const monFull = d.toLocaleString('en-US', { month: 'long' }).toLowerCase();
        return [`${day} ${mon}`, `${dayPad} ${mon}`, `${day} ${monFull}`, `${dayPad} ${monFull}`];
    };
    const todays = formatD(now);
    if (/\btoday|aaj\b/i.test(lowerText)) return 'TODAY';
    let foundAnyDate = false; let foundToday = false;
    const dateRegex = /\b(\d{1,2})\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/ig;
    let match;
    while ((match = dateRegex.exec(lowerText)) !== null) {
        foundAnyDate = true;
        if (todays.some(r => match[0].toLowerCase().includes(r))) foundToday = true;
    }
    const numDateRegex = /\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})\b/g;
    while ((match = numDateRegex.exec(lowerText)) !== null) {
        foundAnyDate = true;
        const d = parseInt(match[1]); const m = parseInt(match[2]);
        if (d === now.getDate() && m === (now.getMonth() + 1)) foundToday = true;
    }
    if (foundToday) return 'TODAY';
    if (foundAnyDate) return 'OLD';
    return 'UNKNOWN';
};

const extractUTR = (text) => {
    const cleanText = text.replace(/O/g, '0').replace(/l/g, '1');
    const patterns = [
        /\b(T\d{11})\b/i,
        /UTR[:\s#]*([A-Z0-9]{10,22})/i,
        /Transaction\s*(?:ID|No\.?|Ref\.?)[:\s]*([A-Z0-9]{8,22})/i,
        /UPI\s*(?:Ref(?:\.?\s*No)?|Txn\.?|ID)[:\s]*([A-Z0-9]{8,22})/i,
        /\b([A-Z]{2,4}\d{9,14})\b/,
        /\b(\d{12})\b/,
        /\b(\d{16})\b/
    ];
    for (const pat of patterns) { const m = cleanText.match(pat); if (m && m[1] && m[1].length >= 8) return m[1].toUpperCase(); }
    return null;
};

const isValidUPI_UTR = (utr) => {
    if (!utr) return true;
    const cleanUtr = utr.replace(/O/gi, '0').replace(/l/gi, '1').replace(/S/gi, '5');
    if (cleanUtr.length === 12 && /^\d+$/.test(cleanUtr)) {
        const currentYearDigit = String(new Date().getFullYear()).slice(-1);
        if (cleanUtr[0] !== currentYearDigit) return false;
    }
    return true;
};

const extractAmount = (rawText) => {
    let text = rawText.replace(/,/g, '').toLowerCase().replace(/o/g, '0').replace(/\b\d{1,2}:\d{2}\s*(?:am|pm)?\b/gi, ' ');
    const validPrices = getValidPrices();
    if (!validPrices.length) return null;
    const symMatch = text.match(/(?:₹|rs\.?|inr)\s*(\d{2,4})/i);
    if (symMatch && validPrices.includes(symMatch[1])) return String(symMatch[1]);
    const looseSymMatch = text.match(/(?:\?|f|z|x|>|<|\|)\s*(\d{2,4})/i);
    if (looseSymMatch && validPrices.includes(looseSymMatch[1])) return String(looseSymMatch[1]);
    const cleanText = text.replace(/\d{6,}/g, ' ');
    const regex = new RegExp(`(?:^|\\s)(${validPrices.join('|')})(?:\\.00)?(?:\\s|$)`, 'i');
    const matches = cleanText.match(regex);
    if (matches && matches[1]) return matches[1];
    return null;
};

const analyzeOCR = (rawText, utr, amount) => {
    const t = rawText.toLowerCase().replace(/[\n\r]/g, ' ');
    const toMag = MAG_UPI_IDS.some(id => t.includes(id));
    const dateStatus = checkDateStatus(t);
    if (dateStatus === 'OLD') return { status: '❌ FAKE/OLD DATE', isAuto: false };
    const isSuccess = /success|succes|paid|pald|completed|complet|approved|received|payment\s*done/i.test(t);
    if (isSuccess && dateStatus === 'TODAY' && !!amount) {
        if (utr && !isValidUPI_UTR(utr)) return { status: '❌ FAKE APP DETECTED (Invalid UTR Year)', isAuto: false };
        if (!toMag) return { status: '🚨 WRONG PAYEE (MAG ESPORTS match nahi hua)', isAuto: false };
        if (!utr) return { status: '⚠️ UTR MISSING (Manual Check)', isAuto: false };
        return { status: '✅ AUTO-VERIFIED', isAuto: true };
    }
    if (isSuccess) return { status: '⚠️ PARTIAL MATCH', isAuto: false };
    return { status: '❌ FAKE/INVALID', isAuto: false };
};

const isInvalidName = (name) => {
    const lower = name.toLowerCase().trim();
    const bad = [
        'ok','done','yes','ha','hmm','ho gaya','hi','hello','bhai','bro','qr','pay',
        'payment','ss','screenshot','mera','slot','book','jaldi','please','plz',
        'team','naam','name','haan','nahi','nope','hm','hn','theek','thik','accha','okay','k'
    ];
    // Also reject if it matches any current lobby name or id
    const lobbyWords = lobbies.flatMap(l => [l.id.toLowerCase(), l.name.toLowerCase()]);
    if (lobbyWords.includes(lower)) return true;
    if (lower.length < 2 || bad.includes(lower) || /^[\d\s\W_]+$/.test(lower) || /^(.)\1{2,}$/.test(lower)) return true;
    return false;
};

// ─────────────────────────────────────────────────────
//  KEYWORD DETECTION — matches lobby name dynamically
// ─────────────────────────────────────────────────────
const detectLobby = (text) => {
    const t = text.toLowerCase();
    // Try to match any active lobby's id or name as a keyword
    const active = getActiveLobbies();
    for (const lobby of active) {
        const id   = lobby.id.toLowerCase();
        const name = lobby.name.toLowerCase();
        // Match exact word or the lobby name/id as a word boundary
        const nameRegex = new RegExp(`\\b${name.replace(/\s+/g, '\\s*')}\\b`);
        const idRegex   = new RegExp(`\\b${id}\\b`);
        if (nameRegex.test(t) || idRegex.test(t)) return lobby.id;
    }
    return null;
};

// ─────────────────────────────────────────────────────
//  WELCOME MESSAGE
// ─────────────────────────────────────────────────────
const getWelcomeMessage = () => {
    const active = getActiveLobbies();
    let msg = `🎮 *${settings.scrimName} — LOBBY REGISTRATION*\n⏰ *Time:* ${settings.lobbyTime}\n━━━━━━━━━━━━━━━━━━━━\n\nKonsi lobby leni hai?\n\n`;
    active.forEach((lobby, idx) => {
        const isFull = !isSlotsAvailable(lobby.id);
        const slots  = getSlotCount(lobby.id);
        msg += `${lobby.emoji} *${lobby.name.toUpperCase()} LOBBY* (${lobby.matches} Matches) — `;
        msg += isFull ? `🛑 *FULL*` : `₹${lobby.price}`;
        msg += ` _(${slots}/${maxSlots})_\n`;
        msg += `   👉 *${idx + 1}* ya *${lobby.name.toLowerCase()}* type karo\n\n`;
    });
    msg += `━━━━━━━━━━━━━━━━━━━━`;
    return msg;
};

// ─────────────────────────────────────────────────────
//  SEND LOBBY INFO
// ─────────────────────────────────────────────────────
const sendLobbyInfo = async (to, lobbyId) => {
    const lobby = lobbyById(lobbyId);
    if (!lobby) return;

    const promoImg = `./promo_${lobby.id}.png`;
    if (fs.existsSync(promoImg)) await safeSend(to, MessageMedia.fromFilePath(promoImg));
    else if (lobby.id === 'live' && fs.existsSync('./mega.png')) await safeSend(to, MessageMedia.fromFilePath('./mega.png'));

    await safeSend(to,
        `${lobby.emoji} *${lobby.name.toUpperCase()} LOBBY*\n` +
        `⏰ *Time:* ${settings.lobbyTime}\n` +
        `⚔️ *Format:* ${lobby.matches} Matches\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `💰 Entry Fee  : *₹${lobby.price}*\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `👇 QR scan karke *₹${lobby.price}* pay karo aur screenshot bhejo.`
    );

    if (fs.existsSync('./qr.png')) {
        await safeSend(to, MessageMedia.fromFilePath('./qr.png'), { caption: `📲 Scan & Pay *₹${lobby.price}* → Screenshot bhejo` });
        setQrReminder(to);
    }
};

const sendAdminMedia = async (mediaPath, caption) => {
    const adminId = client.info.wid.user + '@c.us';
    if (mediaPath && fs.existsSync(mediaPath)) {
        try {
            await client.sendMessage(adminId, MessageMedia.fromFilePath(mediaPath), { caption });
            setTimeout(() => { try { fs.unlinkSync(mediaPath); } catch(e){} }, 5000);
            return;
        } catch (e) { console.error('❌ Admin Image Send Failed:', e.message); }
    }
    try { await client.sendMessage(adminId, `⚠️ [SCREENSHOT NOT FOUND]\n\n${caption}`); } catch(err) {}
};

const processVerification = async (msg, teamName, lobbyId, paymentData) => {
    const { mediaPath, status, utr, amount, imgHash, isAuto } = paymentData;
    const cleanNumber = await getRealNumber(msg);
    const rawId  = msg.from;
    const lobby  = lobbyById(lobbyId);
    const link   = lobby?.link || '';
    const adminDetails = `Team: *${teamName}*\nLobby: *${lobbyId}*\nNumber: +${cleanNumber}\nID: ${rawId}\nUTR: ${utr || 'Not found'}\nAmount: ₹${amount || 'null'}`;

    if (isAuto || status === '✅ AUTO-VERIFIED') {
        if (isDuplicateUTR(utr)) {
            await sendAdminMedia(mediaPath, `⚠️ DUPLICATE UTR BLOCKED!\n${adminDetails}\n\nReply *ok* to force approve or *ban* to deny.`);
            return safeSend(msg.from, "⚠️ Ye payment already register ho chuki hai. Admin check karega.");
        }
        saveRecord(teamName, cleanNumber, lobbyId, utr || 'N/A', amount || 'N/A', imgHash);
        await safeSend(msg.from,
            `✅ *PAYMENT VERIFIED!*\nTeam: *${teamName}*\nLobby: *${lobby?.name || lobbyId}*\n` +
            `━━━━━━━━━━━━━━━━━━━━\n🔗 Group join karo 👇\n${link}`
        );
        await sendAdminMedia(mediaPath, `✅ AUTO-VERIFIED\n${adminDetails}\n\nReply *ban* to revoke.`);
    } else {
        await sendAdminMedia(mediaPath, `🚨 MANUAL CHECK REQUIRED\n${adminDetails}\nStatus: ${status}\n\nReply *ok* to approve or *ban* to deny.`);
        await safeSend(msg.from, `⏳ *Payment manual check pe gaya.*\nAdmin verify karega. Thoda wait karo. 🙏`);
    }
};

const getRealNumber = async (msg) => {
    try { const c = await msg.getContact(); if (c?.number?.length >= 10) return c.number; } catch {}
    return msg.from.split('@')[0];
};

// ─────────────────────────────────────────────────────
//  CLIENT EVENTS
// ─────────────────────────────────────────────────────
client.on('qr',           qr     => { qrcode.generate(qr, { small: true }); });
client.on('ready',        ()     => log('INFO', '✅ BOT READY!'));
client.on('auth_failure', m      => log('ERROR', `Auth failed: ${m}`));
client.on('disconnected', reason => {
    log('WARN', `Disconnected: ${reason}. Reinitializing in 5s...`);
    setTimeout(() => client.initialize(), 5000);
});

// ─────────────────────────────────────────────────────
//  MESSAGE HANDLER
// ─────────────────────────────────────────────────────
client.on('message_create', async msg => {
    try {
        const now = Math.floor(Date.now() / 1000);
        if ((now - msg.timestamp) > 60) return;
        if (msg.from.includes('@g.us') || msg.to.includes('@g.us')) return;
        if (msg.isStatus) return;

        const rawText   = msg.body.trim();
        const textLower = rawText.toLowerCase();
        const cmd       = textLower.split(/\s+/)[0];

        const adminId = client.info.wid.user + '@c.us';
        const isAdmin = msg.fromMe || msg.from === adminId || msg.from === client.info.wid._serialized;

        if (msg.fromMe && !rawText.startsWith('.') && !['ok', 'ban'].includes(textLower)) return;

        if (isAdmin) { await handleAdminMessage(msg, rawText, textLower, cmd); return; }

        if (isRateLimited(msg.from)) return;
        if (antiSpam.has(msg.from)) return;
        antiSpam.add(msg.from);
        setTimeout(() => antiSpam.delete(msg.from), 1000);

        enqueue(msg.from, () => handleUserMessage(msg, rawText, textLower));
    } catch (e) {
        log('ERROR', `message_create outer error: ${e.message}`);
    }
});

// ─────────────────────────────────────────────────────
//  ADMIN HANDLER
// ─────────────────────────────────────────────────────
const handleAdminMessage = async (msg, rawText, textLower, cmd) => {
    const replyAdmin = (text) => client.sendMessage(msg.from, text);

    // ── Broadcast ─────────────────────────────────────────
    if (cmd === '.broadcast' || cmd === '.bc') {
        const parts        = rawText.split(/\s+/);
        const targetArg    = parts[1]?.toLowerCase();
        const bcMessage    = parts.slice(2).join(' ');
        if (!targetArg || !bcMessage) return replyAdmin('⚠️ Usage: .bc <lobby_id/all> <Message>');
        const records = readRecords();
        const targets = targetArg === 'all' ? records : records.filter(r => r.lobbyType?.toLowerCase() === targetArg);
        if (!targets.length) return replyAdmin(`⚠️ Koi team "${targetArg}" lobby me register nahi hai.`);
        await replyAdmin(`⏳ Broadcasting to ${targets.length} teams...`);
        let ok = 0;
        for (const team of targets) {
            try {
                await humanDelay(3000, 8000);
                await client.sendMessage(`${team.number.replace('+', '')}@c.us`,
                    `📢 *${settings.scrimName} ANNOUNCEMENT*\nLobby: *${team.lobbyType?.toUpperCase()}*\n━━━━━━━━━━━━━━━━━━━━\n\n${bcMessage}`);
                ok++;
            } catch (e) {}
        }
        return replyAdmin(`✅ Broadcast sent to ${ok}/${targets.length} teams.`);
    }

    // ── Scrim name ─────────────────────────────────────────
    if (cmd === '.setname' || cmd === '.settitle') {
        const newName = rawText.slice(cmd.length).trim();
        if (newName) { settings.scrimName = newName; saveSettings(); return replyAdmin(`✅ Scrim name: *${newName}*`); }
        return replyAdmin('⚠️ Usage: .setname <Name>');
    }

    // ── Lobby time ─────────────────────────────────────────
    if (cmd === '.setlobbytime' || cmd === '.settime') {
        const time = rawText.slice(cmd.length).trim();
        if (time) { settings.lobbyTime = time; saveSettings(); completedUsers.clear(); return replyAdmin(`✅ Lobby time: *${time}*`); }
        return replyAdmin('⚠️ Usage: .setlobbytime 9 PM');
    }

    // ── Price ──────────────────────────────────────────────
    if (cmd === '.setprice') {
        // .setprice mini 25   OR   .setprice mini 20/25
        const parts = rawText.split(/\s+/);
        const id    = parts[1]?.toLowerCase();
        const price = parts.slice(2).join('');
        const lobby = lobbyById(id);
        if (!lobby || !price) return replyAdmin('⚠️ Usage: .setprice <lobby_id> <amount>\nExample: .setprice mini 25\nExample: .setprice mega 35/45');
        lobby.price = price; saveLobbies();
        return replyAdmin(`✅ *${lobby.name}* price set: ₹${price}`);
    }

    // ── Match count ────────────────────────────────────────
    if (cmd === '.setmatches') {
        const parts = rawText.split(/\s+/);
        const id    = parts[1]?.toLowerCase();
        const count = parts[2];
        const lobby = lobbyById(id);
        if (!lobby || !count) return replyAdmin('⚠️ Usage: .setmatches <lobby_id> <count>\nExample: .setmatches mini 4');
        lobby.matches = count; saveLobbies();
        return replyAdmin(`✅ *${lobby.name}* matches set: ${count}`);
    }

    // ── Lobby display name ─────────────────────────────────
    if (cmd === '.setlobbyname') {
        // .setlobbyname mini Friday Special
        const parts   = rawText.split(/\s+/);
        const id      = parts[1]?.toLowerCase();
        const newName = parts.slice(2).join(' ').trim();
        const lobby   = lobbyById(id);
        if (!lobby || !newName) return replyAdmin('⚠️ Usage: .setlobbyname <lobby_id> <New Display Name>\nExample: .setlobbyname mini Friday Special');
        lobby.name = newName; saveLobbies();
        return replyAdmin(`✅ *${id}* display name changed to: *${newName}*`);
    }

    // ── Lobby emoji ────────────────────────────────────────
    if (cmd === '.setlobbyemoji') {
        const parts = rawText.split(/\s+/);
        const id    = parts[1]?.toLowerCase();
        const emoji = parts[2];
        const lobby = lobbyById(id);
        if (!lobby || !emoji) return replyAdmin('⚠️ Usage: .setlobbyemoji <lobby_id> <emoji>\nExample: .setlobbyemoji mini 🔥');
        lobby.emoji = emoji; saveLobbies();
        return replyAdmin(`✅ *${lobby.name}* emoji set: ${emoji}`);
    }

    // ── Group link ─────────────────────────────────────────
    if (cmd === '.setlink') {
        const parts = rawText.split(/\s+/);
        const id    = parts[1]?.toLowerCase();
        const link  = rawText.match(/https?:\/\/[^\s]+/i)?.[0];
        const lobby = lobbyById(id);
        if (!lobby || !link) return replyAdmin('⚠️ Usage: .setlink <lobby_id> <link>\nExample: .setlink mini https://chat.whatsapp.com/xxx');
        lobby.link = link; saveLobbies();
        return replyAdmin(`✅ *${lobby.name}* link updated.`);
    }

    // ── Mode ───────────────────────────────────────────────
    if (cmd === '.setmode' || cmd === '.setmodelive') {
        let val = cmd === '.setmodelive' ? 'minilive' : rawText.split(/\s+/)[1]?.toLowerCase();
        // Valid: 'all', 'both', 'minilive', or any lobby id
        const validIds = lobbies.map(l => l.id);
        const validModes = ['all', 'both', 'minilive', ...validIds];
        if (!validModes.includes(val)) {
            return replyAdmin(
                `⚠️ Valid modes:\n` +
                `.setmode all — sab lobbies\n` +
                `.setmode both — pehli 2 lobbies\n` +
                `.setmode minilive — 1st + 3rd lobby\n` +
                validIds.map(id => `.setmode ${id} — sirf ${id}`).join('\n')
            );
        }
        activeMode = val; saveMode();
        const activeNames = getActiveLobbies().map(l => l.name).join(' + ');
        return replyAdmin(`✅ *Mode: ${val.toUpperCase()}*\nActive: ${activeNames}`);
    }

    // ── Slot full / open ───────────────────────────────────
    if (cmd === '.setfull') {
        const id = rawText.split(/\s+/)[1]?.toLowerCase();
        if (!id || !lobbyById(id)) return replyAdmin(`⚠️ Usage: .setfull <lobby_id>\nLobbies: ${lobbies.map(l => l.id).join(', ')}`);
        if (!settings.closedLobbies.includes(id)) settings.closedLobbies.push(id);
        saveSettings(); return replyAdmin(`🛑 *${lobbyById(id).name} Lobby* marked FULL.`);
    }

    if (cmd === '.setopen') {
        const id = rawText.split(/\s+/)[1]?.toLowerCase();
        if (!id) return replyAdmin(`⚠️ Usage: .setopen <lobby_id>\nLobbies: ${lobbies.map(l => l.id).join(', ')}`);
        settings.closedLobbies = settings.closedLobbies.filter(l => l !== id);
        saveSettings(); return replyAdmin(`✅ *${lobbyById(id)?.name || id} Lobby* is OPEN.`);
    }

    // ── Max slots ──────────────────────────────────────────
    if (cmd === '.setslots') {
        const n = parseInt(rawText.split(/\s+/)[1]);
        if (!isNaN(n) && n > 0) { maxSlots = n; return replyAdmin(`✅ Max slots per lobby: *${n}*`); }
        return replyAdmin('⚠️ Usage: .setslots <number>');
    }

    // ── List ───────────────────────────────────────────────
    if (cmd === '.list') {
        const records = readRecords();
        if (!records.length) return replyAdmin('📋 No registrations yet.');
        let out = `📋 *SLOTLIST*\n\n`;
        for (const lobby of lobbies) {
            const list = records.filter(r => r.lobbyType?.toLowerCase() === lobby.id);
            if (!list.length) continue;
            out += `${lobby.emoji} *${lobby.name.toUpperCase()} (${list.length}/${maxSlots})*\n`;
            list.forEach((r, i) => out += `  ${i+1}. ${r.teamName}\n`);
            out += '\n';
        }
        return replyAdmin(out.trim());
    }

    if (cmd === '.listdetail' || cmd === '.listd') {
        const records = readRecords();
        if (!records.length) return replyAdmin('📋 No registrations yet.');
        let out = `📋 *DETAILED SLOTLIST*\n\n`;
        for (const lobby of lobbies) {
            const list = records.filter(r => r.lobbyType?.toLowerCase() === lobby.id);
            if (!list.length) continue;
            out += `${lobby.emoji} *${lobby.name.toUpperCase()} (${list.length}/${maxSlots})*\n`;
            list.forEach((r, i) => out += `  ${i+1}. ${r.teamName} | ${r.number} | UTR: ${r.utr}\n`);
            out += '\n';
        }
        return replyAdmin(out.trim());
    }

    // ── Stats ──────────────────────────────────────────────
    if (cmd === '.stats') {
        const s = getStats();
        let out = `📊 *BOT STATS*\n━━━━━━━━━━━━━━━\n`;
        out += `Scrim   : ${settings.scrimName}\n`;
        out += `Total   : ${s.total}\n`;
        for (const lobby of lobbies) {
            out += `${lobby.emoji} ${lobby.name.padEnd(8)}: ${s[lobby.id] || 0}/${maxSlots}\n`;
        }
        out += `\nMode    : ${activeMode.toUpperCase()}\n`;
        out += `Closed  : ${settings.closedLobbies.length ? settings.closedLobbies.join(', ') : 'None'}\n`;
        out += `Time    : ${settings.lobbyTime}\n━━━━━━━━━━━━━━━`;
        return replyAdmin(out);
    }

    // ── Clear ──────────────────────────────────────────────
    if (cmd === '.clear') {
        localRecords = [];
        DailyRecord.deleteMany({}).catch(()=>{});
        TempSession.deleteMany({}).catch(()=>{});
        completedUsers.clear(); seenUsers.clear();
        settings.closedLobbies = []; saveSettings();
        Object.keys(userQueues).forEach(k => { userQueues[k] = []; });
        processingSet.clear();
        return replyAdmin('🧹 All registrations + memory cleared.');
    }

    // ── Lobby info (for admin to see current config) ───────
    if (cmd === '.lobbies') {
        let out = `🎮 *LOBBY CONFIG*\n━━━━━━━━━━━━━━━\n\n`;
        lobbies.forEach((l, i) => {
            out += `*${i+1}. ${l.emoji} ${l.name}* (id: ${l.id})\n`;
            out += `   Price   : ₹${l.price}\n`;
            out += `   Matches : ${l.matches}\n`;
            out += `   Status  : ${settings.closedLobbies.includes(l.id) ? '🛑 FULL' : '✅ Open'}\n`;
            out += `   Link    : ${l.link || 'Not set'}\n\n`;
        });
        out += `Mode: *${activeMode.toUpperCase()}*\nTime: *${settings.lobbyTime}*`;
        return replyAdmin(out);
    }

    // ── Prices quick view ──────────────────────────────────
    if (cmd === '.prices') {
        let out = `💰 *CURRENT PRICES*\n━━━━━━━━━━━━━━━\n`;
        lobbies.forEach(l => out += `${l.emoji} ${l.name.padEnd(8)}: ₹${l.price} (${l.matches} matches)\n`);
        out += `━━━━━━━━━━━━━━━\nTime: ${settings.lobbyTime}`;
        return replyAdmin(out);
    }

    // ── Approval (reply to flagged payment) ───────────────
    if (msg.hasQuotedMsg && (textLower === 'ok' || textLower === 'ban')) {
        const body = (await msg.getQuotedMessage()).body || '';
        let targetId = (body.match(/ID:\s*(\S+)/) || [])[1];
        const cleanNumber = (body.match(/Number:\s*\+?(\d+)/) || [])[1] || (targetId ? targetId.split('@')[0] : null);
        if (cleanNumber && (!targetId || targetId.includes('@lid'))) targetId = `${cleanNumber}@c.us`;
        if (targetId) {
            const teamName = (body.match(/Team:\s*\*?([^\n*]+)\*?/) || [])[1]?.trim() || 'Unknown';
            const lobbyId  = (body.match(/Lobby:\s*\*?([^\n*]+)\*?/i) || [])[1]?.trim()?.toLowerCase() || lobbies[0]?.id;
            const lobby    = lobbyById(lobbyId);
            if (textLower === 'ok') {
                saveRecord(teamName, cleanNumber, lobbyId, 'N/A', 'N/A', 'MANUAL_OK');
                await client.sendMessage(targetId, `✅ *VERIFIED BY ADMIN!*\nTeam: *${teamName}*\n🔗 Link: ${lobby?.link || ''}`);
                return replyAdmin(`✅ Approved: ${teamName}`);
            }
            if (textLower === 'ban') {
                if (body.includes('AUTO-VERIFIED')) removeRecord(cleanNumber);
                completedUsers.delete(targetId); seenUsers.delete(targetId);
                await clearSession(targetId);
                await client.sendMessage(targetId, `🚫 *Payment Rejected!*\nSahi screenshot bhejo ya admin se contact karo.`);
                return replyAdmin(`🚫 Rejected: ${teamName}`);
            }
        }
    }
};

// ─────────────────────────────────────────────────────
//  USER HANDLER
// ─────────────────────────────────────────────────────
const handleUserMessage = async (msg, rawText, textLower) => {
    try {
        const active = getActiveLobbies();

        // Build per-lobby price sets
        const lobbyPrices = {};
        active.forEach(l => { lobbyPrices[l.id] = (l.price || '').match(/\d+/g) || []; });
        const allPrices = Object.values(lobbyPrices).flat();
        const textHasNumber = (pricesArr, text) => pricesArr.some(p => new RegExp(`\\b${p}\\b`).test(text));

        const pData = await TempSession.findOne({ phone: msg.from });
        const isWaitingText = pData?.state === 'AWAITING_LOBBY' || pData?.state === 'AWAITING_TEAM_NAME';

        // Detect which lobby user wants
        let wantsLobby = detectLobby(textLower); // returns lobby id or null

        // Numeric shortcuts: 1 = first active, 2 = second, etc.
        for (let i = 0; i < active.length; i++) {
            if (textLower.trim() === String(i + 1)) { wantsLobby = active[i].id; break; }
        }

        // Price-based detection
        if (!wantsLobby) {
            for (const [id, prices] of Object.entries(lobbyPrices)) {
                if (textHasNumber(prices, textLower)) { wantsLobby = id; break; }
            }
        }

        // QR / pay keyword detection
        const asksQR = /\b(qr|scan|pay|upi|kese|kaise|bhejo|number|send|chahiye|chaiye|chyie|chayie|barcode|bar\s*code|scanner|gpay|g\s*pay|paytm|phonepe|phone\s*pe|bhejna|fee|price|amount|entry|kitna|kitne|rupay|rupee|paise|payment|join|kaise\s*karu|kya\s*kare|how|kaise\s*le|lena\s*hai|book\s*karna|register\s*karna|slot\s*chahiye|slot\s*lena|kaise\s*milega)\b/i.test(textLower);

        const isPriceNumber   = textHasNumber(allPrices, textLower);
        const hasDirectIntent = !!wantsLobby || asksQR || isPriceNumber;

        // ── First-time welcome ────────────────────────────
        if (!seenUsers.has(msg.from) && !msg.hasMedia) {
            seenUsers.add(msg.from);
            if (!isWaitingText && !hasDirectIntent) return safeSend(msg.from, getWelcomeMessage());
        }

        // ── State machine ─────────────────────────────────
        if (pData && !msg.hasMedia) {
            if (pData.state === 'AWAITING_LOBBY') {
                if (!wantsLobby) return safeSend(msg.from,
                    `⚠️ Sahi lobby select karo.\n\n` +
                    active.map((l, i) => `*${i+1}* ya *${l.name.toLowerCase()}* — ${l.emoji} ${l.name}`).join('\n')
                );
                await saveSession(msg.from, { lobbyType: wantsLobby, state: 'AWAITING_TEAM_NAME' });
                return safeSend(msg.from, `✅ *${lobbyById(wantsLobby)?.name} Lobby* select ki!\n\nApna *Team Name* bhejo:`);
            }

            if (pData.state === 'AWAITING_TEAM_NAME') {
                if (isInvalidName(rawText)) return safeSend(msg.from,
                    '⚠️ Proper *Team Name* bhejo.\n(Sirf letters use karo, lobby name ya common words mat bhejo)'
                );
                if (isDuplicateTeam(rawText, pData.lobbyType)) return safeSend(msg.from,
                    `⚠️ *${rawText}* pehle se *${pData.lobbyType} Lobby* mein registered hai!\nKoi doosra naam bhejo:`
                );
                if (!isSlotsAvailable(pData.lobbyType)) {
                    await clearSession(msg.from);
                    return safeSend(msg.from, `🛑 *${lobbyById(pData.lobbyType)?.name || pData.lobbyType} lobby full ho gayi hai!*`);
                }
                clearQrReminder(msg.from);
                completedUsers.add(msg.from);
                await processVerification(msg, rawText, pData.lobbyType, pData);
                await clearSession(msg.from);
                return;
            }
        }

        // ── Image / screenshot ────────────────────────────
        if (msg.hasMedia && msg.type === 'image') {
            clearQrReminder(msg.from);
            const media = await msg.downloadMedia();
            if (!media || !media.data) return safeSend(msg.from, "⚠️ Image download fail ho gayi, dobara bhejo.");

            const tempFileName = `./temp_${msg.from.split('@')[0]}.jpg`;
            fs.writeFileSync(tempFileName, media.data, 'base64');
            const imgHash = crypto.createHash('md5').update(media.data).digest('hex');

            if (isDuplicateHash(imgHash)) {
                try { fs.unlinkSync(tempFileName); } catch(e){}
                return safeSend(msg.from, "⚠️ Bhai ye screenshot pehle hi kisi dusri team ne use kar liya hai! 🚫");
            }

            await safeSend(msg.from, '⏳ Screenshot check ho raha hai...');
            try {
                const buffer = Buffer.from(media.data, 'base64');
                const { data: { text, confidence } } = await (await getOCRWorker()).recognize(buffer);

                const utr       = extractUTR(text);
                const amount    = extractAmount(text);
                const resultObj = analyzeOCR(text, utr, amount);

                if (Math.round(confidence) < OCR_MIN_CONF && resultObj.status === '✅ AUTO-VERIFIED') {
                    resultObj.status = '⚠️ LOW IMAGE QUALITY (Manual Check)';
                    resultObj.isAuto = false;
                }

                // Detect lobby from amount
                let detectedLobbyId = null;
                if (amount) {
                    for (const l of active) {
                        const prices = (l.price || '').match(/\d+/g) || [];
                        if (prices.includes(String(amount))) { detectedLobbyId = l.id; break; }
                    }
                }

                if (pData?.state === 'AWAITING_SS' && pData.lobbyType) {
                    if (detectedLobbyId && detectedLobbyId !== pData.lobbyType) {
                        resultObj.status = `🚨 AMOUNT MISMATCH (Paid ₹${amount}, wanted ${pData.lobbyType})`;
                        resultObj.isAuto = false;
                    }
                    detectedLobbyId = pData.lobbyType;
                }

                if (!detectedLobbyId && active.length === 1) detectedLobbyId = active[0].id;

                if (detectedLobbyId) {
                    await saveSession(msg.from, { mediaPath: tempFileName, status: resultObj.status, isAuto: resultObj.isAuto, utr, amount, imgHash, state: 'AWAITING_TEAM_NAME', lobbyType: detectedLobbyId });
                    return safeSend(msg.from,
                        `✅ Screenshot mila! (₹${amount || '?'})\nLobby: *${lobbyById(detectedLobbyId)?.name || detectedLobbyId}*\n\n👉 Apna *Team Name* bhejo:`
                    );
                } else {
                    await saveSession(msg.from, { mediaPath: tempFileName, status: resultObj.status, isAuto: resultObj.isAuto, utr, amount, imgHash, state: 'AWAITING_LOBBY', lobbyType: null });
                    return safeSend(msg.from,
                        `✅ Screenshot mila!\nKaunsi lobby leni hai?\n\n` +
                        active.map((l, i) => `*${i+1}* ya *${l.name.toLowerCase()}* — ${l.emoji} ${l.name}`).join('\n')
                    );
                }
            } catch (e) {
                await resetOCRWorker();
                await saveSession(msg.from, { mediaPath: null, status: '❌ OCR FAILED', state: 'AWAITING_LOBBY' });
                try { fs.unlinkSync(tempFileName); } catch(err){}
                return safeSend(msg.from,
                    `⚠️ Screenshot scan mein error aayi.\nLobby select karo:\n\n` +
                    active.map((l, i) => `*${i+1}* ya *${l.name.toLowerCase()}*`).join('\n')
                );
            }
        }

        // ── Text intent handling ──────────────────────────
        if (!msg.hasMedia && !isWaitingText && rawText.length > 0) {
            if (hasDirectIntent) {
                if (completedUsers.has(msg.from) && !wantsLobby && !asksQR) return;

                await saveSession(msg.from, { state: 'AWAITING_SS', lobbyType: wantsLobby });

                if (wantsLobby) {
                    if (!isSlotsAvailable(wantsLobby)) return safeSend(msg.from,
                        `😔 *${lobbyById(wantsLobby)?.name || wantsLobby} lobby full ho gayi hai!*`
                    );
                    return await sendLobbyInfo(msg.from, wantsLobby);
                } else {
                    // Generic QR request — show all active lobby prices
                    if (fs.existsSync('./qr.png')) {
                        let caption = `👇 *SCAN & PAY*\n⏰ *Lobby Time:* ${settings.lobbyTime}\n\n`;
                        active.forEach(l => {
                            const p = l.price.includes('/') ? '₹' + l.price.replace('/', ' / ₹') : '₹' + l.price;
                            caption += `${l.emoji} *${l.name}:* ${p}\n`;
                        });
                        caption += `\nPay karke screenshot bhejein.`;
                        await safeSend(msg.from, MessageMedia.fromFilePath('./qr.png'), { caption });
                        setQrReminder(msg.from);
                    } else {
                        return safeSend(msg.from, getWelcomeMessage());
                    }
                    return;
                }
            }

            // Welcome triggers
            const welcomeRegex = /\b(hi|hello|hey|hii|helo|hlo|hlw|hy|sup|menu|book|slot|slots|register|tourney|tournament|scrim|\?|help|details|info|join|start|kya\s*hai|kaise|bhai|bro|lena\s*hai|chahiye|registration|lobby\s*kab|time\s*kya|kab\s*hai|aaj\s*scrim|scrim\s*hai|team\s*add|add\s*karo)\b/i;
            if (welcomeRegex.test(textLower) && !completedUsers.has(msg.from)) {
                return safeSend(msg.from, getWelcomeMessage());
            }
        }

    } catch (e) {
        log('ERROR', `handleUserMessage error for ${msg.from}: ${e.message}`);
    }
};

// ─────────────────────────────────────────────────────
//  CRON — daily reset at midnight IST
// ─────────────────────────────────────────────────────
cron.schedule('0 0 * * *', async () => {
    localRecords = [];
    try { await DailyRecord.deleteMany({}); } catch (e) {}
    try { await TempSession.deleteMany({}); } catch (e) {}
    try {
        fs.readdirSync('./').forEach(f => { if (f.startsWith('temp_') && f.endsWith('.jpg')) try { fs.unlinkSync(f); } catch {} });
    } catch(e) {}
    settings.closedLobbies = []; saveSettings();
    seenUsers.clear(); completedUsers.clear();
    Object.keys(userQueues).forEach(k => { userQueues[k] = []; });
    processingSet.clear();
    log('INFO', '🧹 Daily reset completed.');
}, { timezone: 'Asia/Kolkata' });

client.initialize();
