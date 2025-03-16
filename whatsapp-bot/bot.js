require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');
const express = require('express');

/**
 * Configuration
 */
const ADMIN_NUMBER = process.env.ADMIN_NUMBER || '254700000000'; 
const PAYMENT_INFO = '0701339573 (Camlus)'; // M-Pesa details
const PORT = 3000; // Express server port

// In-memory store for orders (keys = order IDs)
const orders = {};

/**
 * Generate a unique order ID
 */
function generateOrderID() {
  return `FY'S-${Math.floor(100000 + Math.random() * 900000)}`;
}

/**
 * Validate Safaricom phone format (07xxxxxxx or 01xxxxxxx)
 */
function isSafaricomNumber(num) {
  return /^0[71]\d{8}$/.test(num) || /^01\d{8}$/.test(num);
}

/**
 * Data & SMS Bundles (single-digit flow)
 */
const dataBundles = {
  1: { name: 'Hourly: 1GB', price: 19, validity: '1 Hour' },
  2: { name: 'Hourly: 1.5GB', price: 49, validity: '3 Hours' },
  3: { name: 'Daily: 1.25GB', price: 55, validity: 'Till Midnight' },
  4: { name: 'Daily: 1GB', price: 99, validity: '24 Hours' },
  5: { name: 'Daily: 250MB', price: 20, validity: '24 Hours' },
  6: { name: 'Weekly: 6GB', price: 700, validity: '7 Days' },
  7: { name: 'Weekly: 2.5GB', price: 300, validity: '7 Days' },
  8: { name: 'Weekly: 350MB', price: 50, validity: '7 Days' },
  9: { name: 'Monthly: 1.2GB', price: 250, validity: '30 Days' },
  10: { name: 'Monthly: 500MB', price: 100, validity: '30 Days' },
};

const smsBundles = {
  1: { name: '200 SMS', price: 10, validity: 'Daily' },
  2: { name: '1000 SMS', price: 29, validity: 'Weekly' },
};

// Minimal user session data
const session = {}; // { userNumber: { step: '...', selectedBundle: {...} } }

/**
 * WhatsApp Client Setup
 */
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: { headless: true },
});

let qrImageUrl = null; // Will store the QR code as a data URL

client.on('qr', (qr) => {
  // Print in terminal
  console.log('Scan the QR code below to link your WhatsApp:');
  qrcodeTerminal.generate(qr, { small: true });
  // Also store as data URL for the webpage
  QRCode.toDataURL(qr, (err, url) => {
    if (!err) qrImageUrl = url;
  });
});

client.on('ready', () => {
  console.log('✅ Bot is online and ready to serve!');
});

/**
 * Handle Incoming Messages
 */
