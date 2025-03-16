require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');
const express = require('express');

/**
 * =============================
 * CONFIG & GLOBALS
 * =============================
 */
const ADMIN_NUMBER = process.env.ADMIN_NUMBER || '254701339573';
let PAYMENT_INFO = '0701339573 (Camlus)'; // Admin can change
const PORT = 3000;

// Min/Max withdrawal
let MIN_WITHDRAWAL = 20;
let MAX_WITHDRAWAL = 1000;

// In-memory stores
const orders = {};    // key=orderID => { orderID, customer, package, amount, recipient, payment, status, timestamp, remark?, referrer? }
const referrals = {}; // key=userNumber => { code, referred:[...], earnings, withdrawals:[], pin, ... }
const session = {};   // key=userNumber => { step, prevStep, ... }

/**
 * Format date/time in Kenyan local time (UTC+3) manually
 */
function formatKenyaTime(date) {
  // Convert to UTC ms
  const utcMs = date.getTime() + (date.getTimezoneOffset() * 60000);
  // Add +3 hours
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

/**
 * Mask a WhatsApp ID partially
 */
function maskWhatsAppID(waid) {
  const atIndex = waid.indexOf('@');
  if (atIndex === -1) return waid;
  const phone = waid.slice(0, atIndex); 
  if (phone.length < 6) return waid;
  const first5 = phone.slice(0, 5);
  const last1 = phone.slice(-1);
  return `${first5}****${last1}@c.us`;
}

/**
 * Generate a unique order ID
 */
function generateOrderID() {
  return `FY'S-${Math.floor(100000 + Math.random() * 900000)}`;
}

/**
 * Validate Safaricom number
 */
function isSafaricomNumber(num) {
  return /^0[71]\d{8}$/.test(num) || /^01\d{8}$/.test(num);
}

/**
 * Data & SMS packages
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
 * The WhatsApp client
 */
const { puppeteer } = require('whatsapp-web.js');
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: { headless: true }
});

