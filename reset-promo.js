const fs = require('fs');
const path = require('path');

// Sirf Promo Bot ka session folder target kar rahe hain
const promoSessionFolder = path.join(__dirname, '.wwebjs_auth', 'session-promo-worker');

try {
  if (fs.existsSync(promoSessionFolder)) {
    fs.rmSync(promoSessionFolder, { recursive: true, force: true });
    console.log('✅ Sirf Promo Bot ka purana number/session delete ho gaya!');
    console.log('🔄 Ab apne terminal me "node promo.js" run karo aur naye number se QR scan karo.');
  } else {
    console.log('⚠️ Promo bot ka koi purana session nahi mila. Tum direct "node promo.js" run kar sakte ho.');
  }
} catch (err) {
  console.error('❌ Error aayi session delete karne me:', err.message);
}
