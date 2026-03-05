/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  CRASH PRO — server.js  v3.0  (Profit-Control + Smart Bot System)
 *
 *  NEW FEATURES:
 *   1. calculateCrashPoint() — House Edge Algorithm
 *      • Max 15.00x hard cap
 *      • 10% instant-loss games (1.01x ~ 1.02x)
 *      • High-bet rigging: if userBets > 50,000 MMK → house keeps 70-80%
 *      • Single high-roller protection: crash 1.10x~1.40x
 *      • Admin Pressure mode: low house balance → more 1.1x crashes
 *   2. Bot Pool (80+ Myanmar names) — static array, NO new objects per round
 *      • Dynamic rotation: total players always exactly 6
 *      • Shuffle seed changes every round for identity protection
 *   3. Minimum Withdrawal: 5,000 MMK
 *   4. Strict cashout latency check (phase guard)
 *   5. 500+ concurrent user optimisation (Map ops, atomic DB)
 * ═══════════════════════════════════════════════════════════════════════════
 */

'use strict';

const express      = require('express');
const http         = require('http');
const { Server }   = require('socket.io');
const mongoose     = require('mongoose');
const cors         = require('cors');
const dotenv       = require('dotenv');
const { Telegraf } = require('telegraf');

dotenv.config();

// ─── Express + Socket.io ───────────────────────────────────────────────────────

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
  username:       String,
  firstName:      String,
  lastName:       String,
  balance:        { type: Number, default: 1000, min: 0 },
  totalDeposited: { type: Number, default: 0 },
  totalWithdrawn: { type: Number, default: 0 },
  totalBets:      { type: Number, default: 0 },
  totalWins:      { type: Number, default: 0 },
  isBanned:       { type: Boolean, default: false },
  bannedAt:       Date,
  banReason:      String,
  createdAt:      { type: Date, default: Date.now },
  lastActive:     { type: Date, default: Date.now },
});

const betSchema = new mongoose.Schema({
  userId:            { type: String, index: true },
  username:          String,
  amount:            Number,
  cashoutMultiplier: Number,
  startedAt:         Date,
  cashedAt:          Date,
  gameId:            { type: String, index: true },
  profit:            Number,
  status:            { type: String, enum: ['pending', 'won', 'lost'], default: 'pending' },
});

const transactionSchema = new mongoose.Schema({
  userId:        { type: String, index: true },
  username:      String,
  type:          { type: String, enum: ['deposit', 'withdraw'] },
  amount:        Number,
  status:        { type: String, enum: ['pending', 'confirmed', 'rejected'], default: 'pending' },
  accountName:   String,
  accountNumber: String,
  adminNote:     String,
  confirmedBy:   String,
  confirmedAt:   Date,
  createdAt:     { type: Date, default: Date.now },
});

const User        = mongoose.model('User',        userSchema);
const Bet         = mongoose.model('Bet',         betSchema);
const Transaction = mongoose.model('Transaction', transactionSchema);

// ═══════════════════════════════════════════════════════════════════════════
//  HOUSE EDGE CONFIG
// ═══════════════════════════════════════════════════════════════════════════

const HOUSE = {
  MAX_MULTIPLIER:         15.00,   // Hard cap
  INSTANT_LOSS_RATE:      0.10,    // 10% of games → 1.01x or 1.02x
  HIGH_BET_THRESHOLD:     50000,   // MMK — trigger rigging above this
  HOUSE_EDGE_RATIO:       0.75,    // House keeps 75% of pool when rigged
  HIGH_ROLLER_THRESHOLD:  10000,   // Single bet above this → selective crash
  HIGH_ROLLER_CRASH_MIN:  1.10,
  HIGH_ROLLER_CRASH_MAX:  1.40,
  PRESSURE_CRASH_MAX:     1.15,    // When admin balance low
  PRESSURE_BALANCE_LIMIT: 5000,    // Admin virtual balance below this = pressure mode
};

// Admin's virtual "house balance" — tracks net profit (in-memory, resets on restart)
// In production you'd persist this in DB; here we start at a comfortable figure
let houseBalance = 500000; // MMK

// ═══════════════════════════════════════════════════════════════════════════
//  PROFIT-CONTROL CRASH POINT ALGORITHM
//  calculateCrashPoint(totalUserBets, maxSingleBet)
//
//  Priority order:
//   1. Instant-loss roll  (10%)
//   2. Admin Pressure mode (low houseBalance)
//   3. High-roller selective crash
//   4. High total-pool rigging
//   5. Normal random
// ═══════════════════════════════════════════════════════════════════════════

