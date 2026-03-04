const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');
const dotenv = require('dotenv');
const { Telegraf, Markup } = require('telegraf');

// Load environment variables
dotenv.config();

// Initialize Express app
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Telegram Bot setup
const bot = new Telegraf(process.env.BOT_TOKEN);
const ADMIN_GROUP_ID = process.env.ADMIN_GROUP_ID;

// MongoDB connection
mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => {
  console.log('✅ Connected to MongoDB');
}).catch((err) => {
  console.error('❌ MongoDB connection error:', err);
});

// MongoDB Schemas
const userSchema = new mongoose.Schema({
  telegramId: { type: String, required: true, unique: true },
  username: String,
  firstName: String,
  lastName: String,
  balance: { type: Number, default: 1000 }, // Starting balance
  totalDeposited: { type: Number, default: 0 },
  totalWithdrawn: { type: Number, default: 0 },
  totalBets: { type: Number, default: 0 },
  totalWins: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
  lastActive: { type: Date, default: Date.now }
});

const betSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  username: String,
  amount: { type: Number, required: true },
  cashoutMultiplier: Number,
  startedAt: { type: Date, default: Date.now },
  cashedAt: Date,
  gameId: String,
  profit: Number,
  status: { type: String, enum: ['pending', 'won', 'lost'], default: 'pending' }
});

const transactionSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  username: String,
  type: { type: String, enum: ['deposit', 'withdraw'] },
  amount: Number,
  status: { type: String, enum: ['pending', 'confirmed', 'rejected'], default: 'pending' },
  screenshotUrl: String,
  paymentMethod: String,
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

// Game State
let gameState = {
  isRunning: false,
  currentMultiplier: 1.0,
  crashPoint: 0,
  gameId: null,
  startTime: null,
  totalBets: 0,
  bets: new Map(), // Store active bets
  history: []
};

// Bot users (Fake players)
const botUsers = [
  { id: 'bot1', username: 'U Thu Ha', balance: 5000 },
  { id: 'bot2', username: 'Kyaw Kyaw', balance: 3000 },
  { id: 'bot3', username: 'Ma Ma Lay', balance: 7000 },
  { id: 'bot4', username: 'Ko Ko Gyi', balance: 2500 },
  { id: 'bot5', username: 'Daw Hla', balance: 4500 },
  { id: 'bot6', username: 'Mg Mg Aung', balance: 6000 },
  { id: 'bot7', username: 'Su Su Hlaing', balance: 3500 },
  { id: 'bot8', username: 'Zaw Zaw', balance: 8000 },
  { id: 'bot9', username: 'Aye Aye', balance: 2800 },
  { id: 'bot10', username: 'Phyo Phyo', balance: 5200 }
];

// Helper function to generate crash point based on total bets
function generateCrashPoint(totalBets) {
  // Base crash point calculation
  let crashPoint;
  
  // If total bets are high, force low crash point for admin profit
  if (totalBets > 10000) {
    // Force low crash point between 1.1x and 1.5x
    crashPoint = 1.1 + (Math.random() * 0.4);
  } else if (totalBets > 5000) {
    // Medium range
    crashPoint = 1.2 + (Math.random() * 1.3); // 1.2x - 2.5x
  } else {
    // Low bets - allow high multipliers to attract players
    // 80% chance of low multiplier, 20% chance of high multiplier
    if (Math.random() < 0.2) {
      crashPoint = 5 + (Math.random() * 15); // 5x - 20x
    } else {
      crashPoint = 1.1 + (Math.random() * 3.9); // 1.1x - 5x
    }
  }
  
  return Math.round(crashPoint * 100) / 100;
}

