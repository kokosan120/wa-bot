const express = require('express');
const app = express();
let webQR = "Wait... QR is generating...";

app.get('/', (req, res) => {
    if (webQR.includes('@')) {
        res.send(`<h2>Scan this from WhatsApp:</h2><img src="https://api.qrserver.com/v1/create-qr-code/?size=350x350&data=${encodeURIComponent(webQR)}"> <br><p>Refresh this page if the QR expires.</p>`);
    } else {
        res.send(`<h2>${webQR}</h2>`);
    }
});
app.listen(process.env.PORT || 3000, () => console.log('Web server is ready!'));

const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const fs = require('fs');
const Tesseract = require('tesseract.js'); 
const cron = require('node-cron');
const crypto = require('crypto');

process.on('unhandledRejection', e => console.error('⚠️ Rejection:', e.message));
process.on('uncaughtException',  e => console.error('⚠️ Exception:', e.message));

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: { args: ['--no-sandbox', '--disable-setuid-sandbox'], headless: true, timeout: 60000 }
});

const botStartTime = Math.floor(Date.now() / 1000);

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

const readRecords      = () => safeRead('./records.json', []);
const getSlotCount     = (type) => readRecords().filter(r => r.lobbyType?.toLowerCase() === type?.toLowerCase()).length;
const isSlotsAvailable = (type) => { if (settings.closedLobbies.includes(type.toLowerCase())) return false; return getSlotCount(type) < maxSlots; };

const saveRecord = (teamName, number, lobbyType, utr = 'N/A', amount = 'N/A', imgHash = 'N/A') => {
    const records = readRecords();
    records.push({ teamName, number: `+${number}`, lobbyType, utr, amount, imgHash, timestamp: new Date().toLocaleString('en-IN') });
    safeWrite('./records.json', records);
};

const removeRecord = (number) => {
    const records  = readRecords();
    const filtered = records.filter(r => r.number !== `+${number}` && r.number !== number);
    safeWrite('./records.json', filtered);
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

client.on('qr', qr => {
    webQR = qr;
    console.log("👉 Go to your Render link to scan the QR!");
});
client.on('ready', () => {
    webQR = "✅ BOT IS LIVE! You can close this page.";
    log('INFO', '✅ BOT READY!');
});
client.on('auth_failure', m => log('ERROR', `Auth failed: ${m}`));
client.on('disconnected', reason => { log('WARN', `Disconnected: ${reason}. Reinitializing in 5s...`); setTimeout(() => client.initialize(), 5000); });

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

        if (isAdmin) {
            const replyAdmin = (text) => client.sendMessage(msg.from, text);
            if (cmd === '.setname') { settings.scrimName = rawText.slice(cmd.length).trim(); saveSettings(); return replyAdmin(`✅ Name updated.`); }
        }
    } catch (e) {
        log('ERROR', `Handler error: ${e.message}`);
    }
});

cron.schedule('0 0 * * *', () => {
    safeWrite('./records.json', []);
    settings.closedLobbies = [];
    saveSettings();
    seenUsers.clear();
    completedUsers.clear();
}, { timezone: 'Asia/Kolkata' });

client.initialize();
