/**
 * Minimal WhatsApp Buying Bot
 * 
 * 1) npm install whatsapp-web.js qrcode-terminal dotenv
 * 2) Create .env with ADMIN_NUMBER (e.g. ADMIN_NUMBER=254701339573)
 * 3) node bot.js
 * 4) Scan the QR code in your terminal with WhatsApp
 */

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
require('dotenv').config();

// --- Configuration ---
const ADMIN_NUMBER = process.env.ADMIN_NUMBER || '+254701339573'; // Must match the format used by whatsapp-web.js

// --- Data Bundles ---
const dataBundles = {
  daily: [
    { id: 1, name: '1.25GB', price: 55, validity: 'Till Midnight' },
    { id: 2, name: '1GB', price: 99, validity: '24 Hours' },
    { id: 3, name: '250MB', price: 20, validity: '24 Hours' },
  ],
  hourly: [
    { id: 1, name: '1GB', price: 19, validity: '1 Hour' },
    { id: 2, name: '1.5GB', price: 49, validity: '3 Hours' },
  ],
  weekly: [
    { id: 1, name: '6GB', price: 700, validity: '7 Days' },
    { id: 2, name: '2.5GB', price: 300, validity: '7 Days' },
    { id: 3, name: '350MB', price: 50, validity: '7 Days' },
  ],
  monthly: [
    { id: 1, name: '1.2GB', price: 250, validity: '30 Days' },
    { id: 2, name: '500MB', price: 100, validity: '30 Days' },
  ],
};

// --- Orders stored in memory (object). Keys = orderID ---
let orders = {};

// --- Generate Unique Order ID ---
function generateOrderID() {
  return "FY'S-" + Math.floor(100000 + Math.random() * 900000);
}

// --- WhatsApp Client Setup ---
const client = new Client({
  authStrategy: new LocalAuth(),  // stores session data locally
  puppeteer: { headless: true }
});

// --- QR Code Event ---
client.on('qr', qr => {
  console.log('Scan this QR code with your WhatsApp:');
  qrcode.generate(qr, { small: true });
});

// --- Ready Event ---
client.on('ready', () => {
  console.log('✅ Bot is online and ready to receive messages!');
});

