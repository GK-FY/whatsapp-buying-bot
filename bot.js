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
const ADMIN_NUMBER = process.env.ADMIN_NUMBER || '254701339573'; // Your admin number (without +)
let PAYMENT_INFO = '0701339573 (Camlus)'; // Default M-Pesa details; admin can change it
const PORT = 3000; // Express server port

// In-memory orders store (keys = orderID)
const orders = {};

// Minimal session store to manage user flow (key = sender)
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
// Airtime: Users type the amount they want.

// Data packages grouped by subcategory
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

// SMS packages grouped by subcategory
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

let qrImageUrl = null; // Will hold QR code as a data URL

client.on('qr', (qr) => {
  console.log('🔐 Scan the QR code below with WhatsApp:');
  qrcodeTerminal.generate(qr, { small: true });
  QRCode.toDataURL(qr, (err, url) => {
    if (!err) qrImageUrl = url;
  });
});

client.on('ready', async () => {
  console.log('✅ Bot is online and ready!');
  client.sendMessage(`${ADMIN_NUMBER}@c.us`, `🎉 Hello Admin! FY'S ULTRA BOT is now live.\nType "menu" for the user flow or use admin commands to manage orders.`);
});

/**
 * =============================
 * ADMIN COMMANDS
 * =============================
 * Only messages from ${ADMIN_NUMBER}@c.us are considered admin commands.
 *
 * Commands:
 *   update <ORDER_ID> <STATUS>
 *     - Updates an order's status. Sends a beautiful update message to the customer.
 *
 *   set payment <mpesa_number> "<Name>"
 *     - Updates PAYMENT_INFO (e.g., set payment 0712345678 "Camlus 2.0")
 *
 *   add data <subcat> "<name>" <price> "<validity>"
 *     - Adds a new data package to the specified subcategory (hourly, daily, weekly, monthly)
 *
 *   remove data <subcat> <id>
 *     - Removes a data package from the specified subcategory
 *
 *   edit data <subcat> <id> <newprice>
 *     - Updates the price of a data package in the specified subcategory
 *
 *   add sms <subcat> "<name>" <price> "<validity>"
 *     - Adds a new SMS package to the specified subcategory (daily, weekly, monthly)
 *
 *   remove sms <subcat> <id>
 *     - Removes an SMS package from the specified subcategory
 *
 *   edit sms <subcat> <id> <newprice>
 *     - Updates the price of an SMS package
 *
 *   search <ORDER_ID>
 *     - Searches and displays all details of an order, including the time placed.
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

client.on('message', async (msg) => {
  const sender = msg.from; // e.g., "2547XXXXXXXX@c.us"
  const body = msg.body.trim();
  const lower = body.toLowerCase();

  // ---------- ADMIN COMMANDS ----------
  if (sender === `${ADMIN_NUMBER}@c.us`) {
    // Command: update <ORDER_ID> <STATUS>
    if (lower.startsWith('update ')) {
      const parts = body.split(' ');
      if (parts.length < 3) {
        return client.sendMessage(sender, '❌ Usage: update <ORDER_ID> <STATUS>');
      }
      const orderID = parts[1];
      const newStatus = parts.slice(2).join(' ').toUpperCase();
      if (!orders[orderID]) {
        return client.sendMessage(sender, `❌ Order ${orderID} not found.`);
      }
      orders[orderID].status = newStatus;
      const user = orders[orderID].customer;
      let extraMsg = '';
      if (newStatus === 'CONFIRMED') {
        extraMsg = '✅ Your payment has been confirmed! We are processing your order.';
      } else if (newStatus === 'COMPLETED') {
        extraMsg = '🎉 Your order has been completed! Thank you for choosing FYS PROPERTY. We hope you enjoy your purchase!';
      } else if (newStatus === 'CANCELLED') {
        extraMsg = '🚫 Your order has been cancelled. Please contact support if needed.';
      } else if (newStatus === 'REFUNDED') {
        extraMsg = '💰 Your order has been refunded. Please check your M-Pesa balance.';
      } else {
        extraMsg = 'Your order status has been updated.';
      }
      // Send a beautiful, sensitive update message to the customer.
      client.sendMessage(user, `🔔 *Order Update*\nYour order *${orderID}* is now *${newStatus}*.\n\n✨ Thank you for choosing FYS PROPERTY! We truly appreciate your trust. For any help, please call 0701339573.\n\nReply with "0" to go back to the previous menu or "00" for the main menu.`);
      return client.sendMessage(sender, `✅ Order *${orderID}* updated to *${newStatus}* successfully.`);
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
        return client.sendMessage(sender, `❌ No data package with ID ${idToRemove} in ${subcat}.`);
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
        return client.sendMessage(sender, `❌ No data package with ID ${idToEdit} in ${subcat}.`);
      }
      pack.price = newPrice;
      return client.sendMessage(sender, `✅ Updated data package [${idToEdit}] in ${subcat} to price KSH ${newPrice}.`);
    }

    // Command: add sms <subcat> "<name>" <price> "<validity>"
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

    // Command: remove sms <subcat> <id>
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

    // Command: edit sms <subcat> <id> <newprice>
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
        `🕒 Placed at: ${new Date(o.timestamp).toLocaleString()}`
      );
    }
  } // END ADMIN COMMANDS

  // ---------- USER FLOW ----------
  // Allow "0" to go back to previous menu and "00" for main menu.
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
      `Thank you for choosing FYS PROPERTY! We are dedicated to providing you with the best offers.\n\n` +
      `Please choose an option by typing a number:\n` +
      `1️⃣ Airtime\n` +
      `2️⃣ Data Bundles\n` +
      `3️⃣ SMS Bundles\n\n` +
      `For order status, type: status <ORDER_ID>\n` +
      `Or if you've paid, type: PAID <ORDER_ID>\n` +
      `Type "00" at any time to return to the main menu.`;
    return client.sendMessage(sender, welcomeMsg);
  }

  // --------- Airtime Flow ---------
  if (session[sender]?.step === 'main' && lower === '1') {
    session[sender].prevStep = 'main';
    session[sender].step = 'airtime';
    return client.sendMessage(sender, '💳 *Airtime Purchase*\n\nPlease enter the amount in KES (e.g., "50").\nType "0" to go back.');
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
      `👉 Please enter the *recipient phone number* (Safaricom, e.g., 07XXXXXXXX).\nType "0" to go back.`
    );
  }

  // --------- Data Flow ---------
  if (session[sender]?.step === 'main' && lower === '2') {
    session[sender].prevStep = 'main';
    session[sender].step = 'data-category';
    return client.sendMessage(sender,
      `📶 *Data Bundles*\nChoose a subcategory by typing the number:\n` +
      `1) Hourly\n2) Daily\n3) Weekly\n4) Monthly\n\n` +
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
      `✉️ *SMS Bundles*\nChoose a subcategory by typing the number:\n` +
      `1) Daily\n2) Weekly\n3) Monthly\n\n` +
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
    // Notify admin with all details
    client.sendMessage(`${ADMIN_NUMBER}@c.us`,
      `🔔 *New Order Received!* 🔔\n\n` +
      `🆔 Order ID: ${order.orderID}\n` +
      `📦 Package: ${order.package}\n` +
      `💰 Amount: KSH ${order.amount}\n` +
      `📞 Recipient: ${order.recipient}\n` +
      `📱 Payment Number: ${order.payment}\n` +
      `🕒 Time: ${new Date(order.timestamp).toLocaleString()}\n` +
      `User: ${sender}\n\n` +
      `*Admin Commands:*\n` +
      `update ${order.orderID} CONFIRMED\n` +
      `update ${order.orderID} COMPLETED\n` +
      `update ${order.orderID} REFUNDED\n` +
      `update ${order.orderID} CANCELLED\n` +
      `set payment <mpesa> "Name"\n` +
      `add data <subcat> "<name>" <price> "<validity>"\n` +
      `remove data <subcat> <id>\n` +
      `edit data <subcat> <id> <newprice>\n` +
      `search <ORDER_ID>`
    );
    return;
  }

  // ---------- Confirm Payment (User types "PAID <ORDER_ID>")
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
    client.sendMessage(sender,
      `✅ Payment confirmed!\nYour order *${orderID}* is now *CONFIRMED*.\n\n✨ Thank you for choosing FYS PROPERTY! We truly appreciate your trust. For any help, please call 0701339573.\n\nType "00" for the main menu.`
    );
    client.sendMessage(`${ADMIN_NUMBER}@c.us`, `🔔 Order *${orderID}* marked as CONFIRMED by the user.`);
    return;
  }

  // ---------- Order Status (User types "status <ORDER_ID>")
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

  // ---------- Fallback / Help Message ----------
  client.sendMessage(sender,
    `🤖 *FY'S ULTRA BOT*\n` +
    `Type "menu" to see the main menu.\n` +
    `To check an order, type: status <ORDER_ID>\n` +
    `After payment, type: PAID <ORDER_ID>\n` +
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
