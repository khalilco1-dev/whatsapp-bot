const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const express = require('express');
const QRCode = require('qrcode');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const port = process.env.PORT || 3000;
let qrCodeData = null;

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({
    model: "gemini-1.5-flash",
    systemInstruction: process.env.SYSTEM_PROMPT || "أنت مساعد خدمة عملاء ذكي ومحترف. استقبل استفسارات العملاء بلباقة، وأجب باختصار، واجمع بياناتهم (الاسم، والخدمة أو الاستفسار المطلوب، والموعد المناسب) لتأكيد الحجز."
});

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('./auth_info');
    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            qrCodeData = await QRCode.toDataURL(qr);
            console.log('QR Code ready');
        }
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) startBot();
        } else if (connection === 'open') {
            qrCodeData = null;
            console.log('WhatsApp connected successfully!');
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        const m = messages[0];
        if (!m.message || m.key.fromMe || m.key.remoteJid.endsWith('@g.us')) return;

        const userText = m.message.conversation || m.message.extendedTextMessage?.text;
        if (!userText) return;

        try {
            const result = await model.generateContent(userText);
            const reply = result.response.text();
            await sock.sendMessage(m.key.remoteJid, { text: reply });
        } catch (err) {
            console.error('Gemini error:', err);
        }
    });
}

app.get('/', (req, res) => res.send('Bot is running! Go to /qr to connect.'));
app.get('/qr', (req, res) => {
    if (!qrCodeData) return res.send('<h3>البوت متصل حالياً، أو جاري تجهيز الرمز.. أعد تحديث الصفحة بعد قليل.</h3>');
    res.send(`<html><body style="text-align:center;padding-top:40px;font-family:sans-serif;"><h2>امسح الرمز من واتساب هاتفك</h2><img src="${qrCodeData}" style="width:320px;height:320px;box-shadow:0 0 10px #ccc;border-radius:10px;"/></body></html>`);
});

app.listen(port, () => {
    console.log(`Server on port ${port}`);
    startBot();
});
