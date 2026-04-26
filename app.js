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
//  MONGODB SETUP
// ─────────────────────────────────────────────────────
const MONGO_URI = 'mongodb+srv://tinyji6887_db_user:Tinyji6887_db_user@cluster0.zu7kwc5.mongodb.net/Magbotpaid?retryWrites=true&w=majority';

mongoose.connect(MONGO_URI)
    .then(() => console.log('✅ Connected to MongoDB (Magbotpaid)!'))
    .catch(err => console.error('❌ MongoDB Connection Error:', err));

const teamSchema = new mongoose.Schema({
    teamName: String,
    number: String,
    lobbyType: String,
    utr: String,
    amount: String,
    imgHash: String,
    timestamp: String
});

// Collection ka naam 'Dailylobby' set kiya hai
const DailyRecord = mongoose.model('Dailylobby', teamSchema, 'Dailylobby');

let localRecords = [];
// Bot start hote hi purana data fetch karega
DailyRecord.find({}).then(data => {
    localRecords = data;
    console.log(`✅ Loaded ${localRecords.length} teams from Database.`);
});


const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: { args: ['--no-sandbox', '--disable-setuid-sandbox'], headless: true, timeout: 60000 }
});

const botStartTime = Math.floor(Date.now() / 1000);

// ─────────────────────────────────────────────────────
//  HELPERS & STATE
// ─────────────────────────────────────────────────────
const safeRead  = (file, fallback) => {
    try { if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
    return fallback;
};
const safeWrite = (file, data) => {
    try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }
    catch(e) { console.error(`❌ Write error [${file}]:`, e.message); }
};

const LOG_FILE = './bot.log';
const log = (level, msg) => {
    const entry = `[${new Date().toLocaleString('en-IN')}] [${level}] ${msg}`;
    console.log(entry);
    try { fs.appendFileSync(LOG_FILE, entry + '\n'); } catch {}
};

const pendingPayments = {};
const rateLimitMap    = {};
const sessionTimeout  = {};
const antiSpam        = new Set();
const seenUsers       = new Set();
const completedUsers  = new Set();
const qrReminders     = {};
let maxSlots          = 24;

let activeMode = safeRead('./mode.json', { mode: 'both' }).mode;
const saveMode = () => safeWrite('./mode.json', { mode: activeMode });

let links = safeRead('./links.json', { mini: 'https://chat.whatsapp.com/xxx', mega: 'https://chat.whatsapp.com/yyy', live: 'https://chat.whatsapp.com/zzz' });
const saveLinks = () => safeWrite('./links.json', links);

let settings = safeRead('./settings.json', { scrimName: 'MAG ESPORTS', miniPrice: '20/25', megaPrice: '35/45', livePrice: '55', lobbyTime: '9 PM', closedLobbies: [] });
if (!settings.closedLobbies) settings.closedLobbies = [];
const saveSettings = () => safeWrite('./settings.json', settings);

const MAG_UPI_IDS = ['8823827920@okbizaxis', '8823827920', 'mag esports', 'magesports', 'mag_esports', 'mac esports', 'maq esports', '882382792o', 'chetan bhul', 'chetan'];
const OCR_MIN_CONF = 30;

const getValidPrices = () => {
    const allStr = `${settings.miniPrice} ${settings.megaPrice} ${settings.livePrice}`;
    return allStr.match(/\d+/g) || [];
};

