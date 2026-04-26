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

// Render Specific Puppeteer & Auth Configuration
const client = new Client({
    authStrategy: new LocalAuth({
        dataPath: './.wwebjs_auth' 
    }),
    puppeteer: {
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu'
        ],
        headless: true
    }
});

const botStartTime = Math.floor(Date.now() / 1000);

// --- HELPERS & STATE ---
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

// --- CORE LOGIC ---
const getWelcomeMessage = () => {
    let msg = `🎮 *${settings.scrimName} — LOBBY REGISTRATION*\n⏰ *Time:* ${settings.lobbyTime}\n━━━━━━━━━━━━━━━━━━━━\n\nKonsi lobby leni hai?\n\n`;
    const isMiniFull = !isSlotsAvailable('mini');
    const isMegaFull = !isSlotsAvailable('mega');
    const isLiveFull = !isSlotsAvailable('live');

    if (['all', 'both', 'mini', 'minilive'].includes(activeMode)) msg += `🟡 *MINI LOBBY* - ` + (isMiniFull ? `🛑 FULL` : `₹${settings.miniPrice}`) + `\n`;
    if (['all', 'both', 'mega'].includes(activeMode)) msg += `🔵 *MEGA LOBBY* - ` + (isMegaFull ? `🛑 FULL` : `₹${settings.megaPrice}`) + `\n`;
    if (['all', 'live', 'minilive'].includes(activeMode)) msg += `🔴 *LIVE LOBBY* - ` + (isLiveFull ? `🛑 FULL` : `₹${settings.livePrice}`) + `\n`;

    msg += `\n━━━━━━━━━━━━━━━━━━━━\n👉 Type lobby name (Mini/Mega/Live) to start.`;
    return msg;
};

const isSlotsAvailable = (type) => { if (settings.closedLobbies.includes(type.toLowerCase())) return false; return true; };

client.on('qr', qr => {
    webQR = qr;
    console.log("👉 Go to your Render link to scan the QR!");
});

client.on('ready', () => {
    webQR = "✅ BOT IS LIVE! You can close this page.";
    console.log('✅ BOT READY!');
});

client.on('message', async msg => {
    if (msg.from.includes('@g.us')) return;
    const textLower = msg.body.toLowerCase();

    if (textLower === 'hi' || textLower === 'menu') {
        msg.reply(getWelcomeMessage());
    }
});

client.initialize();
