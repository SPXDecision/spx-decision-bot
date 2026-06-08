require('dotenv').config();

const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const MASSIVE_API_KEY = process.env.MASSIVE_API_KEY;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const CHECK_INTERVAL_MS = Number(process.env.CHECK_INTERVAL_MS || 30000);
const MIN_VOLUME = Number(process.env.MIN_VOLUME || 100);
const MIN_SCORE = Number(process.env.MIN_SCORE || 80);
const PROFIT_STEP = Number(process.env.PROFIT_STEP || 0.30);
const OPTION_STOP_PCT = Number(process.env.OPTION_STOP_PCT || 25);
const SIGNAL_COOLDOWN_MS = Number(process.env.SIGNAL_COOLDOWN_MS || 5 * 60 * 1000);

const bot = new TelegramBot(BOT_TOKEN, { polling: false });

const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY
);

let lastSignalKey = '';
let lastSignalAt = 0;
let isRunning = false;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function toNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function fmt(n, digits = 2) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return 'غير متاح';
  return Number(n).toLocaleString('en-US', { maximumFractionDigits: digits });
}

function pct(n) {
  if (!Number.isFinite(Number(n))) return 'غير متاح';
  return `${Number(n).toFixed(1)}%`;
}

function getDateRange() {
  const today = new Date();
  const end = new Date();
  end.setDate(today.getDate() + 7);

  return {
    fromDate: today.toISOString().slice(0, 10),
    toDate: end.toISOString().slice(0, 10)
  };
}

async function getSPXPrice() {
  const url =
    'https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?interval=1m&range=1d';

  const res = await axios.get(url, {
    timeout: 30000,
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Accept': 'application/json'
    }
  });

  const result = res.data?.chart?.result?.[0];

  const price =
    toNumber(result?.meta?.regularMarketPrice) ||
    toNumber(result?.meta?.previousClose);

  if (!price) {
    throw new Error('Yahoo SPX price unavailable');
  }

  return price;
}

function getContractType(c) {
  return String(c?.details?.contract_type || '').toLowerCase();
}

function getStrike(c) {
  return toNumber(c?.details?.strike_price);
}

function getExpiration(c) {
  return c?.details?.expiration_date || null;
}

function getTicker(c) {
  return c?.details?.ticker || c?.ticker || null;
}

function getGamma(c) {
  return toNumber(c?.greeks?.gamma);
}

function getOpenInterest(c) {
  return toNumber(c?.open_interest);
}

function getVolume(c) {
  return toNumber(c?.day?.volume);
}

function getBid(c) {
  return toNumber(c?.last_quote?.bid);
}

function getAsk(c) {
  return toNumber(c?.last_quote?.ask);
}

function getLastTrade(c) {
  return toNumber(c?.last_trade?.price);
}

function getOptionPrice(c) {
  const bid = getBid(c);
  const ask = getAsk(c);
  const last = getLastTrade(c);

  if (bid !== null && ask !== null && bid > 0 && ask > 0) {
    return (bid + ask) / 2;
  }

  if (last !== null && last > 0) return last;
  if (ask !== null && ask > 0) return ask;
  if (bid !== null && bid > 0) return bid;

  return null;
}

function getSpreadPct(c) {
  const bid = getBid(c);
  const ask = getAsk(c);

  if (bid === null || ask === null || bid <= 0 || ask <= 0) return null;

  const mid = (bid + ask) / 2;
  return mid > 0 ? ((ask - bid) / mid) * 100 : null;
}

