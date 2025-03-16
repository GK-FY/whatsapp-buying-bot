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
const ADMIN_NUMBER = process.env.ADMIN_NUMBER || '254701339573'; // Admin number (without plus)
let PAYMENT_INFO = '0701339573 (Camlus)'; // Default payment details (can be updated by admin)
const PORT = 3000; // Port for the Express server

// In-memory orders store: key = orderID, value = order details
const orders = {};

// In-memory referral store: key = referrer (sender id), value = { code, referred: [user IDs], earnings, withdrawals: [] }
const referrals = {};

// In-memory session for each user to manage flow (key = sender)
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
 * PACKAGES: Airtime, Data, SMS
 * =============================
 */
// Airtime: user enters an amount

// Data packages organized by subcategory
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

// SMS packages organized by subcategory
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
  // Also generate a data URL for the web page:
  QRCode.toDataURL(qr, (err, url) => {
    if (!err) qrImageUrl = url;
  });
});

client.on('ready', async () => {
  console.log('✅ Bot is online and ready!');
  client.sendMessage(`${ADMIN_NUMBER}@c.us`, `🎉 Hello Admin! FY'S ULTRA BOT is live. Type "menu" for user flow or use admin commands to manage orders and referrals.`);
});

/**
 * =============================
 * REFERRAL FUNCTIONS
 * =============================
 */
// When a user sends "referral", they get a unique referral link.
function getReferralLink(sender) {
  if (!referrals[sender]) {
    // Generate a unique referral code (e.g., "REF" + 6 random digits)
    const code = 'REF' + Math.floor(100000 + Math.random() * 900000);
    referrals[sender] = { code, referred: [], earnings: 0, withdrawals: [] };
  }
  // The referral link uses the bot's WhatsApp number and includes the code
  return `https://wa.me/${ADMIN_NUMBER}?text=ref ${referrals[sender].code}`;
}

