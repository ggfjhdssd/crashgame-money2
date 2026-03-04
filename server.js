const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');
const dotenv = require('dotenv');
const { Telegraf } = require('telegraf');

dotenv.config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: ["https://crash-gamemoney.vercel.app", "http://localhost:3000"],
    credentials: true
  },
  transports: ['websocket', 'polling']
});

app.use(cors({
  origin: ["https://crash-gamemoney.vercel.app", "http://localhost:3000"],
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Telegram Bot (optional, for admin commands only)
const bot = new Telegraf(process.env.BOT_TOKEN);
const ADMIN_IDS = process.env.ADMIN_IDS ? process.env.ADMIN_IDS.split(',') : [];

// MongoDB
mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => console.log('✅ MongoDB connected')).catch(err => console.error(err));

// Schemas
const userSchema = new mongoose.Schema({
  telegramId: { type: String, required: true, unique: true },
  username: String,
  firstName: String,
  lastName: String,
  balance: { type: Number, default: 1000 },
  totalDeposited: { type: Number, default: 0 },
  totalWithdrawn: { type: Number, default: 0 },
  totalBets: { type: Number, default: 0 },
  totalWins: { type: Number, default: 0 },
  isBanned: { type: Boolean, default: false },
  bannedAt: Date,
  banReason: String,
  createdAt: { type: Date, default: Date.now },
  lastActive: { type: Date, default: Date.now }
});

const betSchema = new mongoose.Schema({
  userId: String,
  username: String,
  amount: Number,
  cashoutMultiplier: Number,
  startedAt: Date,
  cashedAt: Date,
  gameId: String,
  profit: Number,
  status: { type: String, enum: ['pending', 'won', 'lost'], default: 'pending' }
});

const transactionSchema = new mongoose.Schema({
  userId: String,
  username: String,
  type: { type: String, enum: ['deposit', 'withdraw'] },
  amount: Number,
  status: { type: String, enum: ['pending', 'confirmed', 'rejected'], default: 'pending' },
  accountName: String,
  accountNumber: String,
  adminNote: String,
  confirmedBy: String,
  confirmedAt: Date,
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);
const Bet = mongoose.model('Bet', betSchema);
const Transaction = mongoose.model('Transaction', transactionSchema);

// Game state
let gameState = {
  isRunning: false,
  currentMultiplier: 1.0,
  crashPoint: 0,
  gameId: null,
  startTime: null,
  totalBets: 0,
  bets: new Map(),
  history: [],
  countdownInterval: null
};

// Bot users
const botUsers = [
  { id: 'bot1', username: 'U Thu Ha', balance: 5000, strategy: 'early' },
  { id: 'bot2', username: 'Kyaw Kyaw', balance: 3000, strategy: 'medium' },
  { id: 'bot3', username: 'Ma Ma Lay', balance: 7000, strategy: 'late' },
  { id: 'bot4', username: 'Ko Ko Gyi', balance: 2500, strategy: 'random' },
  { id: 'bot5', username: 'Daw Hla', balance: 4500, strategy: 'early' },
  { id: 'bot6', username: 'Mg Mg Aung', balance: 6000, strategy: 'medium' },
  { id: 'bot7', username: 'Su Su Hlaing', balance: 3500, strategy: 'late' },
  { id: 'bot8', username: 'Zaw Zaw', balance: 8000, strategy: 'random' },
  { id: 'bot9', username: 'Aye Aye', balance: 2800, strategy: 'early' },
  { id: 'bot10', username: 'Phyo Phyo', balance: 5200, strategy: 'medium' }
];

function generateCrashPoint(totalBets) {
  let crashPoint;
  if (totalBets > 10000) crashPoint = 1.1 + Math.random() * 0.9;
  else if (totalBets > 5000) crashPoint = 1.2 + Math.random() * 2.8;
  else if (totalBets > 2000) crashPoint = 1.5 + Math.random() * 5.5;
  else {
    if (Math.random() < 0.3) crashPoint = 5 + Math.random() * 15;
    else crashPoint = 1.1 + Math.random() * 3.9;
  }
  return Math.min(20.0, Math.round(crashPoint * 100) / 100);
}

// Game loop with 30ms updates for smooth multiplier
async function startGameLoop() {
  console.log('🎮 Game loop started');
  while (true) {
    await startCountdown();
    await startNewGame();

    const startTime = Date.now();
    gameState.startTime = startTime;

    while (gameState.isRunning) {
      const elapsed = (Date.now() - startTime) / 1000;
      const current = 1.0 + elapsed * 0.1; // 0.1x per second
      if (current >= gameState.crashPoint) {
        await crashGame();
        break;
      }
      gameState.currentMultiplier = Math.round(current * 100) / 100;
      io.emit('multiplier', { multiplier: gameState.currentMultiplier, gameState: 'running' });
      processBotCashouts();
      await sleep(30); // 30ms for smooth updates
    }

    io.emit('multiplier', { multiplier: 0, gameState: 'waiting' });
    await sleep(3000);
  }
}

function startCountdown() {
  return new Promise(resolve => {
    let count = 3;
    io.emit('countdown', { seconds: count });
    gameState.countdownInterval = setInterval(() => {
      count--;
      if (count > 0) {
        io.emit('countdown', { seconds: count });
      } else {
        clearInterval(gameState.countdownInterval);
        io.emit('gameStart', {});
        resolve();
      }
    }, 1000);
  });
}

async function startNewGame() {
  const totalBetsAmount = Array.from(gameState.bets.values()).reduce((s, b) => s + b.amount, 0);
  gameState = {
    isRunning: true,
    currentMultiplier: 1.0,
    crashPoint: generateCrashPoint(totalBetsAmount),
    gameId: generateGameId(),
    startTime: Date.now(),
    totalBets: totalBetsAmount,
    bets: new Map(),
    history: gameState.history.slice(0, 20)
  };
  console.log(`🎲 New game: crash at ${gameState.crashPoint}x, total bets ${totalBetsAmount}`);
  placeBotBets();
  io.emit('activeBets', { bets: Array.from(gameState.bets.values()).map(b => ({ username: b.username, amount: b.amount, isBot: b.isBot })) });
}

async function crashGame() {
  gameState.isRunning = false;
  console.log(`💥 Crashed at ${gameState.crashPoint}x`);
  for (const [uid, bet] of gameState.bets.entries()) {
    if (!bet.cashedAt) await processBetLoss(uid, bet);
  }
  gameState.history.unshift({ gameId: gameState.gameId, crashPoint: gameState.crashPoint, totalBets: gameState.totalBets, timestamp: new Date() });
  io.emit('gameCrashed', { multiplier: gameState.crashPoint, gameId: gameState.gameId });
}

// Bet functions
async function placeBet(userId, username, amount) {
  try {
    const user = await User.findOne({ telegramId: userId });
    if (!user) return { success: false, message: 'User not found' };
    if (user.isBanned) return { success: false, message: 'Account banned' };
    if (!gameState.isRunning && gameState.countdownInterval) return { success: false, message: 'Wait for countdown' };
    if (gameState.bets.has(userId)) return { success: false, message: 'Already have active bet' };
    if (user.balance < amount) return { success: false, message: 'Insufficient balance' };

    user.balance -= amount;
    user.totalBets += 1;
    await user.save();

    const bet = { userId, username, amount, placedAt: Date.now(), gameId: gameState.gameId, isBot: false };
    gameState.bets.set(userId, bet);
    gameState.totalBets += amount;
    await Bet.create({ userId, username, amount, gameId: gameState.gameId, status: 'pending' });
    gameState.crashPoint = generateCrashPoint(gameState.totalBets);
    io.emit('balanceUpdate', { userId, balance: user.balance });
    io.emit('activeBets', { bets: Array.from(gameState.bets.values()).map(b => ({ username: b.username, amount: b.amount, isBot: b.isBot })) });
    return { success: true, message: 'Bet placed', newBalance: user.balance };
  } catch (error) {
    console.error(error);
    return { success: false, message: 'Server error' };
  }
}

async function cashOut(userId, multiplier) {
  try {
    const bet = gameState.bets.get(userId);
    if (!bet || bet.cashedAt) return { success: false, message: 'No active bet' };
    if (!gameState.isRunning) return { success: false, message: 'Game crashed' };

    const profit = bet.amount * (multiplier - 1);
    const totalReturn = bet.amount + profit;
    const user = await User.findOne({ telegramId: userId });
    if (user) {
      user.balance += totalReturn;
      user.totalWins += 1;
      await user.save();
      await Bet.findOneAndUpdate({ userId, gameId: gameState.gameId }, { cashoutMultiplier: multiplier, profit, status: 'won', cashedAt: new Date() });
      bet.cashedAt = Date.now();
      bet.cashoutMultiplier = multiplier;
      bet.profit = profit;
      io.emit('balanceUpdate', { userId, balance: user.balance });
      io.emit('betResult', { success: true, type: 'cashout', multiplier, profit, userId });
      io.emit('newHistory', { username: bet.username, start: 1.0, stop: multiplier, profit, isBot: bet.isBot });
      io.emit('activeBets', { bets: Array.from(gameState.bets.values()).filter(b => !b.cashedAt).map(b => ({ username: b.username, amount: b.amount, isBot: b.isBot })) });
      return { success: true, multiplier, profit, newBalance: user.balance };
    }
    return { success: false, message: 'User not found' };
  } catch (error) {
    console.error(error);
    return { success: false, message: 'Server error' };
  }
}

async function processBetLoss(userId, bet) {
  await Bet.findOneAndUpdate({ userId, gameId: gameState.gameId }, { status: 'lost' });
  io.emit('newHistory', { username: bet.username, start: 1.0, stop: gameState.crashPoint, profit: -bet.amount, isBot: bet.isBot });
}

// Bot functions
function placeBotBets() {
  const num = 5 + Math.floor(Math.random() * 5);
  const selected = [...botUsers].sort(() => 0.5 - Math.random()).slice(0, num);
  selected.forEach(bot => {
    const amount = Math.floor(Math.random() * 1000) + 100;
    if (bot.balance >= amount) {
      bot.balance -= amount;
      gameState.bets.set(bot.id, { userId: bot.id, username: bot.username, amount, placedAt: Date.now(), gameId: gameState.gameId, isBot: true, strategy: bot.strategy });
      gameState.totalBets += amount;
      console.log(`🤖 ${bot.username} (${bot.strategy}) bet ${amount}`);
    }
  });
}

function processBotCashouts() {
  for (const [uid, bet] of gameState.bets.entries()) {
    if (bet.isBot && !bet.cashedAt) {
      const mult = gameState.currentMultiplier;
      let should = false;
      switch (bet.strategy) {
        case 'early': should = mult > 1.2 && mult < 2.0 && Math.random() < 0.3; break;
        case 'medium': should = mult > 2.0 && mult < 4.0 && Math.random() < 0.2; break;
        case 'late': should = mult > 4.0 && mult < 8.0 && Math.random() < 0.15; break;
        case 'random': should = Math.random() < 0.1; break;
      }
      if (should) {
        const profit = bet.amount * (mult - 1);
        bet.cashedAt = Date.now();
        bet.cashoutMultiplier = mult;
        bet.profit = profit;
        const bot = botUsers.find(b => b.id === uid);
        if (bot) bot.balance += bet.amount + profit;
        console.log(`🤖 ${bet.username} cashed at ${mult}x`);
        io.emit('newHistory', { username: bet.username, start: 1.0, stop: mult, profit, isBot: true });
      }
    }
  }
}

// API Routes
app.post('/api/auth', async (req, res) => {
  try {
    const { id, username, first_name, last_name } = req.body;
    let user = await User.findOne({ telegramId: id.toString() });
    if (!user) {
      user = await User.create({ telegramId: id.toString(), username, firstName: first_name, lastName: last_name, balance: 1000 });
    } else {
      if (user.isBanned) return res.json({ success: false, message: 'Banned', banned: true });
      user.lastActive = new Date();
      await user.save();
    }
    res.json({ success: true, user: { id: user.telegramId, username: user.username, balance: user.balance, totalDeposited: user.totalDeposited, totalWithdrawn: user.totalWithdrawn } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.post('/api/deposit', async (req, res) => {
  try {
    const { userId, username, name, phone, amount } = req.body;
    if (!userId || !username || !name || !phone || !amount || amount < 3000) {
      return res.status(400).json({ success: false, message: 'Invalid data or amount < 3000' });
    }
    const transaction = await Transaction.create({ userId, username, type: 'deposit', amount, accountName: name, accountNumber: phone, status: 'pending' });
    console.log('📥 Deposit saved:', transaction._id);
    res.json({ success: true, message: 'Deposit request received' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.post('/api/withdraw', async (req, res) => {
  try {
    const { userId, username, name, phone, amount } = req.body;
    if (!userId || !username || !name || !phone || !amount || amount <= 0) {
      return res.status(400).json({ success: false, message: 'Invalid data' });
    }
    const user = await User.findOne({ telegramId: userId });
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    if (user.balance < amount) return res.status(400).json({ success: false, message: 'Insufficient balance' });
    const transaction = await Transaction.create({ userId, username, type: 'withdraw', amount, accountName: name, accountNumber: phone, status: 'pending' });
    console.log('📤 Withdraw saved:', transaction._id);
    res.json({ success: true, message: 'Withdraw request received' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Admin API endpoints (secured by telegramId in header)
async function isAdmin(telegramId) {
  return ADMIN_IDS.includes(telegramId);
}

app.get('/api/admin/users', async (req, res) => {
  const adminId = req.headers['x-telegram-id'];
  if (!adminId || !(await isAdmin(adminId))) return res.status(403).json({ success: false, message: 'Unauthorized' });
  try {
    const users = await User.find().sort({ createdAt: -1 }).limit(100);
    res.json({ success: true, users });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.get('/api/admin/transactions', async (req, res) => {
  const adminId = req.headers['x-telegram-id'];
  if (!adminId || !(await isAdmin(adminId))) return res.status(403).json({ success: false, message: 'Unauthorized' });
  try {
    const transactions = await Transaction.find().sort({ createdAt: -1 }).limit(100);
    res.json({ success: true, transactions });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.post('/api/admin/user/balance', async (req, res) => {
  const adminId = req.headers['x-telegram-id'];
  if (!adminId || !(await isAdmin(adminId))) return res.status(403).json({ success: false, message: 'Unauthorized' });
  try {
    const { userId, action, amount } = req.body;
    if (!userId || !action || !amount) return res.status(400).json({ success: false, message: 'Missing fields' });
    const user = await User.findOne({ telegramId: userId });
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    if (action === 'add') {
      user.balance += amount;
      user.totalDeposited += amount;
    } else if (action === 'deduct') {
      if (user.balance < amount) return res.status(400).json({ success: false, message: 'Insufficient balance' });
      user.balance -= amount;
      user.totalWithdrawn += amount;
    } else return res.status(400).json({ success: false, message: 'Invalid action' });
    await user.save();
    io.emit('balanceUpdate', { userId, balance: user.balance });
    res.json({ success: true, balance: user.balance });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.post('/api/admin/user/ban', async (req, res) => {
  const adminId = req.headers['x-telegram-id'];
  if (!adminId || !(await isAdmin(adminId))) return res.status(403).json({ success: false, message: 'Unauthorized' });
  try {
    const { userId, ban, reason } = req.body;
    const user = await User.findOne({ telegramId: userId });
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    user.isBanned = ban;
    if (ban) { user.banReason = reason || 'No reason'; user.bannedAt = new Date(); }
    else { user.banReason = null; user.bannedAt = null; }
    await user.save();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.post('/api/admin/transaction/process', async (req, res) => {
  const adminId = req.headers['x-telegram-id'];
  if (!adminId || !(await isAdmin(adminId))) return res.status(403).json({ success: false, message: 'Unauthorized' });
  try {
    const { transactionId, status, adminNote } = req.body;
    const transaction = await Transaction.findById(transactionId);
    if (!transaction) return res.status(404).json({ success: false, message: 'Transaction not found' });
    if (status === 'confirmed') {
      if (transaction.type === 'deposit') {
        const user = await User.findOne({ telegramId: transaction.userId });
        if (user) {
          user.balance += transaction.amount;
          user.totalDeposited += transaction.amount;
          await user.save();
          io.emit('balanceUpdate', { userId: transaction.userId, balance: user.balance });
        }
      } else if (transaction.type === 'withdraw') {
        const user = await User.findOne({ telegramId: transaction.userId });
        if (user) {
          // balance already deducted at request time? Actually we deduct on confirm.
          user.balance -= transaction.amount;
          user.totalWithdrawn += transaction.amount;
          await user.save();
          io.emit('balanceUpdate', { userId: transaction.userId, balance: user.balance });
        }
      }
      transaction.status = 'confirmed';
    } else if (status === 'rejected') {
      transaction.status = 'rejected';
      if (transaction.type === 'withdraw') {
        // If withdraw was pending, no balance change yet.
      }
    }
    transaction.adminNote = adminNote || '';
    transaction.confirmedBy = adminId;
    transaction.confirmedAt = new Date();
    await transaction.save();
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Socket.io
io.on('connection', (socket) => {
  console.log('🟢 Client', socket.id);
  const userId = socket.handshake.query.userId;
  if (userId) socket.userId = userId;

  socket.emit('multiplier', { multiplier: gameState.currentMultiplier, gameState: gameState.isRunning ? 'running' : 'waiting' });
  socket.emit('activeBets', { bets: Array.from(gameState.bets.values()).filter(b => !b.cashedAt).map(b => ({ username: b.username, amount: b.amount, isBot: b.isBot })) });

  socket.on('placeBet', async (data, cb) => cb(await placeBet(data.userId, data.username, data.amount)));
  socket.on('cashOut', async (data, cb) => cb(await cashOut(data.userId, data.multiplier)));
  socket.on('authenticate', (data) => socket.userId = data.userId);
  socket.on('disconnect', () => console.log('🔴', socket.id));
});

function generateGameId() { return Date.now().toString(36) + Math.random().toString(36).substr(2); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Start
startGameLoop();

if (process.env.BOT_TOKEN) {
  bot.launch().then(() => console.log('🤖 Bot started')).catch(console.error);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`));

process.once('SIGINT', () => { bot.stop('SIGINT'); mongoose.disconnect(); process.exit(0); });
process.once('SIGTERM', () => { bot.stop('SIGTERM'); mongoose.disconnect(); process.exit(0); });
