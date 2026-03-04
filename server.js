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
    origin: ["https://crash-gamemoney.vercel.app", "http://localhost:3000"], // Adjust origins
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

const bot = new Telegraf(process.env.BOT_TOKEN);
const ADMIN_IDS = process.env.ADMIN_IDS ? process.env.ADMIN_IDS.split(',') : [];

mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => console.log('✅ MongoDB connected')).catch(err => console.error(err));

// Schemas
const userSchema = new mongoose.Schema({
  telegramId: { type: String, required: true, unique: true },
  username: String,
  firstName: String,
  balance: { type: Number, default: 1000 },
  totalDeposited: { type: Number, default: 0 },
  totalWithdrawn: { type: Number, default: 0 },
  isBanned: { type: Boolean, default: false }
});

const transactionSchema = new mongoose.Schema({
  userId: String,
  username: String,
  type: { type: String, enum: ['deposit', 'withdraw'] },
  amount: Number,
  status: { type: String, enum: ['pending', 'confirmed', 'rejected'], default: 'pending' },
  accountName: String,
  accountNumber: String,
  confirmedBy: String,
  confirmedAt: Date,
  createdAt: { type: Date, default: Date.now }
});

const betSchema = new mongoose.Schema({
    userId: String,
    username: String,
    amount: Number,
    gameId: String,
    status: { type: String, default: 'pending' }, // pending, won, lost
    profit: Number,
    cashoutMultiplier: Number,
    date: {type: Date, default: Date.now}
});

const User = mongoose.model('User', userSchema);
const Transaction = mongoose.model('Transaction', transactionSchema);
const Bet = mongoose.model('Bet', betSchema);

// Game State
let gameState = {
  isRunning: false,
  currentMultiplier: 1.0,
  crashPoint: 0,
  gameId: null,
  bets: new Map(), // userId -> Bet Object
  countdownInterval: null
};

// Bot Logic (Simplified for brevity)
const botUsers = [
    { id: 'bot1', username: 'U Thu Ha', balance: 5000 },
    { id: 'bot2', username: 'Kyaw Kyaw', balance: 3000 },
    { id: 'bot3', username: 'Su Su', balance: 4000 }
];

// --- CORE GAME LOOP ---
async function startGameLoop() {
  while (true) {
    // 1. Countdown (3 seconds)
    // Betting IS allowed here
    await runCountdown(3); 

    // 2. Start Game
    await startNewGame();
    io.emit('gameStart', {}); // Trigger "STOP" buttons on client

    // 3. Running Phase
    const startTime = Date.now();
    gameState.isRunning = true;
    
    while (gameState.isRunning) {
      const elapsed = (Date.now() - startTime) / 1000;
      // Exponential curve: 1.00 * e^(0.06 * t) approx
      const current = Math.pow(Math.E, 0.06 * elapsed); 
      
      if (current >= gameState.crashPoint) {
        await crashGame();
        break;
      }
      
      gameState.currentMultiplier = current;
      io.emit('multiplier', { multiplier: current, gameState: 'running' });
      processBotCashouts(current);
      await sleep(50); // 50ms Tick
    }
    
    // 4. Post Crash
    await sleep(3000); // Show "CRASHED" for 3 seconds before restarting
  }
}

function runCountdown(seconds) {
  return new Promise(resolve => {
    let count = seconds;
    io.emit('countdown', { seconds: count });
    gameState.countdownInterval = setInterval(() => {
      count--;
      if (count > 0) {
        io.emit('countdown', { seconds: count });
      } else {
        clearInterval(gameState.countdownInterval);
        resolve();
      }
    }, 1000);
  });
}

async function startNewGame() {
    // Calculate Crash Point based on total bets (Simple Algo)
    const totalBetAmount = Array.from(gameState.bets.values()).reduce((a,b)=>a+b.amount,0);
    // Logic: House Edge. If bets high, chance of low crash increases.
    // Random generation for demo:
    const r = Math.random();
    let crash = 1.00;
    if (r < 0.05) crash = 1.00; // Instant crash (5%)
    else if (r < 0.3) crash = 1.0 + Math.random(); // 1.0 - 2.0 (25%)
    else crash = 1.0 + Math.random() * 5; // Up to 6x
    
    if (Math.random() < 0.02) crash = 50.0; // Rare Jackpot

    gameState.crashPoint = Math.floor(crash * 100) / 100;
    gameState.gameId = Date.now().toString();
    gameState.bets.clear(); // Clear memory map, DB bets preserved
    
    // Bots place bets
    placeBotBets();
    io.emit('activeBets', { bets: Array.from(gameState.bets.values()).map(b => ({ username: b.username, isBot: b.isBot })) });
}

async function crashGame() {
    gameState.isRunning = false;
    io.emit('gameCrashed', { multiplier: gameState.crashPoint });
    
    // Process Losses
    // Winners handled in cashOut function. Remaining are losers.
    for (const [uid, bet] of gameState.bets.entries()) {
        if (!bet.cashedAt) {
            // Log Loss to DB if real user
            if (!bet.isBot) {
                await Bet.create({ userId: uid, username: bet.username, amount: bet.amount, gameId: gameState.gameId, status: 'lost', profit: -bet.amount });
            }
        }
    }
}

// --- API ---

// Login
app.post('/api/auth', async (req, res) => {
    const { id, username, first_name } = req.body;
    let user = await User.findOne({ telegramId: id.toString() });
    if (!user) user = await User.create({ telegramId: id.toString(), username: username||first_name, balance: 1000 });
    res.json({ success: true, user });
});

