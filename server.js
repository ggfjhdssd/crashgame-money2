/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  CRASH PRO — server.js  v5.0
 *
 *  CHANGES:
 *   1. FOMO trick ဖျက် — cashout ပြီးနောက် "x.xxထိတက်သွားသည်" မပြ
 *   2. 1.00x crash 35% (was 12%) — ပိုများသောအကြိမ် instant total loss
 *   3. 30,000+ total bet → 1.00x crash ချက်ချင်း (total wipe)
 *   4. Telegram Bot /start → welcome + 1000ကျပ် + Play button
 *   5. Telegram Bot /admin → admin only → admin panel link button
 * ═══════════════════════════════════════════════════════════════════════════
 */

'use strict';

const express      = require('express');
const http         = require('http');
const { Server }   = require('socket.io');
const mongoose     = require('mongoose');
const cors         = require('cors');
const dotenv       = require('dotenv');
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

// Game & Admin URLs
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
  MAX_MULTIPLIER:         15.00,
  FIXED_CAP_MAX:          1.99,

  // ★ Total bet ≥ 30,000 → immediate 1.00x wipe
  HIGH_BET_THRESHOLD:     30000,

  // ★ 35% of all games → instant 1.00x crash
  INSTANT_LOSS_RATE:      0.35,

  // Player Entry Trigger
  ENTRY_TRIGGER_MAX:      1.50,

  // Pressure mode
  PRESSURE_BALANCE_LIMIT: 5000,
  PRESSURE_TRIGGER_RATE:  0.65,
  PRESSURE_CRASH_MIN:     1.01,
  PRESSURE_CRASH_MAX:     1.12,

  // High-roller trap
  HIGH_ROLLER_THRESHOLD:  8000,
  HIGH_ROLLER_CRASH_MIN:  1.05,
  HIGH_ROLLER_CRASH_MAX:  1.35,
};

let houseBalance = 500000;

function r2(n) { return Math.round(n * 100) / 100; }
const rand = () => Math.random();

// ═══════════════════════════════════════════════════════════════════════════
//  CRASH POINT  (priority ladder)
//
//  1. ★ High bet pool ≥30k  → 1.00x (total wipe)
//  2. ★ Instant-loss 35%    → 1.00x
//  3. Pressure mode          → 1.01–1.12x
//  4. High-roller trap       → 1.05–1.35x
//  5. Entry Trigger          → 1.05–1.50x
//  6. Normal                 → 1.10–1.99x
// ═══════════════════════════════════════════════════════════════════════════
function calculateCrashPoint(totalUserBets = 0, maxSingleBet = 0, hasRealUser = false) {

  // 1. ★ High-bet pool wipe
  if (totalUserBets >= HOUSE.HIGH_BET_THRESHOLD) {
    console.log(`💣 HIGH BET WIPE 1.00x (pool=${totalUserBets})`);
    return 1.00;
  }

  // 2. ★ Instant-loss 35%
  if (rand() < HOUSE.INSTANT_LOSS_RATE) {
    console.log(`🎰 Instant-loss 1.00x`);
    return 1.00;
  }

  // 3. Pressure mode
  if (houseBalance < HOUSE.PRESSURE_BALANCE_LIMIT && rand() < HOUSE.PRESSURE_TRIGGER_RATE) {
    return r2(HOUSE.PRESSURE_CRASH_MIN + rand() * (HOUSE.PRESSURE_CRASH_MAX - HOUSE.PRESSURE_CRASH_MIN));
  }

  // 4. High-roller trap
  if (maxSingleBet >= HOUSE.HIGH_ROLLER_THRESHOLD && rand() < 0.72) {
    return r2(HOUSE.HIGH_ROLLER_CRASH_MIN + rand() * (HOUSE.HIGH_ROLLER_CRASH_MAX - HOUSE.HIGH_ROLLER_CRASH_MIN));
  }

  // 5. Entry Trigger
  if (hasRealUser && rand() < 0.75) {
    const cp = r2(1.05 + rand() * (HOUSE.ENTRY_TRIGGER_MAX - 1.05));
    console.log(`🎯 Entry trigger → ${cp}x`);
    return cp;
  }

  // 6. Normal range
  return r2(1.10 + rand() * (HOUSE.FIXED_CAP_MAX - 1.10));
}

function generateDemoCrashPoint() {
  return r2(3.0 + rand() * 7.0);
}

