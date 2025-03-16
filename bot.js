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
let PAYMENT_INFO = '0701339573 (Camlus)'; // Default payment info; admin can update.
const PORT = 3000;

// New variables: Minimum and Maximum withdrawal amounts.
let MIN_WITHDRAWAL = 20; // default minimum withdrawal (KSH)
let MAX_WITHDRAWAL = 1000; // default maximum withdrawal (KSH)

// In-memory orders store: key = orderID, value = order details.
const orders = {};

// In-memory referral store: key = referrer (sender id), value = { code, referred: [user IDs], earnings, withdrawals: [], pin }.
const referrals = {};

// In-memory session store for multi-step flows (key = sender).
const session = {};

/**
 * Helper: Generate a unique order ID (e.g., FY'S-123456)
 */
function generateOrderID() {
  return `FY'S-${Math.floor(100000 + Math.random() * 900000)}`;
}

/**
 * Helper: Validate Safaricom phone numbers (07XXXXXXXX or 01XXXXXXXX)
 */
function isSafaricomNumber(num) {
  return /^0[71]\d{8}$/.test(num) || /^01\d{8}$/.test(num);
}

/**
 * =============================
 * PACKAGES: Airtime, Data, and SMS
 * =============================
 */
// Airtime: user enters an amount.

// Data packages grouped by subcategory.
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

// SMS packages grouped by subcategory.
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
  console.log('🔐 Scan the QR code below with WhatsApp:');
  qrcodeTerminal.generate(qr, { small: true });
  QRCode.toDataURL(qr, (err, url) => {
    if (!err) qrImageUrl = url;
  });
});

client.on('ready', async () => {
  console.log('✅ Bot is online and ready!');
  client.sendMessage(`${ADMIN_NUMBER}@c.us`, `🎉 Hello Admin! FY'S ULTRA BOT is now live.\nType "menu" for user flow or "Admin CMD" to see all admin commands.`);
});

/**
 * =============================
 * REFERRAL FUNCTIONS
 * =============================
 */
// Get a referral link for a user.
function getReferralLink(sender) {
  if (!referrals[sender]) {
    const code = 'REF' + Math.floor(100000 + Math.random() * 900000);
    referrals[sender] = { code, referred: [], earnings: 0, withdrawals: [], pin: null };
  }
  return `https://wa.me/${ADMIN_NUMBER}?text=ref ${referrals[sender].code}`;
}

// Record a referral from a new user.
function recordReferral(newUser, refCode) {
  for (let ref in referrals) {
    if (referrals[ref].code === refCode) {
      if (ref === newUser) return; // Prevent self-referral.
      if (!referrals[ref].referred.includes(newUser)) {
        referrals[ref].referred.push(newUser);
      }
      if (!session[newUser]) session[newUser] = {};
      session[newUser].referrer = refCode;
      break;
    }
  }
}

