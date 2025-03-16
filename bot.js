require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');
const express = require('express');
const moment = require('moment-timezone');

/**
 * =============================
 * CONFIGURATION & GLOBAL VARIABLES
 * =============================
 */
const ADMIN_NUMBER = process.env.ADMIN_NUMBER || '254701339573'; 
let PAYMENT_INFO = '0701339573 (Camlus)'; // Default payment info; admin can update.
const PORT = 3000;

// Minimum & Maximum withdrawal amounts (admin can update via set withdrawal command).
let MIN_WITHDRAWAL = 20;
let MAX_WITHDRAWAL = 1000;

// Orders & referral data in memory.
const orders = {};   // key = orderID, value = order details
const referrals = {}; // key = userNumber, value = { code, referred: [...], earnings, withdrawals: [...], pin }

// For multi-step flows.
const session = {};

/**
 * Format date/time in Kenya (Africa/Nairobi)
 */
function formatKenyaTime(date) {
  return moment(date).tz('Africa/Nairobi').format('YYYY-MM-DD HH:mm:ss');
}

/**
 * Mask a WhatsApp ID (like 254701234567@c.us) partially for privacy
 */
function maskWhatsAppID(waid) {
  // Typically "2547XXXXXXXX@c.us"
  // We'll keep first 5 digits, then mask next 4, keep last 1.
  // e.g. "25470****6@c.us"
  const atIndex = waid.indexOf('@');
  if (atIndex === -1) return waid; // fallback
  const phone = waid.slice(0, atIndex); // e.g. "254701234567"
  if (phone.length < 6) return waid; // too short to mask
  const first5 = phone.slice(0, 5); // "25470"
  const last1 = phone.slice(-1);    // "7"
  return `${first5}****${last1}@c.us`;
}

/**
 * Generate a unique order ID
 */
function generateOrderID() {
  return `FY'S-${Math.floor(100000 + Math.random() * 900000)}`;
}

/**
 * Validate Safaricom phone (07xxxxxxx or 01xxxxxxx)
 */
function isSafaricomNumber(num) {
  return /^0[71]\d{8}$/.test(num) || /^01\d{8}$/.test(num);
}

/**
 * PACKAGES (Data, SMS). Airtime is user-defined amount.
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
 * WhatsApp Client Setup
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

client.on('ready', async () => {
  console.log('✅ Bot is online and ready!');
  client.sendMessage(`${ADMIN_NUMBER}@c.us`, `🎉 Hello Admin! FY'S ULTRA BOT is now live.\nType "menu" for user flow, or "Admin CMD" to see all admin commands.`);
});

/**
 * Generate or get referral code for a user, return referral link
 */
function getReferralLink(sender) {
  if (!referrals[sender]) {
    const code = 'REF' + Math.floor(100000 + Math.random() * 900000);
    referrals[sender] = { code, referred: [], earnings: 0, withdrawals: [], pin: null };
  }
  return `https://wa.me/${ADMIN_NUMBER}?text=ref ${referrals[sender].code}`;
}

/**
 * If new user sends "ref <code>", record it
 */
function recordReferral(newUser, refCode) {
  for (let refUser in referrals) {
    if (referrals[refUser].code === refCode) {
      if (refUser === newUser) return; // prevent self-referral
      if (!referrals[refUser].referred.includes(newUser)) {
        referrals[refUser].referred.push(newUser);
      }
      if (!session[newUser]) session[newUser] = {};
      session[newUser].referrer = refCode;
      break;
    }
  }
}

/**
 * Parse quoted parts for admin commands
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
 * The main message handler
 */
