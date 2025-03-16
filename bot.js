/**
 * WhatsApp Buying Bot
 * ===================
 * Features:
 *  - Single-digit steps for Data & SMS
 *  - Minimal flow: choose category -> pick bundle -> enter recipient -> payment -> done
 *  - No database needed (in-memory orders)
 *  - Admin commands to update orders
 *  - Webpage QR code (http://localhost:3000/qr) for easy scanning
 */

require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');
const express = require('express');

// ---------------------------
// Configuration
// ---------------------------
const ADMIN_NUMBER = process.env.ADMIN_NUMBER || '254701339573'; // e.g. "254701234567"
const PAYMENT_INFO = '0701339573 (Camlus)'; // M-Pesa payment details

// In-memory sessions (for step-by-step user flow)
const session = {};
// In-memory orders (keys = orderID)
const orders = {};

// Web-based QR code data
let qrImageUrl = null;

// ---------------------------
// Bundles & Packages
// ---------------------------
const dataCategories = {
  1: {
    label: 'Hourly',
    bundles: [
      { id: 1, name: '1GB', price: 19, validity: '1 Hour' },
      { id: 2, name: '1.5GB', price: 49, validity: '3 Hours' },
    ],
  },
  2: {
    label: 'Daily',
    bundles: [
      { id: 1, name: '1.25GB', price: 55, validity: 'Till Midnight' },
      { id: 2, name: '1GB', price: 99, validity: '24 Hours' },
      { id: 3, name: '250MB', price: 20, validity: '24 Hours' },
    ],
  },
  3: {
    label: 'Weekly',
    bundles: [
      { id: 1, name: '6GB', price: 700, validity: '7 Days' },
      { id: 2, name: '2.5GB', price: 300, validity: '7 Days' },
      { id: 3, name: '350MB', price: 50, validity: '7 Days' },
    ],
  },
  4: {
    label: 'Monthly',
    bundles: [
      { id: 1, name: '1.2GB', price: 250, validity: '30 Days' },
      { id: 2, name: '500MB', price: 100, validity: '30 Days' },
    ],
  },
};

const smsCategories = {
  1: { id: 1, name: '200 SMS', price: 10, validity: 'Daily' },
  2: { id: 2, name: '1000 SMS', price: 29, validity: 'Weekly' },
};

// ---------------------------
// Helper Functions
// ---------------------------
function generateOrderID() {
  return `FY'S-${Math.floor(100000 + Math.random() * 900000)}`;
}

function isSafaricomNumber(num) {
  return /^0[71]\d{8}$/.test(num) || /^01\d{8}$/.test(num);
}

// ---------------------------
// WhatsApp Client
// ---------------------------
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: { headless: true },
});

// On QR event, store as data URL + print in terminal
client.on('qr', (qr) => {
  // Terminal display
  console.log('Scan the QR code below (or visit /qr to see it in the browser):');
  qrcodeTerminal.generate(qr, { small: true });

  // Web-based QR
  QRCode.toDataURL(qr, (err, url) => {
    if (!err) qrImageUrl = url;
  });
});

client.on('ready', () => {
  console.log('✅ Bot is online and ready!');
});