/**
 * =============================
 * ADMIN COMMAND PARSER (for quoted parts)
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
  const sender = msg.from; // e.g., "2547xxxxxxx@c.us"
  const body = msg.body.trim();
  const lower = body.toLowerCase();

  // ---------- ADMIN COMMANDS ----------
  if (sender === `${ADMIN_NUMBER}@c.us`) {
    // Admin can type "admin cmd" to view all admin commands.
    if (lower === 'admin cmd') {
      const adminCmds = `📜 *Admin Commands:*\n
1. update <ORDER_ID> <STATUS> <REMARK>  - Update order status (remark required)
2. set payment <mpesa_number> "<Name>"   - Update payment details
3. add data <subcat> "<name>" <price> "<validity>"  - Add a new data package (subcat: hourly/daily/weekly/monthly)
4. remove data <subcat> <id>            - Remove a data package
5. edit data <subcat> <id> <newprice>     - Edit price of a data package
6. add sms <subcat> "<name>" <price> "<validity>"   - Add a new SMS package (subcat: daily/weekly/monthly)
7. remove sms <subcat> <id>             - Remove an SMS package
8. edit sms <subcat> <id> <newprice>      - Edit price of an SMS package
9. set withdrawal <min> <max>           - Set minimum and maximum withdrawal amounts
10. search <ORDER_ID>                   - Search for an order
11. referrals all                       - View all referral data
12. withdraw update <referrer_code> <withdrawal_id> <STATUS> <remarks> - Update withdrawal request
`;
      return client.sendMessage(sender, adminCmds);
    }

    // Command: set withdrawal <min> <max>
    if (lower.startsWith('set withdrawal ')) {
      const parts = body.split(' ');
      if (parts.length !== 3) {
        return client.sendMessage(sender, '❌ Usage: set withdrawal <min> <max>');
      }
      const min = Number(parts[1]);
      const max = Number(parts[2]);
      if (isNaN(min) || isNaN(max) || min <= 0 || max <= min) {
        return client.sendMessage(sender, '❌ Please provide valid numbers where max > min > 0.');
      }
      MIN_WITHDRAWAL = min;
      MAX_WITHDRAWAL = max;
      return client.sendMessage(sender, `✅ Withdrawal limits updated: Minimum = KSH ${MIN_WITHDRAWAL}, Maximum = KSH ${MAX_WITHDRAWAL}`);
    }

    // Command: update <ORDER_ID> <STATUS> <REMARK>
    if (lower.startsWith('update ')) {
      const parts = body.split(' ');
      if (parts.length < 4) {
        return client.sendMessage(sender, '❌ Usage: update <ORDER_ID> <STATUS> <REMARK> (Remark is required)');
      }
      const orderID = parts[1];
      const newStatus = parts[2].toUpperCase();
      const remark = parts.slice(3).join(' ');
      if (!orders[orderID]) {
        return client.sendMessage(sender, `❌ Order ${orderID} not found.`);
      }
      orders[orderID].status = newStatus;
      orders[orderID].remark = remark;
      const user = orders[orderID].customer;
      let extraMsg = '';
      if (newStatus === 'CONFIRMED') {
        extraMsg = '✅ Your payment has been confirmed! We are processing your order.';
      } else if (newStatus === 'COMPLETED') {
        extraMsg = '🎉 Your order has been completed! Thank you for choosing FYS PROPERTY. We hope you enjoy your purchase!';
      } else if (newStatus === 'CANCELLED') {
        extraMsg = `😔 We regret to inform you that your order has been cancelled.\n\nOrder Details:\nOrder ID: ${orderID}\nPackage: ${orders[orderID].package}\nPlaced at: ${new Date(orders[orderID].timestamp).toLocaleString()}\n\nRemark: ${remark}\nPlease contact support if needed.`;
      } else if (newStatus === 'REFUNDED') {
        extraMsg = '💰 Your order has been refunded. Please check your M-Pesa balance.';
      } else {
        extraMsg = 'Your order status has been updated.';
      }
      client.sendMessage(user, `🔔 *Order Update*\nYour order *${orderID}* is now *${newStatus}*.\n${extraMsg}\n\nReply with "0" for previous menu or "00" for main menu.`);
      return client.sendMessage(sender, `✅ Order *${orderID}* updated to *${newStatus}* with remark: "${remark}".`);
    }

    // Command: set payment <mpesa_number> "<Name>"
    if (lower.startsWith('set payment ')) {
      const parts = parseQuotedParts(body.split(' '), 2);
      if (parts.length < 2) {
        return client.sendMessage(sender, '❌ Usage: set payment <mpesa_number> "<Name>"');
      }
      const mpesa = parts[0];
      const name = parts[1];
      PAYMENT_INFO = `${mpesa} (${name})`;
      return client.sendMessage(sender, `✅ Payment info updated to: ${PAYMENT_INFO}`);
    }

    // Command: add data <subcat> "<name>" <price> "<validity>"
    if (lower.startsWith('add data ')) {
      const parts = parseQuotedParts(body.split(' '), 2);
      if (parts.length < 4) {
        return client.sendMessage(sender, '❌ Usage: add data <subcat> "<name>" <price> "<validity>"');
      }
      const subcat = parts[0].toLowerCase();
      const name = parts[1];
      const price = Number(parts[2]);
      const validity = parts[3];
      if (isNaN(price)) {
        return client.sendMessage(sender, '❌ Price must be a number.');
      }
      if (!dataPackages[subcat]) {
        return client.sendMessage(sender, `❌ Data subcategory "${subcat}" not found. Options: hourly, daily, weekly, monthly.`);
      }
      const arr = dataPackages[subcat];
      const newId = arr.length > 0 ? arr[arr.length - 1].id + 1 : 1;
      arr.push({ id: newId, name, price, validity });
      return client.sendMessage(sender, `✅ Added new data package: [${newId}] ${name} @ KSH ${price} (${validity}) to ${subcat}.`);
    }

    // Command: remove data <subcat> <id>
    if (lower.startsWith('remove data ')) {
      const parts = body.split(' ');
      if (parts.length < 4) {
        return client.sendMessage(sender, '❌ Usage: remove data <subcat> <id>');
      }
      const subcat = parts[2].toLowerCase();
      const idToRemove = Number(parts[3]);
      if (isNaN(idToRemove)) {
        return client.sendMessage(sender, '❌ ID must be a number.');
      }
      if (!dataPackages[subcat]) {
        return client.sendMessage(sender, `❌ Data subcategory "${subcat}" not found.`);
      }
      const arr = dataPackages[subcat];
      const idx = arr.findIndex(p => p.id === idToRemove);
      if (idx === -1) {
        return client.sendMessage(sender, `❌ No package with ID ${idToRemove} in ${subcat}.`);
      }
      arr.splice(idx, 1);
      return client.sendMessage(sender, `✅ Removed data package ID ${idToRemove} from ${subcat}.`);
    }

    // Command: edit data <subcat> <id> <newprice>
    if (lower.startsWith('edit data ')) {
      const parts = body.split(' ');
      if (parts.length < 5) {
        return client.sendMessage(sender, '❌ Usage: edit data <subcat> <id> <newprice>');
      }
      const subcat = parts[2].toLowerCase();
      const idToEdit = Number(parts[3]);
      const newPrice = Number(parts[4]);
      if (isNaN(idToEdit) || isNaN(newPrice)) {
        return client.sendMessage(sender, '❌ ID and price must be numbers.');
      }
      if (!dataPackages[subcat]) {
        return client.sendMessage(sender, `❌ Data subcategory "${subcat}" not found.`);
      }
      const pack = dataPackages[subcat].find(p => p.id === idToEdit);
      if (!pack) {
        return client.sendMessage(sender, `❌ No package with ID ${idToEdit} in ${subcat}.`);
      }
      pack.price = newPrice;
      return client.sendMessage(sender, `✅ Updated data package [${idToEdit}] in ${subcat} to price KSH ${newPrice}.`);
    }

    // Similar commands for SMS:
    if (lower.startsWith('add sms ')) {
      const parts = parseQuotedParts(body.split(' '), 2);
      if (parts.length < 4) {
        return client.sendMessage(sender, '❌ Usage: add sms <subcat> "<name>" <price> "<validity>"');
      }
      const subcat = parts[0].toLowerCase();
      const name = parts[1];
      const price = Number(parts[2]);
      const validity = parts[3];
      if (isNaN(price)) {
        return client.sendMessage(sender, '❌ Price must be a number.');
      }
      if (!smsPackages[subcat]) {
        return client.sendMessage(sender, `❌ SMS subcategory "${subcat}" not found. Options: daily, weekly, monthly.`);
      }
      const arr = smsPackages[subcat];
      const newId = arr.length > 0 ? arr[arr.length - 1].id + 1 : 1;
      arr.push({ id: newId, name, price, validity });
      return client.sendMessage(sender, `✅ Added new SMS package: [${newId}] ${name} @ KSH ${price} (${validity}) to ${subcat}.`);
    }
    if (lower.startsWith('remove sms ')) {
      const parts = body.split(' ');
      if (parts.length < 4) {
        return client.sendMessage(sender, '❌ Usage: remove sms <subcat> <id>');
      }
      const subcat = parts[2].toLowerCase();
      const idToRemove = Number(parts[3]);
      if (isNaN(idToRemove)) {
        return client.sendMessage(sender, '❌ ID must be a number.');
      }
      if (!smsPackages[subcat]) {
        return client.sendMessage(sender, `❌ SMS subcategory "${subcat}" not found.`);
      }
      const arr = smsPackages[subcat];
      const idx = arr.findIndex(p => p.id === idToRemove);
      if (idx === -1) {
        return client.sendMessage(sender, `❌ No SMS package with ID ${idToRemove} in ${subcat}.`);
      }
      arr.splice(idx, 1);
      return client.sendMessage(sender, `✅ Removed SMS package ID ${idToRemove} from ${subcat}.`);
    }
    if (lower.startsWith('edit sms ')) {
      const parts = body.split(' ');
      if (parts.length < 5) {
        return client.sendMessage(sender, '❌ Usage: edit sms <subcat> <id> <newprice>');
      }
      const subcat = parts[2].toLowerCase();
      const idToEdit = Number(parts[3]);
      const newPrice = Number(parts[4]);
      if (isNaN(idToEdit) || isNaN(newPrice)) {
        return client.sendMessage(sender, '❌ ID and price must be numbers.');
      }
      if (!smsPackages[subcat]) {
        return client.sendMessage(sender, `❌ SMS subcategory "${subcat}" not found.`);
      }
      const pack = smsPackages[subcat].find(p => p.id === idToEdit);
      if (!pack) {
        return client.sendMessage(sender, `❌ No SMS package with ID ${idToEdit} in ${subcat}.`);
      }
      pack.price = newPrice;
      return client.sendMessage(sender, `✅ Updated SMS package [${idToEdit}] in ${subcat} to price KSH ${newPrice}.`);
    }
    
    // Command: search <ORDER_ID>
    if (lower.startsWith('search ')) {
      const parts = body.split(' ');
      if (parts.length !== 2) {
        return client.sendMessage(sender, '❌ Usage: search <ORDER_ID>');
      }
      const orderID = parts[1];
      if (!orders[orderID]) {
        return client.sendMessage(sender, `❌ Order ${orderID} not found.`);
      }
      const o = orders[orderID];
      return client.sendMessage(sender,
        `🔍 *Order Details*\n\n` +
        `🆔 Order ID: ${o.orderID}\n` +
        `📦 Package: ${o.package}\n` +
        `💰 Amount: KSH ${o.amount}\n` +
        `📞 Recipient: ${o.recipient}\n` +
        `📱 Payment: ${o.payment}\n` +
        `📌 Status: ${o.status}\n` +
        `🕒 Placed at: ${new Date(o.timestamp).toLocaleString()}\n` +
        `📝 Remark: ${o.remark || 'None'}`
      );
    }
    
    // ---------- End Admin Commands ----------
  } // END ADMIN COMMANDS

  // ---------- USER REFERRALS MENU ----------
  if (lower === 'my referrals') {
    session[sender] = session[sender] || {};
    session[sender].prevStep = session[sender].step || 'main';
    session[sender].step = 'my_referrals_menu';
    const refMenu = `🌟 *My Referrals Menu* 🌟\n\n` +
      `Please choose an option:\n` +
      `1️⃣ View Referral Earnings & Balance\n` +
      `2️⃣ Withdraw Earnings\n` +
      `3️⃣ Get Your Referral Link\n` +
      `4️⃣ Set/Update Your Withdrawal PIN\n` +
      `5️⃣ View All My Referrals\n\n` +
      `Type the number of your choice, or "0" to go back.`;
    return client.sendMessage(sender, refMenu);
  }
  if (session[sender]?.step === 'my_referrals_menu') {
    if (body === '1') {
      if (!referrals[sender]) {
        return client.sendMessage(sender, `😞 You have no referral record yet. Type "referral" to generate your referral link and start referring friends!`);
      }
      const refData = referrals[sender];
      let msgText = `📢 *Your Referral Details:*\nReferral Code: *${refData.code}*\nTotal Referrals: *${refData.referred.length}*\nCurrent Earnings: *KSH ${refData.earnings}*\n\nReferred Users:\n`;
      if (refData.referred.length === 0) {
        msgText += `None yet. Share your link by typing "referral".`;
      } else {
        refData.referred.forEach((u, idx) => {
          msgText += `${idx + 1}. ${u}\n`;
        });
      }
      if (refData.withdrawals && refData.withdrawals.length > 0) {
        msgText += `\nWithdrawal Requests:\n`;
        refData.withdrawals.forEach((wd, idx) => {
          msgText += `${idx + 1}. ID: ${wd.id}, Amount: KSH ${wd.amount}, Status: ${wd.status}, Requested: ${new Date(wd.timestamp).toLocaleString()}\nRemarks: ${wd.remarks}\n`;
        });
      }
      return client.sendMessage(sender, msgText);
    } else if (body === '2') {
      if (!referrals[sender] || referrals[sender].earnings < MIN_WITHDRAWAL) {
        return client.sendMessage(sender, `😞 You must have at least KSH ${MIN_WITHDRAWAL} in earnings to withdraw.`);
      }
      if (!referrals[sender].pin) {
        return client.sendMessage(sender, `⚠️ Please set up your withdrawal PIN first by choosing option 4.`);
      }
      session[sender].step = 'withdraw_request';
      return client.sendMessage(sender, `💸 *Withdrawal Request*\nPlease enter the withdrawal amount and M-Pesa number separated by a space.\nFor example: \`20 0712345678\`\nNote: Maximum withdrawal is KSH ${MAX_WITHDRAWAL}.\nType "0" to go back.`);
    } else if (body === '3') {
      const link = getReferralLink(sender);
      return client.sendMessage(sender, `😍 *Your Referral Link:*\n${link}\nShare this link with your friends and earn KSH5 for each successful referral (order must be placed)!`);
    } else if (body === '4') {
      session[sender].step = 'set_pin';
      return client.sendMessage(sender, `🔐 *Set/Update Your Withdrawal PIN*\nPlease enter a new 4-digit PIN (cannot be 1234 or 0000).`);
    } else if (body === '5') {
      if (!referrals[sender] || referrals[sender].referred.length === 0) {
        return client.sendMessage(sender, `😞 You have no referred users yet. Type "referral" to get your referral link and start referring!`);
      }
      let refList = `📋 *My Referred Users:*\n`;
      referrals[sender].referred.forEach((u, idx) => {
        refList += `${idx + 1}. ${u}\n`;
      });
      return client.sendMessage(sender, refList);
    } else {
      return client.sendMessage(sender, '❌ Invalid choice. Please type 1, 2, 3, 4, or 5, or "0" to go back.');
    }
  }
  // Withdrawal Request Flow:
  if (session[sender]?.step === 'withdraw_request') {
    const parts = body.split(' ');
    if (parts.length !== 2) {
      return client.sendMessage(sender, '❌ Please enter the amount and M-Pesa number separated by a space. For example: 20 0712345678');
    }
    const amount = Number(parts[0]);
    const mpesa = parts[1];
    if (isNaN(amount) || amount <= 0) {
      return client.sendMessage(sender, '❌ Invalid amount.');
    }
    if (amount > referrals[sender].earnings || amount > MAX_WITHDRAWAL) {
      return client.sendMessage(sender, `❌ You cannot withdraw more than your earnings (KSH ${referrals[sender].earnings}) or the maximum allowed (KSH ${MAX_WITHDRAWAL}).`);
    }
    if (amount < MIN_WITHDRAWAL) {
      return client.sendMessage(sender, `❌ The minimum withdrawal amount is KSH ${MIN_WITHDRAWAL}.`);
    }
    if (!isSafaricomNumber(mpesa)) {
      return client.sendMessage(sender, '❌ Invalid M-Pesa number.');
    }
    session[sender].withdrawRequest = { amount, mpesa };
    session[sender].step = 'withdraw_pin';
    return client.sendMessage(sender, `🔒 Please enter your 4-digit PIN to confirm withdrawal of KSH ${amount} to ${mpesa}.`);
  }
  if (session[sender]?.step === 'withdraw_pin') {
    if (!/^\d{4}$/.test(body)) {
      return client.sendMessage(sender, '❌ PIN must be exactly 4 digits.');
    }
    if (body !== referrals[sender].pin) {
      return client.sendMessage(sender, '❌ Incorrect PIN. Withdrawal cancelled.');
    }
    const reqData = session[sender].withdrawRequest;
    const withdrawal = {
      id: `WD-${Math.floor(1000 + Math.random() * 9000)}`,
      amount: reqData.amount,
      mpesa: reqData.mpesa,
      status: 'PENDING',
      timestamp: new Date().toISOString(),
      remarks: ''
    };
    referrals[sender].withdrawals = referrals[sender].withdrawals || [];
    referrals[sender].withdrawals.push(withdrawal);
    referrals[sender].earnings -= reqData.amount;
    session[sender].step = 'my_referrals_menu';
    delete session[sender].withdrawRequest;
    client.sendMessage(sender, `🙏 *Withdrawal Requested!*\nYour request (ID: ${withdrawal.id}) for KSH ${withdrawal.amount} to be sent to ${reqData.mpesa} is received and pending approval.\nThank you for choosing FYS PROPERTY!`);
    client.sendMessage(`${ADMIN_NUMBER}@c.us`, `🔔 *New Withdrawal Request*\nUser: ${sender}\nWithdrawal ID: ${withdrawal.id}\nAmount: KSH ${withdrawal.amount}\nM-Pesa Number: ${reqData.mpesa}\nTime: ${new Date(withdrawal.timestamp).toLocaleString()}\n\nUse "withdraw update <referrer_code> <withdrawal_id> <STATUS> <remarks>" to update.`);
    return;
  }
  if (session[sender]?.step === 'set_pin') {
    if (!/^\d{4}$/.test(body)) {
      return client.sendMessage(sender, '❌ PIN must be exactly 4 digits.');
    }
    if (body === '1234' || body === '0000') {
      return client.sendMessage(sender, '❌ That PIN is not allowed. Please choose a different 4-digit PIN.');
    }
    if (!referrals[sender]) {
      const code = 'REF' + Math.floor(100000 + Math.random() * 900000);
      referrals[sender] = { code, referred: [], earnings: 0, withdrawals: [], pin: body };
    } else {
      referrals[sender].pin = body;
    }
    session[sender].step = 'my_referrals_menu';
    return client.sendMessage(sender, `✅ Your withdrawal PIN has been set to *${body}*.\nReturning to My Referrals Menu.`);
  }
  
  // ---------- Standard Navigation ----------
  if (body === '0') {
    if (session[sender] && session[sender].prevStep) {
      session[sender].step = session[sender].prevStep;
      return client.sendMessage(sender, '🔙 Returning to previous menu...');
    } else {
      session[sender] = { step: 'main' };
      return client.sendMessage(sender, '🏠 Returning to main menu...');
    }
  }
  if (body === '00') {
    session[sender] = { step: 'main' };
    return client.sendMessage(sender, '🏠 Returning to main menu...');
  }

  // ---------- Main Menu ----------
  if (lower === 'menu' || lower === 'start') {
    session[sender] = { step: 'main' };
    const welcomeMsg = `🌟 *Welcome to FY'S ULTRA BOT!* 🌟\n\n` +
      `Thank you for choosing FYS PROPERTY, where your satisfaction is our priority!\n\n` +
      `Please choose an option by typing a number:\n` +
      `1️⃣ Airtime\n2️⃣ Data Bundles\n3️⃣ SMS Bundles\n4️⃣ My Referrals\n\n` +
      `For order status, type: status <ORDER_ID>\n` +
      `After payment, type: PAID <ORDER_ID>\n` +
      `Type "00" at any time for the main menu.`;
    return client.sendMessage(sender, welcomeMsg);
  }

  // ---------- Airtime Flow ----------
  if (session[sender]?.step === 'main' && lower === '1') {
    session[sender].prevStep = 'main';
    session[sender].step = 'airtime';
    return client.sendMessage(sender, '💳 *Airtime Purchase*\n\nPlease enter the airtime amount in KES (e.g., "50").\nType "0" to go back.');
  }
  if (session[sender]?.step === 'airtime') {
    const amt = Number(body);
    if (isNaN(amt) || amt <= 0) {
      return client.sendMessage(sender, '❌ Invalid amount. Please enter a positive number (e.g., "50").');
    }
    const orderID = generateOrderID();
    orders[orderID] = {
      orderID,
      customer: sender,
      package: `Airtime (KES ${amt})`,
      amount: amt,
      recipient: null,
      payment: null,
      status: 'PENDING',
      timestamp: new Date().toISOString()
    };
    delete session[sender];
    return client.sendMessage(sender,
      `🛒 *Order Created!*\n\n` +
      `🆔 Order ID: *${orderID}*\n` +
      `📦 Package: Airtime (KES ${amt})\n` +
      `💰 Price: KES ${amt}\n\n` +
      `👉 Please enter the *recipient phone number* (e.g., 07XXXXXXXX).\nType "0" to go back.`
    );
  }

  // ---------- Data Flow ----------
  if (session[sender]?.step === 'main' && lower === '2') {
    session[sender].prevStep = 'main';
    session[sender].step = 'data-category';
    return client.sendMessage(sender,
      `📶 *Data Bundles*\nChoose a subcategory by typing the number:\n1) Hourly\n2) Daily\n3) Weekly\n4) Monthly\n\n` +
      `Type "0" to go back, "00" for main menu.`
    );
  }
  if (session[sender]?.step === 'data-category') {
    if (!['1','2','3','4'].includes(lower)) {
      return client.sendMessage(sender, '❌ Invalid choice. Please type 1, 2, 3, or 4.');
    }
    let cat = '';
    if (lower === '1') cat = 'hourly';
    else if (lower === '2') cat = 'daily';
    else if (lower === '3') cat = 'weekly';
    else if (lower === '4') cat = 'monthly';
    session[sender].prevStep = 'data-category';
    session[sender].step = 'data-list';
    session[sender].dataCat = cat;
    let listMsg = `✅ *${cat.toUpperCase()} Data Bundles:*\n`;
    dataPackages[cat].forEach((p) => {
      listMsg += `[${p.id}] ${p.name} @ KSH ${p.price} (${p.validity})\n`;
    });
    listMsg += `\nType the package ID to select (e.g., "1").\nOr type "0" to go back, "00" for main menu.`;
    return client.sendMessage(sender, listMsg);
  }
  if (session[sender]?.step === 'data-list') {
    const cat = session[sender].dataCat;
    const pkgId = Number(body);
    if (isNaN(pkgId)) {
      return client.sendMessage(sender, '❌ Invalid package ID. Please type a number.');
    }
    const selected = dataPackages[cat].find(p => p.id === pkgId);
    if (!selected) {
      return client.sendMessage(sender, '❌ No package with that ID. Type "menu" to restart.');
    }
    const orderID = generateOrderID();
    orders[orderID] = {
      orderID,
      customer: sender,
      package: `${selected.name} (${cat})`,
      amount: selected.price,
      recipient: null,
      payment: null,
      status: 'PENDING',
      timestamp: new Date().toISOString()
    };
    if (session[sender]?.referrer) {
      orders[orderID].referrer = session[sender].referrer;
    }
    delete session[sender];
    return client.sendMessage(sender,
      `🛒 *Order Created!*\n\n` +
      `🆔 Order ID: *${orderID}*\n` +
      `📦 Package: ${selected.name} (${cat})\n` +
      `💰 Price: KSH ${selected.price}\n\n` +
      `👉 Please enter the *recipient phone number* (e.g., 07XXXXXXXX).\nType "0" to go back.`
    );
  }

  // ---------- SMS Flow ----------
  if (session[sender]?.step === 'main' && lower === '3') {
    session[sender].prevStep = 'main';
    session[sender].step = 'sms-category';
    return client.sendMessage(sender,
      `✉️ *SMS Bundles*\nChoose a subcategory by typing the number:\n1) Daily\n2) Weekly\n3) Monthly\n\n` +
      `Type "0" to go back, "00" for main menu.`
    );
  }
  if (session[sender]?.step === 'sms-category') {
    if (!['1','2','3'].includes(lower)) {
      return client.sendMessage(sender, '❌ Invalid choice. Please type 1, 2, or 3.');
    }
    let cat = '';
    if (lower === '1') cat = 'daily';
    else if (lower === '2') cat = 'weekly';
    else if (lower === '3') cat = 'monthly';
    session[sender].prevStep = 'sms-category';
    session[sender].step = 'sms-list';
    session[sender].smsCat = cat;
    let listMsg = `✅ *${cat.toUpperCase()} SMS Bundles:*\n`;
    smsPackages[cat].forEach((p) => {
      listMsg += `[${p.id}] ${p.name} @ KSH ${p.price} (${p.validity})\n`;
    });
    listMsg += `\nType the package ID to select (e.g., "1").\nOr type "0" to go back, "00" for main menu.`;
    return client.sendMessage(sender, listMsg);
  }
  if (session[sender]?.step === 'sms-list') {
    const cat = session[sender].smsCat;
    const pkgId = Number(body);
    if (isNaN(pkgId)) {
      return client.sendMessage(sender, '❌ Invalid package ID. Please type a number.');
    }
    const selected = smsPackages[cat].find(p => p.id === pkgId);
    if (!selected) {
      return client.sendMessage(sender, '❌ No SMS package with that ID. Type "menu" to restart.');
    }
    const orderID = generateOrderID();
    orders[orderID] = {
      orderID,
      customer: sender,
      package: `${selected.name} (SMS - ${cat})`,
      amount: selected.price,
      recipient: null,
      payment: null,
      status: 'PENDING',
      timestamp: new Date().toISOString()
    };
    if (session[sender]?.referrer) {
      orders[orderID].referrer = session[sender].referrer;
    }
    delete session[sender];
    return client.sendMessage(sender,
      `🛒 *Order Created!*\n\n` +
      `🆔 Order ID: *${orderID}*\n` +
      `📦 Package: ${selected.name} (SMS - ${cat})\n` +
      `💰 Price: KSH ${selected.price}\n\n` +
      `👉 Please enter the *recipient phone number* (e.g., 07XXXXXXXX).\nType "0" to go back.`
    );
  }

  // ---------- Capture Recipient ----------
  const pendingRecipOrder = Object.values(orders).find(o => o.customer === sender && !o.recipient);
  if (pendingRecipOrder) {
    if (!isSafaricomNumber(body)) {
      return client.sendMessage(sender, '❌ Invalid phone number. Must be in the format 07XXXXXXXX or 01XXXXXXXX.');
    }
    pendingRecipOrder.recipient = body;
    return client.sendMessage(sender, `✅ Recipient set to *${body}*.\nNow please enter your *payment number* (Safaricom).\nType "0" to go back.`);
  }

  // ---------- Capture Payment ----------
  const pendingPaymentOrder = Object.values(orders).find(o => o.customer === sender && o.recipient && !o.payment);
  if (pendingPaymentOrder) {
    if (!isSafaricomNumber(body)) {
      return client.sendMessage(sender, '❌ Invalid payment number. Must be in the format 07XXXXXXXX or 01XXXXXXXX.');
    }
    pendingPaymentOrder.payment = body;
    const order = pendingPaymentOrder;
    const summary = `🎉 *Order Summary* 🎉\n\n` +
      `🆔 Order ID: *${order.orderID}*\n` +
      `📦 Package: *${order.package}*\n` +
      `💰 Amount: *KSH ${order.amount}*\n` +
      `📞 Recipient: *${order.recipient}*\n` +
      `📱 Payment Number: *${order.payment}*\n` +
      `🕒 Placed at: ${new Date(order.timestamp).toLocaleString()}\n\n` +
      `👉 Please send *KSH ${order.amount}* to *${PAYMENT_INFO}*.\n` +
      `Then type: *PAID ${order.orderID}* when done.\n\n` +
      `Type "0" to go back or "00" for main menu.`;
    client.sendMessage(sender, summary);
    let adminMsg = `🔔 *New Order Received!* 🔔\n\n` +
      `🆔 Order ID: ${order.orderID}\n` +
      `📦 Package: ${order.package}\n` +
      `💰 Amount: KSH ${order.amount}\n` +
      `📞 Recipient: ${order.recipient}\n` +
      `📱 Payment Number: ${order.payment}\n` +
      `🕒 Time: ${new Date(order.timestamp).toLocaleString()}\n` +
      `User: ${sender}\n`;
    if (order.referrer) {
      adminMsg += `Referred by Code: ${order.referrer}\n`;
    }
    adminMsg += `\n*Admin Commands:*\nupdate ${order.orderID} <STATUS> <REMARK>\nset payment <mpesa> "Name"\n` +
      `add data <subcat> "<name>" <price> "<validity>"\nremove data <subcat> <id>\nedit data <subcat> <id> <newprice>\n` +
      `add sms <subcat> "<name>" <price> "<validity>"\nremove sms <subcat> <id>\nedit sms <subcat> <id> <newprice>\n` +
      `search <ORDER_ID>\nset withdrawal <min> <max>\nwithdraw update <referrer_code> <withdrawal_id> <STATUS> <remarks>\nreferrals all\nAdmin CMD`;
    client.sendMessage(`${ADMIN_NUMBER}@c.us`, adminMsg);
    return;
  }

  // ---------- Confirm Payment ----------
  if (lower.startsWith('paid ')) {
    const parts = body.split(' ');
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
    client.sendMessage(sender,
      `✅ Payment confirmed!\nYour order *${orderID}* is now *CONFIRMED*.\n\n✨ Thank you for choosing FYS PROPERTY! We truly appreciate your trust. For any help, please call 0701339573.\n\nType "00" for the main menu.`
    );
    client.sendMessage(`${ADMIN_NUMBER}@c.us`, `🔔 Order *${orderID}* marked as CONFIRMED by the user.`);
    return;
  }

  // ---------- Order Status ----------
  if (lower.startsWith('status ')) {
    const parts = body.split(' ');
    if (parts.length !== 2) {
      return client.sendMessage(sender, '❌ Usage: status <ORDER_ID>');
    }
    const orderID = parts[1];
    if (!orders[orderID]) {
      return client.sendMessage(sender, `❌ Order ${orderID} not found.`);
    }
    const o = orders[orderID];
    return client.sendMessage(sender,
      `📦 *Order Status*\n\n` +
      `🆔 Order ID: ${o.orderID}\n` +
      `📦 Package: ${o.package}\n` +
      `💰 Amount: KSH ${o.amount}\n` +
      `📞 Recipient: ${o.recipient}\n` +
      `📱 Payment: ${o.payment}\n` +
      `📌 Status: ${o.status}\n` +
      `🕒 Placed at: ${new Date(o.timestamp).toLocaleString()}\n` +
      `📝 Remark: ${o.remark || 'None'}\n\n` +
      `Type "0" to go back or "00" for main menu.`
    );
  }

  // ---------- Fallback / Help Message ----------
  client.sendMessage(sender,
    `🤖 *FY'S ULTRA BOT*\n` +
    `Type "menu" to see the main menu.\n` +
    `For order status, type: status <ORDER_ID>\n` +
    `After payment, type: PAID <ORDER_ID>\n` +
    `For referral features, type: my referrals\n` +
    `Or type "0" for previous menu, "00" for main menu.`
  );
});

/**
 * =============================
 * EXPRESS SERVER FOR WEB QR CODE
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
