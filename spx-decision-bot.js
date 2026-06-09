require('dotenv').config();

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');
const puppeteer = require('puppeteer');
const { createClient } = require('@supabase/supabase-js');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const MASSIVE_API_KEY = process.env.MASSIVE_API_KEY;
const FMP_API_KEY = process.env.FMP_API_KEY;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const MIN_VOLUME = Number(process.env.MIN_VOLUME || 100);
const MIN_OI = Number(process.env.MIN_OI || 100);

const MIN_OPTION_PRICE = Number(process.env.MIN_OPTION_PRICE || 2.00);
const MAX_OPTION_PRICE = Number(process.env.MAX_OPTION_PRICE || 3.20);
const MAX_OPTION_PRICE_AT_ACTIVATION = Number(process.env.MAX_OPTION_PRICE_AT_ACTIVATION || 3.20);

const MIN_DELTA = Number(process.env.MIN_DELTA || 0.10);
const MAX_DELTA = Number(process.env.MAX_DELTA || 0.90);
const MAX_SPREAD_PCT = Number(process.env.MAX_SPREAD_PCT || 50);

const CHECK_INTERVAL_MS = Number(process.env.CHECK_INTERVAL_MS || 300000);
const MAGNET_ALERT_MOVE = Number(process.env.MAGNET_ALERT_MOVE || 25);
const NEAR_STRIKE_RANGE = Number(process.env.NEAR_STRIKE_RANGE || 150);
const FORCE_RUN = String(process.env.FORCE_RUN || 'false').toLowerCase() === 'true';

const PROFIT_STEP = Number(process.env.PROFIT_STEP || 0.10);
const OPTION_STOP_PCT = Number(process.env.OPTION_STOP_PCT || 25);

const TP_POINTS = Number(process.env.TP_POINTS || 10);
const SIGNAL_COOLDOWN_MS = Number(process.env.SIGNAL_COOLDOWN_MS || 5 * 60 * 1000);

const bot = new TelegramBot(BOT_TOKEN, { polling: false });

const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY
);

let previousAlertState = null;
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

function fmtCompact(n) {
  if (!Number.isFinite(Number(n))) return 'غير متاح';

  const value = Number(n);
  const abs = Math.abs(value);

  if (abs >= 1000000) return `${(value / 1000000).toFixed(1)}M`;
  if (abs >= 1000) return `${(value / 1000).toFixed(1)}K`;

  return fmt(value, 2);
}

function pct(n) {
  if (!Number.isFinite(Number(n))) return 'غير متاح';
  return `${Number(n).toFixed(1)}%`;
}

function signedPct(n) {
  if (!Number.isFinite(Number(n))) return 'غير متاح';
  const sign = Number(n) > 0 ? '+' : '';
  return `${sign}${Number(n).toFixed(1)}%`;
}

function isMarketOpenNow() {
  if (FORCE_RUN) return true;

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(new Date());

  const get = type => parts.find(p => p.type === type)?.value;

  const weekday = get('weekday');
  const hour = Number(get('hour'));
  const minute = Number(get('minute'));

  if (weekday === 'Sat' || weekday === 'Sun') return false;

  const currentMinutes = hour * 60 + minute;
  const marketOpen = 9 * 60 + 30;
  const marketClose = 16 * 60;

  return currentMinutes >= marketOpen && currentMinutes <= marketClose;
}

function distanceText(price, level) {
  if (!Number.isFinite(Number(price)) || !Number.isFinite(Number(level))) {
    return 'غير متاح';
  }

  const diff = Number(price) - Number(level);
  const abs = Math.abs(diff);

  if (diff > 0) return `فوقه بـ ${fmt(abs, 2)} نقطة`;
  if (diff < 0) return `تحته بـ ${fmt(abs, 2)} نقطة`;
  return 'عنده مباشرة';
}

function getSaudiTime() {
  return new Date().toLocaleString('en-US', {
    timeZone: 'Asia/Riyadh',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
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

function todayDate() {
  return new Date().toISOString().slice(0, 10);
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
  if (!optionData) return 'غير متاح';
  const sideLetter = optionData.type === 'call' ? 'C' : 'P';
  return `SPX ${fmt(optionData.strike, 0)}${sideLetter}`;
}
async function getSPXPrice() {
  if (!FMP_API_KEY) {
    throw new Error('FMP_API_KEY غير موجود في ملف .env');
  }

  const url =
    `https://financialmodelingprep.com/stable/quote-short?symbol=%5EGSPC&apikey=${FMP_API_KEY}`;

  const res = await axios.get(url, { timeout: 30000 });
  const row = Array.isArray(res.data) ? res.data[0] : null;
  const price = toNumber(row?.price);

  if (price === null) {
    throw new Error('فشل جلب سعر SPX من FMP');
  }

  return price;
}

async function getFilteredSPXChain() {
  const { fromDate, toDate } = getDateRange();

  let url =
    `https://api.massive.com/v3/snapshot/options/I:SPX` +
    `?order=asc&limit=250&sort=ticker` +
    `&expiration_date.gte=${fromDate}` +
    `&expiration_date.lte=${toDate}` +
    `&apiKey=${MASSIVE_API_KEY}`;

  const allContracts = [];
  let page = 1;

  while (url) {
    console.log(`Fetching SPX page ${page}...`);

    const res = await axios.get(url, { timeout: 90000 });
    const results = res.data?.results || [];

    allContracts.push(...results);

    console.log(`Page ${page}: ${results.length} contracts`);

    url = res.data?.next_url || null;

    if (url && !url.includes('apiKey=')) {
      url += `${url.includes('?') ? '&' : '?'}apiKey=${MASSIVE_API_KEY}`;
    }

    page++;
    await sleep(200);
  }

  return {
    contracts: allContracts,
    fromDate,
    toDate
  };
}

function analyzeSPXGamma(contracts, spxPrice) {
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
        totalOI: 0,
        callVolume: 0,
        putVolume: 0,
        totalVolume: 0
      });
    }

    const row = strikeMap.get(strike);

    row.totalGammaPower += gammaPower;
    row.totalOI += oi;
    row.totalVolume += volume;

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

  const nearRows = rows.filter(r =>
    Number.isFinite(Number(spxPrice)) &&
    Math.abs(r.strike - spxPrice) <= NEAR_STRIKE_RANGE
  );

  const analysisRows = nearRows.length > 0 ? nearRows : rows;

  const strongestCall =
    analysisRows.slice().sort((a, b) => b.callGammaPower - a.callGammaPower)[0] || null;

  const strongestPut =
    analysisRows.slice().sort((a, b) => b.putGammaPower - a.putGammaPower)[0] || null;

  const strongestMagnet =
    analysisRows.slice().sort((a, b) => b.totalGammaPower - a.totalGammaPower)[0] || null;

  const topCallLiquidity = analysisRows
    .filter(r => r.callVolume > 0)
    .slice()
    .sort((a, b) => b.callVolume - a.callVolume)
    .slice(0, 3);

  const topPutLiquidity = analysisRows
    .filter(r => r.putVolume > 0)
    .slice()
    .sort((a, b) => b.putVolume - a.putVolume)
    .slice(0, 3);

  const topCallGamma = analysisRows
    .filter(r => r.callGammaPower > 0)
    .slice()
    .sort((a, b) => b.callGammaPower - a.callGammaPower)
    .slice(0, 3);

  const topPutGamma = analysisRows
    .filter(r => r.putGammaPower > 0)
    .slice()
    .sort((a, b) => b.putGammaPower - a.putGammaPower)
    .slice(0, 3);

  const totalCallGamma = analysisRows.reduce((sum, r) => sum + r.callGammaPower, 0);
  const totalPutGamma = analysisRows.reduce((sum, r) => sum + r.putGammaPower, 0);
  const netGamma = totalCallGamma - totalPutGamma;

  const totalFlowVolume = totalCallVolume + totalPutVolume;
  const callFlowPct = totalFlowVolume > 0 ? (totalCallVolume / totalFlowVolume) * 100 : 0;
  const putFlowPct = totalFlowVolume > 0 ? (totalPutVolume / totalFlowVolume) * 100 : 0;

  let flowBias = '🟡 متوازن';
  if (callFlowPct >= 55) flowBias = '🟢 سيطرة الكول';
  if (putFlowPct >= 55) flowBias = '🔴 سيطرة البوت';

  const activeLevels = [...new Set([
    strongestCall?.strike,
    strongestPut?.strike,
    strongestMagnet?.strike,
    ...topCallLiquidity.map(r => r.strike),
    ...topPutLiquidity.map(r => r.strike),
    ...topCallGamma.map(r => r.strike),
    ...topPutGamma.map(r => r.strike)
  ].filter(v => v !== null && v !== undefined))].sort((a, b) => a - b);

  let priceLocation = 'غير متاح';

  if (spxPrice && strongestPut?.strike && strongestCall?.strike) {
    if (spxPrice > strongestCall.strike) priceLocation = '🟢 فوق المقاومة الرئيسية';
    else if (spxPrice < strongestPut.strike) priceLocation = '🔴 تحت الدعم الرئيسي';
    else priceLocation = '🟡 بين الدعم والمقاومة';
  }

  return {
    spxPrice,
    totalContracts: contracts.length,
    usableContracts: usable.length,
    ignoredContracts: contracts.length - usable.length,
    strikeCount: rows.length,
    nearStrikeCount: analysisRows.length,

    strongestCall,
    strongestPut,
    strongestMagnet,

    topCallLiquidity,
    topPutLiquidity,
    topCallGamma,
    topPutGamma,

    totalCallGamma,
    totalPutGamma,
    netGamma,

    marketRegime: netGamma >= 0 ? 'Positive Gamma' : 'Negative Gamma',

    activeLow: activeLevels.length ? activeLevels[0] : null,
    activeHigh: activeLevels.length ? activeLevels[activeLevels.length - 1] : null,

    totalCallVolume,
    totalPutVolume,
    totalFlowVolume,
    callFlowPct,
    putFlowPct,
    flowBias,
    priceLocation
  };
}

