/**
 * WhatsApp Buying Bot
 * =====================
 * This bot lets users purchase data bundles (and, in the future, airtime/SMS)
 * with an easy interactive process. It auto-generates orders with a unique ID,
 * requests recipient and payment numbers (validated as Safaricom numbers), and
 * sends clear payment instructions.
 *
 * Admin (your number) can update order status, change payment details, and list orders by period.
 */

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
require('dotenv').config();

// -------------------------
// CONFIGURATION
// -------------------------
const ADMIN_NUMBER = process.env.ADMIN_NUMBER || "+254701339573"; // Admin WhatsApp number

// File to persist orders (JSON format)
const ordersFile = 'orders.json';
let orders = fs.existsSync(ordersFile) ? JSON.parse(fs.readFileSync(ordersFile)) : {};

// Save orders to the JSON file (for persistence)
const saveOrders = () => fs.writeFileSync(ordersFile, JSON.stringify(orders, null, 2));

// Generate a unique order ID: FY'S-XXXXXX
const generateOrderID = () => "FY'S-" + Math.floor(100000 + Math.random() * 900000);

// -------------------------
// PACKAGES & BUNDLES
// -------------------------
// For this example, we focus on Data Bundles. You can add airtime and SMS similarly.
const dataBundles = {
  "Hourly": [
    { id: 1, name: "1GB", price: 19, validity: "1 hour" },
    { id: 2, name: "1.5GB", price: 49, validity: "3 hours" }
  ],
  "Daily": [
    { id: 1, name: "1.25GB", price: 55, validity: "Till Midnight" },
    { id: 2, name: "1GB", price: 99, validity: "24 hours" },
    { id: 3, name: "250MB", price: 20, validity: "24 hours" }
  ],
  "Weekly": [
    { id: 1, name: "6GB", price: 700, validity: "7 days" },
    { id: 2, name: "2.5GB", price: 300, validity: "7 days" },
    { id: 3, name: "350MB", price: 50, validity: "7 days" }
  ],
  "Monthly": [
    { id: 1, name: "1.2GB", price: 250, validity: "30 days" },
    { id: 2, name: "500MB", price: 100, validity: "30 days" }
  ]
};

// -------------------------
// UTILITY FUNCTIONS
// -------------------------

/**
 * Filter orders by period.
 * @param {string} period - "today", "yesterday", "lastweek", or "lastmonth"
 * @returns {string} - A formatted string of matching orders.
 */
const getOrdersByPeriod = (period) => {
  const now = new Date();
  let filtered = [];

  Object.keys(orders).forEach(orderId => {
    const order = orders[orderId];
    const orderDate = new Date(order.timestamp);
    const diffTime = now - orderDate;
    const diffDays = diffTime / (1000 * 3600 * 24);

    if (period === "today" && now.toDateString() === orderDate.toDateString()) {
      filtered.push(order);
    } else if (period === "yesterday" && diffDays >= 1 && diffDays < 2) {
      filtered.push(order);
    } else if (period === "lastweek" && diffDays >= 7 && diffDays < 14) {
      filtered.push(order);
    } else if (period === "lastmonth" && diffDays >= 30 && diffDays < 60) {
      filtered.push(order);
    }
  });

  if (filtered.length === 0) return `😢 No orders found for ${period}.`;

  let response = `📜 *Orders for ${period}:*\n`;
  filtered.forEach(o => {
    response += `\n🆔 ${o.orderID}\n📦 Package: ${o.package}\n💰 Price: KSH ${o.amount}\n📞 Recipient: ${o.recipient}\n📱 Payment: ${o.payment}\n📌 Status: ${o.status}\n🕒 ${new Date(o.timestamp).toLocaleString()}\n--------------------`;
  });
  return response;
};

// -------------------------
// WHATSAPP CLIENT SETUP
// -------------------------
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: { headless: true }
});

// Generate and display QR code for authentication
client.on('qr', qr => {
  console.log("🔐 Scan the QR code below with your WhatsApp app to link the bot:");
  qrcode.generate(qr, { small: true });
});

// When the client is ready
client.on('ready', () => {
  console.log("✅ Bot is Online & Ready!");
});

// -------------------------
// INTERACTIVE BOT FLOW
// -------------------------
/**
 * User flow:
 * 1. User sends "start" to get the main menu.
 * 2. They choose a category (currently: Data Bundles only).
 * 3. They choose a validity period (Hourly, Daily, Weekly, Monthly).
 * 4. They choose a specific bundle.
 * 5. They enter recipient number.
 * 6. They enter payment number.
 * 7. Order is confirmed and payment instructions are given.
 */
