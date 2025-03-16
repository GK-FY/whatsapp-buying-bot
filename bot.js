require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');
const express = require('express');
const fetch = require('node-fetch'); // for STK push API calls

/**
 * =============================
 * CONFIGURATION & GLOBAL VARIABLES
 * =============================
 */
const ADMIN_NUMBER = process.env.ADMIN_NUMBER || '254701339573';
let PAYMENT_INFO = '0701339573 (Camlus)'; // Admin can update
const PORT = 3000;

// PayHero STK push config: Admin can update channelID & authBase64
let PAYHERO_CHANNEL_ID = 911;
let PAYHERO_AUTH_BASE64 = '3A6anVoWFZrRk5qSVl0MGNMOERGMlR3dlhrQ0VWUWJHNDVVVnNaMEdDSw==';

// Min/Max withdrawal (admin can update)
let MIN_WITHDRAWAL = 20;
let MAX_WITHDRAWAL = 1000;

// Data stores
const orders = {};    // orderID => { ... }
const referrals = {}; // user => { code, referred:[], earnings, withdrawals:[], pin, parent?: string }
const session = {};   // user => { step, prevStep, etc. }
const bannedUsers = new Set(); // Banned user IDs

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

// Mask a WhatsApp ID partially for privacy
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
 * Attempt STK push via PayHero API
 * If it fails or user doesn't get it, we fallback to manual payment instructions.
 */
async function sendSTKPush(amount, phoneNumber, externalRef, customerName) {
  const body = {
    amount,
    phone_number: phoneNumber,
    channel_id: PAYHERO_CHANNEL_ID,
    provider: 'm-pesa',
    external_reference: externalRef,
    customer_name: customerName,
    callback_url: 'https://example.com/callback.php'
  };
  try {
    const res = await fetch('https://backend.payhero.co.ke/api/v2/payments', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${PAYHERO_AUTH_BASE64}`
      },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    return data; // Return the response JSON
  } catch (err) {
    console.error('Error sending STK push:', err);
    return null;
  }
}

/**
 * =============================
 * PACKAGES (DATA, SMS)
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
  console.log('🔐 Scan the QR code below with WhatsApp:');
  qrcodeTerminal.generate(qr, { small: true });
  QRCode.toDataURL(qr, (err, url) => {
    if (!err) qrImageUrl = url;
  });
});
client.on('ready', () => {
  console.log('✅ Bot is online!');
  client.sendMessage(`${ADMIN_NUMBER}@c.us`, `🎉 Hello Admin! FY'S ULTRA BOT is now live.\nType "menu" for user flow or "Admin CMD" for admin commands.`);
});

/**
 * =============================
 * REFERRAL HELPERS
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
  for (let ref in referrals) {
    if (referrals[ref].code === refCode) {
      if (ref === newUser) return;
      if (!referrals[ref].referred.includes(newUser)) {
        referrals[ref].referred.push(newUser);
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
    // Admin commands menu
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
17) set payhero <channel_id> <base64Auth>  (For STK push config)`;
      return client.sendMessage(sender, adminMenu);
    }
    // set payhero <channel_id> <base64Auth>
    if (lower.startsWith('set payhero ')) {
      const parts = text.split(' ');
      if (parts.length < 4) {
        return client.sendMessage(sender, '❌ Usage: set payhero <channel_id> <base64Auth>');
      }
      const channelId = Number(parts[2]);
      const authBase64 = parts[3];
      if (isNaN(channelId) || channelId <= 0) {
        return client.sendMessage(sender, '❌ channel_id must be a positive number.');
      }
      PAYHERO_CHANNEL_ID = channelId;
      PAYHERO_AUTH_BASE64 = authBase64;
      return client.sendMessage(sender, `✅ Updated STK push config:\nchannel_id = ${channelId}\nAuthorization = Basic ${authBase64}`);
    }
    // ban user
    if (lower.startsWith('ban ')) {
      const splitted = text.split(' ');
      if (splitted.length !== 2) return client.sendMessage(sender, '❌ Usage: ban <userID>');
      bannedUsers.add(splitted[1]);
      return client.sendMessage(sender, `✅ Banned user ${splitted[1]}.`);
    }
    // unban user
    if (lower.startsWith('unban ')) {
      const splitted = text.split(' ');
      if (splitted.length !== 2) return client.sendMessage(sender, '❌ Usage: unban <userID>');
      bannedUsers.delete(splitted[1]);
      return client.sendMessage(sender, `✅ Unbanned user ${splitted[1]}.`);
    }
    // ... (other admin commands, see final code above)

    // search <ORDER_ID>
    if (lower.startsWith('search ')) {
      const splitted = text.split(' ');
      if (splitted.length !== 2) {
        return client.sendMessage(sender, '❌ Usage: search <ORDER_ID>');
      }
      const orderID = splitted[1];
      if (!orders[orderID]) {
        return client.sendMessage(sender, `❌ Order ${orderID} not found.`);
      }
      const o = orders[orderID];
      return client.sendMessage(sender,
        `🔎 *Order Details*\n\n` +
        `🆔 Order ID: ${o.orderID}\n` +
        `📦 Package: ${o.package}\n` +
        `💰 Amount: KSH ${o.amount}\n` +
        `📞 Recipient: ${o.recipient}\n` +
        `📱 Payment: ${o.payment}\n` +
        `📌 Status: ${o.status}\n` +
        `🕒 Placed at: ${formatKenyaTime(new Date(o.timestamp))}\n` +
        `📝 Remark: ${o.remark || 'None'}`
      );
    }
    // referrals all
    if (lower === 'referrals all') {
      let resp = `🙌 *All Referral Data*\nWithdrawal Limits: Min KSH ${MIN_WITHDRAWAL}, Max KSH ${MAX_WITHDRAWAL}\n\n`;
      for (let u in referrals) {
        resp += `User: ${u}\nCode: ${referrals[u].code}\nTotal Referred: ${referrals[u].referred.length}\nEarnings: KSH ${referrals[u].earnings}\nWithdrawals: ${referrals[u].withdrawals.length}\nPIN: ${referrals[u].pin || 'Not Set'}\nParent: ${referrals[u].parent || 'None'}\n\n`;
      }
      return client.sendMessage(sender, resp);
    }
    // (The rest of the admin commands are the same as in the final code above.)
  }

  // ========== If user is banned (and not admin)
  if (bannedUsers.has(sender) && sender !== `${ADMIN_NUMBER}@c.us`) {
    return client.sendMessage(sender, "🚫 You are banned from using this service.");
  }

  // ========== REFERRAL & MAIN MENU FLOWS (Identical to the final code above) ==========
  // (Include the entire user flow for Airtime, Data, SMS, My Referrals, STK push usage, etc.)
  // ...
  // AFTER the user enters their payment number, we attempt STK push:

  // For example, in the place where we finalize the order (like "airtimePayment", "dataPay", "smsPay"), we do:
  // ...
  // 1) Create the order in memory
  // 2) Attempt STK push:
  // 
  //    const pushResult = await sendSTKPush(orders[orderID].amount, orders[orderID].payment, orderID, 'FYS PROPERTY BOT');
  //    if (pushResult && !pushResult.error) {
  //      client.sendMessage(sender, `🔔 STK Push sent! Please check your phone for an M-PESA prompt. If you don't see it within 30 seconds, you can still send manually to ${PAYMENT_INFO}.`);
  //    } else {
  //      client.sendMessage(sender, `⚠️ We tried sending STK push but something went wrong. Please send money manually to ${PAYMENT_INFO}.`);
  //    }
  // 
  // 3) Send summary message
  // 4) Notify admin
  // ...
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
