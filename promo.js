const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');

const client = new Client({
    authStrategy: new LocalAuth({ clientId: 'promo-worker' }),
    puppeteer: { args: ['--no-sandbox', '--disable-setuid-sandbox'] }
});

const safeRead  = (file, fallback) => { try { if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')); } catch {} return fallback; };
const safeWrite = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2));

// ─────────────────────────────────────────────────────
//  ANTI-BAN UTILITIES
// ─────────────────────────────────────────────────────

/** Returns a random integer between min and max (inclusive). */
const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

/**
 * Waits for a random duration between minMs and maxMs milliseconds.
 * Simulates human-like pacing between messages.
 */
const humanDelay = (minMs = 2000, maxMs = 6000) =>
    new Promise(res => setTimeout(res, randInt(minMs, maxMs)));

/**
 * Sends a message with typing simulation:
 *  1. Random read pause (1–3 s)
 *  2. sendPresenceAvailable — marks account online
 *  3. startTyping indicator
 *  4. Typing delay (2–5 s) — simulates composing
 *  5. stopTyping
 *  6. Small pre-send gap (500 ms–1.5 s)
 *  7. Actual send
 */
const safeSend = async (to, content, options = {}) => {
    try {
        await humanDelay(1000, 3000);
        const chat = await client.getChatById(to).catch(() => null);
        if (chat) {
            await client.sendPresenceAvailable().catch(() => {});
            await chat.sendStateTyping().catch(() => {});
        }
        await humanDelay(2000, 5000);
        if (chat) await chat.clearState().catch(() => {});
        await humanDelay(500, 1500);
        return await client.sendMessage(to, content, options);
    } catch (e) {
        console.error(`❌ safeSend failed to ${to}: ${e.message}`);
        return await client.sendMessage(to, content, options);
    }
};

// ─────────────────────────────────────────────────────
//  BROCHURE DATA
// ─────────────────────────────────────────────────────
const defaultMini = `*MAG ESPORTS* | \n\`\`\`BUY LOBBY GET PURCHASE POINTS\`\`\`\n\n\`❗9 PM MINI LOBBY\` 🗽\n(\`\`\`B2B 4 MATCHES | B/K/P/S\`\`\`)\n\n  *ENTRY/ PP*\n    \`👇 / 👇\`\n📌 ₹25 / 220 \`BOOK HERE\` \n📌 ₹30 / 270 \`BOOK HERE\` \n\n\`⚖️💸(PP DISTRIBUTION )\`\n* *₹25 -100 / 70 / 50*=220\n* *₹30 -130 / 80 / 60*=270\n\n*_DM 9332777859 FOR SLOT_*`;
const defaultMega = `*MAG ESPORTS* | \n\`\`\`BUY LOBBY GET PURCHASE POINTS\`\`\`\n\n\`❗9 PM T2 LOBBY\` 🗽\n* \`\`\`MATCHES  - B2B 6\`\`\`\n* \`\`\`ROTATION - B/K/P/A/N/S\`\`\`\n\n    *ENTRY/ PP*\n       \`👇/ 👇\`\n 📌 ₹55 / 520 Live \n 📌 ₹40 / 400\n\`⚖️💸(PP DISTRIBUTION )\`\n* *₹55 -250/ 150/110* =520\n* *₹40 -200 / 120 / 80* =400\n\n*_DM  _88174 80559 _FOR SLOT_*`;

const getCustomBrochure = (type) => {
    const filePath = path.join(__dirname, `brochure_${type}.txt`);
    if (fs.existsSync(filePath)) return fs.readFileSync(filePath, 'utf8');
    if (type === 'mini') return defaultMini;
    if (type === 'mega') return defaultMega;
    return defaultMini;
};

const sendBrochure = async (to, type) => {
    const promoMsg = getCustomBrochure(type);
    const extensions = ['.png', '.jpg', '.jpeg'];
    let media = null;

    for (let ext of extensions) {
        const imgPath = path.join(__dirname, `${type}${ext}`);
        if (fs.existsSync(imgPath)) {
            media = MessageMedia.fromFilePath(imgPath);
            console.log(`📸 Photo mil gayi: ${type}${ext}`);
            break;
        }
    }

    try {
        if (media) {
            // Use safeSend for typing simulation on media messages too
            await safeSend(to, media, { caption: promoMsg });
            console.log(`✅ ${type.toUpperCase()} Image + Text sent to ${to}`);
        } else {
            await safeSend(to, promoMsg);
            console.log(`⚠️ ERROR: ${type} ki photo nahi mili! Sent ONLY TEXT to ${to}`);
        }
    } catch (e) {
        console.log(`❌ Failed to send promo to ${to}: ${e.message}`);
    }
};

// ─────────────────────────────────────────────────────
//  DYNAMIC CRON JOB
// ─────────────────────────────────────────────────────
let promoTask = null;