async function getSPXOptionsChain() {
  const { fromDate, toDate } = getDateRange();
  const MAX_PAGES = Number(process.env.MAX_PAGES || 20);

  let url =
    `https://api.massive.com/v3/snapshot/options/I:SPX` +
    `?order=asc&limit=250&sort=ticker` +
    `&expiration_date.gte=${fromDate}` +
    `&expiration_date.lte=${toDate}` +
    `&apiKey=${MASSIVE_API_KEY}`;

  const allContracts = [];
  let page = 1;

  while (url && page <= MAX_PAGES) {
    console.log(`Fetching SPX page ${page}...`);

    const res = await axios.get(url, { timeout: 90000 });
    const results = res.data?.results || [];

    allContracts.push(...results);

    url = res.data?.next_url || null;

    if (url && !url.includes('apiKey=')) {
      url += `${url.includes('?') ? '&' : '?'}apiKey=${MASSIVE_API_KEY}`;
    }

    page++;
    await sleep(150);
  }

  return allContracts;
}
function analyzeSPX(contracts) {
  const usable = contracts.filter(c => {
    const type = getContractType(c);
    const strike = getStrike(c);
    const gamma = getGamma(c);
    const oi = getOpenInterest(c);
    const volume = getVolume(c);

    return (
      (type === 'call' || type === 'put') &&
      strike !== null &&
      gamma !== null &&
      oi !== null &&
      oi > 0 &&
      volume !== null &&
      volume >= MIN_VOLUME
    );
  });

  const strikeMap = new Map();

  let totalCallVolume = 0;
  let totalPutVolume = 0;

  for (const c of usable) {
    const type = getContractType(c);
    const strike = getStrike(c);
    const gamma = getGamma(c);
    const oi = getOpenInterest(c);
    const volume = getVolume(c) || 0;
    const gammaPower = gamma * oi * 100;

    if (!strikeMap.has(strike)) {
      strikeMap.set(strike, {
        strike,
        callGammaPower: 0,
        putGammaPower: 0,
        totalGammaPower: 0,
        callOI: 0,
        putOI: 0,
        callVolume: 0,
        putVolume: 0
      });
    }

    const row = strikeMap.get(strike);

    row.totalGammaPower += gammaPower;

    if (type === 'call') {
      row.callGammaPower += gammaPower;
      row.callOI += oi;
      row.callVolume += volume;
      totalCallVolume += volume;
    }

    if (type === 'put') {
      row.putGammaPower += gammaPower;
      row.putOI += oi;
      row.putVolume += volume;
      totalPutVolume += volume;
    }
  }

  const rows = [...strikeMap.values()];

  const strongestCall =
    rows.slice().sort((a, b) => b.callGammaPower - a.callGammaPower)[0] || null;

  const strongestPut =
    rows.slice().sort((a, b) => b.putGammaPower - a.putGammaPower)[0] || null;

  const strongestMagnet =
    rows.slice().sort((a, b) => b.totalGammaPower - a.totalGammaPower)[0] || null;

  const topCallLiquidity =
    rows.filter(r => r.callVolume > 0).sort((a, b) => b.callVolume - a.callVolume).slice(0, 3);

  const topPutLiquidity =
    rows.filter(r => r.putVolume > 0).sort((a, b) => b.putVolume - a.putVolume).slice(0, 3);

  const totalCallGamma = rows.reduce((sum, r) => sum + r.callGammaPower, 0);
  const totalPutGamma = rows.reduce((sum, r) => sum + r.putGammaPower, 0);
  const netGamma = totalCallGamma - totalPutGamma;

  const totalFlowVolume = totalCallVolume + totalPutVolume;
  const callFlowPct = totalFlowVolume > 0 ? (totalCallVolume / totalFlowVolume) * 100 : 0;
  const putFlowPct = totalFlowVolume > 0 ? (totalPutVolume / totalFlowVolume) * 100 : 0;

  let flowBias = 'متوازن';
  if (callFlowPct >= 55) flowBias = 'CALL';
  if (putFlowPct >= 55) flowBias = 'PUT';

  const callWall = strongestCall?.strike || null;
  const putWall = strongestPut?.strike || null;
  const magnet = strongestMagnet?.strike || null;

  let decisionLow = putWall;
  let decisionHigh = callWall;
  let isTightZone = false;

  if (callWall && putWall && Math.abs(callWall - putWall) <= 10) {
    decisionLow = Math.min(callWall, putWall);
    decisionHigh = Math.max(callWall, putWall);
    isTightZone = true;
  }

  return {
    usableCount: usable.length,
    strikeCount: rows.length,
    netGamma,
    gammaState: netGamma >= 0 ? 'POSITIVE' : 'NEGATIVE',
    totalCallVolume,
    totalPutVolume,
    callFlowPct,
    putFlowPct,
    flowBias,
    callWall,
    putWall,
    magnet,
    decisionLow,
    decisionHigh,
    isTightZone,
    topCallLiquidity,
    topPutLiquidity
  };
}