// ═══════════════════════════════════════════════════════════════════════════
//  BOT POOL — 80 Myanmar bots
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
const BOT_POOL   = new Map();
const BOT_ARRAY  = [];

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
const MULTIPLIER_TICK_MS = 50;
const BETWEEN_GAME_MS    = 3000;
const GROWTH_RATE        = 0.08;
const TOTAL_PLAYERS      = 6;
const MIN_WITHDRAWAL     = 5000;

let roundCounter = 0;

function createFreshState() {
  return {
    phase:              'idle',
    gameId:             null,
    crashPoint:         0,
    currentMultiplier:  1.0,
    startTime:          null,
    bets:               new Map(),
    totalBetsAmount:    0,
    totalUserBets:      0,
    maxSingleUserBet:   0,
    hasRealUser:        false,
    history:            [],
  };
}
let G = createFreshState();

const sleep          = ms => new Promise(r => setTimeout(r, ms));
const generateGameId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

function activeBetsSnapshot() {
  const out = [];
  for (const b of G.bets.values()) {
    if (!b.cashedAt) out.push({ username: b.username, amount: b.amount, isBot: b.isBot });
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
//  ★ TELEGRAM BOT
// ═══════════════════════════════════════════════════════════════════════════

// /start — welcome message + 1000ကျပ် + Play button
bot.start(async (ctx) => {
  try {
    const from     = ctx.from;
    const tid      = String(from.id);
    const name     = from.first_name || from.username || 'ဂုဏ်ယူသောကစားသမား';
    const username = from.username
      || `${from.first_name ?? ''}${from.last_name ? ' '+from.last_name : ''}`.trim()
      || `User_${tid.slice(-4)}`;

    // Auto-register new user with 1000 balance
    try {
      const existing = await User.findOne({ telegramId: tid });
      if (!existing) {
        await User.create({
          telegramId: tid, username,
          firstName: from.first_name,
          lastName: from.last_name,
          balance: 1000,
        });
        console.log(`🆕 New user: ${username} (${tid})`);
      }
    } catch (dbErr) {
      console.error('DB /start error:', dbErr.message);
    }

    await ctx.replyWithHTML(
      `🎉 <b>ကြိုဆိုပါတယ် ${name}!</b>\n\n` +
      `🎁 ကြိုဆိုလက်ဆောင် <b>1,000 ကျပ်</b> ရရှိပါသည်။\n\n` +
      `💰 ပိုက်ဆံရှာပြီး ဂိမ်းကစားရန် <b>Play</b> button ကိုနှိပ်ပါ။`,
      Markup.inlineKeyboard([
        [Markup.button.webApp('🎮 Play Now', GAME_URL)],
      ])
    );
  } catch (err) {
    console.error('/start handler error:', err.message);
  }
});

// /admin — admin only → sends admin panel button
bot.command('admin', async (ctx) => {
  const tid = String(ctx.from.id);

  if (!ADMIN_IDS.includes(tid)) {
    return ctx.reply('⛔ Admin access မရှိပါ။');
  }

  await ctx.replyWithHTML(
    `🔐 <b>Admin Panel</b>\n\n` +
    `Admin menu ကိုဝင်ရောက်ရန် အောက်ပါ button ကိုနှိပ်ပါ။`,
    Markup.inlineKeyboard([
      [Markup.button.url('⚙️ Admin Panel ဝင်ရန်', ADMIN_PANEL_URL)],
    ])
  );
});

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
      console.error('🔥 Loop error:', err);
      await sleep(2000);
    }
  }
}

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

  const demoPoint = generateDemoCrashPoint();
  io.emit('countdown', { seconds: COUNTDOWN_SECONDS, gameId: G.gameId, demoPoint });

  setTimeout(placeBotBets, 600 + Math.floor(rand() * 900));
  await sleep(COUNTDOWN_SECONDS * 1000);

  G.crashPoint = calculateCrashPoint(G.totalUserBets, G.maxSingleUserBet, G.hasRealUser);

  console.log(
    `📊 Round ${roundCounter} | crash=${G.crashPoint}x | ` +
    `userBets=${G.totalUserBets} | hasReal=${G.hasRealUser} | house=${houseBalance}`
  );
}