// Game Loop
async function startGameLoop() {
  console.log('🎮 Starting game loop...');
  
  while (true) {
    // Start new game
    await startNewGame();
    
    // Run game for random duration (based on crash point)
    const runDuration = gameState.crashPoint * 1000; // 1 second per multiplier point
    const startTime = Date.now();
    gameState.startTime = startTime;
    
    // Update multiplier in real-time
    while (gameState.isRunning) {
      const elapsedSeconds = (Date.now() - startTime) / 1000;
      const currentMultiplier = 1.0 + (elapsedSeconds * 0.1); // Increase by 0.1x per second
      
      if (currentMultiplier >= gameState.crashPoint) {
        // Game crashed
        await crashGame();
        break;
      }
      
      gameState.currentMultiplier = Math.round(currentMultiplier * 100) / 100;
      
      // Broadcast multiplier to all clients
      io.emit('multiplier', {
        multiplier: gameState.currentMultiplier,
        gameState: 'running'
      });
      
      // Check bot cashouts
      processBotCashouts();
      
      await sleep(100); // Update every 100ms
    }
    
    // Wait 3 seconds before next game
    io.emit('multiplier', {
      multiplier: 0,
      gameState: 'waiting'
    });
    
    await sleep(3000);
  }
}

async function startNewGame() {
  // Calculate total bets for this round
  const totalBetsAmount = Array.from(gameState.bets.values())
    .reduce((sum, bet) => sum + bet.amount, 0);
  
  gameState = {
    isRunning: true,
    currentMultiplier: 1.0,
    crashPoint: generateCrashPoint(totalBetsAmount),
    gameId: generateGameId(),
    startTime: Date.now(),
    totalBets: totalBetsAmount,
    bets: new Map(),
    history: gameState.history.slice(0, 20) // Keep last 20 games
  };
  
  console.log(`🎲 New game started - Crash Point: ${gameState.crashPoint}x, Total Bets: ${totalBetsAmount}`);
  
  // Place bot bets
  placeBotBets();
}

async function crashGame() {
  gameState.isRunning = false;
  
  console.log(`💥 Game crashed at ${gameState.crashPoint}x`);
  
  // Process all pending bets (lost)
  for (const [userId, bet] of gameState.bets.entries()) {
    if (!bet.cashedAt) {
      // User didn't cash out - lost bet
      await processBetLoss(userId, bet);
    }
  }
  
  // Save game to history
  gameState.history.unshift({
    gameId: gameState.gameId,
    crashPoint: gameState.crashPoint,
    totalBets: gameState.totalBets,
    timestamp: new Date()
  });
  
  // Emit crash event
  io.emit('gameCrashed', {
    multiplier: gameState.crashPoint,
    gameId: gameState.gameId
  });
}

// Bet processing functions
async function placeBet(userId, username, amount) {
  if (!gameState.isRunning) {
    return { success: false, message: 'Game is not running' };
  }
  
  // Check if user already has a bet
  if (gameState.bets.has(userId)) {
    return { success: false, message: 'You already have an active bet' };
  }
  
  // Check user balance
  const user = await User.findOne({ telegramId: userId });
  if (!user || user.balance < amount) {
    return { success: false, message: 'Insufficient balance' };
  }
  
  // Deduct balance
  user.balance -= amount;
  user.totalBets += 1;
  await user.save();
  
  // Create bet record
  const bet = {
    userId,
    username,
    amount,
    placedAt: Date.now(),
    gameId: gameState.gameId
  };
  
  gameState.bets.set(userId, bet);
  gameState.totalBets += amount;
  
  // Save to database
  await Bet.create({
    userId,
    username,
    amount,
    gameId: gameState.gameId,
    status: 'pending'
  });
  
  // Update game crash point based on new total
  gameState.crashPoint = generateCrashPoint(gameState.totalBets);
  
  io.emit('balanceUpdate', { userId, balance: user.balance });
  
  return { success: true, message: 'Bet placed successfully' };
}

