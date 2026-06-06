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
        // ── Activity gate ────────────────────────────────
        // Before processing each queued message, check if the user
        // is still within the active window. If they went idle between
        // queueing and processing, silently discard the reply.
        // This prevents the bot from DMing people who messaged long ago
        // and are no longer waiting — a key anti-spam signal for WA.
        if (!isUserActive(userId)) {
            log('INFO', `Skipped reply to ${userId} — user no longer active (window: ${ACTIVE_WINDOW/1000}s)`);
            userQueues[userId] = [];  // flush remaining queue for this idle user
            break;
        }
        const fn = userQueues[userId].shift();
        try { await fn(); } catch (e) { log('ERROR', `Queue error for ${userId}: ${e.message}`); }
        await humanDelay(1000, 3000);
    }
    processingSet.delete(userId);
};

// ─────────────────────────────────────────────────────
//  MONGODB SETUP
// ─────────────────────────────────────────────────────
const MONGO_URI = 'mongodb://tinyji6887_db_user:magbot123@ac-mnwngek-shard-00-00.zu7kwc5.mongodb.net:27017,ac-mnwngek-shard-00-01.zu7kwc5.mongodb.net:27017,ac-mnwngek-shard-00-02.zu7kwc5.mongodb.net:27017/Magbotpaid?ssl=true&replicaSet=atlas-v4niu4-shard-0&authSource=admin&retryWrites=true&w=majority';

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
    puppeteer: { 
        headless: true,
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process',
            '--disable-gpu'
        ]
    },
    // Ye line WhatsApp ko bolegi ki bot kisi server se nahi, balki ek normal Windows PC se chal raha hai
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
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

// ── Activity Tracker ─────────────────────────────────
// Tracks the last time each user sent a message (Unix ms).
// Bot will only DM/reply users who have been active within
// the configured ACTIVE_WINDOW. Users who messaged long ago
// and are now idle won't get spammed — protecting both the
// user experience and the account from spam-filter triggers.
const lastActiveMap = {};                  // { userId: timestamp_ms }
let   ACTIVE_WINDOW = 30 * 1000;          // default: 30 seconds (configurable via .setwindow)

const touchActive  = (userId) => { lastActiveMap[userId] = Date.now(); };
const isUserActive = (userId) => {
    const last = lastActiveMap[userId];
    return last && (Date.now() - last) <= ACTIVE_WINDOW;
};

// ─────────────────────────────────────────────────────
//  SETTINGS  (now includes custom lobby + solo/duo)
// ─────────────────────────────────────────────────────
let activeMode = safeRead('./mode.json', { mode: 'both' }).mode;
const saveMode = () => safeWrite('./mode.json', { mode: activeMode });

let links = safeRead('./links.json', {
    mini:        'https://chat.whatsapp.com/xxx',
    mega:        'https://chat.whatsapp.com/yyy',
    live:        'https://chat.whatsapp.com/zzz',
    medium:      'https://chat.whatsapp.com/mmm',
    competitive: 'https://chat.whatsapp.com/ccc',
    custom:      'https://chat.whatsapp.com/aaa',
    solo:        'https://chat.whatsapp.com/bbb',
    duo:         'https://chat.whatsapp.com/ddd'
});
const saveLinks = () => safeWrite('./links.json', links);

let settings = safeRead('./settings.json', {
    scrimName:         'MAG ESPORTS',
    miniPrice:         '20/25',
    megaPrice:         '35/45',
    livePrice:         '55',
    mediumPrice:       '30/35',
    competitivePrice:  '50/60',
    customPrice:       '30',
    soloPrice:         '15',
    duoPrice:          '20',
    lobbyTime:         '9 PM',
    miniMatches:       '4',
    megaMatches:       '6',
    liveMatches:       '6',
    mediumMatches:     '5',
    competitiveMatches:'8',
    customMatches:     '5',
    closedLobbies:     []
});
if (!settings.closedLobbies)        settings.closedLobbies        = [];
if (!settings.miniMatches)          settings.miniMatches          = '4';
if (!settings.megaMatches)          settings.megaMatches          = '6';
if (!settings.liveMatches)          settings.liveMatches          = '6';
if (!settings.mediumMatches)        settings.mediumMatches        = '5';
if (!settings.competitiveMatches)   settings.competitiveMatches   = '8';
if (!settings.customMatches)        settings.customMatches        = '5';
if (!settings.customPrice)          settings.customPrice          = '30';
if (!settings.soloPrice)            settings.soloPrice            = '15';
if (!settings.duoPrice)             settings.duoPrice             = '20';
if (!settings.mediumPrice)          settings.mediumPrice          = '30/35';
if (!settings.competitivePrice)     settings.competitivePrice     = '50/60';
const saveSettings = () => safeWrite('./settings.json', settings);

// All valid lobby type names (canonical capitalised form)
const ALL_LOBBY_TYPES = ['Mini', 'Mega', 'Live', 'Medium', 'Competitive', 'Custom', 'Solo', 'Duo'];

// Which lobby types are included in each mode
const MODE_LOBBIES = {
    mini:             ['Mini'],
    mega:             ['Mega'],
    live:             ['Live'],
    medium:           ['Medium'],
    competitive:      ['Competitive'],
    both:             ['Mini', 'Mega'],
    all:              ['Mini', 'Mega', 'Live', 'Medium', 'Competitive'],
    minilive:         ['Mini', 'Live'],
    minimedium:       ['Mini', 'Medium'],
    megacomp:         ['Mega', 'Competitive'],
    minimediumcomp:   ['Mini', 'Medium', 'Competitive'],
    minimediumlive:   ['Mini', 'Medium', 'Live'],
    megamediumcomp:   ['Mega', 'Medium', 'Competitive'],
    custom:           ['Custom'],
    solo:             ['Solo'],
    duo:              ['Duo'],
    solodup:          ['Solo', 'Duo'],
    full:             ['Mini', 'Mega', 'Live', 'Medium', 'Competitive', 'Custom', 'Solo', 'Duo']
};

const lobbyInMode = (type) => (MODE_LOBBIES[activeMode] || []).map(t => t.toLowerCase()).includes(type.toLowerCase());

const MAG_UPI_IDS = ['8823827920@okbizaxis', '8823827920', 'mag esports', 'magesports', 'mag_esports',
                     'mac esports', 'maq esports', '882382792o', 'chetan bhul', 'chetan'];
const OCR_MIN_CONF = 30;

// ─────────────────────────────────────────────────────
//  LOBBY META HELPER — single source of truth
// ─────────────────────────────────────────────────────
const getLobbyMeta = (type) => {
    const t = type?.toLowerCase();
    const map = {
        mini:        { price: settings.miniPrice,        matches: settings.miniMatches,        emoji: '🟡', color: 'MINI'        },
        mega:        { price: settings.megaPrice,        matches: settings.megaMatches,        emoji: '🔵', color: 'MEGA'        },
        live:        { price: settings.livePrice,        matches: settings.liveMatches,        emoji: '🔴', color: 'LIVE'        },
        medium:      { price: settings.mediumPrice,      matches: settings.mediumMatches,      emoji: '🟠', color: 'MEDIUM'      },
        competitive: { price: settings.competitivePrice, matches: settings.competitiveMatches, emoji: '🏆', color: 'COMPETITIVE' },
        custom:      { price: settings.customPrice,      matches: settings.customMatches,      emoji: '🟣', color: 'CUSTOM'      },
        solo:        { price: settings.soloPrice,        matches: '4',                         emoji: '⚪', color: 'SOLO'        },
        duo:         { price: settings.duoPrice,         matches: '4',                         emoji: '🟤', color: 'DUO'        },
    };
    return map[t] || map['mini'];
};

const getValidPrices = () => {
    const allPrices = [
        settings.miniPrice, settings.megaPrice, settings.livePrice,
        settings.mediumPrice, settings.competitivePrice,
        settings.customPrice, settings.soloPrice, settings.duoPrice
    ].join(' ');
    return allPrices.match(/\d+/g) || [];
};

