require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');
const express = require('express');

/**
 * =============================
 * CONFIGURATION & GLOBALS
 * =============================
 */
const ADMIN_NUMBER = process.env.ADMIN_NUMBER || '254700000000'; 
let PAYMENT_INFO = '0701339573 (Camlus)'; // M-Pesa details, admin can change via WhatsApp

// Generate unique order IDs
function generateOrderID() {
  return `FY'S-${Math.floor(100000 + Math.random() * 900000)}`;
}

// Validate Safaricom format
function isSafaricomNumber(num) {
  return /^0[71]\d{8}$/.test(num) || /^01\d{8}$/.test(num);
}

// -----------------------------
// PACKAGES (Airtime, Data, SMS)
// -----------------------------

// Airtime: We'll let user type the exact amount (no fixed packages).
// Data => Hourly, Daily, Weekly, Monthly
const dataPackages = {
  hourly: [
    { id: 1, name: '1GB', price: 19, validity: '1 hour' },
    { id: 2, name: '1.5GB', price: 49, validity: '3 hours' },
  ],
  daily: [
    { id: 1, name: '1.25GB', price: 55, validity: 'Till midnight' },
    { id: 2, name: '1GB', price: 99, validity: '24 hours' },
    { id: 3, name: '250MB', price: 20, validity: '24 hours' },
  ],
  weekly: [
    { id: 1, name: '6GB', price: 700, validity: '7 days' },
    { id: 2, name: '2.5GB', price: 300, validity: '7 days' },
    { id: 3, name: '350MB', price: 50, validity: '7 days' },
  ],
  monthly: [
    { id: 1, name: '1.2GB', price: 250, validity: '30 days' },
    { id: 2, name: '500MB', price: 100, validity: '30 days' },
  ],
};

// SMS => Daily, Weekly, Monthly
const smsPackages = {
  daily: [
    { id: 1, name: '200 SMS', price: 10, validity: '1 day' },
  ],
  weekly: [
    { id: 1, name: '1000 SMS', price: 29, validity: '7 days' },
  ],
  monthly: [
    { id: 1, name: '2000 SMS', price: 99, validity: '30 days' },
  ],
};

// Orders stored in memory (keys = orderID)
const orders = {};

// Minimal user session
const session = {}; // e.g. { "2547XXX@c.us": { step: "...", data: ... } }

/**
 * =============================
 * WHATSAPP CLIENT
 * =============================
 */
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: { headless: true },
});

let qrImageUrl = null; // data URL for web-based QR

// Generate QR in terminal + store for Express
client.on('qr', (qr) => {
  console.log('Scan this QR code to link your WhatsApp:');
  qrcodeTerminal.generate(qr, { small: true });
  QRCode.toDataURL(qr, (err, url) => {
    if (!err) qrImageUrl = url;
  });
});

// When the bot is ready
client.on('ready', async () => {
  console.log('✅ Bot is online and ready!');

  // Send a welcome message to admin if desired
  client.sendMessage(`${ADMIN_NUMBER}@c.us`, `🎉 Hello Admin! Your bot is now online. Type "menu" to see user flow or try admin commands (e.g., set payment, add data, etc.).`);
});

/**
 * =============================
 * ADMIN COMMANDS
 * =============================
 * Admin can:
 * 1) update <ORDER_ID> <STATUS>
 * 2) set payment <mpesa_number> <name in quotes>
 * 3) add data <hourly/daily/weekly/monthly> "<name>" <price> "<validity>"
 * 4) remove data <hourly/daily/weekly/monthly> <id>
 * 5) edit data <hourly/daily/weekly/monthly> <id> <newprice>
 * (similar for sms => add sms <daily/weekly/monthly> ...)
 */
function parseQuotedString(parts, fromIndex) {
  // Joins everything from fromIndex and tries to parse "quoted" segments
  // e.g. ["add","data","daily","\"250MB\"","20","\"24 hours\""]
  // becomes name="250MB", price=20, validity="24 hours"
  let final = [];
  let current = [];
  let inQuotes = false;

  for (let i = fromIndex; i < parts.length; i++) {
    let p = parts[i];
    if (p.startsWith('"') && !p.endsWith('"')) {
      // start quotes
      inQuotes = true;
      current.push(p.substring(1)); // remove first quote
    } else if (p.endsWith('"') && inQuotes) {
      // end quotes
      inQuotes = false;
      current.push(p.slice(0, -1)); // remove last quote
      final.push(current.join(' '));
      current = [];
    } else if (inQuotes) {
      // middle of quoted text
      current.push(p);
    } else if (p.startsWith('"') && p.endsWith('"')) {
      // single-word quoted
      final.push(p.slice(1, -1));
    } else {
      // unquoted
      final.push(p);
    }
  }
  return final;
}

