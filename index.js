const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const express = require('express');
const QRCode = require('qrcode');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const port = process.env.PORT || 8000;
let qrCodeData = null;

// تتبع العملاء وسجل محادثاتهم
const activeCampaignLeads = new Set();
const chatSessions = new Map();

const defaultKeywords = "عرض,حجز,استفسار,تفاصيل,اعلان,إعلان,موعد,كشف,زراعة";
const campaignKeywords = (process.env.CAMPAIGN_KEYWORDS || defaultKeywords)
    .split(',')
    .map(k => k.trim().toLowerCase());

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");
const model = genAI.getGenerativeModel({
    model: "gemini-3-flash-preview",
    systemInstruction: process.env.SYSTEM_PROMPT || "أنت المساعد الشخصي للدكتور خليل عوض يوسف. أجب باختصار شديد ولباقة."
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
            console.log('--- تم تجهيز رمز QR جديد ---');
        }
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) startBot();
        } else if (connection === 'open') {
            qrCodeData = null;
            console.log('=== تم اتصال واتساب بالخادم بنجاح! ===');
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        const m = messages[0];
        if (!m.message || m.key.fromMe || m.key.remoteJid.endsWith('@g.us')) return;

        const userText = (m.message.conversation || m.message.extendedTextMessage?.text || "").trim();
        if (!userText) return;

        const senderJid = m.key.remoteJid;
        const lowerText = userText.toLowerCase();
        const isCampaignTrigger = campaignKeywords.some(keyword => lowerText.includes(keyword));

        // التحقق من أن الرسالة من حملة إعلانية أو محادثة مستمرة
        if (isCampaignTrigger || activeCampaignLeads.has(senderJid)) {
            const isFirstMessage = !activeCampaignLeads.has(senderJid);
            activeCampaignLeads.add(senderJid);

            // استرجاع جلسة المحادثة التفاعلية
            if (!chatSessions.has(senderJid)) {
                chatSessions.set(senderJid, model.startChat());
            }
            const chat = chatSessions.get(senderJid);

            try {
                // توجيه إضافي خفيف للتأكيد على الاختصار وعدم تكرار الترحيب بعد المرة الأولى
                const promptModifier = isFirstMessage 
                    ? `[ملاحظة: هذه أول رسالة للمريض، رحب به بإيجاز إماراتي وأجب باختصار]: ${userText}`
                    : `[ملاحظة: محادثة مستمرة، ادخل في الجواب مباشرة باختصار بدون تكرار ترحيب أو ديباجة]: ${userText}`;

                const result = await chat.sendMessage(promptModifier);
                const reply = result.response.text();
                await sock.sendMessage(senderJid, { text: reply });
                console.log(`تم الرد باختصار على: ${senderJid}`);
            } catch (err) {
                console.error('خطأ في استجابة Gemini:', err.message);
            }
        }
    });
}

app.get('/', (req, res) => res.send('Bot is running! Go to /qr'));
app.get('/qr', (req, res) => {
    if (!qrCodeData) return res.send('<h3 style="text-align:center;margin-top:50px;font-family:sans-serif;">البوت متصل حالياً بنجاح!</h3>');
    res.send(`<html><body style="text-align:center;padding-top:40px;font-family:sans-serif;"><h2>امسح الرمز من واتساب هاتفك</h2><img src="${qrCodeData}" style="width:320px;height:320px;border-radius:10px;box-shadow:0 0 10px #ccc;"/></body></html>`);
});

app.listen(port, () => {
    console.log(`Server listening on port ${port}`);
    startBot();
});
