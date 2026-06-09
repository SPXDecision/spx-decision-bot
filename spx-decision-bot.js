require('dotenv').config();

const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const MASSIVE_API_KEY = process.env.MASSIVE_API_KEY;
const FMP_API_KEY = process.env.FMP_API_KEY;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const CHECK_INTERVAL_MS = Number(process.env.CHECK_INTERVAL_MS || 30000);

const MIN_VOLUME = Number(process.env.MIN_VOLUME || 100);
const MIN_OI = Number(process.env.MIN_OI || 500);

const MIN_WATCH_SCORE = Number(process.env.MIN_WATCH_SCORE || 60);
const MIN_ACTIVATION_SCORE = Number(process.env.MIN_ACTIVATION_SCORE || 80);

const PROFIT_STEP = Number(process.env.PROFIT_STEP || 0.30);
const OPTION_STOP_PCT = Number(process.env.OPTION_STOP_PCT || 25);
const SIGNAL_COOLDOWN_MS = Number(process.env.SIGNAL_COOLDOWN_MS || 5 * 60 * 1000);
const MAX_PAGES = Number(process.env.MAX_PAGES || 20);

const MIN_OPTION_PRICE = Number(process.env.MIN_OPTION_PRICE || 1.50);
const MAX_OPTION_PRICE = Number(process.env.MAX_OPTION_PRICE || 3.20);
const MAX_OPTION_PRICE_AT_ACTIVATION = Number(process.env.MAX_OPTION_PRICE_AT_ACTIVATION || 3.50);

const MIN_DELTA = Number(process.env.MIN_DELTA || 0.25);
const MAX_DELTA = Number(process.env.MAX_DELTA || 0.50);
const MAX_SPREAD_PCT = Number(process.env.MAX_SPREAD_PCT || 15);
const MAX_STRIKE_DISTANCE = Number(process.env.MAX_STRIKE_DISTANCE || 20);

const DECISION_NEAR_POINTS = Number(process.env.DECISION_NEAR_POINTS || 15);

const bot = new TelegramBot(BOT_TOKEN, { polling: false });
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

bot.sendMessage(
  ADMIN_CHAT_ID,
  '✅ SPX Decision Bot شغال الآن\n\nتم تشغيل البوت ومراقبة SPX بدأت.'
).catch(err => {
  console.error('START MESSAGE ERROR:', err.message);
});

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

function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