client.on('message', async (msg) => {
  const sender = msg.from; // e.g. "2547XXXX@c.us"
  const body = msg.body.trim();

  // -------------- ADMIN COMMANDS --------------
  if (sender === `${ADMIN_NUMBER}@c.us`) {
    const lower = body.toLowerCase();

    // 1) update ORDER_ID STATUS
    if (lower.startsWith('update ')) {
      // e.g. "update FY'S-123456 completed"
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

      // Notify user
      const userNumber = orders[orderID].customer;
      let extra = '';
      switch (newStatus) {
        case 'CONFIRMED': extra = '✅ Payment confirmed! Processing your order soon.'; break;
        case 'COMPLETED': extra = '🎉 Your order is complete! Enjoy.'; break;
        case 'CANCELLED': extra = '🚫 Your order was cancelled. Contact support if needed.'; break;
        case 'REFUNDED': extra = '💰 Your order was refunded. Check your M-Pesa balance.'; break;
        default: extra = '';
      }
      client.sendMessage(userNumber, `🔔 *Order Update*\nOrder *${orderID}* => *${newStatus}*\n${extra}`);
      return client.sendMessage(sender, `✅ Updated ${orderID} to ${newStatus}.`);
    }

    // 2) set payment <mpesa_number> <name in quotes>
    // e.g. "set payment 0712345678 "Camlus 2.0""
    if (lower.startsWith('set payment ')) {
      const parts = parseQuotedString(msg.body.split(' '), 2); 
      // parts might be like ["0712345678", "Camlus 2.0"]
      if (parts.length < 2) {
        return client.sendMessage(sender, '❌ Usage: set payment <mpesa_number> "<name>"');
      }
      const mpesaNum = parts[0];
      const name = parts[1];
      PAYMENT_INFO = `${mpesaNum} (${name})`;
      return client.sendMessage(sender, `✅ Payment info updated to: ${PAYMENT_INFO}`);
    }

    // 3) add data or sms
    // e.g. "add data daily "250MB" 20 "24 hours""
    // or   "add sms weekly "500 SMS" 50 "7 days""
    if (lower.startsWith('add data ') || lower.startsWith('add sms ')) {
      // parse: "add data daily "250MB" 20 "24 hours""
      // parts => ["add","data","daily","\"250MB\"","20","\"24","hours\""] => we parse carefully
      const splitted = msg.body.split(' ');
      // splitted[0] = "add"
      // splitted[1] = "data" or "sms"
      // splitted[2] = "daily"/"hourly"/...
      const type = splitted[1].toLowerCase(); // "data" or "sms"
      const category = splitted[2].toLowerCase();

      // parse the rest
      // we expect: "<name>" <price> "<validity>"
      const rest = parseQuotedString(splitted, 3); 
      // e.g. ["250MB", "20", "24 hours"]

      if (rest.length < 3) {
        return client.sendMessage(sender, `❌ Usage: add ${type} <category> "<name>" <price> "<validity>"`);
      }
      const name = rest[0];
      const price = Number(rest[1]);
      const validity = rest[2];

      if (isNaN(price)) {
        return client.sendMessage(sender, '❌ Invalid price. Must be a number.');
      }

      // Add to dataPackages[category] or smsPackages[category]
      let target;
      if (type === 'data') {
        if (!dataPackages[category]) {
          return client.sendMessage(sender, `❌ Invalid data category: ${category}`);
        }
        const arr = dataPackages[category];
        const newId = arr.length > 0 ? arr[arr.length - 1].id + 1 : 1;
        arr.push({ id: newId, name, price, validity });
        return client.sendMessage(sender, `✅ Added new data package: [${newId}] ${name} @ KES ${price} (${validity}) to ${category}.`);
      } else {
        // sms
        if (!smsPackages[category]) {
          return client.sendMessage(sender, `❌ Invalid sms category: ${category}`);
        }
        const arr = smsPackages[category];
        const newId = arr.length > 0 ? arr[arr.length - 1].id + 1 : 1;
        arr.push({ id: newId, name, price, validity });
        return client.sendMessage(sender, `✅ Added new SMS package: [${newId}] ${name} @ KES ${price} (${validity}) to ${category}.`);
      }
    }

    // 4) remove data or sms
    // e.g. "remove data daily 2"
    // e.g. "remove sms weekly 1"
    if (lower.startsWith('remove data ') || lower.startsWith('remove sms ')) {
      const splitted = msg.body.split(' ');
      // splitted => ["remove","data","daily","2"]
      if (splitted.length < 4) {
        return client.sendMessage(sender, '❌ Usage: remove data|sms <category> <id>');
      }
      const type = splitted[1].toLowerCase(); // data or sms
      const category = splitted[2].toLowerCase();
      const idToRemove = Number(splitted[3]);

      if (isNaN(idToRemove)) {
        return client.sendMessage(sender, '❌ Invalid ID. Must be a number.');
      }

      if (type === 'data') {
        if (!dataPackages[category]) {
          return client.sendMessage(sender, `❌ Invalid data category: ${category}`);
        }
        const arr = dataPackages[category];
        const idx = arr.findIndex(p => p.id === idToRemove);
        if (idx === -1) {
          return client.sendMessage(sender, `❌ No package with ID ${idToRemove} in ${category}.`);
        }
        arr.splice(idx, 1);
        return client.sendMessage(sender, `✅ Removed data package ID ${idToRemove} from ${category}.`);
      } else {
        // sms
        if (!smsPackages[category]) {
          return client.sendMessage(sender, `❌ Invalid sms category: ${category}`);
        }
        const arr = smsPackages[category];
        const idx = arr.findIndex(p => p.id === idToRemove);
        if (idx === -1) {
          return client.sendMessage(sender, `❌ No SMS package with ID ${idToRemove} in ${category}.`);
        }
        arr.splice(idx, 1);
        return client.sendMessage(sender, `✅ Removed SMS package ID ${idToRemove} from ${category}.`);
      }
    }

    // 5) edit data or sms
    // e.g. "edit data daily 2 120" => changes price of ID=2 to 120
    if (lower.startsWith('edit data ') || lower.startsWith('edit sms ')) {
      const splitted = msg.body.split(' ');
      // splitted => ["edit","data","daily","2","120"]
      if (splitted.length < 5) {
        return client.sendMessage(sender, '❌ Usage: edit data|sms <category> <id> <newprice>');
      }
      const type = splitted[1].toLowerCase();
      const category = splitted[2].toLowerCase();
      const idToEdit = Number(splitted[3]);
      const newPrice = Number(splitted[4]);

      if (isNaN(idToEdit) || isNaN(newPrice)) {
        return client.sendMessage(sender, '❌ Invalid ID or price. Must be numbers.');
      }

      if (type === 'data') {
        if (!dataPackages[category]) {
          return client.sendMessage(sender, `❌ Invalid data category: ${category}`);
        }
        const arr = dataPackages[category];
        const pack = arr.find(p => p.id === idToEdit);
        if (!pack) {
          return client.sendMessage(sender, `❌ No data package with ID ${idToEdit} in ${category}.`);
        }
        pack.price = newPrice;
        return client.sendMessage(sender, `✅ Updated data package [${idToEdit}] to price KES ${newPrice}.`);
      } else {
        if (!smsPackages[category]) {
          return client.sendMessage(sender, `❌ Invalid sms category: ${category}`);
        }
        const arr = smsPackages[category];
        const pack = arr.find(p => p.id === idToEdit);
        if (!pack) {
          return client.sendMessage(sender, `❌ No SMS package with ID ${idToEdit} in ${category}.`);
        }
        pack.price = newPrice;
        return client.sendMessage(sender, `✅ Updated SMS package [${idToEdit}] to price KES ${newPrice}.`);
      }
    }
  } // END ADMIN COMMANDS

  // -------------- USER FLOW --------------
  const lower = body.toLowerCase();

  // "menu" or "start"
  if (lower === 'menu' || lower === 'start') {
    session[sender] = { step: 'main' };
    const welcomeMsg = `🌟 *Welcome to FY'S ULTRA BOT!* 🌟\n\n` +
      `I can help you purchase *Airtime, Data bundles, or SMS bundles*.\n` +
      `Please choose an option (type the number):\n\n` +
      `1️⃣ Airtime\n` +
      `2️⃣ Data Bundles\n` +
      `3️⃣ SMS Bundles\n\n` +
      `You can also check an order status with: status <ORDER_ID>\n` +
      `Or confirm payment with: PAID <ORDER_ID>\n`;
    return client.sendMessage(sender, welcomeMsg);
  }

  // If user is at main step
  if (session[sender]?.step === 'main') {
    if (lower === '1') {
      // Airtime
      session[sender].step = 'airtime';
      return client.sendMessage(sender, '💳 *Airtime Purchase*\n\nEnter the amount of airtime (e.g. "50" for KES 50).');
    } else if (lower === '2') {
      // Data
      session[sender].step = 'data-category';
      return client.sendMessage(sender,
        `📶 *Data Bundles*\nChoose a subcategory:\n` +
        `1) Hourly\n2) Daily\n3) Weekly\n4) Monthly\n(Type 1,2,3, or 4)`
      );
    } else if (lower === '3') {
      // SMS
      session[sender].step = 'sms-category';
      return client.sendMessage(sender,
        `✉️ *SMS Bundles*\nChoose a subcategory:\n` +
        `1) Daily\n2) Weekly\n3) Monthly\n(Type 1,2, or 3)`
      );
    } else {
      return client.sendMessage(sender, '❌ Invalid choice. Type "menu" to restart.');
    }
  }

  // ---------------------------
  // AIRTIME FLOW
  // ---------------------------
  if (session[sender]?.step === 'airtime') {
    // user typed an amount?
    const amt = Number(body);
    if (isNaN(amt) || amt <= 0) {
      return client.sendMessage(sender, '❌ Invalid amount. Please enter a positive number (e.g. "50").');
    }
    // Create an order
    const orderID = generateOrderID();
    orders[orderID] = {
      orderID,
      customer: sender,
      package: `Airtime (KES ${amt})`,
      amount: amt,
      recipient: null,
      payment: null,
      status: 'PENDING',
      timestamp: new Date().toISOString(),
    };
    delete session[sender];
    return client.sendMessage(sender,
      `🛒 *Order Created!*\n\n` +
      `🆔 Order ID: *${orderID}*\n` +
      `📦 Package: Airtime (KES ${amt})\n` +
      `💰 Price: KES ${amt}\n\n` +
      `👉 Please enter the *recipient phone number* (07XXXXXXXX).`
    );
  }

  // ---------------------------
  // DATA FLOW
  // ---------------------------
  if (session[sender]?.step === 'data-category') {
    if (!['1','2','3','4'].includes(lower)) {
      return client.sendMessage(sender, '❌ Invalid subcategory. Type 1,2,3, or 4.');
    }
    let cat = '';
    if (lower === '1') cat = 'hourly';
    else if (lower === '2') cat = 'daily';
    else if (lower === '3') cat = 'weekly';
    else if (lower === '4') cat = 'monthly';

    session[sender].dataCat = cat;
    session[sender].step = 'data-list';

    // Show packages
    let listMsg = `✅ *${cat.toUpperCase()} Data Bundles:*\n`;
    dataPackages[cat].forEach((p) => {
      listMsg += `[${p.id}] ${p.name} @ KES ${p.price} (${p.validity})\n`;
    });
    listMsg += `\nType the package ID to buy (e.g. "1").`;
    return client.sendMessage(sender, listMsg);
  }

  if (session[sender]?.step === 'data-list') {
    const cat = session[sender].dataCat;
    const pkgId = Number(body);
    if (isNaN(pkgId)) {
      return client.sendMessage(sender, '❌ Invalid ID. Type a number (e.g. "1").');
    }
    const selected = dataPackages[cat].find(p => p.id === pkgId);
    if (!selected) {
      return client.sendMessage(sender, '❌ No package with that ID. Type "menu" to restart.');
    }

    // Create order
    const orderID = generateOrderID();
    orders[orderID] = {
      orderID,
      customer: sender,
      package: `${selected.name} (${cat})`,
      amount: selected.price,
      recipient: null,
      payment: null,
      status: 'PENDING',
      timestamp: new Date().toISOString(),
    };

    // Clear session
    delete session[sender];

    return client.sendMessage(sender,
      `🛒 *Order Created!*\n\n` +
      `🆔 Order ID: *${orderID}*\n` +
      `📦 Package: ${selected.name} (${cat})\n` +
      `💰 Price: KES ${selected.price}\n\n` +
      `👉 Please enter the *recipient phone number* (07XXXXXXXX).`
    );
  }

  // ---------------------------
  // SMS FLOW
  // ---------------------------
  if (session[sender]?.step === 'sms-category') {
    if (!['1','2','3'].includes(lower)) {
      return client.sendMessage(sender, '❌ Invalid subcategory. Type 1,2, or 3.');
    }
    let cat = '';
    if (lower === '1') cat = 'daily';
    else if (lower === '2') cat = 'weekly';
    else if (lower === '3') cat = 'monthly';

    session[sender].smsCat = cat;
    session[sender].step = 'sms-list';

    // Show packages
    let listMsg = `✅ *${cat.toUpperCase()} SMS Bundles:*\n`;
    smsPackages[cat].forEach((p) => {
      listMsg += `[${p.id}] ${p.name} @ KES ${p.price} (${p.validity})\n`;
    });
    listMsg += `\nType the package ID to buy (e.g. "1").`;
    return client.sendMessage(sender, listMsg);
  }

  if (session[sender]?.step === 'sms-list') {
    const cat = session[sender].smsCat;
    const pkgId = Number(body);
    if (isNaN(pkgId)) {
      return client.sendMessage(sender, '❌ Invalid ID. Type a number (e.g. "1").');
    }
    const selected = smsPackages[cat].find(p => p.id === pkgId);
    if (!selected) {
      return client.sendMessage(sender, '❌ No package with that ID. Type "menu" to restart.');
    }

    // Create order
    const orderID = generateOrderID();
    orders[orderID] = {
      orderID,
      customer: sender,
      package: `${selected.name} (SMS - ${cat})`,
      amount: selected.price,
      recipient: null,
      payment: null,
      status: 'PENDING',
      timestamp: new Date().toISOString(),
    };

    // Clear session
    delete session[sender];

    return client.sendMessage(sender,
      `🛒 *Order Created!*\n\n` +
      `🆔 Order ID: *${orderID}*\n` +
      `📦 Package: ${selected.name} (SMS - ${cat})\n` +
      `💰 Price: KES ${selected.price}\n\n` +
      `👉 Please enter the *recipient phone number* (07XXXXXXXX).`
    );
  }

  // ---------------------------
  // CAPTURE RECIPIENT
  // ---------------------------
  const needingRecip = Object.values(orders).find(o => o.customer === sender && o.recipient === null);
  if (needingRecip) {
    // Validate phone
    if (!isSafaricomNumber(body)) {
      return client.sendMessage(sender, '❌ Invalid phone. Must be 07XXXXXXXX or 01XXXXXXXX.');
    }
    needingRecip.recipient = body;
    return client.sendMessage(sender, `✅ Recipient set to ${body}.\nNow enter your *payment number* (Safaricom).`);
  }

  // ---------------------------
  // CAPTURE PAYMENT
  // ---------------------------
  const needingPay = Object.values(orders).find(o => o.customer === sender && o.recipient && o.payment === null);
  if (needingPay) {
    if (!isSafaricomNumber(body)) {
      return client.sendMessage(sender, '❌ Invalid payment number. Must be 07XXXXXXXX or 01XXXXXXXX.');
    }
    needingPay.payment = body;

    // Summarize
    const order = needingPay;
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
      `update ${order.orderID} CANCELLED\n\n` +
      `Or change payment details with: set payment <mpesa> "Name"`
    );
    return;
  }

  // ---------------------------
  // PAID <ORDER_ID>
  // ---------------------------
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
    client.sendMessage(sender, `✅ Payment noted! Your order *${orderID}* is now *CONFIRMED*.\nWe’ll process it shortly.`);
    client.sendMessage(`${ADMIN_NUMBER}@c.us`, `🔔 Order *${orderID}* marked as CONFIRMED by the user.`);
    return;
  }

  // ---------------------------
  // STATUS <ORDER_ID>
  // ---------------------------
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
      `🆔 ${o.orderID}\n` +
      `📦 ${o.package}\n` +
      `💰 KSH ${o.amount}\n` +
      `📞 Recipient: ${o.recipient}\n` +
      `📱 Payment: ${o.payment}\n` +
      `📌 Status: *${o.status}*`
    );
  }

  // ---------------------------
  // FALLBACK
  // ---------------------------
  client.sendMessage(sender,
    `🤖 *FY'S ULTRA BOT*\n` +
    `Type "menu" to see the main menu.\n` +
    `Or "status <ORDERID>" to check an order.\n` +
    `Or "PAID <ORDERID>" after paying.\n`
  );
});

/**
 * =============================
 * EXPRESS SERVER FOR WEB QR
 * =============================
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

app.listen(3000, () => {
  console.log('🌐 Express server running at http://localhost:3000');
});

/**
 * Initialize the WhatsApp client
 */
client.initialize();