function buildTradeDecision(spxPrice, a) {
  if (!spxPrice || !a.decisionLow || !a.decisionHigh) {
    return { side: 'NO_TRADE', score: 0, reason: 'بيانات غير مكتملة' };
  }

  let side = 'NO_TRADE';
  let score = 0;
  const reasons = [];

  if (spxPrice < a.decisionLow) {
    side = 'PUT';
    score += 30;
    reasons.push(`السعر كسر أدنى منطقة القرار ${fmt(a.decisionLow, 2)}`);

    if (a.putFlowPct >= 55) {
      score += 25;
      reasons.push(`سيطرة البوت ${pct(a.putFlowPct)}`);
    }

    if (a.netGamma < 0) {
      score += 25;
      reasons.push('قاما سلبية تدعم التذبذب والضغط الهابط');
    }

    if ((a.topPutLiquidity?.[0]?.putVolume || 0) > (a.topCallLiquidity?.[0]?.callVolume || 0) * 0.8) {
      score += 20;
      reasons.push('سيولة البوت قوية مقارنة بالكول');
    }
  }

  if (spxPrice > a.decisionHigh) {
    side = 'CALL';
    score += 30;
    reasons.push(`السعر اخترق أعلى منطقة القرار ${fmt(a.decisionHigh, 2)}`);

    if (a.callFlowPct >= 55) {
      score += 25;
      reasons.push(`سيطرة الكول ${pct(a.callFlowPct)}`);
    }

    if (a.netGamma > 0) {
      score += 25;
      reasons.push('قاما إيجابية تدعم الاستقرار الصاعد');
    } else if (a.callFlowPct >= 65) {
      score += 15;
      reasons.push('رغم القاما السلبية، سيولة الكول قوية');
    }

    if ((a.topCallLiquidity?.[0]?.callVolume || 0) > (a.topPutLiquidity?.[0]?.putVolume || 0) * 0.8) {
      score += 20;
      reasons.push('سيولة الكول قوية مقارنة بالبوت');
    }
  }

  if (spxPrice >= a.decisionLow && spxPrice <= a.decisionHigh) {
    return {
      side: 'NO_TRADE',
      score: 0,
      reason: 'السعر داخل منطقة التوازن، لا توجد صفقة'
    };
  }

  if (score < MIN_SCORE) {
    return {
      side: 'NO_TRADE',
      score,
      reason: `الإشارة ضعيفة، السكور ${score}/100`
    };
  }

  return {
    side,
    score,
    reasons
  };
}
function selectBestOptionContract(contracts, side, spxPrice) {
  const wantedType = side === 'CALL' ? 'call' : 'put';

  const candidates = contracts
    .map(c => {
      const type = getContractType(c);
      const strike = getStrike(c);
      const volume = getVolume(c) || 0;
      const oi = getOpenInterest(c) || 0;
      const price = getOptionPrice(c);
      const spreadPct = getSpreadPct(c);
      const ticker = getTicker(c);
      const expiration = getExpiration(c);

      return {
        contract: c,
        type,
        strike,
        volume,
        oi,
        price,
        spreadPct,
        ticker,
        expiration
      };
    })
    .filter(x => {
      if (x.type !== wantedType) return false;
      if (!x.ticker || !x.expiration) return false;
      if (x.strike === null || x.price === null || x.price <= 0) return false;
      if (x.volume < MIN_VOLUME) return false;
      if (x.spreadPct !== null && x.spreadPct > 35) return false;

      const distance = Math.abs(x.strike - spxPrice);
      return distance <= 100;
    })
    .sort((a, b) => {
      const expA = String(a.expiration);
      const expB = String(b.expiration);

      if (expA !== expB) return expA.localeCompare(expB);

      const distA = Math.abs(a.strike - spxPrice);
      const distB = Math.abs(b.strike - spxPrice);

      if (distA !== distB) return distA - distB;

      return b.volume - a.volume;
    });

  return candidates[0] || null;
}

async function getActiveTrade() {
  const { data, error } = await supabase
    .from('spx_decision_trades')
    .select('*')
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error('getActiveTrade error:', error.message);
    return null;
  }

  return data || null;
}

async function saveNewTrade(signal, optionData, spxPrice, analysis) {
  const optionEntry = optionData.price;
  const stopPrice = optionEntry * (1 - OPTION_STOP_PCT / 100);

  const row = {
    status: 'active',
    side: signal.side,

    spx_entry: spxPrice,
    spx_current: spxPrice,

    option_ticker: optionData.ticker,
    option_entry: optionEntry,
    option_current: optionEntry,
    option_high: optionEntry,
    option_low: optionEntry,

    stop_price: stopPrice,
    tp1: optionEntry + PROFIT_STEP,
    tp2: optionEntry + PROFIT_STEP * 2,

    max_profit_amount: 0,
    max_profit_pct: 0,
    last_profit_step: 0,

    close_reason: null
  };

  const { data, error } = await supabase
    .from('spx_decision_trades')
    .insert(row)
    .select()
    .single();

  if (error) {
    console.error('saveNewTrade error:', error.message);
    throw error;
  }

  return data;
}