async function cashOut(userId, multiplier) {
  const bet = gameState.bets.get(userId);
  
  if (!bet || bet.cashedAt) {
    return { success: false, message: 'No active bet found' };
  }
  
  if (!gameState.isRunning) {
    return { success: false, message: 'Game has crashed' };
  }
  
  // Calculate profit
  const profit = bet.amount * (multiplier - 1);
  const totalReturn = bet.amount + profit;
  
  // Update user balance
  const user = await User.findOne({ telegramId: userId });
  if (user) {
    user.balance += totalReturn;
    user.totalWins += 1;
    await user.save();
    
    // Update bet record
    await Bet.findOneAndUpdate(
      { userId, gameId: gameState.gameId },
      {
        cashoutMultiplier: multiplier,
        profit: profit,
        status: 'won',
        cashedAt: new Date()
      }
    );
    
    bet.cashedAt = Date.now();
    bet.cashoutMultiplier = multiplier;
    bet.profit = profit;
    
    io.emit('balanceUpdate', { userId, balance: user.balance });
  }
  
  return {
    success: true,
    multiplier,
    profit,
    newBalance: user?.balance
  };
}

async function processBetLoss(userId, bet) {
  await Bet.findOneAndUpdate(
    { userId, gameId: gameState.gameId },
    { status: 'lost' }
  );
}

// Bot functions
function placeBotBots() {
  // Randomly select 5-10 bots to place bets
  const numBots = 5 + Math.floor(Math.random() * 5);
  const selectedBots = [...botUsers].sort(() => 0.5 - Math.random()).slice(0, numBots);
  
  selectedBots.forEach(bot => {
    const betAmount = Math.floor(Math.random() * 1000) + 100; // 100-1100
    if (bot.balance >= betAmount) {
      bot.balance -= betAmount;
      gameState.bets.set(bot.id, {
        userId: bot.id,
        username: bot.username,
        amount: betAmount,
        placedAt: Date.now(),
        gameId: gameState.gameId,
        isBot: true
      });
      gameState.totalBets += betAmount;
      
      console.log(`🤖 Bot ${bot.username} placed bet: ${betAmount}`);
    }
  });
}

function processBotCashouts() {
  // Bots randomly decide to cash out based on current multiplier
  for (const [userId, bet] of gameState.bets.entries()) {
    if (bet.isBot && !bet.cashedAt) {
      // Bot cashout logic
      const cashoutChance = 0.1; // 10% chance per update
      if (Math.random() < cashoutChance) {
        const cashoutMultiplier = gameState.currentMultiplier;
        
        // Some bots cash out early, some late
        if (cashoutMultiplier > 1.2 && Math.random() < 0.7) {
          // Cash out
          const profit = bet.amount * (cashoutMultiplier - 1);
          bet.cashedAt = Date.now();
          bet.cashoutMultiplier = cashoutMultiplier;
          bet.profit = profit;
          
          // Find bot and update balance
          const bot = botUsers.find(b => b.id === userId);
          if (bot) {
            bot.balance += bet.amount + profit;
          }
          
          console.log(`🤖 Bot ${bet.username} cashed out at ${cashoutMultiplier}x`);
        }
      }
    }
  }
}

