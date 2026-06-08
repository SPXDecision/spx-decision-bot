require('dotenv').config();

const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const MASSIVE_API_KEY = process.env.MASSIVE_API_KEY;
const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;

const bot = new TelegramBot(BOT_TOKEN, { polling: false });

async function getSPXPrice() {
  const url = `https://finnhub.io/api/v1/quote?symbol=^SPX&token=${FINNHUB_API_KEY}`;
  const res = await axios.get(url, { timeout: 30000 });
  return Number(res.data?.c);
}

async function testMassiveSPX() {
  const url =
    `https://api.massive.com/v3/snapshot/options/I:SPX` +
    `?order=asc&limit=10&sort=ticker` +
    `&apiKey=${MASSIVE_API_KEY}`;

  const res = await axios.get(url, { timeout: 30000 });
  return res.data?.results?.length || 0;
}

async function main() {
  try {
    const spxPrice = await getSPXPrice();
    const massiveCount = await testMassiveSPX();

    const msg =
`✅ اختبار SPX Decision Bot نجح

💰 سعر SPX:
${spxPrice || 'غير متاح'}

📡 Massive:
تم سحب ${massiveCount} عقود تجريبية

✅ البوت جاهز للمرحلة التالية`;

    console.log(msg);
    await bot.sendMessage(ADMIN_CHAT_ID, msg);
  } catch (err) {
    console.error(err?.response?.data || err.message);

    await bot.sendMessage(
      ADMIN_CHAT_ID,
      `❌ فشل اختبار SPX Decision Bot\n\n${err?.response?.data?.error || err.message}`
    );
  }
}

main();
