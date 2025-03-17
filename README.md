# **FY'S PROPERTY WHATSAPP BOT 🚀📲**  
_The Ultimate WhatsApp Bot for Buying Data Bundles & Seamless M-Pesa Payments!_  

![GitHub repo size](https://img.shields.io/github/repo-size/GK-FY/fy-s-property-bot?style=flat-square)  
![GitHub stars](https://img.shields.io/github/stars/GK-FY/fy-s-property-bot?style=flat-square)  
![GitHub forks](https://img.shields.io/github/forks/GK-FY/fy-s-property-bot?style=flat-square)  
![License](https://img.shields.io/github/license/GK-FY/fy-s-property-bot?style=flat-square)  

---

## **🌟 About FY'S PROPERTY BOT**  

FY'S PROPERTY BOT is a **fully automated** WhatsApp bot that allows users to **buy data bundles** directly from WhatsApp. The bot is **highly interactive**, **engaging**, and **secure**, offering a seamless purchasing experience through **M-Pesa payments** via the **PayHero API**.  

With **real-time processing** and **instant confirmations**, this bot ensures that users get their data bundles quickly and efficiently!  

📌 **No need to call agents – Buy data bundles anytime, anywhere with a simple chat!**  

---

## **✨ Features**  

### ✅ **WhatsApp Data Bundle Purchases**  
- Instantly buy data bundles by chatting with the bot  
- **No manual intervention required**  

### ✅ **M-Pesa Integration** 💰  
- Secure **STK Push payments** via **PayHero API**  
- Real-time **payment detection**  
- Instant notifications for successful, failed, or pending payments  

### ✅ **Automatic WhatsApp Web Connection**  
- Login via **QR Code**  
- **Always online** using **PM2 or GitHub Codespaces**  

### ✅ **Interactive & Engaging Chatbot** 🗣️  
- Provides clear **step-by-step instructions**  
- Uses **fun and engaging responses** for a better user experience  

### ✅ **Error Handling & Troubleshooting**  
- Detects **wrong phone numbers**  
- Shows **real-time errors** (e.g., **insufficient funds, wrong PIN, failed transactions**)  

### ✅ **Unique Order System** 🛍️  
- **Every purchase generates a unique order number**  
- Users can **track their orders** via WhatsApp  

### ✅ **Secure & Fast** 🔒⚡  
- Uses **secure payment verification**  
- **Fast processing** ensures quick data delivery  

---

## **🚀 Getting Started**  

### **1️⃣ Installation**  
First, clone the repository and install dependencies:  

```bash
git clone https://github.com/GK-FY/fy-s-property-bot.git
cd fy-s-property-bot
npm install
```

---

### **2️⃣ Configuration**  
Create a `.env` file and add your credentials:  

```env
PORT=5000
PAYHERO_API_KEY=your_payhero_api_key
CHANNEL_ID=your_channel_id
```

---

### **3️⃣ Running the Bot**  
Start the bot with:  

```bash
node bot.js
```

or use **PM2** to keep it online forever:  

```bash
pm2 start bot.js --name "FY'S PROPERTY BOT"
```

---

### **4️⃣ Logging into WhatsApp**  
Once the bot starts, **scan the QR code** on the terminal to connect your WhatsApp account. 🎉  

---

## **🌍 Deployment**  

### **1️⃣ Deploy on Heroku**  

_Ensure you have the Heroku CLI installed._  

```bash
heroku create fy-s-property-bot
heroku config:set PAYHERO_API_KEY=your_payhero_api_key CHANNEL_ID=your_channel_id
git push heroku main
```

Visit your Heroku app, **scan the QR code**, and you're live! 🚀  

---

### **2️⃣ Keeping the Bot Online (24/7)**
Use **PM2** to restart the bot automatically if it crashes:  

```bash
pm2 startup
pm2 save
```

Or deploy it to **GitHub Codespaces** and use a **Keep-Alive Script**.

---

## **💡 How to Use the Bot?**  

1️⃣ **Start Chatting** – Send a message like **"Buy Data"** to the bot.  
2️⃣ **Select a Package** – The bot will show available data bundles.  
3️⃣ **Enter Recipient Number** – Provide the phone number to receive data.  
4️⃣ **Confirm Payment** – You’ll receive an M-Pesa STK push.  
5️⃣ **Order Confirmation** – The bot will confirm your order and process it.  

✅ **That’s it! Your data bundle will be delivered instantly!** 🚀  

---

## **🛠 Troubleshooting**  

### **Bot Not Responding?**  
✔️ Ensure WhatsApp Web is logged in  
✔️ Check if the PayHero API Key is correct  
✔️ Restart the bot and scan the QR again  

### **M-Pesa Payment Issues?**  
✔️ Confirm the payment number and recipient number are valid  
✔️ Check if the PayHero API is up and running  

---

## **👨‍💻 Contributing**  

Want to improve FY'S PROPERTY BOT? 🚀  

1. Fork this repository  
2. Create a feature branch (`git checkout -b feature-branch`)  
3. Commit changes (`git commit -m "Add a new feature"`)  
4. Push to your branch (`git push origin feature-branch`)  
5. Open a pull request  

---

## **📜 License**  

This project is licensed under the **MIT License**. See `LICENSE` for details.  

---

## **📞 Contact & Support**  

🔹 GitHub: [GK-FY/fy-s-property-bot](https://github.com/GK-FY/fy-s-property-bot)  
🔹 WhatsApp Support: [+254701339573](https://wa.me/254701339573)  

💙 **Made with love by FY'S PROPERTY** 💙
