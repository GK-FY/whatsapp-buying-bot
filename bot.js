require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');
const express = require('express');
const fetch = require('node-fetch'); // using node-fetch@2

/**
 * =============================
 * CONFIGURATION & GLOBAL VARIABLES
 * =============================
 */
const ADMIN_NUMBER = process.env.ADMIN_NUMBER || '254701339573';
let PAYMENT_INFO = '0701339573 (Camlus)'; // default; admin can update
const PORT = 3000;

// PayHero STK push credentials (admin can update via "set payhero" command)
let PAYHERO_CHANNEL_ID = 911;
let PAYHERO_AUTH_BASE64 = '3A6anVoWFZrRk5qSVl0MGNMOERGMlR3dlhrQ0VWUWJHNDVVVnNaMEdDSw==';

// Withdrawal limits (admin can update)
let MIN_WITHDRAWAL = 20;
let MAX_WITHDRAWAL = 1000;

// In-memory data
const orders = {};    // orderID -> order details
const referrals = {}; // user (string) -> { code, referred: [], earnings, withdrawals: [], pin, parent }
const session = {};   // user -> { step, prevStep, etc. }
const bannedUsers = new Set(); // set of banned user IDs

/**
 * =============================
 * HELPER FUNCTIONS
 * =============================
 */
// Format a Date to Kenyan local time (UTC+3)
function formatKenyaTime(date) {
  const utcMs = date.getTime() + (date.getTimezoneOffset() * 60000);
  const kenyaMs = utcMs + (3 * 3600000);
  const d = new Date(kenyaMs);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day} ${hh}:${mm}:${ss}`;
}

// Partially mask a WhatsApp ID for privacy
function maskWhatsAppID(waid) {
  const atIndex = waid.indexOf('@');
  if (atIndex === -1) return waid;
  const phone = waid.slice(0, atIndex);
  if (phone.length < 6) return waid;
  const first5 = phone.slice(0, 5);
  const last1 = phone.slice(-1);
  return `${first5}****${last1}@c.us`;
}

// Generate a unique order ID
function generateOrderID() {
  return `FY'S-${Math.floor(100000 + Math.random() * 900000)}`;
}

// Validate Safaricom phone number (07XXXXXXXX or 01XXXXXXXX)
function isSafaricomNumber(num) {
  return /^0[71]\d{8}$/.test(num) || /^01\d{8}$/.test(num);
}

/**
 * =============================
 * STK PUSH & WITHDRAWAL API FUNCTIONS
 * =============================
 */
async function sendSTKPush(amount, phoneNumber, externalRef, customerName) {
  try {
    const response = await fetch('https://backend.payhero.co.ke/api/v2/payments', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${PAYHERO_AUTH_BASE64}`
      },
      body: JSON.stringify({
        amount,
        phone_number: phoneNumber,
        channel_id: PAYHERO_CHANNEL_ID,
        provider: 'm-pesa',
        external_reference: externalRef,
        customer_name: customerName,
        callback_url: 'https://example.com/callback.php'
      })
    });
    const data = await response.json();
    if (!response.ok) {
      console.log('❌ STK Push Error:', data);
      return { success: false, message: '⚠️ STK push failed. Please pay manually.' };
    }
    console.log('✅ STK Push Sent:', data);
    return { success: true, message: '🔔 STK push sent! Check your phone for the M-PESA prompt.' };
  } catch (err) {
    console.error('Error sending STK push:', err);
    return { success: false, message: '⚠️ STK push request error. Please pay manually.' };
  }
}

async function processWithdrawal(wd) {
  // wd: withdrawal object { id, amount, mpesa, ... }
  try {
    const response = await fetch('https://backend.payhero.co.ke/api/v2/withdraw', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${PAYHERO_AUTH_BASE64}`
      },
      body: JSON.stringify({
        external_reference: wd.id,
        amount: wd.amount,
        phone_number: wd.mpesa,
        network_code: "63902",
        callback_url: "https://example.com",
        channel: "mobile",
        channel_id: PAYHERO_CHANNEL_ID,
        payment_service: "b2c"
      })
    });
    const data = await response.json();
    if (!response.ok) {
      console.log('❌ Withdrawal API Error:', data);
      return { success: false, message: '⚠️ Withdrawal API call failed.' };
    }
    console.log('✅ Withdrawal API Success:', data);
    return { success: true, message: '💸 Withdrawal processed successfully!' };
  } catch (err) {
    console.error('Error processing withdrawal:', err);
    return { success: false, message: '⚠️ Withdrawal request error.' };
  }
}

/**
 * =============================
 * PACKAGES: Data & SMS
 * =============================
 */
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
const { puppeteer } = require('whatsapp-web.js');
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: { headless: true }
});
let qrImageUrl = null;

client.on('qr', (qr) => {
  console.log('🔐 Please scan the QR code below with WhatsApp:');
  qrcodeTerminal.generate(qr, { small: true });
  QRCode.toDataURL(qr, (err, url) => {
    if (!err) qrImageUrl = url;
  });
});

// Prevent responses in group chats
client.on('message', async (msg) => {
  if (msg.from.endsWith('@g.us')) return;
});

client.on('ready', () => {
  console.log('✅ Bot is online!');
  client.sendMessage(
    `${ADMIN_NUMBER}@c.us`,
    `🎉 Hello Admin! FY'S ULTRA BOT is now live.
Type "menu" for user flow or "Admin CMD" for admin commands.`
  );
});

/**
 * =============================
 * REFERRAL UTILITIES
 * =============================
 */
function getReferralLink(sender) {
  if (!referrals[sender]) {
    const code = 'REF' + Math.floor(100000 + Math.random() * 900000);
    referrals[sender] = {
      code,
      referred: [],
      earnings: 0,
      withdrawals: [],
      pin: null,
      parent: session[sender]?.referrer || null
    };
  }
  return `https://wa.me/254700363422?text=ref%20${referrals[sender].code}`;
}