function scoreOptionCandidate(x) {
  const deltaScore = x.delta === null
    ? 0.7
    : 1 - Math.min(Math.abs((x.delta || 0) - 0.35) / 0.35, 1);

  const volumeScore = Math.min((x.volume || 0) / 10000, 1);
  const oiScore = Math.min((x.oi || 0) / 5000, 1);
  const spreadScore = x.spreadPct === null
    ? 0.6
    : 1 - Math.min((x.spreadPct || 100) / MAX_SPREAD_PCT, 1);

  let priceScore = 0.5;

  if (x.price >= 2.00 && x.price <= 2.60) priceScore = 1;
  else if (x.price > 2.60 && x.price <= 3.20) priceScore = 0.85;

  return (
    deltaScore * 30 +
    volumeScore * 30 +
    oiScore * 20 +
    spreadScore * 10 +
    priceScore * 10
  );
}

function selectBestOptionContract(contracts, side) {
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
      if (x.type !== wantedType) return false;
      if (!x.ticker || !x.expiration) return false;
      if (x.strike === null || x.price === null || x.price <= 0) return false;

      if (x.volume < MIN_VOLUME) return false;
      if (x.oi < MIN_OI) return false;

      if (x.price < MIN_OPTION_PRICE || x.price > MAX_OPTION_PRICE) return false;

      if (x.delta !== null && (x.delta < MIN_DELTA || x.delta > MAX_DELTA)) return false;
      if (x.spreadPct !== null && x.spreadPct > MAX_SPREAD_PCT) return false;

      return true;
    })
    .map(x => ({
      ...x,
      optionScore: scoreOptionCandidate(x)
    }))
    .sort((a, b) => b.optionScore - a.optionScore);

  return candidates[0] || null;
}
function buildTradeRecommendation(a, contracts) {
  const price = Number(a.spxPrice);

  const callLiquidity = a.topCallLiquidity?.[0] || {};
  const putLiquidity = a.topPutLiquidity?.[0] || {};
  const callGamma = a.topCallGamma?.[0] || {};
  const putGamma = a.topPutGamma?.[0] || {};

  const callPower =
    Number(callLiquidity.callVolume || 0) +
    Number(callLiquidity.callOI || 0) +
    Number(callGamma.callGammaPower || 0);

  const putPower =
    Number(putLiquidity.putVolume || 0) +
    Number(putLiquidity.putOI || 0) +
    Number(putGamma.putGammaPower || 0);

  let side = 'WAIT';
  let score = 5;
  const reasons = [];

  if (callPower > putPower) {
    side = 'CALL';
    score = 7;
    reasons.push('GEX: CALL BIAS');
    reasons.push(`Radar: CALL`);
  }

  if (putPower > callPower) {
    side = 'PUT';
    score = 7;
    reasons.push('GEX: PUT BIAS');
    reasons.push(`Radar: PUT`);
  }

  if (side === 'CALL') {
    if (a.callFlowPct >= 55) {
      score += 1;
      reasons.push(`Call Flow مسيطر ${pct(a.callFlowPct)}`);
    }

    if (a.netGamma > 0) {
      score += 1;
      reasons.push('Positive Gamma يدعم الصعود');
    }

    if (String(a.priceLocation).includes('فوق المقاومة')) {
      score += 1;
      reasons.push('السعر فوق المقاومة الرئيسية');
    }
  }

  if (side === 'PUT') {
    if (a.putFlowPct >= 55) {
      score += 1;
      reasons.push(`Put Flow مسيطر ${pct(a.putFlowPct)}`);
    }

    if (a.netGamma < 0) {
      score += 1;
      reasons.push('Negative Gamma يدعم الضغط الهابط');
    }

    if (String(a.priceLocation).includes('تحت الدعم')) {
      score += 1;
      reasons.push('السعر تحت الدعم الرئيسي');
    }
  }

  score = Math.max(1, Math.min(10, score));

  if (score < 7 || side === 'WAIT') {
    return {
      side: 'WAIT',
      score,
      option: null,
      activationPrice: null,
      stockStop: null,
      tp1: null,
      tp2: null,
      tp3: null,
      stopType: 'لا يوجد',
      reasons: reasons.length ? reasons : ['القراءة غير كافية للدخول']
    };
  }

  const option = selectBestOptionContract(contracts, side);

  if (!option) {
    return {
      side: 'WAIT',
      score,
      option: null,
      activationPrice: null,
      stockStop: null,
      tp1: null,
      tp2: null,
      tp3: null,
      stopType: 'لا يوجد',
      reasons: [
        ...reasons,
        `لم يتم العثور على عقد مناسب بين ${fmt(MIN_OPTION_PRICE, 2)} و ${fmt(MAX_OPTION_PRICE, 2)}`
      ]
    };
  }

  let activationPrice = null;
  let stockStop = null;
  let tp1 = null;
  let tp2 = null;
  let tp3 = null;
  let stopType = 'وقف من رسالة القاما';

  if (side === 'CALL') {
    activationPrice = a.strongestCall?.strike || a.strongestMagnet?.strike || price;
    stockStop = a.strongestPut?.strike || a.strongestMagnet?.strike || price - TP_POINTS;

    tp1 = activationPrice + TP_POINTS;
    tp2 = activationPrice + TP_POINTS * 2;
    tp3 = activationPrice + TP_POINTS * 3;
  }

  if (side === 'PUT') {
    activationPrice = a.strongestPut?.strike || a.strongestMagnet?.strike || price;
    stockStop = a.strongestCall?.strike || a.strongestMagnet?.strike || price + TP_POINTS;

    tp1 = activationPrice - TP_POINTS;
    tp2 = activationPrice - TP_POINTS * 2;
    tp3 = activationPrice - TP_POINTS * 3;
  }

  return {
    side,
    score,
    option,
    activationPrice,
    stockStop,
    tp1,
    tp2,
    tp3,
    stopType,
    reasons
  };
}

