/**
 * ═══════════════════════════════════════════════════════════════
 *  CRASH PRO — server.js  (Production-grade rewrite)
 *  Fixes:
 *   1. Bets placed during countdown are PRESERVED when game starts
 *   2. gameId generated at countdown start (not game start)
 *   3. 50ms multiplier broadcast interval
 *   4. Strict cashOut: validates gameId + isRunning + no double-spend
 *   5. MongoDB connection-drop handling with retry
 *   6. Graceful socket disconnect cleanup
 *   7. Atomic-style balance ops via findOneAndUpdate to reduce race risk
 * ═══════════════════════════════════════════════════════════════
 */

'use strict';

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const mongoose   = require('mongoose');
const cors       = require('cors');
const dotenv     = require('dotenv');
const { Telegraf } = require('telegraf');

dotenv.config();

// ─── Express + Socket.io setup ────────────────────────────────────────────────

const app    = express();
const server = http.createServer(app);

const ALLOWED_ORIGINS = [
  'https://crash-gamemoney.vercel.app',
  'http://localhost:3000'
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

const bot      = new Telegraf(process.env.BOT_TOKEN || 'dummy');
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').filter(Boolean);

// ─── MongoDB with reconnect handling ──────────────────────────────────────────

let dbReady = false;

async function connectDB() {
  try {
    await mongoose.connect(process.env.MONGO_URI, {
      useNewUrlParser:    true,
      useUnifiedTopology: true,
      serverSelectionTimeoutMS: 5000,
    });
    dbReady = true;
    console.log('✅ MongoDB connected');
  } catch (err) {
    console.error('❌ MongoDB connection failed, retrying in 5s…', err.message);
    setTimeout(connectDB, 5000);
  }
}

mongoose.connection.on('disconnected', () => {
  dbReady = false;
  console.warn('⚠️  MongoDB disconnected, reconnecting…');
  setTimeout(connectDB, 3000);
});
mongoose.connection.on('reconnected', () => {
  dbReady = true;
  console.log('✅ MongoDB reconnected');
});

connectDB();

// ─── Schemas ──────────────────────────────────────────────────────────────────

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

// ─── Game constants ────────────────────────────────────────────────────────────

const COUNTDOWN_SECONDS  = 5;    // betting window
const MULTIPLIER_TICK_MS = 50;   // emit interval (50ms = ~20fps)
const BETWEEN_GAME_MS    = 3000; // pause after crash before next countdown
const GROWTH_RATE        = 0.06; // multiplier growth per second (tune as needed)

// ─── Game state ───────────────────────────────────────────────────────────────
/**
 * phase: 'idle' | 'countdown' | 'running' | 'crashed'
 *
 * KEY DESIGN:
 *  • gameId is generated at the START of countdown so bets reference it.
 *  • gameState.bets (Map) is NEVER reset between countdown and running;
 *    it only clears at the very start of a new countdown cycle.
 *  • startNewGame() copies the countdown bets map reference — no data loss.
 */
const createFreshState = () => ({
  phase:             'idle',      // 'countdown' | 'running' | 'crashed'
  gameId:            null,
  crashPoint:        0,
  currentMultiplier: 1.0,
  startTime:         null,
  bets:              new Map(),   // userId → bet object — lives across countdown→running
  totalBetsAmount:   0,
  history:           [],
});

let G = createFreshState();

// ─── Bot users ────────────────────────────────────────────────────────────────

const BOT_USERS = [
  { id: 'bot1',  username: 'U Thu Ha',      balance: 5000, strategy: 'early'  },
  { id: 'bot2',  username: 'Kyaw Kyaw',     balance: 3000, strategy: 'medium' },
  { id: 'bot3',  username: 'Ma Ma Lay',     balance: 7000, strategy: 'late'   },
  { id: 'bot4',  username: 'Ko Ko Gyi',     balance: 2500, strategy: 'random' },
  { id: 'bot5',  username: 'Daw Hla',       balance: 4500, strategy: 'early'  },
  { id: 'bot6',  username: 'Mg Mg Aung',    balance: 6000, strategy: 'medium' },
  { id: 'bot7',  username: 'Su Su Hlaing',  balance: 3500, strategy: 'late'   },
  { id: 'bot8',  username: 'Zaw Zaw',       balance: 8000, strategy: 'random' },
  { id: 'bot9',  username: 'Aye Aye',       balance: 2800, strategy: 'early'  },
  { id: 'bot10', username: 'Phyo Phyo',     balance: 5200, strategy: 'medium' },
];

// ─── Crash point generator ────────────────────────────────────────────────────

function generateCrashPoint(totalBets) {
  let cp;
  if      (totalBets > 10000) cp = 1.1 + Math.random() * 0.9;
  else if (totalBets > 5000)  cp = 1.2 + Math.random() * 2.8;
  else if (totalBets > 2000)  cp = 1.5 + Math.random() * 5.5;
  else                         cp = Math.random() < 0.3
                                      ? 5  + Math.random() * 15
                                      : 1.1 + Math.random() * 3.9;
  return Math.min(20.0, Math.round(cp * 100) / 100);
}

// ─── Helper ───────────────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));
function generateGameId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ─── activeBets snapshot (for socket broadcast) ───────────────────────────────

function activeBetsSnapshot() {
  return Array.from(G.bets.values())
    .filter(b => !b.cashedAt)
    .map(b => ({ username: b.username, amount: b.amount, isBot: b.isBot }));
}

// ═══════════════════════════════════════════════════════════════
//  GAME LOOP
// ═══════════════════════════════════════════════════════════════

async function startGameLoop() {
  console.log('🎮 Game loop started');
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await runCountdown();
      await runGame();
      // brief pause so clients can see crash screen
      await sleep(BETWEEN_GAME_MS);
    } catch (err) {
      console.error('🔥 Game loop error:', err);
      await sleep(2000); // prevent tight error loop
    }
  }
}