const setupPromoCron = () => {
    const autoPromo = safeRead('./autopromo.json', { active: false, targets: [], interval: 7 });
    const interval  = autoPromo.interval || 7;

    if (promoTask) promoTask.stop();

    console.log(`⏳ Auto-Brochure timer set to ${interval} minutes.`);
    promoTask = cron.schedule(`*/${interval} * * * *`, async () => {
        const currentPromoState = safeRead('./autopromo.json', { active: false, targets: [], interval: 7 });
        const activeMode        = safeRead('./mode.json', { mode: 'both' }).mode;

        if (!currentPromoState.active || currentPromoState.targets.length === 0) return;

        console.log(`📢 Sending promos to ${currentPromoState.targets.length} targets...`);
        for (const target of currentPromoState.targets) {
            if (activeMode === 'both') {
                await sendBrochure(target, 'mini');
                // Anti-ban: random gap between mini and mega message (3–7 s)
                await humanDelay(3000, 7000);
                await sendBrochure(target, 'mega');
            } else {
                await sendBrochure(target, activeMode);
            }
            // Anti-ban: random gap between each target (4–10 s)
            await humanDelay(4000, 10000);
        }
    });
};

// ─────────────────────────────────────────────────────
//  CLIENT EVENTS
// ─────────────────────────────────────────────────────
client.on('qr', qr => {
    qrcode.generate(qr, { small: true });
    console.log('👆 PROMO BOT KA QR SCAN KARO (Dusra Terminal)');
});

client.on('ready', () => {
    console.log('✅ PROMO BOT IS READY!');
    setupPromoCron();
});

client.on('message_create', async msg => {
    const rawText = msg.body.trim();
    const cmd     = rawText.toLowerCase().split(/\s+/)[0];
    const isAdmin = msg.fromMe || msg.from === '100334781354038@lid' || msg.from === client.info.wid._serialized;

    if (!isAdmin) return;

    let autoPromo   = safeRead('./autopromo.json', { active: false, targets: [], interval: 7 });
    const activeMode = safeRead('./mode.json', { mode: 'both' }).mode;

    const chat       = await msg.getChat();
    const explicitId = rawText.split(/\s+/)[1];
    const targetId   = explicitId ? explicitId : chat.id._serialized;

    if (cmd === '.setinterval') {
        const newInterval = parseInt(rawText.split(/\s+/)[1]);
        if (!isNaN(newInterval) && newInterval > 0) {
            autoPromo.interval = newInterval;
            safeWrite('./autopromo.json', autoPromo);
            setupPromoCron();
            return msg.reply(`✅ Auto-Brochure ka time ab *${newInterval} minutes* set ho gaya hai.`);
        }
        return msg.reply('⚠️ Sahi time likho bhai, usage: `.setinterval 5` (minutes me)');
    }

    if (cmd === '.clearpromo') {
        autoPromo.targets = [];
        autoPromo.active  = false;
        safeWrite('./autopromo.json', autoPromo);
        return msg.reply('🧹 Purane sabhi targets clear ho gaye.');
    }

    if (cmd === '.autostart') {
        autoPromo.active = true;
        safeWrite('./autopromo.json', autoPromo);
        await msg.reply(`✅ Auto-Brochure START ho gaya (${autoPromo.interval || 7} mins interval). Pehla brochure abhi bhej raha hu...`);

        if (autoPromo.targets.length > 0) {
            for (const target of autoPromo.targets) {
                if (activeMode === 'both') {
                    await sendBrochure(target, 'mini');
                    await humanDelay(3000, 7000);
                    await sendBrochure(target, 'mega');
                } else {
                    await sendBrochure(target, activeMode);
                }
                await humanDelay(4000, 10000);
            }
        } else {
            await msg.reply('⚠️ Target list khali hai. Pehle kisi group me jake `.addtarget` karo.');
        }
        return;
    }

    if (cmd === '.autostop') {
        autoPromo.active = false;
        safeWrite('./autopromo.json', autoPromo);
        return msg.reply('🛑 Auto-Brochure STOP ho gaya.');
    }

    if (cmd === '.addtarget') {
        if (!explicitId && !targetId.includes('@g.us')) {
            return msg.reply('⚠️ Bhai, tum abhi Personal Chat me ho! Agar group me bhejna hai, toh us **Group ko open karke** wahan `.addtarget` likho.');
        }
        if (!autoPromo.targets.includes(targetId)) {
            autoPromo.targets.push(targetId);
            safeWrite('./autopromo.json', autoPromo);
            return msg.reply(`✅ Added target: ${targetId}`);
        }
        return msg.reply('⚠️ Ye Group already added hai.');
    }

    if (cmd === '.removetarget') {
        autoPromo.targets = autoPromo.targets.filter(t => t !== targetId);
        safeWrite('./autopromo.json', autoPromo);
        return msg.reply(`🗑️ Removed target: ${targetId}`);
    }

    if (cmd === '.setbrochure') {
        const type = rawText.split(/\s+/)[1]?.toLowerCase();
        if (!['mini', 'mega'].includes(type)) return msg.reply('⚠️ Usage: Kisi bhi brochure text ko reply karo `.setbrochure mini` ya `.setbrochure mega`');

        if (msg.hasQuotedMsg) {
            const quoted = await msg.getQuotedMessage();
            fs.writeFileSync(path.join(__dirname, `brochure_${type}.txt`), quoted.body, 'utf8');
            return msg.reply(`✅ ${type.toUpperCase()} brochure updated!`);
        } else {
            const newText = rawText.substring(cmd.length + type.length + 2).trim();
            if (newText) {
                fs.writeFileSync(path.join(__dirname, `brochure_${type}.txt`), newText, 'utf8');
                return msg.reply(`✅ ${type.toUpperCase()} brochure updated!`);
            }
            return msg.reply('⚠️ Apna naya brochure *reply* me do, ya command ke aage paste karo.');
        }
    }
});

client.initialize();
