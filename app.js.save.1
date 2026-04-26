const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const Tesseract = require('tesseract.js');
const cron = require('node-cron');

// ─────────────────────────────────────────────────────
//  CRASH PROTECTION
// ─────────────────────────────────────────────────────
process.on('unhandledRejection', e => console.error('⚠️ Rejection:', e.message));
process.on('uncaughtException',  e => console.error('⚠️ Exception:',  e.message));

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: { args: ['--no-sandbox', '--disable-setuid-sandbox'] }
});

// ─────────────────────────────────────────────────────
//  STATE
// ─────────────────────────────────────────────────────
const pendingPayments = {};
const qrTimers        = {};
const recentlyPaid    = new Set();
const antiSpam        = new Set();
const seenUsers       = new Set();   // first-time greeting tracker

let maxSlots        = 24;
let manualLobbyTime = null;   // override with .settime

const VALID_AMOUNTS         = ['25', '30', '32', '35', '50', '60'];
const OCR_MIN_CONFIDENCE    = 35;
const AUTO_VERIFY_MIN_SCORE = 7;
const qrKeywords = ['qr','scan','scanner','pay','payment','upi','number','kese','kaise','25','30'];

// ─────────────────────────────────────────────────────
//  PERSISTENT TESSERACT WORKER
// ─────────────────────────────────────────────────────
let _ocrWorker = null;

const getOCRWorker = async () => {
    if (!_ocrWorker) {
        _ocrWorker = await Tesseract.createWorker('eng', 1, { logger: () => {} });
        await _ocrWorker.setParameters({
            tessedit_pageseg_mode: '11',
            preserve_interword_spaces: '1',
        });
    }
    return _ocrWorker;
};

const resetOCRWorker = async () => {
    try { if (_ocrWorker) await _ocrWorker.terminate(); } catch {}
    _ocrWorker = null;
};

process.on('SIGINT', async () => { await resetOCRWorker(); process.exit(0); });

// ─────────────────────────────────────────────────────
//  COOL FEATURES — typing simulation + reactions
// ─────────────────────────────────────────────────────

// Shows "typing..." before every reply — feels human
const simulateTyping = async (chatId, ms = 1200) => {
    try {
        const chat = await client.getChatById(chatId);
        await chat.sendStateTyping();
        await new Promise(r => setTimeout(r, ms));
        await chat.clearState();
    } catch {}
};

// React to messages with emoji
const reactTo = async (msg, emoji) => {
    try { await msg.react(emoji); } catch {}
};

// ─────────────────────────────────────────────────────
//  CONTACT HELPERS  (fixes @lid number issue)
// ─────────────────────────────────────────────────────
const getRealNumber = async (msg) => {
    try {
        const c = await msg.getContact();
        if (c?.number?.length >= 10) return c.number;
    } catch {}
    return msg.from.split('@')[0];
};

const getRealNumberFromId = async (id) => {
    try {
        const c = await client.getContactById(id);
        if (c?.number?.length >= 10) return c.number;
    } catch {}
    return id.split('@')[0];
};

const getContactName = async (msg) => {
    try {
        const c = await msg.getContact();
        return c.pushname || c.name || null;
    } catch {}
    return null;
};

// ─────────────────────────────────────────────────────
//  FILE HELPERS
// ─────────────────────────────────────────────────────
const readRecords = () => {
    try {
        if (fs.existsSync('./records.json')) return JSON.parse(fs.readFileSync('./records.json'));
    } catch {}
    return [];
};

const saveRecord = (teamName, number, utr = 'N/A', amount = 'N/A') => {
    const records = readRecords();
    records.push({
        teamName,
        number   : `+${number}`,
        utr,
        amount,
        timestamp: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
    });
    fs.writeFileSync('./records.json', JSON.stringify(records, null, 2));
};

const removeRecord = (number) => {
    const records = readRecords();
    fs.writeFileSync('./records.json', JSON.stringify(
        records.filter(r => r.number !== `+${number}` && r.number !== number), null, 2
    ));
};

const isDuplicateUTR = (utr) => {
    if (!utr || utr === 'N/A') return false;
    return readRecords().some(r => r.utr === utr);
};