// ─── Phase 1: Countdown ───────────────────────────────────────────────────────

async function runCountdown() {
  // Reset only the bet map and amounts — history is kept
  G.bets            = new Map();   // ← fresh map for this round
  G.totalBetsAmount = 0;
  G.currentMultiplier = 1.0;
  G.phase           = 'countdown';

  // ★ Generate gameId NOW so bets placed during countdown get the right gameId
  G.gameId     = generateGameId();
  G.crashPoint = 0; // will be finalised at game start

  io.emit('countdown', {
    seconds: COUNTDOWN_SECONDS,
    gameId:  G.gameId,
  });

  // Place bot bets during countdown window (after a short delay)
  setTimeout(placeBotBets, 800);

  // Wait the full countdown
  await sleep(COUNTDOWN_SECONDS * 1000);

  // Finalise crash point now that all bets are in
  G.crashPoint = generateCrashPoint(G.totalBetsAmount);
  console.log(`🎲 Game ${G.gameId} — crash @ ${G.crashPoint}x | bets: ${G.totalBetsAmount} MMK`);
}

// ─── Phase 2: Running ─────────────────────────────────────────────────────────

async function runGame() {
  G.phase     = 'running';
  G.startTime = Date.now();

  // ★ DO NOT reset G.bets here — carry forward bets from countdown
  io.emit('gameStart', {
    gameId:     G.gameId,
    crashPoint: G.crashPoint,               // optional: remove if you don't want to reveal
    bets:       activeBetsSnapshot(),
  });

  // Multiplier loop — 50ms ticks
  while (G.phase === 'running') {
    const elapsed = (Date.now() - G.startTime) / 1000;
    // Exponential growth: e^(rate * t)
    const mult = Math.pow(Math.E, GROWTH_RATE * elapsed);
    G.currentMultiplier = Math.round(mult * 100) / 100;

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

  // Process all bets that weren't cashed out
  const lossPromises = [];
  for (const [uid, bet] of G.bets.entries()) {
    if (!bet.cashedAt) {
      lossPromises.push(processBetLoss(uid, bet));
    }
  }
  await Promise.allSettled(lossPromises); // don't let one failure block others

  // Push to history (keep last 50)
  G.history.unshift({
    gameId:     G.gameId,
    crashPoint: G.crashPoint,
    totalBets:  G.totalBetsAmount,
    timestamp:  Date.now(),
  });
  if (G.history.length > 50) G.history.length = 50;

  io.emit('gameCrashed', {
    multiplier: G.crashPoint,
    gameId:     G.gameId,
  });
}

// ═══════════════════════════════════════════════════════════════
//  PLACE BET  — called during countdown only
// ═══════════════════════════════════════════════════════════════

async function placeBet(userId, username, amount) {
  // ── Phase guard ────────────────────────────────────────────────
  if (G.phase !== 'countdown') {
    return { success: false, message: G.phase === 'running'
      ? 'ဂိမ်းစပြီးပါပြီ — နောက်ပတ်တွင် Bet လောင်းပါ'
      : 'Countdown မစသေးပါ' };
  }

  // ── Duplicate guard ────────────────────────────────────────────
  if (G.bets.has(userId)) {
    return { success: false, message: 'ဤပတ်တွင် Bet လောင်းပြီးပါပြီ' };
  }

  // ── Amount guard ───────────────────────────────────────────────
  amount = Number(amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { success: false, message: 'ငွေပမာဏ မမှန်ကန်' };
  }

  // ── DB guard ───────────────────────────────────────────────────
  if (!dbReady) return { success: false, message: 'Server မသင့်တော်သေးပါ' };

  try {
    // Atomic balance deduction: only deduct if balance is sufficient
    const user = await User.findOneAndUpdate(
      { telegramId: userId, balance: { $gte: amount }, isBanned: false },
      { $inc: { balance: -amount, totalBets: 1 }, $set: { lastActive: new Date() } },
      { new: true }
    );

    if (!user) {
      // Distinguish between "not found", "banned", or "insufficient balance"
      const existing = await User.findOne({ telegramId: userId });
      if (!existing)        return { success: false, message: 'User not found' };
      if (existing.isBanned) return { success: false, message: 'Account banned' };
      return { success: false, message: 'လက်ကျန်မလုံလောက်' };
    }

    // ★ Register bet in the SAME Map that runGame() will use
    const bet = {
      userId,
      username,
      amount,
      isBot:    false,
      gameId:   G.gameId,   // gameId was set at countdown start ✓
      placedAt: Date.now(),
      cashedAt: null,
      cashoutMultiplier: null,
      profit:   null,
    };
    G.bets.set(userId, bet);
    G.totalBetsAmount += amount;

    // Fire-and-forget DB write (non-blocking)
    Bet.create({ userId, username, amount, gameId: G.gameId, status: 'pending' })
       .catch(e => console.error('Bet.create error:', e));

    // Broadcast
    io.emit('balanceUpdate', { userId, balance: user.balance });
    io.emit('activeBets',    { bets: activeBetsSnapshot() });

    return { success: true, newBalance: user.balance };
  } catch (err) {
    console.error('placeBet error:', err);
    return { success: false, message: 'Server error' };
  }
}

// ═══════════════════════════════════════════════════════════════
//  CASH OUT  — strict validation, no double-spend
// ═══════════════════════════════════════════════════════════════

async function cashOut(userId, clientMultiplier, clientGameId) {
  // ── Phase guard ────────────────────────────────────────────────
  if (G.phase !== 'running') {
    return { success: false, message: 'ဂိမ်း Crash ဖြစ်သွားပြီ — Cashout မရတော့ပါ' };
  }

  // ── gameId guard (stale event protection) ──────────────────────
  if (clientGameId && clientGameId !== G.gameId) {
    return { success: false, message: 'Game session မမှန်ကန်' };
  }

  // ── Bet guard ──────────────────────────────────────────────────
  const bet = G.bets.get(userId);
  if (!bet)          return { success: false, message: 'Active bet မရှိပါ' };
  if (bet.cashedAt)  return { success: false, message: 'ရပြီးသားဖြစ်သည် (Double cashout)' };

  // ── Mark cashed immediately (prevents concurrent double-spend) ─
  bet.cashedAt = Date.now();   // ← set BEFORE async DB call

  // Use server-side multiplier (don't trust client fully — clamp to server value)
  const multiplier  = Math.min(
    parseFloat(clientMultiplier) || G.currentMultiplier,
    G.currentMultiplier          // never allow cashout above current server mult
  );
  const profit      = Math.round(bet.amount * (multiplier - 1) * 100) / 100;
  const totalReturn = bet.amount + profit;

  bet.cashoutMultiplier = multiplier;
  bet.profit            = profit;

  if (!dbReady) {
    // Still give winnings even if DB is down (reconcile later)
    console.warn('⚠️  cashOut: DB not ready, processing in-memory only');
  }

  try {
    const user = await User.findOneAndUpdate(
      { telegramId: userId },
      { $inc: { balance: totalReturn, totalWins: 1 } },
      { new: true }
    );

    if (user) {
      // Non-blocking DB bet update
      Bet.findOneAndUpdate(
        { userId, gameId: G.gameId },
        { cashoutMultiplier: multiplier, profit, status: 'won', cashedAt: new Date() }
      ).catch(e => console.error('Bet update error:', e));

      io.emit('balanceUpdate', { userId, balance: user.balance });
    }

    io.emit('betResult', {
      success:     true,
      type:        'cashout',
      userId,
      gameId:      G.gameId,
      multiplier,
      profit,
      betAmount:   bet.amount,
      totalReturn,
    });

    io.emit('newHistory', {
      username:   bet.username,
      start:      1.0,
      stop:       multiplier,
      profit,
      isBot:      false,
      status:     'won',
    });

    io.emit('activeBets', { bets: activeBetsSnapshot() });

    return { success: true, multiplier, profit, totalReturn, newBalance: user?.balance };
  } catch (err) {
    console.error('cashOut DB error:', err);
    // bet.cashedAt is already set so no double-spend even on error
    return { success: false, message: 'Server error — bet recorded locally' };
  }
}

// ─── Bot helpers ──────────────────────────────────────────────────────────────

function placeBotBets() {
  if (G.phase !== 'countdown') return;

  const count    = 4 + Math.floor(Math.random() * 5);
  const selected = [...BOT_USERS].sort(() => Math.random() - 0.5).slice(0, count);

  selected.forEach(bot => {
    const amount = Math.floor(Math.random() * 900) + 100;
    if (bot.balance < amount) return;

    bot.balance -= amount;
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

  io.emit('activeBets', { bets: activeBetsSnapshot() });
}

function processBotCashouts() {
  for (const [uid, bet] of G.bets.entries()) {
    if (!bet.isBot || bet.cashedAt) continue;

    const m = G.currentMultiplier;
    let shouldCash = false;

    switch (bet.strategy) {
      case 'early':  shouldCash = m > 1.3 && m < 2.0  && Math.random() < 0.25; break;
      case 'medium': shouldCash = m > 2.0 && m < 5.0  && Math.random() < 0.18; break;
      case 'late':   shouldCash = m > 5.0 && m < 10.0 && Math.random() < 0.12; break;
      case 'random': shouldCash = Math.random() < 0.08; break;
    }

    if (!shouldCash) continue;

    const profit = Math.round(bet.amount * (m - 1) * 100) / 100;
    bet.cashedAt          = Date.now();
    bet.cashoutMultiplier = m;
    bet.profit            = profit;

    const botUser = BOT_USERS.find(b => b.id === uid);
    if (botUser) botUser.balance += bet.amount + profit;

    io.emit('newHistory', {
      username: bet.username,
      start:    1.0,
      stop:     m,
      profit,
      isBot:    true,
      status:   'won',
    });
    io.emit('activeBets', { bets: activeBetsSnapshot() });
  }
}

// ─── Process bet loss on crash ────────────────────────────────────────────────

async function processBetLoss(userId, bet) {
  if (!bet.isBot) {
    Bet.findOneAndUpdate(
      { userId, gameId: G.gameId },
      { status: 'lost' }
    ).catch(e => console.error('BetLoss update error:', e));
  }

  io.emit('newHistory', {
    username: bet.username,
    start:    1.0,
    stop:     G.crashPoint,
    profit:   -bet.amount,
    isBot:    bet.isBot,
    status:   'lost',
  });
}

// ═══════════════════════════════════════════════════════════════
//  SOCKET.IO  — connection handler
// ═══════════════════════════════════════════════════════════════

io.on('connection', (socket) => {
  const userId = socket.handshake.query.userId || null;
  socket.userId = userId;
  console.log(`🟢 Connect [${socket.id}] uid=${userId}`);

  // Send current state to newly connected client
  socket.emit('gameState', {
    phase:      G.phase,
    gameId:     G.gameId,
    multiplier: G.currentMultiplier,
    history:    G.history.slice(0, 10),
  });
  socket.emit('activeBets', { bets: activeBetsSnapshot() });

  // If game is mid-run, also send a multiplier so client syncs immediately
  if (G.phase === 'running') {
    socket.emit('multiplier', { multiplier: G.currentMultiplier, phase: 'running' });
  }

  // ── placeBet ──────────────────────────────────────────────────
  socket.on('placeBet', async (data, cb) => {
    if (typeof cb !== 'function') return;
    if (!data?.userId || !data?.username || !data?.amount) {
      return cb({ success: false, message: 'Invalid payload' });
    }
    const result = await placeBet(
      String(data.userId),
      String(data.username),
      Number(data.amount)
    );
    cb(result);
  });

  // ── cashOut ───────────────────────────────────────────────────
  socket.on('cashOut', async (data, cb) => {
    if (typeof cb !== 'function') return;
    if (!data?.userId) return cb({ success: false, message: 'Invalid payload' });
    const result = await cashOut(
      String(data.userId),
      data.multiplier,
      data.gameId
    );
    cb(result);
  });

  // ── authenticate ──────────────────────────────────────────────
  socket.on('authenticate', (data) => {
    if (data?.userId) socket.userId = String(data.userId);
  });

  // ── disconnect ────────────────────────────────────────────────
  socket.on('disconnect', (reason) => {
    console.log(`🔴 Disconnect [${socket.id}] uid=${socket.userId} reason=${reason}`);
    // No cleanup needed — bet state lives in G.bets (server-side Map)
  });

  socket.on('error', (err) => {
    console.error(`Socket error [${socket.id}]:`, err.message);
  });
});

// ═══════════════════════════════════════════════════════════════
//  API ROUTES
// ═══════════════════════════════════════════════════════════════

// ── Auth ──────────────────────────────────────────────────────────────────────
app.post('/api/auth', async (req, res) => {
  try {
    const { id, username, first_name, last_name } = req.body;
    if (!id) return res.status(400).json({ success: false, message: 'Missing id' });

    const tid = String(id);
    let user  = await User.findOne({ telegramId: tid });

    if (!user) {
      user = await User.create({
        telegramId: tid, username,
        firstName: first_name, lastName: last_name,
        balance: 1000,
      });
    } else {
      if (user.isBanned) return res.json({ success: false, banned: true, message: 'Banned' });
      user.lastActive = new Date();
      await user.save();
    }

    res.json({
      success: true,
      user: {
        id:             user.telegramId,
        username:       user.username,
        balance:        user.balance,
        totalDeposited: user.totalDeposited,
        totalWithdrawn: user.totalWithdrawn,
      },
    });
  } catch (err) {
    console.error('auth error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── Deposit ───────────────────────────────────────────────────────────────────
app.post('/api/deposit', async (req, res) => {
  try {
    const { userId, username, name, phone, amount } = req.body;
    if (!userId || !name || !phone || !amount || Number(amount) < 3000) {
      return res.status(400).json({ success: false, message: 'Invalid data or amount < 3000' });
    }
    await Transaction.create({
      userId, username, type: 'deposit',
      amount: Number(amount), accountName: name, accountNumber: phone,
    });
    res.json({ success: true, message: 'Deposit request received' });
  } catch (err) {
    console.error('deposit error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── Withdraw (immediate balance deduction) ────────────────────────────────────
app.post('/api/withdraw', async (req, res) => {
  try {
    const { userId, username, name, phone, amount } = req.body;
    const amt = Number(amount);
    if (!userId || !name || !phone || !amt || amt <= 0) {
      return res.status(400).json({ success: false, message: 'Invalid data' });
    }

    // Atomic deduction
    const user = await User.findOneAndUpdate(
      { telegramId: userId, balance: { $gte: amt } },
      { $inc: { balance: -amt, totalWithdrawn: amt } },
      { new: true }
    );
    if (!user) {
      const exists = await User.findOne({ telegramId: userId });
      return res.status(400).json({
        success: false,
        message: exists ? 'လက်ကျန်မလုံလောက်' : 'User not found',
      });
    }

    await Transaction.create({
      userId, username, type: 'withdraw',
      amount: amt, accountName: name, accountNumber: phone,
    });

    io.emit('balanceUpdate', { userId, balance: user.balance });
    res.json({ success: true, newBalance: user.balance, message: 'Withdraw request received' });
  } catch (err) {
    console.error('withdraw error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── Admin middleware ──────────────────────────────────────────────────────────

function adminGuard(req, res, next) {
  const id = req.headers['x-telegram-id'];
  if (!id || !ADMIN_IDS.includes(id)) {
    return res.status(403).json({ success: false, message: 'Unauthorized' });
  }
  next();
}

// ── Admin: list users ─────────────────────────────────────────────────────────
app.get('/api/admin/users', adminGuard, async (req, res) => {
  try {
    const users = await User.find().sort({ createdAt: -1 }).limit(200).lean();
    res.json({ success: true, users });
  } catch (err) { res.status(500).json({ success: false, message: 'Server error' }); }
});

// ── Admin: list transactions ──────────────────────────────────────────────────
app.get('/api/admin/transactions', adminGuard, async (req, res) => {
  try {
    const transactions = await Transaction.find().sort({ createdAt: -1 }).limit(200).lean();
    res.json({ success: true, transactions });
  } catch (err) { res.status(500).json({ success: false, message: 'Server error' }); }
});

// ── Admin: adjust balance ─────────────────────────────────────────────────────
app.post('/api/admin/user/balance', adminGuard, async (req, res) => {
  try {
    const { userId, action, amount } = req.body;
    const amt = Number(amount);
    if (!userId || !action || !amt) return res.status(400).json({ success: false, message: 'Missing fields' });

    let update;
    if (action === 'add') {
      update = { $inc: { balance: amt, totalDeposited: amt } };
    } else if (action === 'deduct') {
      // Only deduct if sufficient balance
      const u = await User.findOneAndUpdate(
        { telegramId: userId, balance: { $gte: amt } },
        { $inc: { balance: -amt, totalWithdrawn: amt } },
        { new: true }
      );
      if (!u) return res.status(400).json({ success: false, message: 'Insufficient balance' });
      io.emit('balanceUpdate', { userId, balance: u.balance });
      return res.json({ success: true, balance: u.balance });
    } else {
      return res.status(400).json({ success: false, message: 'Invalid action' });
    }

    const user = await User.findOneAndUpdate({ telegramId: userId }, update, { new: true });
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    io.emit('balanceUpdate', { userId, balance: user.balance });
    res.json({ success: true, balance: user.balance });
  } catch (err) { res.status(500).json({ success: false, message: 'Server error' }); }
});

// ── Admin: ban/unban ──────────────────────────────────────────────────────────
app.post('/api/admin/user/ban', adminGuard, async (req, res) => {
  try {
    const { userId, ban, reason } = req.body;
    const update = ban
      ? { isBanned: true,  banReason: reason || 'No reason', bannedAt: new Date() }
      : { isBanned: false, banReason: null, bannedAt: null };
    const user = await User.findOneAndUpdate({ telegramId: userId }, update);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, message: 'Server error' }); }
});

// ── Admin: process transaction ────────────────────────────────────────────────
app.post('/api/admin/transaction/process', adminGuard, async (req, res) => {
  try {
    const { transactionId, status, adminNote } = req.body;
    const tx = await Transaction.findById(transactionId);
    if (!tx) return res.status(404).json({ success: false, message: 'Transaction not found' });
    if (tx.status !== 'pending') return res.status(400).json({ success: false, message: 'Already processed' });

    if (status === 'confirmed' && tx.type === 'deposit') {
      const user = await User.findOneAndUpdate(
        { telegramId: tx.userId },
        { $inc: { balance: tx.amount, totalDeposited: tx.amount } },
        { new: true }
      );
      if (user) io.emit('balanceUpdate', { userId: tx.userId, balance: user.balance });
    }

    if (status === 'rejected' && tx.type === 'withdraw') {
      // Refund
      const user = await User.findOneAndUpdate(
        { telegramId: tx.userId },
        { $inc: { balance: tx.amount, totalWithdrawn: -tx.amount } },
        { new: true }
      );
      if (user) {
        io.emit('balanceUpdate', { userId: tx.userId, balance: user.balance });
        console.log(`↩️  Withdraw rejected — refunded ${tx.amount} → ${tx.userId}`);
      }
    }

    tx.status      = status;
    tx.adminNote   = adminNote || '';
    tx.confirmedBy = req.headers['x-telegram-id'];
    tx.confirmedAt = new Date();
    await tx.save();

    res.json({ success: true });
  } catch (err) {
    console.error('process tx error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({
  status: 'ok',
  phase:  G.phase,
  gameId: G.gameId,
  bets:   G.bets.size,
  db:     dbReady,
}));

// ─── Start ────────────────────────────────────────────────────────────────────

startGameLoop();

if (process.env.BOT_TOKEN) {
  bot.launch()
     .then(() => console.log('🤖 Telegram bot started'))
     .catch(err => console.error('Bot launch error:', err));
}

const PORT = Number(process.env.PORT) || 3000;
server.listen(PORT, () => console.log(`🚀 Server listening on port ${PORT}`));

const shutdown = (sig) => {
  console.log(`\n${sig} received — shutting down`);
  bot.stop(sig);
  server.close(() => mongoose.disconnect().then(() => process.exit(0)));
};
process.once('SIGINT',  () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