async function runGame() {
  G.phase     = 'running';
  G.startTime = Date.now();
  io.emit('gameStart', { gameId: G.gameId, bets: activeBetsSnapshot() });

  // ★ For 1.00x crash — emit once then crash immediately
  if (G.crashPoint <= 1.00) {
    G.currentMultiplier = 1.00;
    io.emit('multiplier', { multiplier: 1.00, phase: 'running', ts: Date.now() });
    await sleep(300); // brief pause so client sees 1.00x
    await crashGame();
    return;
  }

  while (G.phase === 'running') {
    const elapsed = (Date.now() - G.startTime) / 1000;
    const mult    = r2(Math.pow(Math.E, GROWTH_RATE * elapsed));
    G.currentMultiplier = mult;

    if (mult >= G.crashPoint) {
      G.currentMultiplier = G.crashPoint;
      io.emit('multiplier', { multiplier: G.currentMultiplier, phase: 'running', ts: Date.now() });
      await crashGame();
      break;
    }

    io.emit('multiplier', { multiplier: mult, phase: 'running', ts: Date.now() });
    processBotCashouts();
    await sleep(MULTIPLIER_TICK_MS);
  }
}

async function crashGame() {
  G.phase = 'crashed';
  console.log(`💥 Round ${roundCounter} @ ${G.crashPoint}x`);

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

  G.history.unshift({ gameId: G.gameId, crashPoint: G.crashPoint, totalBets: G.totalBetsAmount, timestamp: Date.now() });
  if (G.history.length > 50) G.history.length = 50;

  io.emit('gameCrashed', { multiplier: G.crashPoint, gameId: G.gameId });
}

// ═══════════════════════════════════════════════════════════════════════════
//  PLACE BET
// ═══════════════════════════════════════════════════════════════════════════
async function placeBet(userId, username, amount) {
  if (G.phase !== 'countdown') {
    return { success: false, message: G.phase === 'running' ? 'ဂိမ်းစပြီးပါပြီ — နောက်ပတ်တွင် Bet လောင်းပါ' : 'Countdown မစသေးပါ' };
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

    const bet = { userId, username, amount, isBot: false, gameId: G.gameId, placedAt: Date.now(), cashedAt: null, cashoutMultiplier: null, profit: null };
    G.bets.set(userId, bet);
    G.totalBetsAmount  += amount;
    G.totalUserBets    += amount;
    if (amount > G.maxSingleUserBet) G.maxSingleUserBet = amount;

    if (!G.hasRealUser) {
      G.hasRealUser = true;
      console.log(`🎯 Entry trigger armed — ${username} bet=${amount}`);
    }

    Bet.create({ userId, username, amount, gameId: G.gameId, status: 'pending' }).catch(e => console.error('Bet.create:', e));
    io.emit('balanceUpdate', { userId, balance: user.balance });
    io.emit('activeBets',    { bets: activeBetsSnapshot() });
    return { success: true, newBalance: user.balance };
  } catch (err) {
    console.error('placeBet:', err);
    return { success: false, message: 'Server error' };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  CASH OUT
// ═══════════════════════════════════════════════════════════════════════════
async function cashOut(userId, clientMultiplier, clientGameId) {
  if (G.phase !== 'running') return { success: false, message: 'ဂိမ်း Crash ဖြစ်သွားပြီ — Cashout မရတော့ပါ' };
  if (clientGameId && clientGameId !== G.gameId) return { success: false, message: 'Game session မမှန်ကန်' };

  const bet = G.bets.get(userId);
  if (!bet)         return { success: false, message: 'Active bet မရှိပါ' };
  if (bet.cashedAt) return { success: false, message: 'ရပြီးသားဖြစ်သည်' };

  bet.cashedAt = Date.now();
  const multiplier  = Math.min(parseFloat(clientMultiplier) || G.currentMultiplier, G.currentMultiplier);
  const profit      = r2(bet.amount * (multiplier - 1));
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
      Bet.findOneAndUpdate({ userId, gameId: G.gameId }, { cashoutMultiplier: multiplier, profit, status: 'won', cashedAt: new Date() }).catch(e => console.error('Bet update:', e));
      io.emit('balanceUpdate', { userId, balance: user.balance });
    }
    // ★ No visualCrashHint — FOMO removed
    io.emit('betResult', { success: true, type: 'cashout', userId, gameId: G.gameId, multiplier, profit, betAmount: bet.amount, totalReturn });
    io.emit('newHistory', { username: bet.username, start: 1.0, stop: multiplier, profit, isBot: false, status: 'won' });
    io.emit('activeBets', { bets: activeBetsSnapshot() });
    return { success: true, multiplier, profit, totalReturn, newBalance: user?.balance };
  } catch (err) {
    console.error('cashOut:', err);
    return { success: false, message: 'Server error' };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  BOT SYSTEM
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
    bot.balance  -= amount;
    bot.lastRound = roundCounter;
    G.bets.set(bot.id, { userId: bot.id, username: bot.username, amount, isBot: true, strategy: bot.strategy, gameId: G.gameId, placedAt: Date.now(), cashedAt: null, cashoutMultiplier: null, profit: null });
    G.totalBetsAmount += amount;
  });
  io.emit('activeBets', { bets: activeBetsSnapshot() });
}

