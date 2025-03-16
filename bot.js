// bot.js

const { Client, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const QRCode = require('qrcode');

const app = express();
const port = process.env.PORT || 3000;

let qrImageUrl = null;  // This will store the QR code image (as a data URL)

// In-memory order storage (for demo purposes)
const orders = {};

// Helper: Generate order number in the format FY'S-XXXXXX (6-digit number)
function generateOrderNumber() {
    const randomSixDigits = Math.floor(100000 + Math.random() * 900000);
    return `FY'S-${randomSixDigits}`;
}

// Define available packages and categories
const packages = {
    airtime: {
        name: 'Airtime',
        description: 'Recharge your airtime instantly in KES.'
    },
    data: {
        name: 'Data Bundles',
        categories: ['daily', 'hourly', 'weekly', 'monthly'],
        description: 'Purchase data bundles in various categories.'
    },
    sms: {
        name: 'SMS Bundles',
        categories: ['daily', 'weekly', 'monthly'],
        description: 'Purchase SMS bundles for different periods.'
    }
};

// Define your admin WhatsApp number (in WhatsApp format, without the plus sign)
// For example, +254701339573 becomes: 254701339573@c.us
const adminNumber = "254701339573@c.us";

// Initialize the WhatsApp client with LocalAuth for session persistence
const client = new Client({
    authStrategy: new LocalAuth()
});

// When a QR code is generated, convert it to a data URL so we can serve it in a webpage.
client.on('qr', (qr) => {
    console.log('QR RECEIVED, generating image...');
    QRCode.toDataURL(qr, (err, url) => {
        if (err) {
            console.error('Error generating QR code', err);
        } else {
            qrImageUrl = url;
            console.log('QR code updated. Visit http://localhost:' + port + '/qr to view it.');
        }
    });
});

// Log when the client is ready.
client.on('ready', () => {
    console.log('WhatsApp Client is ready!');
});

// Listen for incoming WhatsApp messages
client.on('message', async (message) => {
    const msg = message.body.trim();
    const sender = message.from;
    
    // -------------------------
    // ADMIN COMMANDS (only from adminNumber)
    // -------------------------
    if (sender === adminNumber && msg.toLowerCase().startsWith('update')) {
        // Expected format: update <orderNumber> <newStatus>
        const parts = msg.split(' ');
        if (parts.length >= 3) {
            const orderNumber = parts[1].trim();
            const newStatus = parts.slice(2).join(' ').trim();
            if (orders[orderNumber]) {
                orders[orderNumber].status = newStatus;
                // Notify the user who placed the order
                const userNumber = orders[orderNumber].user;
                await client.sendMessage(userNumber, `Your order ${orderNumber} status has been updated to: ${newStatus}`);
                await client.sendMessage(adminNumber, `Order ${orderNumber} updated to: ${newStatus}`);
            } else {
                await client.sendMessage(adminNumber, `Order ${orderNumber} not found.`);
            }
        } else {
            await client.sendMessage(adminNumber, `Invalid update command format. Use: update <orderNumber> <newStatus>`);
        }
        return;
    }
    
    // -------------------------
    // USER COMMANDS
    // -------------------------
    
    // !start command: send welcome message with instructions
    if (msg.toLowerCase() === '!start') {
        const welcomeMsg = `Welcome to the Buying Bot!

We offer the following packages in Kenyan Shillings (KES):

1. Airtime - Recharge your mobile airtime.
2. Data Bundles - Categories: ${packages.data.categories.join(', ')}.
3. SMS Bundles - Categories: ${packages.sms.categories.join(', ')}.

To purchase, use the following command formats:
• Airtime: !buy airtime <amount> <target_number>
• Data: !buy data <category> <amount> <target_number>
• SMS: !buy sms <category> <quantity> <target_number>

To check your order status, type: !order <order_number>

Example:
!buy airtime 100 254712345678`;
        await client.sendMessage(sender, welcomeMsg);
        return;
    }
    
    // Check order status: !order <orderNumber>
    if (msg.toLowerCase().startsWith('!order')) {
        const parts = msg.split(' ');
        if (parts.length === 2) {
            const orderNumber = parts[1].trim();
            if (orders[orderNumber]) {
                const order = orders[orderNumber];
                await client.sendMessage(sender, `Order Details:
Order Number: ${orderNumber}
Package: ${order.packageType}
Category: ${order.category || 'N/A'}
Amount/Quantity: ${order.amount}
Target Number: ${order.target}
Status: ${order.status}`);
            } else {
                await client.sendMessage(sender, `Order ${orderNumber} not found.`);
            }
        } else {
            await client.sendMessage(sender, `Invalid command. Use: !order <order_number>`);
        }
        return;
    }
    
    // Process purchase commands: !buy <type> <...args>
    if (msg.toLowerCase().startsWith('!buy')) {
        const parts = msg.split(' ');
        if (parts.length < 4) {
            await client.sendMessage(sender, 'Invalid command format. Please check the instructions using !start');
            return;
        }
        const packageType = parts[1].toLowerCase();
        
        // Airtime Purchase: !buy airtime <amount> <target_number>
        if (packageType === 'airtime') {
            if (parts.length !== 4) {
                await client.sendMessage(sender, 'Invalid format for airtime purchase. Use: !buy airtime <amount> <target_number>');
                return;
            }
            const amount = parts[2];
            const target = parts[3];
            const orderNumber = generateOrderNumber();
            orders[orderNumber] = {
                user: sender,
                packageType: 'Airtime',
                category: null,
                amount: amount,
                target: target,
                status: 'Pending'
            };
            const responseMsg = `Thank you for your purchase!
Order Number: ${orderNumber}
Package: Airtime
Amount: KES ${amount}
Target Number: ${target}
Status: Pending`;
            await client.sendMessage(sender, responseMsg);
            // Notify admin with order details
            const adminMsg = `New Order Received:
Order Number: ${orderNumber}
Package: Airtime
Amount: KES ${amount}
User: ${sender}
Target Number: ${target}`;
            await client.sendMessage(adminNumber, adminMsg);
            return;
        }
        
        // Data Bundle Purchase: !buy data <category> <amount> <target_number>
        else if (packageType === 'data') {
            if (parts.length !== 5) {
                await client.sendMessage(sender, 'Invalid format for data purchase. Use: !buy data <category> <amount> <target_number>');
                return;
            }
            const category = parts[2].toLowerCase();
            if (!packages.data.categories.includes(category)) {
                await client.sendMessage(sender, `Invalid data category. Available categories: ${packages.data.categories.join(', ')}`);
                return;
            }
            const amount = parts[3];
            const target = parts[4];
            const orderNumber = generateOrderNumber();
            orders[orderNumber] = {
                user: sender,
                packageType: 'Data Bundles',
                category: category,
                amount: amount,
                target: target,
                status: 'Pending'
            };
            const responseMsg = `Thank you for your purchase!
Order Number: ${orderNumber}
Package: Data Bundles (${category})
Amount: KES ${amount}
Target Number: ${target}
Status: Pending`;
            await client.sendMessage(sender, responseMsg);
            // Notify admin
            const adminMsg = `New Order Received:
Order Number: ${orderNumber}
Package: Data Bundles (${category})
Amount: KES ${amount}
User: ${sender}
Target Number: ${target}`;
            await client.sendMessage(adminNumber, adminMsg);
            return;
        }
        
        // SMS Bundle Purchase: !buy sms <category> <quantity> <target_number>
        else if (packageType === 'sms') {
            if (parts.length !== 5) {
                await client.sendMessage(sender, 'Invalid format for SMS purchase. Use: !buy sms <category> <quantity> <target_number>');
                return;
            }
            const category = parts[2].toLowerCase();
            if (!packages.sms.categories.includes(category)) {
                await client.sendMessage(sender, `Invalid SMS category. Available categories: ${packages.sms.categories.join(', ')}`);
                return;
            }
            const quantity = parts[3];
            const target = parts[4];
            const orderNumber = generateOrderNumber();
            orders[orderNumber] = {
                user: sender,
                packageType: 'SMS Bundles',
                category: category,
                amount: quantity,
                target: target,
                status: 'Pending'
            };
            const responseMsg = `Thank you for your purchase!
Order Number: ${orderNumber}
Package: SMS Bundles (${category})
Quantity: ${quantity}
Target Number: ${target}
Status: Pending`;
            await client.sendMessage(sender, responseMsg);
            // Notify admin
            const adminMsg = `New Order Received:
Order Number: ${orderNumber}
Package: SMS Bundles (${category})
Quantity: ${quantity}
User: ${sender}
Target Number: ${target}`;
            await client.sendMessage(adminNumber, adminMsg);
            return;
        }
        else {
            await client.sendMessage(sender, 'Invalid package type. Please use airtime, data, or sms.');
            return;
        }
    }
    
    // If command not recognized, provide a help message.
    await client.sendMessage(sender, 'Unknown command. Please type !start to see available commands.');
});

// Initialize the WhatsApp client (this will prompt you to scan the QR code if no session is saved)
client.initialize();

// -------------------------
// Express Server Routes
// -------------------------

// Route to show the QR code so you can scan and link the bot
app.get('/qr', (req, res) => {
    if (qrImageUrl) {
        res.send(`
            <html>
                <head>
                    <title>WhatsApp Bot QR Code</title>
                </head>
                <body style="font-family: Arial, sans-serif; text-align: center;">
                    <h1>Scan this QR Code with WhatsApp</h1>
                    <img src="${qrImageUrl}" alt="QR Code" style="width:300px;height:300px;" />
                    <p>If you have already scanned the code, the bot should be connected.</p>
                </body>
            </html>
        `);
    } else {
        res.send(`
            <html>
                <head>
                    <title>WhatsApp Bot QR Code</title>
                </head>
                <body style="font-family: Arial, sans-serif; text-align: center;">
                    <h1>QR Code not available yet.</h1>
                    <p>Please check the server console for updates.</p>
                </body>
            </html>
        `);
    }
});

// Root route with a simple welcome message and link to the QR code page
app.get('/', (req, res) => {
    res.send(`
        <html>
            <head>
                <title>WhatsApp Buying Bot</title>
            </head>
            <body style="font-family: Arial, sans-serif; text-align: center;">
                <h1>Welcome to the WhatsApp Buying Bot</h1>
                <p>To connect the bot, please scan the QR code at <a href="/qr">/qr</a>.</p>
            </body>
        </html>
    `);
});

// Start the Express server
app.listen(port, () => {
    console.log(`Express server is running on http://localhost:${port}`);
});