function calculateCrashPoint(totalUserBets = 0, maxSingleBet = 0) {
  const rand = Math.random;

  // ── 1. Instant loss (10% of all games) ───────────────────────────────────
  if (rand() < HOUSE.INSTANT_LOSS_RATE) {
    const cp = rand() < 0.5 ? 1.01 : 1.02;
    console.log(`🎯 Instant-loss game: ${cp}x`);
    return cp;
  }

  // ── 2. Admin Pressure mode ────────────────────────────────────────────────
  //    If house balance is critically low, crash early more often
  if (houseBalance < HOUSE.PRESSURE_BALANCE_LIMIT && rand() < 0.60) {
    const cp = round2(1.05 + rand() * (HOUSE.PRESSURE_CRASH_MAX - 1.05));
    console.log(`⚠️  Pressure mode crash: ${cp}x (houseBalance=${houseBalance})`);
    return cp;
  }

  // ── 3. High-roller selective crash ───────────────────────────────────────
  //    A single user bet > threshold → crash before they profit much
  if (maxSingleBet >= HOUSE.HIGH_ROLLER_THRESHOLD) {
    // 70% chance to trigger selective crash
    if (rand() < 0.70) {
      const range = HOUSE.HIGH_ROLLER_CRASH_MAX - HOUSE.HIGH_ROLLER_CRASH_MIN;
      const cp    = round2(HOUSE.HIGH_ROLLER_CRASH_MIN + rand() * range);
      console.log(`🎯 High-roller protection crash: ${cp}x (single bet: ${maxSingleBet})`);
      return cp;
    }
  }

  // ── 4. Dynamic rigging — high total user bets ────────────────────────────
  //    If pool > threshold, calculate crash so house keeps HOUSE_EDGE_RATIO of pool
  if (totalUserBets >= HOUSE.HIGH_BET_THRESHOLD) {
    // House wants to pay out at most (1 - edge) * pool
    // Max payout = pool * (1 - HOUSE_EDGE_RATIO)
    // crashPoint = maxPayout / totalUserBets
    // But we enforce a minimum crash of 1.05 so it's not too obvious
    const maxPayout    = totalUserBets * (1 - HOUSE.HOUSE_EDGE_RATIO);
    const targetMult   = maxPayout / totalUserBets;  // fraction < 1 usually
    // We set crashPoint just below where users break even
    // Jitter ±0.05 so it doesn't look deterministic
    const jitter = (rand() - 0.5) * 0.10;
    const cp     = round2(Math.max(1.05, Math.min(
      HOUSE.MAX_MULTIPLIER,
      targetMult + 1.0 + jitter   // +1.0 because mult starts at 1.0
    )));
    console.log(`💰 Rigged crash: ${cp}x (pool=${totalUserBets}, edge=${HOUSE.HOUSE_EDGE_RATIO})`);
    return cp;
  }

  // ── 5. Normal random distribution ────────────────────────────────────────
  let cp;
  const roll = rand();
  if      (roll < 0.35) cp = 1.10 + rand() * 0.90;   // 35%: 1.1x–2.0x
  else if (roll < 0.60) cp = 2.00 + rand() * 2.00;   // 25%: 2.0x–4.0x
  else if (roll < 0.80) cp = 4.00 + rand() * 4.00;   // 20%: 4.0x–8.0x
  else if (roll < 0.93) cp = 8.00 + rand() * 4.00;   // 13%: 8.0x–12.0x
  else                   cp = 12.0 + rand() * 3.00;   //  7%: 12.0x–15.0x

  return round2(Math.min(cp, HOUSE.MAX_MULTIPLIER));
}

function round2(n) { return Math.round(n * 100) / 100; }

// ═══════════════════════════════════════════════════════════════════════════
//  BOT POOL  — 80 Myanmar bots, static array (NO new objects per round)
//  Memory-safe: we store objects once at startup and rotate via index
// ═══════════════════════════════════════════════════════════════════════════