client.on('message', async (message) => {
  const sender = message.from; // e.g. '2547XXXXXXXX@c.us'
  const text = message.body.trim().toLowerCase();

  // --- ADMIN COMMANDS (only from admin) ---
  if (sender === `${ADMIN_NUMBER}@c.us`) {
    // Update order status: "update FY'S-123456 COMPLETED"
    if (text.startsWith('update ')) {
      const parts = message.body.split(' ');
      if (parts.length < 3) {
        return client.sendMessage(sender, '❌ Usage: update <ORDER_ID> <STATUS>');
      }
      const orderID = parts[1];
      const newStatus = parts.slice(2).join(' ').toUpperCase();
      if (!orders[orderID]) {
        return client.sendMessage(sender, `❌ Order ${orderID} not found.`);
      }
      orders[orderID].status = newStatus;

      // Notify the user
      const userNumber = orders[orderID].customer; // e.g. '2547XXXX@c.us'
      let extra = '';
      if (newStatus === 'CONFIRMED') extra = '✅ Payment confirmed! Processing your bundle soon.';
      if (newStatus === 'COMPLETED') extra = '🎉 Your order is now complete. Enjoy!';
      if (newStatus === 'CANCELLED') extra = '🚫 Your order was cancelled. Contact support if needed.';
      if (newStatus === 'REFUNDED') extra = '💰 Your order was refunded. Check your M-Pesa balance.';

      client.sendMessage(userNumber, `🔔 *Order Update*\nYour order *${orderID}* is now *${newStatus}*.\n${extra}`);
      return client.sendMessage(sender, `✅ Updated *${orderID}* to *${newStatus}*.`);
    }
  }

  // --- USER FLOW ---
  // Start or Menu
  if (text === 'start' || text === 'menu') {
    session[sender] = { step: 'main' };
    const welcomeMsg = `🌟 *Hello and Welcome to FY'S ULTRA BOT!* 🌟\n\n` +
      `I'm here to help you purchase Data Bundles and SMS quickly and easily.\n\n` +
      `Main Menu:\n` +
      `1️⃣ Buy Data Bundles\n` +
      `2️⃣ Buy SMS Bundles\n\n` +
      `You can also check an order by typing: status <ORDER_ID>\n` +
      `Or confirm payment by typing: PAID <ORDER_ID>\n\n` +
      `*Reply with a number (1 or 2) to begin.*`;
    return client.sendMessage(sender, welcomeMsg);
  }

  // If user is at main menu
  if (session[sender]?.step === 'main') {
    if (text === '1') {
      // Show data bundles
      session[sender].step = 'data';
      let dataList = `📶 *DATA BUNDLES*\n\n`;
      Object.keys(dataBundles).forEach((k) => {
        dataList += `${k}) ${dataBundles[k].name} @ KES ${dataBundles[k].price} (Valid ${dataBundles[k].validity})\n`;
      });
      dataList += `\nReply with the *number* (e.g. "3") to select a bundle.`;
      return client.sendMessage(sender, dataList);
    } else if (text === '2') {
      // Show SMS bundles
      session[sender].step = 'sms';
      let smsList = `✉️ *SMS BUNDLES*\n\n`;
      Object.keys(smsBundles).forEach((k) => {
        smsList += `${k}) ${smsBundles[k].name} @ KES ${smsBundles[k].price} (${smsBundles[k].validity})\n`;
      });
      smsList += `\nReply with the *number* (e.g. "1") to select a bundle.`;
      return client.sendMessage(sender, smsList);
    } else {
      return client.sendMessage(sender, '❌ Invalid choice. Type "menu" to return.');
    }
  }

  // If user is picking a Data bundle
  if (session[sender]?.step === 'data') {
    const choice = Number(text);
    const selected = dataBundles[choice];
    if (!selected) {
      return client.sendMessage(sender, '❌ Invalid bundle number. Type "menu" to return.');
    }
    // Create order
    const orderID = generateOrderID();
    orders[orderID] = {
      orderID,
      customer: sender,
      package: selected.name,
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
      `🛒 *Order Created!*\n\n` +
      `🆔 Order ID: *${orderID}*\n` +
      `📦 Package: *${selected.name}*\n` +
      `💰 Price: *KSH ${selected.price}*\n\n` +
      `👉 Please enter the *recipient number* (Safaricom, e.g. 07XXXXXXXX):`
    );
  }

  // If user is picking an SMS bundle
  if (session[sender]?.step === 'sms') {
    const choice = Number(text);
    const selected = smsBundles[choice];
    if (!selected) {
      return client.sendMessage(sender, '❌ Invalid SMS bundle. Type "menu" to return.');
    }
    // Create order
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
      `🛒 *Order Created!*\n\n` +
      `🆔 Order ID: *${orderID}*\n` +
      `📦 Package: *${selected.name}* (${selected.validity})\n` +
      `💰 Price: *KSH ${selected.price}*\n\n` +
      `👉 Please enter the *recipient number* (Safaricom, e.g. 07XXXXXXXX):`
    );
  }

  // If there's an order needing a recipient
  const orderNeedingRecipient = Object.values(orders).find(o => o.customer === sender && !o.recipient);
  if (orderNeedingRecipient) {
    // Validate recipient
    if (!isSafaricomNumber(text)) {
      return client.sendMessage(sender, '❌ Invalid number. Must be Safaricom format (07xxxxxxx or 01xxxxxxx).');
    }
    orderNeedingRecipient.recipient = text;
    return client.sendMessage(sender, `✅ Recipient set to *${text}*.\nNow enter your *payment number* (Safaricom).`);
  }

  // If there's an order needing payment
  const orderNeedingPayment = Object.values(orders).find(o => o.customer === sender && o.recipient && !o.payment);
  if (orderNeedingPayment) {
    // Validate payment
    if (!isSafaricomNumber(text)) {
      return client.sendMessage(sender, '❌ Invalid payment number. Must be Safaricom format.');
    }
    orderNeedingPayment.payment = text;

    // Summarize
    const order = orderNeedingPayment;
    const summary = `🎉 *Order Summary* 🎉\n\n` +
      `🆔 Order ID: *${order.orderID}*\n` +
      `📦 Package: *${order.package}*\n` +
      `💰 Amount: *KSH ${order.amount}*\n` +
      `📞 Recipient: *${order.recipient}*\n` +
      `📱 Payment Number: *${order.payment}*\n` +
      `🕒 Time: ${new Date(order.timestamp).toLocaleString()}\n\n` +
      `👉 Please send *KSH ${order.amount}* to *${PAYMENT_INFO}*.\n` +
      `Then type: *PAID ${order.orderID}* when done.`;
    client.sendMessage(sender, summary);

    // Notify admin
    client.sendMessage(`${ADMIN_NUMBER}@c.us`,
      `🔔 *New Order* 🔔\n\n` +
      `🆔 ${order.orderID}\n` +
      `📦 ${order.package}\n` +
      `💰 KSH ${order.amount}\n` +
      `📞 Recipient: ${order.recipient}\n` +
      `📱 Payment: ${order.payment}\n` +
      `User: ${sender}\n\n` +
      `*Admin Commands:*\n` +
      `update ${order.orderID} CONFIRMED\n` +
      `update ${order.orderID} COMPLETED\n` +
      `update ${order.orderID} REFUNDED\n` +
      `update ${order.orderID} CANCELLED\n`
    );
    return;
  }

  // If user types "PAID <ORDERID>"
  if (text.startsWith('paid ')) {
    const parts = text.split(' ');
    if (parts.length !== 2) {
      return client.sendMessage(sender, '❌ Usage: PAID <ORDER_ID>');
    }
    const orderID = parts[1];
    if (!orders[orderID]) {
      return client.sendMessage(sender, `❌ Order ${orderID} not found.`);
    }
    orders[orderID].status = 'CONFIRMED';
    client.sendMessage(sender, `✅ Payment noted! Your order *${orderID}* is now *CONFIRMED*.\nWe’ll process it shortly.`);
    client.sendMessage(`${ADMIN_NUMBER}@c.us`, `🔔 Order *${orderID}* marked as CONFIRMED by the user.`);
    return;
  }

  // If user types "status <ORDERID>"
  if (text.startsWith('status ')) {
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
      `📌 Status: *${o.status}*`
    );
  }

  // Fallback message
  client.sendMessage(sender,
    `🤖 *FY'S ULTRA BOT*\n` +
    `Type "menu" to see the main menu.\n` +
    `Or "status <ORDERID>" to check an order.\n` +
    `Or "PAID <ORDERID>" after paying.`
  );
});

/**
 * Express Server to Show QR Code
 */
const app = express();

app.get('/', (req, res) => {
  res.send(`
    <html>
      <head><title>WhatsApp Bot</title></head>
      <body style="font-family: Arial; text-align: center;">
        <h1>Welcome to FY'S Ultra Bot</h1>
        <p>Visit <a href="/qr">/qr</a> to scan the QR code.</p>
      </body>
    </html>
  `);
});

app.get('/qr', (req, res) => {
  if (qrImageUrl) {
    res.send(`
      <html>
        <head><title>Scan QR</title></head>
        <body style="font-family: Arial; text-align: center;">
          <h1>Scan This QR Code with WhatsApp</h1>
          <img src="${qrImageUrl}" style="width:300px;height:300px" />
          <p>Open WhatsApp > Linked Devices > Link a device</p>
        </body>
      </html>
    `);
  } else {
    res.send(`<h1>QR Code not ready yet. Check console for updates.</h1>`);
  }
});

app.listen(PORT, () => {
  console.log(`🌐 Express server running at http://localhost:${PORT}`);
});

// Initialize the WhatsApp client
client.initialize();