// Telegram Bot Commands
bot.start(async (ctx) => {
  const telegramId = ctx.from.id.toString();
  const username = ctx.from.username || `${ctx.from.first_name} ${ctx.from.last_name || ''}`.trim();
  
  try {
    let user = await User.findOne({ telegramId });
    
    if (!user) {
      user = await User.create({
        telegramId,
        username,
        firstName: ctx.from.first_name,
        lastName: ctx.from.last_name,
        balance: 1000 // Starting bonus
      });
      
      await ctx.reply(
        `🎉 ကြိုဆိုပါတယ် ${username}!\n\n` +
        `သင့်အကောင့်ကို စတင်ဖွင့်လှစ်လိုက်ပါပြီ။\n` +
        `လက်ကျန်ငွေ: 1000 MMK\n\n` +
        `ဂိမ်းစတင်ဆော့ကစားရန် Mini App ကိုဖွင့်ပါ။`
      );
    } else {
      await ctx.reply(
        `ပြန်လည်ကြိုဆိုပါတယ် ${username}!\n` +
        `သင့်လက်ကျန်ငွေ: ${user.balance} MMK`
      );
    }
    
    // Send Mini App button
    await ctx.reply('ဂိမ်းစတင်ရန် အောက်ပါကိုနှိပ်ပါ', {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🎮 CRASH GAME ဖွင့်ရန်', web_app: { url: 'https://your-vercel-app.vercel.app' } }]
        ]
      }
    });
  } catch (error) {
    console.error('Error in start command:', error);
    await ctx.reply('စနစ်ကျသင့်မှုတစ်ခုဖြစ်ပွားခဲ့ပါသည်။ နောက်မှပြန်ကြိုးစားပါ။');
  }
});

// Deposit request handler
bot.on('message', async (ctx) => {
  if (ctx.message.web_app_data) {
    // Handle Mini App data
    const data = JSON.parse(ctx.message.web_app_data.data);
    
    if (data.type === 'deposit') {
      await handleDeposit(ctx, data);
    } else if (data.type === 'withdraw') {
      await handleWithdraw(ctx, data);
    }
  }
});

async function handleDeposit(ctx, data) {
  const telegramId = ctx.from.id.toString();
  const username = ctx.from.username || `${ctx.from.first_name} ${ctx.from.last_name || ''}`.trim();
  
  // Save deposit request
  const transaction = await Transaction.create({
    userId: telegramId,
    username,
    type: 'deposit',
    amount: data.amount,
    screenshotUrl: data.screenshotUrl,
    paymentMethod: data.paymentMethod,
    status: 'pending'
  });
  
  // Send to admin group for approval
  await ctx.telegram.sendMessage(
    ADMIN_GROUP_ID,
    `💰 *ငွေသွင်းရန် တောင်းဆိုချက်*\n\n` +
    `👤 User: ${username}\n` +
    `🆔 ID: ${telegramId}\n` +
    `💵 ပမာဏ: ${data.amount} MMK\n` +
    `💳 ငွေသွင်းနည်း: ${data.paymentMethod}\n` +
    `📸 [ပြေစာကြည့်ရန်](${data.screenshotUrl})\n` +
    `🆔 Transaction ID: ${transaction._id}`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ အတည်ပြုမည်', callback_data: `confirm_deposit_${transaction._id}` },
            { text: '❌ ငြင်းပယ်မည်', callback_data: `reject_deposit_${transaction._id}` }
          ]
        ]
      }
    }
  );
  
  await ctx.reply('ငွေသွင်းရန် တောင်းဆိုချက်ကို လက်ခံရရှိပါသည်။ Admin အတည်ပြုပြီးပါက ငွေလက်ကျန်ထဲသို့ ထည့်ပေးပါမည်။');
}

async function handleWithdraw(ctx, data) {
  const telegramId = ctx.from.id.toString();
  const username = ctx.from.username || `${ctx.from.first_name} ${ctx.from.last_name || ''}`.trim();
  
  // Check balance
  const user = await User.findOne({ telegramId });
  if (!user || user.balance < data.amount) {
    await ctx.reply('လက်ကျန်ငွေ မလုံလောက်ပါ။');
    return;
  }
  
  // Save withdraw request
  const transaction = await Transaction.create({
    userId: telegramId,
    username,
    type: 'withdraw',
    amount: data.amount,
    accountName: data.accountName,
    accountNumber: data.accountNumber,
    status: 'pending'
  });
  
  // Send to admin group
  await ctx.telegram.sendMessage(
    ADMIN_GROUP_ID,
    `💸 *ငွေထုတ်ရန် တောင်းဆိုချက်*\n\n` +
    `👤 User: ${username}\n` +
    `🆔 ID: ${telegramId}\n` +
    `💵 ပမာဏ: ${data.amount} MMK\n` +
    `🏦 KPay နံပါတ်: ${data.accountNumber}\n` +
    `📝 နာမည်: ${data.accountName}\n` +
    `🆔 Transaction ID: ${transaction._id}\n` +
    `💰 လက်ကျန်: ${user.balance} MMK`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ ငွေလွှဲပြီးပါပြီ', callback_data: `confirm_withdraw_${transaction._id}` },
            { text: '❌ ငြင်းပယ်မည်', callback_data: `reject_withdraw_${transaction._id}` }
          ]
        ]
      }
    }
  );
  
  await ctx.reply('ငွေထုတ်ရန် တောင်းဆိုချက်ကို လက်ခံရရှိပါသည်။ Admin ငွေလွှဲပြီးပါက အတည်ပြုပေးပါမည်။');
}