async function getSPXPrice() {
  const url =
    `https://financialmodelingprep.com/stable/quote?symbol=%5EGSPC&apikey=${FMP_API_KEY}`;

  const res = await axios.get(url, { timeout: 30000 });
  const row = res.data?.[0];

  const price = Number(row?.price) || Number(row?.previousClose);

  if (!price) {
    throw new Error('FMP SPX price unavailable');
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

function getDelta(c) {
  const d = toNumber(c?.greeks?.delta);
  return d === null ? null : Math.abs(d);
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

function buildContractLabel(optionData) {
  const sideLetter = optionData.type === 'call' ? 'C' : 'P';
  return `SPX ${fmt(optionData.strike, 0)}${sideLetter}`;
}

async function getSPXOptionsChain() {
  const today = todayDate();

  let url =
    `https://api.massive.com/v3/snapshot/options/I:SPX` +
    `?order=asc&limit=250&sort=ticker` +
    `&expiration_date=${today}` +
    `&apiKey=${MASSIVE_API_KEY}`;

  const allContracts = [];
  let page = 1;

  while (url && page <= MAX_PAGES) {
    console.log(`Fetching SPX 0DTE page ${page}...`);

    const res = await axios.get(url, { timeout: 90000 });
    const results = res.data?.results || [];

    console.log(`Page ${page}: ${results.length} contracts`);
    allContracts.push(...results);

    url = res.data?.next_url || null;

    if (url && !url.includes('apiKey=')) {
      url += `${url.includes('?') ? '&' : '?'}apiKey=${MASSIVE_API_KEY}`;
    }

    page++;
    await sleep(150);
  }

  console.log(`Total 0DTE contracts loaded: ${allContracts.length}`);
  return allContracts;
}

function analyzeSPX(contracts, spxPrice) {
  const today = todayDate();

  const usable = contracts.filter(c => {
    const type = getContractType(c);
    const strike = getStrike(c);
    const gamma = getGamma(c);
    const oi = getOpenInterest(c);
    const volume = getVolume(c);
    const expiration = getExpiration(c);

    return (
      expiration === today &&
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

  const belowPrice = rows
    .filter(r => Number(r.strike) < Number(spxPrice))
    .sort((a, b) => b.strike - a.strike);

  const abovePrice = rows
    .filter(r => Number(r.strike) > Number(spxPrice))
    .sort((a, b) => a.strike - b.strike);

  const nearestSupport =
    belowPrice.slice().sort((a, b) => b.totalGammaPower - a.totalGammaPower)[0] || null;

  const nearestResistance =
    abovePrice.slice().sort((a, b) => b.totalGammaPower - a.totalGammaPower)[0] || null;
   const topCallLiquidity =
    rows.filter(r => r.callVolume > 0)
      .sort((a, b) => b.callVolume - a.callVolume)
      .slice(0, 3);

  const topPutLiquidity =
    rows.filter(r => r.putVolume > 0)
      .sort((a, b) => b.putVolume - a.putVolume)
      .slice(0, 3);

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

  let decisionLow = nearestSupport?.strike || putWall;
  let decisionHigh = nearestResistance?.strike || callWall;
  let isTightZone = false;

  if (decisionLow && decisionHigh && Math.abs(decisionHigh - decisionLow) <= 10) {
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
    nearestSupport: nearestSupport?.strike || null,
    nearestResistance: nearestResistance?.strike || null,
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

  if (spxPrice <= a.decisionLow + DECISION_NEAR_POINTS) {
    side = 'PUT';
    score += 30;
    reasons.push(`السعر قريب من كسر منطقة القرار ${fmt(a.decisionLow, 2)}`);

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

  if (spxPrice >= a.decisionHigh - DECISION_NEAR_POINTS) {
    side = 'CALL';
    score += 30;
    reasons.push(`السعر قريب من اختراق منطقة القرار ${fmt(a.decisionHigh, 2)}`);

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

  if (score < MIN_WATCH_SCORE) {
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

function scoreOptionCandidate(x, spxPrice) {
  const deltaScore = 1 - Math.min(Math.abs((x.delta || 0) - 0.35) / 0.25, 1);
  const volumeScore = Math.min((x.volume || 0) / 5000, 1);
  const oiScore = Math.min((x.oi || 0) / 5000, 1);
  const spreadScore = 1 - Math.min((x.spreadPct || 100) / MAX_SPREAD_PCT, 1);
  const gammaScore = Math.min(Math.abs(x.gamma || 0) / 0.05, 1);

  let priceScore = 0.5;

  if (x.price >= 2.00 && x.price <= 2.50) {
    priceScore = 1;
  } else if (x.price >= 1.80 && x.price <= 2.80) {
    priceScore = 0.8;
  } else if (x.price >= MIN_OPTION_PRICE && x.price <= MAX_OPTION_PRICE) {
    priceScore = 0.6;
  }

  const distance = Math.abs(x.strike - spxPrice);
  const distanceScore = 1 - Math.min(distance / MAX_STRIKE_DISTANCE, 1);

  return (
    deltaScore * 30 +
    volumeScore * 20 +
    oiScore * 15 +
    spreadScore * 15 +
    gammaScore * 10 +
    priceScore * 10 +
    distanceScore * 5
  );
} 
function selectBestOptionContract(contracts, side, spxPrice) {
  const wantedType = side === 'CALL' ? 'call' : 'put';
  const today = todayDate();

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
      const delta = getDelta(c);
      const gamma = getGamma(c);
      const bid = getBid(c);
      const ask = getAsk(c);
      const last = getLastTrade(c);

      return {
        contract: c,
        type,
        strike,
        volume,
        oi,
        price,
        spreadPct,
        ticker,
        expiration,
        delta,
        gamma,
        bid,
        ask,
        last
      };
    })
    .filter(x => {
      if (x.expiration !== today) return false;
      if (x.type !== wantedType) return false;
      if (!x.ticker || !x.expiration) return false;
      if (x.strike === null || x.price === null || x.price <= 0) return false;

      if (x.volume < MIN_VOLUME) return false;
      if (x.oi < MIN_OI) return false;

      if (x.price < MIN_OPTION_PRICE || x.price > MAX_OPTION_PRICE) return false;
      if (x.delta === null || x.delta < MIN_DELTA || x.delta > MAX_DELTA) return false;
      if (x.spreadPct === null || x.spreadPct > MAX_SPREAD_PCT) return false;

      const distance = Math.abs(x.strike - spxPrice);
      return distance <= MAX_STRIKE_DISTANCE;
    })
    .map(x => ({
      ...x,
      optionScore: scoreOptionCandidate(x, spxPrice)
    }))
    .sort((a, b) => b.optionScore - a.optionScore);

  return candidates[0] || null;
}

function getActivationLevel(side, analysis) {
  return side === 'CALL' ? analysis.decisionHigh : analysis.decisionLow;
}

function uniqueSortedLevels(levels, side, activationPrice) {
  const clean = [...new Set(
    levels
      .filter(v => Number.isFinite(Number(v)))
      .map(Number)
  )];

  if (side === 'CALL') {
    return clean
      .filter(v => v > activationPrice)
      .sort((a, b) => a - b);
  }

  return clean
    .filter(v => v < activationPrice)
    .sort((a, b) => b - a);
}

function getSPXTargets(side, activationPrice, analysis) {
  const callLiquidityLevels = (analysis.topCallLiquidity || []).map(x => x.strike);
  const putLiquidityLevels = (analysis.topPutLiquidity || []).map(x => x.strike);

  if (side === 'CALL') {
    const targets = uniqueSortedLevels(
      [
        analysis.magnet,
        analysis.callWall,
        analysis.decisionHigh,
        ...callLiquidityLevels
      ],
      side,
      activationPrice
    );

    const stops = [
      analysis.decisionLow,
      analysis.putWall,
      analysis.magnet
    ]
      .filter(v => Number.isFinite(Number(v)) && Number(v) < activationPrice)
      .map(Number)
      .sort((a, b) => b - a);

    return {
      tp1: targets[0] || activationPrice + 10,
      tp2: targets[1] || targets[0] || activationPrice + 20,
      tp3: targets[2] || targets[1] || targets[0] || activationPrice + 30,
      stop: stops[0] || activationPrice - 10
    };
  }

  const targets = uniqueSortedLevels(
    [
      analysis.magnet,
      analysis.putWall,
      analysis.decisionLow,
      ...putLiquidityLevels
    ],
    side,
    activationPrice
  );

  const stops = [
    analysis.decisionHigh,
    analysis.callWall,
    analysis.magnet
  ]
    .filter(v => Number.isFinite(Number(v)) && Number(v) > activationPrice)
    .map(Number)
    .sort((a, b) => a - b);

  return {
    tp1: targets[0] || activationPrice - 10,
    tp2: targets[1] || targets[0] || activationPrice - 20,
    tp3: targets[2] || targets[1] || targets[0] || activationPrice - 30,
    stop: stops[0] || activationPrice + 10
  };
}

async function getTradeByStatuses(statuses) {
  const { data, error } = await supabase
    .from('spx_decision_trades')
    .select('*')
    .in('status', statuses)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error('getTradeByStatuses error:', error.message);
    return null;
  }

  return data || null;
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

async function saveWatchingTrade(signal, optionData, spxPrice, analysis) {
  const activationPrice = getActivationLevel(signal.side, analysis);
  const targets = getSPXTargets(signal.side, activationPrice, analysis);
    const row = {
    status: 'watching',
    side: signal.side,

    spx_entry: null,
    spx_current: spxPrice,

    activation_price: activationPrice,
    watch_option_price: optionData.price,
    contract_label: buildContractLabel(optionData),
    expiration_date: optionData.expiration,

    option_ticker: optionData.ticker,
    option_entry: null,
    option_current: optionData.price,
    option_high: optionData.price,
    option_low: optionData.price,
    max_option_price: optionData.price,

    stop_price: null,
    tp1: null,
    tp2: null,

    spx_tp1: targets.tp1,
    spx_tp2: targets.tp2,
    spx_tp3: targets.tp3,
    spx_stop: targets.stop,

    max_profit_amount: 0,
    max_profit_pct: 0,
    last_profit_step: 0,
    activation_reason: signal.reasons.join(' | '),
    close_reason: null
  };

  const { data, error } = await supabase
    .from('spx_decision_trades')
    .insert(row)
    .select()
    .single();

  if (error) {
    console.error('saveWatchingTrade error:', error.message);
    throw error;
  }

  return data;
}

function buildWatchingMessage(signal, spxPrice, optionData, analysis) {
  const isCall = signal.side === 'CALL';
  const activationPrice = getActivationLevel(signal.side, analysis);
  const targets = getSPXTargets(signal.side, activationPrice, analysis);

  return (
`🚨 صفقة مراقبة — SPX Decision

📊 المؤشر: SPX
${isCall ? '🟢 النوع: كول' : '🔴 النوع: بوت'}
📅 الانتهاء: ${optionData.expiration}

🎯 العقد المختار:
${buildContractLabel(optionData)}
${optionData.ticker}

💰 سعر SPX الحالي: ${fmt(spxPrice, 2)}

💵 سعر العقد وقت الاختيار: ${fmt(optionData.price, 2)}
⭐ تقييم العقد: ${fmt(optionData.optionScore, 1)} / 105

📍 التفعيل:
${isCall ? 'اختراق' : 'كسر'} ${fmt(activationPrice, 2)} والثبات ${isCall ? 'فوقه' : 'تحته'}

🎯 أهداف SPX:
TP1: ${fmt(targets.tp1, 2)}
TP2: ${fmt(targets.tp2, 2)}
TP3: ${fmt(targets.tp3, 2)}

🛑 وقف SPX:
${fmt(targets.stop, 2)}

━━━━━━━━━━━━━━
📊 بيانات العقد

Bid: ${fmt(optionData.bid, 2)}
Ask: ${fmt(optionData.ask, 2)}
Last: ${fmt(optionData.last, 2)}
OI: ${fmt(optionData.oi, 0)}
Volume: ${fmt(optionData.volume, 0)}
Delta: ${fmt(optionData.delta, 4)}
Gamma: ${fmt(optionData.gamma, 6)}
Spread: ${fmt(optionData.spreadPct, 1)}%

━━━━━━━━━━━━━━
📊 سبب الصفقة

${signal.reasons.map(x => `✅ ${x}`).join('\n')}
✅ Score: ${signal.score} / 100
✅ انتهاء يومي فقط: ${optionData.expiration}

⏳ الحالة:
مراقبة فقط — لم تتفعل بعد

⚠️ ليست توصية شراء أو بيع`
  );
}

function buildActivatedMessage(trade, spxPrice, optionData, optionEntry) {
  const isCall = trade.side === 'CALL';

  return (
`✅ تم تفعيل الصفقة — SPX Decision

📊 المؤشر: SPX
${isCall ? '🟢 النوع: كول' : '🔴 النوع: بوت'}
📅 الانتهاء: ${trade.expiration_date}

🎯 العقد:
${trade.contract_label}
${trade.option_ticker}

💰 سعر SPX الحالي: ${fmt(spxPrice, 2)}
📍 مستوى الدخول: ${fmt(trade.activation_price, 2)}

💵 دخول العقد: ${fmt(optionEntry, 2)}
🛑 وقف العقد: ${fmt(optionEntry * (1 - OPTION_STOP_PCT / 100), 2)}
🛑 وقف SPX: ${fmt(trade.spx_stop, 2)}

🎯 أهداف SPX:
TP1: ${fmt(trade.spx_tp1, 2)}
TP2: ${fmt(trade.spx_tp2, 2)}
TP3: ${fmt(trade.spx_tp3, 2)}

📦 OI: ${fmt(optionData.oi, 0)}
📊 Volume: ${fmt(optionData.volume, 0)}

🔔 سيتم إرسال تحديث كلما ارتفع العقد +${fmt(PROFIT_STEP, 2)}

⚠️ ليست توصية شراء أو بيع`
  );
}

function buildActivationCancelledMessage(trade, currentPrice) {
  return (
`❌ تم إلغاء تفعيل صفقة SPX — SPX Decision

📊 المؤشر: SPX
🎯 العقد:
${trade.contract_label}
${trade.option_ticker}

💵 سعر العقد الحالي:
${fmt(currentPrice, 2)}

📌 السبب:
سعر العقد خرج عن نطاق التفعيل المسموح.
النطاق المسموح للتفعيل:
${fmt(MIN_OPTION_PRICE, 2)} إلى ${fmt(MAX_OPTION_PRICE_AT_ACTIVATION, 2)}

⚠️ ليست توصية شراء أو بيع`
  );
}
function buildProfitUpdateMessage(trade, currentPrice, maxOptionPrice, profitAmount, maxProfitAmount, profitPct) {
  const isCall = trade.side === 'CALL';

  const tp1Hit = isCall
    ? Number(trade.spx_current) >= Number(trade.spx_tp1)
    : Number(trade.spx_current) <= Number(trade.spx_tp1);

  const tp2Hit = isCall
    ? Number(trade.spx_current) >= Number(trade.spx_tp2)
    : Number(trade.spx_current) <= Number(trade.spx_tp2);

  const tp3Hit = isCall
    ? Number(trade.spx_current) >= Number(trade.spx_tp3)
    : Number(trade.spx_current) <= Number(trade.spx_tp3);

  return (
`📈 تحديث العقد — SPX Decision

📊 المؤشر: SPX
🎯 العقد:
${trade.contract_label}
${trade.option_ticker}

💵 دخول العقد: ${fmt(trade.option_entry, 2)}
💵 السعر الحالي: ${fmt(currentPrice, 2)}
📈 أعلى سعر وصله العقد: ${fmt(maxOptionPrice, 2)}
✅ الربح الحالي: +${fmt(profitAmount, 2)}
🔥 أعلى ربح وصل له العقد: +${fmt(maxProfitAmount, 2)}
📊 نسبة الربح الحالية: +${fmt(profitPct, 1)}%

🎯 حالة الأهداف:
TP1: ${tp1Hit ? '✅ تحقق' : '⏳ لم يتحقق'}
TP2: ${tp2Hit ? '✅ تحقق' : '⏳ لم يتحقق'}
TP3: ${tp3Hit ? '✅ تحقق' : '⏳ لم يتحقق'}

🛑 وقف العقد: ${fmt(trade.stop_price, 2)}

⚠️ ليست توصية شراء أو بيع`
  );
}

function buildStopMessage(trade, currentPrice, maxProfitAmount, maxProfitPct, maxOptionPrice) {
  if (maxProfitAmount > 0) {
    return (
`🟡 تنبيه للمستمرين — SPX Decision

📊 المؤشر: SPX
🎯 العقد:
${trade.contract_label}
${trade.option_ticker}

💵 دخول العقد: ${fmt(trade.option_entry, 2)}
📈 أعلى سعر وصل له العقد: ${fmt(maxOptionPrice, 2)}
🔥 أعلى ربح تحقق: +${fmt(maxProfitAmount, 2)}
📊 أعلى نسبة ربح: +${fmt(maxProfitPct, 1)}%

💵 سعر العقد الحالي: ${fmt(currentPrice, 2)}
🛑 وقف العقد: ${fmt(trade.stop_price, 2)}

📌 العقد عاد الآن تحت الوقف وتم إيقاف المتابعة.
✅ الصفقة حققت ربح قبل الرجوع، وليست صفقة فاشلة.

⚠️ ليست توصية شراء أو بيع`
    );
  }

  return (
`🛑 تم ضرب وقف صفقة SPX — SPX Decision

📊 المؤشر: SPX
🎯 العقد:
${trade.contract_label}
${trade.option_ticker}

💵 دخول العقد: ${fmt(trade.option_entry, 2)}
💵 سعر العقد الحالي: ${fmt(currentPrice, 2)}
🛑 وقف العقد: ${fmt(trade.stop_price, 2)}

📌 لم تحقق الصفقة ربحاً قبل الوقف.

⚠️ ليست توصية شراء أو بيع`
  );
}

async function manageWatchingTrade(trade, contracts, spxPrice, analysis) {
  const isCall = trade.side === 'CALL';
  const activationPrice = Number(trade.activation_price);

  const currentSignal = buildTradeDecision(spxPrice, analysis);

  const activated = isCall
    ? spxPrice >= activationPrice
    : spxPrice <= activationPrice;

  if (!activated) {
    console.log(`Watching trade not activated yet: ${trade.option_ticker}`);
    await updateTrade(trade.id, { spx_current: spxPrice });
    return;
  }

  if (currentSignal.side !== trade.side || currentSignal.score < MIN_ACTIVATION_SCORE) {
    console.log(
      `Activation blocked. Side=${currentSignal.side}, Score=${currentSignal.score}, Required=${MIN_ACTIVATION_SCORE}`
    );

    await updateTrade(trade.id, { spx_current: spxPrice });
    return;
  }

  const option = contracts.find(c => getTicker(c) === trade.option_ticker);

  if (!option) {
    console.log('Watching option not found:', trade.option_ticker);
    return;
  }

  const currentPrice = getOptionPrice(option);

  if (currentPrice === null || currentPrice <= 0) {
    console.log('No activation option price for:', trade.option_ticker);
    return;
  }

  if (currentPrice < MIN_OPTION_PRICE || currentPrice > MAX_OPTION_PRICE_AT_ACTIVATION) {
    await bot.sendMessage(ADMIN_CHAT_ID, buildActivationCancelledMessage(trade, currentPrice));

    await updateTrade(trade.id, {
      status: 'cancelled_price_range',
      option_current: currentPrice,
      spx_current: spxPrice,
      closed_at: new Date().toISOString(),
      close_reason: 'activation_price_out_of_range'
    });

    return;
  }

  const stopPrice = currentPrice * (1 - OPTION_STOP_PCT / 100);

  await updateTrade(trade.id, {
    status: 'active',
    activated_at: new Date().toISOString(),
    spx_entry: spxPrice,
    spx_current: spxPrice,
    option_entry: currentPrice,
    option_current: currentPrice,
    option_high: currentPrice,
    option_low: currentPrice,
    max_option_price: currentPrice,
    stop_price: stopPrice,
    tp1: currentPrice + PROFIT_STEP,
    tp2: currentPrice + PROFIT_STEP * 2
  });

  await bot.sendMessage(
    ADMIN_CHAT_ID,
    buildActivatedMessage(trade, spxPrice, {
      oi: getOpenInterest(option),
      volume: getVolume(option)
    }, currentPrice)
  );
}

async function manageActiveTrade(trade, contracts, spxPrice) {
  const option = contracts.find(c => getTicker(c) === trade.option_ticker);
  if (!option) return console.log('Active option not found:', trade.option_ticker);

  const currentPrice = getOptionPrice(option);
  if (currentPrice === null || currentPrice <= 0) return;

  const optionEntry = Number(trade.option_entry);
  const profitAmount = currentPrice - optionEntry;
  const profitPct = optionEntry > 0 ? (profitAmount / optionEntry) * 100 : 0;

  const newHigh = Math.max(Number(trade.option_high || optionEntry), currentPrice);
  const newLow = Math.min(Number(trade.option_low || optionEntry), currentPrice);
  const maxOptionPrice = Math.max(Number(trade.max_option_price || optionEntry), newHigh);
  const maxProfitAmount = Math.max(Number(trade.max_profit_amount || 0), maxOptionPrice - optionEntry);
  const maxProfitPct = optionEntry > 0 ? (maxProfitAmount / optionEntry) * 100 : 0;

  const currentStep = profitAmount > 0 ? Math.floor(profitAmount / PROFIT_STEP) * PROFIT_STEP : 0;

  const updatedTrade = {
    ...trade,
    spx_current: spxPrice,
    option_current: currentPrice,
    option_high: newHigh,
    option_low: newLow,
    max_option_price: maxOptionPrice,
    max_profit_amount: maxProfitAmount,
    max_profit_pct: maxProfitPct
  };

  await updateTrade(trade.id, updatedTrade);

  if (currentStep > Number(trade.last_profit_step || 0)) {
    await bot.sendMessage(
      ADMIN_CHAT_ID,
      buildProfitUpdateMessage(updatedTrade, currentPrice, maxOptionPrice, profitAmount, maxProfitAmount, profitPct)
    );
    await updateTrade(trade.id, { last_profit_step: currentStep });
  }

  if (currentPrice <= Number(trade.stop_price)) {
    await bot.sendMessage(
      ADMIN_CHAT_ID,
      buildStopMessage(updatedTrade, currentPrice, maxProfitAmount, maxProfitPct, maxOptionPrice)
    );

    await updateTrade(trade.id, {
      status: maxProfitAmount > 0 ? 'closed_after_profit' : 'closed_stop',
      option_current: currentPrice,
      spx_current: spxPrice,
      option_high: newHigh,
      option_low: newLow,
      max_option_price: maxOptionPrice,
      max_profit_amount: maxProfitAmount,
      max_profit_pct: maxProfitPct,
      closed_at: new Date().toISOString(),
      close_reason: maxProfitAmount > 0 ? 'stop_after_profit' : 'stop_loss'
    });
  }
}

async function runCycle() {
  if (isRunning) return console.log('Previous cycle still running, skipped.');
  isRunning = true;

  try {
    const spxPrice = await getSPXPrice();
    const contracts = await getSPXOptionsChain();

    console.log('BOT HEARTBEAT | SPX PRICE:', spxPrice);
    
    const analysis = analyzeSPX(contracts, spxPrice);

    console.log('Analysis:', analysis);

    const existingTrade = await getTradeByStatuses(['watching', 'active']);

    if (existingTrade?.status === 'watching') {
      await manageWatchingTrade(existingTrade, contracts, spxPrice, analysis);
      return;
    }

    if (existingTrade?.status === 'active') {
      await manageActiveTrade(existingTrade, contracts, spxPrice);
      return;
    }

    const signal = buildTradeDecision(spxPrice, analysis);
    console.log(`SPX ${spxPrice} | Signal: ${signal.side} | Score: ${signal.score}`);

    if (signal.side === 'NO_TRADE') return console.log(signal.reason);

    const signalKey = `${signal.side}-${analysis.decisionLow}-${analysis.decisionHigh}-${todayDate()}`;
    const now = Date.now();

    if (signalKey === lastSignalKey && now - lastSignalAt < SIGNAL_COOLDOWN_MS) {
      return console.log('Duplicate signal skipped.');
    }

    const optionData = selectBestOptionContract(contracts, signal.side, spxPrice);
    if (!optionData) return console.log('No suitable 0DTE option contract found.');

    const savedTrade = await saveWatchingTrade(signal, optionData, spxPrice, analysis);

    lastSignalKey = signalKey;
    lastSignalAt = now;

    await bot.sendMessage(ADMIN_CHAT_ID, buildWatchingMessage(signal, spxPrice, optionData, analysis));

    console.log('New watching trade saved:', savedTrade.id);
  } catch (err) {
    console.error('ERROR MESSAGE:', err?.message);
    console.error('ERROR DATA:', err?.response?.data);
    console.error('ERROR STACK:', err?.stack);

    try {
      await bot.sendMessage(ADMIN_CHAT_ID, `❌ فشل SPX Decision Bot\n\n${err?.message || 'Unknown Error'}`);
    } catch {}
  } finally {
    isRunning = false;
  }
}

runCycle();
setInterval(runCycle, CHECK_INTERVAL_MS);