const MYANMAR_BOT_NAMES = [
  // Classic Myanmar names
  "Seint Seint","Kyaw Kyaw","Aye Aye","Phyo Phyo","Su Su",
  "Mg Mg","Zaw Zaw","Hla Hla","Mya Mya","Tun Tun",
  "Thidar","Nilar","Zayar","Kaung Kaung","Htet Htet",
  "Thet Thet","Myo Myo","Wutyi","Thae Thae","Chit Chit",
  "Aung Aung","Bo Bo","Thiha","Min Min","Lin Lin",
  // Trendy / Romanized
  "Howmah_jsksn","Htuneaing","Zay_Yar_99","Ko_Latt_Pro","Mm_K_77",
  "X_Aung_X","Lion_Heart_MM","Shadow_K","Dark_Moon_Htut","K_Phyo_88",
  "Sweet_Yoon","Rose_Mi","Sky_Walker_Kyaw","Mg_Thura_007","Lucky_Win_Mg",
  "J_Don_2024","Phoe_Wa_7","Black_Tiger_Ko","King_Aung_Gyi","Lady_Rose_9",
  // Modern
  "Zay Yar Htet","Yoon Wadi","Thoon Thadi","Eaindra","May Thu",
  "Htet Arkar","Wai Yan","Sithu","Kaung Sett","Hein Htet",
  "Pyae Phyo","Thant Sin","Yan Naing","Kyaw Zayar","Pyae Sone",
  "Nay Chi","Hnin Oo","Ei Ei","Wai Wai","Khin Khin",
  // Gaming style
  "Pro_Gamer_Ko","King_MMK","Jackpot_Aung","Lucky_7_Mg","Win_Win_Ko",
  "Tiger_Kyaw","Dragon_Phyo","Phoenix_Su","Wolf_Zaw","Eagle_Min",
  "Ace_Htet","Boss_Aung","Chief_Bo","Maverick_Mg","Ninja_Ko",
  "Sniper_Tun","Viper_Lin","Storm_Myo","Flash_Win","Ghost_Hla",
  // Female names
  "Honey_Thida","Angel_Nilar","Queen_Ei","Princess_Ma","Star_Aye",
  "Moon_Hla","Flower_Mya","Cherry_Su","Jade_Khin","Pearl_Hnin",
  "Crystal_Wai","Diamond_Nay","Ruby_Yoon","Sapphire_May","Gold_Thidar",
  // Additional
  "Maung Maung","Ko Latt","U Kyaw","Daw Khin","Ma Sandar",
  "Ko Htun","Mg Thet","Su Myat","Ei Phyu","Nan Dar",
];

// ── Build the static bot pool once at startup ──────────────────────────────
// Strategy distribution: early 30%, medium 35%, late 20%, random 15%
const STRATEGIES = ['early','early','early','medium','medium','medium','medium','late','late','random'];

/** @type {Map<string, BotObj>} */
const BOT_POOL = new Map();

MYANMAR_BOT_NAMES.forEach((name, i) => {
  const id = `bot_${i}`;
  BOT_POOL.set(id, {
    id,
    username:  name,
    balance:   3000 + Math.floor(Math.random() * 12000),  // 3k–15k initial
    strategy:  STRATEGIES[i % STRATEGIES.length],
    lastRound: -1,   // round counter to avoid same bots two rounds in a row
  });
});

// Convert to array for O(1) shuffle — do NOT recreate this array in the loop
const BOT_ARRAY = Array.from(BOT_POOL.values());

console.log(`🤖 Bot pool initialised: ${BOT_POOL.size} bots`);

// ─── Shuffle utility (Fisher-Yates, in-place on a COPY) ───────────────────────
function shuffleSlice(arr, count) {
  // Returns `count` unique random elements without mutating original
  const copy = arr.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, count);
}

// ═══════════════════════════════════════════════════════════════════════════
//  GAME CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

const COUNTDOWN_SECONDS  = 5;
const MULTIPLIER_TICK_MS = 50;
const BETWEEN_GAME_MS    = 3000;
const GROWTH_RATE        = 0.06;
const TOTAL_PLAYERS      = 6;     // ★ Always exactly 6 visible players per round
const MIN_WITHDRAWAL     = 5000;  // ★ Minimum withdrawal in MMK

// ─── Round counter (used for bot identity rotation) ───────────────────────────
let roundCounter = 0;

// ─── Game state ───────────────────────────────────────────────────────────────

let G = createFreshState();

