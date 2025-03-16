require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');
const express = require('express');

/**
 * =============================
 * CONFIGURATION & GLOBAL VARIABLES
 * =============================
 */
const ADMIN_NUMBER = process.env.ADMIN_NUMBER || '254701339573';
let PAYMENT_INFO = '0701339573 (Camlus)'; // Default payment details (admin can update)
const PORT = 3000;

// Withdrawal limits (admin can update)
let MIN_WITHDRAWAL = 20;
let MAX_WITHDRAWAL = 1000;

// In-memory stores:
const orders = {};    // key: orderID → order details
const referrals = {}; // key: user (sender) → { code, referred: [], earnings, withdrawals: [], pin }
const session = {};   // key: sender → { step, prevStep, ... }

/**
 * =============================
 * HELPER FUNCTIONS
 * =============================
 */
// Format date/time in Kenya (UTC+3)
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

// Mask WhatsApp ID for privacy
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

// Validate Safaricom number (07XXXXXXXX or 01XXXXXXXX)
function isSafaricomNumber(num) {
  return /^0[71]\d{8}$/.test(num) || /^01\d{8}$/.test(num);
}

/**
 * =============================
 * PACKAGES: DATA & SMS (Airtime is user-defined)
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
 * WHATSAPP CLIENT SETUP
 * =============================
 */
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: { headless: true }
});

let qrImageUrl = null;
client.on('qr', (qr) => {
  console.log('🔐 Please scan the QR code with WhatsApp:');
  qrcodeTerminal.generate(qr, { small: true });
  QRCode.toDataURL(qr, (err, url) => {
    if (!err) qrImageUrl = url;
  });
});

client.on('ready', () => {
  console.log('✅ Bot is online and ready!');
  client.sendMessage(`${ADMIN_NUMBER}@c.us`, `🎉 Hello Admin! FY'S ULTRA BOT is now live. Type "menu" for user flow or "Admin CMD" for admin commands.`);
});

/**
 * =============================
 * REFERRAL FUNCTIONS
 * =============================
 */
function getReferralLink(sender) {
  if (!referrals[sender]) {
    const code = 'REF' + Math.floor(100000 + Math.random() * 900000);
    referrals[sender] = { code, referred: [], earnings: 0, withdrawals: [], pin: null };
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
    let part = parts[i];
    if (part.startsWith('"') && !part.endsWith('"')) {
      inQuote = true;
      current += part.slice(1) + ' ';
    } else if (inQuote && part.endsWith('"')) {
      inQuote = false;
      current += part.slice(0, -1);
      result.push(current.trim());
      current = '';
    } else if (inQuote) {
      current += part + ' ';
    } else if (part.startsWith('"') && part.endsWith('"')) {
      result.push(part.slice(1, -1));
    } else {
      result.push(part);
    }
  }
  return result;
}

/**
 * =============================
 * MESSAGE HANDLER
 * =============================
 */