function recordReferral(newUser, refCode) {
  // If user already has a referral, do not update
  if (session[newUser] && session[newUser].referrer) return;
  for (let r in referrals) {
    if (referrals[r].code === refCode) {
      if (!referrals[r].referred.includes(newUser)) {
        referrals[r].referred.push(newUser);
      }
      session[newUser] = session[newUser] || {};
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
    let p = parts[i];
    if (p.startsWith('"') && !p.endsWith('"')) {
      inQuote = true;
      current += p.slice(1) + ' ';
    } else if (inQuote && p.endsWith('"')) {
      inQuote = false;
      current += p.slice(0, -1);
      result.push(current.trim());
      current = '';
    } else if (inQuote) {
      current += p + ' ';
    } else if (p.startsWith('"') && p.endsWith('"')) {
      result.push(p.slice(1, -1));
    } else {
      result.push(p);
    }
  }
  return result;
}

/**
 * =============================
 * MAIN MESSAGE HANDLER
 * =============================
 */
client.on('message', async (msg) => {
  const sender = msg.from;
  const text = msg.body.trim();
  const lower = text.toLowerCase();

  // Ignore group chats
  if (sender.endsWith('@g.us')) return;

  // Block banned users (non-admin)
  if (bannedUsers.has(sender) && sender !== `${ADMIN_NUMBER}@c.us`) {
    return client.sendMessage(sender, "🚫 You are banned from using this service. please Contact Admin To know the reason. Thank you");
  }

  // ---------- ADMIN FLOW ----------
  if (sender === `${ADMIN_NUMBER}@c.us`) {
    if (lower === 'admin cmd') {
      const adminMenu = `📜 *Admin Menu* 📜
1) update <ORDER_ID> <STATUS> <REMARK>
2) set payment <mpesa_number> "<Name>"
3) add data <subcat> "<name>" <price> "<validity>"
4) remove data <subcat> <id>
5) edit data <subcat> <id> <newprice>
6) add sms <subcat> "<name>" <price> "<validity>"
7) remove sms <subcat> <id>
8) edit sms <subcat> <id> <newprice>
9) set withdrawal <min> <max>
10) search <ORDER_ID>
11) referrals all
12) withdraw update <ref_code> <wd_id> <STATUS> <remarks>
13) earnings add <ref_code> <amount> <remarks>
14) earnings deduct <ref_code> <amount> <remarks>
15) ban <userID>
16) unban <userID>
17) set payhero <channel_id> <base64Auth>
18) approve <wd_id>
19) cancel <wd_id>`;
      return client.sendMessage(sender, adminMenu);
    }
    // set payhero <channel_id> <base64Auth>
    if (lower.startsWith('set payhero ')) {
      const parts = text.split(' ');
      if (parts.length < 4)
        return client.sendMessage(sender, '❌ Usage: set payhero <channel_id> <base64Auth>');
      const chId = Number(parts[2]);
      const auth = parts[3];
      if (isNaN(chId) || chId <= 0)
        return client.sendMessage(sender, '❌ channel_id must be a positive number.');
      PAYHERO_CHANNEL_ID = chId;
      PAYHERO_AUTH_BASE64 = auth;
      return client.sendMessage(sender, `✅ Updated STK/Withdrawal config:
channel_id = ${chId}
Authorization = Basic ${auth}`);
    }
    // ban <userID>
    if (lower.startsWith('ban ')) {
      const parts = text.split(' ');
      if (parts.length !== 2) return client.sendMessage(sender, '❌ Usage: ban <userID>');
      bannedUsers.add(parts[1]);
      return client.sendMessage(sender, `✅ Banned user ${parts[1]}.`);
    }
    // unban <userID>
    if (lower.startsWith('unban ')) {
      const parts = text.split(' ');
      if (parts.length !== 2) return client.sendMessage(sender, '❌ Usage: unban <userID>');
      bannedUsers.delete(parts[1]);
      return client.sendMessage(sender, `✅ Unbanned user ${parts[1]}.`);
    }
    // set withdrawal <min> <max>
    if (lower.startsWith('set withdrawal ')) {
      const parts = text.split(' ');
      if (parts.length !== 4)
        return client.sendMessage(sender, '❌ Usage: set withdrawal <min> <max>');
      const minW = Number(parts[2]);
      const maxW = Number(parts[3]);
      if (isNaN(minW) || isNaN(maxW) || minW <= 0 || maxW <= minW)
        return client.sendMessage(sender, '❌ Provide valid numbers (max > min > 0).');
      MIN_WITHDRAWAL = minW;
      MAX_WITHDRAWAL = maxW;
      return client.sendMessage(sender, `✅ Withdrawal limits updated: min = KSH ${MIN_WITHDRAWAL}, max = KSH ${MAX_WITHDRAWAL}`);
    }
    // update <ORDER_ID> <STATUS> <REMARK>
    if (lower.startsWith('update ')) {
      const parts = text.split(' ');
      if (parts.length < 4)
        return client.sendMessage(sender, '❌ Usage: update <ORDER_ID> <STATUS> <REMARK>');
      const orderID = parts[1];
      const status = parts[2].toUpperCase();
      const remark = parts.slice(3).join(' ');
      if (!orders[orderID])
        return client.sendMessage(sender, `❌ Order ${orderID} not found.`);
      // Prevent updating if already confirmed or completed
      if (orders[orderID].status !== 'PENDING')
        return client.sendMessage(sender, `❌ Order ${orderID} has already been marked as ${orders[orderID].status}. To check status, type: status ${orderID}`);
      orders[orderID].status = status;
      orders[orderID].remark = remark;
      const user = orders[orderID].customer;
      let extra = '';
      if (status === 'CONFIRMED') {
        extra = '✅ Payment confirmed! We are processing your order.';
      } else if (status === 'COMPLETED') {
        extra = '🎉 Your order has been completed! Thank you for choosing FYS PROPERTY.';
        // Two-level referral bonus:
        if (orders[orderID].referrer) {
          let direct = null;
          for (let u in referrals) {
            if (referrals[u].code === orders[orderID].referrer) {
              direct = u;
              referrals[u].earnings += 5;
              client.sendMessage(u, `🔔 Congrats! You earned KSH5 from a referral order!`);
              break;
            }
          }
          if (direct && referrals[direct].parent) {
            const parentCode = referrals[direct].parent;
            for (let v in referrals) {
              if (referrals[v].code === parentCode) {
                referrals[v].earnings += 5;
                client.sendMessage(v, `🔔 Great news! You earned KSH5 as a second-level referral bonus!`);
                break;
              }
            }
          }
        }
      } else if (status === 'CANCELLED') {
        extra = `😔 Your order was cancelled.
Order ID: ${orderID}
Package: ${orders[orderID].package}
Placed at: ${formatKenyaTime(new Date(orders[orderID].timestamp))}
Remark: ${remark}
Please contact support if needed.`;
      } else if (status === 'REFUNDED') {
        extra = '💰 Your order was refunded. Check your M-Pesa balance.';
      } else {
        extra = 'Your order status has been updated.';
      }
      client.sendMessage(user, `🔔 *Order Update*\nYour order *${orderID}* is now *${status}*.
${extra}
Reply "0" or "00" for menus.`);
      return client.sendMessage(sender, `✅ Order ${orderID} updated to ${status} with remark: "${remark}".`);
    }
    // set payment <mpesa_number> "<Name>"
    if (lower.startsWith('set payment ')) {
      const parts = parseQuotedParts(text.split(' '), 2);
      if (parts.length < 2)
        return client.sendMessage(sender, '❌ Usage: set payment <mpesa_number> "<Name>"');
      const mpesa = parts[0];
      const name = parts[1];
      PAYMENT_INFO = `${mpesa} (${name})`;
      return client.sendMessage(sender, `✅ Payment info updated to: ${PAYMENT_INFO}`);
    }
    // add data <subcat> "<name>" <price> "<validity>"
    if (lower.startsWith('add data ')) {
      const parts = parseQuotedParts(text.split(' '), 2);
      if (parts.length < 4)
        return client.sendMessage(sender, '❌ Usage: add data <subcat> "<name>" <price> "<validity>"');
      const subcat = parts[0].toLowerCase();
      const name = parts[1];
      const price = Number(parts[2]);
      const validity = parts[3];
      if (!dataPackages[subcat])
        return client.sendMessage(sender, `❌ Invalid data category: ${subcat}`);
      const arr = dataPackages[subcat];
      const newId = arr.length ? arr[arr.length - 1].id + 1 : 1;
      arr.push({ id: newId, name, price, validity });
      return client.sendMessage(sender, `✅ Added data package: [${newId}] ${name} @ KSH ${price} (${validity}) to ${subcat}.`);
    }
    // remove data <subcat> <id>
    if (lower.startsWith('remove data ')) {
      const parts = text.split(' ');
      if (parts.length < 4)
        return client.sendMessage(sender, '❌ Usage: remove data <subcat> <id>');
      const subcat = parts[2].toLowerCase();
      const idToRemove = Number(parts[3]);
      if (!dataPackages[subcat])
        return client.sendMessage(sender, `❌ Invalid data subcat: ${subcat}`);
      const idx = dataPackages[subcat].findIndex(x => x.id === idToRemove);
      if (idx === -1)
        return client.sendMessage(sender, `❌ No data package with ID ${idToRemove}.`);
      dataPackages[subcat].splice(idx, 1);
      return client.sendMessage(sender, `✅ Removed data package ID ${idToRemove} from ${subcat}.`);
    }
    // edit data <subcat> <id> <newprice>
    if (lower.startsWith('edit data ')) {
      const parts = text.split(' ');
      if (parts.length < 5)
        return client.sendMessage(sender, '❌ Usage: edit data <subcat> <id> <newprice>');
      const subcat = parts[2].toLowerCase();
      const idToEdit = Number(parts[3]);
      const newPrice = Number(parts[4]);
      if (!dataPackages[subcat])
        return client.sendMessage(sender, `❌ Invalid data subcat: ${subcat}`);
      const pack = dataPackages[subcat].find(x => x.id === idToEdit);
      if (!pack)
        return client.sendMessage(sender, `❌ No data package with ID ${idToEdit}.`);
      pack.price = newPrice;
      return client.sendMessage(sender, `✅ Updated data package ID ${idToEdit} to KSH ${newPrice}.`);
    }
    // add sms <subcat> "<name>" <price> "<validity>"
    if (lower.startsWith('add sms ')) {
      const parts = parseQuotedParts(text.split(' '), 2);
      if (parts.length < 4)
        return client.sendMessage(sender, '❌ Usage: add sms <subcat> "<name>" <price> "<validity>"');
      const subcat = parts[0].toLowerCase();
      const name = parts[1];
      const price = Number(parts[2]);
      const validity = parts[3];
      if (!smsPackages[subcat])
        return client.sendMessage(sender, `❌ Invalid sms subcat: ${subcat}`);
      const arr = smsPackages[subcat];
      const newId = arr.length ? arr[arr.length - 1].id + 1 : 1;
      arr.push({ id: newId, name, price, validity });
      return client.sendMessage(sender, `✅ Added SMS package: [${newId}] ${name} @ KSH ${price} (${validity}) to ${subcat}.`);
    }
    // remove sms <subcat> <id>
    if (lower.startsWith('remove sms ')) {
      const parts = text.split(' ');
      if (parts.length < 4)
        return client.sendMessage(sender, '❌ Usage: remove sms <subcat> <id>');
      const subcat = parts[2].toLowerCase();
      const idToRemove = Number(parts[3]);
      if (!smsPackages[subcat])
        return client.sendMessage(sender, `❌ Invalid sms subcat: ${subcat}`);
      const idx = smsPackages[subcat].findIndex(x => x.id === idToRemove);
      if (idx === -1)
        return client.sendMessage(sender, `❌ No SMS package with ID ${idToRemove}.`);
      smsPackages[subcat].splice(idx, 1);
      return client.sendMessage(sender, `✅ Removed SMS package ID ${idToRemove} from ${subcat}.`);
    }
    // edit sms <subcat> <id> <newprice>
    if (lower.startsWith('edit sms ')) {
      const parts = text.split(' ');
      if (parts.length < 5)
        return client.sendMessage(sender, '❌ Usage: edit sms <subcat> <id> <newprice>');
      const subcat = parts[2].toLowerCase();
      const idToEdit = Number(parts[3]);
      const newPrice = Number(parts[4]);
      if (!smsPackages[subcat])
        return client.sendMessage(sender, `❌ Invalid sms subcat: ${subcat}`);
      const pack = smsPackages[subcat].find(x => x.id === idToEdit);
      if (!pack)
        return client.sendMessage(sender, `❌ No SMS package with ID ${idToEdit}.`);
      pack.price = newPrice;
      return client.sendMessage(sender, `✅ Updated SMS package ID ${idToEdit} to KSH ${newPrice}.`);
    }
    // referrals all
    if (lower === 'referrals all') {
      let resp = `🙌 *All Referral Data*\nWithdrawal Limits: Min KSH ${MIN_WITHDRAWAL}, Max KSH ${MAX_WITHDRAWAL}\n\n`;
      for (let u in referrals) {
        resp += `User: ${u}\nCode: ${referrals[u].code}\nTotal Referred: ${referrals[u].referred.length}\nEarnings: KSH ${referrals[u].earnings}\nWithdrawals: ${referrals[u].withdrawals.length}\nPIN: ${referrals[u].pin || 'Not Set'}\nParent: ${referrals[u].parent || 'None'}\n\n`;
      }
      return client.sendMessage(sender, resp);
    }
    // withdraw update <ref_code> <wd_id> <STATUS> <remarks>
    if (lower.startsWith('withdraw update ')) {
      const parts = text.split(' ');
      if (parts.length < 6)
        return client.sendMessage(sender, '❌ Usage: withdraw update <ref_code> <wd_id> <STATUS> <remarks>');
      const refCode = parts[2].toUpperCase();
      const wdId = parts[3];
      const newStatus = parts[4].toUpperCase();
      const remarks = parts.slice(5).join(' ');
      let foundUser = null;
      for (let u in referrals) {
        if (referrals[u].code === refCode) { foundUser = u; break; }
      }
      if (!foundUser)
        return client.sendMessage(sender, `❌ No user with referral code ${refCode}.`);
      const wdArr = referrals[foundUser].withdrawals;
      const wd = wdArr.find(x => x.id === wdId);
      if (!wd)
        return client.sendMessage(sender, `❌ No withdrawal with ID ${wdId} for code ${refCode}.`);
      wd.status = newStatus;
      wd.remarks = remarks;
      client.sendMessage(foundUser, `🔔 *Withdrawal Update*\nYour withdrawal (ID: ${wdId}) is now *${newStatus}*.\nRemarks: ${remarks} 👍`);
      return client.sendMessage(sender, `✅ Updated withdrawal ${wdId} to ${newStatus} with remarks: "${remarks}".`);
    }
    // approve <wd_id>
    if (lower.startsWith('approve ')) {
      const parts = text.split(' ');
      if (parts.length !== 2)
        return client.sendMessage(sender, '❌ Usage: approve <withdrawal_id>');
      const wdId = parts[1];
      let foundUser = null;
      let targetWd = null;
      for (let u in referrals) {
        const wd = referrals[u].withdrawals.find(x => x.id === wdId);
        if (wd) {
          foundUser = u;
          targetWd = wd;
          break;
        }
      }
      if (!targetWd)
        return client.sendMessage(sender, `❌ Withdrawal ${wdId} not found.`);
      // Process withdrawal via API
      const result = await processWithdrawal(targetWd);
      if (result.success) {
        targetWd.status = 'APPROVED';
        client.sendMessage(foundUser, `💸 *Withdrawal Approved!*\nYour withdrawal (ID: ${wdId}) for KSH ${targetWd.amount} has been approved and is being processed.\n${result.message}`);
        return client.sendMessage(sender, `✅ Withdrawal ${wdId} approved and processed.`);
      } else {
        return client.sendMessage(sender, `❌ Withdrawal ${wdId} approval failed: ${result.message}`);
      }
    }
    // cancel <wd_id>
    if (lower.startsWith('cancel ')) {
      const parts = text.split(' ');
      if (parts.length !== 2)
        return client.sendMessage(sender, '❌ Usage: cancel <withdrawal_id>');
      const wdId = parts[1];
      let foundUser = null;
      let targetWd = null;
      for (let u in referrals) {
        const wd = referrals[u].withdrawals.find(x => x.id === wdId);
        if (wd) {
          foundUser = u;
          targetWd = wd;
          break;
        }
      }
      if (!targetWd)
        return client.sendMessage(sender, `❌ Withdrawal ${wdId} not found.`);
      targetWd.status = 'CANCELLED';
      client.sendMessage(foundUser, `⚠️ *Withdrawal Cancelled!*\nYour withdrawal (ID: ${wdId}) has been cancelled by the admin.`);
      return client.sendMessage(sender, `✅ Withdrawal ${wdId} has been cancelled.`);
    }
    // earnings add <ref_code> <amount> <remarks>
    if (lower.startsWith('earnings add ')) {
      const parts = text.split(' ');
      if (parts.length < 5)
        return client.sendMessage(sender, '❌ Usage: earnings add <ref_code> <amount> <remarks>');
      const refCode = parts[2].toUpperCase();
      const amount = Number(parts[3]);
      const remarks = parts.slice(4).join(' ');
      if (isNaN(amount) || amount <= 0)
        return client.sendMessage(sender, '❌ Invalid amount.');
      let target = null;
      for (let u in referrals) {
        if (referrals[u].code === refCode) { target = u; break; }
      }
      if (!target)
        return client.sendMessage(sender, `❌ No user with referral code ${refCode}.`);
      referrals[target].earnings += amount;
      client.sendMessage(target, `🔔 *Admin Adjustment*\nYour earnings increased by KSH ${amount}.\nRemarks: ${remarks}\nNew Earnings: KSH ${referrals[target].earnings} 💰`);
      return client.sendMessage(sender, `✅ Added KSH ${amount} to user ${target}.`);
    }
    // earnings deduct <ref_code> <amount> <remarks>
    if (lower.startsWith('earnings deduct ')) {
      const parts = text.split(' ');
      if (parts.length < 5)
        return client.sendMessage(sender, '❌ Usage: earnings deduct <ref_code> <amount> <remarks>');
      const refCode = parts[2].toUpperCase();
      const amount = Number(parts[3]);
      const remarks = parts.slice(4).join(' ');
      if (isNaN(amount) || amount <= 0)
        return client.sendMessage(sender, '❌ Invalid amount.');
      let target = null;
      for (let u in referrals) {
        if (referrals[u].code === refCode) { target = u; break; }
      }
      if (!target)
        return client.sendMessage(sender, `❌ No user with referral code ${refCode}.`);
      if (referrals[target].earnings < amount)
        return client.sendMessage(sender, `❌ User only has KSH ${referrals[target].earnings}.`);
      referrals[target].earnings -= amount;
      client.sendMessage(target, `🔔 *Admin Adjustment*\nYour earnings were deducted by KSH ${amount}.\nRemarks: ${remarks}\nNew Earnings: KSH ${referrals[target].earnings} 💰`);
      return client.sendMessage(sender, `✅ Deducted KSH ${amount} from user ${target}.`);
    }
    // search <ORDER_ID>
    if (lower.startsWith('search ')) {
      const parts = text.split(' ');
      if (parts.length !== 2)
        return client.sendMessage(sender, '❌ Usage: search <ORDER_ID>');
      const orderID = parts[1];
      if (!orders[orderID])
        return client.sendMessage(sender, `❌ Order ${orderID} not found.`);
      const o = orders[orderID];
      return client.sendMessage(sender,
        `🔎 *Order Details*\n
🆔 Order ID: ${o.orderID}
📦 Package: ${o.package}
💰 Amount: KSH ${o.amount}
📞 Recipient: ${o.recipient}
📱 Payment: ${o.payment}
📌 Status: ${o.status}
🕒 Placed at: ${formatKenyaTime(new Date(o.timestamp))}
📝 Remark: ${o.remark || 'None'}`
      );
    }
    // End Admin commands.
  } // End Admin Flow

  // ---------- REFERRAL QUICK COMMANDS ----------
  if (lower === 'referral') {
    if (session[sender] && session[sender].referrer) {
      return client.sendMessage(sender, `*Warning ⚠️!* You were already referred by code *${session[sender].referrer}*.`);
    }
    const link = getReferralLink(sender);
    return client.sendMessage(sender, `😍 *Your unique Referral Link is:*\n${link}\nShare it with friends and family to earn KSH5 per successful order!`);
  }
  if (lower.startsWith('ref ')) {
    const parts = text.split(' ');
    if (parts.length === 2) {
      if (session[sender] && session[sender].referrer) {
        return client.sendMessage(sender, `*Warning ⚠️!* You were already referred by code *${session[sender].referrer}*.`);
      }
      recordReferral(sender, parts[1].toUpperCase());
      client.sendMessage(sender, `🙏 Referral successful! You were referred by code *${parts[1].toUpperCase()}*. Start referring others to win more rewards!`);
      return;
    }
  }

  // ---------- MAIN MENU NAVIGATION ----------
  if (lower === 'menu' || lower === 'start') {
    session[sender] = { step: 'main' };
    const mainMenu = `🌟 *Welcome to FY'S PROPERTY BOT!* 🌟
Thank you for choosing FYS PROPERTY!

Select an option:
1️⃣ Airtime
2️⃣ Data Bundles
3️⃣ SMS Bundles
4️⃣ My Referrals

For order status: status *<ORDER_ID>*
After payment: *PAID <ORDER_ID>*
Type "00" for main menu.`;
    return client.sendMessage(sender, mainMenu);
  }
  if (text === '0') {
    if (session[sender]?.prevStep) {
      session[sender].step = session[sender].prevStep;
      return client.sendMessage(sender, '🔄 Returning to previous menu... Please reply with *Menu*');
    } else {
      session[sender] = { step: 'main' };
      return client.sendMessage(sender, '🏠 Returning to main menu... Please reply with *Menu*');
    }
  }
  if (text === '00') {
    session[sender] = { step: 'main' };
    return client.sendMessage(sender, '🏠 Returning to main menu... Please reply with *Menu"');
  }

  // ---------- OPTION 1: Airtime Purchase ----------
  if (session[sender]?.step === 'main' && text === '1') {
    session[sender].prevStep = 'main';
    session[sender].step = 'airtimeAmount';
    return client.sendMessage(sender, `💳 *Airtime Purchase*\nEnter the amount in KES (e.g., "10").\nType "0" to go back.`);
  }
  if (session[sender]?.step === 'airtimeAmount') {
    const amt = Number(text);
    if (isNaN(amt) || amt <= 0)
      return client.sendMessage(sender, '❌ Invalid amount.');
    session[sender].airtimeAmount = amt;
    session[sender].step = 'airtimeRecipient';
    return client.sendMessage(sender, `✅ Amount set to KSH ${amt}.\nEnter recipient phone number (07XXXXXXXX):`);
  }
  if (session[sender]?.step === 'airtimeRecipient') {
    if (!isSafaricomNumber(text))
      return client.sendMessage(sender, '❌ Invalid phone number.');
    session[sender].airtimeRecipient = text;
    session[sender].step = 'airtimePayment';
    return client.sendMessage(sender, `✅ Recipient set: ${text}.\nEnter your payment number (07XXXXXXXX):`);
  }
  if (session[sender]?.step === 'airtimePayment') {
    if (!isSafaricomNumber(text))
      return client.sendMessage(sender, '❌ Invalid payment number.');
    const orderID = generateOrderID();
    const amt = session[sender].airtimeAmount;
    orders[orderID] = {
      orderID,
      customer: sender,
      package: `Airtime (KES ${amt})`,
      amount: amt,
      recipient: session[sender].airtimeRecipient,
      payment: text,
      status: 'PENDING',
      timestamp: new Date().toISOString()
    };
    // Attempt STK push
    const pushResult = await sendSTKPush(amt, text, orderID, 'FYS PROPERTY BOT');
    if (pushResult.success) {
      client.sendMessage(sender, `${pushResult.message}\nIf you don't receive it, please pay manually to ${PAYMENT_INFO}.`);
    } else {
      client.sendMessage(sender, `${pushResult.message}\nPlease pay manually to ${PAYMENT_INFO}.`);
    }
    delete session[sender].airtimeAmount;
    delete session[sender].airtimeRecipient;
    session[sender].step = 'main';
    const summary = `🛒 *Order Created!*
🆔 ${orderID}
Package: Airtime (KES ${amt})
💰 Price: KSH ${amt}
📞 Recipient: ${orders[orderID].recipient}
📱 Payment: ${orders[orderID].payment}
🕒 Placed at: ${formatKenyaTime(new Date(orders[orderID].timestamp))}
👉 Type: PAID ${orderID} once you complete payment.
Type "00" for main menu.`;
    client.sendMessage(sender, summary);
    const adminMsg = `🔔 *New Airtime Order*
🆔 ${orderID}
Package: Airtime (KES ${amt})
Price: KSH ${amt}
Recipient: ${orders[orderID].recipient}
Payment: ${orders[orderID].payment}
Time: ${formatKenyaTime(new Date(orders[orderID].timestamp))}
User: ${sender}
(Use admin commands to update.)`;
    client.sendMessage(`${ADMIN_NUMBER}@c.us`, adminMsg);
    return;
  }

  // ---------- OPTION 2: Data Bundles ----------
  if (session[sender]?.step === 'main' && text === '2') {
    session[sender].prevStep = 'main';
    session[sender].step = 'dataCategory';
    return client.sendMessage(sender, `📶 *Data Bundles*
Choose subcategory:
1) Hourly
2) Daily
3) Weekly
4) Monthly
Type "0" to go back.`);
  }
  if (session[sender]?.step === 'dataCategory') {
    if (!['1', '2', '3', '4'].includes(text))
      return client.sendMessage(sender, '❌ Invalid choice. Please type 1, 2, 3, or 4.');
    const cat = text === '1' ? 'hourly' : text === '2' ? 'daily' : text === '3' ? 'weekly' : 'monthly';
    session[sender].dataCat = cat;
    session[sender].prevStep = 'dataCategory';
    session[sender].step = 'dataList';
    let listMsg = `✅ *${cat.toUpperCase()} Data Bundles:*\n`;
    dataPackages[cat].forEach(p => {
      listMsg += `[${p.id}] ${p.name} @ KSH ${p.price} (${p.validity})\n`;
    });
    listMsg += `\nType the package ID to select, or "0" to go back.`;
    return client.sendMessage(sender, listMsg);
  }
  if (session[sender]?.step === 'dataList') {
    const cat = session[sender].dataCat;
    const pkgId = Number(text);
    if (isNaN(pkgId))
      return client.sendMessage(sender, '❌ Invalid package ID.');
    const pkg = dataPackages[cat].find(x => x.id === pkgId);
    if (!pkg)
      return client.sendMessage(sender, '❌ No package with that ID.');
    session[sender].dataBundle = pkg;
    session[sender].prevStep = 'dataList';
    session[sender].step = 'dataRecip';
    return client.sendMessage(sender, `✅ Selected: ${pkg.name} (KSH ${pkg.price}).
Enter recipient phone number (07XXXXXXXX):`);
  }
  if (session[sender]?.step === 'dataRecip') {
    if (!isSafaricomNumber(text))
      return client.sendMessage(sender, '❌ Invalid phone number.');
    session[sender].dataRecipient = text;
    session[sender].prevStep = 'dataRecip';
    session[sender].step = 'dataPay';
    return client.sendMessage(sender, `✅ Recipient set: ${text}.
Enter your payment number (07XXXXXXXX):`);
  }
  if (session[sender]?.step === 'dataPay') {
    if (!isSafaricomNumber(text))
      return client.sendMessage(sender, '❌ Invalid payment number.');
    const orderID = generateOrderID();
    orders[orderID] = {
      orderID,
      customer: sender,
      package: `${session[sender].dataBundle.name} (${session[sender].dataCat})`,
      amount: session[sender].dataBundle.price,
      recipient: session[sender].dataRecipient,
      payment: text,
      status: 'PENDING',
      timestamp: new Date().toISOString()
    };
    if (session[sender].referrer) {
      orders[orderID].referrer = session[sender].referrer;
    }
    const pushResult = await sendSTKPush(orders[orderID].amount, text, orderID, 'FYS PROPERTY BOT');
    if (pushResult.success) {
      client.sendMessage(sender, `${pushResult.message}\nIf not, please pay manually to ${PAYMENT_INFO}.`);
    } else {
      client.sendMessage(sender, `${pushResult.message}\nPlease pay manually to ${PAYMENT_INFO}.`);
    }
    delete session[sender].dataBundle;
    delete session[sender].dataRecipient;
    session[sender].step = 'main';
    const summary = `🛒 *Order Created!*
🆔 ${orderID}
Package: ${orders[orderID].package}
💰 KSH ${orders[orderID].amount}
📞 Recipient: ${orders[orderID].recipient}
📱 Payment: ${orders[orderID].payment}
🕒 Placed at: ${formatKenyaTime(new Date(orders[orderID].timestamp))}
👉 Type: PAID ${orderID} when you complete payment.
Type "00" for main menu.`;
    client.sendMessage(sender, summary);
    const adminMsg = `🔔 *New Data Order*
🆔 ${orderID}
Package: ${orders[orderID].package}
Price: KSH ${orders[orderID].amount}
Recipient: ${orders[orderID].recipient}
Payment: ${orders[orderID].payment}
Time: ${formatKenyaTime(new Date(orders[orderID].timestamp))}
User: ${sender}
(Use admin commands to update.)`;
    client.sendMessage(`${ADMIN_NUMBER}@c.us`, adminMsg);
    return;
  }

  // ---------- OPTION 3: SMS Bundles ----------
  if (session[sender]?.step === 'main' && text === '3') {
    session[sender].prevStep = 'main';
    session[sender].step = 'smsCategory';
    return client.sendMessage(sender, `✉️ *SMS Bundles*
Choose subcategory:
1) Daily
2) Weekly
3) Monthly
Type "0" to go back.`);
  }
  if (session[sender]?.step === 'smsCategory') {
    if (!['1','2','3'].includes(text))
      return client.sendMessage(sender, '❌ Invalid choice.');
    const cat = text === '1' ? 'daily' : text === '2' ? 'weekly' : 'monthly';
    session[sender].smsCat = cat;
    session[sender].prevStep = 'smsCategory';
    session[sender].step = 'smsList';
    let listMsg = `✅ *${cat.toUpperCase()} SMS Bundles:*\n`;
    smsPackages[cat].forEach(x => {
      listMsg += `[${x.id}] ${x.name} @ KSH ${x.price} (${x.validity})\n`;
    });
    listMsg += `\nType the package ID to select, or "0" to go back.`;
    return client.sendMessage(sender, listMsg);
  }
  if (session[sender]?.step === 'smsList') {
    const cat = session[sender].smsCat;
    const pkgId = Number(text);
    if (isNaN(pkgId))
      return client.sendMessage(sender, '❌ Invalid package ID.');
    const pkg = smsPackages[cat].find(x => x.id === pkgId);
    if (!pkg)
      return client.sendMessage(sender, '❌ No package with that ID.');
    session[sender].smsBundle = pkg;
    session[sender].prevStep = 'smsList';
    session[sender].step = 'smsRecip';
    return client.sendMessage(sender, `✅ Selected: ${pkg.name} (KSH ${pkg.price}).
Enter recipient phone number (07XXXXXXXX):`);
  }
  if (session[sender]?.step === 'smsRecip') {
    if (!isSafaricomNumber(text))
      return client.sendMessage(sender, '❌ Invalid phone number.');
    session[sender].smsRecipient = text;
    session[sender].prevStep = 'smsRecip';
    session[sender].step = 'smsPay';
    return client.sendMessage(sender, `✅ Recipient set: ${text}.
Enter your payment number (07XXXXXXXX):`);
  }
  if (session[sender]?.step === 'smsPay') {
    if (!isSafaricomNumber(text))
      return client.sendMessage(sender, '❌ Invalid payment number.');
    const orderID = generateOrderID();
    orders[orderID] = {
      orderID,
      customer: sender,
      package: `${session[sender].smsBundle.name} (SMS - ${session[sender].smsCat})`,
      amount: session[sender].smsBundle.price,
      recipient: session[sender].smsRecipient,
      payment: text,
      status: 'PENDING',
      timestamp: new Date().toISOString()
    };
    if (session[sender].referrer) {
      orders[orderID].referrer = session[sender].referrer;
    }
    const pushResult = await sendSTKPush(orders[orderID].amount, text, orderID, 'FYS PROPERTY BOT');
    if (pushResult.success) {
      client.sendMessage(sender, `${pushResult.message}\nIf not, please pay manually to ${PAYMENT_INFO}.`);
    } else {
      client.sendMessage(sender, `${pushResult.message}\nPlease pay manually to ${PAYMENT_INFO}.`);
    }
    delete session[sender].smsBundle;
    delete session[sender].smsRecipient;
    session[sender].step = 'main';
    const summary = `🛒 *Order Created!*
🆔 ${orderID}
Package: ${orders[orderID].package}
💰 KSH ${orders[orderID].amount}
📞 Recipient: ${orders[orderID].recipient}
📱 Payment: ${orders[orderID].payment}
🕒 Placed at: ${formatKenyaTime(new Date(orders[orderID].timestamp))}
👉 Type: PAID ${orderID} once payment is complete.
Type "00" for main menu.`;
    client.sendMessage(sender, summary);
    const adminMsg = `🔔 *New SMS Order*
🆔 ${orderID}
Package: ${orders[orderID].package}
Price: KSH ${orders[orderID].amount}
Recipient: ${orders[orderID].recipient}
Payment: ${orders[orderID].payment}
Time: ${formatKenyaTime(new Date(orders[orderID].timestamp))}
User: ${sender}
(Use admin commands to update.)`;
    client.sendMessage(`${ADMIN_NUMBER}@c.us`, adminMsg);
    return;
  }

  // ---------- MY REFERRALS (Option 4) ----------
  if (session[sender]?.step === 'main' && text === '4') {
    session[sender].prevStep = 'main';
    session[sender].step = 'myReferralsMenu';
    const refMenu = `🌟 *My Referrals Menu* 🌟
1️⃣ View Earnings & Balance
2️⃣ Withdraw Earnings
3️⃣ Get Referral Link
4️⃣ Change PIN
5️⃣ View Referred Users
Type a number, or "0" to go back.`;
    return client.sendMessage(sender, refMenu);
  }
  if (session[sender]?.step === 'myReferralsMenu') {
    if (text === '1') {
      if (!referrals[sender])
        return client.sendMessage(sender, `😞 No referral record. Type "referral" to get your link!`);
      const r = referrals[sender];
      let msgText = `📢 *Your Referral Overview*\nReferral Code: ${r.code}\nEarnings: KSH ${r.earnings}\nTotal Referred: ${r.referred.length}\n\nWithdrawal History:\n`;
      if (r.withdrawals.length === 0) {
        msgText += `None yet.`;
      } else {
        r.withdrawals.forEach((wd, i) => {
          msgText += `${i + 1}. ID: ${wd.id}, Amt: KSH ${wd.amount}, Status: ${wd.status}, Time: ${formatKenyaTime(new Date(wd.timestamp))}\nRemarks: ${wd.remarks}\n\n`;
        });
      }
      return client.sendMessage(sender, msgText);
    } else if (text === '2') {
      if (!referrals[sender] || referrals[sender].earnings < MIN_WITHDRAWAL)
        return client.sendMessage(sender, `😞 You need at least KSH ${MIN_WITHDRAWAL} to withdraw.`);
      if (!referrals[sender].pin)
        return client.sendMessage(sender, `*Warning⚠️!* No PIN set. Choose option 4 to set your PIN first.`);
      session[sender].step = 'withdrawRequest';
      return client.sendMessage(sender, `💸 *Withdrawal Request*\nEnter "<amount> <mpesa_number>" (e.g., "50 0701339573").\nLimits: Min KSH ${MIN_WITHDRAWAL}, Max KSH ${MAX_WITHDRAWAL}\nType "0" to go back.`);
    } else if (text === '3') {
      const link = getReferralLink(sender);
      return client.sendMessage(sender, `😍 *Your unique Referral Link is:*\n${link}\nShare it with friends and family to earn KSH5 per successful order!`);
    } else if (text === '4') {
      if (referrals[sender] && referrals[sender].pin) {
        session[sender].step = 'oldPin';
        return client.sendMessage(sender, `🔐 Enter your current 4-digit PIN to change it:`);
      } else {
        session[sender].step = 'setNewPin';
        return client.sendMessage(sender, `🔐 No PIN set. Enter a new 4-digit PIN (not "1234" or "0000"):`);
      }
    } else if (text === '5') {
      if (!referrals[sender] || referrals[sender].referred.length === 0)
        return client.sendMessage(sender, `😞 You haven't referred anyone yet. Type "referral" to get your link!`);
      let list = `👥 *Your Referred Users* (masked):\n\n`;
      referrals[sender].referred.forEach((u, i) => {
        const masked = maskWhatsAppID(u);
        const userOrders = Object.values(orders).filter(o => o.customer === u);
        const total = userOrders.length;
        const canceled = userOrders.filter(o => o.status === 'CANCELLED').length;
        list += `${i + 1}. ${masked}\n   Orders: ${total}, Cancelled: ${canceled}\n\n`;
      });
      return client.sendMessage(sender, list);
    } else {
      return client.sendMessage(sender, '❌ Invalid choice. Type 1, 2, 3, 4, or 5, or "0" to go back.');
    }
  }
  // PIN change flows:
  if (session[sender]?.step === 'oldPin') {
    if (text !== referrals[sender].pin)
      return client.sendMessage(sender, '❌ Incorrect PIN. Type "0" to cancel.');
    session[sender].step = 'setNewPin';
    return client.sendMessage(sender, '✅ Current PIN verified. Enter your new 4-digit PIN (not "1234" or "0000"):');
  }
  if (session[sender]?.step === 'setNewPin') {
    if (!/^\d{4}$/.test(text))
      return client.sendMessage(sender, '❌ PIN must be exactly 4 digits.');
    if (text === '1234' || text === '0000')
      return client.sendMessage(sender, '❌ That PIN is not allowed.');
    if (!referrals[sender]) {
      const code = 'REF' + Math.floor(100000 + Math.random() * 900000);
      referrals[sender] = { code, referred: [], earnings: 0, withdrawals: [], pin: text, parent: session[sender]?.referrer || null };
    } else {
      referrals[sender].pin = text;
    }
    session[sender].step = 'myReferralsMenu';
    return client.sendMessage(sender, `✅ Your PIN has been updated to ${text}. Returning to My Referrals menu.`);
  }
  // Withdrawal Request flow:
  if (session[sender]?.step === 'withdrawRequest') {
    const parts = text.split(' ');
    if (parts.length !== 2)
      return client.sendMessage(sender, '❌ Usage: "<amount> <mpesa_number>" e.g., "50 0712345678"');
    const amount = Number(parts[0]);
    const mpesa = parts[1];
    if (isNaN(amount) || amount <= 0)
      return client.sendMessage(sender, '❌ Invalid amount.');
    if (!isSafaricomNumber(mpesa))
      return client.sendMessage(sender, '❌ Invalid M-Pesa number.');
    if (amount > referrals[sender].earnings || amount > MAX_WITHDRAWAL)
      return client.sendMessage(sender, `❌ You cannot withdraw more than your earnings (KSH ${referrals[sender].earnings}) or the max limit (KSH ${MAX_WITHDRAWAL}).`);
    if (amount < MIN_WITHDRAWAL)
      return client.sendMessage(sender, `❌ Minimum withdrawal is KSH ${MIN_WITHDRAWAL}.`);
    session[sender].withdrawRequest = { amount, mpesa };
    session[sender].step = 'withdrawPin';
    return client.sendMessage(sender, `🔒 Enter your 4-digit PIN to confirm withdrawing KSH ${amount} to ${mpesa}.`);
  }
  if (session[sender]?.step === 'withdrawPin') {
    if (!/^\d{4}$/.test(text))
      return client.sendMessage(sender, '❌ PIN must be exactly 4 digits.');
    if (referrals[sender].pin !== text)
      return client.sendMessage(sender, '❌ Incorrect PIN. Withdrawal cancelled.');
    const req = session[sender].withdrawRequest;
    const wd = {
      id: `WD-${Math.floor(1000 + Math.random() * 9000)}`,
      amount: req.amount,
      mpesa: req.mpesa,
      status: 'PENDING',
      timestamp: new Date().toISOString(),
      remarks: ''
    };
    referrals[sender].withdrawals.push(wd);
    referrals[sender].earnings -= req.amount;
    delete session[sender].withdrawRequest;
    session[sender].step = 'myReferralsMenu';
    client.sendMessage(sender, `🙏 *Withdrawal Requested!*
ID: ${wd.id}
Amount: KSH ${wd.amount} to ${wd.mpesa}
Status: PENDING
Thank you for choosing FYS PROPERTY!`);
    client.sendMessage(`${ADMIN_NUMBER}@c.us`, `🔔 *New Withdrawal Request*
User: ${sender}
WD ID: ${wd.id}
Amount: KSH ${wd.amount}
M-Pesa: ${wd.mpesa}
Time: ${formatKenyaTime(new Date(wd.timestamp))}
(Use "withdraw update <ref_code> <wd_id> <STATUS> <remarks>" or "approve <wd_id>" / "cancel <wd_id>" to update.)`);
    return;
  }
  // ---------- ADMIN: Approve Withdrawal (approve <wd_id>)
  if (sender === `${ADMIN_NUMBER}@c.us` && lower.startsWith('approve ')) {
    const parts = text.split(' ');
    if (parts.length !== 2)
      return client.sendMessage(sender, '❌ Usage: approve <withdrawal_id>');
    const wdId = parts[1];
    let foundUser = null;
    let targetWd = null;
    for (let u in referrals) {
      const wd = referrals[u].withdrawals.find(x => x.id === wdId);
      if (wd) {
        foundUser = u;
        targetWd = wd;
        break;
      }
    }
    if (!targetWd)
      return client.sendMessage(sender, `❌ Withdrawal ${wdId} not found.`);
    // Process withdrawal via API
    const result = await processWithdrawal(targetWd);
    if (result.success) {
      targetWd.status = 'APPROVED';
      client.sendMessage(foundUser, `💸 *Withdrawal Approved!*
Your withdrawal (ID: ${wdId}) for KSH ${targetWd.amount} has been approved and is being processed.
${result.message}`);
      return client.sendMessage(sender, `✅ Withdrawal ${wdId} approved and processed.`);
    } else {
      return client.sendMessage(sender, `❌ Withdrawal ${wdId} approval failed: ${result.message}`);
    }
  }
  // ---------- ADMIN: Cancel Withdrawal (cancel <wd_id>)
  if (sender === `${ADMIN_NUMBER}@c.us` && lower.startsWith('cancel ')) {
    const parts = text.split(' ');
    if (parts.length !== 2)
      return client.sendMessage(sender, '❌ Usage: cancel <withdrawal_id>');
    const wdId = parts[1];
    let foundUser = null;
    let targetWd = null;
    for (let u in referrals) {
      const wd = referrals[u].withdrawals.find(x => x.id === wdId);
      if (wd) {
        foundUser = u;
        targetWd = wd;
        break;
      }
    }
    if (!targetWd)
      return client.sendMessage(sender, `❌ Withdrawal ${wdId} not found.`);
    targetWd.status = 'CANCELLED';
    client.sendMessage(foundUser, `⚠️ *Withdrawal Cancelled!*
Your withdrawal (ID: ${wdId}) has been cancelled by the admin.`);
    return client.sendMessage(sender, `✅ Withdrawal ${wdId} has been cancelled.`);
  }
  // ---------- ADMIN: earnings add/deduct commands handled above
  // (see previous admin commands for earnings add/deduct)
  // ---------- ADMIN: search <ORDER_ID>
  if (sender === `${ADMIN_NUMBER}@c.us` && lower.startsWith('search ')) {
    const parts = text.split(' ');
    if (parts.length !== 2)
      return client.sendMessage(sender, '❌ Usage: search <ORDER_ID>');
    const orderID = parts[1];
    if (!orders[orderID])
      return client.sendMessage(sender, `❌ Order ${orderID} not found.`);
    const o = orders[orderID];
    return client.sendMessage(sender,
      `🔎 *Order Details*\n
🆔 Order ID: ${o.orderID}
📦 Package: ${o.package}
💰 Amount: KSH ${o.amount}
📞 Recipient: ${o.recipient}
📱 Payment: ${o.payment}
📌 Status: ${o.status}
🕒 Placed at: ${formatKenyaTime(new Date(o.timestamp))}
📝 Remark: ${o.remark || 'None'}`
    );
  }
  // End Admin commands

  // ---------- REFERRAL QUICK COMMANDS ----------
  if (lower === 'referral') {
    if (session[sender] && session[sender].referrer) {
      return client.sendMessage(sender, `ℹ️ You were already referred by code *${session[sender].referrer}*.`);
    }
    const link = getReferralLink(sender);
    return client.sendMessage(sender, `😍 *Your Referral Link:*\n${link}\nShare it with friends to earn KSH5 per successful order!`);
  }
  if (lower.startsWith('ref ')) {
    const parts = text.split(' ');
    if (parts.length === 2) {
      if (session[sender] && session[sender].referrer) {
        return client.sendMessage(sender, `ℹ️ You were already referred by code *${session[sender].referrer}*.`);
      }
      recordReferral(sender, parts[1].toUpperCase());
      client.sendMessage(sender, `🙏 Referral successful! You were referred by code *${parts[1].toUpperCase()}*. Start referring others to win more rewards!`);
      return;
    }
  }

  // ---------- MAIN MENU NAVIGATION ----------
  if (lower === 'menu' || lower === 'start') {
    session[sender] = { step: 'main' };
    const mainMenu = `🌟 *Welcome to FY'S ULTRA BOT!* 🌟
Thank you for choosing FYS PROPERTY!

Select an option:
1️⃣ Airtime
2️⃣ Data Bundles
3️⃣ SMS Bundles
4️⃣ My Referrals

For order status: status <ORDER_ID>
After payment: PAID <ORDER_ID>
Type "00" for main menu.`;
    return client.sendMessage(sender, mainMenu);
  }
  if (text === '0') {
    if (session[sender]?.prevStep) {
      session[sender].step = session[sender].prevStep;
      return client.sendMessage(sender, '🔄 Returning to previous menu... Please reply with *Menu*');
    } else {
      session[sender] = { step: 'main' };
      return client.sendMessage(sender, '🏠 Returning to main menu... Please Reply with *Menu*');
    }
  }
  if (text === '00') {
    session[sender] = { step: 'main' };
    return client.sendMessage(sender, '🏠 Returning to main menu... Please reply with *Menu*');
  }

  // ---------- OPTION 1: Airtime Purchase ----------
  if (session[sender]?.step === 'main' && text === '1') {
    session[sender].prevStep = 'main';
    session[sender].step = 'airtimeAmount';
    return client.sendMessage(sender, `💳 *Airtime Purchase*\nEnter the amount in KES (e.g., "10").\nType "0" to go back.`);
  }
  if (session[sender]?.step === 'airtimeAmount') {
    const amt = Number(text);
    if (isNaN(amt) || amt <= 0)
      return client.sendMessage(sender, '❌ Invalid amount.');
    session[sender].airtimeAmount = amt;
    session[sender].step = 'airtimeRecipient';
    return client.sendMessage(sender, `✅ Amount set to KSH ${amt}.\nEnter recipient phone number (07XXXXXXXX):`);
  }
  if (session[sender]?.step === 'airtimeRecipient') {
    if (!isSafaricomNumber(text))
      return client.sendMessage(sender, '❌ Invalid phone number.');
    session[sender].airtimeRecipient = text;
    session[sender].step = 'airtimePayment';
    return client.sendMessage(sender, `✅ Recipient set: ${text}.\nEnter your payment number (07XXXXXXXX):`);
  }
  if (session[sender]?.step === 'airtimePayment') {
    if (!isSafaricomNumber(text))
      return client.sendMessage(sender, '❌ Invalid payment number.');
    const orderID = generateOrderID();
    const amt = session[sender].airtimeAmount;
    orders[orderID] = {
      orderID,
      customer: sender,
      package: `Airtime (KES ${amt})`,
      amount: amt,
      recipient: session[sender].airtimeRecipient,
      payment: text,
      status: 'PENDING',
      timestamp: new Date().toISOString()
    };
    // Attempt STK push
    const pushResult = await sendSTKPush(amt, text, orderID, 'FYS PROPERTY BOT');
    if (pushResult.success) {
      client.sendMessage(sender, `${pushResult.message}\nIf you don't receive it, please pay manually to ${PAYMENT_INFO}.`);
    } else {
      client.sendMessage(sender, `${pushResult.message}\nPlease pay manually to ${PAYMENT_INFO}.`);
    }
    delete session[sender].airtimeAmount;
    delete session[sender].airtimeRecipient;
    session[sender].step = 'main';
    const summary = `🛒 *Order Created!*
🆔 ${orderID}
Package: Airtime (KES ${amt})
💰 Price: KSH ${amt}
📞 Recipient: ${orders[orderID].recipient}
📱 Payment: ${orders[orderID].payment}
🕒 Placed at: ${formatKenyaTime(new Date(orders[orderID].timestamp))}
👉 Type: PAID ${orderID} once you complete payment.
Type "00" for main menu.`;
    client.sendMessage(sender, summary);
    const adminMsg = `🔔 *New Airtime Order*
🆔 ${orderID}
Package: Airtime (KES ${amt})
Price: KSH ${amt}
Recipient: ${orders[orderID].recipient}
Payment: ${orders[orderID].payment}
Time: ${formatKenyaTime(new Date(orders[orderID].timestamp))}
User: ${sender}
(Use admin commands to update.)`;
    client.sendMessage(`${ADMIN_NUMBER}@c.us`, adminMsg);
    return;
  }

  // ---------- OPTION 2: Data Bundles ----------
  if (session[sender]?.step === 'main' && text === '2') {
    session[sender].prevStep = 'main';
    session[sender].step = 'dataCategory';
    return client.sendMessage(sender, `📶 *Data Bundles*
Choose subcategory:
1) Hourly
2) Daily
3) Weekly
4) Monthly
Type "0" to go back.`);
  }
  if (session[sender]?.step === 'dataCategory') {
    if (!['1', '2', '3', '4'].includes(text))
      return client.sendMessage(sender, '❌ Invalid choice. Please type 1, 2, 3, or 4.');
    const cat = text === '1' ? 'hourly' : text === '2' ? 'daily' : text === '3' ? 'weekly' : 'monthly';
    session[sender].dataCat = cat;
    session[sender].prevStep = 'dataCategory';
    session[sender].step = 'dataList';
    let listMsg = `✅ *${cat.toUpperCase()} Data Bundles:*\n`;
    dataPackages[cat].forEach(p => {
      listMsg += `[${p.id}] ${p.name} @ KSH ${p.price} (${p.validity})\n`;
    });
    listMsg += `\nType the package ID to select, or "0" to go back.`;
    return client.sendMessage(sender, listMsg);
  }
  if (session[sender]?.step === 'dataList') {
    const cat = session[sender].dataCat;
    const pkgId = Number(text);
    if (isNaN(pkgId))
      return client.sendMessage(sender, '❌ Invalid package ID.');
    const pkg = dataPackages[cat].find(x => x.id === pkgId);
    if (!pkg)
      return client.sendMessage(sender, '❌ No package with that ID.');
    session[sender].dataBundle = pkg;
    session[sender].prevStep = 'dataList';
    session[sender].step = 'dataRecip';
    return client.sendMessage(sender, `✅ Selected: ${pkg.name} (KSH ${pkg.price}).
Enter recipient phone number (07XXXXXXXX):`);
  }
  if (session[sender]?.step === 'dataRecip') {
    if (!isSafaricomNumber(text))
      return client.sendMessage(sender, '❌ Invalid phone number.');
    session[sender].dataRecipient = text;
    session[sender].prevStep = 'dataRecip';
    session[sender].step = 'dataPay';
    return client.sendMessage(sender, `✅ Recipient set: ${text}.
Enter your payment number (07XXXXXXXX):`);
  }
  if (session[sender]?.step === 'dataPay') {
    if (!isSafaricomNumber(text))
      return client.sendMessage(sender, '❌ Invalid payment number.');
    const orderID = generateOrderID();
    orders[orderID] = {
      orderID,
      customer: sender,
      package: `${session[sender].dataBundle.name} (${session[sender].dataCat})`,
      amount: session[sender].dataBundle.price,
      recipient: session[sender].dataRecipient,
      payment: text,
      status: 'PENDING',
      timestamp: new Date().toISOString()
    };
    if (session[sender].referrer) {
      orders[orderID].referrer = session[sender].referrer;
    }
    const pushResult = await sendSTKPush(orders[orderID].amount, text, orderID, 'FYS PROPERTY BOT');
    if (pushResult.success) {
      client.sendMessage(sender, `${pushResult.message}\nIf not, please pay manually to ${PAYMENT_INFO}.`);
    } else {
      client.sendMessage(sender, `${pushResult.message}\nPlease pay manually to ${PAYMENT_INFO}.`);
    }
    delete session[sender].dataBundle;
    delete session[sender].dataRecipient;
    session[sender].step = 'main';
    const summary = `🛒 *Order Created!*
🆔 ${orderID}
Package: ${orders[orderID].package}
💰 KSH ${orders[orderID].amount}
📞 Recipient: ${orders[orderID].recipient}
📱 Payment: ${orders[orderID].payment}
🕒 Placed at: ${formatKenyaTime(new Date(orders[orderID].timestamp))}
👉 Type: PAID ${orderID} when you complete payment.
Type "00" for main menu.`;
    client.sendMessage(sender, summary);
    const adminMsg = `🔔 *New Data Order*
🆔 ${orderID}
Package: ${orders[orderID].package}
Price: KSH ${orders[orderID].amount}
Recipient: ${orders[orderID].recipient}
Payment: ${orders[orderID].payment}
Time: ${formatKenyaTime(new Date(orders[orderID].timestamp))}
User: ${sender}
(Use admin commands to update.)`;
    client.sendMessage(`${ADMIN_NUMBER}@c.us`, adminMsg);
    return;
  }

  // ---------- OPTION 3: SMS Bundles ----------
  if (session[sender]?.step === 'main' && text === '3') {
    session[sender].prevStep = 'main';
    session[sender].step = 'smsCategory';
    return client.sendMessage(sender, `✉️ *SMS Bundles*
Choose subcategory:
1) Daily
2) Weekly
3) Monthly
Type "0" to go back.`);
  }
  if (session[sender]?.step === 'smsCategory') {
    if (!['1','2','3'].includes(text))
      return client.sendMessage(sender, '❌ Invalid choice.');
    const cat = text === '1' ? 'daily' : text === '2' ? 'weekly' : 'monthly';
    session[sender].smsCat = cat;
    session[sender].prevStep = 'smsCategory';
    session[sender].step = 'smsList';
    let listMsg = `✅ *${cat.toUpperCase()} SMS Bundles:*\n`;
    smsPackages[cat].forEach(x => {
      listMsg += `[${x.id}] ${x.name} @ KSH ${x.price} (${x.validity})\n`;
    });
    listMsg += `\nType the package ID to select, or "0" to go back.`;
    return client.sendMessage(sender, listMsg);
  }
  if (session[sender]?.step === 'smsList') {
    const cat = session[sender].smsCat;
    const pkgId = Number(text);
    if (isNaN(pkgId))
      return client.sendMessage(sender, '❌ Invalid package ID.');
    const pkg = smsPackages[cat].find(x => x.id === pkgId);
    if (!pkg)
      return client.sendMessage(sender, '❌ No package with that ID.');
    session[sender].smsBundle = pkg;
    session[sender].prevStep = 'smsList';
    session[sender].step = 'smsRecip';
    return client.sendMessage(sender, `✅ Selected: ${pkg.name} (KSH ${pkg.price}).
Enter recipient phone number (07XXXXXXXX):`);
  }
  if (session[sender]?.step === 'smsRecip') {
    if (!isSafaricomNumber(text))
      return client.sendMessage(sender, '❌ Invalid phone number.');
    session[sender].smsRecipient = text;
    session[sender].prevStep = 'smsRecip';
    session[sender].step = 'smsPay';
    return client.sendMessage(sender, `✅ Recipient set: ${text}.
Enter your payment number (07XXXXXXXX):`);
  }
  if (session[sender]?.step === 'smsPay') {
    if (!isSafaricomNumber(text))
      return client.sendMessage(sender, '❌ Invalid payment number.');
    const orderID = generateOrderID();
    orders[orderID] = {
      orderID,
      customer: sender,
      package: `${session[sender].smsBundle.name} (SMS - ${session[sender].smsCat})`,
      amount: session[sender].smsBundle.price,
      recipient: session[sender].smsRecipient,
      payment: text,
      status: 'PENDING',
      timestamp: new Date().toISOString()
    };
    if (session[sender].referrer) {
      orders[orderID].referrer = session[sender].referrer;
    }
    const pushResult = await sendSTKPush(orders[orderID].amount, text, orderID, 'FYS PROPERTY BOT');
    if (pushResult.success) {
      client.sendMessage(sender, `${pushResult.message}\nIf not, please pay manually to ${PAYMENT_INFO}.`);
    } else {
      client.sendMessage(sender, `${pushResult.message}\nPlease pay manually to ${PAYMENT_INFO}.`);
    }
    delete session[sender].smsBundle;
    delete session[sender].smsRecipient;
    session[sender].step = 'main';
    const summary = `🛒 *Order Created!*
🆔 ${orderID}
Package: ${orders[orderID].package}
💰 KSH ${orders[orderID].amount}
📞 Recipient: ${orders[orderID].recipient}
📱 Payment: ${orders[orderID].payment}
🕒 Placed at: ${formatKenyaTime(new Date(orders[orderID].timestamp))}
👉 Type: PAID ${orderID} once payment is complete.
Type "00" for main menu.`;
    client.sendMessage(sender, summary);
    const adminMsg = `🔔 *New SMS Order*
🆔 ${orderID}
Package: ${orders[orderID].package}
Price: KSH ${orders[orderID].amount}
Recipient: ${orders[orderID].recipient}
Payment: ${orders[orderID].payment}
Time: ${formatKenyaTime(new Date(orders[orderID].timestamp))}
User: ${sender}
(Use admin commands to update.)`;
    client.sendMessage(`${ADMIN_NUMBER}@c.us`, adminMsg);
    return;
  }

  // ---------- MY REFERRALS (Option 4) ----------
  if (session[sender]?.step === 'main' && text === '4') {
    session[sender].prevStep = 'main';
    session[sender].step = 'myReferralsMenu';
    const refMenu = `🌟 *My Referrals Menu* 🌟
1️⃣ View Earnings & Balance
2️⃣ Withdraw Earnings
3️⃣ Get Referral Link
4️⃣ Change PIN
5️⃣ View Referred Users
Type a number, or "0" to go back.`;
    return client.sendMessage(sender, refMenu);
  }
  if (session[sender]?.step === 'myReferralsMenu') {
    if (text === '1') {
      if (!referrals[sender])
        return client.sendMessage(sender, `😞 No referral record. Type "referral" to get your link!`);
      const r = referrals[sender];
      let msgText = `📢 *Your Referral Overview*\nReferral Code: ${r.code}\nEarnings: KSH ${r.earnings}\nTotal Referred: ${r.referred.length}\n\nWithdrawal History:\n`;
      if (r.withdrawals.length === 0) {
        msgText += `None yet.`;
      } else {
        r.withdrawals.forEach((wd, i) => {
          msgText += `${i + 1}. ID: ${wd.id}, Amt: KSH ${wd.amount}, Status: ${wd.status}, Time: ${formatKenyaTime(new Date(wd.timestamp))}\nRemarks: ${wd.remarks}\n\n`;
        });
      }
      return client.sendMessage(sender, msgText);
    } else if (text === '2') {
      if (!referrals[sender] || referrals[sender].earnings < MIN_WITHDRAWAL)
        return client.sendMessage(sender, `😞 You need at least KSH ${MIN_WITHDRAWAL} to withdraw.`);
      if (!referrals[sender].pin)
        return client.sendMessage(sender, `⚠️ No PIN set. Choose option 4 to set your PIN first.`);
      session[sender].step = 'withdrawRequest';
      return client.sendMessage(sender, `💸 *Withdrawal Request*\nEnter "<amount> <mpesa_number>" (e.g., "50 0712345678").\nLimits: Min KSH ${MIN_WITHDRAWAL}, Max KSH ${MAX_WITHDRAWAL}\nType "0" to go back.`);
    } else if (text === '3') {
      const link = getReferralLink(sender);
      return client.sendMessage(sender, `😍 *Your unique Referral Link is:*\n${link}\nShare it with friends and family to earn KSH5 per successful order!`);
    } else if (text === '4') {
      if (referrals[sender] && referrals[sender].pin) {
        session[sender].step = 'oldPin';
        return client.sendMessage(sender, `🔐 Enter your current 4-digit PIN to change it:`);
      } else {
        session[sender].step = 'setNewPin';
        return client.sendMessage(sender, `🔐 No PIN set. Enter a new 4-digit PIN (not "1234" or "0000"):`);
      }
    } else if (text === '5') {
      if (!referrals[sender] || referrals[sender].referred.length === 0)
        return client.sendMessage(sender, `😞 You haven't referred anyone yet. Type "referral" to get your link!`);
      let list = `👥 *Your Referred Users* (masked):\n\n`;
      referrals[sender].referred.forEach((u, i) => {
        const masked = maskWhatsAppID(u);
        const userOrders = Object.values(orders).filter(o => o.customer === u);
        const total = userOrders.length;
        const canceled = userOrders.filter(o => o.status === 'CANCELLED').length;
        list += `${i + 1}. ${masked}\n   Orders: ${total}, Cancelled: ${canceled}\n\n`;
      });
      return client.sendMessage(sender, list);
    } else {
      return client.sendMessage(sender, '❌ Invalid choice. Type 1, 2, 3, 4, or 5, or "0" to go back.');
    }
  }
  // PIN change flows:
  if (session[sender]?.step === 'oldPin') {
    if (text !== referrals[sender].pin)
      return client.sendMessage(sender, '❌ Incorrect PIN. Type "0" to cancel.');
    session[sender].step = 'setNewPin';
    return client.sendMessage(sender, '✅ Current PIN verified. Enter your new 4-digit PIN (not "1234" or "0000"):');
  }
  if (session[sender]?.step === 'setNewPin') {
    if (!/^\d{4}$/.test(text))
      return client.sendMessage(sender, '❌ PIN must be exactly 4 digits.');
    if (text === '1234' || text === '0000')
      return client.sendMessage(sender, '❌ That PIN is not allowed.');
    if (!referrals[sender]) {
      const code = 'REF' + Math.floor(100000 + Math.random() * 900000);
      referrals[sender] = { code, referred: [], earnings: 0, withdrawals: [], pin: text, parent: session[sender]?.referrer || null };
    } else {
      referrals[sender].pin = text;
    }
    session[sender].step = 'myReferralsMenu';
    return client.sendMessage(sender, `✅ Your PIN has been updated to ${text}. Returning to My Referrals menu.`);
  }
  // Withdrawal Request flow:
  if (session[sender]?.step === 'withdrawRequest') {
    const parts = text.split(' ');
    if (parts.length !== 2)
      return client.sendMessage(sender, '❌ Usage: "<amount> <mpesa_number>" e.g., "50 0712345678"');
    const amount = Number(parts[0]);
    const mpesa = parts[1];
    if (isNaN(amount) || amount <= 0)
      return client.sendMessage(sender, '❌ Invalid amount.');
    if (!isSafaricomNumber(mpesa))
      return client.sendMessage(sender, '❌ Invalid M-Pesa number.');
    if (amount > referrals[sender].earnings || amount > MAX_WITHDRAWAL)
      return client.sendMessage(sender, `❌ You cannot withdraw more than your earnings (KSH ${referrals[sender].earnings}) or the max limit (KSH ${MAX_WITHDRAWAL}).`);
    if (amount < MIN_WITHDRAWAL)
      return client.sendMessage(sender, `❌ Minimum withdrawal is KSH ${MIN_WITHDRAWAL}.`);
    session[sender].withdrawRequest = { amount, mpesa };
    session[sender].step = 'withdrawPin';
    return client.sendMessage(sender, `🔒 Enter your 4-digit PIN to confirm withdrawing KSH ${amount} to ${mpesa}.`);
  }
  if (session[sender]?.step === 'withdrawPin') {
    if (!/^\d{4}$/.test(text))
      return client.sendMessage(sender, '❌ PIN must be exactly 4 digits.');
    if (referrals[sender].pin !== text)
      return client.sendMessage(sender, '❌ Incorrect PIN. Withdrawal cancelled.');
    const req = session[sender].withdrawRequest;
    const wd = {
      id: `WD-${Math.floor(1000 + Math.random() * 9000)}`,
      amount: req.amount,
      mpesa: req.mpesa,
      status: 'PENDING',
      timestamp: new Date().toISOString(),
      remarks: ''
    };
    referrals[sender].withdrawals.push(wd);
    referrals[sender].earnings -= req.amount;
    delete session[sender].withdrawRequest;
    session[sender].step = 'myReferralsMenu';
    client.sendMessage(sender, `🙏 *Withdrawal Requested!*
ID: ${wd.id}
Amount: KSH ${wd.amount} to ${wd.mpesa}
Status: PENDING
Thank you for choosing FYS PROPERTY!`);
    client.sendMessage(`${ADMIN_NUMBER}@c.us`, `🔔 *New Withdrawal Request*
User: ${sender}
WD ID: ${wd.id}
Amount: KSH ${wd.amount}
M-Pesa: ${wd.mpesa}
Time: ${formatKenyaTime(new Date(wd.timestamp))}
(Use "withdraw update <ref_code> <wd_id> <STATUS> <remarks>" or "approve <wd_id>" / "cancel <wd_id>" to update.)`);
    return;
  }
  // ---------- ADMIN: Approve Withdrawal (approve <wd_id>)
  if (sender === `${ADMIN_NUMBER}@c.us` && lower.startsWith('approve ')) {
    const parts = text.split(' ');
    if (parts.length !== 2)
      return client.sendMessage(sender, '❌ Usage: approve <withdrawal_id>');
    const wdId = parts[1];
    let foundUser = null;
    let targetWd = null;
    for (let u in referrals) {
      const wd = referrals[u].withdrawals.find(x => x.id === wdId);
      if (wd) {
        foundUser = u;
        targetWd = wd;
        break;
      }
    }
    if (!targetWd)
      return client.sendMessage(sender, `❌ Withdrawal ${wdId} not found.`);
    // Call withdrawal API
    const result = await processWithdrawal(targetWd);
    if (result.success) {
      targetWd.status = 'APPROVED';
      client.sendMessage(foundUser, `💸 *Withdrawal Approved!*
Your withdrawal (ID: ${wdId}) for KSH ${targetWd.amount} has been approved and is being processed.
${result.message}`);
      return client.sendMessage(sender, `✅ Withdrawal ${wdId} approved and processed.`);
    } else {
      return client.sendMessage(sender, `❌ Withdrawal ${wdId} approval failed: ${result.message}`);
    }
  }
  // ---------- ADMIN: Cancel Withdrawal (cancel <wd_id>)
  if (sender === `${ADMIN_NUMBER}@c.us` && lower.startsWith('cancel ')) {
    const parts = text.split(' ');
    if (parts.length !== 2)
      return client.sendMessage(sender, '❌ Usage: cancel <withdrawal_id>');
    const wdId = parts[1];
    let foundUser = null;
    let targetWd = null;
    for (let u in referrals) {
      const wd = referrals[u].withdrawals.find(x => x.id === wdId);
      if (wd) {
        foundUser = u;
        targetWd = wd;
        break;
      }
    }
    if (!targetWd)
      return client.sendMessage(sender, `❌ Withdrawal ${wdId} not found.`);
    targetWd.status = 'CANCELLED';
    client.sendMessage(foundUser, `⚠️ *Withdrawal Cancelled!*
Your withdrawal (ID: ${wdId}) has been cancelled by the admin.`);
    return client.sendMessage(sender, `✅ Withdrawal ${wdId} has been cancelled.`);
  }
  // ---------- ADMIN: earnings add/deduct and search commands handled above
  // (see earlier admin command sections)
  // End Admin Flow

  // ---------- USER: Confirm Payment ("PAID <ORDER_ID>")
  if (lower.startsWith('paid ')) {
    const parts = text.split(' ');
    if (parts.length !== 2)
      return client.sendMessage(sender, '❌ Usage: PAID <ORDER_ID>');
    const orderID = parts[1];
    if (!orders[orderID])
      return client.sendMessage(sender, `❌ Order ${orderID} not found.`);
    // Prevent user from confirming an order already updated
    if (orders[orderID].status !== 'PENDING')
      return client.sendMessage(sender, `❌ Order ${orderID} has already been marked as ${orders[orderID].status}. To check status, type: status ${orderID}`);
    orders[orderID].status = 'CONFIRMED';
    // Two-level referral bonus
    if (orders[orderID].referrer && !orders[orderID].referralCredited) {
      let directUser = null;
      for (let u in referrals) {
        if (referrals[u].code === orders[orderID].referrer) {
          directUser = u;
          referrals[u].earnings += 5;
          client.sendMessage(u, `🔔 Congrats! You earned KSH5 from a referral order!`);
          break;
        }
      }
      if (directUser && referrals[directUser].parent) {
        const parentCode = referrals[directUser].parent;
        for (let v in referrals) {
          if (referrals[v].code === parentCode) {
            referrals[v].earnings += 5;
            client.sendMessage(v, `🔔 Great news! You earned KSH5 as a second-level referral bonus!`);
            break;
          }
        }
      }
      orders[orderID].referralCredited = true;
    }
    client.sendMessage(sender, `✅ Payment confirmed for order ${orderID}!
Your order is now *CONFIRMED*.
✨ Thank you for choosing FYS PROPERTY! For help, call 0701339573.
Type "00" for main menu.`);
    client.sendMessage(`${ADMIN_NUMBER}@c.us`, `🔔 Order ${orderID} marked as CONFIRMED by user ${sender}.`);
    return;
  }
  // ---------- USER: Order Status ("status <ORDER_ID>")
  if (lower.startsWith('status ')) {
    const parts = text.split(' ');
    if (parts.length !== 2)
      return client.sendMessage(sender, '❌ Usage: status <ORDER_ID>');
    const orderID = parts[1];
    if (!orders[orderID])
      return client.sendMessage(sender, `❌ Order ${orderID} not found.`);
    const o = orders[orderID];
    return client.sendMessage(sender,
      `📦 *Order Details*\n
🆔 Order ID: ${o.orderID}
📦 Package: ${o.package}
💰 Amount: KSH ${o.amount}
📞 Recipient: ${o.recipient}
📱 Payment: ${o.payment}
📌 Status: ${o.status}
🕒 Placed at: ${formatKenyaTime(new Date(o.timestamp))}
📝 Remark: ${o.remark || 'None'}
Type "0" or "00" for menus.`
    );
  }
  // ---------- FALLBACK ----------
  client.sendMessage(sender,
    `🤖 *FY'S PROPERTY BOT*
Type "menu" for main menu.
For order status: status <ORDER_ID>
After payment: PAID <ORDER_ID>
For referrals: referral or my referrals
Or "0"/"00" for navigation.`
  );
});

/**
 * =============================
 * EXPRESS SERVER FOR QR CODE
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
