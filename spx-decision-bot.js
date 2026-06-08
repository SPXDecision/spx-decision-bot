require('dotenv').config();

const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const MASSIVE_API_KEY = process.env.MASSIVE_API_KEY;

const bot = new TelegramBot(BOT_TOKEN, { polling: false });

function toNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function getSPXPrice() {
  const url =
    'https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?interval=1m&range=1d';

  const res = await axios.get(url, {
    timeout: 30000,
    headers: {
      'User-Agent': 'Mozilla/5.0'
    }
  });

  const result = res.data?.chart?.result?.[0];

  const price =
    toNumber(result?.meta?.regularMarketPrice) ||
    toNumber(result?.meta?.previousClose);

  return price;
}

async function testMassiveSPXOptions() {
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
    const massiveCount = await testMassiveSPXOptions();

    const msg =
`✅ اختبار SPX Decision Bot نجح

💰 سعر SPX:
${spxPrice || 'غير متاح'}

📡 Massive Options:
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