async function getOpenDecisionTrade() {
  const { data, error } = await supabase
    .from('st_decision_trades')
    .select('*')
    .in('status', ['watching', 'active'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error('getOpenDecisionTrade error:', error.message);
    return null;
  }

  return data || null;
}

async function updateDecisionTrade(id, patch) {
  const { error } = await supabase
    .from('st_decision_trades')
    .update(patch)
    .eq('id', id);

  if (error) {
    console.error('updateDecisionTrade error:', error.message);
  }
}

async function saveWatchingDecisionTrade(rec, a) {
  const option = rec.option;

  const row = {
    status: 'watching',
    symbol: 'SPX',
    side: rec.side,

    stock_entry: null,
    stock_current: a.spxPrice,
    activation_price: rec.activationPrice,

    contract_label: buildContractLabel(option),
    option_ticker: option.ticker,
    expiration_date: option.expiration,

    option_entry: null,
    option_current: option.price,
    option_high: option.price,
    option_low: option.price,
    max_option_price: option.price,

    stop_price: null,
    stock_stop: rec.stockStop,
    stop_type: rec.stopType,

    tp1: rec.tp1,
    tp2: rec.tp2,
    tp3: rec.tp3,

    hit_tp1: false,
    hit_tp2: false,
    hit_tp3: false,

    max_profit_amount: 0,
    max_profit_pct: 0,
    last_profit_step: 0,

    score: rec.score,
    reason: rec.reasons.join(' | '),
    close_reason: null
  };

  const { data, error } = await supabase
    .from('st_decision_trades')
    .insert(row)
    .select()
    .single();

  if (error) {
    console.error('saveWatchingDecisionTrade error:', error.message);
    throw error;
  }

  return data;
}

function buildWatchingDecisionMessage(rec, a) {
  const option = rec.option;
  const isCall = rec.side === 'CALL';

  return (
`🚨 صفقة مراقبة — ST Decision

📊 السهم: SPX
${isCall ? '🟢 النوع: كول' : '🔴 النوع: بوت'}
📅 الانتهاء: ${option.expiration}

🎯 العقد المختار:
${buildContractLabel(option)}
${option.ticker}

💰 سعر السهم الحالي: ${fmt(a.spxPrice, 2)}

💵 سعر العقد وقت الاختيار: ${fmt(option.price, 2)}

📍 التفعيل:
${isCall ? 'اختراق' : 'كسر'} ${fmt(rec.activationPrice, 2)} والثبات ${isCall ? 'فوقه' : 'تحته'}

🎯 أهداف السهم:
TP1: ${fmt(rec.tp1, 2)}
TP2: ${fmt(rec.tp2, 2)}
TP3: ${fmt(rec.tp3, 2)}

🛑 وقف السهم:
${fmt(rec.stockStop, 2)}
📌 نوع الوقف: ${rec.stopType}

━━━━━━━━━━━━━━
📊 بيانات العقد

Bid: ${fmt(option.bid, 2)}
Ask: ${fmt(option.ask, 2)}
Last: ${fmt(option.last, 2)}
OI: ${fmt(option.oi, 0)}
Volume: ${fmt(option.volume, 0)}
Delta: ${fmt(option.delta, 12)}
Gamma: ${fmt(option.gamma, 12)}

━━━━━━━━━━━━━━
📊 سبب الصفقة

${rec.reasons.map(x => `✅ ${x}`).join('\n')}
✅ Score القاما: ${rec.score} / 10
✅ انتهاء مقترح/مسيطر: ${option.expiration}

⏳ الحالة:
مراقبة فقط — لم تتفعل بعد

⚠️ ليست توصية شراء أو بيع`
  );
}

function buildActivatedDecisionMessage(trade, a, option, optionEntry) {
  const isCall = trade.side === 'CALL';

  return (
`✅ تم تفعيل الصفقة — ST Decision

📊 السهم: SPX
${isCall ? '🟢 النوع: كول' : '🔴 النوع: بوت'}
📅 الانتهاء: ${trade.expiration_date}

🎯 العقد:
${trade.contract_label}
${trade.option_ticker}

💰 سعر السهم الحالي: ${fmt(a.spxPrice, 2)}
📍 مستوى الدخول: ${fmt(trade.activation_price, 2)}

💵 دخول العقد: ${fmt(optionEntry, 2)}
🛑 وقف العقد: ${fmt(optionEntry * (1 - OPTION_STOP_PCT / 100), 2)}
🛑 وقف السهم: ${fmt(trade.stock_stop, 2)}
📌 نوع الوقف: ${trade.stop_type}

🎯 أهداف السهم:
TP1: ${fmt(trade.tp1, 2)}
TP2: ${fmt(trade.tp2, 2)}
TP3: ${fmt(trade.tp3, 2)}

📦 OI: ${fmt(getOpenInterest(option), 0)}
📊 Volume: ${fmt(getVolume(option), 0)}

🔔 سيتم إرسال تحديث كلما ارتفع العقد +${fmt(PROFIT_STEP, 2)}

⚠️ ليست توصية شراء أو بيع`
  );
}
function buildProfitUpdateDecisionMessage(trade, a, currentPrice, maxOptionPrice, profitAmount, option) {
  const isCall = trade.side === 'CALL';

  const tp1Hit = isCall
    ? Number(a.spxPrice) >= Number(trade.tp1)
    : Number(a.spxPrice) <= Number(trade.tp1);

  const tp2Hit = isCall
    ? Number(a.spxPrice) >= Number(trade.tp2)
    : Number(a.spxPrice) <= Number(trade.tp2);

  const tp3Hit = isCall
    ? Number(a.spxPrice) >= Number(trade.tp3)
    : Number(a.spxPrice) <= Number(trade.tp3);

  return (
`📈 تحديث العقد — ST Decision

📊 السهم: SPX
🎯 العقد:
${trade.contract_label}
${trade.option_ticker}

💵 دخول العقد: ${fmt(trade.option_entry, 2)}
💵 السعر الحالي: ${fmt(currentPrice, 2)}
📈 أعلى سعر وصله العقد: ${fmt(maxOptionPrice, 2)}
✅ الربح الحالي: +${fmt(profitAmount, 2)}
🔥 أعلى ربح وصل له العقد: +${fmt(maxOptionPrice - Number(trade.option_entry), 2)}

🎯 حالة الأهداف:
TP1: ${tp1Hit ? '✅ تحقق' : '⏳ لم يتحقق'}
TP2: ${tp2Hit ? '✅ تحقق' : '⏳ لم يتحقق'}
TP3: ${tp3Hit ? '✅ تحقق' : '⏳ لم يتحقق'}

🛑 وقف العقد: ${fmt(trade.stop_price, 2)}
📦 OI: ${fmt(getOpenInterest(option), 0)}
📊 Volume: ${fmt(getVolume(option), 0)}`
  );
}

function buildTP3DecisionMessage(trade, a, currentPrice) {
  const optionEntry = Number(trade.option_entry);
  const profitAmount = currentPrice - optionEntry;

  return (
`🎯🔥 تحقق الهدف الثالث — ST Decision

📊 السهم: SPX
🎯 العقد:
${trade.contract_label}
${trade.option_ticker}

✅ تحقق: TP3
💰 سعر السهم الحالي: ${fmt(a.spxPrice, 2)}
💵 سعر العقد الحالي: ${fmt(currentPrice, 2)}
💵 دخول العقد: ${fmt(optionEntry, 2)}
📈 الربح الحالي: +${fmt(profitAmount, 2)}

━━━━━━━━━━━━━━
🏁 انتهت المتابعة رسميًا

إذا بتستمر:
ارفع وقفك واحمِ ربحك، وانتبه لعقدك.

😄 الطمع شين.

⚠️ ليست توصية شراء أو بيع`
  );
}

function buildStopDecisionMessage(trade, a, currentPrice, maxOptionPrice, maxProfitAmount) {
  if (maxProfitAmount > 0) {
    return (
`🟡 تنبيه للمستمرين — ST Decision

📊 السهم: SPX
🎯 العقد:
${trade.contract_label}
${trade.option_ticker}

💵 دخول العقد: ${fmt(trade.option_entry, 2)}
📈 أعلى سعر وصل له العقد: ${fmt(maxOptionPrice, 2)}
🔥 أعلى ربح تحقق: +${fmt(maxProfitAmount, 2)}

💰 سعر السهم الحالي: ${fmt(a.spxPrice, 2)}
💵 سعر العقد الحالي: ${fmt(currentPrice, 2)}
🛑 وقف العقد: ${fmt(trade.stop_price, 2)}

📌 العقد عاد الآن تحت الوقف وتم إيقاف المتابعة.
✅ الصفقة حققت ربح قبل الرجوع، وليست صفقة فاشلة.

⚠️ ليست توصية شراء أو بيع`
    );
  }

  return (
`🛑 تم ضرب وقف صفقة SPX — ST Decision

📊 السهم: SPX
🎯 العقد:
${trade.contract_label}
${trade.option_ticker}

💰 سعر السهم الحالي: ${fmt(a.spxPrice, 2)}
💵 دخول العقد: ${fmt(trade.option_entry, 2)}
💵 سعر العقد الحالي: ${fmt(currentPrice, 2)}
🛑 وقف العقد: ${fmt(trade.stop_price, 2)}

📌 لم تحقق الصفقة ربحاً قبل الوقف.

⚠️ ليست توصية شراء أو بيع`
  );
}

async function manageWatchingDecisionTrade(trade, contracts, a) {
  const isCall = trade.side === 'CALL';

  const activated = isCall
    ? Number(a.spxPrice) >= Number(trade.activation_price)
    : Number(a.spxPrice) <= Number(trade.activation_price);

  await updateDecisionTrade(trade.id, {
    stock_current: a.spxPrice
  });

  if (!activated) {
    console.log('ST Decision watching not activated yet.');
    return;
  }

  const option = contracts.find(c => getTicker(c) === trade.option_ticker);

  if (!option) {
    console.log('Watching option not found:', trade.option_ticker);
    return;
  }

  const currentPrice = getOptionPrice(option);

  if (currentPrice === null || currentPrice <= 0) {
    console.log('No option price on activation:', trade.option_ticker);
    return;
  }

  if (
    currentPrice < MIN_OPTION_PRICE ||
    currentPrice > MAX_OPTION_PRICE_AT_ACTIVATION
  ) {
    await bot.sendMessage(
      ADMIN_CHAT_ID,
`❌ تم إلغاء تفعيل صفقة SPX — ST Decision

📊 السهم: SPX
🎯 العقد:
${trade.contract_label}
${trade.option_ticker}

💵 سعر العقد الحالي:
${fmt(currentPrice, 2)}

📌 السبب:
سعر العقد خرج عن نطاق التفعيل المسموح.
النطاق المسموح:
${fmt(MIN_OPTION_PRICE, 2)} إلى ${fmt(MAX_OPTION_PRICE_AT_ACTIVATION, 2)}

⚠️ ليست توصية شراء أو بيع`
    );

    await updateDecisionTrade(trade.id, {
      status: 'cancelled_price_range',
      option_current: currentPrice,
      stock_current: a.spxPrice,
      closed_at: new Date().toISOString(),
      close_reason: 'activation_price_out_of_range'
    });

    return;
  }

  const stopPrice = currentPrice * (1 - OPTION_STOP_PCT / 100);

  await updateDecisionTrade(trade.id, {
    status: 'active',
    activated_at: new Date().toISOString(),
    stock_entry: a.spxPrice,
    stock_current: a.spxPrice,

    option_entry: currentPrice,
    option_current: currentPrice,
    option_high: currentPrice,
    option_low: currentPrice,
    max_option_price: currentPrice,

    stop_price: stopPrice
  });

  await bot.sendMessage(
    ADMIN_CHAT_ID,
    buildActivatedDecisionMessage(trade, a, option, currentPrice)
  );
}

async function manageActiveDecisionTrade(trade, contracts, a) {
  const option = contracts.find(c => getTicker(c) === trade.option_ticker);

  if (!option) {
    console.log('Active option not found:', trade.option_ticker);
    return;
  }

  const currentPrice = getOptionPrice(option);

  if (currentPrice === null || currentPrice <= 0) {
    console.log('No active option price:', trade.option_ticker);
    return;
  }

  const optionEntry = Number(trade.option_entry);
  const profitAmount = currentPrice - optionEntry;
  const profitPct = optionEntry > 0 ? (profitAmount / optionEntry) * 100 : 0;

  const newHigh = Math.max(Number(trade.option_high || optionEntry), currentPrice);
  const newLow = Math.min(Number(trade.option_low || optionEntry), currentPrice);

  const maxOptionPrice = Math.max(Number(trade.max_option_price || optionEntry), newHigh);
  const maxProfitAmount = Math.max(
    Number(trade.max_profit_amount || 0),
    maxOptionPrice - optionEntry
  );

  const maxProfitPct = optionEntry > 0
    ? (maxProfitAmount / optionEntry) * 100
    : 0;

  const isCall = trade.side === 'CALL';

  const hitTp1Now = isCall
    ? Number(a.spxPrice) >= Number(trade.tp1)
    : Number(a.spxPrice) <= Number(trade.tp1);

  const hitTp2Now = isCall
    ? Number(a.spxPrice) >= Number(trade.tp2)
    : Number(a.spxPrice) <= Number(trade.tp2);

  const hitTp3Now = isCall
    ? Number(a.spxPrice) >= Number(trade.tp3)
    : Number(a.spxPrice) <= Number(trade.tp3);

  const currentStep =
    profitAmount > 0
      ? Math.floor(profitAmount / PROFIT_STEP) * PROFIT_STEP
      : 0;

  const updatedTrade = {
    ...trade,
    stock_current: a.spxPrice,
    option_current: currentPrice,
    option_high: newHigh,
    option_low: newLow,
    max_option_price: maxOptionPrice,
    max_profit_amount: maxProfitAmount,
    max_profit_pct: maxProfitPct,
    hit_tp1: Boolean(trade.hit_tp1) || hitTp1Now,
    hit_tp2: Boolean(trade.hit_tp2) || hitTp2Now,
    hit_tp3: Boolean(trade.hit_tp3) || hitTp3Now
  };

  await updateDecisionTrade(trade.id, {
    stock_current: a.spxPrice,
    option_current: currentPrice,
    option_high: newHigh,
    option_low: newLow,
    max_option_price: maxOptionPrice,
    max_profit_amount: maxProfitAmount,
    max_profit_pct: maxProfitPct,
    hit_tp1: updatedTrade.hit_tp1,
    hit_tp2: updatedTrade.hit_tp2,
    hit_tp3: updatedTrade.hit_tp3
  });

  if (hitTp3Now) {
    await bot.sendMessage(
      ADMIN_CHAT_ID,
      buildTP3DecisionMessage(updatedTrade, a, currentPrice)
    );

    await updateDecisionTrade(trade.id, {
      status: 'closed_tp3',
      option_current: currentPrice,
      stock_current: a.spxPrice,
      closed_at: new Date().toISOString(),
      close_reason: 'tp3_hit'
    });

    return;
  }

  if (currentStep > Number(trade.last_profit_step || 0)) {
    await bot.sendMessage(
      ADMIN_CHAT_ID,
      buildProfitUpdateDecisionMessage(
        updatedTrade,
        a,
        currentPrice,
        maxOptionPrice,
        profitAmount,
        option
      )
    );

    await updateDecisionTrade(trade.id, {
      last_profit_step: currentStep
    });
  }

  if (currentPrice <= Number(trade.stop_price)) {
    await bot.sendMessage(
      ADMIN_CHAT_ID,
      buildStopDecisionMessage(
        updatedTrade,
        a,
        currentPrice,
        maxOptionPrice,
        maxProfitAmount
      )
    );

    await updateDecisionTrade(trade.id, {
      status: maxProfitAmount > 0 ? 'closed_after_profit' : 'closed_stop',
      option_current: currentPrice,
      stock_current: a.spxPrice,
      closed_at: new Date().toISOString(),
      close_reason: maxProfitAmount > 0 ? 'stop_after_profit' : 'stop_loss'
    });
  }
}
function getFlowChange(current, previous) {
  if (!previous) {
    return {
      callChange: null,
      putChange: null,
      text: 'أول تحديث للرادار'
    };
  }

  const callChange = current.callFlowPct - previous.callFlowPct;
  const putChange = current.putFlowPct - previous.putFlowPct;

  return {
    callChange,
    putChange,
    text:
`Call Flow: ${signedPct(callChange)}
Put Flow: ${signedPct(putChange)}`
  };
}

function getArabicBias(a) {
  if (!a.strongestCall || !a.strongestPut) return 'غير واضح';

  const callPower = a.strongestCall.callGammaPower;
  const putPower = a.strongestPut.putGammaPower;

  if (a.netGamma < 0 && putPower > callPower * 1.5 && a.putFlowPct >= 55) {
    return '🔴 ضغط هابط / تذبذب عالي';
  }

  if (a.netGamma < 0) {
    return '🔴 تذبذب مرتفع';
  }

  if (a.netGamma > 0 && a.callFlowPct >= 55) {
    return '🟢 ميل صاعد / استقرار أعلى';
  }

  return '🟡 توازن أو تذبذب بين المستويات';
}

function getArabicGammaState(a) {
  return a.marketRegime === 'Positive Gamma'
    ? '🟢 Positive Gamma'
    : '🔴 Negative Gamma';
}

function getMarketSummary(a) {
  if (a.callFlowPct >= 55 && a.netGamma >= 0) {
    return {
      flow: ' Call Flow مسيطر',
      gamma: ' Positive Gamma',
      bias: 'صاعد',
      invalidation: 'الدعم الرئيسي'
    };
  }

  if (a.putFlowPct >= 55 && a.netGamma < 0) {
    return {
      flow: ' Put Flow مسيطر',
      gamma: ' Negative Gamma',
      bias: 'هابط',
      invalidation: 'المقاومة الرئيسية'
    };
  }

  return {
    flow: ' سيولة متوازنة',
    gamma: a.netGamma >= 0 ? ' Positive Gamma' : ' Negative Gamma',
    bias: 'عرضي / تذبذب',
    invalidation: 'انتظار الكسر أو الاختراق'
  };
}

function getGammaEnvironment(a) {
  if (a.netGamma > 0 && a.callFlowPct >= 55) {
    return `🟢 استقرار أعلى / ميل صاعد
Net Gamma: ${fmtCompact(a.netGamma)}`;
  }

  if (a.netGamma < 0 && a.putFlowPct >= 55) {
    return `🔴 تذبذب مرتفع / ضغط هابط
Net Gamma: ${fmtCompact(a.netGamma)}`;
  }

  if (a.netGamma < 0) {
    return `🟠 تذبذب مرتفع بدون اتجاه مؤكد
Net Gamma: ${fmtCompact(a.netGamma)}`;
  }

  return `🟡 استقرار نسبي / توازن
Net Gamma: ${fmtCompact(a.netGamma)}`;
}

function getMoveProbability(a) {
  let callScore = 50;
  let putScore = 50;

  callScore += (a.callFlowPct - 50) * 0.6;
  putScore += (a.putFlowPct - 50) * 0.6;

  if (a.netGamma > 0) callScore += 7;
  if (a.netGamma < 0) putScore += 7;

  if (String(a.priceLocation).includes('فوق المقاومة')) callScore += 10;
  if (String(a.priceLocation).includes('تحت الدعم')) putScore += 10;

  callScore = Math.max(0, Math.min(100, callScore));
  putScore = Math.max(0, Math.min(100, putScore));

  const total = callScore + putScore;
  const callPct = total > 0 ? (callScore / total) * 100 : 50;
  const putPct = total > 0 ? (putScore / total) * 100 : 50;

  const confidence = Math.round(Math.abs(callPct - putPct) / 10) + 5;
  const finalConfidence = Math.max(5, Math.min(10, confidence));

  const bias =
    callPct > putPct
      ? '🟢 CALL أقرب'
      : putPct > callPct
        ? '🔴 PUT أقرب'
        : '🟡 متوازن';

  return {
    callPct,
    putPct,
    confidence: finalConfidence,
    bias,
    text:
`🎯 احتمالية الحركة

🟢 CALL: ${pct(callPct)}
🔴 PUT: ${pct(putPct)}

 القراءة:
${bias}

🔥 الثقة:
${finalConfidence} / 10`
  };
}

function formatCallLiquidity(rows) {
  if (!rows || rows.length === 0) return 'غير متاح';

  return rows
    .map((r, i) =>
`${i + 1}) ${fmt(r.strike, 2)}
Vol: ${fmt(r.callVolume, 0)}
OI: ${fmt(r.callOI, 0)}`
    )
    .join('\n\n');
}

function formatPutLiquidity(rows) {
  if (!rows || rows.length === 0) return 'غير متاح';

  return rows
    .map((r, i) =>
`${i + 1}) ${fmt(r.strike, 2)}
Vol: ${fmt(r.putVolume, 0)}
OI: ${fmt(r.putOI, 0)}`
    )
    .join('\n\n');
}

function formatCallGamma(rows) {
  if (!rows || rows.length === 0) return 'غير متاح';

  return rows
    .map((r, i) =>
`${i + 1}) ${fmt(r.strike, 2)}
Gamma Power: ${fmtCompact(r.callGammaPower)}
OI: ${fmt(r.callOI, 0)}
Vol: ${fmt(r.callVolume, 0)}`
    )
    .join('\n\n');
}

function formatPutGamma(rows) {
  if (!rows || rows.length === 0) return 'غير متاح';

  return rows
    .map((r, i) =>
`${i + 1}) ${fmt(r.strike, 2)}
Gamma Power: ${fmtCompact(r.putGammaPower)}
OI: ${fmt(r.putOI, 0)}
Vol: ${fmt(r.putVolume, 0)}`
    )
    .join('\n\n');
}

function buildNearestScenario(a) {
  const price = a.spxPrice;
  const support = a.strongestPut?.strike;
  const resistance = a.strongestCall?.strike;
  const magnet = a.strongestMagnet?.strike;

  if (!price || !support || !resistance) {
    return {
      nearest: 'غير متاح',
      bias: '🟡 WAIT',
      note: 'البيانات غير مكتملة',
      supportDistance: null,
      resistanceDistance: null,
      magnetDistance: null,
      text: 'البيانات غير مكتملة'
    };
  }

  const supportDistance = Math.abs(price - support);
  const resistanceDistance = Math.abs(price - resistance);
  const magnetDistance = magnet ? Math.abs(price - magnet) : null;

  let nearest = '🧲 نقطة التوازن';
  let bias = '🟡 WAIT';
  let note = 'انتظار كسر أو اختراق واضح';

  if (resistanceDistance < supportDistance) {
    nearest = '🚧 المقاومة';
    bias = a.callFlowPct >= 55 ? '🟢 CALL BIAS' : '🟡 WAIT';
    note = a.callFlowPct >= 55
      ? 'راقب الاختراق والثبات فوق المقاومة'
      : 'قريب من المقاومة لكن سيولة الكول غير كافية';
  }

  if (supportDistance < resistanceDistance) {
    nearest = '🛡️ الدعم';
    bias = a.putFlowPct >= 55 ? '🔴 PUT BIAS' : '🟡 WAIT';
    note = a.putFlowPct >= 55
      ? 'راقب الكسر والثبات تحت الدعم'
      : 'قريب من الدعم لكن سيولة البوت غير كافية';
  }

  if (
    magnetDistance !== null &&
    magnetDistance <= supportDistance &&
    magnetDistance <= resistanceDistance
  ) {
    nearest = '🧲 نقطة التوازن';
    bias = '🟡 WAIT';
    note = 'السعر قريب من التوازن، احتمالية التذبذب أعلى';
  }

  return {
    nearest,
    bias,
    note,
    supportDistance,
    resistanceDistance,
    magnetDistance,
    text:
`🎯 السيناريو الأقرب

💰 السعر الحالي:
${fmt(price, 2)}

🚧 المقاومة:
${fmt(resistance, 2)}
📏 ${fmt(resistanceDistance, 2)} نقطة

🛡️ الدعم:
${fmt(support, 2)}
📏 ${fmt(supportDistance, 2)} نقطة

🧲 التوازن:
${fmt(magnet, 2)}
📏 ${magnetDistance === null ? 'غير متاح' : `${fmt(magnetDistance, 2)} نقطة`}

━━━━━━━━━━━━━━

 الأقرب حالياً:
${nearest}

 الأفضلية الحالية:
${bias}

⚠️ الملاحظة:
${note}`
  };
}

function getFinalRead(a) {
  const price = a.spxPrice;
  const magnet = a.strongestMagnet?.strike;
  const put = a.strongestPut?.strike;
  const call = a.strongestCall?.strike;

  if (!magnet || !put || !call || !price) {
    return 'القراءة غير مكتملة بسبب نقص البيانات.';
  }

  if (price > call && a.callFlowPct >= 55) {
    return `SPX أعلى من المقاومة الرئيسية ${fmt(call, 2)} مع سيطرة سيولة الكول، وهذا يعطي أفضلية صاعدة بشرط الثبات فوق المستوى.`;
  }

  if (price < put && a.putFlowPct >= 55) {
    return `SPX تحت الدعم الرئيسي ${fmt(put, 2)} مع سيطرة سيولة البوت، وهذا يعطي ضغطاً هابطاً واضحاً.`;
  }

  if (price >= put && price <= call) {
    return `SPX داخل نطاق القرار بين ${fmt(put, 2)} و ${fmt(call, 2)}. الأفضل انتظار كسر أو اختراق واضح قبل الاعتماد على الاتجاه.`;
  }

  if (a.marketRegime === 'Negative Gamma') {
    return 'القاما سلبية، لذلك الحركة قد تكون سريعة ومتذبذبة. لا تعتمد على الاتجاه إلا بعد كسر أو اختراق واضح لمستويات القرار.';
  }

  return 'الخريطة مستقرة نسبياً، لكن القرار الأفضل يكون بعد تفاعل السعر مع الدعم أو المقاومة الرئيسية.';
}

function buildDecisionBlock(a) {
  const price = a.spxPrice;
  const decisionPut = a.strongestPut?.strike;
  const decisionMagnet = a.strongestMagnet?.strike;
  const decisionCall = a.strongestCall?.strike;

  if (
    decisionPut &&
    decisionCall &&
    Math.abs(decisionCall - decisionPut) <= 10
  ) {
    const low = Math.min(decisionCall, decisionPut);
    const high = Math.max(decisionCall, decisionPut);

    return (
`🎯 خريطة القرار

🧲 منطقة التوازن الرئيسية
${fmt(low, 2)} - ${fmt(high, 2)}

 موقع السعر:
${distanceText(price, (low + high) / 2)}

📍 تركز القاما والسيولة في نفس المنطقة

⚠️ السوق داخل نطاق تذبذب ضيق

🟢 اختراق ${fmt(high, 2)}
أفضلية CALL

🔴 كسر ${fmt(low, 2)}
أفضلية PUT

🟡 بين ${fmt(low, 2)} - ${fmt(high, 2)}
انتظار / تذبذب`
    );
  }

  return (
`🎯 خريطة القرار

🛡️ الدعم الرئيسي
${fmt(decisionPut, 2)}

📏 السعر:
${distanceText(price, decisionPut)}

🧲 نقطة التوازن
${fmt(decisionMagnet, 2)}

📏 السعر:
${distanceText(price, decisionMagnet)}

🚧 المقاومة الرئيسية
${fmt(decisionCall, 2)}

📏 السعر:
${distanceText(price, decisionCall)}

━━━━━━━━━━━━━━
🚦 القرار اللحظي

🟢 فوق ${fmt(decisionCall, 2)}
أفضلية CALL

🔴 تحت ${fmt(decisionPut, 2)}
أفضلية PUT

🟡 بين ${fmt(decisionPut, 2)} - ${fmt(decisionCall, 2)}
تذبذب / انتظار`
  );
}

function buildReport(a, fromDate, toDate, previous) {
  const bias = getArabicBias(a);
  const finalRead = getFinalRead(a);
  const gammaState = getArabicGammaState(a);
  const gammaEnvironment = getGammaEnvironment(a);
  const moveProbability = getMoveProbability(a);
  const decisionBlock = buildDecisionBlock(a);
  const flowChange = getFlowChange(a, previous);
  const nearestScenario = buildNearestScenario(a);

  return (
`📡 SPX Gamma & Liquidity Radar

💰 SPX: ${fmt(a.spxPrice, 2)}
📅 التاريخ: ${fromDate}
⏰ آخر تحديث: ${getSaudiTime()} السعودية

━━━━━━━━━━━━━━
🧠 ملخص السوق
━━━━━━━━━━━━━━

📈 الاتجاه العام: ${bias}
🧠 حالة القاما: ${gammaState}
💰 تدفق السيولة: ${a.flowBias}
📍 موقع السعر: ${a.priceLocation}

🟢 Call Flow: ${pct(a.callFlowPct)}
🔴 Put Flow: ${pct(a.putFlowPct)}

🧠 بيئة السوق:
${gammaEnvironment}

━━━━━━━━━━━━━━
📈 تغير السيولة
━━━━━━━━━━━━━━

${flowChange.text}

━━━━━━━━━━━━━━
${nearestScenario.text}

━━━━━━━━━━━━━━
${moveProbability.text}

━━━━━━━━━━━━━━
${decisionBlock}

━━━━━━━━━━━━━━
🔥 أقوى سيولة CALL
━━━━━━━━━━━━━━

${formatCallLiquidity(a.topCallLiquidity)}

━━━━━━━━━━━━━━
🔥 أقوى سيولة PUT
━━━━━━━━━━━━━━

${formatPutLiquidity(a.topPutLiquidity)}

━━━━━━━━━━━━━━
⚡ أقوى 3 Gamma CALL
━━━━━━━━━━━━━━

${formatCallGamma(a.topCallGamma)}

━━━━━━━━━━━━━━
⚡ أقوى 3 Gamma PUT
━━━━━━━━━━━━━━

${formatPutGamma(a.topPutGamma)}

━━━━━━━━━━━━━━
📊 نطاق السيطرة
━━━━━━━━━━━━━━

منطقة الدعم:
${fmt(a.strongestPut?.strike, 2)}

منطقة التوازن:
${fmt(a.strongestMagnet?.strike, 2)}

منطقة المقاومة:
${fmt(a.strongestCall?.strike, 2)}

📌 نطاق التحليل:
±${fmt(NEAR_STRIKE_RANGE, 0)} نقطة حول السعر

━━━━━━━━━━━━━━
📌 الخلاصة
━━━━━━━━━━━━━━

${finalRead}`
  );
}

function buildHtml(a, fromDate) {
  return `
<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8" />
<style>
body {
  margin: 0;
  width: 1080px;
  min-height: 1350px;
  background: #07111f;
  color: #ffffff;
  font-family: Arial, Tahoma, sans-serif;
  direction: rtl;
}
.wrap {
  width: 1080px;
  min-height: 1350px;
  padding: 28px;
  background: #07111f;
}
.header {
  border: 1px solid #284057;
  border-radius: 26px;
  background: #101e2b;
  padding: 24px;
  text-align: center;
}
.school {
  font-size: 44px;
  font-weight: 900;
}
.title {
  font-size: 28px;
  color: #61c4ff;
  direction: ltr;
}
.card {
  margin-top: 18px;
  border: 1px solid #294158;
  border-radius: 24px;
  background: #0d1d2b;
  padding: 22px;
}
.price {
  font-size: 64px;
  font-weight: 900;
  text-align: center;
  direction: ltr;
}
.grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 18px;
}
h2 {
  text-align: center;
  font-size: 30px;
}
.line {
  display: flex;
  justify-content: space-between;
  border-bottom: 1px solid rgba(255,255,255,.12);
  padding: 12px 0;
  font-size: 24px;
}
.green { color: #67e36f; }
.red { color: #ff5757; }
.yellow { color: #f2c94c; }
.blue { color: #61c4ff; }
.footer {
  margin-top: 18px;
  color: #f2c94c;
  text-align: center;
  font-size: 24px;
}
</style>
</head>
<body>
<div class="wrap">
  <div class="header">
    <div class="school">مدرسة السوق الامريكي</div>
    <div class="title">SPX GAMMA & LIQUIDITY RADAR</div>
    <div>${fromDate} • ${getSaudiTime()} KSA</div>
  </div>

  <div class="card">
    <div class="price">SPX ${fmt(a.spxPrice, 2)}</div>
  </div>

  <div class="grid">
    <div class="card">
      <h2>ملخص السوق</h2>
      <div class="line"><span>Call Flow</span><b class="green">${pct(a.callFlowPct)}</b></div>
      <div class="line"><span>Put Flow</span><b class="red">${pct(a.putFlowPct)}</b></div>
      <div class="line"><span>Gamma</span><b>${a.marketRegime}</b></div>
      <div class="line"><span>الموقع</span><b>${a.priceLocation}</b></div>
    </div>

    <div class="card">
      <h2>مستويات القرار</h2>
      <div class="line"><span>الدعم</span><b class="red">${fmt(a.strongestPut?.strike, 2)}</b></div>
      <div class="line"><span>التوازن</span><b class="yellow">${fmt(a.strongestMagnet?.strike, 2)}</b></div>
      <div class="line"><span>المقاومة</span><b class="green">${fmt(a.strongestCall?.strike, 2)}</b></div>
    </div>
  </div>

  <div class="grid">
    <div class="card">
      <h2 class="green">أقوى CALL</h2>
      <div class="line"><span>سيولة</span><b>${fmt(a.topCallLiquidity?.[0]?.strike, 2)}</b></div>
      <div class="line"><span>Volume</span><b>${fmt(a.topCallLiquidity?.[0]?.callVolume, 0)}</b></div>
      <div class="line"><span>Gamma</span><b>${fmtCompact(a.topCallGamma?.[0]?.callGammaPower)}</b></div>
    </div>

    <div class="card">
      <h2 class="red">أقوى PUT</h2>
      <div class="line"><span>سيولة</span><b>${fmt(a.topPutLiquidity?.[0]?.strike, 2)}</b></div>
      <div class="line"><span>Volume</span><b>${fmt(a.topPutLiquidity?.[0]?.putVolume, 0)}</b></div>
      <div class="line"><span>Gamma</span><b>${fmtCompact(a.topPutGamma?.[0]?.putGammaPower)}</b></div>
    </div>
  </div>

  <div class="footer">
    ليست توصية شراء أو بيع • محتوى تعليمي وتحليلي فقط
  </div>
</div>
</body>
</html>`;
}

async function generateRadarImage(a, fromDate) {
  const html = buildHtml(a, fromDate);
  const outDir = path.join(__dirname, 'tmp');

  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir);
  }

  const filePath = path.join(outDir, `spx-radar-${Date.now()}.png`);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage'
    ]
  });

  const page = await browser.newPage();

  await page.setViewport({
    width: 1080,
    height: 1350,
    deviceScaleFactor: 1
  });

  await page.setContent(html, { waitUntil: 'networkidle0' });
  await page.screenshot({ path: filePath, fullPage: true });
  await browser.close();

  return filePath;
}