let qrImageUrl = null;
client.on('qr', qr => {
  console.log('Scan QR code below:');
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
 * Referral helpers
 */
function getReferralLink(sender) {
  if (!referrals[sender]) {
    const code = 'REF' + Math.floor(100000 + Math.random() * 900000);
    referrals[sender] = { code, referred: [], earnings: 0, withdrawals: [], pin: null };
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
 * Admin command parser
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
 * Main message handler
 */
client.on('message', async msg => {
  const sender = msg.from;
  const text = msg.body.trim();
  const lower = text.toLowerCase();

  // ---------- ADMIN COMMANDS ----------
  if (sender === `${ADMIN_NUMBER}@c.us`) {
    if (lower === 'admin cmd') {
      const adminCmds = `📜 *Admin Commands:*\n
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
14) earnings deduct <ref_code> <amount> <remarks>`;
      return client.sendMessage(sender, adminCmds);
    }

    // earnings add <ref_code> <amount> <remarks>
    if (lower.startsWith('earnings add ')) {
      const splitted = text.split(' ');
      if (splitted.length < 5) {
        return client.sendMessage(sender, '❌ Usage: earnings add <ref_code> <amount> <remarks>');
      }
      const refCode = splitted[2].toUpperCase();
      const amount = Number(splitted[3]);
      const remarks = splitted.slice(4).join(' ');
      if (isNaN(amount) || amount <= 0) {
        return client.sendMessage(sender, '❌ Invalid amount.');
      }
      // find user
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
      referrals[foundUser].earnings += amount;
      client.sendMessage(foundUser, `🔔 *Admin Adjustment*\nYour referral earnings have been *increased* by KSH ${amount}.\nRemarks: ${remarks}\nCurrent Earnings: KSH ${referrals[foundUser].earnings}`);
      return client.sendMessage(sender, `✅ Added KSH ${amount} to user ${foundUser} (ref code ${refCode}).`);
    }

    // earnings deduct <ref_code> <amount> <remarks>
    if (lower.startsWith('earnings deduct ')) {
      const splitted = text.split(' ');
      if (splitted.length < 5) {
        return client.sendMessage(sender, '❌ Usage: earnings deduct <ref_code> <amount> <remarks>');
      }
      const refCode = splitted[2].toUpperCase();
      const amount = Number(splitted[3]);
      const remarks = splitted.slice(4).join(' ');
      if (isNaN(amount) || amount <= 0) {
        return client.sendMessage(sender, '❌ Invalid amount.');
      }
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
      if (referrals[foundUser].earnings < amount) {
        return client.sendMessage(sender, `❌ User has only KSH ${referrals[foundUser].earnings} in earnings. Can't deduct ${amount}.`);
      }
      referrals[foundUser].earnings -= amount;
      client.sendMessage(foundUser, `🔔 *Admin Adjustment*\nYour referral earnings have been *deducted* by KSH ${amount}.\nRemarks: ${remarks}\nCurrent Earnings: KSH ${referrals[foundUser].earnings}`);
      return client.sendMessage(sender, `✅ Deducted KSH ${amount} from user ${foundUser} (ref code ${refCode}).`);
    }

    // set withdrawal <min> <max>
    if (lower.startsWith('set withdrawal ')) {
      const splitted = text.split(' ');
      if (splitted.length !== 4) {
        return client.sendMessage(sender, '❌ Usage: set withdrawal <min> <max>');
      }
      const minW = Number(splitted[2]);
      const maxW = Number(splitted[3]);
      if (isNaN(minW) || isNaN(maxW) || minW <= 0 || maxW <= minW) {
        return client.sendMessage(sender, '❌ Provide valid numbers, max > min > 0');
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
      const newStatus = splitted[2].toUpperCase();
      const remark = splitted.slice(3).join(' ');
      if (!orders[orderID]) {
        return client.sendMessage(sender, `❌ Order ${orderID} not found.`);
      }
      orders[orderID].status = newStatus;
      orders[orderID].remark = remark;
      const user = orders[orderID].customer;
      let extra = '';
      if (newStatus === 'CONFIRMED') {
        extra = '✅ Payment confirmed! We are processing your order. Thank you for your patience.';
      } else if (newStatus === 'COMPLETED') {
        extra = '🎉 Your order is completed! We appreciate you choosing FYS PROPERTY!';
      } else if (newStatus === 'CANCELLED') {
        extra = `😔 We regret to inform you that your order was cancelled.\n\nOrder ID: ${orderID}\nPackage: ${orders[orderID].package}\nPlaced: ${formatKenyaTime(new Date(orders[orderID].timestamp))}\nRemark: ${remark}\nPlease contact support if needed.`;
      } else if (newStatus === 'REFUNDED') {
        extra = '💰 Your order was refunded. Check your M-Pesa balance.';
      } else {
        extra = 'Your order status has been updated.';
      }
      client.sendMessage(user, `🔔 *Order Update*\nOrder *${orderID}* => *${newStatus}*\n${extra}\n\nReply "0" or "00" for menus.`);
      return client.sendMessage(sender, `✅ Order *${orderID}* => *${newStatus}*, remark: "${remark}".`);
    }

    // set payment ...
    if (lower.startsWith('set payment ')) {
      const parts = parseQuotedParts(text.split(' '), 2);
      if (parts.length < 2) {
        return client.sendMessage(sender, '❌ Usage: set payment <mpesa_number> "<Name>"');
      }
      const mpesa = parts[0];
      const name = parts[1];
      PAYMENT_INFO = `${mpesa} (${name})`;
      return client.sendMessage(sender, `✅ Payment info updated: ${PAYMENT_INFO}`);
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
      return client.sendMessage(sender, `✅ Added data package [${newId}] ${name} @ KSH ${price} (${validity}) to ${subcat}.`);
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
      const arr = dataPackages[subcat];
      const idx = arr.findIndex(x => x.id === idToRemove);
      if (idx === -1) {
        return client.sendMessage(sender, `❌ No data package with ID ${idToRemove} in ${subcat}.`);
      }
      arr.splice(idx, 1);
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
        return client.sendMessage(sender, `❌ No data package with ID ${idToEdit} in ${subcat}.`);
      }
      pack.price = newPrice;
      return client.sendMessage(sender, `✅ Updated data package [${idToEdit}] => KSH ${newPrice}.`);
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
      return client.sendMessage(sender, `✅ Added SMS package [${newId}] ${name} @ KSH ${price} (${validity}) to ${subcat}.`);
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
      const arr = smsPackages[subcat];
      const idx = arr.findIndex(x => x.id === idToRemove);
      if (idx === -1) {
        return client.sendMessage(sender, `❌ No SMS package with ID ${idToRemove} in ${subcat}.`);
      }
      arr.splice(idx, 1);
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
        return client.sendMessage(sender, `❌ No SMS package with ID ${idToEdit} in ${subcat}.`);
      }
      pack.price = newPrice;
      return client.sendMessage(sender, `✅ Updated SMS package [${idToEdit}] => KSH ${newPrice}.`);
    }

    // referrals all
    if (lower === 'referrals all') {
      let resp = `📢 *All Referral Data*\nMinWithdraw = ${MIN_WITHDRAWAL}, MaxWithdraw = ${MAX_WITHDRAWAL}\n\n`;
      for (let r in referrals) {
        resp += `Referrer: ${r}\nCode: ${referrals[r].code}\nTotal Referred: ${referrals[r].referred.length}\nEarnings: KSH ${referrals[r].earnings}\nWithdrawals: ${referrals[r].withdrawals?.length || 0}\nPin: ${referrals[r].pin ? 'Set' : 'Not Set'}\n\n`;
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
      if (!foundUser) {
        return client.sendMessage(sender, `❌ No user found with referral code ${refCode}.`);
      }
      const wArr = referrals[foundUser].withdrawals || [];
      const wd = wArr.find(x => x.id === wdId);
      if (!wd) {
        return client.sendMessage(sender, `❌ No withdrawal ID ${wdId} found for code ${refCode}.`);
      }
      wd.status = newStatus;
      wd.remarks = remarks;
      client.sendMessage(foundUser, `🔔 *Withdrawal Update*\nYour withdrawal (ID: ${wdId}) => *${newStatus}*\nRemarks: ${remarks}`);
      return client.sendMessage(sender, `✅ Updated withdrawal ${wdId} => ${newStatus}, remarks: "${remarks}".`);
    }
  }

  // ---------- REFERRAL QUICK COMMANDS ----------
  if (lower === 'referral') {
    const link = getReferralLink(sender);
    return client.sendMessage(sender, `😍 *Your Referral Link*\n${link}\nShare with friends to earn KSH5 per successful referral!`);
  }
  if (lower.startsWith('ref ')) {
    const splitted = text.split(' ');
    if (splitted.length === 2) {
      recordReferral(sender, splitted[1].toUpperCase());
      return client.sendMessage(sender, `🙏 You've been referred by code *${splitted[1].toUpperCase()}*. Enjoy!`);
    }
  }

  // ---------- MAIN MENU NAV ----------
  if (lower === 'menu' || lower === 'start') {
    session[sender] = { step: 'main' };
    const welcome = `🌟 *Welcome to FY'S ULTRA BOT!* 🌟\n\n` +
      `Thank you for choosing FYS PROPERTY, where your satisfaction is our priority!\n\n` +
      `Choose an option:\n1️⃣ Airtime\n2️⃣ Data Bundles\n3️⃣ SMS Bundles\n4️⃣ My Referrals\n\n` +
      `For order status: status <ORDER_ID>\nAfter payment: PAID <ORDER_ID>\nType "00" any time for main menu.`;
    return client.sendMessage(sender, welcome);
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

  // ---------- OPTION 1: AIRTIME ----------
  if (session[sender]?.step === 'main' && text === '1') {
    session[sender].prevStep = 'main';
    session[sender].step = 'airtimeAmount';
    return client.sendMessage(sender, `💳 *Airtime Purchase*\n\nPlease enter the amount of airtime (in KES), e.g. "50".\nType "0" to go back.`);
  }
  if (session[sender]?.step === 'airtimeAmount') {
    // parse the amount
    const amt = Number(text);
    if (isNaN(amt) || amt <= 0) {
      return client.sendMessage(sender, '❌ Invalid amount. Please enter a positive number (e.g. "50").');
    }
    // store in session
    session[sender].airtimeAmount = amt;
    session[sender].step = 'airtimeRecipient';
    return client.sendMessage(sender, `✅ Amount set to KSH ${amt}.\nNow enter the *recipient phone number* (07XXXXXXXX).`);
  }
  if (session[sender]?.step === 'airtimeRecipient') {
    if (!isSafaricomNumber(text)) {
      return client.sendMessage(sender, '❌ Invalid phone number. Must be 07XXXXXXXX or 01XXXXXXXX.');
    }
    session[sender].airtimeRecipient = text;
    session[sender].step = 'airtimePayment';
    return client.sendMessage(sender, `✅ Recipient set to ${text}.\nNow enter your *payment number* (Safaricom).`);
  }
  if (session[sender]?.step === 'airtimePayment') {
    if (!isSafaricomNumber(text)) {
      return client.sendMessage(sender, '❌ Invalid payment number. Must be 07XXXXXXXX or 01XXXXXXXX.');
    }
    // finalize order
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
    // clear session
    delete session[sender].airtimeAmount;
    delete session[sender].airtimeRecipient;
    session[sender].step = 'main';

    const summary = `🛒 *Order Created!*\n\n🆔 Order ID: *${orderID}*\n📦 Package: Airtime (KES ${orders[orderID].amount})\n` +
      `💰 Price: KES ${orders[orderID].amount}\n📞 Recipient: ${orders[orderID].recipient}\n` +
      `📱 Payment Number: ${orders[orderID].payment}\n` +
      `🕒 Placed at: ${formatKenyaTime(new Date(orders[orderID].timestamp))}\n\n` +
      `👉 Please send KSH ${orders[orderID].amount} to *${PAYMENT_INFO}*.\nThen type: PAID ${orderID} once paid.\n` +
      `Type "00" for main menu.`;
    client.sendMessage(sender, summary);

    // notify admin
    const adminMsg = `🔔 *New Airtime Order*\n\n🆔 ${orderID}\nPackage: Airtime (KES ${orders[orderID].amount})\n` +
      `Price: KES ${orders[orderID].amount}\nRecipient: ${orders[orderID].recipient}\nPayment: ${orders[orderID].payment}\n` +
      `Time: ${formatKenyaTime(new Date(orders[orderID].timestamp))}\nUser: ${sender}\n\n` +
      `*Admin Commands*:\nupdate ${orderID} CONFIRMED "remark"\n... etc. (Type "Admin CMD" for full list)`;
    client.sendMessage(`${ADMIN_NUMBER}@c.us`, adminMsg);
    return;
  }

  // ---------- OPTION 2: DATA BUNDLES ----------
  if (session[sender]?.step === 'main' && text === '2') {
    session[sender].prevStep = 'main';
    session[sender].step = 'dataCategory';
    const dataCatMsg = `📶 *Data Bundles*\nChoose a subcategory:\n1) Hourly\n2) Daily\n3) Weekly\n4) Monthly\nType "0" to go back.`;
    return client.sendMessage(sender, dataCatMsg);
  }
  if (session[sender]?.step === 'dataCategory') {
    if (!['1','2','3','4'].includes(text)) {
      return client.sendMessage(sender, '❌ Invalid choice. Please type 1,2,3, or 4.');
    }
    let cat = '';
    if (text === '1') cat = 'hourly';
    else if (text === '2') cat = 'daily';
    else if (text === '3') cat = 'weekly';
    else if (text === '4') cat = 'monthly';
    session[sender].dataCat = cat;
    session[sender].prevStep = 'dataCategory';
    session[sender].step = 'dataList';

    let listMsg = `✅ *${cat.toUpperCase()} Data Bundles:*\n`;
    dataPackages[cat].forEach(p => {
      listMsg += `[${p.id}] ${p.name} @ KSH ${p.price} (${p.validity})\n`;
    });
    listMsg += `\nType the package ID to select, or "0" to go back.`;
    return client.sendMessage(sender, listMsg);
  }
  if (session[sender]?.step === 'dataList') {
    const cat = session[sender].dataCat;
    const pkgId = Number(text);
    if (isNaN(pkgId)) {
      return client.sendMessage(sender, '❌ Invalid package ID. Please type a number.');
    }
    const found = dataPackages[cat].find(x => x.id === pkgId);
    if (!found) {
      return client.sendMessage(sender, '❌ No package with that ID. Type "menu" to restart.');
    }
    // store in session
    session[sender].dataBundle = found;
    session[sender].step = 'dataRecip';
    return client.sendMessage(sender, `✅ Selected: ${found.name} (KSH ${found.price}).\nNow enter the *recipient phone number* (07XXXXXXXX).`);
  }
  if (session[sender]?.step === 'dataRecip') {
    if (!isSafaricomNumber(text)) {
      return client.sendMessage(sender, '❌ Invalid phone number. Must be 07XXXXXXXX or 01XXXXXXXX.');
    }
    session[sender].dataRecipient = text;
    session[sender].step = 'dataPay';
    return client.sendMessage(sender, `✅ Recipient set: ${text}.\nNow enter your *payment number* (Safaricom).`);
  }
  if (session[sender]?.step === 'dataPay') {
    if (!isSafaricomNumber(text)) {
      return client.sendMessage(sender, '❌ Invalid payment number.');
    }
    // finalize
    const orderID = generateOrderID();
    const bundle = session[sender].dataBundle;
    orders[orderID] = {
      orderID,
      customer: sender,
      package: `${bundle.name} (${session[sender].dataCat})`,
      amount: bundle.price,
      recipient: session[sender].dataRecipient,
      payment: text,
      status: 'PENDING',
      timestamp: new Date().toISOString()
    };
    // clear session
    delete session[sender].dataBundle;
    delete session[sender].dataRecipient;
    session[sender].step = 'main';

    const summary = `🛒 *Order Created!*\n\n🆔 ${orderID}\n📦 ${orders[orderID].package}\n` +
      `💰 KSH ${orders[orderID].amount}\n📞 ${orders[orderID].recipient}\n` +
      `📱 Payment: ${orders[orderID].payment}\n` +
      `🕒 Placed: ${formatKenyaTime(new Date(orders[orderID].timestamp))}\n\n` +
      `👉 Send KSH ${orders[orderID].amount} to *${PAYMENT_INFO}*.\nThen type: PAID ${orderID}\nType "00" for menu.`;
    client.sendMessage(sender, summary);

    const adminMsg = `🔔 *New Data Order*\n\n🆔 ${orderID}\nPackage: ${orders[orderID].package}\n` +
      `Price: KSH ${orders[orderID].amount}\nRecipient: ${orders[orderID].recipient}\nPayment: ${orders[orderID].payment}\n` +
      `Time: ${formatKenyaTime(new Date(orders[orderID].timestamp))}\nUser: ${sender}\n\n(Use admin commands to update)`;
    client.sendMessage(`${ADMIN_NUMBER}@c.us`, adminMsg);
    return;
  }

  // ---------- OPTION 3: SMS BUNDLES ----------
  if (session[sender]?.step === 'main' && text === '3') {
    session[sender].prevStep = 'main';
    session[sender].step = 'smsCategory';
    const smsCatMsg = `✉️ *SMS Bundles*\n1) Daily\n2) Weekly\n3) Monthly\nType "0" to go back.`;
    return client.sendMessage(sender, smsCatMsg);
  }
  if (session[sender]?.step === 'smsCategory') {
    if (!['1','2','3'].includes(text)) {
      return client.sendMessage(sender, '❌ Invalid choice. Please type 1,2, or 3.');
    }
    let cat = '';
    if (text === '1') cat = 'daily';
    else if (text === '2') cat = 'weekly';
    else if (text === '3') cat = 'monthly';
    session[sender].smsCat = cat;
    session[sender].prevStep = 'smsCategory';
    session[sender].step = 'smsList';

    let listMsg = `✅ *${cat.toUpperCase()} SMS Bundles:*\n`;
    smsPackages[cat].forEach(x => {
      listMsg += `[${x.id}] ${x.name} @ KSH ${x.price} (${x.validity})\n`;
    });
    listMsg += `\nType the package ID, or "0" to go back.`;
    return client.sendMessage(sender, listMsg);
  }
  if (session[sender]?.step === 'smsList') {
    const cat = session[sender].smsCat;
    const pkgId = Number(text);
    if (isNaN(pkgId)) {
      return client.sendMessage(sender, '❌ Invalid package ID. Must be a number.');
    }
    const found = smsPackages[cat].find(x => x.id === pkgId);
    if (!found) {
      return client.sendMessage(sender, '❌ No package with that ID. Type "menu" to restart.');
    }
    session[sender].smsBundle = found;
    session[sender].step = 'smsRecip';
    return client.sendMessage(sender, `✅ Selected: ${found.name} (KSH ${found.price}).\nNow enter recipient (07XXXXXXXX).`);
  }
  if (session[sender]?.step === 'smsRecip') {
    if (!isSafaricomNumber(text)) {
      return client.sendMessage(sender, '❌ Invalid phone number. Must be 07XXXXXXXX or 01XXXXXXXX.');
    }
    session[sender].smsRecipient = text;
    session[sender].step = 'smsPay';
    return client.sendMessage(sender, `✅ Recipient set: ${text}.\nNow enter your *payment number* (Safaricom).`);
  }
  if (session[sender]?.step === 'smsPay') {
    if (!isSafaricomNumber(text)) {
      return client.sendMessage(sender, '❌ Invalid payment number.');
    }
    const orderID = generateOrderID();
    const bundle = session[sender].smsBundle;
    orders[orderID] = {
      orderID,
      customer: sender,
      package: `${bundle.name} (SMS - ${session[sender].smsCat})`,
      amount: bundle.price,
      recipient: session[sender].smsRecipient,
      payment: text,
      status: 'PENDING',
      timestamp: new Date().toISOString()
    };
    delete session[sender].smsBundle;
    delete session[sender].smsRecipient;
    session[sender].step = 'main';

    const summary = `🛒 *Order Created!*\n\n🆔 ${orderID}\n📦 ${orders[orderID].package}\n` +
      `💰 KSH ${orders[orderID].amount}\n📞 ${orders[orderID].recipient}\n` +
      `📱 Payment: ${orders[orderID].payment}\n` +
      `🕒 Placed: ${formatKenyaTime(new Date(orders[orderID].timestamp))}\n\n` +
      `👉 Send KSH ${orders[orderID].amount} to *${PAYMENT_INFO}*.\nThen type: PAID ${orderID}\nType "00" for menu.`;
    client.sendMessage(sender, summary);

    const adminMsg = `🔔 *New SMS Order*\n\n🆔 ${orderID}\nPackage: ${orders[orderID].package}\n` +
      `Price: KSH ${orders[orderID].amount}\nRecipient: ${orders[orderID].recipient}\nPayment: ${orders[orderID].payment}\n` +
      `Time: ${formatKenyaTime(new Date(orders[orderID].timestamp))}\nUser: ${sender}\n\n(Use admin commands to update)`;
    client.sendMessage(`${ADMIN_NUMBER}@c.us`, adminMsg);
    return;
  }

  // ---------- REFERRALS MENU (OPTION 4) ----------
  if (session[sender]?.step === 'main' && text === '4') {
    session[sender].prevStep = 'main';
    session[sender].step = 'myReferralsMenu';
    const refMenu = `🌟 *My Referrals Menu* 🌟\n\n` +
      `1) View Earnings & Balance\n2) Withdraw Earnings\n3) Get Referral Link\n4) Set/Update PIN\n5) View Referred Users\n\nType a number, or "0" to go back.`;
    return client.sendMessage(sender, refMenu);
  }
  if (session[sender]?.step === 'myReferralsMenu') {
    if (text === '1') {
      if (!referrals[sender]) {
        return client.sendMessage(sender, `😞 No referral record. Type "referral" to get your link!`);
      }
      const rData = referrals[sender];
      let msg = `📢 *Referral Overview*\nCode: ${rData.code}\nEarnings: KSH ${rData.earnings}\nTotal Referred: ${rData.referred.length}\n\n`;
      if (rData.withdrawals && rData.withdrawals.length > 0) {
        msg += `🪙 *Withdrawal History*:\n`;
        rData.withdrawals.forEach((wd, i) => {
          msg += `${i+1}. ID: ${wd.id}, Amt: KSH ${wd.amount}, Status: ${wd.status}, Time: ${formatKenyaTime(new Date(wd.timestamp))}\nRemarks: ${wd.remarks}\n\n`;
        });
      } else {
        msg += `No withdrawals yet.\n`;
      }
      return client.sendMessage(sender, msg);
    } else if (text === '2') {
      // Withdraw
      if (!referrals[sender] || referrals[sender].earnings < MIN_WITHDRAWAL) {
        return client.sendMessage(sender, `😞 You need at least KSH ${MIN_WITHDRAWAL} to withdraw.`);
      }
      if (!referrals[sender].pin) {
        return client.sendMessage(sender, `⚠️ No PIN set. Choose option 4 to set your PIN first.`);
      }
      session[sender].step = 'withdrawRequest';
      return client.sendMessage(sender, `💸 *Withdrawal Request*\nEnter "<amount> <mpesa_number>" e.g. "50 0712345678".\nLimits: Min KSH ${MIN_WITHDRAWAL}, Max KSH ${MAX_WITHDRAWAL}\nType "0" to go back.`);
    } else if (text === '3') {
      const link = getReferralLink(sender);
      return client.sendMessage(sender, `😍 *Your Referral Link*\n${link}\nShare to earn KSH5 per successful referral!`);
    } else if (text === '4') {
      session[sender].step = 'setPin';
      return client.sendMessage(sender, `🔐 Enter a new 4-digit PIN (not "1234" or "0000").`);
    } else if (text === '5') {
      if (!referrals[sender] || referrals[sender].referred.length === 0) {
        return client.sendMessage(sender, `😞 You haven't referred anyone yet. Type "referral" to get your link!`);
      }
      let userList = `👥 *Your Referred Users* (partially masked):\n\n`;
      referrals[sender].referred.forEach((u, i) => {
        const masked = maskWhatsAppID(u);
        const userAll = Object.values(orders).filter(o => o.customer === u);
        const total = userAll.length;
        const canceled = userAll.filter(o => o.status === 'CANCELLED').length;
        userList += `${i+1}. ${masked}\n   Orders: ${total}, Cancelled: ${canceled}\n\n`;
      });
      return client.sendMessage(sender, userList);
    } else {
      return client.sendMessage(sender, '❌ Invalid choice. Type 1..5 or "0" to go back.');
    }
  }

  // ---------- WITHDRAWAL FLOW ----------
  if (session[sender]?.step === 'withdrawRequest') {
    const splitted = text.split(' ');
    if (splitted.length !== 2) {
      return client.sendMessage(sender, '❌ Usage: "<amount> <mpesa_number>" e.g. "50 0712345678"');
    }
    const amount = Number(splitted[0]);
    const mpesa = splitted[1];
    if (isNaN(amount) || amount <= 0) {
      return client.sendMessage(sender, '❌ Invalid amount.');
    }
    if (!referrals[sender]) {
      return client.sendMessage(sender, `😞 No referral record. Type "referral" to get your link.`);
    }
    if (amount > referrals[sender].earnings || amount > MAX_WITHDRAWAL) {
      return client.sendMessage(sender, `❌ Can't withdraw more than earnings (KSH ${referrals[sender].earnings}) or max limit (KSH ${MAX_WITHDRAWAL}).`);
    }
    if (amount < MIN_WITHDRAWAL) {
      return client.sendMessage(sender, `❌ Minimum withdrawal is KSH ${MIN_WITHDRAWAL}.`);
    }
    if (!isSafaricomNumber(mpesa)) {
      return client.sendMessage(sender, '❌ Invalid M-Pesa number.');
    }
    session[sender].withdrawRequest = { amount, mpesa };
    session[sender].step = 'withdrawPin';
    return client.sendMessage(sender, `🔒 Enter your 4-digit PIN to confirm withdrawing KSH ${amount} to ${mpesa}.`);
  }
  if (session[sender]?.step === 'withdrawPin') {
    if (!referrals[sender]) {
      return client.sendMessage(sender, '❌ No referral record found.');
    }
    if (referrals[sender].pin !== text) {
      return client.sendMessage(sender, '❌ Incorrect PIN. Withdrawal canceled.');
    }
    const reqData = session[sender].withdrawRequest;
    const wd = {
      id: `WD-${Math.floor(1000 + Math.random() * 9000)}`,
      amount: reqData.amount,
      mpesa: reqData.mpesa,
      status: 'PENDING',
      timestamp: new Date().toISOString(),
      remarks: ''
    };
    referrals[sender].withdrawals.push(wd);
    referrals[sender].earnings -= reqData.amount;
    delete session[sender].withdrawRequest;
    session[sender].step = 'myReferralsMenu';

    client.sendMessage(sender, `🙏 *Withdrawal Requested!*\nID: ${wd.id}, KSH ${wd.amount} → ${wd.mpesa}\nStatus: PENDING.\nThank you for choosing FYS PROPERTY!`);
    client.sendMessage(`${ADMIN_NUMBER}@c.us`, `🔔 *New Withdrawal Request*\nUser: ${sender}\nWD ID: ${wd.id}\nAmount: KSH ${wd.amount}\nM-Pesa: ${wd.mpesa}\nTime: ${formatKenyaTime(new Date(wd.timestamp))}\nUse "withdraw update <ref_code> <wd_id> <STATUS> <remarks>" to update.`);
    return;
  }

  // ---------- SET PIN ----------
  if (session[sender]?.step === 'setPin') {
    if (!/^\d{4}$/.test(text)) {
      return client.sendMessage(sender, '❌ PIN must be exactly 4 digits.');
    }
    if (text === '1234' || text === '0000') {
      return client.sendMessage(sender, '❌ That PIN is not allowed. Please choose a different 4-digit PIN.');
    }
    if (!referrals[sender]) {
      const code = 'REF' + Math.floor(100000 + Math.random() * 900000);
      referrals[sender] = { code, referred: [], earnings: 0, withdrawals: [], pin: text };
    } else {
      referrals[sender].pin = text;
    }
    session[sender].step = 'myReferralsMenu';
    return client.sendMessage(sender, `✅ Your withdrawal PIN is now set to ${text}. Returning to My Referrals menu.`);
  }

  // ---------- FALLBACK ----------
  client.sendMessage(sender,
    `🤖 *FY'S ULTRA BOT*\nType "menu" for main menu.\nOrder status: status <ORDER_ID>\nAfter payment: PAID <ORDER_ID>\nReferrals: referral or my referrals\nOr "0"/"00" for menus.`
  );
});

/**
 * EXPRESS SERVER for QR code
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
 * Initialize the WhatsApp client
 */
client.initialize();