function createFreshState() {
  return {
    phase:             'idle',
    gameId:            null,
    crashPoint:        0,
    currentMultiplier: 1.0,
    startTime:         null,
    bets:              new Map(),
    totalBetsAmount:   0,
    totalUserBets:     0,   // ★ real-user bets only (for crash algorithm)
    maxSingleUserBet:  0,   // ★ highest single real-user bet
    history:           [],
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const sleep        = ms => new Promise(r => setTimeout(r, ms));
const generateGameId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

function activeBetsSnapshot() {
  const out = [];
  for (const b of G.bets.values()) {
    if (!b.cashedAt) out.push({ username: b.username, amount: b.amount, isBot: b.isBot });
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
//  GAME LOOP
// ═══════════════════════════════════════════════════════════════════════════

async function startGameLoop() {
  console.log('🎮 Game loop started');
  while (true) {
    try {
      await runCountdown();
      await runGame();
      await sleep(BETWEEN_GAME_MS);
    } catch (err) {
      console.error('🔥 Game loop error:', err);
      await sleep(2000);
    }
  }
}

// ─── Phase 1: Countdown ───────────────────────────────────────────────────────

async function runCountdown() {
  roundCounter++;

  // Reset state — keep history
  G.bets               = new Map();
  G.totalBetsAmount    = 0;
  G.totalUserBets      = 0;
  G.maxSingleUserBet   = 0;
  G.currentMultiplier  = 1.0;
  G.phase              = 'countdown';
  G.gameId             = generateGameId();
  G.crashPoint         = 0;

  io.emit('countdown', { seconds: COUNTDOWN_SECONDS, gameId: G.gameId });

  // Place bot bets after a short human-like delay
  setTimeout(placeBotBets, 600 + Math.floor(Math.random() * 800));

  await sleep(COUNTDOWN_SECONDS * 1000);

  // ★ Crash point determined NOW using real user bet data
  G.crashPoint = calculateCrashPoint(G.totalUserBets, G.maxSingleUserBet);
  console.log(
    `🎲 Round ${roundCounter} | game=${G.gameId} | crash@${G.crashPoint}x` +
    ` | userBets=${G.totalUserBets} | maxSingle=${G.maxSingleUserBet} | house=${houseBalance}`
  );
}

// ─── Phase 2: Running ─────────────────────────────────────────────────────────

async function runGame() {
  G.phase     = 'running';
  G.startTime = Date.now();

  io.emit('gameStart', {
    gameId: G.gameId,
    bets:   activeBetsSnapshot(),
  });

  while (G.phase === 'running') {
    const elapsed = (Date.now() - G.startTime) / 1000;
    const mult    = Math.pow(Math.E, GROWTH_RATE * elapsed);
    G.currentMultiplier = round2(mult);

    if (G.currentMultiplier >= G.crashPoint) {
      G.currentMultiplier = G.crashPoint;
      io.emit('multiplier', { multiplier: G.currentMultiplier, phase: 'running' });
      await crashGame();
      break;
    }

    io.emit('multiplier', { multiplier: G.currentMultiplier, phase: 'running' });
    processBotCashouts();
    await sleep(MULTIPLIER_TICK_MS);
  }
}

// ─── Crash ────────────────────────────────────────────────────────────────────

async function crashGame() {
  G.phase = 'crashed';
  console.log(`💥 Crashed @ ${G.crashPoint}x`);

  // Calculate house profit/loss for this round
  let roundProfit = 0;
  const lossPromises = [];

  for (const [uid, bet] of G.bets.entries()) {
    if (!bet.cashedAt) {
      // House wins this bet
      if (!bet.isBot) roundProfit += bet.amount;
      lossPromises.push(processBetLoss(uid, bet));
    } else if (!bet.isBot) {
      // House paid this out
      roundProfit -= bet.profit ?? 0;
    }
  }

  await Promise.allSettled(lossPromises);

  // Update house balance
  houseBalance += roundProfit;
  if (houseBalance < 0) houseBalance = 0;

  G.history.unshift({
    gameId:     G.gameId,
    crashPoint: G.crashPoint,
    totalBets:  G.totalBetsAmount,
    timestamp:  Date.now(),
  });
  if (G.history.length > 50) G.history.length = 50;

  io.emit('gameCrashed', { multiplier: G.crashPoint, gameId: G.gameId });
}

// ═══════════════════════════════════════════════════════════════════════════
//  PLACE BET
// ═══════════════════════════════════════════════════════════════════════════

async function placeBet(userId, username, amount) {
  if (G.phase !== 'countdown') {
    return { success: false, message: G.phase === 'running'
      ? 'ဂိမ်းစပြီးပါပြီ — နောက်ပတ်တွင် Bet လောင်းပါ'
      : 'Countdown မစသေးပါ' };
  }
  if (G.bets.has(userId))  return { success: false, message: 'ဤပတ်တွင် Bet လောင်းပြီးပါပြီ' };

  amount = Number(amount);
  if (!Number.isFinite(amount) || amount <= 0) return { success: false, message: 'ငွေပမာဏ မမှန်ကန်' };
  if (!dbReady) return { success: false, message: 'Server မသင့်တော်သေးပါ' };

  try {
    const user = await User.findOneAndUpdate(
      { telegramId: userId, balance: { $gte: amount }, isBanned: false },
      { $inc: { balance: -amount, totalBets: 1 }, $set: { lastActive: new Date() } },
      { new: true }
    );

    if (!user) {
      const ex = await User.findOne({ telegramId: userId });
      if (!ex)          return { success: false, message: 'User not found' };
      if (ex.isBanned)  return { success: false, message: 'Account banned' };
      return { success: false, message: 'လက်ကျန်မလုံလောက်' };
    }

    const bet = {
      userId, username, amount,
      isBot: false, gameId: G.gameId,
      placedAt: Date.now(), cashedAt: null,
      cashoutMultiplier: null, profit: null,
    };
    G.bets.set(userId, bet);
    G.totalBetsAmount  += amount;
    G.totalUserBets    += amount;              // ★ track real-user pool
    if (amount > G.maxSingleUserBet) G.maxSingleUserBet = amount;  // ★ high-roller tracking

    Bet.create({ userId, username, amount, gameId: G.gameId, status: 'pending' })
       .catch(e => console.error('Bet.create error:', e));

    io.emit('balanceUpdate', { userId, balance: user.balance });
    io.emit('activeBets',    { bets: activeBetsSnapshot() });

    return { success: true, newBalance: user.balance };
  } catch (err) {
    console.error('placeBet error:', err);
    return { success: false, message: 'Server error' };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  CASH OUT — strict phase guard (latency check)
// ═══════════════════════════════════════════════════════════════════════════

async function cashOut(userId, clientMultiplier, clientGameId) {
  // ★ Strict latency check — if phase is not 'running', reject immediately
  if (G.phase !== 'running') {
    return { success: false, message: 'ဂိမ်း Crash ဖြစ်သွားပြီ — Cashout မရတော့ပါ' };
  }

  if (clientGameId && clientGameId !== G.gameId) {
    return { success: false, message: 'Game session မမှန်ကန်' };
  }

  const bet = G.bets.get(userId);
  if (!bet)         return { success: false, message: 'Active bet မရှိပါ' };
  if (bet.cashedAt) return { success: false, message: 'ရပြီးသားဖြစ်သည် (Double cashout)' };

  // Mark cashed BEFORE async — prevents concurrent double-spend
  bet.cashedAt = Date.now();

  const multiplier  = Math.min(
    parseFloat(clientMultiplier) || G.currentMultiplier,
    G.currentMultiplier
  );
  const profit      = round2(bet.amount * (multiplier - 1));
  const totalReturn = bet.amount + profit;

  bet.cashoutMultiplier = multiplier;
  bet.profit            = profit;

  try {
    const user = await User.findOneAndUpdate(
      { telegramId: userId },
      { $inc: { balance: totalReturn, totalWins: 1 } },
      { new: true }
    );

    if (user) {
      Bet.findOneAndUpdate(
        { userId, gameId: G.gameId },
        { cashoutMultiplier: multiplier, profit, status: 'won', cashedAt: new Date() }
      ).catch(e => console.error('Bet update error:', e));

      io.emit('balanceUpdate', { userId, balance: user.balance });
    }

    io.emit('betResult', {
      success: true, type: 'cashout',
      userId, gameId: G.gameId,
      multiplier, profit, betAmount: bet.amount, totalReturn,
    });
    io.emit('newHistory', {
      username: bet.username, start: 1.0, stop: multiplier,
      profit, isBot: false, status: 'won',
    });
    io.emit('activeBets', { bets: activeBetsSnapshot() });

    return { success: true, multiplier, profit, totalReturn, newBalance: user?.balance };
  } catch (err) {
    console.error('cashOut DB error:', err);
    return { success: false, message: 'Server error' };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  BOT SYSTEM — 6-Player Rule
//  ★ No new bot objects created per round — reuse from BOT_POOL
//  ★ Identity protection: rotate bots based on roundCounter
// ═══════════════════════════════════════════════════════════════════════════

function placeBotBets() {
  if (G.phase !== 'countdown') return;

  // How many real users have already bet this round?
  let realUserCount = 0;
  for (const b of G.bets.values()) {
    if (!b.isBot) realUserCount++;
  }

  const botsNeeded = Math.max(0, TOTAL_PLAYERS - realUserCount);
  if (botsNeeded === 0) return;

  // ★ Identity Protection: exclude bots used in the previous round
  // Filter bots that didn't play last round (lastRound !== roundCounter - 1)
  const freshBots = BOT_ARRAY.filter(b => b.lastRound !== roundCounter - 1);

  // Pick botsNeeded unique bots with a shuffled fresh list
  const selected = shuffleSlice(
    freshBots.length >= botsNeeded ? freshBots : BOT_ARRAY,
    botsNeeded
  );

  selected.forEach(bot => {
    const minBet = 200;
    const maxBet = Math.min(1500, bot.balance);
    if (bot.balance < minBet) {
      bot.balance = 5000; // Replenish exhausted bots
    }
    const amount = minBet + Math.floor(Math.random() * (maxBet - minBet));

    bot.balance   -= amount;
    bot.lastRound  = roundCounter;  // ★ mark as used this round

    G.bets.set(bot.id, {
      userId:            bot.id,
      username:          bot.username,
      amount,
      isBot:             true,
      strategy:          bot.strategy,
      gameId:            G.gameId,
      placedAt:          Date.now(),
      cashedAt:          null,
      cashoutMultiplier: null,
      profit:            null,
    });
    G.totalBetsAmount += amount;
  });

  console.log(`🤖 Round ${roundCounter}: ${realUserCount} real user(s) + ${selected.length} bots = ${realUserCount + selected.length} players`);
  io.emit('activeBets', { bets: activeBetsSnapshot() });
}

// ─── Bot cashout processing ───────────────────────────────────────────────────

function processBotCashouts() {
  for (const [uid, bet] of G.bets.entries()) {
    if (!bet.isBot || bet.cashedAt) continue;

    const m = G.currentMultiplier;
    let shouldCash = false;

    // Bots cash out more conservatively when crash point is low
    // (they "know" the game is rigged — simulates smart bot behaviour)
    const isLowCrash = G.crashPoint <= 1.5;

    switch (bet.strategy) {
      case 'early':
        shouldCash = isLowCrash
          ? m > 1.05 && m < 1.25 && Math.random() < 0.50
          : m > 1.20 && m < 2.00 && Math.random() < 0.25;
        break;
      case 'medium':
        shouldCash = isLowCrash
          ? m > 1.10 && m < 1.35 && Math.random() < 0.40
          : m > 2.00 && m < 5.00 && Math.random() < 0.18;
        break;
      case 'late':
        shouldCash = isLowCrash
          ? m > 1.15 && Math.random() < 0.35
          : m > 5.00 && m < 10.0 && Math.random() < 0.12;
        break;
      case 'random':
        shouldCash = Math.random() < (isLowCrash ? 0.15 : 0.08);
        break;
    }

    if (!shouldCash) continue;

    const profit = round2(bet.amount * (m - 1));
    bet.cashedAt          = Date.now();
    bet.cashoutMultiplier = m;
    bet.profit            = profit;

    // Update bot balance in pool (reuse object)
    const botObj = BOT_POOL.get(uid);
    if (botObj) botObj.balance += bet.amount + profit;

    io.emit('newHistory', {
      username: bet.username, start: 1.0, stop: m,
      profit, isBot: true, status: 'won',
    });
    io.emit('activeBets', { bets: activeBetsSnapshot() });
  }
}

// ─── Process bet loss ──────────────────────────────────────────────────────────

async function processBetLoss(userId, bet) {
  if (!bet.isBot) {
    Bet.findOneAndUpdate(
      { userId, gameId: G.gameId }, { status: 'lost' }
    ).catch(e => console.error('BetLoss error:', e));
  } else {
    // Replenish bot balance so it never runs dry
    const botObj = BOT_POOL.get(userId);
    if (botObj && botObj.balance < 1000) botObj.balance += 3000;
  }

  io.emit('newHistory', {
    username: bet.username, start: 1.0, stop: G.crashPoint,
    profit: -bet.amount, isBot: bet.isBot, status: 'lost',
  });
}

// ═══════════════════════════════════════════════════════════════════════════
//  SOCKET.IO
// ═══════════════════════════════════════════════════════════════════════════

io.on('connection', (socket) => {
  const userId = socket.handshake.query.userId || null;
  socket.userId = userId;
  console.log(`🟢 [${socket.id}] uid=${userId}`);

  socket.emit('gameState', {
    phase:      G.phase,
    gameId:     G.gameId,
    multiplier: G.currentMultiplier,
    history:    G.history.slice(0, 10),
  });
  socket.emit('activeBets', { bets: activeBetsSnapshot() });

  if (G.phase === 'running') {
    socket.emit('multiplier', { multiplier: G.currentMultiplier, phase: 'running' });
  }

  socket.on('placeBet', async (data, cb) => {
    if (typeof cb !== 'function') return;
    if (!data?.userId || !data?.username || !data?.amount) {
      return cb({ success: false, message: 'Invalid payload' });
    }
    cb(await placeBet(String(data.userId), String(data.username), Number(data.amount)));
  });

  socket.on('cashOut', async (data, cb) => {
    if (typeof cb !== 'function') return;
    if (!data?.userId) return cb({ success: false, message: 'Invalid payload' });
    cb(await cashOut(String(data.userId), data.multiplier, data.gameId));
  });

  socket.on('authenticate', (data) => {
    if (data?.userId) socket.userId = String(data.userId);
  });

  socket.on('disconnect', (reason) => {
    console.log(`🔴 [${socket.id}] uid=${socket.userId} ${reason}`);
  });

  socket.on('error', (err) => console.error(`Socket err [${socket.id}]:`, err.message));
});

// ═══════════════════════════════════════════════════════════════════════════
//  API ROUTES
// ═══════════════════════════════════════════════════════════════════════════

app.post('/api/auth', async (req, res) => {
  try {
    const { id, username, first_name, last_name } = req.body;
    if (!id) return res.status(400).json({ success: false, message: 'Missing id' });
    const tid = String(id);
    let user  = await User.findOne({ telegramId: tid });
    if (!user) {
      user = await User.create({ telegramId: tid, username, firstName: first_name, lastName: last_name, balance: 1000 });
    } else {
      if (user.isBanned) return res.json({ success: false, banned: true, message: 'Banned' });
      user.lastActive = new Date();
      await user.save();
    }
    res.json({ success: true, user: {
      id: user.telegramId, username: user.username,
      balance: user.balance, totalDeposited: user.totalDeposited, totalWithdrawn: user.totalWithdrawn,
    }});
  } catch (err) {
    console.error('auth:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.post('/api/deposit', async (req, res) => {
  try {
    const { userId, username, name, phone, amount } = req.body;
    if (!userId || !name || !phone || !amount || Number(amount) < 3000) {
      return res.status(400).json({ success: false, message: 'Invalid data or amount < 3000' });
    }
    await Transaction.create({ userId, username, type: 'deposit', amount: Number(amount), accountName: name, accountNumber: phone });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ★ Withdraw — Minimum 5,000 MMK
app.post('/api/withdraw', async (req, res) => {
  try {
    const { userId, username, name, phone, amount } = req.body;
    const amt = Number(amount);

    if (!userId || !name || !phone || !amt || amt <= 0) {
      return res.status(400).json({ success: false, message: 'Invalid data' });
    }

    // ★ Minimum withdrawal enforcement
    if (amt < MIN_WITHDRAWAL) {
      return res.status(400).json({
        success: false,
        message: `အနည်းဆုံး ${MIN_WITHDRAWAL.toLocaleString()} MMK ထုတ်ရမည်`,
      });
    }

    const user = await User.findOneAndUpdate(
      { telegramId: userId, balance: { $gte: amt } },
      { $inc: { balance: -amt, totalWithdrawn: amt } },
      { new: true }
    );
    if (!user) {
      const ex = await User.findOne({ telegramId: userId });
      return res.status(400).json({ success: false, message: ex ? 'လက်ကျန်မလုံလောက်' : 'User not found' });
    }

    await Transaction.create({ userId, username, type: 'withdraw', amount: amt, accountName: name, accountNumber: phone });

    io.emit('balanceUpdate', { userId, balance: user.balance });
    res.json({ success: true, newBalance: user.balance });
  } catch (err) {
    console.error('withdraw:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── Admin middleware ──────────────────────────────────────────────────────────

function adminGuard(req, res, next) {
  const id = req.headers['x-telegram-id'];
  if (!id || !ADMIN_IDS.includes(id)) return res.status(403).json({ success: false, message: 'Unauthorized' });
  next();
}

app.get('/api/admin/users', adminGuard, async (req, res) => {
  try { res.json({ success: true, users: await User.find().sort({ createdAt: -1 }).limit(200).lean() }); }
  catch { res.status(500).json({ success: false, message: 'Server error' }); }
});

app.get('/api/admin/transactions', adminGuard, async (req, res) => {
  try { res.json({ success: true, transactions: await Transaction.find().sort({ createdAt: -1 }).limit(200).lean() }); }
  catch { res.status(500).json({ success: false, message: 'Server error' }); }
});

app.post('/api/admin/user/balance', adminGuard, async (req, res) => {
  try {
    const { userId, action, amount } = req.body;
    const amt = Number(amount);
    if (!userId || !action || !amt) return res.status(400).json({ success: false, message: 'Missing fields' });
    let user;
    if (action === 'add') {
      user = await User.findOneAndUpdate({ telegramId: userId }, { $inc: { balance: amt, totalDeposited: amt } }, { new: true });
    } else if (action === 'deduct') {
      user = await User.findOneAndUpdate(
        { telegramId: userId, balance: { $gte: amt } },
        { $inc: { balance: -amt, totalWithdrawn: amt } }, { new: true }
      );
      if (!user) return res.status(400).json({ success: false, message: 'Insufficient balance' });
    } else return res.status(400).json({ success: false, message: 'Invalid action' });
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    io.emit('balanceUpdate', { userId, balance: user.balance });
    res.json({ success: true, balance: user.balance });
  } catch { res.status(500).json({ success: false, message: 'Server error' }); }
});

app.post('/api/admin/user/ban', adminGuard, async (req, res) => {
  try {
    const { userId, ban, reason } = req.body;
    const update = ban
      ? { isBanned: true,  banReason: reason || 'No reason', bannedAt: new Date() }
      : { isBanned: false, banReason: null, bannedAt: null };
    const user = await User.findOneAndUpdate({ telegramId: userId }, update);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    res.json({ success: true });
  } catch { res.status(500).json({ success: false, message: 'Server error' }); }
});

app.post('/api/admin/transaction/process', adminGuard, async (req, res) => {
  try {
    const { transactionId, status, adminNote } = req.body;
    const tx = await Transaction.findById(transactionId);
    if (!tx) return res.status(404).json({ success: false, message: 'Not found' });
    if (tx.status !== 'pending') return res.status(400).json({ success: false, message: 'Already processed' });

    if (status === 'confirmed' && tx.type === 'deposit') {
      const u = await User.findOneAndUpdate(
        { telegramId: tx.userId },
        { $inc: { balance: tx.amount, totalDeposited: tx.amount } },
        { new: true }
      );
      if (u) io.emit('balanceUpdate', { userId: tx.userId, balance: u.balance });
    }
    if (status === 'rejected' && tx.type === 'withdraw') {
      const u = await User.findOneAndUpdate(
        { telegramId: tx.userId },
        { $inc: { balance: tx.amount, totalWithdrawn: -tx.amount } },
        { new: true }
      );
      if (u) io.emit('balanceUpdate', { userId: tx.userId, balance: u.balance });
    }

    tx.status = status; tx.adminNote = adminNote || '';
    tx.confirmedBy = req.headers['x-telegram-id']; tx.confirmedAt = new Date();
    await tx.save();
    res.json({ success: true });
  } catch (err) {
    console.error('tx process:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── Admin: house stats ─────────────────────────────────────────────────────────
app.get('/api/admin/house', adminGuard, (req, res) => {
  res.json({
    success: true,
    houseBalance,
    round: roundCounter,
    phase: G.phase,
    bets:  G.bets.size,
    botPoolSize: BOT_POOL.size,
  });
});

// ── Admin: set house balance (for testing pressure mode) ───────────────────────
app.post('/api/admin/house/balance', adminGuard, (req, res) => {
  const amt = Number(req.body.amount);
  if (!Number.isFinite(amt) || amt < 0) return res.status(400).json({ success: false });
  houseBalance = amt;
  console.log(`Admin set houseBalance → ${houseBalance}`);
  res.json({ success: true, houseBalance });
});

// ── Health check ───────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({
  status: 'ok', phase: G.phase, gameId: G.gameId,
  round: roundCounter, bots: BOT_POOL.size, db: dbReady, house: houseBalance,
}));

// ─── Start ─────────────────────────────────────────────────────────────────────

startGameLoop();

if (process.env.BOT_TOKEN) {
  bot.launch().then(() => console.log('🤖 Bot started')).catch(console.error);
}

const PORT = Number(process.env.PORT) || 3000;
server.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`));

const shutdown = sig => {
  bot.stop(sig);
  server.close(() => mongoose.disconnect().then(() => process.exit(0)));
};
process.once('SIGINT',  () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