// --- Handle Incoming Messages ---
client.on('message', async msg => {
  const sender = msg.from;      // e.g. '254712345678@c.us'
  const body = msg.body.trim().toLowerCase();

  // -------------------------
  // ADMIN COMMANDS
  // -------------------------
  if (sender === ADMIN_NUMBER) {
    // Update order status: "update FY'S-123456 confirmed"
    if (body.startsWith('update ')) {
      const parts = msg.body.split(' ');
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

      // Notify user about the update
      let extraMsg = '';
      if (newStatus === 'CONFIRMED') extraMsg = '✅ We have confirmed your payment and will process your bundle soon.';
      else if (newStatus === 'COMPLETED') extraMsg = '🎉 Your order is completed! Enjoy your data bundle.';
      else if (newStatus === 'CANCELLED') extraMsg = '🚫 Your order was cancelled. Contact support if you have questions.';
      else if (newStatus === 'REFUNDED') extraMsg = '💰 Your order was refunded. Check your M-Pesa balance.';

      client.sendMessage(user, `🔔 *Order Update*\nYour order *${orderID}* status is now: *${newStatus}*\n${extraMsg}`);
      return client.sendMessage(sender, `✅ Updated *${orderID}* to *${newStatus}*.`);
    }
  }

  // -------------------------
  // USER COMMANDS
  // -------------------------
  // Start or Menu
  if (body === 'start' || body === 'menu') {
    const menuMsg = `🎉 *Welcome to FY'S Buying Bot!* 🎉\n\n` +
                    `Select what you'd like to do:\n` +
                    `1️⃣ Buy Data Bundles\n` +
                    `2️⃣ (Coming soon) Buy Airtime\n` +
                    `3️⃣ (Coming soon) Buy SMS\n\n` +
                    `Reply with the number (e.g. "1") to proceed.`;
    return client.sendMessage(sender, menuMsg);
  }

  // If user typed "1" -> Data Bundles
  if (body === '1') {
    const dataMsg = `📊 *Data Bundles*\n\n` +
                    `- "hourly"  : Hourly Bundles\n` +
                    `- "daily"   : Daily Bundles\n` +
                    `- "weekly"  : Weekly Bundles\n` +
                    `- "monthly" : Monthly Bundles\n\n` +
                    `Type the one you want, e.g. "daily" or "monthly".`;
    return client.sendMessage(sender, dataMsg);
  }

  // If user typed one of these: "hourly", "daily", "weekly", "monthly"
  if (['hourly', 'daily', 'weekly', 'monthly'].includes(body)) {
    const chosen = dataBundles[body];
    if (!chosen) {
      return client.sendMessage(sender, '❌ Invalid category. Type "hourly", "daily", "weekly", or "monthly".');
    }
    let bundleList = `✅ *${body.toUpperCase()} BUNDLES:*\n\n`;
    chosen.forEach(b => {
      bundleList += `• ${b.id}. ${b.name} @ KSH ${b.price} (Valid for ${b.validity})\n`;
    });
    bundleList += `\nType the bundle number (e.g. "1") to choose.`;
    // Store the user's current selection in a "session"
    orders[sender] = { step: 'select_bundle', category: body };
    return client.sendMessage(sender, bundleList);
  }

  // If user is in step "select_bundle" and typed a number
  if (orders[sender]?.step === 'select_bundle') {
    const category = orders[sender].category;
    const chosenBundle = dataBundles[category].find(b => b.id === Number(body));
    if (!chosenBundle) {
      return client.sendMessage(sender, '❌ Invalid bundle number. Please try again.');
    }

    // Create a new order ID
    const orderID = generateOrderID();
    orders[orderID] = {
      orderID,
      customer: sender,
      package: `${chosenBundle.name} (${category})`,
      amount: chosenBundle.price,
      recipient: null,
      payment: null,
      status: 'PENDING',
      timestamp: new Date().toISOString()
    };

    // Clear the user's "session"
    delete orders[sender];

    // Prompt for recipient
    return client.sendMessage(sender,
      `🛒 *Order Created!* 🛒\n\n` +
      `🆔 Order ID: *${orderID}*\n` +
      `📦 Package: *${chosenBundle.name}* (${category})\n` +
      `💰 Price: *KSH ${chosenBundle.price}*\n\n` +
      `👉 Please enter the *recipient number* (Safaricom only, e.g. 07XXXXXXXX):`
    );
  }

  // If user typed a Safaricom number (07XXXXXXXX or 01XXXXXXXX) & we find an order with no recipient
  if (/^0[71]\d{8}$/.test(body)) {
    // Find an order with PENDING recipient
    const pendingOrder = Object.values(orders).find(o => o.customer === sender && o.recipient === null);
    if (pendingOrder) {
      pendingOrder.recipient = body;
      return client.sendMessage(sender,
        `✅ Recipient set to *${body}*.\n` +
        `Please enter your *payment number* (Safaricom), e.g. 07XXXXXXXX:`
      );
    }

    // If user typed a Safaricom number but there's no pending order
    const noOrderMsg = `❌ No pending order found. Type "start" to begin.`;
    return client.sendMessage(sender, noOrderMsg);
  }

  // If user typed a Safaricom number for payment & there's an order with no payment set
  if (/^0[71]\d{8}$/.test(body)) {
    const pendingOrder = Object.values(orders).find(o => o.customer === sender && o.recipient && o.payment === null);
    if (pendingOrder) {
      pendingOrder.payment = body;
      // Summarize the order
      const summary = `🎉 *Order Summary* 🎉\n\n` +
                      `🆔 Order ID: *${pendingOrder.orderID}*\n` +
                      `📦 Package: *${pendingOrder.package}*\n` +
                      `💰 Amount: *KSH ${pendingOrder.amount}*\n` +
                      `📞 Recipient: *${pendingOrder.recipient}*\n` +
                      `📱 Payment Number: *${pendingOrder.payment}*\n\n` +
                      `👉 *Send KSH ${pendingOrder.amount} to 0701339573 (Camlus)*\n` +
                      `Then reply: *PAID ${pendingOrder.orderID}* when done.`;
      client.sendMessage(sender, summary);

      // Notify admin
      const adminMsg = `🔔 *New Order!* 🔔\n\n` +
                       `🆔 Order: ${pendingOrder.orderID}\n` +
                       `📦 Package: ${pendingOrder.package}\n` +
                       `💰 Amount: KSH ${pendingOrder.amount}\n` +
                       `📞 Recipient: ${pendingOrder.recipient}\n` +
                       `📱 Payment: ${pendingOrder.payment}\n` +
                       `👤 User: ${sender}\n\n` +
                       `*Admin Commands:* \n` +
                       `update ${pendingOrder.orderID} CONFIRMED\n` +
                       `update ${pendingOrder.orderID} COMPLETED\n` +
                       `update ${pendingOrder.orderID} REFUNDED\n` +
                       `update ${pendingOrder.orderID} CANCELLED\n`;
      client.sendMessage(ADMIN_NUMBER, adminMsg);
      return;
    }
  }

  // If user types "PAID <ORDERID>"
  if (body.startsWith('paid ')) {
    const parts = body.split(' ');
    const orderID = parts[1];
    if (!orders[orderID]) {
      return client.sendMessage(sender, `❌ Order ${orderID} not found.`);
    }
    // Mark as "CONFIRMED"
    orders[orderID].status = 'CONFIRMED';
    client.sendMessage(sender, `✅ Payment confirmed! Your order *${orderID}* will be processed shortly.`);
    client.sendMessage(ADMIN_NUMBER, `🔔 Order *${orderID}* has been marked as CONFIRMED by the user.`);
    return;
  }

  // If user types "status <ORDERID>"
  if (body.startsWith('status ')) {
    const orderID = body.split(' ')[1];
    if (!orders[orderID]) {
      return client.sendMessage(sender, `❌ Order ${orderID} not found.`);
    }
    const o = orders[orderID];
    return client.sendMessage(sender,
      `📦 *Order Status*\n\n` +
      `🆔 *${orderID}*\n` +
      `📦 Package: ${o.package}\n` +
      `💰 Amount: KSH ${o.amount}\n` +
      `📞 Recipient: ${o.recipient}\n` +
      `📱 Payment: ${o.payment}\n` +
      `📌 Status: *${o.status}*\n`
    );
  }

  // Fallback / Help
  if (!body.startsWith('update ') && !body.startsWith('paid ') && !body.startsWith('status ')) {
    client.sendMessage(sender,
      `🤖 *FY'S Buying Bot*\n\n` +
      `Type *start* or *menu* to see the main menu.\n` +
      `To check an order, type: *status <ORDERID>*\n` +
      `If you've paid, type: *PAID <ORDERID>*`
    );
  }
});

// --- Initialize the client ---
client.initialize();