client.on('message', async msg => {
  const sender = msg.from;
  const text = msg.body.trim().toLowerCase();

  // -------------------------
  // ADMIN COMMANDS (only admin can use these)
  // -------------------------
  if (sender === ADMIN_NUMBER) {
    // List orders by period: "orders today", "orders yesterday", "orders lastweek", "orders lastmonth"
    if (text.startsWith("orders ")) {
      const period = text.split(" ")[1];
      const ordersList = getOrdersByPeriod(period);
      return client.sendMessage(ADMIN_NUMBER, ordersList);
    }

    // Update order status: "update ORDERID NEWSTATUS"
    if (text.startsWith("update ")) {
      const parts = msg.body.trim().split(" ");
      if (parts.length < 3) {
        return client.sendMessage(ADMIN_NUMBER, "❌ Usage: update ORDERID NEWSTATUS");
      }
      const orderId = parts[1];
      const newStatus = parts.slice(2).join(" ").toUpperCase();
      if (orders[orderId]) {
        orders[orderId].status = newStatus;
        saveOrders();
        client.sendMessage(orders[orderId].customer, `🔔 *Order Update*\nYour order *${orderId}* has been updated to *${newStatus}*.\n${newStatus === "REFUNDED" ? "💰 Please check your M-Pesa balance." : newStatus === "CANCELLED" ? "🚫 The order has been cancelled. Contact support for assistance." : newStatus === "COMPLETED" ? "🎉 Your order has been completed. Thank you!" : "✅ Your order is now confirmed."}`);
        return client.sendMessage(ADMIN_NUMBER, `✅ Order *${orderId}* updated to *${newStatus}* successfully.`);
      } else {
        return client.sendMessage(ADMIN_NUMBER, `❌ Order *${orderId}* not found.`);
      }
    }

    // Update payment details: "update-payment ORDERID NEWPAYMENT"
    if (text.startsWith("update-payment ")) {
      const parts = msg.body.trim().split(" ");
      if (parts.length !== 3) {
        return client.sendMessage(ADMIN_NUMBER, "❌ Usage: update-payment ORDERID NEWPAYMENT");
      }
      const orderId = parts[1];
      const newPayment = parts[2];
      if (!/^0[71]\d{8}$/.test(newPayment)) {
        return client.sendMessage(ADMIN_NUMBER, "❌ Invalid payment number. Must start with 07 or 01 and be 10 digits.");
      }
      if (orders[orderId]) {
        orders[orderId].payment = newPayment;
        saveOrders();
        client.sendMessage(orders[orderId].customer, `🔔 Your payment details for order *${orderId}* have been updated to *${newPayment}*.`);
        return client.sendMessage(ADMIN_NUMBER, `✅ Payment details for order *${orderId}* updated successfully.`);
      } else {
        return client.sendMessage(ADMIN_NUMBER, `❌ Order *${orderId}* not found.`);
      }
    }
  }

  // -------------------------
  // USER INTERFACE
  // -------------------------
  if (text === "start" || text === "menu") {
    // Show main menu
    const menuMsg = `🎉 *Welcome to FY'S Buying Bot!* 🎉\n\nPlease choose an option by replying with the number:\n1️⃣ Buy Data Bundles\n2️⃣ Buy Airtime (Coming Soon)\n3️⃣ Buy SMS Bundles (Coming Soon)\n\nType *menu* anytime to see this message again.`;
    return client.sendMessage(sender, menuMsg);
  }

  // If user chooses "1" for Data Bundles
  if (text === "1") {
    const dataMenu = `📊 *Data Bundles Menu*\n\nChoose a validity period:\n1️⃣ Hourly Bundles\n2️⃣ Daily Bundles\n3️⃣ Weekly Bundles\n4️⃣ Monthly Bundles\n\nReply with the number (e.g., "1.1" for Hourly)`;
    return client.sendMessage(sender, dataMenu);
  }

  // User selects validity period and bundle option:
  // For Hourly, we'll use prefix "1.1", for Daily "1.2", Weekly "1.3", Monthly "1.4"
  if (text.startsWith("1.1") || text.startsWith("1.2") || text.startsWith("1.3") || text.startsWith("1.4")) {
    // Determine the category based on user input
    let category = "";
    if (text.startsWith("1.1")) category = "Hourly";
    else if (text.startsWith("1.2")) category = "Daily";
    else if (text.startsWith("1.3")) category = "Weekly";
    else if (text.startsWith("1.4")) category = "Monthly";
    
    // List available bundles for the chosen category
    let bundleMsg = `📶 *${category} Data Bundles Available:*\n`;
    dataBundles[category].forEach((bundle, index) => {
      bundleMsg += `✅ ${index + 1}. *${bundle.name}* @ *KSH ${bundle.price}* (${bundle.validity})\n`;
    });
    bundleMsg += `\nReply with the bundle number (e.g., "1.1.2" for option 2 in Hourly)`;
    // Save chosen category for this user (in a temporary order session)
    orders[sender] = { category };
    return client.sendMessage(sender, bundleMsg);
  }

  // Capture bundle selection: e.g., "1.1.1" means first bundle in Hourly
  if (/^1\.[1-4]\.[1-9]$/.test(text)) {
    const parts = text.split(".");
    const catNumber = parts[1]; // 1 for Hourly, 2 for Daily, etc.
    const bundleNumber = Number(parts[2]) - 1; // zero-indexed

    let category = "";
    if (catNumber === "1") category = "Hourly";
    else if (catNumber === "2") category = "Daily";
    else if (catNumber === "3") category = "Weekly";
    else if (catNumber === "4") category = "Monthly";

    if (!orders[sender] || orders[sender].category !== category) {
      orders[sender] = { category };
    }
    const selectedBundle = dataBundles[category][bundleNumber];
    if (!selectedBundle) {
      return client.sendMessage(sender, "❌ Invalid bundle selection. Please try again.");
    }
    // Create a new order with a unique ID and timestamp
    const orderID = generateOrderID();
    orders[orderID] = {
      customer: sender,
      package: selectedBundle.name + " (" + category + ")",
      amount: selectedBundle.price,
      recipient: null,
      payment: null,
      status: "Pending",
      timestamp: new Date().toISOString()
    };
    // Remove temporary session data for this user (if any)
    delete orders[sender];
    saveOrders();
    const summaryMsg = `🛒 *Order Created!*\n\n🆔 Order ID: *${orderID}*\n📦 Package: *${selectedBundle.name}* (${category})\n💰 Price: *KSH ${selectedBundle.price}*\n\n👉 Please enter the *recipient number* (Safaricom only, e.g., 07XXXXXXXX or 01XXXXXXXX):`;
    return client.sendMessage(sender, summaryMsg);
  }

  // Capture recipient number (if order exists and no recipient is set)
  if ((/^0[71]\d{8}$/.test(text)) && (Object.values(orders).find(o => o.customer === sender && !o.recipient))) {
    const order = Object.values(orders).find(o => o.customer === sender && !o.recipient);
    order.recipient = text;
    saveOrders();
    return client.sendMessage(sender, `✅ Recipient number saved: *${text}*.\n\nNow, please enter your *payment number* (Safaricom only, e.g., 07XXXXXXXX):`);
  }

  // Capture payment number (if order exists and recipient is set but payment not)
  if ((/^0[71]\d{8}$/.test(text)) && (Object.values(orders).find(o => o.customer === sender && o.recipient && !o.payment))) {
    const order = Object.values(orders).find(o => o.customer === sender && o.recipient && !o.payment);
    order.payment = text;
    saveOrders();
    // Order summary and payment instructions
    const orderSummary = `🎉 *Order Summary:*\n\n🆔 Order ID: *${order.orderID || Object.keys(orders).find(id => orders[id] === order)}*\n📦 Package: *${order.package}*\n💰 Price: *KSH ${order.amount}*\n📞 Recipient: *${order.recipient}*\n📱 Payment Number: *${order.payment}*\n\n💳 *Payment Instructions:*\nSend *KSH ${order.amount}* to *0701339573 (Camlus)* via M-Pesa.\n\n👉 Once paid, reply with: *PAID ${order.orderID || Object.keys(orders).find(id => orders[id] === order)}*`;
    // Save the generated orderID explicitly if not already set
    if (!order.orderID) {
      order.orderID = Object.keys(orders).find(id => orders[id] === order);
    }
    saveOrders();
    // Notify the user
    client.sendMessage(sender, orderSummary);
    // Notify admin with a detailed order alert
    const adminMsg = `🚀 *New Order Received!*\n\n🆔 Order ID: *${order.orderID}*\n📦 Package: *${order.package}*\n💰 Price: *KSH ${order.amount}*\n📞 Recipient: *${order.recipient}*\n📱 Payment Number: *${order.payment}*\n🕒 Time: *${new Date(order.timestamp).toLocaleString()}*\n\n*Admin Actions:*\nReply with:\n• update ${order.orderID} CONFIRMED\n• update ${order.orderID} COMPLETED\n• update ${order.orderID} REFUNDED\n• update ${order.orderID} CANCELLED\n\nTo update payment details, type: update-payment ${order.orderID} NEW_NUMBER`;
    client.sendMessage(ADMIN_NUMBER, adminMsg);
    return;
  }

  // Confirm Payment: User sends "PAID ORDERID"
  if (text.startsWith("paid ")) {
    const orderId = msg.body.trim().split(" ")[1];
    if (orders[orderId]) {
      orders[orderId].status = "CONFIRMED";
      saveOrders();
      client.sendMessage(sender, `✅ *Payment Confirmed!* Your order *${orderId}* is now processing. Thank you for your purchase!`);
      client.sendMessage(ADMIN_NUMBER, `🔔 Order *${orderId}* has been marked as CONFIRMED.`);
    } else {
      client.sendMessage(sender, "❌ Order not found. Please check your Order ID.");
    }
    return;
  }

  // Fallback default message for unrecognized commands
  const defaultMsg = `🤖 *FY'S Buying Bot*\n\nType *start* or *menu* to view options.\nFor order status, type: status ORDERID\n\nFor support, contact our team.`;
  client.sendMessage(sender, defaultMsg);
});

// -------------------------
// Initialize Bot
// -------------------------
client.initialize();