async function updateTrade(id, patch) {
  const { error } = await supabase
    .from('spx_decision_trades')
    .update(patch)
    .eq('id', id);

  if (error) {
    console.error('updateTrade error:', error.message);
  }
}

function buildTradeMessage(signal, spxPrice, analysis, optionData) {
  const isCall = signal.side === 'CALL';
  const stopPrice = optionData.price * (1 - OPTION_STOP_PCT / 100);

  return (
`🚨 SPX Trade Setup

${isCall ? '📈 CALL' : '📉 PUT'}

💰 سعر SPX:
${fmt(spxPrice, 2)}

📄 العقد:
${optionData.ticker}

💵 دخول العقد:
${fmt(optionData.price, 2)}

🛑 وقف العقد:
${fmt(stopPrice, 2)}

🔥 الثقة:
${signal.score}/100

━━━━━━━━━━━━━━

🎯 منطقة القرار:
${fmt(analysis.decisionLow, 2)} - ${fmt(analysis.decisionHigh, 2)}

🧲 Magnet:
${fmt(analysis.magnet, 2)}

🟢 Call Wall:
${fmt(analysis.callWall, 2)}

🔴 Put Wall:
${fmt(analysis.putWall, 2)}

━━━━━━━━━━━━━━

💰 السيولة:
🟢 Call Flow: ${pct(analysis.callFlowPct)}
🔴 Put Flow: ${pct(analysis.putFlowPct)}

📊 صافي القاما:
${fmt(analysis.netGamma, 2)}

━━━━━━━━━━━━━━

📍 أسباب الصفقة:
${signal.reasons.map(x => `• ${x}`).join('\n')}

━━━━━━━━━━━━━━

🎯 تحديثات الربح:
كل +${fmt(PROFIT_STEP, 2)} على العقد

⚠️ ليست توصية شراء أو بيع.
راقب التنفيذ وإدارة المخاطر.`
  );
}

function buildProfitUpdateMessage(trade, currentPrice, profitAmount, profitPct) {
  return (
`📈 تحديث صفقة SPX ${trade.side}

📄 العقد:
${trade.option_ticker}

💵 الدخول:
${fmt(trade.option_entry, 2)}

💰 السعر الحالي:
${fmt(currentPrice, 2)}

✅ الربح الحالي:
+${fmt(profitAmount, 2)}

📊 نسبة الربح:
+${fmt(profitPct, 1)}%`
  );
}
function buildStopMessage(trade, currentPrice, maxProfitAmount, maxProfitPct) {
  const hadProfit = maxProfitAmount > 0;

  if (hadProfit) {
    return (
`🛑 تم ضرب وقف صفقة SPX ${trade.side}

📄 العقد:
${trade.option_ticker}

💵 الدخول:
${fmt(trade.option_entry, 2)}

🛑 الوقف:
${fmt(trade.stop_price, 2)}

💰 السعر الحالي:
${fmt(currentPrice, 2)}

📌 ملاحظة:
الصفقة حققت قبل الوقف أعلى ربح:
+${fmt(maxProfitAmount, 2)}

📊 أعلى نسبة ربح:
+${fmt(maxProfitPct, 1)}%`
    );
  }

  return (
`🛑 تم ضرب وقف صفقة SPX ${trade.side}

📄 العقد:
${trade.option_ticker}

💵 الدخول:
${fmt(trade.option_entry, 2)}

🛑 الوقف:
${fmt(trade.stop_price, 2)}

💰 السعر الحالي:
${fmt(currentPrice, 2)}

📌 لم تحقق الصفقة ربحاً قبل الوقف.`
  );
}