// ─────────────────────────────────────────────────────
//  BLACKLIST SYSTEM
// ─────────────────────────────────────────────────────
const readBlacklist = () => {
    try {
        if (fs.existsSync('./blacklist.json')) return JSON.parse(fs.readFileSync('./blacklist.json'));
    } catch {}
    return [];
};

const isBlacklisted = (number) => {
    const list = readBlacklist();
    return list.some(n => n === number || n === `+${number}` || n === number.replace('+', ''));
};

const addToBlacklist = (number) => {
    const clean = number.replace('+', '');
    const list  = readBlacklist();
    if (list.includes(clean)) return false;
    list.push(clean);
    fs.writeFileSync('./blacklist.json', JSON.stringify(list, null, 2));
    return true;
};

const removeFromBlacklist = (number) => {
    const clean    = number.replace('+', '');
    const filtered = readBlacklist().filter(n => n !== clean);
    fs.writeFileSync('./blacklist.json', JSON.stringify(filtered, null, 2));
};

// ─────────────────────────────────────────────────────
//  SLOT HELPERS  (live urgency counter)
// ─────────────────────────────────────────────────────
const getSlotsLeft = () => Math.max(0, maxSlots - readRecords().length);

const getUrgencyText = () => {
    const left = getSlotsLeft();
    if (left === 0)  return `🛑 *SLOTS FULL HAI!*`;
    if (left <= 3)   return `🔥 *SIRF ${left} SLOT BACHI HAI! ABHI BOOK KRO!*`;
    if (left <= 7)   return `⚡ *Sirf ${left} slots baki hain! Jaldi karo!*`;
    return `✅ *${left} slots available*`;
};

