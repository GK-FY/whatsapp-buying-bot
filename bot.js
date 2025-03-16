require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');
const express = require('express');
const fetch = require('node-fetch');  // Using node-fetch@2, so CommonJS require() works

/**
 * =============================
 * CONFIGURATION & GLOBALS
 * =============================
 */
const ADMIN_NUMBER = process.env.ADMIN_NUMBER || '254701339573';
let PAYMENT_INFO = '0701339573 (Camlus)'; // Admin can change
const PORT = 3000;

// PayHero STK push credentials (admin can update via "set payhero" command)
let PAYHERO_CHANNEL_ID = 911;
let PAYHERO_AUTH_BASE64 = '3A6anVoWFZrRk5qSVl0MGNMOERGMlR3dlhrQ0VWUWJHNDVVVnNaMEdDSw==';

// Min/Max withdrawal (admin can update)
let MIN_WITHDRAWAL = 20;
let MAX_WITHDRAWAL = 1000;

// In-memory data
const orders = {};    // key=orderID → order details
const referrals = {}; // key=user → { code, referred:[], earnings, withdrawals:[], pin, parent?: string }
const session = {};   // key=user → { step, prevStep, etc. }
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

// Generate a unique order ID
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
  client.sendMessage(`${ADMIN_NUMBER}@c.us`, `🎉 Hello Admin! FY'S ULTRA BOT is now live.\nType "menu" for user flow or "Admin CMD" for admin commands.`);
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
    // Admin CMD
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

    // set payhero <channel_id> <base64Auth>
    if (lower.startsWith('set payhero ')) {
      const parts = text.split(' ');
      if (parts.length < 4) {
        return client.sendMessage(sender, '❌ Usage: set payhero <channel_id> <base64Auth>');
      }
      const chId = Number(parts[2]);
      const auth = parts[3];
      if (isNaN(chId) || chId <= 0) {
        return client.sendMessage(sender, '❌ channel_id must be a positive number.');
      }
      PAYHERO_CHANNEL_ID = chId;
      PAYHERO_AUTH_BASE64 = auth;
      return client.sendMessage(sender, `✅ Updated STK push config:\nchannel_id = ${chId}\nAuthorization = Basic ${auth}`);
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
    // set withdrawal
    if (lower.startsWith('set withdrawal ')) {
      const splitted = text.split(' ');
      if (splitted.length !== 4) {
        return client.sendMessage(sender, '❌ Usage: set withdrawal <min> <max>');
      }
      const minW = Number(splitted[2]);
      const maxW = Number(splitted[3]);
      if (isNaN(minW) || isNaN(maxW) || minW <= 0 || maxW <= minW) {
        return client.sendMessage(sender, '❌ Provide valid numbers (max > min > 0).');
      }
      MIN_WITHDRAWAL = minW;
      MAX_WITHDRAWAL = maxW;
      return client.sendMessage(sender, `✅ Withdrawal limits updated: min = KSH ${MIN_WITHDRAWAL}, max = KSH ${MAX_WITHDRAWAL}`);
    }
    // update <ORDER_ID> <STATUS> <REMARK>
    if (lower.startsWith('update ')) {
      const splitted = text.split(' ');
      if (splitted.length < 4) {
        return client.sendMessage(sender, '❌ Usage: update <ORDER_ID> <STATUS> <REMARK>');
      }
      const orderID = splitted[1];
      const status = splitted[2].toUpperCase();
      const remark = splitted.slice(3).join(' ');
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
        extra = '🎉 Your order has been completed! Thank you for choosing FYS PROPERTY.';
        // two-level referral bonus
        if (orders[orderID].referrer) {
          let direct = null;
          for (let u in referrals) {
            if (referrals[u].code === orders[orderID].referrer) {
              direct = u;
              referrals[u].earnings += 5;
              client.sendMessage(u, `🔔 Congrats! You earned KSH5 from a successful referral order!`);
              break;
            }
          }
          // second-level
          if (direct && referrals[direct].parent) {
            const parentCode = referrals[direct].parent;
            for (let v in referrals) {
              if (referrals[v].code === parentCode) {
                referrals[v].earnings += 5;
                client.sendMessage(v, `🔔 Great news! You earned KSH5 as a second-level referral bonus!`);
                break;
              }
            }
          }
        }
      } else if (status === 'CANCELLED') {
        extra = `😔 We regret to inform you that your order was cancelled.\nOrder ID: ${orderID}\nPackage: ${orders[orderID].package}\nPlaced at: ${formatKenyaTime(new Date(orders[orderID].timestamp))}\nRemark: ${remark}\nPlease contact support if needed.`;
      } else if (status === 'REFUNDED') {
        extra = '💰 Your order was refunded. Check your M-Pesa balance.';
      } else {
        extra = 'Your order status has been updated.';
      }
      client.sendMessage(user, `🔔 *Order Update*\nYour order *${orderID}* => *${status}*\n${extra}\n\nReply "0" or "00" for menus.`);
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
    // add data ...
    if (lower.startsWith('add data ')) {
      const splitted = parseQuotedParts(text.split(' '), 2);
      if (splitted.length < 4) {
        return client.sendMessage(sender, '❌ Usage: add data <subcat> "<name>" <price> "<validity>"');
      }
      const subcat = splitted[0].toLowerCase();
      const name = splitted[1];
      const price = Number(splitted[2]);
      const validity = splitted[3];
      if (!dataPackages[subcat]) {
        return client.sendMessage(sender, `❌ Invalid data category: ${subcat}`);
      }
      const arr = dataPackages[subcat];
      const newId = arr.length ? arr[arr.length - 1].id + 1 : 1;
      arr.push({ id: newId, name, price, validity });
      return client.sendMessage(sender, `✅ Added data package: [${newId}] ${name} @ KSH ${price} (${validity}) to ${subcat}.`);
    }
    // remove data ...
    if (lower.startsWith('remove data ')) {
      const splitted = text.split(' ');
      if (splitted.length < 4) {
        return client.sendMessage(sender, '❌ Usage: remove data <subcat> <id>');
      }
      const subcat = splitted[2].toLowerCase();
      const idToRemove = Number(splitted[3]);
      if (!dataPackages[subcat]) {
        return client.sendMessage(sender, `❌ Invalid data subcat: ${subcat}`);
      }
      const idx = dataPackages[subcat].findIndex(x => x.id === idToRemove);
      if (idx === -1) {
        return client.sendMessage(sender, `❌ No data package with ID ${idToRemove}.`);
      }
      dataPackages[subcat].splice(idx, 1);
      return client.sendMessage(sender, `✅ Removed data package ID ${idToRemove} from ${subcat}.`);
    }
    // edit data ...
    if (lower.startsWith('edit data ')) {
      const splitted = text.split(' ');
      if (splitted.length < 5) {
        return client.sendMessage(sender, '❌ Usage: edit data <subcat> <id> <newprice>');
      }
      const subcat = splitted[2].toLowerCase();
      const idToEdit = Number(splitted[3]);
      const newPrice = Number(splitted[4]);
      if (!dataPackages[subcat]) {
        return client.sendMessage(sender, `❌ Invalid data subcat: ${subcat}`);
      }
      const pack = dataPackages[subcat].find(x => x.id === idToEdit);
      if (!pack) {
        return client.sendMessage(sender, `❌ No data package with ID ${idToEdit}.`);
      }
      pack.price = newPrice;
      return client.sendMessage(sender, `✅ Updated data package ID ${idToEdit} to KSH ${newPrice}.`);
    }
    // add sms ...
    if (lower.startsWith('add sms ')) {
      const splitted = parseQuotedParts(text.split(' '), 2);
      if (splitted.length < 4) {
        return client.sendMessage(sender, '❌ Usage: add sms <subcat> "<name>" <price> "<validity>"');
      }
      const subcat = splitted[0].toLowerCase();
      const name = splitted[1];
      const price = Number(splitted[2]);
      const validity = splitted[3];
      if (!smsPackages[subcat]) {
        return client.sendMessage(sender, `❌ Invalid sms subcat: ${subcat}`);
      }
      const arr = smsPackages[subcat];
      const newId = arr.length ? arr[arr.length - 1].id + 1 : 1;
      arr.push({ id: newId, name, price, validity });
      return client.sendMessage(sender, `✅ Added SMS package: [${newId}] ${name} @ KSH ${price} (${validity}) to ${subcat}.`);
    }
    // remove sms ...
    if (lower.startsWith('remove sms ')) {
      const splitted = text.split(' ');
      if (splitted.length < 4) {
        return client.sendMessage(sender, '❌ Usage: remove sms <subcat> <id>');
      }
      const subcat = splitted[2].toLowerCase();
      const idToRemove = Number(splitted[3]);
      if (!smsPackages[subcat]) {
        return client.sendMessage(sender, `❌ Invalid sms subcat: ${subcat}`);
      }
      const idx = smsPackages[subcat].findIndex(x => x.id === idToRemove);
      if (idx === -1) {
        return client.sendMessage(sender, `❌ No SMS package with ID ${idToRemove}.`);
      }
      smsPackages[subcat].splice(idx, 1);
      return client.sendMessage(sender, `✅ Removed SMS package ID ${idToRemove} from ${subcat}.`);
    }
    // edit sms ...
    if (lower.startsWith('edit sms ')) {
      const splitted = text.split(' ');
      if (splitted.length < 5) {
        return client.sendMessage(sender, '❌ Usage: edit sms <subcat> <id> <newprice>');
      }
      const subcat = splitted[2].toLowerCase();
      const idToEdit = Number(splitted[3]);
      const newPrice = Number(splitted[4]);
      if (!smsPackages[subcat]) {
        return client.sendMessage(sender, `❌ Invalid sms subcat: ${subcat}`);
      }
      const pack = smsPackages[subcat].find(x => x.id === idToEdit);
      if (!pack) {
        return client.sendMessage(sender, `❌ No SMS package with ID ${idToEdit}.`);
      }
      pack.price = newPrice;
      return client.sendMessage(sender, `✅ Updated SMS package ID ${idToEdit} to KSH ${newPrice}.`);
    }
    // referrals all
    if (lower === 'referrals all') {
      let resp = `🙌 *All Referral Data*\nWithdrawal Limits: Min KSH ${MIN_WITHDRAWAL}, Max KSH ${MAX_WITHDRAWAL}\n\n`;
      for (let u in referrals) {
        resp += `User: ${u}\nCode: ${referrals[u].code}\nTotal Referred: ${referrals[u].referred.length}\nEarnings: KSH ${referrals[u].earnings}\nWithdrawals: ${referrals[u].withdrawals.length}\nPIN: ${referrals[u].pin || 'Not Set'}\nParent: ${referrals[u].parent || 'None'}\n\n`;
      }
      return client.sendMessage(sender, resp);
    }
    // withdraw update ...
    if (lower.startsWith('withdraw update ')) {
      const splitted = text.split(' ');
      if (splitted.length < 6) {
        return client.sendMessage(sender, '❌ Usage: withdraw update <ref_code> <wd_id> <STATUS> <remarks>');
      }
      const refCode = splitted[2].toUpperCase();
      const wdId = splitted[3];
      const newStatus = splitted[4].toUpperCase();
      const remarks = splitted.slice(5).join(' ');
      let foundUser = null;
      for (let user in referrals) {
        if (referrals[user].code === refCode) {
          foundUser = user;
          break;
        }
      }
      if (!foundUser) return client.sendMessage(sender, `❌ No user with referral code ${refCode}.`);
      const wdArr = referrals[foundUser].withdrawals;
      const wd = wdArr.find(x => x.id === wdId);
      if (!wd) return client.sendMessage(sender, `❌ No withdrawal with ID ${wdId} for code ${refCode}.`);
      wd.status = newStatus;
      wd.remarks = remarks;
      client.sendMessage(foundUser, `🔔 *Withdrawal Update*\nYour withdrawal (ID: ${wdId}) => *${newStatus}*.\nRemarks: ${remarks} 👍`);
      return client.sendMessage(sender, `✅ Updated withdrawal ${wdId} to ${newStatus} with remarks: "${remarks}".`);
    }
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
  }

  // ========== REFERRAL QUICK COMMANDS ==========
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

  // ========== MAIN MENU NAV ==========
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
    // finalize order
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

  // ---------- Data & SMS flows are analogous ----------
  // (In each final step, we do the same STK push approach and fallback.)

  // ---------- Confirm Payment (User typed "PAID <ORDER_ID>")
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
    // Two-level referral bonus if not yet credited
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

  // ---------- Order Status (User typed "status <ORDER_ID>")
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

  // ---------- My Referrals (Option 4) etc. ----------
  // ... (The rest of the flows for My Referrals, PIN change, and withdrawal are analogous)
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