function processBotCashouts() {
  if (G.crashPoint <= 1.00) return; // no bots cash out on instant-loss rounds
  const isLowCrash = G.crashPoint <= 1.5;
  for (const [uid, bet] of G.bets.entries()) {
    if (!bet.isBot || bet.cashedAt) continue;
    const m = G.currentMultiplier;
    let shouldCash = false;
    switch (bet.strategy) {
      case 'early':  shouldCash = isLowCrash ? m > 1.05 && m < 1.25 && rand() < 0.55 : m > 1.20 && m < 2.00 && rand() < 0.22; break;
      case 'medium': shouldCash = isLowCrash ? m > 1.10 && m < 1.35 && rand() < 0.45 : m > 2.00 && m < 5.00 && rand() < 0.16; break;
      case 'late':   shouldCash = isLowCrash ? m > 1.15 && rand() < 0.40 : m > 5.00 && m < 10.0 && rand() < 0.12; break;
      case 'random': shouldCash = rand() < (isLowCrash ? 0.18 : 0.07); break;
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
    Bet.findOneAndUpdate({ userId, gameId: G.gameId }, { status: 'lost' }).catch(e => console.error('BetLoss:', e));
  } else {
    const b = BOT_POOL.get(userId);
    if (b && b.balance < 1000) b.balance += 3000;
  }
  io.emit('newHistory', { username: bet.username, start: 1.0, stop: G.crashPoint, profit: -bet.amount, isBot: bet.isBot, status: 'lost' });
}

// ═══════════════════════════════════════════════════════════════════════════
//  SOCKET.IO
// ═══════════════════════════════════════════════════════════════════════════
io.on('connection', (socket) => {
  socket.userId = socket.handshake.query.userId || null;
  console.log(`🟢 [${socket.id}] uid=${socket.userId}`);

  socket.emit('gameState', { phase: G.phase, gameId: G.gameId, multiplier: G.currentMultiplier, history: G.history.slice(0, 10), ts: Date.now() });
  socket.emit('activeBets', { bets: activeBetsSnapshot() });
  if (G.phase === 'running') {
    socket.emit('multiplier', { multiplier: G.currentMultiplier, phase: 'running', ts: Date.now() });
  }

  socket.on('placeBet', async (data, cb) => {
    if (typeof cb !== 'function') return;
    if (!data?.userId || !data?.username || !data?.amount) return cb({ success: false, message: 'Invalid payload' });
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
    res.json({ success: true, user: { id: user.telegramId, username: user.username, balance: user.balance, totalDeposited: user.totalDeposited, totalWithdrawn: user.totalWithdrawn } });
  } catch { res.status(500).json({ success: false, message: 'Server error' }); }
});

app.post('/api/deposit', async (req, res) => {
  try {
    const { userId, username, name, phone, amount } = req.body;
    if (!userId || !name || !phone || !amount || Number(amount) < 3000) return res.status(400).json({ success: false, message: 'Invalid data or amount < 3000' });
    await Transaction.create({ userId, username, type: 'deposit', amount: Number(amount), accountName: name, accountNumber: phone });
    res.json({ success: true });
  } catch { res.status(500).json({ success: false, message: 'Server error' }); }
});

app.post('/api/withdraw', async (req, res) => {
  try {
    const { userId, username, name, phone, amount } = req.body;
    const amt = Number(amount);
    if (!userId || !name || !phone || !amt || amt <= 0) return res.status(400).json({ success: false, message: 'Invalid data' });
    if (amt < MIN_WITHDRAWAL) return res.status(400).json({ success: false, message: `အနည်းဆုံး ${MIN_WITHDRAWAL.toLocaleString()} MMK ထုတ်ရမည်` });
    const user = await User.findOneAndUpdate({ telegramId: userId, balance: { $gte: amt } }, { $inc: { balance: -amt, totalWithdrawn: amt } }, { new: true });
    if (!user) {
      const ex = await User.findOne({ telegramId: userId });
      return res.status(400).json({ success: false, message: ex ? 'လက်ကျန်မလုံလောက်' : 'User not found' });
    }
    await Transaction.create({ userId, username, type: 'withdraw', amount: amt, accountName: name, accountNumber: phone });
    io.emit('balanceUpdate', { userId, balance: user.balance });
    res.json({ success: true, newBalance: user.balance });
  } catch { res.status(500).json({ success: false, message: 'Server error' }); }
});

function adminGuard(req, res, next) {
  const id = req.headers['x-telegram-id'];
  if (!id || !ADMIN_IDS.includes(id)) return res.status(403).json({ success: false, message: 'Unauthorized' });
  next();
}

app.get('/api/admin/users',        adminGuard, async (req, res) => { try { res.json({ success: true, users: await User.find().sort({ createdAt: -1 }).limit(200).lean() }); } catch { res.status(500).json({ success: false }); } });
app.get('/api/admin/transactions', adminGuard, async (req, res) => { try { res.json({ success: true, transactions: await Transaction.find().sort({ createdAt: -1 }).limit(200).lean() }); } catch { res.status(500).json({ success: false }); } });

app.post('/api/admin/user/balance', adminGuard, async (req, res) => {
  try {
    const { userId, action, amount } = req.body;
    const amt = Number(amount);
    if (!userId || !action || !amt) return res.status(400).json({ success: false, message: 'Missing fields' });
    let user;
    if (action === 'add') {
      user = await User.findOneAndUpdate({ telegramId: userId }, { $inc: { balance: amt, totalDeposited: amt } }, { new: true });
    } else if (action === 'deduct') {
      user = await User.findOneAndUpdate({ telegramId: userId, balance: { $gte: amt } }, { $inc: { balance: -amt, totalWithdrawn: amt } }, { new: true });
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
    const upd = ban ? { isBanned: true, banReason: reason || '', bannedAt: new Date() } : { isBanned: false, banReason: null, bannedAt: null };
    const user = await User.findOneAndUpdate({ telegramId: userId }, upd);
    if (!user) return res.status(404).json({ success: false });
    res.json({ success: true });
  } catch { res.status(500).json({ success: false }); }
});

app.post('/api/admin/transaction/process', adminGuard, async (req, res) => {
  try {
    const { transactionId, status, adminNote } = req.body;
    const tx = await Transaction.findById(transactionId);
    if (!tx)                     return res.status(404).json({ success: false, message: 'Not found' });
    if (tx.status !== 'pending') return res.status(400).json({ success: false, message: 'Already processed' });
    if (status === 'confirmed' && tx.type === 'deposit') {
      const u = await User.findOneAndUpdate({ telegramId: tx.userId }, { $inc: { balance: tx.amount, totalDeposited: tx.amount } }, { new: true });
      if (u) io.emit('balanceUpdate', { userId: tx.userId, balance: u.balance });
    }
    if (status === 'rejected' && tx.type === 'withdraw') {
      const u = await User.findOneAndUpdate({ telegramId: tx.userId }, { $inc: { balance: tx.amount, totalWithdrawn: -tx.amount } }, { new: true });
      if (u) io.emit('balanceUpdate', { userId: tx.userId, balance: u.balance });
    }
    tx.status = status; tx.adminNote = adminNote || '';
    tx.confirmedBy = req.headers['x-telegram-id']; tx.confirmedAt = new Date();
    await tx.save();
    res.json({ success: true });
  } catch { res.status(500).json({ success: false }); }
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
app.get('/health', (req, res) => res.json({ status: 'ok', phase: G.phase, round: roundCounter, bots: BOT_POOL.size, db: dbReady, house: houseBalance }));

// ─── Start ────────────────────────────────────────────────────────────────────
startGameLoop();
if (process.env.BOT_TOKEN) {
  bot.launch().then(() => console.log('🤖 Telegram Bot started')).catch(console.error);
}
const PORT = Number(process.env.PORT) || 3000;
server.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`));
const shutdown = sig => { bot.stop(sig); server.close(() => mongoose.disconnect().then(() => process.exit(0))); };
process.once('SIGINT',  () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