function buildAlertMessages(current, previous) {
  if (!previous) return [];

  const alerts = [];

  if (current.flowBias !== previous.flowBias) {
    alerts.push(
`🚨 SPX Alert

💰 انقلاب السيولة اللحظية

من:
${previous.flowBias}

إلى:
${current.flowBias}

🟢 Call Flow: ${pct(current.callFlowPct)}
🔴 Put Flow: ${pct(current.putFlowPct)}

📍 راقب الحركة القادمة`
    );
  }

  if (current.marketRegime !== previous.marketRegime) {
    alerts.push(
`🚨 SPX Alert

🧠 تغير حالة القاما

من:
${previous.marketRegime === 'Positive Gamma' ? '🟢 قاما إيجابية' : '🔴 قاما سلبية'}

إلى:
${current.marketRegime === 'Positive Gamma' ? '🟢 قاما إيجابية' : '🔴 قاما سلبية'}

📍 تغير مهم في بنية السوق`
    );
  }

  return alerts;
}

async function maybeCreateDecisionTrade(contracts, analysis) {
  const existingTrade = await getOpenDecisionTrade();

  if (existingTrade?.status === 'watching') {
    await manageWatchingDecisionTrade(existingTrade, contracts, analysis);
    return;
  }

  if (existingTrade?.status === 'active') {
    await manageActiveDecisionTrade(existingTrade, contracts, analysis);
    return;
  }

  const rec = buildTradeRecommendation(analysis, contracts);

  if (rec.side === 'WAIT' || !rec.option) {
    console.log('ST Decision WAIT:', rec.reasons.join(' | '));
    return;
  }

  const signalKey =
    `${rec.side}-${rec.activationPrice}-${rec.option.ticker}-${todayDate()}`;

  const now = Date.now();

  if (signalKey === lastSignalKey && now - lastSignalAt < SIGNAL_COOLDOWN_MS) {
    console.log('Duplicate ST Decision skipped.');
    return;
  }

  const saved = await saveWatchingDecisionTrade(rec, analysis);

  lastSignalKey = signalKey;
  lastSignalAt = now;

  await bot.sendMessage(
    ADMIN_CHAT_ID,
    buildWatchingDecisionMessage(rec, analysis)
  );

  console.log('New ST Decision saved:', saved.id);
}