// ---------------------------
// Handle Incoming Messages
// ---------------------------
client.on('message', async (message) => {
  const sender = message.from; // e.g. "2547XXXXXXX@c.us"
  const text = message.body.trim();

  // ========== ADMIN COMMANDS ==========
  if (sender === ADMIN_NUMBER) {
    // e.g. "update FY'S-123456 confirmed"
    if (text.toLowerCase().startsWith('update ')) {
      const parts = text.split(' ');
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
      switch (newStatus) {
        case 'CONFIRMED':
          extraMsg = '✅ Payment confirmed! We are processing your order soon.';
          break;
        case 'COMPLETED':
          extraMsg = '🎉 Your order is now complete! Enjoy.';
          break;
        case 'CANCELLED':
          extraMsg = '🚫 Your order was cancelled. Contact support if needed.';
          break;
        case 'REFUNDED':
          extraMsg = '💰 Your order was refunded. Check your M-Pesa balance.';
          break;
        default:
          extraMsg = '';
      }
      client.sendMessage(user, `🔔 *Order Update*\nOrder *${orderID}* status: *${newStatus}*\n${extraMsg}`);
      client.sendMessage(sender, `✅ Order *${orderID}* updated to *${newStatus}*.`);
      return;
    }
  }

  // ========== USER FLOW ==========
  // "menu" or "start"
  if (text.toLowerCase() === 'menu' || text.toLowerCase() === 'start') {
    session[sender] = { step: 'main' };
    const menuMsg = `🎉 *Welcome to FY'S Buying Bot!* 🎉\n\n` +
      `Select an option by typing a number:\n` +
      `1️⃣ Buy Data Bundles\n` +
      `2️⃣ Buy Airtime (Coming Soon)\n` +
      `3️⃣ Buy SMS Bundles\n\n` +
      `Type "status <ORDER_ID>" to check an existing order.\n` +
      `Type "menu" any time to return here.`;
    return client.sendMessage(sender, menuMsg);
  }

  // If user typed a single digit while on main step
  if (session[sender]?.step === 'main') {
    if (text === '1') {
      // Data
      session[sender].step = 'dataCategory';
      return client.sendMessage(sender, `📊 *DATA BUNDLES*\nChoose validity:\n1) Hourly\n2) Daily\n3) Weekly\n4) Monthly`);
    } else if (text === '2') {
      // Airtime (coming soon)
      return client.sendMessage(sender, '⚠️ Airtime purchase is *coming soon!* Type "menu" to go back.');
    } else if (text === '3') {
      // SMS
      session[sender].step = 'smsCategory';
      return client.sendMessage(sender, `✉️ *SMS BUNDLES*\n1) 200 SMS @ KES 10 (Daily)\n2) 1000 SMS @ KES 29 (Weekly)`);
    } else {
      return client.sendMessage(sender, '❌ Invalid option. Type "menu" to return.');
    }
  }

  // ========== DATA FLOW ==========
  if (session[sender]?.step === 'dataCategory') {
    // text should be "1", "2", "3", or "4"
    const catNum = Number(text);
    if (![1, 2, 3, 4].includes(catNum)) {
      return client.sendMessage(sender, '❌ Invalid data category. Type "menu" to return.');
    }
    session[sender].dataCat = catNum;
    session[sender].step = 'dataBundleList';

    const chosenCat = dataCategories[catNum];
    let listMsg = `✅ *${chosenCat.label} Bundles*\n`;
    chosenCat.bundles.forEach((b) => {
      listMsg += `${b.id}) ${b.name} @ KES ${b.price} (${b.validity})\n`;
    });
    listMsg += '\nType the bundle number (e.g. "1").';
    return client.sendMessage(sender, listMsg);
  }

  if (session[sender]?.step === 'dataBundleList') {
    const catNum = session[sender].dataCat;
    const chosenCat = dataCategories[catNum];
    const bundleId = Number(text);
    const selected = chosenCat.bundles.find((b) => b.id === bundleId);
    if (!selected) {
      return client.sendMessage(sender, '❌ Invalid bundle number. Type "menu" to return.');
    }
    // Create new order
    const orderID = generateOrderID();
    orders[orderID] = {
      orderID,
      customer: sender,
      package: `${selected.name} (${chosenCat.label})`,
      amount: selected.price,
      recipient: null,
      payment: null,
      status: 'PENDING',
      timestamp: new Date().toISOString(),
    };

    // Clear session
    delete session[sender];

    // Ask for recipient
    return client.sendMessage(sender,
      `🛒 *Order Created!* 🛒\n\n` +
      `🆔 Order ID: *${orderID}*\n` +
      `📦 Package: *${selected.name}* (${chosenCat.label})\n` +
      `💰 Price: *KSH ${selected.price}*\n\n` +
      `👉 Please enter the *recipient number* (Safaricom, e.g. 07XXXXXXXX):`
    );
  }

  // ========== SMS FLOW ==========
  if (session[sender]?.step === 'smsCategory') {
    const choice = Number(text);
    if (![1, 2].includes(choice)) {
      return client.sendMessage(sender, '❌ Invalid SMS option. Type "menu" to return.');
    }
    const selected = smsCategories[choice];
    const orderID = generateOrderID();
    orders[orderID] = {
      orderID,
      customer: sender,
      package: `${selected.name} (SMS - ${selected.validity})`,
      amount: selected.price,
      recipient: null,
      payment: null,
      status: 'PENDING',
      timestamp: new Date().toISOString(),
    };

    // Clear session
    delete session[sender];

    // Ask for recipient
    return client.sendMessage(sender,
      `🛒 *Order Created!* 🛒\n\n` +
      `🆔 Order ID: *${orderID}*\n` +
      `📦 Package: *${selected.name}* (${selected.validity})\n` +
      `💰 Price: *KSH ${selected.price}*\n\n` +
      `👉 Please enter the *recipient number* (Safaricom, e.g. 07XXXXXXXX):`
    );
  }

  // ========== CAPTURE RECIPIENT & PAYMENT ==========
  // 1) If there's an order with no recipient
  const pendingRecipOrder = Object.values(orders).find(
    (o) => o.customer === sender && !o.recipient
  );
  if (pendingRecipOrder && isSafaricomNumber(text)) {
    pendingRecipOrder.recipient = text;
    return client.sendMessage(sender,
      `✅ Recipient number set to *${text}*.\n` +
      `Please enter your *payment number* (Safaricom):`
    );
  } else if (pendingRecipOrder && !isSafaricomNumber(text)) {
    // If user typed something not recognized as a Safaricom # but we expect a recipient
    return client.sendMessage(sender, '❌ Invalid number. Must be Safaricom (07XXXXXXX or 01XXXXXXX).');
  }

  // 2) If there's an order with a recipient but no payment
  const pendingPaymentOrder = Object.values(orders).find(
    (o) => o.customer === sender && o.recipient && !o.payment
  );
  if (pendingPaymentOrder && isSafaricomNumber(text)) {
    pendingPaymentOrder.payment = text;
    // Summarize
    const order = pendingPaymentOrder;
    const summary = `🎉 *Order Summary* 🎉\n\n` +
      `🆔 Order ID: *${order.orderID}*\n` +
      `📦 Package: *${order.package}*\n` +
      `💰 Amount: *KSH ${order.amount}*\n` +
      `📞 Recipient: *${order.recipient}*\n` +
      `📱 Payment Number: *${order.payment}*\n` +
      `🕒 Time: ${new Date(order.timestamp).toLocaleString()}\n\n` +
      `👉 Send *KSH ${order.amount}* to *${PAYMENT_INFO}*\n` +
      `Then type: *PAID ${order.orderID}* when done.`;
    client.sendMessage(sender, summary);

    // Notify admin
    client.sendMessage(ADMIN_NUMBER,
      `🔔 *New Order* 🔔\n\n` +
      `🆔 *${order.orderID}*\n` +
      `📦 ${order.package}\n` +
      `💰 KSH ${order.amount}\n` +
      `📞 Recipient: ${order.recipient}\n` +
      `📱 Payment: ${order.payment}\n` +
      `User: ${sender}\n\n` +
      `*Admin Commands*:\n` +
      `update ${order.orderID} CONFIRMED\n` +
      `update ${order.orderID} COMPLETED\n` +
      `update ${order.orderID} REFUNDED\n` +
      `update ${order.orderID} CANCELLED\n`
    );
    return;
  } else if (pendingPaymentOrder && !isSafaricomNumber(text)) {
    return client.sendMessage(sender, '❌ Invalid payment number. Must be Safaricom (07XXXXXXX or 01XXXXXXX).');
  }

  // ========== PAID <ORDERID> ==========
  if (text.toLowerCase().startsWith('paid ')) {
    const parts = text.split(' ');
    if (parts.length !== 2) {
      return client.sendMessage(sender, '❌ Usage: PAID <ORDER_ID>');
    }
    const orderID = parts[1];
    if (!orders[orderID]) {
      return client.sendMessage(sender, `❌ Order ${orderID} not found.`);
    }
    orders[orderID].status = 'CONFIRMED';
    client.sendMessage(sender, `✅ Payment noted! Your order *${orderID}* is now *CONFIRMED*.\nWe'll process it soon.`);
    client.sendMessage(ADMIN_NUMBER, `🔔 Order *${orderID}* was marked as CONFIRMED by the user.`);
    return;
  }

  // ========== STATUS <ORDERID> ==========
  if (text.toLowerCase().startsWith('status ')) {
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
      `📦 *Order Status*\n\n` +
      `🆔 ${o.orderID}\n` +
      `📦 ${o.package}\n` +
      `💰 KSH ${o.amount}\n` +
      `📞 Recipient: ${o.recipient}\n` +
      `📱 Payment: ${o.payment}\n` +
      `📌 Status: *${o.status}*\n`
    );
  }

  // ========== Fallback ==========
  client.sendMessage(sender,
    `🤖 *FY'S Buying Bot*\n` +
    `Type "menu" to view options.\n` +
    `Or "status <ORDERID>" to check an order.\n` +
    `Or "PAID <ORDERID>" after payment.`
  );
});

// ---------------------------
// Express Server for QR Page
// ---------------------------
const app = express();
app.get('/qr', (req, res) => {
  if (qrImageUrl) {
    return res.send(`
      <html>
        <head>
          <title>WhatsApp Bot QR</title>
        </head>
        <body style="font-family:sans-serif;text-align:center;">
          <h1>Scan This QR Code</h1>
          <img src="${qrImageUrl}" alt="qr" style="width:300px;height:300px"/>
          <p>Open WhatsApp > Linked Devices > Scan this code</p>
        </body>
      </html>
    `);
  } else {
    return res.send('<h1>QR not available yet. Check console.</h1>');
  }
});
app.get('/', (req, res) => {
  res.send('<h1>Welcome to the WhatsApp Buying Bot!</h1><p>Visit <a href="/qr">/qr</a> to scan the QR code.</p>');
});

app.listen(3000, () => {
  console.log('🌐 Express server running at http://localhost:3000');
});

// ---------------------------
// Initialize WhatsApp Client
// ---------------------------
client.initialize();
