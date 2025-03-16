require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');
const express = require('express');
const fetch = require('node-fetch');  // Must be node-fetch@2 for CommonJS require

/**
 * =============================
 * CONFIGURATION & GLOBALS
 * =============================
 */
const ADMIN_NUMBER = process.env.ADMIN_NUMBER || '254701339573';
let PAYMENT_INFO = '0701339573 (Camlus)'; // Admin can update
const PORT = 3000;

// PayHero STK push credentials (admin can update via "set payhero" command)
let PAYHERO_CHANNEL_ID = 911;
let PAYHERO_AUTH_BASE64 = '3A6anVoWFZrRk5qSVl0MGNMOERGMlR3dlhrQ0VWUWJHNDVVVnNaMEdDSw==';

// Min/Max withdrawal (admin can update)
let MIN_WITHDRAWAL = 20;
let MAX_WITHDRAWAL = 1000;

// In-memory data
const orders = {};    // orderID => { ... }
const referrals = {}; // user => { code, referred:[], earnings, withdrawals:[], pin, parent?: string }
const session = {};   // user => { step, prevStep, etc. }
const bannedUsers = new Set(); // track banned users

/**
 * =============================
 * HELPER FUNCTIONS
 * =============================
 */
// Format date/time in Kenyan local time (UTC+3)
function formatKenyaTime(date) {
  const utcMs = date.getTime() + (date.getTimezoneOffset() * 60000);
  const kenyaMs = utcMs + (3 * 3600000);
  const d = new Date(kenyaMs);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day} ${hh}:${mm}:${ss}`;
}

// Mask a WhatsApp ID partially
function maskWhatsAppID(waid) {
  const atIndex = waid.indexOf('@');
  if (atIndex === -1) return waid;
  const phone = waid.slice(0, atIndex);
  if (phone.length < 6) return waid;
  const first5 = phone.slice(0, 5);
  const last1 = phone.slice(-1);
  return `${first5}****${last1}@c.us`;
}

// Generate unique order ID
function generateOrderID() {
  return `FY'S-${Math.floor(100000 + Math.random() * 900000)}`;
}

// Validate Safaricom phone
function isSafaricomNumber(num) {
  return /^0[71]\d{8}$/.test(num) || /^01\d{8}$/.test(num);
}

/**
 * Attempt STK push via PayHero
 */