// If a new user sends "ref <code>", record that they were referred.
function recordReferral(newUser, refCode) {
  // Search referrals to see if any referrer has this code
  for (let referrer in referrals) {
    if (referrals[referrer].code === refCode) {
      // Avoid self-referral
      if (referrer === newUser) return;
      if (!referrals[referrer].referred.includes(newUser)) {
        referrals[referrer].referred.push(newUser);
      }
      // Save referrer in session for this order flow
      if (!session[newUser]) session[newUser] = {};
      session[newUser].referrer = refCode;
      return;
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

  // ----- REFERRAL USER COMMANDS -----
  if (lower === 'referral') {
    // Provide the user with their unique referral link.
    const link = getReferralLink(sender);
    return client.sendMessage(sender, `😍 *Your Referral Link:*\n${link}\nShare this link with your friends. For every order placed through your referral, you'll earn KSH55!`);
  }
  // If the message starts with "ref " assume it's a referral code from a new user.
  if (lower.startsWith('ref ')) {
    const parts = body.split(' ');
    if (parts.length === 2) {
      const refCode = parts[1].toUpperCase();
      recordReferral(sender, refCode);
      return client.sendMessage(sender, `🙏 Thank you! You were referred by code *${refCode}*. Enjoy our offers and share your own referral link by typing "referral".`);
    }
  }
  // User can check their referral details.
  if (lower === 'referrals') {
    if (!referrals[sender]) {
      return client.sendMessage(sender, `😞 You have no referral record yet. Type "referral" to get your referral link and start referring friends!`);
    }
    const refData = referrals[sender];
    let messageText = `📢 *Your Referral Details:*\nReferral Code: *${refData.code}*\nTotal Referrals: *${refData.referred.length}*\nCurrent Earnings: *KSH ${refData.earnings}*\n\nReferred Users:\n`;
    if (refData.referred.length === 0) {
      messageText += `None yet. Share your link: type "referral" to get it.`;
    } else {
      refData.referred.forEach((u, idx) => {
        messageText += `${idx + 1}. ${u}\n`;
      });
    }
    return client.sendMessage(sender, messageText);
  }
  // User withdraw earnings command.
  if (lower === 'withdraw earnings') {
    if (!referrals[sender] || referrals[sender].earnings < 20) {
      return client.sendMessage(sender, `😞 You must earn at least KSH 20 to withdraw. Keep referring and placing orders!`);
    }
    session[sender] = session[sender] || {};
    session[sender].step = 'withdraw';
    return client.sendMessage(sender, `💸 *Withdrawal Request*\nYou have KSH ${referrals[sender].earnings} available.\nPlease enter the M-Pesa number to which you want your earnings sent (e.g., 07XXXXXXXX).`);
  }
  if (session[sender]?.step === 'withdraw') {
    if (!isSafaricomNumber(body)) {
      return client.sendMessage(sender, '❌ Invalid number. Please enter a valid Safaricom number (07XXXXXXXX or 01XXXXXXXX).');
    }
    // Record the withdrawal request
    const withdrawal = {
      id: `WD-${Math.floor(1000 + Math.random() * 9000)}`,
      amount: referrals[sender].earnings,
      mpesa: body,
      status: 'PENDING',
      timestamp: new Date().toISOString(),
      remarks: ''
    };
    referrals[sender].withdrawals = referrals[sender].withdrawals || [];
    referrals[sender].withdrawals.push(withdrawal);
    // Reset earnings (pending admin approval)
    referrals[sender].earnings = 0;
    session[sender].step = null;
    // Notify user and admin
    client.sendMessage(sender, `🙏 *Withdrawal Requested!*\nYour request (ID: ${withdrawal.id}) for KSH ${withdrawal.amount} to be sent to ${body} is received and is pending approval.\nThank you for using FYS PROPERTY!`);
    client.sendMessage(`${ADMIN_NUMBER}@c.us`, `🔔 *New Withdrawal Request*\nUser: ${sender}\nWithdrawal ID: ${withdrawal.id}\nAmount: KSH ${withdrawal.amount}\nM-Pesa Number: ${body}\nTime: ${new Date(withdrawal.timestamp).toLocaleString()}\n\nUse "withdraw update ${sender} ${withdrawal.id} <STATUS> <remarks>" to update.`);
    return;
  }

  // ----- ADMIN REFERRAL WITHDRAW UPDATE COMMAND -----
  if (sender === `${ADMIN_NUMBER}@c.us` && lower.startsWith('withdraw update ')) {
    const parts = body.split(' ');
    if (parts.length < 4) {
      return client.sendMessage(sender, '❌ Usage: withdraw update <referrer_code> <withdrawal_id> <STATUS> <remarks>');
    }
    const refCode = parts[2];
    const wdId = parts[3];
    const newStatus = parts[4].toUpperCase();
    const remarks = parts.slice(5).join(' ');
    // Find referrer by code
    let referrer = null;
    for (let r in referrals) {
      if (referrals[r].code === refCode) {
        referrer = r;
        break;
      }
    }
    if (!referrer) {
      return client.sendMessage(sender, `❌ Referrer with code ${refCode} not found.`);
    }
    // Find withdrawal in referrals[referrer].withdrawals
    const wdArr = referrals[referrer].withdrawals || [];
    const wd = wdArr.find(w => w.id === wdId);
    if (!wd) {
      return client.sendMessage(sender, `❌ Withdrawal ID ${wdId} not found for referrer ${refCode}.`);
    }
    wd.status = newStatus;
    wd.remarks = remarks;
    client.sendMessage(sender, `✅ Withdrawal ${wdId} for referrer ${refCode} updated to ${newStatus}.\nRemarks: ${remarks}`);
    client.sendMessage(referrer, `🔔 *Withdrawal Update*\nYour withdrawal (ID: ${wdId}) has been updated to *${newStatus}*.\nRemarks: ${remarks}`);
    return;
  }

  // ----- ADMIN: Referral overview -----
  if (sender === `${ADMIN_NUMBER}@c.us` && lower === 'referrals all') {
    let msgText = `📢 *All Referral Details:*\n\n`;
    for (let r in referrals) {
      msgText += `Referrer: ${r}\nCode: ${referrals[r].code}\nTotal Referrals: ${referrals[r].referred.length}\nEarnings: KSH ${referrals[r].earnings}\nWithdrawals: ${referrals[r].withdrawals ? referrals[r].withdrawals.length : 0}\n---------------------\n`;
    }
    return client.sendMessage(sender, msgText);
  }

  // ---------- ADMIN COMMANDS END ----------

  // ---------- USER FLOW ----------
  // Allow "0" to go to previous menu and "00" for main menu.
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

  // Main Menu
  if (lower === 'menu' || lower === 'start') {
    session[sender] = { step: 'main' };
    const welcomeMsg = `🌟 *Welcome to FY'S ULTRA BOT!* 🌟\n\n` +
      `Thank you for choosing FYS PROPERTY! We are dedicated to serving you with the best offers.\n\n` +
      `Please choose an option by typing a number:\n` +
      `1️⃣ Airtime\n` +
      `2️⃣ Data Bundles\n` +
      `3️⃣ SMS Bundles\n\n` +
      `To view your referral details, type: referrals\n` +
      `To get your referral link, type: referral\n` +
      `To withdraw your earnings, type: withdraw earnings\n\n` +
      `For order status, type: status <ORDER_ID>\n` +
      `Or if you've paid, type: PAID <ORDER_ID>\n` +
      `Type "00" at any time for the main menu.`;
    return client.sendMessage(sender, welcomeMsg);
  }

  // --------- Airtime Flow ---------
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

  // --------- Data Flow ---------
  if (session[sender]?.step === 'main' && lower === '2') {
    session[sender].prevStep = 'main';
    session[sender].step = 'data-category';
    return client.sendMessage(sender,
      `📶 *Data Bundles*\nChoose a subcategory:\n1) Hourly\n2) Daily\n3) Weekly\n4) Monthly\n\n` +
      `Type "0" to go back, "00" for main menu.`
    );
  }
  if (session[sender]?.step === 'data-category') {
    if (!['1', '2', '3', '4'].includes(lower)) {
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
    // Record referral if exists
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

  // --------- SMS Flow ---------
  if (session[sender]?.step === 'main' && lower === '3') {
    session[sender].prevStep = 'main';
    session[sender].step = 'sms-category';
    return client.sendMessage(sender,
      `✉️ *SMS Bundles*\nChoose a subcategory:\n1) Daily\n2) Weekly\n3) Monthly\n\n` +
      `Type "0" to go back, "00" for main menu.`
    );
  }
  if (session[sender]?.step === 'sms-category') {
    if (!['1', '2', '3'].includes(lower)) {
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
    // Notify admin with order and referral details if any.
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
      // If order becomes COMPLETED later, we’ll credit KSH55 (see update command)
    }
    adminMsg += `\n*Admin Commands:*\nupdate ${order.orderID} CONFIRMED\nupdate ${order.orderID} COMPLETED\nupdate ${order.orderID} REFUNDED\nupdate ${order.orderID} CANCELLED\n` +
      `set payment <mpesa> "Name"\nadd data <subcat> "<name>" <price> "<validity>"\nremove data <subcat> <id>\nedit data <subcat> <id> <newprice>\n` +
      `add sms <subcat> "<name>" <price> "<validity>"\nremove sms <subcat> <id>\nedit sms <subcat> <id> <newprice>\n` +
      `search <ORDER_ID>\nwithdraw update <referrer_code> <withdrawal_id> <STATUS> <remarks>\nreferrals all`;
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
    // If the order has a referrer and not yet credited, credit KSH55
    if (orders[orderID].referrer && !orders[orderID].referralCredited) {
      // Find the referrer by code
      for (let ref in referrals) {
        if (referrals[ref].code === orders[orderID].referrer) {
          referrals[ref].earnings += 55;
          break;
        }
      }
      orders[orderID].referralCredited = true;
    }
    client.sendMessage(sender,
      `✅ Payment confirmed!\nYour order *${orderID}* is now *CONFIRMED*.\n\n✨ Thank you for choosing FYS PROPERTY! We truly appreciate your trust.\nFor assistance, please call 0701339573.\n\nType "00" for the main menu.`
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
      `🕒 Placed at: ${new Date(o.timestamp).toLocaleString()}\n\n` +
      `Type "0" to go back or "00" for main menu.`
    );
  }

  // ---------- Special: If an order is updated to CANCELLED, send a special cancellation message ----------
  // (This is handled in the admin update command when newStatus is CANCELLED.)

  // ---------- Referral: Check if user wants to see their referral link or details ----------
  if (lower === 'referral') {
    const link = getReferralLink(sender);
    return client.sendMessage(sender, `😍 *Your Referral Link:*\n${link}\nShare this with friends! Earn KSH55 for every successful referral (order must be placed).\nType "referrals" to view your referral details.`);
  }
  if (lower === 'referrals') {
    if (!referrals[sender]) {
      return client.sendMessage(sender, `😞 You have no referral record yet. Type "referral" to generate your referral link and start referring friends!`);
    }
    const refData = referrals[sender];
    let messageText = `📢 *Your Referral Details:*\nReferral Code: *${refData.code}*\nTotal Referrals: *${refData.referred.length}*\nCurrent Earnings: *KSH ${refData.earnings}*\n\nReferred Users:\n`;
    if (refData.referred.length === 0) {
      messageText += `None yet. Share your link by typing "referral".`;
    } else {
      refData.referred.forEach((u, idx) => {
        messageText += `${idx + 1}. ${u}\n`;
      });
    }
    if (refData.withdrawals && refData.withdrawals.length > 0) {
      messageText += `\nWithdrawal Requests:\n`;
      refData.withdrawals.forEach((wd, idx) => {
        messageText += `${idx + 1}. ID: ${wd.id}, Amount: KSH ${wd.amount}, Status: ${wd.status}, Requested: ${new Date(wd.timestamp).toLocaleString()}\nRemarks: ${wd.remarks}\n`;
      });
    }
    return client.sendMessage(sender, messageText);
  }
  // If user wants to withdraw earnings
  if (lower === 'withdraw earnings') {
    if (!referrals[sender] || referrals[sender].earnings < 20) {
      return client.sendMessage(sender, `😞 You must earn at least KSH 20 to withdraw. Keep referring and placing orders!`);
    }
    session[sender] = session[sender] || {};
    session[sender].step = 'withdraw';
    return client.sendMessage(sender, `💸 *Withdrawal Request*\nYou have KSH ${referrals[sender].earnings} available.\nPlease enter the M-Pesa number where you'd like to receive your earnings (e.g., 07XXXXXXXX).`);
  }
  if (session[sender]?.step === 'withdraw') {
    if (!isSafaricomNumber(body)) {
      return client.sendMessage(sender, '❌ Invalid number. Enter a valid Safaricom number (07XXXXXXXX or 01XXXXXXXX).');
    }
    const withdrawal = {
      id: `WD-${Math.floor(1000 + Math.random() * 9000)}`,
      amount: referrals[sender].earnings,
      mpesa: body,
      status: 'PENDING',
      timestamp: new Date().toISOString(),
      remarks: ''
    };
    referrals[sender].withdrawals = referrals[sender].withdrawals || [];
    referrals[sender].withdrawals.push(withdrawal);
    referrals[sender].earnings = 0;
    session[sender].step = null;
    client.sendMessage(sender, `🙏 *Withdrawal Requested!*\nYour request (ID: ${withdrawal.id}) for KSH ${withdrawal.amount} to be sent to ${body} is received and pending approval.\nThank you for choosing FYS PROPERTY!`);
    client.sendMessage(`${ADMIN_NUMBER}@c.us`, `🔔 *New Withdrawal Request*\nUser: ${sender}\nWithdrawal ID: ${withdrawal.id}\nAmount: KSH ${withdrawal.amount}\nM-Pesa Number: ${body}\nTime: ${new Date(withdrawal.timestamp).toLocaleString()}\n\nUse "withdraw update ${referrals[sender].code} ${withdrawal.id} <STATUS> <remarks>" to update.`);
    return;
  }

  // ---------- Admin Referral Withdrawal Update (handled above) ----------
  // ---------- Admin Referral Overview (handled above with "referrals all") ----------
  if (sender === `${ADMIN_NUMBER}@c.us` && lower === 'referrals all') {
    let msgText = `📢 *All Referral Details:*\n\n`;
    for (let r in referrals) {
      msgText += `Referrer: ${r}\nCode: ${referrals[r].code}\nTotal Referrals: ${referrals[r].referred.length}\nEarnings: KSH ${referrals[r].earnings}\nWithdrawals: ${referrals[r].withdrawals ? referrals[r].withdrawals.length : 0}\n---------------------\n`;
    }
    return client.sendMessage(sender, msgText);
  }

  // ---------- Fallback / Help Message ----------
  client.sendMessage(sender,
    `🤖 *FY'S ULTRA BOT*\n` +
    `Type "menu" to see the main menu.\n` +
    `For order status, type: status <ORDER_ID>\n` +
    `After payment, type: PAID <ORDER_ID>\n` +
    `Or use "referral", "referrals", "withdraw earnings" for referral features.\n` +
    `Type "0" for previous menu, "00" for main menu.`
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