// Deposit
app.post('/api/deposit', async (req, res) => {
    const { userId, username, name, phone, amount } = req.body;
    await Transaction.create({ userId, username, type: 'deposit', amount, accountName: name, accountNumber: phone });
    res.json({ success: true });
});

// Withdraw (IMMEDIATE DEDUCTION LOGIC)
app.post('/api/withdraw', async (req, res) => {
    const { userId, username, name, phone, amount } = req.body;
    const user = await User.findOne({ telegramId: userId });
    
    if (!user || user.balance < amount) {
        return res.status(400).json({ success: false, message: 'လက်ကျန်မလုံလောက်ပါ' });
    }

    // 1. Deduct immediately
    user.balance -= amount;
    user.totalWithdrawn += amount; // Optional: track expected withdraw
    await user.save();

    // 2. Create Transaction
    await Transaction.create({ userId, username, type: 'withdraw', amount, accountName: name, accountNumber: phone });

    res.json({ success: true, newBalance: user.balance });
});

// Admin Transaction Process (REFUND ON REJECT LOGIC)
app.post('/api/admin/transaction/process', async (req, res) => {
    const adminId = req.headers['x-telegram-id']; // Secure this in prod
    const { transactionId, status } = req.body; // status: 'confirmed' or 'rejected'

    const tx = await Transaction.findById(transactionId);
    if (!tx || tx.status !== 'pending') return res.json({ success: false, message: 'Invalid TX' });

    if (tx.type === 'withdraw') {
        if (status === 'confirmed') {
            // Money already gone, just mark done.
            tx.status = 'confirmed';
        } else if (status === 'rejected') {
            // Refund money
            const user = await User.findOne({ telegramId: tx.userId });
            if (user) {
                user.balance += tx.amount;
                // revert stats if needed
                user.totalWithdrawn -= tx.amount;
                await user.save();
                io.emit('balanceUpdate', { userId: tx.userId, balance: user.balance });
            }
            tx.status = 'rejected';
        }
    } else if (tx.type === 'deposit') {
        if (status === 'confirmed') {
            const user = await User.findOne({ telegramId: tx.userId });
            if (user) {
                user.balance += tx.amount;
                user.totalDeposited += tx.amount;
                await user.save();
                io.emit('balanceUpdate', { userId: tx.userId, balance: user.balance });
            }
            tx.status = 'confirmed';
        } else {
            tx.status = 'rejected';
        }
    }
    
    tx.confirmedBy = adminId;
    tx.confirmedAt = new Date();
    await tx.save();
    res.json({ success: true });
});

// --- SOCKET HANDLERS ---
function placeBotBets() {
    // Simplified bot betting
    botUsers.forEach(bot => {
        if(Math.random()>0.5) {
            const amt = Math.floor(Math.random()*500);
            gameState.bets.set(bot.id, { userId: bot.id, username: bot.username, amount: amt, isBot: true });
        }
    });
}
function processBotCashouts(currentMult) {
    for (const [uid, bet] of gameState.bets.entries()) {
        if(bet.isBot && !bet.cashedAt) {
            // Random cashout logic for bots
            if(Math.random() < 0.05 * currentMult) {
                bet.cashedAt = true;
                const profit = Math.floor(bet.amount * (currentMult - 1));
                io.emit('newHistory', { username: bet.username, start: 1.0, stop: currentMult, profit, isBot: true });
            }
        }
    }
}

io.on('connection', (socket) => {
    const userId = socket.handshake.query.userId;
    
    socket.on('placeBet', async (data, cb) => {
        // Allow betting if countdown is active OR game is not running (waiting)
        // Strictly prevent betting if game IS running (rocket flying)
        if (gameState.isRunning) return cb({ success: false, message: 'Game in progress' });
        
        const user = await User.findOne({ telegramId: userId });
        if (!user || user.balance < data.amount) return cb({ success: false, message: 'No Balance' });
        
        user.balance -= data.amount;
        await user.save();
        
        // Add to active bets
        gameState.bets.set(userId, { 
            userId, username: data.username, amount: data.amount, isBot: false 
        });
        
        io.emit('activeBets', { bets: Array.from(gameState.bets.values()).map(b => ({ username: b.username, isBot: b.isBot })) });
        cb({ success: true, newBalance: user.balance });
    });

    socket.on('cashOut', async (data, cb) => {
        if (!gameState.isRunning) return cb({ success: false, message: 'Game crashed' });
        
        const bet = gameState.bets.get(userId);
        if (!bet || bet.cashedAt) return cb({ success: false });

        const mult = gameState.currentMultiplier;
        const profit = Math.floor(bet.amount * (mult - 1));
        const totalReturn = bet.amount + profit;

        const user = await User.findOne({ telegramId: userId });
        user.balance += totalReturn;
        await user.save();

        bet.cashedAt = true;
        
        // Save Win
        await Bet.create({ userId, username: bet.username, amount: bet.amount, gameId: gameState.gameId, status: 'won', profit, cashoutMultiplier: mult });

        io.emit('betResult', { success: true, type: 'cashout', multiplier: mult, profit, userId });
        io.emit('newHistory', { username: bet.username, start: 1.0, stop: mult, profit, isBot: false });
        
        cb({ success: true, newBalance: user.balance });
    });
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Start
startGameLoop();
server.listen(process.env.PORT || 3000, () => console.log('🚀 Server Started'));