client.on('message', async (msg) => {
  const sender = msg.from;
  const text = msg.body.trim();
  const lower = text.toLowerCase();

  // ========== ADMIN-ONLY COMMANDS ==========
  if (sender === `${ADMIN_NUMBER}@c.us`) {
    // Show admin commands
    if (lower === 'admin cmd') {
      const adminCmds = `📜 *Admin Commands:*\n
1) update <ORDER_ID> <STATUS> <REMARK>\n   - e.g. update FY'S-123456 CANCELLED "No stock"
2) set payment <mpesa_number> "<Name>"
3) add data <subcat> "<name>" <price> "<validity>"
4) remove data <subcat> <id>
5) edit data <subcat> <id> <newprice>
6) add sms <subcat> "<name>" <price> "<validity>"
7) remove sms <subcat> <id>
8) edit sms <subcat> <id> <newprice>
9) set withdrawal <min> <max>   (Set min & max withdrawal)
10) search <ORDER_ID>           (View order details)
11) referrals all               (View all referral data)
12) withdraw update <ref_code> <wd_id> <STATUS> <remarks>`;
      return client.sendMessage(sender, adminCmds);
    }

    // set withdrawal <min> <max>
    if (lower.startsWith('set withdrawal ')) {
      const parts = text.split(' ');
      if (parts.length !== 3) {
        return client.sendMessage(sender, '❌ Usage: set withdrawal <min> <max>');
      }
      const min = Number(parts[2]);
      const max = Number(parts[3]); // Actually we need to parse differently
      // Actually let's do something else: we see we splitted but we might do it incorrectly
      // Let's do it properly:
      // Actually, let's just fix it easily:
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
        extra = '✅ Payment confirmed! We are processing your order.';
      } else if (newStatus === 'COMPLETED') {
        extra = '🎉 Your order has been completed! Thank you for choosing FYS PROPERTY!';
      } else if (newStatus === 'CANCELLED') {
        extra = `😔 We regret to inform you that your order was cancelled.\n\nOrder ID: ${orderID}\nPackage: ${orders[orderID].package}\nPlaced at: ${formatKenyaTime(orders[orderID].timestamp)}\nRemark: ${remark}\nPlease contact support if needed.`;
      } else if (newStatus === 'REFUNDED') {
        extra = '💰 Your order has been refunded. Please check your M-Pesa balance.';
      } else {
        extra = 'Your order status has been updated.';
      }
      client.sendMessage(user, `🔔 *Order Update*\nOrder *${orderID}* => *${newStatus}*\n${extra}\n\nReply "0" for previous or "00" for main menu.`);
      return client.sendMessage(sender, `✅ Order *${orderID}* updated to *${newStatus}* with remark: "${remark}".`);
    }

    // set payment <mpesa_number> "<Name>"
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
      if (isNaN(price)) {
        return client.sendMessage(sender, '❌ Price must be a number.');
      }
      if (!dataPackages[subcat]) {
        return client.sendMessage(sender, `❌ Invalid data category: ${subcat}`);
      }
      const arr = dataPackages[subcat];
      const newId = arr.length ? arr[arr.length - 1].id + 1 : 1;
      arr.push({ id: newId, name, price, validity });
      return client.sendMessage(sender, `✅ Added new data package: [${newId}] ${name} @ KSH ${price} (${validity}) to ${subcat}.`);
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
        return client.sendMessage(sender, `❌ Invalid data subcategory: ${subcat}`);
      }
      const arr = dataPackages[subcat];
      const idx = arr.findIndex(p => p.id === idToRemove);
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
        return client.sendMessage(sender, `❌ Invalid data subcategory: ${subcat}`);
      }
      const pack = dataPackages[subcat].find(p => p.id === idToEdit);
      if (!pack) {
        return client.sendMessage(sender, `❌ No data package with ID ${idToEdit} in ${subcat}.`);
      }
      pack.price = newPrice;
      return client.sendMessage(sender, `✅ Updated data package [${idToEdit}] in ${subcat} to KSH ${newPrice}.`);
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
        return client.sendMessage(sender, `❌ Invalid sms subcategory: ${subcat}`);
      }
      const arr = smsPackages[subcat];
      const newId = arr.length ? arr[arr.length - 1].id + 1 : 1;
      arr.push({ id: newId, name, price, validity });
      return client.sendMessage(sender, `✅ Added new SMS package [${newId}] ${name} @ KSH ${price} (${validity}) to ${subcat}.`);
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
        return client.sendMessage(sender, `❌ Invalid sms subcategory: ${subcat}`);
      }
      const arr = smsPackages[subcat];
      const idx = arr.findIndex(p => p.id === idToRemove);
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
        return client.sendMessage(sender, `❌ Invalid sms subcategory: ${subcat}`);
      }
      const pack = smsPackages[subcat].find(p => p.id === idToEdit);
      if (!pack) {
        return client.sendMessage(sender, `❌ No SMS package with ID ${idToEdit} in ${subcat}.`);
      }
      pack.price = newPrice;
      return client.sendMessage(sender, `✅ Updated SMS package [${idToEdit}] in ${subcat} to KSH ${newPrice}.`);
    }

    // referrals all
    if (lower === 'referrals all') {
      let resp = `📢 *All Referral Data*\n\nMinWithdraw = ${MIN_WITHDRAWAL}, MaxWithdraw = ${MAX_WITHDRAWAL}\n\n`;
      for (let r in referrals) {
        resp += `Referrer: ${r}\nCode: ${referrals[r].code}\nTotal Referred: ${referrals[r].referred.length}\nEarnings: KSH ${referrals[r].earnings}\nWithdrawals: ${referrals[r].withdrawals?.length || 0}\nPin: ${referrals[r].pin ? 'Set' : 'Not Set'}\n\n`;
      }
      return client.sendMessage(sender, resp);
    }

    // withdraw update <referrer_code> <withdrawal_id> <STATUS> <remarks>
    if (lower.startsWith('withdraw update ')) {
      const splitted = text.split(' ');
      if (splitted.length < 6) {
        return client.sendMessage(sender, '❌ Usage: withdraw update <ref_code> <wd_id> <STATUS> <remarks>');
      }
      const refCode = splitted[2];
      const wdId = splitted[3];
      const newStatus = splitted[4].toUpperCase();
      const remarks = splitted.slice(5).join(' ');
      // find who has this code
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
        return client.sendMessage(sender, `❌ No withdrawal ID ${wdId} found for ref code ${refCode}.`);
      }
      wd.status = newStatus;
      wd.remarks = remarks;
      client.sendMessage(foundUser, `🔔 *Withdrawal Update*\nYour withdrawal (ID: ${wdId}) is now *${newStatus}*.\nRemarks: ${remarks}`);
      return client.sendMessage(sender, `✅ Updated withdrawal ${wdId} to ${newStatus} with remarks: "${remarks}".`);
    }
  } // END ADMIN COMMANDS

  // ---------- REFERRAL QUICK COMMANDS ----------
  if (lower === 'referral') {
    const link = getReferralLink(sender);
    return client.sendMessage(sender, `😍 *Your Referral Link*\n${link}\nShare with friends to earn KSH5 for each successful order placed!`);
  }
  if (lower.startsWith('ref ')) {
    const splitted = text.split(' ');
    if (splitted.length === 2) {
      recordReferral(sender, splitted[1].toUpperCase());
      return client.sendMessage(sender, `🙏 Thank you! You've been referred by code *${splitted[1].toUpperCase()}*. Enjoy our services!`);
    }
  }

  // ---------- MAIN MENU NAV ----------
  if (lower === 'menu' || lower === 'start') {
    session[sender] = { step: 'main' };
    const welcome = `🌟 *Welcome to FY'S ULTRA BOT!* 🌟\n\n` +
      `Thank you for choosing FYS PROPERTY. Your satisfaction is our priority!\n\n` +
      `Please choose an option by typing a number:\n` +
      `1️⃣ Airtime\n2️⃣ Data Bundles\n3️⃣ SMS Bundles\n4️⃣ My Referrals\n\n` +
      `For order status: status <ORDER_ID>\nAfter payment: PAID <ORDER_ID>\nType "00" anytime for main menu.`;
    return client.sendMessage(sender, welcome);
  }
  if (text === '0') {
    if (session[sender] && session[sender].prevStep) {
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

  // ---------- REFERRALS MENU (OPTION 4) ----------
  if (session[sender]?.step === 'main' && text === '4') {
    // My Referrals sub-menu
    session[sender].prevStep = 'main';
    session[sender].step = 'my_referrals_menu';
    const refMenu = `🌟 *My Referrals Menu* 🌟\n\n` +
      `1) View Earnings & Balance\n2) Withdraw Earnings\n3) Get Referral Link\n4) Set/Update PIN\n5) View Referred Users (partially masked)\n\nType the number, or "0" to go back.`;
    return client.sendMessage(sender, refMenu);
  }
  if (session[sender]?.step === 'my_referrals_menu') {
    if (text === '1') {
      // View Earnings & Balance
      if (!referrals[sender]) {
        return client.sendMessage(sender, `😞 You have no referral record yet. Type "referral" to generate your link and start referring friends!`);
      }
      const rData = referrals[sender];
      let msg = `📢 *Referral Overview*\nCode: *${rData.code}*\nEarnings: KSH ${rData.earnings}\nTotal Referred: ${rData.referred.length}\n\n`;
      if (rData.withdrawals && rData.withdrawals.length > 0) {
        msg += `🪙 *Withdrawal History*:\n`;
        rData.withdrawals.forEach((wd, i) => {
          msg += `${i + 1}. ID: ${wd.id}, Amt: KSH ${wd.amount}, Status: ${wd.status}, Requested: ${formatKenyaTime(wd.timestamp)}\nRemarks: ${wd.remarks}\n`;
        });
      } else {
        msg += `No withdrawals yet.\n`;
      }
      return client.sendMessage(sender, msg);
    } else if (text === '2') {
      // Withdraw
      if (!referrals[sender] || referrals[sender].earnings < MIN_WITHDRAWAL) {
        return client.sendMessage(sender, `😞 You need at least KSH ${MIN_WITHDRAWAL} to withdraw. Keep referring or placing orders!`);
      }
      if (!referrals[sender].pin) {
        return client.sendMessage(sender, `⚠️ You have not set a withdrawal PIN yet. Choose option 4 to set your PIN first.`);
      }
      session[sender].step = 'withdraw_request';
      return client.sendMessage(sender, `💸 *Withdrawal Request*\nEnter "<amount> <mpesa_number>" e.g. "50 0712345678".\nLimits: Min KSH ${MIN_WITHDRAWAL}, Max KSH ${MAX_WITHDRAWAL}\nType "0" to go back.`);
    } else if (text === '3') {
      // Referral link
      const link = getReferralLink(sender);
      return client.sendMessage(sender, `😍 *Your Referral Link:*\n${link}\nShare to earn KSH5 per successful referral!`);
    } else if (text === '4') {
      // Set or update PIN
      session[sender].step = 'set_pin';
      return client.sendMessage(sender, `🔐 *Set/Update PIN*\nEnter a 4-digit PIN (not "1234" or "0000").`);
    } else if (text === '5') {
      // View referred users partially masked
      if (!referrals[sender] || referrals[sender].referred.length === 0) {
        return client.sendMessage(sender, `😞 You haven't referred anyone yet. Type "referral" to get your link!`);
      }
      let userList = `👥 *Your Referred Users* (partially masked):\n\n`;
      referrals[sender].referred.forEach((u, i) => {
        const masked = maskWhatsAppID(u);
        // Gather stats: how many orders placed, how many canceled
        const userAllOrders = Object.values(orders).filter(o => o.customer === u);
        const totalOrders = userAllOrders.length;
        const canceledOrders = userAllOrders.filter(o => o.status === 'CANCELLED').length;
        userList += `${i + 1}. ${masked}\n   Orders Placed: ${totalOrders}, Cancelled: ${canceledOrders}\n\n`;
      });
      return client.sendMessage(sender, userList);
    } else {
      return client.sendMessage(sender, '❌ Invalid choice. Please type 1,2,3,4,5 or "0" to go back.');
    }
  }

  // ---------- WITHDRAW REQUEST FLOW ----------
  if (session[sender]?.step === 'withdraw_request') {
    const splitted = text.split(' ');
    if (splitted.length !== 2) {
      return client.sendMessage(sender, '❌ Usage: "<amount> <mpesa_number>" e.g. "50 0712345678"');
    }
    const amount = Number(splitted[0]);
    const mpesa = splitted[1];
    if (isNaN(amount) || amount <= 0) {
      return client.sendMessage(sender, '❌ Invalid amount.');
    }
    if (!isSafaricomNumber(mpesa)) {
      return client.sendMessage(sender, '❌ Invalid M-Pesa number.');
    }
    if (!referrals[sender]) {
      return client.sendMessage(sender, `😞 No referral record found. Type "referral" to get your link.`);
    }
    if (amount > referrals[sender].earnings || amount > MAX_WITHDRAWAL) {
      return client.sendMessage(sender, `❌ You cannot withdraw more than your current earnings (KSH ${referrals[sender].earnings}) or the max limit (KSH ${MAX_WITHDRAWAL}).`);
    }
    if (amount < MIN_WITHDRAWAL) {
      return client.sendMessage(sender, `❌ Minimum withdrawal is KSH ${MIN_WITHDRAWAL}.`);
    }
    session[sender].withdrawRequest = { amount, mpesa };
    session[sender].step = 'withdraw_pin';
    return client.sendMessage(sender, `🔒 Enter your 4-digit PIN to confirm withdrawing KSH ${amount} to ${mpesa}.`);
  }
  if (session[sender]?.step === 'withdraw_pin') {
    // Validate pin
    if (!referrals[sender]) {
      return client.sendMessage(sender, '❌ No referral record found.');
    }
    if (referrals[sender].pin !== text) {
      return client.sendMessage(sender, '❌ Incorrect PIN. Withdrawal canceled.');
    }
    // Process
    const reqData = session[sender].withdrawRequest;
    const wd = {
      id: `WD-${Math.floor(1000 + Math.random() * 9000)}`,
      amount: reqData.amount,
      mpesa: reqData.mpesa,
      status: 'PENDING',
      timestamp: new Date().toISOString(),
      remarks: ''
    };
    referrals[sender].withdrawals = referrals[sender].withdrawals || [];
    referrals[sender].withdrawals.push(wd);
    referrals[sender].earnings -= reqData.amount;
    delete session[sender].withdrawRequest;
    session[sender].step = 'my_referrals_menu';
    client.sendMessage(sender, `🙏 *Withdrawal Requested!*\nID: ${wd.id}, KSH ${wd.amount} to ${wd.mpesa}\nStatus: PENDING.\nWe appreciate you choosing FYS PROPERTY!`);
    client.sendMessage(`${ADMIN_NUMBER}@c.us`, `🔔 *New Withdrawal Request*\nUser: ${sender}\nWithdrawal ID: ${wd.id}\nAmount: KSH ${wd.amount}\nM-Pesa: ${wd.mpesa}\nTime: ${formatKenyaTime(wd.timestamp)}\nUse "withdraw update <ref_code> <wd_id> <STATUS> <remarks>" to update.`);
    return;
  }

  // ---------- SET PIN ----------
  if (session[sender]?.step === 'set_pin') {
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
    session[sender].step = 'my_referrals_menu';
    return client.sendMessage(sender, `✅ Your withdrawal PIN is now set to ${text}. Returning to My Referrals menu.`);
  }

  // ---------- FALLBACK ----------
  client.sendMessage(sender,
    `🤖 *FY'S ULTRA BOT*\n` +
    `Type "menu" to see the main menu.\n` +
    `For order status: status <ORDER_ID>\nAfter payment: PAID <ORDER_ID>\nFor referrals: my referrals\n` +
    `Or "0" for previous, "00" for main menu.`
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
  console.log(`🌐 Express server is running at http://localhost:${PORT}`);
});

/**
 * Initialize the WhatsApp client
 */
client.initialize();