const saveSession  = async (phone, data) => { data.createdAt = new Date(); await TempSession.findOneAndUpdate({ phone }, data, { upsert: true }); };
const clearSession = async (phone) => { await TempSession.deleteOne({ phone }); };

const setQrReminder = (userId) => {
    if (qrReminders[userId]) clearTimeout(qrReminders[userId]);
    qrReminders[userId] = setTimeout(async () => {
        const pData = await TempSession.findOne({ phone: userId });
        if (!pData || pData.state === 'AWAITING_TEAM_NAME') { delete qrReminders[userId]; return; }
        try {
            await safeSend(userId, `🚨 *SLOT ABHI SAFE NAHI HAI!* 🚨\n\nBhai tumne lobby select ki thi par payment screenshot abhi tak nahi aayi!\n\n🔥 *Slots bhar rahe hain — waiting list teams ready hain!*\n\n⏳ Abhi pay karo aur screenshot bhejo — warna tumhara slot automatically cancel ho jayega!\n\n_Last chance bhai — jaldi karo!_ ⚡`);
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
const getSlotCount     = (type) => readRecords().filter(r => r.lobbyType?.toLowerCase() === type?.toLowerCase()).length;
const isSlotsAvailable = (type) => {
    if (settings.closedLobbies.includes(type.toLowerCase())) return false;
    return getSlotCount(type) < maxSlots;
};

const saveRecord = (teamName, number, lobbyType, utr = 'N/A', amount = 'N/A', imgHash = 'N/A') => {
    const istTimestamp = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

    // Normalize to clean 10-digit Indian number → store as +91XXXXXXXXXX
    let clean = String(number).replace(/\D/g, '');
    if (clean.length === 12 && clean.startsWith('91')) clean = clean.slice(2);
    if (clean.length > 10) clean = clean.slice(-10);
    const finalNumber = clean.length === 10 ? `+91${clean}` : `+${clean}`;

    const doc = { teamName, number: finalNumber, lobbyType, utr, amount, imgHash, timestamp: istTimestamp };
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
const isDuplicateTeam = (teamName, lobbyType) => readRecords().some(r =>
    r.lobbyType?.toLowerCase() === lobbyType.toLowerCase() &&
    r.teamName.toLowerCase().trim() === teamName.toLowerCase().trim()
);

const getStats = () => {
    const records = readRecords();
    const out = { total: records.length };
    ALL_LOBBY_TYPES.forEach(t => { out[t.toLowerCase()] = records.filter(r => r.lobbyType?.toLowerCase() === t.toLowerCase()).length; });
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
    if (validPrices.length === 0) return null;
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
    const bad = ['ok','done','yes','ha','hmm','ho gaya','hi','hello','bhai','bro','qr','pay',
                 'payment','ss','screenshot','mera','slot','book','jaldi','please','plz',
                 'team','naam','name','mini','mega','live','custom','solo','duo'];
    if (lower.length < 2 || bad.includes(lower) || /^[\d\s\W_]+$/.test(lower) || /^(.)\1{2,}$/.test(lower)) return true;
    return false;
};

// ─────────────────────────────────────────────────────
//  WELCOME MESSAGE — dynamic based on active mode
// ─────────────────────────────────────────────────────
// Returns a FOMO urgency label based on remaining slots (exact count hidden)
const getFomoLabel = (lobbyName) => {
    const filled  = getSlotCount(lobbyName);
    const remaining = maxSlots - filled;
    const pct = filled / maxSlots;

    if (!isSlotsAvailable(lobbyName))  return `🛑 *FULL* — Slot nahi bache!`;
    if (remaining <= 2)                return `🔥 *ALMOST FULL* — Sirf ${remaining} slot bacha hai! Jaldi karo!`;
    if (remaining <= 5)                return `⚡ *FILLING FAST* — Bahut kam slots bache hain!`;
    if (pct >= 0.7)                    return `🚨 *LIMITED SLOTS* — Slots tezi se bhar rahe hain!`;
    if (pct >= 0.4)                    return `⚠️ *SLOTS FILLING* — Abhi book karo!`;
    return `✅ *AVAILABLE* — Slot lo abhi!`;
};

const getWelcomeMessage = () => {
    const activeLobbies = MODE_LOBBIES[activeMode] || [];
    let msg = `🎮 *${settings.scrimName} — LOBBY REGISTRATION*\n`;
    msg += `⏰ *Time:* ${settings.lobbyTime}\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━\n\n`;
    msg += `⚡ *Slots tezi se bhar rahe hain! Jaldi karo!* ⚡\n\n`;

    for (const lobbyName of activeLobbies) {
        const meta  = getLobbyMeta(lobbyName);
        const isFull = !isSlotsAvailable(lobbyName);
        msg += `${meta.emoji} *${lobbyName.toUpperCase()} LOBBY* (${meta.matches} Matches)\n`;
        msg += `   💰 Entry: *₹${meta.price}*\n`;
        msg += `   ${getFomoLabel(lobbyName)}\n\n`;
    }

    msg += `━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `👉 `;
    if (activeLobbies.length > 1) {
        msg += `*${activeLobbies.join('*, *')}* — koi ek type karo.`;
    } else if (activeLobbies.length === 1) {
        msg += `*${activeLobbies[0]}* likh kar bhejo.`;
    }
    msg += `\n⚠️ _Slot guaranteed nahi hoga jab tak payment nahi hoti!_`;
    msg += `\n━━━━━━━━━━━━━━━━━━━━`;
    return msg;
};

// ─────────────────────────────────────────────────────
//  SEND LOBBY INFO  — works for any lobby type
// ─────────────────────────────────────────────────────
const sendLobbyInfo = async (to, lobbyType) => {
    const meta      = getLobbyMeta(lobbyType);
    const filled    = getSlotCount(lobbyType);
    const remaining = maxSlots - filled;
    const fomoLine  = getFomoLabel(lobbyType);

    // Send promo image if exists
    const promoImages = [`./promo_${lobbyType.toLowerCase()}.png`, './mega.png'];
    if (['live','custom'].includes(lobbyType.toLowerCase())) {
        for (const img of promoImages) {
            if (fs.existsSync(img)) { await safeSend(to, MessageMedia.fromFilePath(img)); break; }
        }
    }

    await safeSend(to,
        `${meta.emoji} *${lobbyType.toUpperCase()} LOBBY*\n` +
        `⏰ *Time:* ${settings.lobbyTime}\n` +
        `⚔️ *Format:* ${meta.matches} Matches\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `💰 Entry Fee : *₹${meta.price}*\n` +
        `🎯 Status    : ${fomoLine}\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `👇 *Abhi pay karo warna slot kisi aur ko mil jayega!*\nQR scan karke *₹${meta.price}* bhejo aur screenshot attach karo.`
    );

    if (fs.existsSync('./qr.png')) {
        await safeSend(to, MessageMedia.fromFilePath('./qr.png'), {
            caption: `📲 *Scan & Pay ₹${meta.price}*\n⚠️ _Payment ke baad hi slot confirm hoga!_\n\nPay karo → Screenshot bhejo → Done! ✅`
        });
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

const processVerification = async (msg, teamName, lobbyType, paymentData) => {
    const { mediaPath, status, utr, amount, imgHash, isAuto } = paymentData;
    const cleanNumber = await getRealNumber(msg);
    const rawId = msg.from;
    const link  = links[lobbyType.toLowerCase()] || links.mini;
    const adminDetails = `Team: *${teamName}*\nLobby: *${lobbyType}*\nNumber: +${cleanNumber}\nID: ${rawId}\nUTR: ${utr || 'Not found'}\nAmount: ₹${amount || 'null'}`;

    if (isAuto || status === '✅ AUTO-VERIFIED') {
        if (isDuplicateUTR(utr)) {
            await sendAdminMedia(mediaPath, `⚠️ DUPLICATE UTR BLOCKED!\n${adminDetails}\n\nReply *ok* to force approve or *ban* to deny.`);
            return safeSend(msg.from, "⚠️ Ye payment already register ho chuki hai. Admin check karega.");
        }
        saveRecord(teamName, cleanNumber, lobbyType, utr || 'N/A', amount || 'N/A', imgHash);
        await safeSend(msg.from, `✅ *PAYMENT VERIFIED!*\nTeam: *${teamName}*\nLobby: *${lobbyType}*\n━━━━━━━━━━━━━━━━━━━━\n🔗 Group join karo 👇\n${link}`);
        await sendAdminMedia(mediaPath, `✅ AUTO-VERIFIED\n${adminDetails}\n\nReply *ban* to revoke.`);
    } else {
        await sendAdminMedia(mediaPath, `🚨 MANUAL CHECK REQUIRED\n${adminDetails}\nStatus: ${status}\n\nReply *ok* to approve or *ban* to deny.`);
        await safeSend(msg.from, `⏳ *Payment manual check pe gaya.*\nAdmin verify karega. Thoda wait karo. 🙏`);
    }
};

const getRealNumber = async (msg) => {
    // Tier 1: contact.number (most reliable)
    try {
        const contact = await msg.getContact();
        if (contact?.number) {
            let num = String(contact.number).replace(/\D/g, '');
            if (num.startsWith('91') && num.length === 12) num = num.slice(2);
            if (num.length === 10 && /^[6-9]/.test(num)) return num;
        }
    } catch (e) {}
    // Tier 2: pushname se nahi, _data.notifyName ignore karo
    // contact.id._serialized try karo
    try {
        const contact = await msg.getContact();
        const serial = contact?.id?._serialized || '';
        if (serial.includes('@c.us')) {
            let num = serial.split('@')[0].replace(/\D/g, '');
            if (num.startsWith('91') && num.length === 12) num = num.slice(2);
            if (num.length === 10 && /^[6-9]/.test(num)) return num;
        }
    } catch (e) {}
    // Tier 3: msg.from (agar @c.us format hai)
    try {
        if (msg.from?.includes('@c.us')) {
            let num = msg.from.split('@')[0].replace(/\D/g, '');
            if (num.startsWith('91') && num.length === 12) num = num.slice(2);
            if (num.length === 10 && /^[6-9]/.test(num)) return num;
        }
    } catch (e) {}
    // Tier 4: _data fields
    try {
        const rawNum = msg._data?.author || msg._data?.from || '';
        if (rawNum.includes('@c.us')) {
            let num = rawNum.split('@')[0].replace(/\D/g, '');
            if (num.startsWith('91') && num.length === 12) num = num.slice(2);
            num = num.slice(-10);
            if (num.length === 10 && /^[6-9]/.test(num)) return num;
        }
    } catch (e) {}
    // Fallback: jo bhi mile
    log('WARN', `Real number extract nahi hua: ${msg.from}`);
    return msg.from.split('@')[0].replace(/\D/g, '').slice(-10);
};

// ─────────────────────────────────────────────────────
//  KEYWORD DETECTION — expanded Hindi + English + Hinglish
// ─────────────────────────────────────────────────────
const detectLobby = (text) => {
    const t = text.toLowerCase();

    // Mini keywords
    if (/\bmini\b|chota|chhota|cheap|sasta|m1\b|4\s*match/.test(t)) return 'Mini';

    // Mega keywords
    if (/\bmega\b|bada|m2\b|6\s*match/.test(t)) return 'Mega';

    // Live keywords
    if (/\blive\b|stream|streaming|on\s*air/.test(t)) return 'Live';

    // Medium keywords
    if (/\bmedium\b|mid\b|beech\b|madhyam|m3\b|5\s*match/.test(t)) return 'Medium';

    // Competitive keywords
    if (/\bcompetitive\b|comp\b|pro\b|ranked\b|serious\b|8\s*match|tourney\s*mode/.test(t)) return 'Competitive';

    // Custom keywords
    if (/\bcustom\b|customise|customize|special|khas|alag/.test(t)) return 'Custom';

    // Solo keywords
    if (/\bsolo\b|single|akela|alone|1v1|ek\s*banda/.test(t)) return 'Solo';

    // Duo keywords
    if (/\bduo\b|double|dono|pair|2\s*banda|2v2/.test(t)) return 'Duo';

    return null;
};

// ─────────────────────────────────────────────────────
//  WHATSAPP NATIVE PAY HANDLER
//  Security layers:
//  1. msg.type === 'payment'         — real WA payment object only
//  2. payData present                — actual payload must exist
//  3. status === completed/success   — only settled payments
//  4. !msg.fromMe                    — must be incoming, not outgoing
//  5. receiverWaId === bot number    — anti-spoofing check
//  6. currency === INR               — only Indian Rupee accepted
//  7. amount > 0 and parseable       — valid non-zero amount
//  8. duplicate txnId blocked        — same payment can't register twice
// ─────────────────────────────────────────────────────

const handleWhatsAppPay = async (msg) => {
    try {
        if (msg.type !== 'payment') return false;

        // ── Try all known payload locations ─────────────────────────
        const payData =
            msg._data?.paymentInfo         ||
            msg.rawData?.paymentInfo       ||
            msg._data?.payment             ||
            msg.rawData?.payment           ||
            msg._data?.message?.paymentMessage ||
            msg.rawData?.message?.paymentMessage ||
            null;

        const adminId   = client.info.wid.user + '@c.us';
        const botNumber = client.info.wid.user;

        // ── LAYER 2: Payload must exist ───────────────────────────────
        if (!payData) {
            log('WARN', `WA Pay: paymentInfo missing — ID: ${msg.id?.id}, from: ${msg.from}`);
            log('DEBUG', `WA Pay raw _data keys: ${Object.keys(msg._data || {}).join(', ')}`);
            await client.sendMessage(adminId,
                `⚠️ *WA PAY — DATA MISSING*\nFrom: ${msg.from}\nMsg ID: ${msg.id?.id || 'N/A'}\n\nPayload nahi mila. Manual check karo.`
            );
            await safeSend(msg.from, `✅ Payment signal mila! Admin manually verify karega.\nThoda wait karo. 🙏`);
            return true;
        }

        log('INFO', `WA Pay payData keys: ${Object.keys(payData).join(', ')}`);

        // ── LAYER 3: Status must be successful ───────────────────────
        const rawStatus = String(payData.status || payData.paymentStatus || '').toLowerCase().trim();
        const isSuccessful = [
            'completed', 'successful', 'payment_complete',
            'transferred', 'success', 'done', 'settled'
        ].includes(rawStatus);

        if (!isSuccessful) {
            log('INFO', `WA Pay: Rejected — status='${rawStatus}' from ${msg.from}`);
            await safeSend(msg.from,
                `⚠️ *Payment Status: ${payData.status || rawStatus || 'Unknown'}*\n\n` +
                `Sirf *COMPLETED/SUCCESSFUL* payment accept hoti hai.\n` +
                `Agar payment fail ya pending hai, dobara try karo ya admin se contact karo.`
            );
            return true;
        }

        // ── LAYER 4: Must be incoming (not bot's own outgoing payment) ─
        if (msg.fromMe) {
            log('INFO', `WA Pay: Ignored — outgoing payment sent by bot.`);
            return true;
        }

        // ── LAYER 5: Receiver must be this bot ──────────────────────
        const receiverRaw = String(payData.receiverWaId || payData.receiver || payData.to || '');
        if (receiverRaw && !receiverRaw.includes(botNumber)) {
            log('WARN', `WA Pay: Receiver mismatch — got '${receiverRaw}', expected '${botNumber}'`);
            await client.sendMessage(adminId,
                `🚨 *WA PAY SECURITY ALERT*\n` +
                `Receiver mismatch — possible spoofing!\n` +
                `From: ${msg.from}\n` +
                `Payload receiver: ${receiverRaw}\n` +
                `Bot number: ${botNumber}\n\n` +
                `Do NOT approve without manual UPI verification.`
            );
            return true;
        }

        // ── LAYER 6: Currency must be INR ────────────────────────────
        const currency = String(payData.currency || payData.currencyCode || 'INR').toUpperCase().trim();
        if (currency && currency !== 'INR') {
            log('WARN', `WA Pay: Non-INR currency — '${currency}' from ${msg.from}`);
            await client.sendMessage(adminId,
                `⚠️ *WA PAY — WRONG CURRENCY*\nFrom: ${msg.from}\nCurrency: ${currency}\n\nSirf INR accept hai.`
            );
            await safeSend(msg.from,
                `⚠️ Payment currency *${currency}* accept nahi hoti.\nSirf *Indian Rupee (INR)* chalega.`
            );
            return true;
        }

        // ── LAYER 7: Extract & normalise amount ──────────────────────
        // WA Pay exposes amount in different formats across versions:
        //   • Paise (integer): 2500 = ₹25
        //   • Rupees (float):  25.00 = ₹25
        //   • String:         "25" or "2500"
        // Heuristic: if raw > (max valid price × 10) → treat as paise
        let paidAmount = null;
        const rawAmount = payData.amount ?? payData.totalAmount ?? payData.value ?? null;

        if (rawAmount != null) {
            const raw = parseFloat(String(rawAmount).replace(/,/g, ''));
            if (!isNaN(raw) && raw > 0) {
                const validNums   = getValidPrices().map(Number);
                const maxPrice    = Math.max(...validNums);
                // If raw is more than 10× the highest valid price → likely paise
                paidAmount = raw > maxPrice * 10 ? Math.round(raw / 100) : Math.round(raw);
            }
        }

        if (paidAmount === null || paidAmount <= 0) {
            log('WARN', `WA Pay: Could not parse amount — rawAmount=${rawAmount}, from: ${msg.from}`);
            const cleanNum = await getRealNumber(msg);
            await client.sendMessage(adminId,
                `🚨 *WA PAY — AMOUNT UNREADABLE*\n` +
                `From: +91${cleanNum} | ID: ${msg.from}\n` +
                `Raw amount field: ${rawAmount ?? 'N/A'}\n` +
                `Status: ${rawStatus}\n` +
                `payData: ${JSON.stringify(payData).slice(0, 400)}\n\n` +
                `Manual verification required. Reply *ok* to approve or *ban* to deny.`
            );
            await safeSend(msg.from, `✅ Payment mila! Amount verify nahi hua. Admin check karega.\nThoda wait karo. 🙏`);
            return true;
        }

        // ── LAYER 8: Duplicate transaction ID check ───────────────────
        const txnId =
            payData.transactionId  ||
            payData.txnId          ||
            payData.referenceId    ||
            payData.id             ||
            msg.id?.id             ||
            null;

        if (txnId && isDuplicateUTR(txnId)) {
            log('WARN', `WA Pay: Duplicate txnId blocked — ${txnId} from ${msg.from}`);
            await safeSend(msg.from, `⚠️ Ye payment already registered hai. Admin se contact karo.`);
            return true;
        }

        // ── Match amount to active lobby prices ───────────────────────
        const validPrices   = getValidPrices();
        const amountStr     = String(paidAmount);
        const amountMatches = validPrices.includes(amountStr);

        const activeLobbies  = MODE_LOBBIES[activeMode] || [];
        const extractNumbers = (str) => (String(str).match(/\d+/g) || []);
        const priceDetect = [
            { prices: extractNumbers(settings.miniPrice),        lobby: 'Mini'        },
            { prices: extractNumbers(settings.megaPrice),        lobby: 'Mega'        },
            { prices: extractNumbers(settings.livePrice),        lobby: 'Live'        },
            { prices: extractNumbers(settings.mediumPrice),      lobby: 'Medium'      },
            { prices: extractNumbers(settings.competitivePrice), lobby: 'Competitive' },
            { prices: extractNumbers(settings.customPrice),      lobby: 'Custom'      },
            { prices: extractNumbers(settings.soloPrice),        lobby: 'Solo'        },
            { prices: extractNumbers(settings.duoPrice),         lobby: 'Duo'         },
        ];

        const matchedLobbies = [];
        if (amountMatches) {
            for (const pd of priceDetect) {
                if (
                    pd.prices.includes(amountStr) &&
                    activeLobbies.map(l => l.toLowerCase()).includes(pd.lobby.toLowerCase())
                ) {
                    matchedLobbies.push(pd.lobby);
                }
            }
        }

        let detectedLobby = null;
        let isAmbiguous   = false;
        if (matchedLobbies.length === 1)      detectedLobby = matchedLobbies[0];
        else if (matchedLobbies.length > 1)   isAmbiguous   = true;

        const cleanNumber = await getRealNumber(msg);
        log('INFO', `WA Pay OK — From: +91${cleanNumber}, ₹${paidAmount}, TxnID: ${txnId || 'N/A'}, Status: ${rawStatus}, Matched: [${matchedLobbies.join(',')}]`);

        // ── CASE A: Amount ambiguous — 2+ lobbies match ───────────────
        if (isAmbiguous) {
            touchActive(msg.from);
            clearQrReminder(msg.from);
            await saveSession(msg.from, {
                mediaPath: null,
                status:    '✅ WA-PAY VERIFIED',
                isAuto:    true,
                utr:       txnId || 'WA_PAY',
                amount:    amountStr,
                imgHash:   `WAPAY_${txnId || Date.now()}`,
                state:     'AWAITING_LOBBY',
                lobbyType: null
            });
            let choiceMsg  = `✅ *WhatsApp Pay Received!* ₹${paidAmount}\n`;
            choiceMsg += `🔒 Payment verified!\n━━━━━━━━━━━━━━━━━━━━\n`;
            choiceMsg += `⚠️ Tera amount *${matchedLobbies.length} lobbies* ke price se match karta hai.\n\n`;
            choiceMsg += `Konsi lobby leni hai? Type karo:\n\n`;
            matchedLobbies.forEach((l, i) => {
                const meta = getLobbyMeta(l);
                choiceMsg += `${meta.emoji} *${i + 1}. ${l.toUpperCase()}* — ${meta.matches} Matches @ ₹${meta.price}\n`;
            });
            choiceMsg += `\n👉 Lobby ka naam type karo (e.g. *${matchedLobbies[0]}*)`;
            await safeSend(msg.from, choiceMsg);
            return true;
        }

        // ── CASE B: Exactly one lobby matched — auto-proceed ─────────
        if (amountMatches && detectedLobby) {
            touchActive(msg.from);
            clearQrReminder(msg.from);
            await saveSession(msg.from, {
                mediaPath: null,
                status:    '✅ WA-PAY VERIFIED',
                isAuto:    true,
                utr:       txnId || 'WA_PAY',
                amount:    amountStr,
                imgHash:   `WAPAY_${txnId || Date.now()}`,
                state:     'AWAITING_TEAM_NAME',
                lobbyType: detectedLobby
            });
            await safeSend(msg.from,
                `✅ *WhatsApp Pay Received!*\n` +
                `💰 Amount : *₹${paidAmount}*\n` +
                `🎮 Lobby  : *${detectedLobby}*\n` +
                `🔒 Status : *Verified* ✅\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `👉 Ab apna *Team Name* bhejo aur registration complete karo:`
            );
            await client.sendMessage(adminId,
                `✅ *WA PAY AUTO-VERIFIED*\n` +
                `From: +91${cleanNumber} | ${msg.from}\n` +
                `Amount: ₹${paidAmount} | Lobby: ${detectedLobby}\n` +
                `TxnID: ${txnId || 'N/A'}\n\n` +
                `Reply *ban* to revoke if needed.`
            );
            return true;
        }

        // ── CASE C: Amount doesn't match any lobby price ──────────────
        if (paidAmount !== null && !amountMatches) {
            await client.sendMessage(adminId,
                `🚨 *WA PAY — AMOUNT MISMATCH*\n` +
                `From: +91${cleanNumber} | ${msg.from}\n` +
                `Paid: ₹${paidAmount}\n` +
                `Valid prices: ₹${validPrices.join(', ₹')}\n` +
                `TxnID: ${txnId || 'N/A'}\n\n` +
                `Reply *ok* to manually approve or *ban* to deny.`
            );
            await safeSend(msg.from,
                `⚠️ *Payment Mila! ₹${paidAmount}*\n\n` +
                `Ye amount kisi bhi lobby ke price se match nahi karta.\n\n` +
                `Valid prices:\n` +
                activeLobbies.map(l => { const m = getLobbyMeta(l); return `${m.emoji} ${l}: ₹${m.price}`; }).join('\n') +
                `\n\nAdmin check karega. Wait karo. 🙏`
            );
            return true;
        }

        return true;

    } catch (e) {
        log('ERROR', `handleWhatsAppPay error: ${e.message}\n${e.stack}`);
        try {
            const adminId = client.info.wid.user + '@c.us';
            await client.sendMessage(adminId,
                `🔴 *WA PAY HANDLER CRASH*\nFrom: ${msg.from}\nError: ${e.message}\n\nManual check karo.`
            );
        } catch (_) {}
        return false;
    }
};


client.on('qr',          qr     => { qrcode.generate(qr, { small: true }); });
client.on('ready',       ()     => log('INFO', '✅ BOT READY! EXPANDED KEYWORDS + ANTI-BAN LOADED.'));
client.on('auth_failure', m     => log('ERROR', `Auth failed: ${m}`));
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

        // ── WHATSAPP NATIVE PAY INTERCEPTION ────────────
        // Checked FIRST, before any text/media logic.
        // handleWhatsAppPay returns true if msg was a payment object
        // (pass or fail) — in that case we stop here and never fall
        // through to the OCR / text handler below.
        // Only real msg.type === 'payment' objects pass this gate.
        if (msg.type === 'payment') {
            await handleWhatsAppPay(msg);
            return; // fully handled — do NOT continue to text/image logic
        }

        const rawText   = msg.body.trim();
        const textLower = rawText.toLowerCase();
        const cmd       = textLower.split(/\s+/)[0];

        const adminId = client.info.wid.user + '@c.us';
        const isAdmin = msg.fromMe || msg.from === adminId || msg.from === client.info.wid._serialized;

        if (msg.fromMe && !rawText.startsWith('.') && !['ok', 'ban'].includes(textLower)) return;

        if (isAdmin) { await handleAdminMessage(msg, rawText, textLower, cmd); return; }

        // ── Activity Filter ──────────────────────────
        touchActive(msg.from);
        if (!isUserActive(msg.from)) return;

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

    // ── Broadcast ───────────────────────────────────
    if (cmd === '.broadcast' || cmd === '.bc') {
        const parts = rawText.split(/\s+/);
        const targetLobby = parts[1]?.toLowerCase();
        const bcMessage = parts.slice(2).join(' ');
        if (!targetLobby || !bcMessage) return replyAdmin('⚠️ Usage: .bc <mini/mega/live/medium/competitive/custom/solo/duo/all> <Message>');
        const records = readRecords();
        let targets = targetLobby === 'all'
            ? records
            : records.filter(r => r.lobbyType?.toLowerCase() === targetLobby);
        if (targets.length === 0) return replyAdmin(`⚠️ Koi team ${targetLobby.toUpperCase()} lobby me register nahi hai.`);
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

    // ── Settings ────────────────────────────────────
    if (cmd === '.setname' || cmd === '.settitle') {
        const newName = rawText.slice(cmd.length).trim();
        if (newName) { settings.scrimName = newName; saveSettings(); return replyAdmin(`✅ Scrim name: *${newName}*`); }
        return replyAdmin('⚠️ Usage: .setname <Name>');
    }

    if (cmd === '.setlobbytime' || cmd === '.settime') {
        const time = rawText.slice(cmd.length).trim();
        if (time) { settings.lobbyTime = time; saveSettings(); completedUsers.clear(); return replyAdmin(`✅ Lobby time: *${time}*`); }
        return replyAdmin('⚠️ Usage: .setlobbytime 9 PM');
    }

    // ── Price ───────────────────────────────────────
    if (cmd === '.setprice') {
        const parts = rawText.split(/\s+/);
        const type = parts[1]?.toLowerCase();
        const price = parts[2];
        const priceMap = { mini: 'miniPrice', mega: 'megaPrice', live: 'livePrice', medium: 'mediumPrice', competitive: 'competitivePrice', custom: 'customPrice', solo: 'soloPrice', duo: 'duoPrice' };
        if (priceMap[type] && price) {
            settings[priceMap[type]] = price;
            saveSettings();
            return replyAdmin(`✅ ${type.toUpperCase()} price set to ₹${price}`);
        }
        return replyAdmin('⚠️ Usage: .setprice mini/mega/live/medium/competitive/custom/solo/duo <amount>');
    }

    // ── Match count ─────────────────────────────────
    if (cmd === '.setmatches') {
        const parts = rawText.split(/\s+/);
        const type = parts[1]?.toLowerCase();
        const count = parts[2];
        const matchMap = { mini: 'miniMatches', mega: 'megaMatches', live: 'liveMatches', medium: 'mediumMatches', competitive: 'competitiveMatches', custom: 'customMatches' };
        if (matchMap[type] && count) {
            settings[matchMap[type]] = count;
            saveSettings();
            return replyAdmin(`✅ ${type.toUpperCase()} match count set to ${count}`);
        }
        return replyAdmin('⚠️ Usage: .setmatches mini/mega/live/medium/competitive/custom <count>');
    }

    // ── Links ───────────────────────────────────────
    if (cmd === '.setlink') {
        const parts = rawText.split(/\s+/);
        const type = parts[1]?.toLowerCase();
        const linkMatch = rawText.match(/https?:\/\/[^\s]+/i);
        const validTypes = ['mini', 'mega', 'live', 'medium', 'competitive', 'custom', 'solo', 'duo'];
        if (linkMatch && validTypes.includes(type)) {
            links[type] = linkMatch[0];
            saveLinks();
            return replyAdmin(`✅ *${type.toUpperCase()}* link updated.`);
        }
        return replyAdmin('⚠️ Usage: .setlink mini/mega/live/medium/competitive/custom/solo/duo <link>');
    }

    // ── Mode ────────────────────────────────────────
    if (cmd === '.setmode' || cmd === '.setmodelive') {
        let val = cmd === '.setmodelive' ? 'minilive' : rawText.split(/\s+/)[1]?.toLowerCase();
        const validModes = Object.keys(MODE_LOBBIES);
        if (!validModes.includes(val)) return replyAdmin(`⚠️ Usage: .setmode ${validModes.join(' | ')}`);
        activeMode = val;
        saveMode();
        const activeList = MODE_LOBBIES[val].join(', ');
        return replyAdmin(`✅ *Mode: ${val.toUpperCase()}*\nActive lobbies: ${activeList}`);
    }

    // ── Slot open/close ─────────────────────────────
    if (cmd === '.setfull') {
        const type = rawText.split(/\s+/)[1]?.toLowerCase();
        if (!type) return replyAdmin('⚠️ Usage: .setfull mini/mega/live/medium/competitive/custom/solo/duo');
        if (!settings.closedLobbies.includes(type)) settings.closedLobbies.push(type);
        saveSettings();
        return replyAdmin(`🛑 *${type.toUpperCase()} Lobby* marked as FULL.`);
    }

    if (cmd === '.setopen') {
        const type = rawText.split(/\s+/)[1]?.toLowerCase();
        if (!type) return replyAdmin('⚠️ Usage: .setopen mini/mega/live/medium/competitive/custom/solo/duo');
        settings.closedLobbies = settings.closedLobbies.filter(l => l !== type);
        saveSettings();
        return replyAdmin(`✅ *${type.toUpperCase()} Lobby* is now OPEN.`);
    }

    // ── Slot count ──────────────────────────────────
    if (cmd === '.setslots') {
        const n = parseInt(rawText.split(/\s+/)[1]);
        if (!isNaN(n) && n > 0) { maxSlots = n; return replyAdmin(`✅ Max slots per lobby: *${n}*`); }
        return replyAdmin('⚠️ Usage: .setslots <number>');
    }

    // ── Activity window control ─────────────────────
    if (cmd === '.setwindow') {
        const secs = parseInt(rawText.split(/\s+/)[1]);
        if (!isNaN(secs) && secs >= 5) {
            ACTIVE_WINDOW = secs * 1000;
            return replyAdmin(`✅ Activity window set to *${secs} seconds*.\nBot sirf unhe reply karega jo last ${secs}s me active the.`);
        }
        return replyAdmin(`⚠️ Usage: .setwindow <seconds>\nExample: .setwindow 30\n\nCurrent window: *${ACTIVE_WINDOW/1000}s*`);
    }

    if (cmd === '.window') {
        return replyAdmin(`⏱️ *Activity Window:* ${ACTIVE_WINDOW/1000} seconds\n\nBot sirf unhe reply karta hai jo last ${ACTIVE_WINDOW/1000}s me message kiya ho.\nChange karne ke liye: .setwindow <seconds>`);
    }

    // ── List / Stats / Clear ────────────────────────
    if (cmd === '.list') {
        const records = readRecords();
        if (!records.length) return replyAdmin('📋 No registrations yet.');
        let out = `📋 *SLOTLIST*\n\n`;
        for (const lobbyName of ALL_LOBBY_TYPES) {
            const list = records.filter(r => r.lobbyType?.toLowerCase() === lobbyName.toLowerCase());
            if (!list.length) continue;
            const meta = getLobbyMeta(lobbyName);
            out += `${meta.emoji} *${lobbyName.toUpperCase()} (${list.length}/${maxSlots})*\n`;
            list.forEach((r, i) => out += `  ${i+1}. ${r.teamName}\n`);
            out += '\n';
        }
        return replyAdmin(out.trim());
    }

    if (cmd === '.listdetail' || cmd === '.listd') {
        // Detailed list with numbers and UTR
        const records = readRecords();
        if (!records.length) return replyAdmin('📋 No registrations yet.');
        let out = `📋 *DETAILED SLOTLIST*\n\n`;
        for (const lobbyName of ALL_LOBBY_TYPES) {
            const list = records.filter(r => r.lobbyType?.toLowerCase() === lobbyName.toLowerCase());
            if (!list.length) continue;
            const meta = getLobbyMeta(lobbyName);
            out += `${meta.emoji} *${lobbyName.toUpperCase()} (${list.length}/${maxSlots})*\n`;
            list.forEach((r, i) => out += `  ${i+1}. ${r.teamName} | ${r.number} | UTR: ${r.utr}\n`);
            out += '\n';
        }
        return replyAdmin(out.trim());
    }

    if (cmd === '.stats') {
        const s = getStats();
        const modes = Object.keys(MODE_LOBBIES).join(' | ');
        let out = `📊 *BOT STATS*\n━━━━━━━━━━━━━━━\n`;
        out += `Scrim Name  : ${settings.scrimName}\n`;
        out += `Total       : ${s.total}\n`;
        for (const lt of ALL_LOBBY_TYPES) {
            const meta = getLobbyMeta(lt);
            if (s[lt.toLowerCase()] > 0 || lobbyInMode(lt)) {
                out += `${meta.emoji} ${lt.padEnd(6)} : ${s[lt.toLowerCase()]}/${maxSlots}\n`;
            }
        }
        out += `\nMode        : ${activeMode.toUpperCase()}\n`;
        out += `Closed      : ${settings.closedLobbies.length ? settings.closedLobbies.join(', ') : 'None'}\n`;
        out += `Time        : ${settings.lobbyTime}\n━━━━━━━━━━━━━━━`;
        return replyAdmin(out);
    }

    if (cmd === '.clear') {
        localRecords = [];
        DailyRecord.deleteMany({}).catch(()=>{});
        completedUsers.clear();
        settings.closedLobbies = [];
        saveSettings();
        Object.keys(userQueues).forEach(k => { userQueues[k] = []; });
        processingSet.clear();
        return replyAdmin('🧹 All registrations + memory cleared.');
    }

    // NEW: Remove a specific team by name
    if (cmd === '.remove') {
        const parts = rawText.split(/\s+/);
        const lobbyType = parts[1]?.toLowerCase();
        const teamNameToRemove = parts.slice(2).join(' ').trim();
        if (!lobbyType || !teamNameToRemove) return replyAdmin('⚠️ Usage: .remove mini/mega/live/medium/competitive/custom/solo/duo <team name>');
        const before = localRecords.length;
        localRecords = localRecords.filter(r =>
            !(r.lobbyType?.toLowerCase() === lobbyType && r.teamName.toLowerCase().trim() === teamNameToRemove.toLowerCase().trim())
        );
        DailyRecord.deleteMany({ lobbyType: { $regex: new RegExp(lobbyType, 'i') }, teamName: { $regex: new RegExp(`^${teamNameToRemove}$`, 'i') } }).catch(()=>{});
        const removed = before - localRecords.length;
        return replyAdmin(removed > 0 ? `✅ Removed *${teamNameToRemove}* from ${lobbyType.toUpperCase()}.` : `⚠️ Team not found.`);
    }

    // NEW: Ban a number from registering
    if (cmd === '.ban' && !msg.hasQuotedMsg) {
        const number = rawText.split(/\s+/)[1]?.replace(/\D/g, '');
        if (!number) return replyAdmin('⚠️ Usage: .ban <number> — to ban from quoted msg, reply with "ban"');
        removeRecord(number);
        completedUsers.delete(`${number}@c.us`);
        seenUsers.delete(`${number}@c.us`);
        return replyAdmin(`🚫 Number +${number} banned and record removed.`);
    }

    // NEW: Reset a specific user's session (unstick them)
    if (cmd === '.reset') {
        const number = rawText.split(/\s+/)[1]?.replace(/\D/g, '');
        if (!number) return replyAdmin('⚠️ Usage: .reset <number>');
        const userId = `${number}@c.us`;
        await clearSession(userId);
        completedUsers.delete(userId);
        seenUsers.delete(userId);
        if (userQueues[userId]) userQueues[userId] = [];
        return replyAdmin(`✅ Session reset for +${number}. They can start fresh.`);
    }

    // NEW: Send QR manually to a number
    if (cmd === '.sendqr') {
        const number = rawText.split(/\s+/)[1]?.replace(/\D/g, '');
        if (!number) return replyAdmin('⚠️ Usage: .sendqr <number>');
        const userId = `${number}@c.us`;
        if (!fs.existsSync('./qr.png')) return replyAdmin('⚠️ qr.png not found.');
        try {
            await client.sendMessage(userId, MessageMedia.fromFilePath('./qr.png'), { caption: `📲 *MAG ESPORTS* — Scan & Pay, then send screenshot.` });
            return replyAdmin(`✅ QR sent to +${number}`);
        } catch(e) { return replyAdmin(`❌ Failed: ${e.message}`); }
    }

    // NEW: Show current prices
    if (cmd === '.prices') {
        return replyAdmin(
            `💰 *CURRENT PRICES*\n━━━━━━━━━━━━━━━\n` +
            `🟡 Mini        : ₹${settings.miniPrice} (${settings.miniMatches} matches)\n` +
            `🔵 Mega        : ₹${settings.megaPrice} (${settings.megaMatches} matches)\n` +
            `🔴 Live        : ₹${settings.livePrice} (${settings.liveMatches} matches)\n` +
            `🟠 Medium      : ₹${settings.mediumPrice} (${settings.mediumMatches} matches)\n` +
            `🏆 Competitive : ₹${settings.competitivePrice} (${settings.competitiveMatches} matches)\n` +
            `🟣 Custom      : ₹${settings.customPrice} (${settings.customMatches} matches)\n` +
            `⚪ Solo        : ₹${settings.soloPrice}\n` +
            `🟤 Duo         : ₹${settings.duoPrice}\n` +
            `━━━━━━━━━━━━━━━\nTime: ${settings.lobbyTime}`
        );
    }

    // NEW: Show available modes
    if (cmd === '.modes') {
        let out = `🎮 *AVAILABLE MODES*\n━━━━━━━━━━━━━━━\n`;
        for (const [m, lobbies] of Object.entries(MODE_LOBBIES)) {
            out += `${m === activeMode ? '✅' : '▫️'} *.setmode ${m}* → ${lobbies.join(' + ')}\n`;
        }
        return replyAdmin(out);
    }

    // NEW: Show current links
    if (cmd === '.links') {
        return replyAdmin(
            `🔗 *CURRENT LINKS*\n━━━━━━━━━━━━━━━\n` +
            Object.entries(links).map(([k, v]) => `${k.toUpperCase()}: ${v}`).join('\n')
        );
    }

    // NEW: Admin help command
    if (cmd === '.help') {
        return replyAdmin(
            `🤖 *ADMIN COMMANDS*\n━━━━━━━━━━━━━━━━━\n\n` +
            `*📋 LISTINGS*\n.list — slot list\n.listdetail — list with numbers & UTR\n.stats — full stats\n.prices — all current prices\n.links — all group links\n.modes — all available modes\n\n` +
            `*⚙️ SETTINGS*\n.setname <name>\n.setlobbytime <time>\n.setslots <n>\n.setprice <type> <amt>\n.setmatches <type> <n>\n.setlink <type> <url>\n.setmode <mode>\n\n` +
            `*⏱️ ACTIVITY FILTER*\n.setwindow <seconds> — set active window (default: 30s)\n.window — check current window setting\n_(Bot sirf recently active users ko reply karta hai)_\n\n` +
            `*🎮 LOBBY CONTROL*\n.setfull <type> — mark full\n.setopen <type> — re-open\n\n` +
            `*👤 USER CONTROL*\n.remove <type> <teamname>\n.ban <number>\n.reset <number>\n.sendqr <number>\n\n` +
            `*📢 BROADCAST*\n.bc <type/all> <message>\n\n` +
            `*🗑️ DATA*\n.clear — wipe all data\n\n` +
            `*Approval (reply to flagged msg)*\nok — approve\nban — reject`
        );
    }

    // ── Approval (reply to flagged payment) ─────────
    if (msg.hasQuotedMsg && (textLower === 'ok' || textLower === 'ban')) {
        const body = (await msg.getQuotedMessage()).body || '';

        // Extract ID field (WhatsApp chat ID)
        let targetId = (body.match(/ID:\s*(\S+@\S+)/) || [])[1] || null;

        // Extract number — handles: "+91XXXXXXXXXX", "91XXXXXXXXXX", "+XXXXXXXXXX", "XXXXXXXXXX"
        const numMatch = body.match(/Number:\s*\+?91?(\d{10})/);
        const cleanNumber = numMatch?.[1] || null;

        // Build targetId from number if not found or is @lid format
        if (cleanNumber && (!targetId || targetId.includes('@lid'))) {
            targetId = `91${cleanNumber}@c.us`;
        }

        if (!targetId || !cleanNumber) {
            return replyAdmin(`⚠️ Number/ID extract nahi hua quoted message se.\nBody preview: ${body.slice(0, 100)}`);
        }

        const teamName  = (body.match(/Team:\s*\*?([^\n*]+)\*?/) || [])[1]?.trim() || 'Unknown';
        const lobbyType = (body.match(/Lobby:\s*\*?([^\n*]+)\*?/i) || [])[1]?.trim() || 'Mini';

        if (textLower === 'ok') {
            saveRecord(teamName, cleanNumber, lobbyType, 'N/A', 'N/A', 'MANUAL_OK');
            const link = links[lobbyType.toLowerCase()] || links.mini;
            try {
                await client.sendMessage(targetId, `✅ *VERIFIED BY ADMIN!*\nTeam: *${teamName}*\n🔗 Link: ${link}`);
            } catch(e) {
                log('WARN', `ok: could not message ${targetId}: ${e.message}`);
            }
            return replyAdmin(`✅ Approved: *${teamName}* (${lobbyType})\nNumber: +91${cleanNumber}`);
        }

        if (textLower === 'ban') {
            if (body.includes('AUTO-VERIFIED') || body.includes('WA-PAY')) removeRecord(cleanNumber);
            completedUsers.delete(targetId);
            seenUsers.delete(targetId);
            await clearSession(targetId);
            try {
                await client.sendMessage(targetId, `🚫 *Payment Rejected!*\nSahi screenshot bhejo ya admin se contact karo.`);
            } catch(e) {
                log('WARN', `ban: could not message ${targetId}: ${e.message}`);
            }
            return replyAdmin(`🚫 Rejected: *${teamName}* (${lobbyType})\nNumber: +91${cleanNumber}`);
        }
    }
};

// ─────────────────────────────────────────────────────
//  USER HANDLER
// ─────────────────────────────────────────────────────
const handleUserMessage = async (msg, rawText, textLower) => {
    try {
        const extractNumbers = (str) => (String(str).match(/\d+/g) || []);
        const miniPrices        = extractNumbers(settings.miniPrice);
        const megaPrices        = extractNumbers(settings.megaPrice);
        const livePrices        = extractNumbers(settings.livePrice);
        const mediumPrices      = extractNumbers(settings.mediumPrice);
        const competitivePrices = extractNumbers(settings.competitivePrice);
        const customPrices      = extractNumbers(settings.customPrice);
        const soloPrices        = extractNumbers(settings.soloPrice);
        const duoPrices         = extractNumbers(settings.duoPrice);
        const allPrices         = [...miniPrices, ...megaPrices, ...livePrices, ...mediumPrices, ...competitivePrices, ...customPrices, ...soloPrices, ...duoPrices];
        const textHasNumber = (pricesArr, text) => pricesArr.some(p => new RegExp(`\\b${p}\\b`).test(text));

        const pData = await TempSession.findOne({ phone: msg.from });
        const isWaitingText = pData?.state === 'AWAITING_LOBBY' || pData?.state === 'AWAITING_TEAM_NAME';

        // Lobby keyword detection (filtered to only active mode lobbies)
        const detectedKeyword = detectLobby(textLower);
        let wantsLobby = (detectedKeyword && lobbyInMode(detectedKeyword)) ? detectedKeyword : null;

        // Numeric shortcuts: 1=first active, 2=second, 3=third ... up to 8
        const activeLobbies = MODE_LOBBIES[activeMode] || [];
        if (!wantsLobby && textLower === '1' && activeLobbies[0]) wantsLobby = activeLobbies[0];
        if (!wantsLobby && textLower === '2' && activeLobbies[1]) wantsLobby = activeLobbies[1];
        if (!wantsLobby && textLower === '3' && activeLobbies[2]) wantsLobby = activeLobbies[2];
        if (!wantsLobby && textLower === '4' && activeLobbies[3]) wantsLobby = activeLobbies[3];
        if (!wantsLobby && textLower === '5' && activeLobbies[4]) wantsLobby = activeLobbies[4];
        if (!wantsLobby && textLower === '6' && activeLobbies[5]) wantsLobby = activeLobbies[5];
        if (!wantsLobby && textLower === '7' && activeLobbies[6]) wantsLobby = activeLobbies[6];
        if (!wantsLobby && textLower === '8' && activeLobbies[7]) wantsLobby = activeLobbies[7];

        // Price-number detection — map amount back to lobby type
        if (!wantsLobby) {
            const priceDetect = [
                { prices: miniPrices,        lobby: 'Mini',        mode: ['all','both','mini','minilive','minimedium','minimediumcomp','minimediumlive'] },
                { prices: megaPrices,        lobby: 'Mega',        mode: ['all','both','mega','megacomp','megamediumcomp'] },
                { prices: livePrices,        lobby: 'Live',        mode: ['all','live','minilive','minimediumlive'] },
                { prices: mediumPrices,      lobby: 'Medium',      mode: ['all','medium','minimedium','minimediumcomp','minimediumlive','megamediumcomp','full'] },
                { prices: competitivePrices, lobby: 'Competitive', mode: ['all','competitive','megacomp','minimediumcomp','megamediumcomp','full'] },
                { prices: customPrices,      lobby: 'Custom',      mode: ['all','custom','full'] },
                { prices: soloPrices,        lobby: 'Solo',        mode: ['all','solo','solodup','full'] },
                { prices: duoPrices,         lobby: 'Duo',         mode: ['all','duo','solodup','full'] },
            ];
            for (const pd of priceDetect) {
                if (textHasNumber(pd.prices, textLower) && pd.mode.includes(activeMode)) {
                    wantsLobby = pd.lobby; break;
                }
            }
        }

        // ── Expanded QR/pay keyword detection ───────
        const asksQR = /qr|scan|pay|upi|kese|kaise|bhejo|number|send|chahiye|chaiye|chyie|chayie|barcode|bar\s*code|scanner|gpay|g\s*pay|paytm|phonepe|phone\s*pe|bhejna|fee|price|amount|entry|kitna|kitne|rupay|rupee|paise|payment|join|kaise\s*karu|kya\s*kare|how|kaise\s*le|lena\s*hai|book\s*karna|register\s*karna|slot\s*chahiye/i.test(textLower);

        const isPriceNumber = textHasNumber(allPrices, textLower);
        const hasDirectIntent = !!wantsLobby || asksQR || isPriceNumber;

        // ── Welcome for first-time users ─────────────
        if (!seenUsers.has(msg.from) && !msg.hasMedia) {
            seenUsers.add(msg.from);
            if (!isWaitingText && !hasDirectIntent) {
                return safeSend(msg.from, getWelcomeMessage());
            }
        }

        // ── State machine ────────────────────────────
        if (pData && !msg.hasMedia) {
            if (pData.state === 'AWAITING_LOBBY') {
                if (!wantsLobby) return safeSend(msg.from, `⚠️ Sahi lobby select karo.\n\nOptions: *${activeLobbies.join('*, *')}*`);
                await saveSession(msg.from, { lobbyType: wantsLobby, state: 'AWAITING_TEAM_NAME' });
                return safeSend(msg.from, `✅ *${wantsLobby} Lobby* select ki!\n\nApna *Team Name* bhejo:`);
            }

            if (pData.state === 'AWAITING_TEAM_NAME') {
                if (isInvalidName(rawText)) return safeSend(msg.from, '⚠️ Ek proper *Team Name* bhejo.\n(Team name sirf alphabets mein hona chahiye)');
                if (isDuplicateTeam(rawText, pData.lobbyType)) return safeSend(msg.from, `⚠️ *${rawText}* pehle se *${pData.lobbyType} Lobby* mein registered hai!\nKoi doosra naam bhejo:`);
                if (!isSlotsAvailable(pData.lobbyType)) {
                    await clearSession(msg.from);
                    return safeSend(msg.from, `🛑 *${pData.lobbyType} lobby full ho gayi hai!*`);
                }
                clearQrReminder(msg.from);
                completedUsers.add(msg.from);
                await processVerification(msg, rawText, pData.lobbyType, pData);
                await clearSession(msg.from);
                return;
            }
        }

        // ── Image / screenshot ───────────────────────
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

                // Detect lobby from payment amount
                let detectedLobby = null;
                if (amount) {
                    const priceDetect = [
                        { prices: miniPrices,        lobby: 'Mini',        mode: ['all','both','mini','minilive','minimedium','minimediumcomp','minimediumlive'] },
                        { prices: megaPrices,        lobby: 'Mega',        mode: ['all','both','mega','megacomp','megamediumcomp'] },
                        { prices: livePrices,        lobby: 'Live',        mode: ['all','live','minilive','minimediumlive'] },
                        { prices: mediumPrices,      lobby: 'Medium',      mode: ['all','medium','minimedium','minimediumcomp','minimediumlive','megamediumcomp','full'] },
                        { prices: competitivePrices, lobby: 'Competitive', mode: ['all','competitive','megacomp','minimediumcomp','megamediumcomp','full'] },
                        { prices: customPrices,      lobby: 'Custom',      mode: ['all','custom','full'] },
                        { prices: soloPrices,        lobby: 'Solo',        mode: ['all','solo','solodup','full'] },
                        { prices: duoPrices,         lobby: 'Duo',         mode: ['all','duo','solodup','full'] },
                    ];
                    for (const pd of priceDetect) {
                        if (pd.prices.includes(String(amount)) && pd.mode.includes(activeMode)) {
                            detectedLobby = pd.lobby; break;
                        }
                    }
                }

                if (pData?.state === 'AWAITING_SS' && pData.lobbyType) {
                    if (detectedLobby && detectedLobby !== pData.lobbyType) {
                        resultObj.status = `🚨 AMOUNT MISMATCH (Paid ₹${amount}, wanted ${pData.lobbyType})`;
                        resultObj.isAuto = false;
                    }
                    detectedLobby = pData.lobbyType;
                }

                if (!detectedLobby && activeLobbies.length === 1) detectedLobby = activeLobbies[0];

                if (detectedLobby) {
                    await saveSession(msg.from, { mediaPath: tempFileName, status: resultObj.status, isAuto: resultObj.isAuto, utr, amount, imgHash, state: 'AWAITING_TEAM_NAME', lobbyType: detectedLobby });
                    return safeSend(msg.from, `✅ Screenshot mila! (₹${amount || '?'})\nLobby: *${detectedLobby}*\n\n👉 Apna *Team Name* bhejo:`);
                } else {
                    await saveSession(msg.from, { mediaPath: tempFileName, status: resultObj.status, isAuto: resultObj.isAuto, utr, amount, imgHash, state: 'AWAITING_LOBBY', lobbyType: null });
                    return safeSend(msg.from, `✅ Screenshot mila!\nKaunsi lobby leni hai?\n\n👉 Type karo: *${activeLobbies.join('*, *')}*`);
                }
            } catch (e) {
                await resetOCRWorker();
                await saveSession(msg.from, { mediaPath: null, status: '❌ OCR FAILED', state: 'AWAITING_LOBBY' });
                try { fs.unlinkSync(tempFileName); } catch(err){}
                return safeSend(msg.from, `⚠️ Screenshot scan mein error aayi. Please lobby select karein:\n\n👉 *${activeLobbies.join('*, *')}*`);
            }
        }

        // ── Text intent ──────────────────────────────
        if (!msg.hasMedia && !isWaitingText && rawText.length > 0) {
            if (hasDirectIntent) {
                if (completedUsers.has(msg.from) && !wantsLobby && !asksQR) return;

                await saveSession(msg.from, { state: 'AWAITING_SS', lobbyType: wantsLobby });

                if (wantsLobby) {
                    if (!isSlotsAvailable(wantsLobby)) return safeSend(msg.from, `😔 *${wantsLobby} lobby full ho gayi hai!*`);
                    return await sendLobbyInfo(msg.from, wantsLobby);
                } else {
                    // Generic QR request — show QR with all active lobby prices
                    if (fs.existsSync('./qr.png')) {
                        let captionText = `👇 *SCAN & PAY*\n⏰ *Lobby Time:* ${settings.lobbyTime}\n\n`;
                        for (const lobbyName of activeLobbies) {
                            const meta = getLobbyMeta(lobbyName);
                            const price = meta.price.includes('/') ? '₹' + meta.price.replace('/', ' / ₹') : '₹' + meta.price;
                            captionText += `${meta.emoji} *${lobbyName}:* ${price}\n`;
                        }
                        captionText += `\nPay karke screenshot bhejein.`;
                        await safeSend(msg.from, MessageMedia.fromFilePath('./qr.png'), { caption: captionText });
                        setQrReminder(msg.from);
                        return;
                    } else {
                        return safeSend(msg.from, getWelcomeMessage());
                    }
                }
            }

            // ── Welcome triggers ─────────────────────
            const welcomeRegex = /\b(hi|hello|hey|hii|helo|helo|menu|book|slot|slots|register|tourney|tournament|scrim|\?|help|details|info|join|start|kya\s*hai|kaise|bhai|bro|hy|sup|hlo|hlw|lena\s*hai|chahiye)\b/i;
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
        const files = fs.readdirSync('./');
        files.forEach(f => { if (f.startsWith('temp_') && f.endsWith('.jpg')) try { fs.unlinkSync(f); } catch {} });
    } catch(e) {}
    settings.closedLobbies = [];
    saveSettings();
    seenUsers.clear();
    completedUsers.clear();
    Object.keys(userQueues).forEach(k => { userQueues[k] = []; });
    processingSet.clear();
    // Clear activity tracker so previous day's users don't carry over
    Object.keys(lastActiveMap).forEach(k => { delete lastActiveMap[k]; });
    log('INFO', '🧹 Daily reset completed.');
}, { timezone: 'Asia/Kolkata' });

client.initialize();