client.on('message', async (msg) => {
  const sender = msg.from;
  const text = msg.body.trim();
  const lower = text.toLowerCase();

  // ===================== ADMIN FLOW =====================
  if (sender === `${ADMIN_NUMBER}@c.us`) {
    // Admin menu command:
    if (lower === 'admin cmd') {
      const adminMenu = `📜 *Admin Menu* 📜\n
1️⃣ Update Order: update <ORDER_ID> <STATUS> <REMARK>
2️⃣ Set Payment Info: set payment <mpesa_number> "<Name>"
3️⃣ Add Data Package: add data <subcat> "<name>" <price> "<validity>"
4️⃣ Remove Data Package: remove data <subcat> <id>
5️⃣ Edit Data Package: edit data <subcat> <id> <newprice>
6️⃣ Add SMS Package: add sms <subcat> "<name>" <price> "<validity>"
7️⃣ Remove SMS Package: remove sms <subcat> <id>
8️⃣ Edit SMS Package: edit sms <subcat> <id> <newprice>
9️⃣ Set Withdrawal Limits: set withdrawal <min> <max>
🔟 Search Order: search <ORDER_ID>
1️⃣1️⃣ View All Referrals: referrals all
1️⃣2️⃣ Update Withdrawal Request: withdraw update <ref_code> <wd_id> <STATUS> <remarks>
1️⃣3️⃣ Adjust Earnings: earnings add|deduct <ref_code> <amount> <remarks>
Type a number to choose, or type the full command.
`;
      return client.sendMessage(sender, adminMenu);
    }

    // Adjust earnings
    if (lower.startsWith('earnings add ')) {
      const parts = text.split(' ');
      if (parts.length < 5) {
        return client.sendMessage(sender, '❌ Usage: earnings add <ref_code> <amount> <remarks>');
      }
      const refCode = parts[2].toUpperCase();
      const amount = Number(parts[3]);
      const remarks = parts.slice(4).join(' ');
      if (isNaN(amount) || amount <= 0) {
        return client.sendMessage(sender, '❌ Invalid amount.');
      }
      let target = null;
      for (let u in referrals) {
        if (referrals[u].code === refCode) {
          target = u;
          break;
        }
      }
      if (!target) {
        return client.sendMessage(sender, `❌ No user with referral code ${refCode}.`);
      }
      referrals[target].earnings += amount;
      client.sendMessage(target, `🔔 *Admin Adjustment*\nYour earnings have been increased by KSH ${amount}.\nRemarks: ${remarks}\nCurrent Earnings: KSH ${referrals[target].earnings}`);
      return client.sendMessage(sender, `✅ Added KSH ${amount} to user ${target} (ref ${refCode}).`);
    }
    if (lower.startsWith('earnings deduct ')) {
      const parts = text.split(' ');
      if (parts.length < 5) {
        return client.sendMessage(sender, '❌ Usage: earnings deduct <ref_code> <amount> <remarks>');
      }
      const refCode = parts[2].toUpperCase();
      const amount = Number(parts[3]);
      const remarks = parts.slice(4).join(' ');
      if (isNaN(amount) || amount <= 0) {
        return client.sendMessage(sender, '❌ Invalid amount.');
      }
      let target = null;
      for (let u in referrals) {
        if (referrals[u].code === refCode) {
          target = u;
          break;
        }
      }
      if (!target) {
        return client.sendMessage(sender, `❌ No user with referral code ${refCode}.`);
      }
      if (referrals[target].earnings < amount) {
        return client.sendMessage(sender, `❌ User's earnings are only KSH ${referrals[target].earnings}.`);
      }
      referrals[target].earnings -= amount;
      client.sendMessage(target, `🔔 *Admin Adjustment*\nYour earnings have been deducted by KSH ${amount}.\nRemarks: ${remarks}\nCurrent Earnings: KSH ${referrals[target].earnings}`);
      return client.sendMessage(sender, `✅ Deducted KSH ${amount} from user ${target} (ref ${refCode}).`);
    }

    // set withdrawal limits
    if (lower.startsWith('set withdrawal ')) {
      const parts = text.split(' ');
      if (parts.length !== 4) {
        return client.sendMessage(sender, '❌ Usage: set withdrawal <min> <max>');
      }
      const minVal = Number(parts[2]);
      const maxVal = Number(parts[3]);
      if (isNaN(minVal) || isNaN(maxVal) || minVal <= 0 || maxVal <= minVal) {
        return client.sendMessage(sender, '❌ Please provide valid numbers (max > min > 0).');
      }
      MIN_WITHDRAWAL = minVal;
      MAX_WITHDRAWAL = maxVal;
      return client.sendMessage(sender, `✅ Withdrawal limits updated: Minimum = KSH ${MIN_WITHDRAWAL}, Maximum = KSH ${MAX_WITHDRAWAL}`);
    }

    // update order
    if (lower.startsWith('update ')) {
      const parts = text.split(' ');
      if (parts.length < 4) {
        return client.sendMessage(sender, '❌ Usage: update <ORDER_ID> <STATUS> <REMARK>');
      }
      const orderID = parts[1];
      const status = parts[2].toUpperCase();
      const remark = parts.slice(3).join(' ');
      if (!orders[orderID]) {
        return client.sendMessage(sender, `❌ Order ${orderID} not found.`);
      }
      orders[orderID].status = status;
      orders[orderID].remark = remark;
      const user = orders[orderID].customer;
      let extra = '';
      if (status === 'CONFIRMED') {
        extra = '✅ Payment confirmed! We are processing your order.';
      } else if (status === 'COMPLETED') {
        extra = '🎉 Your order is completed! Thank you for choosing FYS PROPERTY.';
      } else if (status === 'CANCELLED') {
        extra = `😔 We regret to inform you that your order was cancelled.\nOrder ID: ${orderID}\nPackage: ${orders[orderID].package}\nPlaced at: ${formatKenyaTime(new Date(orders[orderID].timestamp))}\nRemark: ${remark}\nPlease contact support if needed.`;
      } else if (status === 'REFUNDED') {
        extra = '💰 Your order was refunded. Please check your M-Pesa balance.';
      } else {
        extra = 'Your order status has been updated.';
      }
      client.sendMessage(user, `🔔 *Order Update*\nYour order *${orderID}* is now *${status}*.\n${extra}\n\nReply "0" or "00" for menus.`);
      return client.sendMessage(sender, `✅ Order ${orderID} updated to ${status} with remark: "${remark}".`);
    }

    // set payment
    if (lower.startsWith('set payment ')) {
      const parts = parseQuotedParts(text.split(' '), 2);
      if (parts.length < 2) {
        return client.sendMessage(sender, '❌ Usage: set payment <mpesa_number> "<Name>"');
      }
      const mpesa = parts[0];
      const name = parts[1];
      PAYMENT_INFO = `${mpesa} (${name})`;
      return client.sendMessage(sender, `✅ Payment info updated to: ${PAYMENT_INFO}`);
    }

    // Data and SMS package management (add, remove, edit) follow a similar pattern...
    if (lower.startsWith('add data ')) {
      const parts = parseQuotedParts(text.split(' '), 2);
      if (parts.length < 4) {
        return client.sendMessage(sender, '❌ Usage: add data <subcat> "<name>" <price> "<validity>"');
      }
      const subcat = parts[0].toLowerCase();
      const name = parts[1];
      const price = Number(parts[2]);
      const validity = parts[3];
      if (!dataPackages[subcat]) {
        return client.sendMessage(sender, `❌ Invalid data category: ${subcat}`);
      }
      const arr = dataPackages[subcat];
      const newId = arr.length ? arr[arr.length - 1].id + 1 : 1;
      arr.push({ id: newId, name, price, validity });
      return client.sendMessage(sender, `✅ Added data package: [${newId}] ${name} @ KSH ${price} (${validity}) to ${subcat}.`);
    }
    if (lower.startsWith('remove data ')) {
      const parts = text.split(' ');
      if (parts.length < 4) {
        return client.sendMessage(sender, '❌ Usage: remove data <subcat> <id>');
      }
      const subcat = parts[2].toLowerCase();
      const idToRemove = Number(parts[3]);
      if (!dataPackages[subcat]) {
        return client.sendMessage(sender, `❌ Invalid data category: ${subcat}`);
      }
      const idx = dataPackages[subcat].findIndex(x => x.id === idToRemove);
      if (idx === -1) {
        return client.sendMessage(sender, `❌ No data package with ID ${idToRemove} in ${subcat}.`);
      }
      dataPackages[subcat].splice(idx, 1);
      return client.sendMessage(sender, `✅ Removed data package ID ${idToRemove} from ${subcat}.`);
    }
    if (lower.startsWith('edit data ')) {
      const parts = text.split(' ');
      if (parts.length < 5) {
        return client.sendMessage(sender, '❌ Usage: edit data <subcat> <id> <newprice>');
      }
      const subcat = parts[2].toLowerCase();
      const idToEdit = Number(parts[3]);
      const newPrice = Number(parts[4]);
      if (!dataPackages[subcat]) {
        return client.sendMessage(sender, `❌ Invalid data category: ${subcat}`);
      }
      const pack = dataPackages[subcat].find(x => x.id === idToEdit);
      if (!pack) {
        return client.sendMessage(sender, `❌ No data package with ID ${idToEdit} in ${subcat}.`);
      }
      pack.price = newPrice;
      return client.sendMessage(sender, `✅ Updated data package ID ${idToEdit} to KSH ${newPrice}.`);
    }
    if (lower.startsWith('add sms ')) {
      const parts = parseQuotedParts(text.split(' '), 2);
      if (parts.length < 4) {
        return client.sendMessage(sender, '❌ Usage: add sms <subcat> "<name>" <price> "<validity>"');
      }
      const subcat = parts[0].toLowerCase();
      const name = parts[1];
      const price = Number(parts[2]);
      const validity = parts[3];
      if (!smsPackages[subcat]) {
        return client.sendMessage(sender, `❌ Invalid sms category: ${subcat}`);
      }
      const arr = smsPackages[subcat];
      const newId = arr.length ? arr[arr.length - 1].id + 1 : 1;
      arr.push({ id: newId, name, price, validity });
      return client.sendMessage(sender, `✅ Added SMS package: [${newId}] ${name} @ KSH ${price} (${validity}) to ${subcat}.`);
    }
    if (lower.startsWith('remove sms ')) {
      const parts = text.split(' ');
      if (parts.length < 4) {
        return client.sendMessage(sender, '❌ Usage: remove sms <subcat> <id>');
      }
      const subcat = parts[2].toLowerCase();
      const idToRemove = Number(parts[3]);
      if (!smsPackages[subcat]) {
        return client.sendMessage(sender, `❌ Invalid sms category: ${subcat}`);
      }
      const idx = smsPackages[subcat].findIndex(x => x.id === idToRemove);
      if (idx === -1) {
        return client.sendMessage(sender, `❌ No SMS package with ID ${idToRemove} in ${subcat}.`);
      }
      smsPackages[subcat].splice(idx, 1);
      return client.sendMessage(sender, `✅ Removed SMS package ID ${idToRemove} from ${subcat}.`);
    }
    if (lower.startsWith('edit sms ')) {
      const parts = text.split(' ');
      if (parts.length < 5) {
        return client.sendMessage(sender, '❌ Usage: edit sms <subcat> <id> <newprice>');
      }
      const subcat = parts[2].toLowerCase();
      const idToEdit = Number(parts[3]);
      const newPrice = Number(parts[4]);
      if (!smsPackages[subcat]) {
        return client.sendMessage(sender, `❌ Invalid sms category: ${subcat}`);
      }
      const pack = smsPackages[subcat].find(x => x.id === idToEdit);
      if (!pack) {
        return client.sendMessage(sender, `❌ No SMS package with ID ${idToEdit} in ${subcat}.`);
      }
      pack.price = newPrice;
      return client.sendMessage(sender, `✅ Updated SMS package ID ${idToEdit} to KSH ${newPrice}.`);
    }
    if (lower === 'referrals all') {
      let resp = `📢 *All Referral Data*\nMinWithdraw: KSH ${MIN_WITHDRAWAL}, MaxWithdraw: KSH ${MAX_WITHDRAWAL}\n\n`;
      for (let r in referrals) {
        resp += `Referrer: ${r}\nCode: ${referrals[r].code}\nTotal Referred: ${referrals[r].referred.length}\nEarnings: KSH ${referrals[r].earnings}\nWithdrawals: ${referrals[r].withdrawals?.length || 0}\nPIN: ${referrals[r].pin ? 'Set' : 'Not Set'}\n\n`;
      }
      return client.sendMessage(sender, resp);
    }
    if (lower.startsWith('withdraw update ')) {
      const parts = text.split(' ');
      if (parts.length < 6) {
        return client.sendMessage(sender, '❌ Usage: withdraw update <ref_code> <wd_id> <STATUS> <remarks>');
      }
      const refCode = parts[2].toUpperCase();
      const wdId = parts[3];
      const newStatus = parts[4].toUpperCase();
      const remarks = parts.slice(5).join(' ');
      let foundUser = null;
      for (let u in referrals) {
        if (referrals[u].code === refCode) {
          foundUser = u;
          break;
        }
      }
      if (!foundUser) {
        return client.sendMessage(sender, `❌ No user with referral code ${refCode}.`);
      }
      const wdArr = referrals[foundUser].withdrawals || [];
      const wd = wdArr.find(x => x.id === wdId);
      if (!wd) {
        return client.sendMessage(sender, `❌ No withdrawal with ID ${wdId} for code ${refCode}.`);
      }
      wd.status = newStatus;
      wd.remarks = remarks;
      client.sendMessage(foundUser, `🔔 *Withdrawal Update*\nYour withdrawal (ID: ${wdId}) is now *${newStatus}*.\nRemarks: ${remarks}`);
      return client.sendMessage(sender, `✅ Updated withdrawal ${wdId} to ${newStatus} with remarks: "${remarks}".`);
    }
  } // END ADMIN

  // ========== REFERRAL QUICK COMMANDS ==========
  if (lower === 'referral') {
    const link = getReferralLink(sender);
    return client.sendMessage(sender, `😍 *Your Referral Link:*\n${link}\nShare with friends and earn KSH5 per successful order!`);
  }
  if (lower.startsWith('ref ')) {
    const parts = text.split(' ');
    if (parts.length === 2) {
      recordReferral(sender, parts[1].toUpperCase());
      return client.sendMessage(sender, `🙏 You've been referred by code *${parts[1].toUpperCase()}*. Enjoy our services!`);
    }
  }

  // ========== MAIN MENU (Client) ==========
  if (lower === 'menu' || lower === 'start') {
    session[sender] = { step: 'main' };
    const mainMenu = `🌟 *Welcome to FY'S ULTRA BOT!* 🌟\n\n` +
      `Thank you for choosing FYS PROPERTY!\n\n` +
      `Select an option:\n1️⃣ Airtime\n2️⃣ Data Bundles\n3️⃣ SMS Bundles\n4️⃣ My Referrals\n\n` +
      `For order status: status <ORDER_ID>\nAfter payment: PAID <ORDER_ID>\nType "00" anytime for main menu.`;
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

  // ---------- AIRTIME (Option 1) ----------
  if (session[sender]?.step === 'main' && text === '1') {
    session[sender].prevStep = 'main';
    session[sender].step = 'airtimeAmount';
    return client.sendMessage(sender, `💳 *Airtime Purchase*\nEnter the amount in KES (e.g., "50"):\nType "0" to go back.`);
  }
  if (session[sender]?.step === 'airtimeAmount') {
    const amt = Number(text);
    if (isNaN(amt) || amt <= 0) {
      return client.sendMessage(sender, '❌ Invalid amount. Please enter a valid number.');
    }
    session[sender].airtimeAmount = amt;
    session[sender].step = 'airtimeRecipient';
    return client.sendMessage(sender, `✅ Amount set to KSH ${amt}.\nEnter the recipient phone number (e.g., 07XXXXXXXX):`);
  }
  if (session[sender]?.step === 'airtimeRecipient') {
    if (!isSafaricomNumber(text)) {
      return client.sendMessage(sender, '❌ Invalid phone number.');
    }
    session[sender].airtimeRecipient = text;
    session[sender].step = 'airtimePayment';
    return client.sendMessage(sender, `✅ Recipient set: ${text}.\nEnter your payment number (e.g., 07XXXXXXXX):`);
  }
  if (session[sender]?.step === 'airtimePayment') {
    if (!isSafaricomNumber(text)) {
      return client.sendMessage(sender, '❌ Invalid payment number.');
    }
    const orderID = generateOrderID();
    orders[orderID] = {
      orderID,
      customer: sender,
      package: `Airtime (KES ${session[sender].airtimeAmount})`,
      amount: session[sender].airtimeAmount,
      recipient: session[sender].airtimeRecipient,
      payment: text,
      status: 'PENDING',
      timestamp: new Date().toISOString()
    };
    delete session[sender].airtimeAmount;
    delete session[sender].airtimeRecipient;
    session[sender].step = 'main';
    const summary = `🛒 *Order Created!*\n\n🆔 Order ID: *${orderID}*\n📦 Package: Airtime (KES ${orders[orderID].amount})\n💰 Price: KSH ${orders[orderID].amount}\n📞 Recipient: ${orders[orderID].recipient}\n📱 Payment: ${orders[orderID].payment}\n🕒 Placed at: ${formatKenyaTime(new Date(orders[orderID].timestamp))}\n\n👉 Please send KSH ${orders[orderID].amount} to *${PAYMENT_INFO}*.\nThen type: PAID ${orderID}\nType "00" for main menu.`;
    client.sendMessage(sender, summary);
    const adminMsg = `🔔 *New Airtime Order*\n\n🆔 ${orderID}\nPackage: Airtime (KES ${orders[orderID].amount})\nPrice: KSH ${orders[orderID].amount}\nRecipient: ${orders[orderID].recipient}\nPayment: ${orders[orderID].payment}\nTime: ${formatKenyaTime(new Date(orders[orderID].timestamp))}\nUser: ${sender}\n\n(Use admin commands to update)`;
    client.sendMessage(`${ADMIN_NUMBER}@c.us`, adminMsg);
    return;
  }

  // ---------- DATA BUNDLES (Option 2) ----------
  if (session[sender]?.step === 'main' && text === '2') {
    session[sender].prevStep = 'main';
    session[sender].step = 'dataCategory';
    return client.sendMessage(sender, `📶 *Data Bundles*\nChoose a subcategory:\n1) Hourly\n2) Daily\n3) Weekly\n4) Monthly\nType "0" to go back.`);
  }
  if (session[sender]?.step === 'dataCategory') {
    if (!['1','2','3','4'].includes(text)) {
      return client.sendMessage(sender, '❌ Invalid choice. Please type 1, 2, 3, or 4.');
    }
    let cat = (text === '1') ? 'hourly' : (text === '2') ? 'daily' : (text === '3') ? 'weekly' : 'monthly';
    session[sender].dataCat = cat;
    session[sender].prevStep = 'dataCategory';
    session[sender].step = 'dataList';
    let listMsg = `✅ *${cat.toUpperCase()} Data Bundles:*\n`;
    dataPackages[cat].forEach(p => { listMsg += `[${p.id}] ${p.name} @ KSH ${p.price} (${p.validity})\n`; });
    listMsg += `\nType the package ID to select, or "0" to go back.`;
    return client.sendMessage(sender, listMsg);
  }
  if (session[sender]?.step === 'dataList') {
    const cat = session[sender].dataCat;
    const pkgId = Number(text);
    if (isNaN(pkgId)) {
      return client.sendMessage(sender, '❌ Invalid package ID.');
    }
    const pkg = dataPackages[cat].find(x => x.id === pkgId);
    if (!pkg) {
      return client.sendMessage(sender, '❌ No package with that ID.');
    }
    session[sender].dataBundle = pkg;
    session[sender].prevStep = 'dataList';
    session[sender].step = 'dataRecip';
    return client.sendMessage(sender, `✅ Selected: ${pkg.name} (KSH ${pkg.price}).\nEnter recipient phone number (07XXXXXXXX):`);
  }
  if (session[sender]?.step === 'dataRecip') {
    if (!isSafaricomNumber(text)) {
      return client.sendMessage(sender, '❌ Invalid phone number.');
    }
    session[sender].dataRecipient = text;
    session[sender].prevStep = 'dataRecip';
    session[sender].step = 'dataPay';
    return client.sendMessage(sender, `✅ Recipient set: ${text}.\nEnter your payment number (07XXXXXXXX):`);
  }
  if (session[sender]?.step === 'dataPay') {
    if (!isSafaricomNumber(text)) {
      return client.sendMessage(sender, '❌ Invalid payment number.');
    }
    const orderID = generateOrderID();
    orders[orderID] = {
      orderID,
      customer: sender,
      package: `${session[sender].dataBundle.name} (${session[sender].dataCat})`,
      amount: session[sender].dataBundle.price,
      recipient: session[sender].dataRecipient,
      payment: text,
      status: 'PENDING',
      timestamp: new Date().toISOString()
    };
    if (session[sender].referrer) {
      orders[orderID].referrer = session[sender].referrer;
    }
    delete session[sender].dataBundle;
    delete session[sender].dataRecipient;
    session[sender].step = 'main';
    const summary = `🛒 *Order Created!*\n\n🆔 ${orderID}\nPackage: ${orders[orderID].package}\n💰 KSH ${orders[orderID].amount}\n📞 Recipient: ${orders[orderID].recipient}\n📱 Payment: ${orders[orderID].payment}\n🕒 Placed at: ${formatKenyaTime(new Date(orders[orderID].timestamp))}\n\n👉 Send KSH ${orders[orderID].amount} to *${PAYMENT_INFO}*.\nThen type: PAID ${orderID}\nType "00" for main menu.`;
    client.sendMessage(sender, summary);
    const adminMsg = `🔔 *New Data Order*\n\n🆔 ${orderID}\nPackage: ${orders[orderID].package}\nPrice: KSH ${orders[orderID].amount}\nRecipient: ${orders[orderID].recipient}\nPayment: ${orders[orderID].payment}\nTime: ${formatKenyaTime(new Date(orders[orderID].timestamp))}\nUser: ${sender}\n\n(Use admin commands to update.)`;
    client.sendMessage(`${ADMIN_NUMBER}@c.us`, adminMsg);
    return;
  }

  // ---------- SMS BUNDLES (Option 3) ----------
  if (session[sender]?.step === 'main' && text === '3') {
    session[sender].prevStep = 'main';
    session[sender].step = 'smsCategory';
    return client.sendMessage(sender, `✉️ *SMS Bundles*\nChoose a subcategory:\n1) Daily\n2) Weekly\n3) Monthly\nType "0" to go back.`);
  }
  if (session[sender]?.step === 'smsCategory') {
    if (!['1','2','3'].includes(text)) {
      return client.sendMessage(sender, '❌ Invalid choice.');
    }
    let cat = (text === '1') ? 'daily' : (text === '2') ? 'weekly' : 'monthly';
    session[sender].smsCat = cat;
    session[sender].prevStep = 'smsCategory';
    session[sender].step = 'smsList';
    let listMsg = `✅ *${cat.toUpperCase()} SMS Bundles:*\n`;
    smsPackages[cat].forEach(x => { listMsg += `[${x.id}] ${x.name} @ KSH ${x.price} (${x.validity})\n`; });
    listMsg += `\nType the package ID, or "0" to go back.`;
    return client.sendMessage(sender, listMsg);
  }
  if (session[sender]?.step === 'smsList') {
    const cat = session[sender].smsCat;
    const pkgId = Number(text);
    if (isNaN(pkgId)) {
      return client.sendMessage(sender, '❌ Invalid package ID.');
    }
    const pkg = smsPackages[cat].find(x => x.id === pkgId);
    if (!pkg) {
      return client.sendMessage(sender, '❌ No package with that ID.');
    }
    session[sender].smsBundle = pkg;
    session[sender].prevStep = 'smsList';
    session[sender].step = 'smsRecip';
    return client.sendMessage(sender, `✅ Selected: ${pkg.name} (KSH ${pkg.price}).\nEnter recipient phone number (07XXXXXXXX):`);
  }
  if (session[sender]?.step === 'smsRecip') {
    if (!isSafaricomNumber(text)) {
      return client.sendMessage(sender, '❌ Invalid phone number.');
    }
    session[sender].smsRecipient = text;
    session[sender].prevStep = 'smsRecip';
    session[sender].step = 'smsPay';
    return client.sendMessage(sender, `✅ Recipient set: ${text}.\nEnter your payment number (07XXXXXXXX):`);
  }
  if (session[sender]?.step === 'smsPay') {
    if (!isSafaricomNumber(text)) {
      return client.sendMessage(sender, '❌ Invalid payment number.');
    }
    const orderID = generateOrderID();
    orders[orderID] = {
      orderID,
      customer: sender,
      package: `${session[sender].smsBundle.name} (SMS - ${session[sender].smsCat})`,
      amount: session[sender].smsBundle.price,
      recipient: session[sender].smsRecipient,
      payment: text,
      status: 'PENDING',
      timestamp: new Date().toISOString()
    };
    if (session[sender].referrer) {
      orders[orderID].referrer = session[sender].referrer;
    }
    delete session[sender].smsBundle;
    delete session[sender].smsRecipient;
    session[sender].step = 'main';
    const summary = `🛒 *Order Created!*\n\n🆔 Order ID: *${orderID}*\nPackage: ${orders[orderID].package}\n💰 KSH ${orders[orderID].amount}\n📞 Recipient: ${orders[orderID].recipient}\n📱 Payment: ${orders[orderID].payment}\n🕒 Placed at: ${formatKenyaTime(new Date(orders[orderID].timestamp))}\n\n👉 Send KSH ${orders[orderID].amount} to *${PAYMENT_INFO}*.\nThen type: PAID ${orderID}\nType "00" for main menu.`;
    client.sendMessage(sender, summary);
    const adminMsg = `🔔 *New SMS Order*\n\n🆔 ${orderID}\nPackage: ${orders[orderID].package}\nPrice: KSH ${orders[orderID].amount}\nRecipient: ${orders[orderID].recipient}\nPayment: ${orders[orderID].payment}\nTime: ${formatKenyaTime(new Date(orders[orderID].timestamp))}\nUser: ${sender}\n\n(Use admin commands to update.)`;
    client.sendMessage(`${ADMIN_NUMBER}@c.us`, adminMsg);
    return;
  }

  // ---------- Capture Recipient (common for orders) ----------
  const pendingRecip = Object.values(orders).find(o => o.customer === sender && !o.recipient);
  if (pendingRecip) {
    if (!isSafaricomNumber(text)) {
      return client.sendMessage(sender, '❌ Invalid phone number.');
    }
    pendingRecip.recipient = text;
    return client.sendMessage(sender, `✅ Recipient set to ${text}.\nNow enter your payment number (07XXXXXXXX):`);
  }

  // ---------- Capture Payment (common for orders) ----------
  const pendingPay = Object.values(orders).find(o => o.customer === sender && o.recipient && !o.payment);
  if (pendingPay) {
    if (!isSafaricomNumber(text)) {
      return client.sendMessage(sender, '❌ Invalid payment number.');
    }
    pendingPay.payment = text;
    const order = pendingPay;
    const summary = `🎉 *Order Summary*\n\n🆔 Order ID: ${order.orderID}\nPackage: ${order.package}\n💰 KSH ${order.amount}\n📞 Recipient: ${order.recipient}\n📱 Payment: ${order.payment}\n🕒 Placed at: ${formatKenyaTime(new Date(order.timestamp))}\n\n👉 Send KSH ${order.amount} to *${PAYMENT_INFO}*.\nThen type: PAID ${order.orderID}\nType "0" to go back or "00" for main menu.`;
    client.sendMessage(sender, summary);
    const adminMsg = `🔔 *New Order Received!*\n\n🆔 ${order.orderID}\nPackage: ${order.package}\nPrice: KSH ${order.amount}\nRecipient: ${order.recipient}\nPayment: ${order.payment}\nTime: ${formatKenyaTime(new Date(order.timestamp))}\nUser: ${sender}\n\n(Use admin commands to update.)`;
    client.sendMessage(`${ADMIN_NUMBER}@c.us`, adminMsg);
    return;
  }

  // ---------- Confirm Payment ----------
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
    if (orders[orderID].referrer && !orders[orderID].referralCredited) {
      for (let ref in referrals) {
        if (referrals[ref].code === orders[orderID].referrer) {
          referrals[ref].earnings += 5;
          break;
        }
      }
      orders[orderID].referralCredited = true;
    }
    client.sendMessage(sender, `✅ Payment confirmed for order ${orderID}!\nYour order is now *CONFIRMED*.\n✨ Thank you for choosing FYS PROPERTY! For help, call 0701339573.\nType "00" for main menu.`);
    client.sendMessage(`${ADMIN_NUMBER}@c.us`, `🔔 Order ${orderID} marked as CONFIRMED by user.`);
    return;
  }

  // ---------- Order Status ----------
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
    return client.sendMessage(sender, `📦 *Order Details*\n\n🆔 Order ID: ${o.orderID}\nPackage: ${o.package}\n💰 KSH ${o.amount}\n📞 Recipient: ${o.recipient}\n📱 Payment: ${o.payment}\n📌 Status: ${o.status}\n🕒 Placed at: ${formatKenyaTime(new Date(o.timestamp))}\n📝 Remark: ${o.remark || 'None'}\n\nType "0" for previous or "00" for main menu.`);
  }

  // ---------- MY REFERRALS MENU (Option 4) ----------
  if (session[sender]?.step === 'main' && text === '4') {
    session[sender].prevStep = 'main';
    session[sender].step = 'myReferralsMenu';
    const refMenu = `🌟 *My Referrals Menu* 🌟\n\nChoose an option:\n1️⃣ View Earnings & Balance\n2️⃣ Withdraw Earnings\n3️⃣ Get Referral Link\n4️⃣ Set/Update PIN\n5️⃣ View Referred Users\n\nType the number, or "0" to go back.`;
    return client.sendMessage(sender, refMenu);
  }
  if (session[sender]?.step === 'myReferralsMenu') {
    if (text === '1') {
      if (!referrals[sender]) {
        return client.sendMessage(sender, `😞 No referral record. Type "referral" to get your link!`);
      }
      const r = referrals[sender];
      let msg = `📢 *Your Referral Overview*\nReferral Code: ${r.code}\nEarnings: KSH ${r.earnings}\nTotal Referred: ${r.referred.length}\n\nWithdrawal History:\n`;
      if (r.withdrawals.length === 0) {
        msg += `None yet.`;
      } else {
        r.withdrawals.forEach((wd, i) => {
          msg += `${i+1}. ID: ${wd.id}, Amt: KSH ${wd.amount}, Status: ${wd.status}, Time: ${formatKenyaTime(new Date(wd.timestamp))}\nRemarks: ${wd.remarks}\n\n`;
        });
      }
      return client.sendMessage(sender, msg);
    } else if (text === '2') {
      if (!referrals[sender] || referrals[sender].earnings < MIN_WITHDRAWAL) {
        return client.sendMessage(sender, `😞 You need at least KSH ${MIN_WITHDRAWAL} to withdraw.`);
      }
      if (!referrals[sender].pin) {
        return client.sendMessage(sender, `⚠️ No PIN set. Choose option 4 to set your PIN first.`);
      }
      session[sender].step = 'withdrawRequest';
      return client.sendMessage(sender, `💸 *Withdrawal Request*\nEnter "<amount> <mpesa_number>" e.g., "50 0712345678".\nLimits: Min KSH ${MIN_WITHDRAWAL}, Max KSH ${MAX_WITHDRAWAL}\nType "0" to go back.`);
    } else if (text === '3') {
      const link = getReferralLink(sender);
      return client.sendMessage(sender, `😍 *Your Referral Link:*\n${link}\nShare it with friends to earn KSH5 per successful referral!`);
    } else if (text === '4') {
      session[sender].step = 'setPin';
      return client.sendMessage(sender, `🔐 *Set/Update PIN*\nEnter a new 4-digit PIN (cannot be 1234 or 0000):`);
    } else if (text === '5') {
      if (!referrals[sender] || referrals[sender].referred.length === 0) {
        return client.sendMessage(sender, `😞 You haven't referred anyone yet. Type "referral" to get your link!`);
      }
      let list = `👥 *Referred Users* (masked):\n\n`;
      referrals[sender].referred.forEach((u, i) => {
        const masked = maskWhatsAppID(u);
        const ordersByUser = Object.values(orders).filter(o => o.customer === u);
        const total = ordersByUser.length;
        const canceled = ordersByUser.filter(o => o.status === 'CANCELLED').length;
        list += `${i+1}. ${masked}\n   Orders: ${total}, Cancelled: ${canceled}\n\n`;
      });
      return client.sendMessage(sender, list);
    } else {
      return client.sendMessage(sender, '❌ Invalid choice. Type 1,2,3,4,5 or "0" to go back.');
    }
  }

  // ---------- WITHDRAWAL REQUEST FLOW ----------
  if (session[sender]?.step === 'withdrawRequest') {
    const parts = text.split(' ');
    if (parts.length !== 2) {
      return client.sendMessage(sender, '❌ Usage: "<amount> <mpesa_number>" e.g., "50 0712345678"');
    }
    const amount = Number(parts[0]);
    const mpesa = parts[1];
    if (isNaN(amount) || amount <= 0) {
      return client.sendMessage(sender, '❌ Invalid amount.');
    }
    if (!isSafaricomNumber(mpesa)) {
      return client.sendMessage(sender, '❌ Invalid M-Pesa number.');
    }
    if (amount > referrals[sender].earnings || amount > MAX_WITHDRAWAL) {
      return client.sendMessage(sender, `❌ You cannot withdraw more than your earnings (KSH ${referrals[sender].earnings}) or max limit (KSH ${MAX_WITHDRAWAL}).`);
    }
    if (amount < MIN_WITHDRAWAL) {
      return client.sendMessage(sender, `❌ Minimum withdrawal is KSH ${MIN_WITHDRAWAL}.`);
    }
    session[sender].withdrawRequest = { amount, mpesa };
    session[sender].step = 'withdrawPin';
    return client.sendMessage(sender, `🔒 Enter your 4-digit PIN to confirm withdrawal of KSH ${amount} to ${mpesa}.`);
  }
  if (session[sender]?.step === 'withdrawPin') {
    if (!/^\d{4}$/.test(text)) {
      return client.sendMessage(sender, '❌ PIN must be exactly 4 digits.');
    }
    if (referrals[sender].pin !== text) {
      return client.sendMessage(sender, '❌ Incorrect PIN. Withdrawal canceled.');
    }
    const req = session[sender].withdrawRequest;
    const wd = {
      id: `WD-${Math.floor(1000 + Math.random() * 9000)}`,
      amount: req.amount,
      mpesa: req.mpesa,
      status: 'PENDING',
      timestamp: new Date().toISOString(),
      remarks: ''
    };
    referrals[sender].withdrawals.push(wd);
    referrals[sender].earnings -= req.amount;
    delete session[sender].withdrawRequest;
    session[sender].step = 'myReferralsMenu';
    client.sendMessage(sender, `🙏 *Withdrawal Requested!*\nID: ${wd.id}, Amount: KSH ${wd.amount} to ${wd.mpesa}\nStatus: PENDING.\nThank you for choosing FYS PROPERTY!`);
    client.sendMessage(`${ADMIN_NUMBER}@c.us`, `🔔 *New Withdrawal Request*\nUser: ${sender}\nWD ID: ${wd.id}\nAmount: KSH ${wd.amount}\nM-Pesa: ${wd.mpesa}\nTime: ${formatKenyaTime(new Date(wd.timestamp))}\nUse "withdraw update <ref_code> <wd_id> <STATUS> <remarks>" to update.`);
    return;
  }
  if (session[sender]?.step === 'setPin') {
    if (!/^\d{4}$/.test(text)) {
      return client.sendMessage(sender, '❌ PIN must be exactly 4 digits.');
    }
    if (text === '1234' || text === '0000') {
      return client.sendMessage(sender, '❌ That PIN is not allowed.');
    }
    if (!referrals[sender]) {
      const code = 'REF' + Math.floor(100000 + Math.random() * 900000);
      referrals[sender] = { code, referred: [], earnings: 0, withdrawals: [], pin: text };
    } else {
      referrals[sender].pin = text;
    }
    session[sender].step = 'myReferralsMenu';
    return client.sendMessage(sender, `✅ Your PIN has been set to ${text}. Returning to My Referrals menu.`);
  }

  // ---------- Independent Commands: Order Status & Payment ----------
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
    return client.sendMessage(sender, `📦 *Order Details*\n\n🆔 Order ID: ${o.orderID}\nPackage: ${o.package}\n💰 KSH ${o.amount}\n📞 Recipient: ${o.recipient}\n📱 Payment: ${o.payment}\n📌 Status: ${o.status}\n🕒 Placed at: ${formatKenyaTime(new Date(o.timestamp))}\n📝 Remark: ${o.remark || 'None'}\n\nType "0" for previous or "00" for main menu.`);
  }
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
    if (orders[orderID].referrer && !orders[orderID].referralCredited) {
      for (let ref in referrals) {
        if (referrals[ref].code === orders[orderID].referrer) {
          referrals[ref].earnings += 5;
          break;
        }
      }
      orders[orderID].referralCredited = true;
    }
    client.sendMessage(sender, `✅ Payment confirmed for order ${orderID}!\nYour order is now *CONFIRMED*.\n✨ Thank you for choosing FYS PROPERTY! For help, call 0701339573.\nType "00" for main menu.`);
    client.sendMessage(`${ADMIN_NUMBER}@c.us`, `🔔 Order ${orderID} marked as CONFIRMED by user ${sender}.`);
    return;
  }

  // ---------- FALLBACK ----------
  client.sendMessage(sender, `🤖 *FY'S ULTRA BOT*\nType "menu" for main menu.\nFor order status: status <ORDER_ID>\nAfter payment: PAID <ORDER_ID>\nFor referrals: referral or my referrals\nOr "0"/"00" for navigation.`);
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