async function runCycle() {
  if (isRunning) {
    console.log('Previous cycle still running, skipped.');
    return;
  }

  isRunning = true;

  try {
    if (!isMarketOpenNow()) {
      console.log('Market closed. SPX radar paused.');
      return;
    }

    const spxPrice = await getSPXPrice();
    const { contracts, fromDate, toDate } = await getFilteredSPXChain();

    const analysis = analyzeSPXGamma(contracts, spxPrice);
    const alerts = buildAlertMessages(analysis, previousAlertState);

    for (const alert of alerts) {
      console.log('Sending SPX Alert...');
      await bot.sendMessage(ADMIN_CHAT_ID, alert);
      await sleep(500);
    }

    await maybeCreateDecisionTrade(contracts, analysis);

    const imagePath = await generateRadarImage(analysis, fromDate);
    const summary = getMarketSummary(analysis);

    previousAlertState = analysis;

    console.log('Sending SPX Gamma Radar image...');

    await bot.sendPhoto(
      ADMIN_CHAT_ID,
      fs.createReadStream(imagePath),
      {
        caption:
`🧠 ملخص السوق

${summary.flow}
${summary.gamma}

📈 التحيز الحالي:
${summary.bias}

🛡️ مستوى الإبطال:
${summary.invalidation}`
      }
    );

    try {
      if (fs.existsSync(imagePath)) {
        fs.unlinkSync(imagePath);
      }
    } catch (_) {}

  } catch (err) {
    console.error(err?.response?.data || err.message);

    try {
      await bot.sendMessage(
        ADMIN_CHAT_ID,
        `❌ فشل تحليل SPX Gamma + Flow\n\n${err?.response?.data?.error || err.message}`
      );
    } catch {}
  } finally {
    isRunning = false;
  }
}

runCycle();
setInterval(runCycle, CHECK_INTERVAL_MS);
