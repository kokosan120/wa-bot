const fs = require('fs');
const path = require('path');

// Main bot ka default session folder
const mainSessionFolder = path.join(__dirname, '.wwebjs_auth', 'session');

try {
  if (fs.existsSync(mainSessionFolder)) {
    fs.rmSync(mainSessionFolder, { recursive: true, force: true });
    console.log('✅ Main Chatbot ka purana number/session delete ho gaya!');
    console.log('🔄 Ab apne terminal me main bot wapas run karo aur naye number se QR scan karo.');
  } else {
    console.log('⚠️ Main bot ka koi purana session nahi mila. Tum direct bot run kar sakte ho.');
  }
} catch (err) {
  console.error('❌ Error:', err.message);
}