// ─────────────────────────────────────────────────────
//  OCR UTILITIES
// ─────────────────────────────────────────────────────
const extractUTR = (text) => {
    const patterns = [
        /\b(T\d{11})\b/i,
        /UTR[:\s#]*([A-Z0-9]{10,22})/i,
        /Ref(?:erence)?\.?\s*(?:No\.?|ID|Number)?[:\s]*([A-Z0-9]{8,22})/i,
        /Transaction\s*(?:ID|No\.?|Ref\.?)[:\s]*([A-Z0-9]{8,22})/i,
        /UPI\s*(?:Ref(?:\.?\s*No)?|Txn\.?|ID)[:\s]*([A-Z0-9]{8,22})/i,
        /Order\s*(?:ID|No\.?)[:\s]*([A-Z0-9]{8,22})/i,
        /\b([A-Z]{2,4}\d{9,14})\b/, /\b(\d{12})\b/, /\b(\d{16})\b/,
    ];
    for (const p of patterns) {
        const m = text.match(p);
        if (m?.[1]?.length >= 8) return m[1].toUpperCase();
    }
    return null;
};

const extractAmount = (rawText) => {
    const text = rawText.replace(/,/g, '');
    const labeled = [
        /(?:Amount\s*(?:Paid)?|Paid|Total(?:\s*Amount)?|Payment)[:\s]*(?:₹|Rs\.?|INR)?\s*(\d+(?:\.\d{1,2})?)/i,
        /(?:₹|Rs\.?|INR)\s*(\d+(?:\.\d{1,2})?)/i,
    ];
    for (const p of labeled) {
        const m = text.match(p);
        if (m) return String(parseInt(m[1], 10));
    }
    for (const m of text.matchAll(/\b(\d{2,4})\.0{1,2}\b/g)) if (VALID_AMOUNTS.includes(m[1])) return m[1];
    for (const m of text.matchAll(/\b(\d{2,4})\b/g))          if (VALID_AMOUNTS.includes(m[1])) return m[1];
    return null;
};

const hasRecentDate = (t) => {
    const MONTHS = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
    const now = new Date();
    for (const offset of [0, -1]) {
        const d   = new Date(now); d.setDate(d.getDate() + offset);
        const day = String(d.getDate());
        const mon = MONTHS[d.getMonth()];
        const mm  = String(d.getMonth() + 1);
        const mmP = mm.padStart(2, '0');
        if (!t.includes(day)) continue;
        if ([mon, `/${mm}/`, `-${mm}-`, `/${mmP}/`, `-${mmP}-`].some(s => t.includes(s))) return true;
    }
    return false;
};

const analyzeOCR = (rawText, utr, amount) => {
    const t = rawText.toLowerCase();
    const checks = {
        hasSuccess : { w: 3, pass: /success|paid|completed|approved|received|payment\s*done/i.test(t) },
        hasDate    : { w: 2, pass: hasRecentDate(t) },
        hasUPI     : { w: 2, pass: /upi|phonepe|gpay|google\s*pay|paytm|bhim/i.test(t) },
        hasUTR     : { w: 2, pass: !!utr },
        isValid    : { w: 2, pass: !!(amount && VALID_AMOUNTS.includes(amount)) },
        hasMag     : { w: 1, pass: /mag\s*esports/i.test(t) },
    };
    const earned = Object.values(checks).reduce((s, c) => s + (c.pass ? c.w : 0), 0);
    let status;
    if (checks.hasSuccess.pass && earned >= AUTO_VERIFY_MIN_SCORE) status = '✅ AUTO-VERIFIED';
    else if (checks.hasSuccess.pass && earned >= 4)                status = '⚠️ PARTIAL MATCH';
    else                                                            status = '❌ FAKE/OLD';
    return { status };
};

const isInvalidName = (name) => {
    const lower = name.toLowerCase().trim();
    const bad = ['ok','done','yes','ha','hmm','hi','hello','bhai','bro','qr','pay','payment',
                 'ss','screenshot','mera','slot','book','please','plz','team','naam','name','jaldi'];
    if (lower.length < 2)           return true;
    if (bad.includes(lower))        return true;
    if (/^[\d\s\W_]+$/.test(lower)) return true;
    if (/^(.)\1{2,}$/.test(lower))  return true;
    if (['asdf','qwer','zxcv','hjkl','abcd'].some(w => lower.includes(w))) return true;
    return false;
};

// ─────────────────────────────────────────────────────
//  DYNAMIC CONTENT
// ─────────────────────────────────────────────────────
let currentGroupLink = 'https://chat.whatsapp.com/B7tUu0lr2OjHTmtMTtAP3B';
if (fs.existsSync('./link.txt')) currentGroupLink = fs.readFileSync('./link.txt', 'utf8').trim();

const getLobbyTime = () => {
    if (manualLobbyTime) return manualLobbyTime;
    const h = parseInt(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata', hour: '2-digit', hour12: false }), 10);
    if (h < 12) return '12 PM'; if (h < 15) return '3 PM';
    if (h < 18) return '6 PM';  if (h < 21) return '9 PM';
    return '12 PM';
};

const getDynamicBrochure = () => {
    const left        = getSlotsLeft();
    const urgencyLine = left <= 7 ? `\n\n${getUrgencyText()}` : '';
    return (
        `*MAG ESPORTS* |\n` +
        `\`\`\`BUY LOBBY GET PURCHASE POINTS\`\`\`\n\n` +
        `\`❗${getLobbyTime()} MINI LOBBY\` 🗽\n` +
        `(\`\`\`B2B 4 MATCHES | B/K/P/S\`\`\`)\n\n` +
        `  *ENTRY/ PP*\n    \`👇 / 👇\`\n` +
        `📌 ₹25 / 220\n📌 ₹30 / 270\n\n` +
        `\`⚖️💸(PP DISTRIBUTION )\`\n` +
        `* *₹25 -100 / 70 / 50*=220\n` +
        `* *₹30 -130 / 80 / 60*=270` +
        urgencyLine +
        `\n\n*Book Kaise Karein?*\n` +
        `'QR' likh kar payment karo aur screenshot ke sath *Team Name* bhejein.\n\n` +
        `*_DM 9332777859 FOR SLOT_*`
    );
};

// ─────────────────────────────────────────────────────
//  ADMIN MESSAGE HELPER
// ─────────────────────────────────────────────────────
const sendAdminMsg = async (media, caption) => {
    try {
        if (media) await client.sendMessage(client.info.wid._serialized, media, { caption });
        else       await client.sendMessage(client.info.wid._serialized, caption);
    } catch {}
};

// ─────────────────────────────────────────────────────
//  CORE VERIFICATION
// ─────────────────────────────────────────────────────
const processVerification = async (msg, teamName, paymentData) => {
    const { media, status, utr, amount } = paymentData;
    const cleanNumber = await getRealNumber(msg);
    const displayNum  = `+${cleanNumber}`;
    const rawId       = msg.from;
    const left        = getSlotsLeft();

    // ── AUTO-VERIFY ────────────────────────────────
    if (status === '✅ AUTO-VERIFIED') {
        if (isDuplicateUTR(utr)) {
            await sendAdminMsg(media,
                `⚠️ DUPLICATE UTR BLOCKED!\nTeam: *${teamName}*\nNumber: ${displayNum}\nID: ${rawId}\n` +
                `UTR: ${utr}\n\nReply *'ok'* to force approve or *'ban'* to deny.`
            );
            await reactTo(msg, '⚠️');
            await simulateTyping(msg.from, 800);
            return msg.reply("⚠️ Ye payment already use ho chuki hai. Admin check karega.");
        }

        saveRecord(teamName, cleanNumber, utr || 'N/A', amount || 'N/A');
        await reactTo(msg, '✅');

        // Mention slot urgency if running low
        const friendNote = (left - 1 > 0 && left - 1 <= 5) ? `\n\n⚡ Sirf *${left - 1} slots* baki hain! Dosto ko bhi batao!` : '';
        await simulateTyping(msg.from, 1200);
        await msg.reply(`✅ *PAYMENT VERIFIED!*\n*Team:* ${teamName}\n\nGroup join karo 👇\n${currentGroupLink}${friendNote}`);
        await sendAdminMsg(media,
            `✅ AUTO-VERIFIED ✅\nTeam: *${teamName}*\nNumber: ${displayNum}\nID: ${rawId}\n` +
            `UTR: ${utr || 'N/A'}\nSlots Left: ${left - 1}/${maxSlots}\n\n` +
            `Reply *'ban'* to revoke & remove record.`
        );

    // ── MANUAL REVIEW ──────────────────────────────
    } else {
        await reactTo(msg, '👀');
        await sendAdminMsg(media,
            `🚨 MANUAL VERIFICATION REQUIRED\nTeam: *${teamName}*\nNumber: ${displayNum}\nID: ${rawId}\n` +
            `Status: ${status}\nUTR: ${utr || 'Not found'}\n\n` +
            `Reply *'ok'* to approve or *'ban'* to deny.`
        );
        await simulateTyping(msg.from, 900);
        await msg.reply("⏳ Screenshot admin ko bhej diya hai. Thoda wait karo, jaldi verify hoga.");
    }
};

// ─────────────────────────────────────────────────────
//  BOT EVENTS
// ─────────────────────────────────────────────────────
client.on('qr',    qr => { qrcode.generate(qr, { small: true }); console.log('👆 Scan QR to login.'); });
client.on('ready', ()  => console.log('✅ MAG ESPORTS BOT IS READY!'));

// ─────────────────────────────────────────────────────
//  MESSAGE HANDLER
// ─────────────────────────────────────────────────────
client.on('message_create', async msg => {
    try {
        const isFromMe  = msg.fromMe;
        const rawText   = msg.body.trim();
        const textLower = rawText.toLowerCase();

        // ══════════════════════════════════════════
        //  ADMIN COMMANDS
        // ══════════════════════════════════════════
        if (isFromMe) {

            // .help — all commands list
            if (textLower === '.help') {
                return msg.reply(
                    `*🤖 ADMIN COMMANDS*\n\n` +
                    `*📋 Records:*\n` +
                    `*.list* — Aaj ki entries\n` +
                    `*.stats* — Full stats\n` +
                    `*.slots* — Quick slot count\n` +
                    `*.export* — Records export\n` +
                    `*.clear* — Records clear\n\n` +
                    `*⚙️ Settings:*\n` +
                    `*.setlink <url>* — Group link change\n` +
                    `*.setslots <n>* — Max slots change\n` +
                    `*.settime <time>* — Lobby time set\n\n` +
                    `*📢 Broadcast:*\n` +
                    `*.broadcast <msg>* — Sab verified users ko message\n\n` +
                    `*🚫 Blacklist:*\n` +
                    `*.blacklist <number>* — User block\n` +
                    `*.unblacklist <number>* — User unblock\n` +
                    `*.blacklistshow* — List dekhna\n\n` +
                    `*💬 Reply Commands (quote karke type karo):*\n` +
                    `*ok* — Payment approve\n` +
                    `*ban* — Payment reject / revoke`
                );
            }

            // .setlink
            if (textLower.startsWith('.setlink')) {
                const m = rawText.match(/https?:\/\/[^\s]+/i);
                if (m) {
                    currentGroupLink = m[0];
                    fs.writeFileSync('./link.txt', currentGroupLink);
                    return msg.reply(`✅ Group link updated!\n${currentGroupLink}`);
                }
                return msg.reply('⚠️ Usage: .setlink https://chat.whatsapp.com/xxx');
            }

            // .setslots
            if (textLower.startsWith('.setslots')) {
                const n = parseInt(rawText.split(' ')[1]);
                if (!isNaN(n) && n > 0) {
                    maxSlots = n;
                    return msg.reply(`✅ Max slots → *${maxSlots}*\n${getUrgencyText()}`);
                }
                return msg.reply('⚠️ Usage: .setslots 24');
            }

            // .settime
            if (textLower.startsWith('.settime')) {
                const t = rawText.substring('.settime'.length).trim();
                if (t) {
                    manualLobbyTime = t;
                    return msg.reply(`✅ Lobby time → *${t}*\nBrochure ab yahi dikhayega.`);
                }
                return msg.reply('⚠️ Usage: .settime 3 PM');
            }

            // .slots — quick status
            if (textLower === '.slots') {
                const records = readRecords();
                return msg.reply(
                    `🗽 *SLOT STATUS*\n\n` +
                    `Filled : *${records.length}/${maxSlots}*\n` +
                    `Left   : *${getSlotsLeft()}*\n\n` +
                    getUrgencyText()
                );
            }

            // .list
            if (textLower === '.list') {
                const records = readRecords();
                let out = `*📋 TODAY'S SLOTLIST (${records.length}/${maxSlots})*\n\n`;
                records.forEach((r, i) => { out += `${i + 1}. *${r.teamName}* | ${r.number}\n`; });
                if (!records.length) out += 'Koi entry nahi abhi tak.';
                return msg.reply(out);
            }

            // .stats
            if (textLower === '.stats') {
                const records  = readRecords();
                const totalAmt = records.reduce((s, r) => s + (parseInt(r.amount) || 0), 0);
                return msg.reply(
                    `*📊 TODAY'S STATS*\n\n` +
                    `Slots Filled : *${records.length}/${maxSlots}*\n` +
                    `Slots Left   : *${getSlotsLeft()}*\n` +
                    `Total Amount : *₹${totalAmt}*\n` +
                    `Pending      : *${Object.keys(pendingPayments).length}*\n` +
                    `Lobby Time   : *${getLobbyTime()}*\n\n` +
                    getUrgencyText()
                );
            }

            // .export — clean formatted export
            if (textLower === '.export') {
                const records = readRecords();
                if (!records.length) return msg.reply('📭 No records to export.');
                const date = new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' });
                let out = `📤 *EXPORT — ${date}*\n\n`;
                records.forEach((r, i) => {
                    out += `${i + 1}. *${r.teamName}*\n   📞 ${r.number} | 🕐 ${r.timestamp}\n\n`;
                });
                out += `─────────────────\nTotal: ${records.length} entries`;
                return msg.reply(out);
            }

            // .clear
            if (textLower === '.clear') {
                fs.writeFileSync('./records.json', JSON.stringify([]));
                return msg.reply('🧹 Records cleared manually.');
            }

            // .broadcast — message all verified users
            if (textLower.startsWith('.broadcast ')) {
                const message = rawText.substring('.broadcast '.length).trim();
                if (!message) return msg.reply('⚠️ Usage: .broadcast <message>');
                const records = readRecords();
                if (!records.length) return msg.reply('No verified users to broadcast to.');
                let sent = 0, failed = 0;
                await msg.reply(`📢 Broadcasting to ${records.length} users...`);
                for (const r of records) {
                    try {
                        const num = r.number.replace('+', '');
                        await client.sendMessage(`${num}@c.us`, message);
                        sent++;
                        await new Promise(res => setTimeout(res, 1500)); // rate-limit safe delay
                    } catch { failed++; }
                }
                return msg.reply(`📢 *Broadcast Done!*\n✅ Sent: ${sent}\n❌ Failed: ${failed}`);
            }

            // .blacklist <number>
            if (textLower.startsWith('.blacklist ')) {
                const num = rawText.split(' ')[1]?.replace('+', '');
                if (!num) return msg.reply('⚠️ Usage: .blacklist 919876543210');
                if (addToBlacklist(num)) return msg.reply(`🚫 *+${num}* blacklisted.`);
                return msg.reply('⚠️ Already in blacklist.');
            }

            // .unblacklist <number>
            if (textLower.startsWith('.unblacklist ')) {
                const num = rawText.split(' ')[1]?.replace('+', '');
                if (!num) return msg.reply('⚠️ Usage: .unblacklist 919876543210');
                removeFromBlacklist(num);
                return msg.reply(`✅ *+${num}* removed from blacklist.`);
            }

            // .blacklistshow
            if (textLower === '.blacklistshow') {
                const list = readBlacklist();
                if (!list.length) return msg.reply('Blacklist khali hai. 🎉');
                return msg.reply(`🚫 *BLACKLIST (${list.length}):*\n\n${list.map((n, i) => `${i + 1}. +${n}`).join('\n')}`);
            }

            // quoted 'ok' → APPROVE
            if (msg.hasQuotedMsg && textLower === 'ok') {
                const quoted = await msg.getQuotedMessage();
                const body   = quoted.body || '';
                const idMatch   = body.match(/ID:\s*(\S+)/);
                const numMatch  = body.match(/Number:\s*\+?(\d+)/);
                const teamMatch = body.match(/Team:\s*\*?([^\n*]+)\*?/);

                let targetId    = idMatch  ? idMatch[1]  : null;
                let cleanNumber = numMatch ? numMatch[1] : null;
                if (!cleanNumber && targetId) cleanNumber = await getRealNumberFromId(targetId);
                if (!targetId && cleanNumber)  targetId   = `${cleanNumber}@c.us`;
                if (!targetId) return msg.reply('❌ User ID not found in quoted message.');

                const teamName = teamMatch ? teamMatch[1].trim() : 'Unknown';
                saveRecord(teamName, cleanNumber, 'N/A', 'N/A');
                await simulateTyping(targetId, 1000);
                await client.sendMessage(targetId,
                    `✅ *PAYMENT VERIFIED BY ADMIN!*\nTeam: *${teamName}*\n\nGroup join karo 👇\n${currentGroupLink}`
                );
                if (pendingPayments[targetId]) delete pendingPayments[targetId];
                return msg.reply(`✅ Approved!\nTeam: *${teamName}*\nNumber: +${cleanNumber}`);
            }

            // quoted 'ban' → REJECT or REVOKE
            if (msg.hasQuotedMsg && textLower === 'ban') {
                const quoted = await msg.getQuotedMessage();
                const body   = quoted.body || '';
                const idMatch   = body.match(/ID:\s*(\S+)/);
                const numMatch  = body.match(/Number:\s*\+?(\d+)/);
                const teamMatch = body.match(/Team:\s*\*?([^\n*]+)\*?/);

                let targetId    = idMatch  ? idMatch[1]  : null;
                let cleanNumber = numMatch ? numMatch[1] : null;
                if (!cleanNumber && targetId) cleanNumber = await getRealNumberFromId(targetId);
                if (!targetId && cleanNumber)  targetId   = `${cleanNumber}@c.us`;
                if (!targetId) return msg.reply('❌ User ID not found in quoted message.');

                const teamName       = teamMatch ? teamMatch[1].trim() : 'Unknown';
                const wasAutoVerified = body.includes('AUTO-VERIFIED');

                if (wasAutoVerified) removeRecord(cleanNumber);
                if (pendingPayments[targetId]) delete pendingPayments[targetId];

                await client.sendMessage(targetId,
                    `❌ *PAYMENT REJECTED!*\n\n` +
                    (wasAutoVerified
                        ? 'Aapka payment admin ne revoke kar diya hai.'
                        : 'Screenshot valid nahi laga.') +
                    `\nSahi screenshot bhejein ya admin se baat karein: 9332777859`
                );
                return msg.reply(
                    `❌ ${wasAutoVerified ? 'REVOKED' : 'Rejected'}!\n` +
                    `Team: *${teamName}*\nNumber: +${cleanNumber}` +
                    (wasAutoVerified ? '\n📌 Record removed.' : '')
                );
            }

            // Admin self QR preview
            if (qrKeywords.some(k => textLower.includes(k)) && fs.existsSync('./qr.png')) {
                const media = MessageMedia.fromFilePath('./qr.png');
                return client.sendMessage(msg.from, media, { caption: "👇 QR Preview." });
            }

            return;
        }

        // ══════════════════════════════════════════
        //  PLAYER SECTION
        // ══════════════════════════════════════════

        // Blacklist check — silently ignore
        const playerNum = await getRealNumber(msg);
        if (isBlacklisted(playerNum)) return;

        // Anti-spam (non-media)
        if (antiSpam.has(msg.from) && !msg.hasMedia) return;

        // First-time greeting with name
        if (!seenUsers.has(msg.from) && !msg.hasMedia) {
            seenUsers.add(msg.from);
            const name = await getContactName(msg);
            if (name) {
                await simulateTyping(msg.from, 600);
                await client.sendMessage(msg.from, `Hey *${name}*! 👋 Welcome to MAG Esports!`);
            }
        }

        // Pending team name
        if (!msg.hasMedia && pendingPayments[msg.from]) {
            const pData    = pendingPayments[msg.from];
            const teamName = rawText;
            if (isInvalidName(teamName)) {
                await simulateTyping(msg.from, 600);
                return msg.reply("⚠️ Proper *Team Name* bhejo.\n(Example: Team Alpha, RG Gamers)");
            }
            if (readRecords().length >= maxSlots) return msg.reply("🛑 Slots full ho gaye! Admin se baat karo: 9332777859");
            delete pendingPayments[msg.from];
            return processVerification(msg, teamName, pData);
        }

        // QR trigger
        if (qrKeywords.some(k => textLower.includes(k))) {
            if (getSlotsLeft() === 0) {
                return msg.reply("🛑 Aaj ke saare slots full ho gaye hain!\nAgle lobby ka wait karo ya admin se baat karo.");
            }
            if (fs.existsSync('./qr.png')) {
                antiSpam.add(msg.from);
                setTimeout(() => antiSpam.delete(msg.from), 15000);

                const media = MessageMedia.fromFilePath('./qr.png');
                await simulateTyping(msg.from, 800);
                await client.sendMessage(msg.from, media, {
                    caption: `👇 Scan karke pay karein aur screenshot bhejein.\n\n${getUrgencyText()}`
                });

                // 2-min follow-up if no screenshot received
                if (qrTimers[msg.from]) clearTimeout(qrTimers[msg.from]);
                qrTimers[msg.from] = setTimeout(async () => {
                    if (!recentlyPaid.has(msg.from) && getSlotsLeft() > 0) {
                        await client.sendMessage(msg.from,
                            `⏳ Bhai payment ho gayi? Screenshot bhej do — sirf *${getSlotsLeft()} slots* baki hain!`
                        );
                    }
                    delete qrTimers[msg.from];
                }, 120000);
                return;
            }
        }

        // Screenshot / OCR
        if (msg.hasMedia) {
            if (qrTimers[msg.from]) { clearTimeout(qrTimers[msg.from]); delete qrTimers[msg.from]; }
            recentlyPaid.add(msg.from);
            setTimeout(() => recentlyPaid.delete(msg.from), 600000);

            await reactTo(msg, '👀');
            await simulateTyping(msg.from, 1200);
            await msg.reply("⏳ Payment check ho raha hai...");

            try {
                const media = await msg.downloadMedia();
                if (!media?.mimetype?.startsWith('image/')) {
                    return msg.reply("⚠️ Sirf payment ka screenshot (image) bhejo.");
                }

                const buffer = Buffer.from(media.data, 'base64');
                const worker = await getOCRWorker();
                const { data: { text, confidence } } = await worker.recognize(buffer);

                const utr      = extractUTR(text);
                const amount   = extractAmount(text);
                let { status } = analyzeOCR(text, utr, amount);
                if (Math.round(confidence) < OCR_MIN_CONFIDENCE) status = '⚠️ LOW IMAGE QUALITY';