// Admin callback handlers
bot.action(/confirm_deposit_(.+)/, async (ctx) => {
  const transactionId = ctx.match[1];
  const adminUsername = ctx.from.username || ctx.from.first_name;
  
  const transaction = await Transaction.findById(transactionId);
  if (!transaction) {
    await ctx.answerCbQuery('Transaction not found');
    return;
  }
  
  // Update user balance
  const user = await User.findOne({ telegramId: transaction.userId });
  if (user) {
    user.balance += transaction.amount;
    user.totalDeposited += transaction.amount;
    await user.save();
  }
  
  transaction.status = 'confirmed';
  transaction.confirmedBy = adminUsername;
  transaction.confirmedAt = new Date();
  await transaction.save();
  
  // Notify user
  await ctx.telegram.sendMessage(
    transaction.userId,
    `✅ ငွေသွင်းတောင်းဆိုချက် အတည်ပြုပြီးပါပြီ။\n` +
    `💰 ပမာဏ: ${transaction.amount} MMK\n` +
    `💳 လက်ကျန်အသစ်: ${user.balance} MMK\n\n` +
    `ကျေးဇူးတင်ပါတယ်။`
  );
  
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
  await ctx.answerCbQuery('✅ Deposit confirmed');
});

bot.action(/reject_deposit_(.+)/, async (ctx) => {
  const transactionId = ctx.match[1];
  
  const transaction = await Transaction.findById(transactionId);
  if (!transaction) {
    await ctx.answerCbQuery('Transaction not found');
    return;
  }
  
  transaction.status = 'rejected';
  await transaction.save();
  
  // Ask for rejection reason
  await ctx.reply('ငြင်းပယ်ရသည့် အကြောင်းအရင်းကို ရေးပေးပါ:', {
    reply_markup: { force_reply: true }
  });
  
  // Store transaction ID in session for next message
  ctx.session = { transactionId };
});

bot.action(/confirm_withdraw_(.+)/, async (ctx) => {
  const transactionId = ctx.match[1];
  const adminUsername = ctx.from.username || ctx.from.first_name;
  
  const transaction = await Transaction.findById(transactionId);
  if (!transaction) {
    await ctx.answerCbQuery('Transaction not found');
    return;
  }
  
  const user = await User.findOne({ telegramId: transaction.userId });
  if (user) {
    user.balance -= transaction.amount;
    user.totalWithdrawn += transaction.amount;
    await user.save();
  }
  
  transaction.status = 'confirmed';
  transaction.confirmedBy = adminUsername;
  transaction.confirmedAt = new Date();
  await transaction.save();
  
  // Notify user
  await ctx.telegram.sendMessage(
    transaction.userId,
    `✅ ငွေထုတ်တောင်းဆိုချက် အတည်ပြုပြီးပါပြီ။\n` +
    `💰 ပမာဏ: ${transaction.amount} MMK ကို သင့် KPay သို့ လွှဲပေးလိုက်ပါပြီ။\n` +
    `💳 လက်ကျန်အသစ်: ${user.balance} MMK\n\n` +
    `ကျေးဇူးတင်ပါတယ်။`
  );
  
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
  await ctx.answerCbQuery('✅ Withdraw confirmed');
});

