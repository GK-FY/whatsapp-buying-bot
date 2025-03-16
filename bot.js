const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');

// Admin Number (CHANGE THIS TO YOUR NUMBER)
const ADMIN_NUMBER = "+254701339573";

// Create a new WhatsApp client
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: { headless: true }
});

// Generate QR Code
client.on('qr', qr => {
    console.log("Scan this QR code to connect:");
    qrcode.generate(qr, { small: true });
});

// Bot Ready
client.on('ready', () => {
    console.log("✅ Bot is Online & Ready!");
});

// Store orders in a JSON file
const ordersFile = 'orders.json';
let orders = fs.existsSync(ordersFile) ? JSON.parse(fs.readFileSync(ordersFile)) : {};

// Save orders to file
const saveOrders = () => fs.writeFileSync(ordersFile, JSON.stringify(orders, null, 2));

// Generate Unique Order ID
const generateOrderID = () => "FY'S-" + Math.floor(100000 + Math.random() * 900000);

// Handle Incoming Messages
client.on('message', async message => {
    const sender = message.from;
    const text = message.body.trim();

    // Admin Order Status Update
    if (sender === ADMIN_NUMBER && text.startsWith("update ")) {
        const [_, orderId, status] = text.split(" ");
        if (orders[orderId]) {
            orders[orderId].status = status;
            saveOrders();
            client.sendMessage(orders[orderId].customer, `📢 *Order Update* 📢\nYour order *${orderId}* is now *${status.toUpperCase()}*.`);
            client.sendMessage(ADMIN_NUMBER, `✅ Order *${orderId}* marked as *${status.toUpperCase()}*`);
        } else {
            client.sendMessage(ADMIN_NUMBER, `❌ Order ID *${orderId}* not found.`);
        }
        return;
    }

    // View Order Status
    if (text.startsWith("status ")) {
        const orderId = text.split(" ")[1];
        if (orders[orderId]) {
            const order = orders[orderId];
            client.sendMessage(sender, `📦 *Order Status* 📦\n*Order:* ${orderId}\n*Status:* ${order.status}\n*Package:* ${order.package}\n*Amount:* KSH ${order.amount}\n*Recipient:* ${order.recipient}`);
        } else {
            client.sendMessage(sender, "❌ Order not found. Check your order number.");
        }
        return;
    }

    // Buying Menu
    if (text === "1") {
        client.sendMessage(sender, "📦 *Choose a Category:* 📦\n1️⃣ Data Bundles\n2️⃣ Airtime\n3️⃣ SMS\n(Reply with a number)");
        return;
    }

    // Data Bundles
    if (text === "1.1") {
        client.sendMessage(sender, "📊 *Choose a Data Bundle:* 📊\n✅ 1. *1.25GB* @ *KSH 55* (Till Midnight)\n✅ 2. *1.5GB* @ *KSH 49* (3 Hours)\n✅ 3. *1GB* @ *KSH 99* (24 Hours)\n(Reply with a number)");
        return;
    }

    // Capture Order
    if (["1.1.1", "1.1.2", "1.1.3"].includes(text)) {
        const packages = {
            "1.1.1": { name: "1.25GB (Till Midnight)", price: 55 },
            "1.1.2": { name: "1.5GB (3 Hours)", price: 49 },
            "1.1.3": { name: "1GB (24 Hours)", price: 99 }
        };
        const chosen = packages[text];
        const orderId = generateOrderID();

        orders[orderId] = {
            customer: sender,
            package: chosen.name,
            amount: chosen.price,
            recipient: null,
            payment: null,
            status: "Pending"
        };
        saveOrders();

        client.sendMessage(sender, `📌 *Order Created:* ${orderId}\n📞 Please enter the recipient number (07XXXXXXXX)`);
        return;
    }

    // Capture Recipient Number
    if (/^07\d{8}$/.test(text) || /^01\d{8}$/.test(text)) {
        const orderId = Object.keys(orders).find(id => orders[id].customer === sender && !orders[id].recipient);
        if (orderId) {
            orders[orderId].recipient = text;
            saveOrders();
            client.sendMessage(sender, `✅ Recipient set: ${text}\n📞 Now enter the payment number (07XXXXXXXX)`);
        }
        return;
    }

    // Capture Payment Number
    if (/^07\d{8}$/.test(text) || /^01\d{8}$/.test(text)) {
        const orderId = Object.keys(orders).find(id => orders[id].customer === sender && orders[id].recipient && !orders[id].payment);
        if (orderId) {
            orders[orderId].payment = text;
            saveOrders();
            const order = orders[orderId];

            // Send Payment Instructions
            client.sendMessage(sender, `💰 *Payment Instructions* 💰\n1️⃣ Send *KSH ${order.amount}* to *0701339573 (Camlus)* via M-Pesa\n2️⃣ Reply *PAID ${orderId}* after payment`);
            client.sendMessage(ADMIN_NUMBER, `📢 *New Order* 📢\n🆔 Order: ${orderId}\n📦 Package: ${order.package}\n💰 Amount: KSH ${order.amount}\n📞 Recipient: ${order.recipient}\n📞 Payment From: ${order.payment}\n👤 User: ${sender}`);
        }
        return;
    }

    // Confirm Payment
    if (text.startsWith("PAID ")) {
        const orderId = text.split(" ")[1];
        if (orders[orderId]) {
            orders[orderId].status = "Confirmed";
            saveOrders();
            client.sendMessage(sender, `✅ Payment confirmed! Your order *${orderId}* is now processing.`);
            client.sendMessage(ADMIN_NUMBER, `🔔 Order *${orderId}* has been marked as *CONFIRMED*`);
        } else {
            client.sendMessage(sender, "❌ Order ID not found.");
        }
        return;
    }

    // Default Response
    client.sendMessage(sender, "🤖 Welcome to *FY'S PROPERTY BOT* 🎉\n1️⃣ Buy Bundles, Airtime & SMS\n2️⃣ Check Order Status (status ORDER_ID)\n3️⃣ Contact Support");
});

// Start the bot
client.initialize();
