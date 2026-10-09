const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const express = require('express');
const QRCode = require('qrcode');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const port = process.env.PORT || 3000;
let qrCodeData = null;

// قائمة لتسجيل أرقام العملاء القادمين من الإعلان لمواصلة المحادثة معهم تلقائياً
const activeCampaignLeads = new Set();

// الكلمات المفتاحية التلقائية للإعلانات
const defaultKeywords = "عرض,حجز,استفسار,تفاصيل,اعلان,إعلان,موعد,كشف,زراعة";
const campaignKeywords = (process.env.CAMPAIGN_KEYWORDS || defaultKeywords)
    .split(',')
    .map(k => k.trim().toLowerCase());

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({
    model: model: "gemini-1.5-flash-latest",
    systemInstruction: process.env.SYSTEM_PROMPT || "أنت مساعد خدمة عملاء ذكي ومحترف. استقبل استفسارات العملاء القادمين من الإعلانات بلباقة، وأجب باختصار ووضوح، واجمع بياناتهم (الاسم، الخدمة أو الاستفسار المطلوب، والوقت المناسب للتواصل) لتأكيد الحجز."
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
            console.log('--- تم تجهيز رمز QR جديد، يرجى مسحه ---');
        }
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('انقطع الاتصال، جاري إعادة المحاولة:', shouldReconnect);
            if (shouldReconnect) startBot();
        } else if (connection === 'open') {
            qrCodeData = null;
            console.log('=== تم اتصال واتساب بالخادم بنجاح! جاهز لاستقبال رسائل الحملات ===');
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

        // فحص هل الرسالة تحتوي على كلمة من كلمات الحملة الإعلانية
        const isCampaignTrigger = campaignKeywords.some(keyword => lowerText.includes(keyword));

        // الرد فقط إذا كانت الرسالة بداية حملة أو عميل إعلان مسجل لدينا مسبقاً
        if (isCampaignTrigger || activeCampaignLeads.has(senderJid)) {
            activeCampaignLeads.add(senderJid);
            console.log(`[عميل إعلان] رسالة من ${senderJid}: "${userText}"`);

            try {
                const result = await model.generateContent(userText);
                const reply = result.response.text();
                await sock.sendMessage(senderJid, { text: reply });
                console.log(`[تم الرد بنجاح بنص Gemini]`);
            } catch (err) {
                console.error('خطأ في استجابة Gemini:', err);
            }
        } else {
            console.log(`[تجاهل] رسالة عادية ليست من حملة إعلانية: ${senderJid}`);
        }
    });
}

app.get('/', (req, res) => res.send('Bot is running! Go to /qr to connect.'));
app.get('/qr', (req, res) => {
    if (!qrCodeData) return res.send('<h3 style="text-align:center;margin-top:50px;">البوت متصل حالياً بنجاح، أو جاري تجهيز الرمز.. أعد تحديث الصفحة بعد ثوانٍ.</h3>');
    res.send(`<html><body style="text-align:center;padding-top:40px;font-family:sans-serif;"><h2>امسح الرمز من واتساب هاتفك</h2><img src="${qrCodeData}" style="width:320px;height:320px;box-shadow:0 0 10px #ccc;border-radius:10px;"/></body></html>`);
});

app.listen(port, () => {
    console.log(`Server listening on port ${port}`);
    startBot();
});