async function sendSTKPush(amount, phoneNumber, externalRef, customerName) {
  try {
    const response = await fetch('https://backend.payhero.co.ke/api/v2/payments', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${PAYHERO_AUTH_BASE64}`
      },
      body: JSON.stringify({
        amount,
        phone_number: phoneNumber,
        channel_id: PAYHERO_CHANNEL_ID,
        provider: 'm-pesa',
        external_reference: externalRef,
        customer_name: customerName,
        callback_url: 'https://example.com/callback.php'
      })
    });
    const data = await response.json();
    if (!response.ok) {
      console.log('❌ STK Push Error:', data);
      return { success: false, message: '⚠️ STK push failed. Please pay manually.' };
    }
    console.log('✅ STK Push Sent:', data);
    return { success: true, message: '🔔 STK Push sent! Check your phone for M-PESA prompt.' };
  } catch (err) {
    console.error('Error sending STK push:', err);
    return { success: false, message: '⚠️ STK push request error. Please pay manually.' };
  }
}

/**
 * =============================
 * PACKAGES: Data & SMS
 * =============================
 */
const dataPackages = {
  hourly: [
    { id: 1, name: '1GB', price: 19, validity: '1 hour' },
    { id: 2, name: '1.5GB', price: 49, validity: '3 hours' }
  ],
  daily: [
    { id: 1, name: '1.25GB', price: 55, validity: 'Till midnight' },
    { id: 2, name: '1GB', price: 99, validity: '24 hours' },
    { id: 3, name: '250MB', price: 20, validity: '24 hours' }
  ],
  weekly: [
    { id: 1, name: '6GB', price: 700, validity: '7 days' },
    { id: 2, name: '2.5GB', price: 300, validity: '7 days' },
    { id: 3, name: '350MB', price: 50, validity: '7 days' }
  ],
  monthly: [
    { id: 1, name: '1.2GB', price: 250, validity: '30 days' },
    { id: 2, name: '500MB', price: 100, validity: '30 days' }
  ]
};
const smsPackages = {
  daily: [
    { id: 1, name: '200 SMS', price: 10, validity: 'Daily' }
  ],
  weekly: [
    { id: 1, name: '1000 SMS', price: 29, validity: 'Weekly' }
  ],
  monthly: [
    { id: 1, name: '2000 SMS', price: 99, validity: 'Monthly' }
  ]
};

/**
 * =============================
 * WHATSAPP CLIENT
 * =============================
 */
const { puppeteer } = require('whatsapp-web.js');
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: { headless: true }
});
let qrImageUrl = null;

client.on('qr', (qr) => {
  console.log('🔐 Please scan the QR code below with WhatsApp:');
  qrcodeTerminal.generate(qr, { small: true });
  QRCode.toDataURL(qr, (err, url) => {
    if (!err) qrImageUrl = url;
  });
});
client.on('ready', () => {
  console.log('✅ Bot is online!');
  client.sendMessage(`${ADMIN_NUMBER}@c.us`, `🎉 Hello Admin! FY'S ULTRA BOT is live.\nType "menu" for user flow or "Admin CMD" for admin commands.`);
});

/**
 * =============================
 * REFERRAL UTILS
 * =============================
 */
function getReferralLink(sender) {
  if (!referrals[sender]) {
    const code = 'REF' + Math.floor(100000 + Math.random() * 900000);
    referrals[sender] = { code, referred: [], earnings: 0, withdrawals: [], pin: null, parent: session[sender]?.referrer || null };
  }
  return `https://wa.me/${ADMIN_NUMBER}?text=ref ${referrals[sender].code}`;
}
function recordReferral(newUser, refCode) {
  for (let r in referrals) {
    if (referrals[r].code === refCode) {
      if (r === newUser) return;
      if (!referrals[r].referred.includes(newUser)) {
        referrals[r].referred.push(newUser);
      }
      session[newUser] = session[newUser] || {};
      session[newUser].referrer = refCode;
      break;
    }
  }
}

/**
 * =============================
 * ADMIN COMMAND PARSER
 * =============================
 */
function parseQuotedParts(parts, fromIndex) {
  let result = [];
  let current = '';
  let inQuote = false;
  for (let i = fromIndex; i < parts.length; i++) {
    let p = parts[i];
    if (p.startsWith('"') && !p.endsWith('"')) {
      inQuote = true;
      current += p.slice(1) + ' ';
    } else if (inQuote && p.endsWith('"')) {
      inQuote = false;
      current += p.slice(0, -1);
      result.push(current.trim());
      current = '';
    } else if (inQuote) {
      current += p + ' ';
    } else if (p.startsWith('"') && p.endsWith('"')) {
      result.push(p.slice(1, -1));
    } else {
      result.push(p);
    }
  }
  return result;
}

/**
 * =============================
 * MAIN MESSAGE HANDLER
 * =============================
 */
client.on('message', async (msg) => {
  const sender = msg.from;
  const text = msg.body.trim();
  const lower = text.toLowerCase();

  // If user is banned (and not admin), block them
  if (bannedUsers.has(sender) && sender !== `${ADMIN_NUMBER}@c.us`) {
    return client.sendMessage(sender, "🚫 You are banned from using this service.");
  }

  // ---------- ADMIN FLOW ----------
  if (sender === `${ADMIN_NUMBER}@c.us`) {
    if (lower === 'admin cmd') {
      const adminMenu = `📜 *Admin Menu* 📜\n
1) update <ORDER_ID> <STATUS> <REMARK>
2) set payment <mpesa_number> "<Name>"
3) add data <subcat> "<name>" <price> "<validity>"
4) remove data <subcat> <id>
5) edit data <subcat> <id> <newprice>
6) add sms <subcat> "<name>" <price> "<validity>"
7) remove sms <subcat> <id>
8) edit sms <subcat> <id> <newprice>
9) set withdrawal <min> <max>
10) search <ORDER_ID>
11) referrals all
12) withdraw update <ref_code> <wd_id> <STATUS> <remarks>
13) earnings add <ref_code> <amount> <remarks>
14) earnings deduct <ref_code> <amount> <remarks>
15) ban <userID>
16) unban <userID>
17) set payhero <channel_id> <base64Auth>`;
      return client.sendMessage(sender, adminMenu);
    }
    // (All admin commands as shown above in the final code snippet.)
    // ...
  }

  // ---------- REFERRAL QUICK COMMANDS ----------
  if (lower === 'referral') {
    const link = getReferralLink(sender);
    return client.sendMessage(sender, `😍 *Your Referral Link:*\n${link}\nShare with friends to earn KSH5 per successful order!`);
  }
  if (lower.startsWith('ref ')) {
    const splitted = text.split(' ');
    if (splitted.length === 2) {
      recordReferral(sender, splitted[1].toUpperCase());
      return client.sendMessage(sender, `🙏 You've been referred by code *${splitted[1].toUpperCase()}*. Enjoy our services!`);
    }
  }

  // ---------- MAIN MENU NAV ----------
  if (lower === 'menu' || lower === 'start') {
    session[sender] = { step: 'main' };
    const mainMenu = `🌟 *Welcome to FY'S ULTRA BOT!* 🌟\n\nThank you for choosing FYS PROPERTY!\n\nSelect an option:\n1️⃣ Airtime\n2️⃣ Data Bundles\n3️⃣ SMS Bundles\n4️⃣ My Referrals\n\nFor order status: status <ORDER_ID>\nAfter payment: PAID <ORDER_ID>\nType "00" for main menu.`;
    return client.sendMessage(sender, mainMenu);
  }
  if (text === '0') {
    if (session[sender]?.prevStep) {
      session[sender].step = session[sender].prevStep;
      return client.sendMessage(sender, '🔙 Returning to previous menu...');
    } else {
      session[sender] = { step: 'main' };
      return client.sendMessage(sender, '🏠 Returning to main menu...');
    }
  }
  if (text === '00') {
    session[sender] = { step: 'main' };
    return client.sendMessage(sender, '🏠 Returning to main menu...');
  }

  // ---------- OPTION 1: Airtime ----------
  if (session[sender]?.step === 'main' && text === '1') {
    session[sender].prevStep = 'main';
    session[sender].step = 'airtimeAmount';
    return client.sendMessage(sender, `💳 *Airtime Purchase*\nEnter the amount in KES (e.g., "50").\nType "0" to go back.`);
  }
  if (session[sender]?.step === 'airtimeAmount') {
    const amt = Number(text);
    if (isNaN(amt) || amt <= 0) {
      return client.sendMessage(sender, '❌ Invalid amount. Please enter a positive number.');
    }
    session[sender].airtimeAmount = amt;
    session[sender].step = 'airtimeRecipient';
    return client.sendMessage(sender, `✅ Amount set to KSH ${amt}.\nNow enter the recipient phone number (07XXXXXXXX):`);
  }
  if (session[sender]?.step === 'airtimeRecipient') {
    if (!isSafaricomNumber(text)) {
      return client.sendMessage(sender, '❌ Invalid phone number.');
    }
    session[sender].airtimeRecipient = text;
    session[sender].step = 'airtimePayment';
    return client.sendMessage(sender, `✅ Recipient set: ${text}.\nEnter your payment number (07XXXXXXXX):`);
  }
  if (session[sender]?.step === 'airtimePayment') {
    if (!isSafaricomNumber(text)) {
      return client.sendMessage(sender, '❌ Invalid payment number.');
    }
    const orderID = generateOrderID();
    const amt = session[sender].airtimeAmount;
    orders[orderID] = {
      orderID,
      customer: sender,
      package: `Airtime (KES ${amt})`,
      amount: amt,
      recipient: session[sender].airtimeRecipient,
      payment: text,
      status: 'PENDING',
      timestamp: new Date().toISOString()
    };
    // Attempt STK push
    const pushResult = await sendSTKPush(amt, text, orderID, 'FYS PROPERTY BOT');
    if (pushResult.success) {
      client.sendMessage(sender, `${pushResult.message}\nIf you don't see it, you can still pay manually to ${PAYMENT_INFO}.`);
    } else {
      client.sendMessage(sender, `${pushResult.message}\nPlease pay manually to ${PAYMENT_INFO}.`);
    }

    delete session[sender].airtimeAmount;
    delete session[sender].airtimeRecipient;
    session[sender].step = 'main';

    const summary = `🛒 *Order Created!*\n\n🆔 ${orderID}\nPackage: Airtime (KES ${amt})\n💰 Price: KSH ${amt}\n📞 Recipient: ${orders[orderID].recipient}\n📱 Payment: ${orders[orderID].payment}\n🕒 Placed at: ${formatKenyaTime(new Date(orders[orderID].timestamp))}\n\n👉 Type: PAID ${orderID} once you complete payment.\nType "00" for main menu.`;
    client.sendMessage(sender, summary);

    // notify admin
    const adminMsg = `🔔 *New Airtime Order*\n\n🆔 ${orderID}\nPackage: Airtime (KES ${amt})\nPrice: KSH ${amt}\nRecipient: ${orders[orderID].recipient}\nPayment: ${orders[orderID].payment}\nTime: ${formatKenyaTime(new Date(orders[orderID].timestamp))}\nUser: ${sender}\n(Use admin commands to update.)`;
    client.sendMessage(`${ADMIN_NUMBER}@c.us`, adminMsg);
    return;
  }

  // ---------- Data & SMS flows are similar (2,3). In each final step, do STK push + fallback.

  // ---------- Confirm Payment ("PAID <ORDER_ID>")
  if (lower.startsWith('paid ')) {
    const parts = text.split(' ');
    if (parts.length !== 2) {
      return client.sendMessage(sender, '❌ Usage: PAID <ORDER_ID>');
    }
    const orderID = parts[1];
    if (!orders[orderID]) {
      return client.sendMessage(sender, `❌ Order ${orderID} not found.`);
    }
    orders[orderID].status = 'CONFIRMED';
    // Two-level referral bonus
    if (orders[orderID].referrer && !orders[orderID].referralCredited) {
      let directUser = null;
      for (let u in referrals) {
        if (referrals[u].code === orders[orderID].referrer) {
          directUser = u;
          referrals[u].earnings += 5;
          client.sendMessage(u, `🔔 Congrats! You earned KSH5 from a referral order!`);
          break;
        }
      }
      // second-level
      if (directUser && referrals[directUser].parent) {
        const parentCode = referrals[directUser].parent;
        for (let v in referrals) {
          if (referrals[v].code === parentCode) {
            referrals[v].earnings += 5;
            client.sendMessage(v, `🔔 Great news! You earned KSH5 as a second-level referral bonus!`);
            break;
          }
        }
      }
      orders[orderID].referralCredited = true;
    }
    client.sendMessage(sender, `✅ Payment confirmed for order ${orderID}!\nYour order is now *CONFIRMED*.\n✨ Thank you for choosing FYS PROPERTY! For help, call 0701339573.\nType "00" for main menu.`);
    client.sendMessage(`${ADMIN_NUMBER}@c.us`, `🔔 Order ${orderID} marked as CONFIRMED by user ${sender}.`);
    return;
  }

  // ---------- Order Status ("status <ORDER_ID>")
  if (lower.startsWith('status ')) {
    const parts = text.split(' ');
    if (parts.length !== 2) {
      return client.sendMessage(sender, '❌ Usage: status <ORDER_ID>');
    }
    const orderID = parts[1];
    if (!orders[orderID]) {
      return client.sendMessage(sender, `❌ Order ${orderID} not found.`);
    }
    const o = orders[orderID];
    return client.sendMessage(sender,
      `📦 *Order Details*\n\n🆔 ${o.orderID}\nPackage: ${o.package}\n💰 KSH ${o.amount}\n📞 Recipient: ${o.recipient}\n📱 Payment: ${o.payment}\n📌 Status: ${o.status}\n🕒 Placed at: ${formatKenyaTime(new Date(o.timestamp))}\n📝 Remark: ${o.remark || 'None'}\n\nType "0" or "00" for menus.`
    );
  }

  // ---------- My Referrals (Option 4), PIN change, withdrawal, etc.
  // ... (similar to the final code snippet)

  // ---------- Fallback
  client.sendMessage(sender,
    `🤖 *FY'S ULTRA BOT*\nType "menu" for main menu.\nFor order status: status <ORDER_ID>\nAfter payment: PAID <ORDER_ID>\nFor referrals: referral or my referrals\nOr "0"/"00" for navigation.`
  );
});

/**
 * =============================
 * EXPRESS SERVER FOR QR CODE
 * =============================
 */
const app = express();
app.get('/', (req, res) => {
  res.send(`
    <html>
      <head><title>FY'S ULTRA BOT</title></head>
      <body style="font-family: Arial; text-align: center;">
        <h1>Welcome to FY'S ULTRA BOT</h1>
        <p>Visit <a href="/qr">/qr</a> to scan the QR code with WhatsApp.</p>
      </body>
    </html>
  `);
});
app.get('/qr', (req, res) => {
  if (qrImageUrl) {
    res.send(`
      <html>
        <head><title>Scan QR Code</title></head>
        <body style="font-family: Arial; text-align: center;">
          <h1>Scan This QR Code with WhatsApp</h1>
          <img src="${qrImageUrl}" style="width:300px;height:300px" />
          <p>Open WhatsApp > Linked Devices > Link a device</p>
        </body>
      </html>
    `);
  } else {
    res.send('<h1>QR Code not ready yet. Check console for updates.</h1>');
  }
});
app.listen(PORT, () => {
  console.log(`🌐 Express server running at http://localhost:${PORT}`);
});

/**
 * =============================
 * INITIALIZE WHATSAPP CLIENT
 * =============================
 */
client.initialize();