// Handle reply messages (rejection reasons)
bot.on('text', async (ctx) => {
  if (ctx.message.reply_to_message && ctx.session?.transactionId) {
    const transactionId = ctx.session.transactionId;
    const reason = ctx.message.text;
    
    const transaction = await Transaction.findById(transactionId);
    if (transaction) {
      transaction.adminNote = reason;
      await transaction.save();
      
      // Notify user
      await ctx.telegram.sendMessage(
        transaction.userId,
        `❌ ငွေသွင်းတောင်းဆိုချက် ငြင်းပယ်ခံရပါသည်။\n` +
        `အကြောင်းအရင်း: ${reason}\n\n` +
        `ထပ်မံကြိုးစားကြည့်ပါ။`
      );
      
      await ctx.reply('အကြောင်းအရင်းကို User ထံ ပို့လိုက်ပါပြီ။');
    }
    
    delete ctx.session.transactionId;
  }
});

// API Routes
app.post('/api/auth', async (req, res) => {
  try {
    const { id, username, first_name, last_name } = req.body;
    
    let user = await User.findOne({ telegramId: id.toString() });
    
    if (!user) {
      user = await User.create({
        telegramId: id.toString(),
        username: username || `${first_name} ${last_name || ''}`.trim(),
        firstName: first_name,
        lastName: last_name,
        balance: 1000
      });
    } else {
      user.lastActive = new Date();
      await user.save();
    }
    
    res.json({
      success: true,
      user: {
        id: user.telegramId,
        username: user.username,
        balance: user.balance,
        totalDeposited: user.totalDeposited,
        totalWithdrawn: user.totalWithdrawn
      }
    });
  } catch (error) {
    console.error('Auth error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.get('/api/balance/:userId', async (req, res) => {
  try {
    const user = await User.findOne({ telegramId: req.params.userId });
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    
    res.json({
      success: true,
      balance: user.balance
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.get('/api/history/:userId', async (req, res) => {
  try {
    const bets = await Bet.find({ userId: req.params.userId })
      .sort({ createdAt: -1 })
      .limit(20);
    
    res.json({
      success: true,
      history: bets
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Socket.io connection handler
io.on('connection', (socket) => {
  console.log('🟢 Client connected:', socket.id);
  
  // Send current game state
  socket.emit('multiplier', {
    multiplier: gameState.currentMultiplier,
    gameState: gameState.isRunning ? 'running' : 'waiting'
  });
  
  // Handle bet placement
  socket.on('placeBet', async (data, callback) => {
    const result = await placeBet(data.userId, data.username, data.amount);
    callback(result);
    
    if (result.success) {
      io.emit('newBet', {
        userId: data.userId,
        username: data.username,
        amount: data.amount
      });
    }
  });
  
  // Handle cash out
  socket.on('cashOut', async (data, callback) => {
    const result = await cashOut(socket.userId, data.multiplier);
    callback(result);
    
    if (result.success) {
      io.emit('cashout', {
        userId: socket.userId,
        multiplier: data.multiplier,
        profit: result.profit
      });
    }
  });
  
  socket.on('disconnect', () => {
    console.log('🔴 Client disconnected:', socket.id);
  });
});

// Helper functions
function generateGameId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Start the game loop
startGameLoop();

// Start Telegram bot
bot.launch().then(() => {
  console.log('🤖 Telegram bot started');
}).catch((err) => {
  console.error('❌ Telegram bot error:', err);
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

// Graceful shutdown
process.once('SIGINT', () => {
  bot.stop('SIGINT');
  mongoose.disconnect();
});
process.once('SIGTERM', () => {
  bot.stop('SIGTERM');
  mongoose.disconnect();
});