// ─────────────────────────────────────────────────────
//  REMINDER & SESSION HELPERS
// ─────────────────────────────────────────────────────
const setQrReminder = (userId) => {
    if (qrReminders[userId]) clearTimeout(qrReminders[userId]);
    qrReminders[userId] = setTimeout(async () => {
        const pData = pendingPayments[userId];
        if (!pData || pData.state === 'AWAITING_TEAM_NAME') { delete qrReminders[userId]; return; }
        try {
            const reminderMsg = `🚨 *FINAL REMINDER!* 🚨\n\nBhai aapne slot manga tha par abhi tak screenshot nahi bheja.\n\n⚡ *Sirf kuch LAST SLOTS bache hain!* ⚡\nJaldi pay karke screenshot bhejo warna aapka slot cancel karke waiting list wali team ko de diya jayega!\n\nFast kro bhai ⏳`;
            await client.sendMessage(userId, reminderMsg);
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

const touchSession = (userId) => {
    if (sessionTimeout[userId]) clearTimeout(sessionTimeout[userId]);
    sessionTimeout[userId] = setTimeout(async () => {
        if (pendingPayments[userId]) {
            delete pendingPayments[userId];
            try { await client.sendMessage(userId, '⌛ *Session timeout ho gayi.*\nDobara screenshot bhejo to restart karo.'); } catch {}
        }
    }, 5 * 60 * 1000);
};

const clearSession = (userId) => {
    if (sessionTimeout[userId]) clearTimeout(sessionTimeout[userId]);
    delete sessionTimeout[userId]; delete pendingPayments[userId];
};

// ─────────────────────────────────────────────────────
//  SLOT HELPERS & SECURITY (UPDATED FOR MONGODB)
// ─────────────────────────────────────────────────────
const readRecords      = () => localRecords;
const getSlotCount     = (type) => readRecords().filter(r => r.lobbyType?.toLowerCase() === type?.toLowerCase()).length;
const isSlotsAvailable = (type) => { if (settings.closedLobbies.includes(type.toLowerCase())) return false; return getSlotCount(type) < maxSlots; };

const saveRecord = (teamName, number, lobbyType, utr = 'N/A', amount = 'N/A', imgHash = 'N/A') => {
    const doc = { teamName, number: `+${number}`, lobbyType, utr, amount, imgHash, timestamp: new Date().toLocaleString('en-IN') };
    localRecords.push(doc); // Save to local array
    new DailyRecord(doc).save().catch(e => log('ERROR', 'MongoDB Save Error: ' + e)); // Save to DB
};

const removeRecord = (number) => {
    const numStr = String(number).startsWith('+') ? number : `+${number}`;
    localRecords = localRecords.filter(r => r.number !== numStr && r.number !== number);
    DailyRecord.deleteMany({ $or: [{ number: numStr }, { number: number }] }).catch(e => log('ERROR', 'DB Del Error: ' + e));
};

const isDuplicateUTR = (utr) => { if (!utr || utr === 'N/A') return false; return readRecords().some(r => r.utr === utr); };
const isDuplicateHash = (hash) => { if (!hash || hash === 'N/A') return false; return readRecords().some(r => r.imgHash === hash); };
const isDuplicateTeam = (teamName, lobbyType) => {
    return readRecords().some(r => r.lobbyType?.toLowerCase() === lobbyType.toLowerCase() && r.teamName.toLowerCase().trim() === teamName.toLowerCase().trim());
};

const getStats = () => {
    const records = readRecords();
    return {
        total: records.length,
        mini: records.filter(r => r.lobbyType?.toLowerCase() === 'mini').length,
        mega: records.filter(r => r.lobbyType?.toLowerCase() === 'mega').length,
        live: records.filter(r => r.lobbyType?.toLowerCase() === 'live').length
    };
};

// ─────────────────────────────────────────────────────
//  🔥 ADVANCED TESSERACT OCR ENGINE 🔥
// ─────────────────────────────────────────────────────
let _ocrWorker = null;
const getOCRWorker = async () => {
    if (!_ocrWorker) {
        _ocrWorker = await Tesseract.createWorker('eng', 1, { logger: () => {} });
        await _ocrWorker.setParameters({
            tessedit_pageseg_mode: '11',
            preserve_interword_spaces: '1',
            user_defined_dpi: '300' 
        });
    }
    return _ocrWorker;
};
const resetOCRWorker = async () => { try { if (_ocrWorker) await _ocrWorker.terminate(); } catch {} _ocrWorker = null; };

const checkDateStatus = (lowerText) => {
    const now = new Date();
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
        const d = parseInt(match[1]);
        const m = parseInt(match[2]);
        if (d === now.getDate() && m === (now.getMonth() + 1)) foundToday = true;
    }

    if (foundToday) return 'TODAY';
    if (foundAnyDate) return 'OLD';
    return 'UNKNOWN';
};

const extractUTR = (text) => {
    const cleanText = text.replace(/O/g, '0').replace(/l/g, '1');
    const patterns = [ /\b(T\d{11})\b/i, /UTR[:\s#]*([A-Z0-9]{10,22})/i, /Transaction\s*(?:ID|No\.?|Ref\.?)[:\s]*([A-Z0-9]{8,22})/i, /UPI\s*(?:Ref(?:\.?\s*No)?|Txn\.?|ID)[:\s]*([A-Z0-9]{8,22})/i, /\b([A-Z]{2,4}\d{9,14})\b/, /\b(\d{12})\b/, /\b(\d{16})\b/ ];
    for (const pat of patterns) { const m = cleanText.match(pat); if (m && m[1] && m[1].length >= 8) return m[1].toUpperCase(); }
    return null;
};

const isValidUPI_UTR = (utr) => {
    if (!utr) return true; 
    const cleanUtr = utr.replace(/O/gi, '0').replace(/l/gi, '1').replace(/S/gi, '5');

    if (cleanUtr.length === 12 && /^\d+$/.test(cleanUtr)) {
        const currentYearDigit = String(new Date().getFullYear()).slice(-1); 
        if (cleanUtr[0] !== currentYearDigit) {
            return false; 
        }
    }
    return true;
};

const extractAmount = (rawText) => {
    let text = rawText.replace(/,/g, '').toLowerCase();
    text = text.replace(/o/g, '0'); 
    
    text = text.replace(/\b\d{1,2}:\d{2}\s*(?:am|pm)?\b/gi, ' ');

    const validPrices = getValidPrices();
    if(validPrices.length === 0) return null;

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
        if (utr && !isValidUPI_UTR(utr)) {
            return { status: '❌ FAKE APP DETECTED (Invalid UTR Year)', isAuto: false };
        }
        if (!toMag) return { status: '🚨 WRONG PAYEE (MAG ESPORTS match nahi hua)', isAuto: false };
        if (!utr) return { status: '⚠️ UTR MISSING (Manual Check)', isAuto: false };
        return { status: '✅ AUTO-VERIFIED', isAuto: true };
    }

    if (isSuccess) return { status: '⚠️ PARTIAL MATCH', isAuto: false };
    return { status: '❌ FAKE/INVALID', isAuto: false };
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
    let msg = `🎮 *${settings.scrimName} — LOBBY REGISTRATION*\n⏰ *Time:* ${settings.lobbyTime}\n━━━━━━━━━━━━━━━━━━━━\n\nKonsi lobby leni hai?\n\n`;
    const isMiniFull = !isSlotsAvailable('mini');
    const isMegaFull = !isSlotsAvailable('mega');
    const isLiveFull = !isSlotsAvailable('live');

    if (['all', 'both', 'mini', 'minilive'].includes(activeMode)) msg += `🟡 *MINI LOBBY* (4 Matches) - ` + (isMiniFull ? `🛑 *FULL*` : `₹${settings.miniPrice}`) + `\n`;
    if (['all', 'both', 'mega'].includes(activeMode)) msg += `🔵 *MEGA LOBBY* (6 Matches) - ` + (isMegaFull ? `🛑 *FULL*` : `₹${settings.megaPrice}`) + `\n`;
    if (['all', 'live', 'minilive'].includes(activeMode)) msg += `🔴 *LIVE LOBBY* (6 Matches) - ` + (isLiveFull ? `🛑 *FULL*` : `₹${settings.livePrice}`) + `\n`;

    msg += `\n━━━━━━━━━━━━━━━━━━━━\n👉 `;
    if (activeMode === 'all') msg += `*Mini*, *Mega* ya *Live* likh kar bhejo.`;
    else if (activeMode === 'both') msg += `*Mini* ya *Mega* likh kar bhejo.`;
    else if (activeMode === 'minilive') msg += `*Mini* ya *Live* likh kar bhejo.`;
    else msg += `*${activeMode.charAt(0).toUpperCase() + activeMode.slice(1)}* likh kar bhejo.`;
    msg += `\n━━━━━━━━━━━━━━━━━━━━`;
    return msg;
};

const sendLobbyInfo = async (to, lobbyType) => {
    let price = settings.miniPrice; let matches = '4 Matches'; let emoji = '🟡';
    if (lobbyType === 'Mega') { price = settings.megaPrice; matches = '6 Matches'; emoji = '🔵'; }
    if (lobbyType === 'Live') { price = settings.livePrice; matches = '6 Matches'; emoji = '🔴'; }

    if (lobbyType === 'Live' && fs.existsSync('./mega.png')) { await client.sendMessage(to, MessageMedia.fromFilePath('./mega.png')); }
    await client.sendMessage(to, `${emoji} *${lobbyType.toUpperCase()} LOBBY*\n⏰ *Time:* ${settings.lobbyTime}\n⚔️ *Format:* ${matches}\n━━━━━━━━━━━━━━━━━━━━\n💰 Entry Fee  : *₹${price}*\n━━━━━━━━━━━━━━━━━━━━\n👇 QR scan karke *₹${price}* pay karo aur screenshot bhejo.`);

    if (fs.existsSync('./qr.png')) {
        await client.sendMessage(to, MessageMedia.fromFilePath('./qr.png'), { caption: `📲 Scan & Pay *₹${price}* → Screenshot bhejo` });
        setQrReminder(to);
    }
};

const processVerification = async (msg, teamName, lobbyType, paymentData) => {
    const { media, status, utr, amount, imgHash, isAuto } = paymentData;
    const cleanNumber = await getRealNumber(msg);
    const rawId       = msg.from;

    let link = links.mini;
    if (lobbyType === 'Mega') link = links.mega;
    if (lobbyType === 'Live') link = links.live;

    const adminDetails = `Team: *${teamName}*\nLobby: *${lobbyType}*\nNumber: +${cleanNumber}\nID: ${rawId}\nUTR: ${utr || 'Not found'}\nAmount: ₹${amount || 'null'}`;

    if (isAuto || status === '✅ AUTO-VERIFIED') {
        if (isDuplicateUTR(utr)) {
            await sendAdminMedia(media, `⚠️ DUPLICATE UTR BLOCKED!\n${adminDetails}\n\nReply *ok* to force approve or *ban* to deny.`);
            return client.sendMessage(msg.from, "⚠️ Ye payment already register ho chuki hai. Admin check karega.");
        }
        saveRecord(teamName, cleanNumber, lobbyType, utr || 'N/A', amount || 'N/A', imgHash);
        await client.sendMessage(msg.from, `✅ *PAYMENT VERIFIED!*\nTeam: *${teamName}*\nLobby: *${lobbyType}*\n━━━━━━━━━━━━━━━━━━━━\n🔗 Group join karo 👇\n${link}`);
        await sendAdminMedia(media, `✅ AUTO-VERIFIED\n${adminDetails}\n\nReply *ban* to revoke.`);
    } else {
        await sendAdminMedia(media, `🚨 MANUAL CHECK REQUIRED\n${adminDetails}\nStatus: ${status}\n\nReply *ok* to approve or *ban* to deny.`);
        await client.sendMessage(msg.from, `⏳ *Payment manual check pe gaya.*\nAdmin verify karega. Thoda wait karo. 🙏`);
    }
};

const getRealNumber = async (msg) => { try { const c = await msg.getContact(); if (c?.number?.length >= 10) return c.number; } catch {} return msg.from.split('@')[0]; };
const sendAdminMedia = async (media, caption) => { try { if(media) await client.sendMessage(client.info.wid._serialized, media, { caption }); else await client.sendMessage(client.info.wid._serialized, caption); } catch {} };

// ─────────────────────────────────────────────────────
//  CLIENT EVENTS
// ─────────────────────────────────────────────────────
client.on('qr', qr => {
    console.log("RAW_QR_TEXT:", qr);
    qrcode.generate(qr, { small: true });
});
client.on('ready', ()  => log('INFO', '✅ BOT READY! ADVANCED OFFLINE TESSERACT ACTIVE.'));
client.on('auth_failure', m => log('ERROR', `Auth failed: ${m}`));
client.on('disconnected', reason => { log('WARN', `Disconnected: ${reason}. Reinitializing in 5s...`); setTimeout(() => client.initialize(), 5000); });

// ─────────────────────────────────────────────────────
//  MESSAGE HANDLER
// ─────────────────────────────────────────────────────
client.on('message_create', async msg => {
    try {
        const now = Math.floor(Date.now() / 1000);
        if ((now - msg.timestamp) > 60) return;

        if (msg.from.includes('@g.us') || msg.to.includes('@g.us')) return;

        const rawText   = msg.body.trim();
        const textLower = rawText.toLowerCase();
        const cmd       = textLower.split(/\s+/)[0];
        const isAdmin   = msg.fromMe || msg.from === client.info.wid._serialized;

        if (msg.isStatus) return;
        if (msg.fromMe && !rawText.startsWith('.') && !['ok', 'ban'].includes(textLower)) return;

        // ══════════════════════════════════════════
        //  ADMIN COMMANDS
        // ══════════════════════════════════════════
        if (isAdmin) {
            const replyAdmin = (text) => client.sendMessage(msg.from, text);
            
            if (cmd === '.broadcast' || cmd === '.bc') {
                const parts = rawText.split(/\s+/);
                const targetLobby = parts[1]?.toLowerCase();
                const bcMessage = parts.slice(2).join(' ');

                if (!targetLobby || !bcMessage) {
                    return replyAdmin('⚠️ Usage: .bc <mini/mega/live/all> <Your Message>');
                }

                const records = readRecords();
                let targets = [];

                if (targetLobby === 'all') {
                    targets = records;
                } else if (['mini', 'mega', 'live'].includes(targetLobby)) {
                    targets = records.filter(r => r.lobbyType?.toLowerCase() === targetLobby);
                } else {
                    return replyAdmin('⚠️ Invalid lobby. Use mini, mega, live, or all.');
                }

                if (targets.length === 0) {
                    return replyAdmin(`⚠️ Koi team ${targetLobby.toUpperCase()} lobby me register nahi hai.`);
                }

                await replyAdmin(`⏳ Broadcasting message to ${targets.length} teams...`);
                
                let successCount = 0;
                for (const team of targets) {
                    try {
                        const targetId = `${team.number.replace('+', '')}@c.us`;
                        const msgFormat = `📢 *${settings.scrimName} ANNOUNCEMENT*\nLobby: *${team.lobbyType.toUpperCase()}*\n━━━━━━━━━━━━━━━━━━━━\n\n${bcMessage}`;
                        await client.sendMessage(targetId, msgFormat);
                        successCount++;
                        await new Promise(res => setTimeout(res, 500)); 
                    } catch (e) {}
                }
                
                return replyAdmin(`✅ Broadcast successfully sent to ${successCount}/${targets.length} teams.`);
            }

            if (cmd === '.setname' || cmd === '.settitle') {
                const newName = rawText.slice(cmd.length).trim();
                if (newName) {
                    settings.scrimName = newName; saveSettings();
                    return replyAdmin(`✅ Scrim name updated to: *${newName}*`);
                }
                return replyAdmin('⚠️ Usage: .setname <New Name>');
            }
            if (cmd === '.setmodelive') {
                activeMode = 'minilive'; saveMode(); return replyAdmin(`✅ *Mode: MINILIVE (Mini & Live Lobby Only)*`);
            }
            if (cmd === '.setlink') {
                const parts = rawText.split(/\s+/); const type = parts[1]?.toLowerCase(); const linkMatch = rawText.match(/https?:\/\/[^\s]+/i);
                if (linkMatch && ['mini', 'mega', 'live'].includes(type)) { links[type] = linkMatch[0]; saveLinks(); return replyAdmin(`✅ *${type.toUpperCase()}* link updated.`); }
                return replyAdmin('⚠️ Usage: .setlink mini/mega/live <link>');
            }
            if (cmd === '.setprice') {
                const parts = rawText.split(/\s+/); const type = parts[1]?.toLowerCase(); const price = parts[2];
                if (type === 'mini' && price) { settings.miniPrice = price; saveSettings(); return replyAdmin(`✅ Mini price updated: ₹${price}`); }
                if (type === 'mega' && price) { settings.megaPrice = price; saveSettings(); return replyAdmin(`✅ Mega price updated: ₹${price}`); }
                if (type === 'live' && price) { settings.livePrice = price; saveSettings(); return replyAdmin(`✅ Live price updated: ₹${price}`); }
                return replyAdmin('⚠️ Usage: .setprice mini/mega/live <amount>');
            }
            if (cmd === '.setlobbytime' || cmd === '.settime') {
                const time = rawText.slice(cmd.length).trim();
                if (time) {
                    settings.lobbyTime = time; saveSettings(); completedUsers.clear();
                    return replyAdmin(`✅ Lobby time set to: *${time}*\n(Memory Reset: Purane players ab book kar sakte hain)`);
                }
                return replyAdmin('⚠️ Usage: .setlobbytime 9 PM');
            }
            if (cmd === '.setfull') {
                const type = rawText.split(/\s+/)[1]?.toLowerCase();
                if (['mini', 'mega', 'live'].includes(type)) {
                    if (!settings.closedLobbies.includes(type)) settings.closedLobbies.push(type);
                    saveSettings();
                    return replyAdmin(`🛑 *${type.toUpperCase()} Lobby* manually marked as FULL.`);
                }
                return replyAdmin('⚠️ Usage: .setfull mini/mega/live');
            }
            if (cmd === '.setopen') {
                const type = rawText.split(/\s+/)[1]?.toLowerCase();
                if (['mini', 'mega', 'live'].includes(type)) {
                    settings.closedLobbies = settings.closedLobbies.filter(l => l !== type);
                    saveSettings();
                    return replyAdmin(`✅ *${type.toUpperCase()} Lobby* is now OPEN.`);
                }
                return replyAdmin('⚠️ Usage: .setopen mini/mega/live');
            }
            if (cmd === '.list') {
                const records = readRecords(); if (!records.length) return replyAdmin('📋 No registrations yet.');
                const miniList = records.filter(r => r.lobbyType?.toLowerCase() === 'mini');
                const megaList = records.filter(r => r.lobbyType?.toLowerCase() === 'mega');
                const liveList = records.filter(r => r.lobbyType?.toLowerCase() === 'live');
                let out = `📋 *SLOTLIST*\n\n`;
                if (miniList.length) { out += `🟡 *MINI (${miniList.length}/${maxSlots})*\n`; miniList.forEach((r, i) => out += `${i+1}. ${r.teamName}\n`); }
                if (megaList.length) { out += `\n🔵 *MEGA (${megaList.length}/${maxSlots})*\n`; megaList.forEach((r, i) => out += `${i+1}. ${r.teamName}\n`); }
                if (liveList.length) { out += `\n🔴 *LIVE (${liveList.length}/${maxSlots})*\n`; liveList.forEach((r, i) => out += `${i+1}. ${r.teamName}\n`); }
                return replyAdmin(out);
            }
            if (cmd === '.clear') {
                localRecords = [];
                DailyRecord.deleteMany({}).catch(()=>{}); // Clear MongoDB completely
                completedUsers.clear(); settings.closedLobbies = []; saveSettings(); 
                return replyAdmin('🧹 Slotlist, Lobbies & User Memory cleared.'); 
            }
            if (cmd === '.stats') {
                const s = getStats(); return replyAdmin(`📊 *BOT STATS*\n━━━━━━━━━━━━━━━\nScrim Name       : ${settings.scrimName}\nTotal Registered : ${s.total}\nMini Slots       : ${s.mini}/${maxSlots}\nMega Slots       : ${s.mega}/${maxSlots}\nLive Slots       : ${s.live}/${maxSlots}\nActive Mode      : ${activeMode.toUpperCase()}\nClosed Lobbies   : ${settings.closedLobbies.length ? settings.closedLobbies.join(', ') : 'None'}\n━━━━━━━━━━━━━━━`);
            }
            if (cmd === '.setslots') {
                const n = parseInt(rawText.split(/\s+/)[1]); if (!isNaN(n) && n > 0) { maxSlots = n; return replyAdmin(`✅ Max slots per lobby: *${n}*`); }
            }
            if (cmd === '.setmode') {
                const val = rawText.split(/\s+/)[1]?.toLowerCase();
                if (!['mini', 'mega', 'live', 'both', 'all', 'minilive'].includes(val)) return replyAdmin(`⚠️ Usage: .setmode mini | mega | live | both | all | minilive`);
                activeMode = val; saveMode(); return replyAdmin(`✅ *Mode: ${activeMode.toUpperCase()}*`);
            }

            if (msg.hasQuotedMsg && (cmd === 'ok' || cmd === 'ban')) {
                const body = (await msg.getQuotedMessage()).body || '';
                let targetId = (body.match(/ID:\s*(\S+)/) || [])[1];
                const cleanNumber = (body.match(/Number:\s*\+?(\d+)/) || [])[1] || (targetId ? targetId.split('@')[0] : null);
                if (cleanNumber && (!targetId || targetId.includes('@lid'))) { targetId = `${cleanNumber}@c.us`; }
                if (targetId) {
                    const teamName = (body.match(/Team:\s*\*?([^\n*]+)\*?/) || [])[1]?.trim() || 'Unknown';
                    const lobbyType = (body.match(/Lobby:\s*\*?([^\n*]+)\*?/i) || [])[1]?.trim() || 'Mini';
                    if (cmd === 'ok') {
                        saveRecord(teamName, cleanNumber, lobbyType, 'N/A', 'N/A', 'MANUAL_OK');
                        let link = links.mini; if(lobbyType.includes('Mega')) link=links.mega; if(lobbyType.includes('Live')) link=links.live;
                        await client.sendMessage(targetId, `✅ *VERIFIED BY ADMIN!*\nTeam: *${teamName}*\n🔗 Link: ${link}`);
                        return replyAdmin(`✅ Approved: ${teamName}`);
                    }
                    if (cmd === 'ban') {
                        if (body.includes('AUTO-VERIFIED')) removeRecord(cleanNumber);
                        completedUsers.delete(targetId);
                        await client.sendMessage(targetId, `🚫 *Payment Rejected!*\nSahi screenshot bhejo ya admin se contact karo.`);
                        return replyAdmin(`🚫 Rejected: ${teamName}`);
                    }
                }
            }
            const adminCmds = ['.setname','.settitle','.broadcast','.bc','.setlink','.setprice','.list','.clear','.stats','.setslots','.setmode','.setlobbytime','.settime','.setfull','.setopen','.setmodelive','ok','ban'];
            if (adminCmds.includes(cmd)) return;
        }

        // ══════════════════════════════════════════
        //  PLAYER BLOCK
        // ══════════════════════════════════════════
        if (isRateLimited(msg.from)) return;

        if (antiSpam.has(msg.from)) return;
        antiSpam.add(msg.from);
        setTimeout(() => antiSpam.delete(msg.from), 1000);

        const extractNumbers = (str) => (String(str).match(/\d+/g) || []);
        const miniPrices = extractNumbers(settings.miniPrice);
        const megaPrices = extractNumbers(settings.megaPrice);
        const livePrices = extractNumbers(settings.livePrice);
        const allPrices = [...miniPrices, ...megaPrices, ...livePrices];
        const textHasNumber = (pricesArr, text) => pricesArr.some(p => new RegExp(`\\b${p}\\b`).test(text));

        const pData = pendingPayments[msg.from];
        const isWaitingText = (pData?.state === 'AWAITING_LOBBY' || pData?.state === 'AWAITING_TEAM_NAME');

        // 🔥 HYPER AGGRESSIVE KEYWORD DETECTION 🔥
        let wantsMini = textLower.includes('mini') || textLower === '1' || textHasNumber(miniPrices, textLower);
        let wantsMega = textLower.includes('mega') || textLower === '2' || textHasNumber(megaPrices, textLower);
        let wantsLive = textLower.includes('live') || textLower === '3' || textHasNumber(livePrices, textLower);

        if (!['all', 'both', 'mini', 'minilive'].includes(activeMode)) wantsMini = false;
        if (!['all', 'both', 'mega'].includes(activeMode)) wantsMega = false;
        if (!['all', 'live', 'minilive'].includes(activeMode)) wantsLive = false;

        const asksQR = /qr|scan|pay|upi|kese|kaise|bhejo|number|send|chahiye|chaiye|chyie|bar code|scanner|gpay|paytm|phonepe|bhejna|fee|price|amount|entry/i.test(textLower);
        const isPriceNumber = textHasNumber(allPrices, textLower);
        const hasDirectIntent = wantsMini || wantsMega || wantsLive || asksQR || isPriceNumber;

        if (!seenUsers.has(msg.from) && !msg.hasMedia) {
            seenUsers.add(msg.from);
            if (!isWaitingText && !hasDirectIntent) {
                return client.sendMessage(msg.from, getWelcomeMessage());
            }
        }

        if (pData && !msg.hasMedia) {
            if (pData.state === 'AWAITING_LOBBY') {
                if (!wantsMini && !wantsMega && !wantsLive) return client.sendMessage(msg.from, `⚠️ Sahi lobby select karo.`);
                const lobbyType = wantsLive ? 'Live' : (wantsMega ? 'Mega' : 'Mini');

                pData.lobbyType = lobbyType; pData.state = 'AWAITING_TEAM_NAME'; touchSession(msg.from);
                return client.sendMessage(msg.from, `✅ *${lobbyType} Lobby* select ki!\n\nApna *Team Name* bhejo:`);
            }

            if (pData.state === 'AWAITING_TEAM_NAME') {
                if (isInvalidName(rawText)) return client.sendMessage(msg.from, '⚠️ Ek proper *Team Name* bhejo.');
                if (isDuplicateTeam(rawText, pData.lobbyType)) return client.sendMessage(msg.from, `⚠️ Ye Team Name (*${rawText}*) already *${pData.lobbyType} Lobby* me registered hai!\nKoi doosra naam bhejo:`);
                if (!isSlotsAvailable(pData.lobbyType)) { clearSession(msg.from); return client.sendMessage(msg.from, `🛑 *${pData.lobbyType} lobby full ho gayi hai!*`); }

                clearQrReminder(msg.from);
                clearSession(msg.from);
                completedUsers.add(msg.from);
                return await processVerification(msg, rawText, pData.lobbyType, pData);
            }
        }

        // ── Screenshot / FAST TESSERACT OCR ──
        if (msg.hasMedia && msg.type === 'image') {

            clearQrReminder(msg.from);
            const media = await msg.downloadMedia();
            const imgHash = crypto.createHash('md5').update(media.data).digest('hex');
            if (isDuplicateHash(imgHash)) return client.sendMessage(msg.from, "⚠️ Bhai ye screenshot pehle hi kisi dusri team ne register kar liya hai! Ek photo do baar use nahi ho sakti. 🚫");

            await client.sendMessage(msg.from, '⏳ Screenshot check ho raha hai...');
            try {
                const buffer = Buffer.from(media.data, 'base64');
                const { data: { text, confidence } } = await (await getOCRWorker()).recognize(buffer);

                const utr = extractUTR(text);
                const amount = extractAmount(text);
                const resultObj = analyzeOCR(text, utr, amount);

                if (Math.round(confidence) < OCR_MIN_CONF && resultObj.status === '✅ AUTO-VERIFIED') {
                    resultObj.status = '⚠️ LOW IMAGE QUALITY (Manual Check)';
                    resultObj.isAuto = false;
                }

                let detectedLobby = null;
                if (amount) {
                    if (miniPrices.includes(String(amount)) && ['all', 'both', 'mini', 'minilive'].includes(activeMode)) detectedLobby = 'Mini';
                    else if (megaPrices.includes(String(amount)) && ['all', 'both', 'mega'].includes(activeMode)) detectedLobby = 'Mega';
                    else if (livePrices.includes(String(amount)) && ['all', 'live', 'minilive'].includes(activeMode)) detectedLobby = 'Live';
                }

                if (pData && pData.state === 'AWAITING_SS' && pData.lobbyType) {
                    if (detectedLobby && detectedLobby !== pData.lobbyType) {
                        resultObj.status = `🚨 AMOUNT MISMATCH (Paid ₹${amount}, wanted ${pData.lobbyType})`;
                        resultObj.isAuto = false;
                    }
                    detectedLobby = pData.lobbyType;
                }

                if (!detectedLobby && !['all', 'both', 'minilive'].includes(activeMode)) detectedLobby = activeMode.charAt(0).toUpperCase() + activeMode.slice(1);

                if (detectedLobby) {
                    pendingPayments[msg.from] = { media, status: resultObj.status, isAuto: resultObj.isAuto, utr, amount, imgHash, state: 'AWAITING_TEAM_NAME', lobbyType: detectedLobby };
                    touchSession(msg.from);
                    return client.sendMessage(msg.from, `✅ Screenshot mila! (₹${amount || '?'})\nLobby: *${detectedLobby}*\n\n👉 Verification ke liye apna *Team Name* bhejo:`);
                } else {
                    pendingPayments[msg.from] = { media, status: resultObj.status, isAuto: resultObj.isAuto, utr, amount, imgHash, state: 'AWAITING_LOBBY', lobbyType: null };
                    touchSession(msg.from);
                    let askMsg = `✅ Screenshot receive ho gaya!\nKaunsi lobby leni hai?\n👉 `;
                    if (activeMode === 'all') askMsg += `Type: *Mini*, *Mega* ya *Live*`;
                    else if (activeMode === 'both') askMsg += `Type: *Mini* ya *Mega*`;
                    else if (activeMode === 'minilive') askMsg += `Type: *Mini* ya *Live*`;
                    else askMsg += `Type: *${activeMode.charAt(0).toUpperCase() + activeMode.slice(1)}*`;
                    return client.sendMessage(msg.from, askMsg);
                }
            } catch (e) {
                await resetOCRWorker();
                pendingPayments[msg.from] = { media: null, status: '❌ OCR SCAN FAILED', state: 'AWAITING_LOBBY' }; touchSession(msg.from);
                return client.sendMessage(msg.from, `⚠️ Screenshot scan me error aayi. Please lobby select karein.`);
            }
        }

        // ── SMART KEYWORDS ──
        if (!msg.hasMedia && !isWaitingText && rawText.length > 0) {
            if (hasDirectIntent) {
                if (completedUsers.has(msg.from) && !/qr|pay|scan|upi|mini|mega|live/i.test(textLower)) return;

                let targetLobby = null;
                if (wantsLive) targetLobby = 'Live';
                else if (wantsMega) targetLobby = 'Mega';
                else if (wantsMini) targetLobby = 'Mini';

                pendingPayments[msg.from] = { state: 'AWAITING_SS', lobbyType: targetLobby };
                touchSession(msg.from);

                if (targetLobby) {
                    if (!isSlotsAvailable(targetLobby)) return client.sendMessage(msg.from, `😔 *${targetLobby} lobby full ho gayi hai!*`);
                    return await sendLobbyInfo(msg.from, targetLobby);
                } else {
                    if (fs.existsSync('./qr.png')) {
                        const qrImg = MessageMedia.fromFilePath('./qr.png');
                        let captionText = `👇 *SCAN & PAY*\n⏰ *Lobby Time:* ${settings.lobbyTime}\n\n`;
                        if (['all', 'both', 'mini', 'minilive'].includes(activeMode)) captionText += `🟡 *Mini:* ${settings.miniPrice.includes('/') ? '₹'+settings.miniPrice.replace('/', ' / ₹') : '₹'+settings.miniPrice}\n`;
                        if (['all', 'both', 'mega'].includes(activeMode)) captionText += `🔵 *Mega:* ${settings.megaPrice.includes('/') ? '₹'+settings.megaPrice.replace('/', ' / ₹') : '₹'+settings.megaPrice}\n`;
                        if (['all', 'live', 'minilive'].includes(activeMode)) captionText += `🔴 *Live:* ₹${settings.livePrice}\n`;
                        captionText += `\nPay karke screenshot bhejein.`;

                        await client.sendMessage(msg.from, qrImg, { caption: captionText });
                        setQrReminder(msg.from);
                        return;
                    } else return client.sendMessage(msg.from, '⚠️ QR image missing.');
                }
            }

            const welcomeRegex = /\b(hi|hello|hey|menu|book|slot|slots|register|tourney|tournament|\?|help|details)\b/i;
            if (welcomeRegex.test(textLower)) {
                if (!completedUsers.has(msg.from)) {
                    return client.sendMessage(msg.from, getWelcomeMessage());
                }
            }
        }

    } catch (e) {
        log('ERROR', `Handler error: ${e.message}`);
    }
});

// Midnight Cron: Updated for MongoDB
cron.schedule('0 0 * * *', async () => {
    localRecords = [];
    try { await DailyRecord.deleteMany({}); } catch (e) {} // Auto-clear DB every night
    settings.closedLobbies = [];
    saveSettings();
    seenUsers.clear();
    completedUsers.clear();
}, { timezone: 'Asia/Kolkata' });

client.initialize();