async function manageActiveTrade(trade, contracts, spxPrice) {
  const option = contracts.find(c => getTicker(c) === trade.option_ticker);

  if (!option) {
    console.log('Active option not found in current chain:', trade.option_ticker);
    return;
  }

  const currentPrice = getOptionPrice(option);

  if (currentPrice === null || currentPrice <= 0) {
    console.log('No current option price for:', trade.option_ticker);
    return;
  }

  const optionEntry = Number(trade.option_entry);
  const profitAmount = currentPrice - optionEntry;
  const profitPct = optionEntry > 0 ? (profitAmount / optionEntry) * 100 : 0;

  const oldHigh = Number(trade.option_high || optionEntry);
  const oldLow = Number(trade.option_low || optionEntry);

  const newHigh = Math.max(oldHigh, currentPrice);
  const newLow = Math.min(oldLow, currentPrice);

  const maxProfitAmount = Math.max(Number(trade.max_profit_amount || 0), newHigh - optionEntry);
  const maxProfitPct = optionEntry > 0 ? (maxProfitAmount / optionEntry) * 100 : 0;

  const lastProfitStep = Number(trade.last_profit_step || 0);
  const currentStep = profitAmount > 0
    ? Math.floor(profitAmount / PROFIT_STEP) * PROFIT_STEP
    : 0;

  await updateTrade(trade.id, {
    spx_current: spxPrice,
    option_current: currentPrice,
    option_high: newHigh,
    option_low: newLow,
    max_profit_amount: maxProfitAmount,
    max_profit_pct: maxProfitPct
  });

  if (currentStep > lastProfitStep) {
    await bot.sendMessage(
      ADMIN_CHAT_ID,
      buildProfitUpdateMessage(trade, currentPrice, profitAmount, profitPct)
    );

    await updateTrade(trade.id, {
      last_profit_step: currentStep
    });
  }

  if (currentPrice <= Number(trade.stop_price)) {
    await bot.sendMessage(
      ADMIN_CHAT_ID,
      buildStopMessage(trade, currentPrice, maxProfitAmount, maxProfitPct)
    );

    await updateTrade(trade.id, {
      status: 'closed',
      option_current: currentPrice,
      spx_current: spxPrice,
      option_high: newHigh,
      option_low: newLow,
      max_profit_amount: maxProfitAmount,
      max_profit_pct: maxProfitPct,
      closed_at: new Date().toISOString(),
      close_reason: 'stop_loss'
    });
  }
}

async function runCycle() {
  if (isRunning) {
    console.log('Previous cycle still running, skipped.');
    return;
  }

  isRunning = true;

  try {
    const spxPrice = await getSPXPrice();
    const contracts = await getSPXOptionsChain();
    const analysis = analyzeSPX(contracts);

    const activeTrade = await getActiveTrade();

    if (activeTrade) {
      console.log('Managing active trade:', activeTrade.option_ticker);
      await manageActiveTrade(activeTrade, contracts, spxPrice);
      return;
    }

    const signal = buildTradeDecision(spxPrice, analysis);

    console.log(
      `SPX ${spxPrice} | Signal: ${signal.side} | Score: ${signal.score}`
    );

    if (signal.side === 'NO_TRADE') {
      console.log(signal.reason);
      return;
    }

    const signalKey = `${signal.side}-${analysis.decisionLow}-${analysis.decisionHigh}`;
    const now = Date.now();

    if (signalKey === lastSignalKey && now - lastSignalAt < SIGNAL_COOLDOWN_MS) {
      console.log('Duplicate signal skipped.');
      return;
    }

    const optionData = selectBestOptionContract(
      contracts,
      signal.side,
      spxPrice
    );

    if (!optionData) {
      console.log('No suitable option contract found.');
      return;
    }

    const savedTrade = await saveNewTrade(
      signal,
      optionData,
      spxPrice,
      analysis
    );

    lastSignalKey = signalKey;
    lastSignalAt = now;

    const msg = buildTradeMessage(
      signal,
      spxPrice,
      analysis,
      optionData
    );

    await bot.sendMessage(ADMIN_CHAT_ID, msg);

    console.log('New trade saved:', savedTrade.id);
  } catch (err) {
    console.error('ERROR MESSAGE:', err?.message);
console.error('ERROR DATA:', err?.response?.data);
console.error('ERROR STACK:', err?.stack);
console.error(err);

    try {
      await bot.sendMessage(
        ADMIN_CHAT_ID,
        `❌ فشل SPX Decision Bot\n\n${err?.response?.data?.error || err.message}`
      );
    } catch {}
  } finally {
    isRunning = false;
  }
}

runCycle();
setInterval(runCycle, CHECK_INTERVAL_MS);
