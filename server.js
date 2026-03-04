const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');
const dotenv = require('dotenv');
const { Telegraf } = require('telegraf');

// Load environment variables
dotenv.config();

// Initialize Express app
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    credentials: true
  },
  transports: ['websocket', 'polling']
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Telegram Bot setup
const bot = new Telegraf(process.env.BOT_TOKEN);
const ADMIN_GROUP_ID = process.env.ADMIN_GROUP_ID;

console.log('Bot Token:', process.env.BOT_TOKEN ? '✅ Present' : '❌ Missing');
console.log('Admin Group ID:', ADMIN_GROUP_ID ? '✅ Present' : '❌ Missing');

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
  balance: { type: Number, default: 1000 },
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
  bets: new Map(),
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

// Helper function to generate crash point
function generateCrashPoint(totalBets) {
  let crashPoint;
  
  if (totalBets > 10000) {
    crashPoint = 1.1 + (Math.random() * 0.4);
  } else if (totalBets > 5000) {
    crashPoint = 1.2 + (Math.random() * 1.3);
  } else {
    if (Math.random() < 0.2) {
      crashPoint = 5 + (Math.random() * 15);
    } else {
      crashPoint = 1.1 + (Math.random() * 3.9);
    }
  }
  
  return Math.round(crashPoint * 100) / 100;
}

// Game Loop
async function startGameLoop() {
  console.log('🎮 Starting game loop...');
  
  while (true) {
    await startNewGame();
    
    const startTime = Date.now();
    gameState.startTime = startTime;
    
    while (gameState.isRunning) {
      const elapsedSeconds = (Date.now() - startTime) / 1000;
      const currentMultiplier = 1.0 + (elapsedSeconds * 0.1);
      
      if (currentMultiplier >= gameState.crashPoint) {
        await crashGame();
        break;
      }
      
      gameState.currentMultiplier = Math.round(currentMultiplier * 100) / 100;
      
      io.emit('multiplier', {
        multiplier: gameState.currentMultiplier,
        gameState: 'running'
      });
      
      processBotCashouts();
      
      await sleep(100);
    }
    
    io.emit('multiplier', {
      multiplier: 0,
      gameState: 'waiting'
    });
    
    await sleep(3000);
  }
}

async function startNewGame() {
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
    history: gameState.history.slice(0, 20)
  };
  
  console.log(`🎲 New game started - Crash Point: ${gameState.crashPoint}x, Total Bets: ${totalBetsAmount}`);
  
  placeBotBets();
  
  // Send active bets to all clients
  const activeBets = Array.from(gameState.bets.values()).map(bet => ({
    username: bet.username,
    amount: bet.amount,
    isBot: bet.isBot || false
  }));
  io.emit('activeBets', { bets: activeBets });
}

async function crashGame() {
  gameState.isRunning = false;
  
  console.log(`💥 Game crashed at ${gameState.crashPoint}x`);
  
  for (const [userId, bet] of gameState.bets.entries()) {
    if (!bet.cashedAt) {
      await processBetLoss(userId, bet);
    }
  }
  
  gameState.history.unshift({
    gameId: gameState.gameId,
    crashPoint: gameState.crashPoint,
    totalBets: gameState.totalBets,
    timestamp: new Date()
  });
  
  io.emit('gameCrashed', {
    multiplier: gameState.crashPoint,
    gameId: gameState.gameId
  });
}

// Bet processing functions
async function placeBet(userId, username, amount) {
  try {
    if (!gameState.isRunning) {
      return { success: false, message: 'Game is not running' };
    }
    
    if (gameState.bets.has(userId)) {
      return { success: false, message: 'You already have an active bet' };
    }
    
    const user = await User.findOne({ telegramId: userId });
    if (!user) {
      return { success: false, message: 'User not found' };
    }
    
    if (user.balance < amount) {
      return { success: false, message: 'Insufficient balance' };
    }
    
    user.balance -= amount;
    user.totalBets += 1;
    await user.save();
    
    const bet = {
      userId,
      username,
      amount,
      placedAt: Date.now(),
      gameId: gameState.gameId,
      isBot: false
    };
    
    gameState.bets.set(userId, bet);
    gameState.totalBets += amount;
    
    await Bet.create({
      userId,
      username,
      amount,
      gameId: gameState.gameId,
      status: 'pending'
    });
    
    gameState.crashPoint = generateCrashPoint(gameState.totalBets);
    
    io.emit('balanceUpdate', { userId, balance: user.balance });
    
    // Update active bets for all clients
    const activeBets = Array.from(gameState.bets.values()).map(b => ({
      username: b.username,
      amount: b.amount,
      isBot: b.isBot || false
    }));
    io.emit('activeBets', { bets: activeBets });
    
    return { success: true, message: 'Bet placed successfully', newBalance: user.balance };
  } catch (error) {
    console.error('placeBet error:', error);
    return { success: false, message: 'Server error' };
  }
}

async function cashOut(userId, multiplier) {
  try {
    const bet = gameState.bets.get(userId);
    
    if (!bet || bet.cashedAt) {
      return { success: false, message: 'No active bet found' };
    }
    
    if (!gameState.isRunning) {
      return { success: false, message: 'Game has crashed' };
    }
    
    const profit = bet.amount * (multiplier - 1);
    const totalReturn = bet.amount + profit;
    
    const user = await User.findOne({ telegramId: userId });
    if (user) {
      user.balance += totalReturn;
      user.totalWins += 1;
      await user.save();
      
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
      io.emit('betResult', { 
        success: true, 
        type: 'cashout', 
        multiplier, 
        profit,
        userId 
      });
      
      // Add to history
      io.emit('newHistory', {
        username: bet.username,
        start: 1.0,
        stop: multiplier,
        profit: profit,
        isBot: bet.isBot || false
      });
      
      // Update active bets
      const activeBets = Array.from(gameState.bets.values())
        .filter(b => !b.cashedAt)
        .map(b => ({
          username: b.username,
          amount: b.amount,
          isBot: b.isBot || false
        }));
      io.emit('activeBets', { bets: activeBets });
    }
    
    return {
      success: true,
      multiplier,
      profit,
      newBalance: user?.balance
    };
  } catch (error) {
    console.error('cashOut error:', error);
    return { success: false, message: 'Server error' };
  }
}

async function processBetLoss(userId, bet) {
  await Bet.findOneAndUpdate(
    { userId, gameId: gameState.gameId },
    { status: 'lost' }
  );
  
  io.emit('newHistory', {
    username: bet.username,
    start: 1.0,
    stop: gameState.crashPoint,
    profit: -bet.amount,
    isBot: bet.isBot || false
  });
}

// Bot functions
function placeBotBets() {
  const numBots = 5 + Math.floor(Math.random() * 5);
  const selectedBots = [...botUsers].sort(() => 0.5 - Math.random()).slice(0, numBots);
  
  selectedBots.forEach(bot => {
    const betAmount = Math.floor(Math.random() * 1000) + 100;
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
  for (const [userId, bet] of gameState.bets.entries()) {
    if (bet.isBot && !bet.cashedAt) {
      const cashoutChance = 0.05;
      if (Math.random() < cashoutChance) {
        const cashoutMultiplier = gameState.currentMultiplier;
        
        if (cashoutMultiplier > 1.1 && Math.random() < 0.5) {
          const profit = bet.amount * (cashoutMultiplier - 1);
          bet.cashedAt = Date.now();
          bet.cashoutMultiplier = cashoutMultiplier;
          bet.profit = profit;
          
          const bot = botUsers.find(b => b.id === userId);
          if (bot) {
            bot.balance += bet.amount + profit;
          }
          
          console.log(`🤖 Bot ${bet.username} cashed out at ${cashoutMultiplier}x`);
          
          io.emit('newHistory', {
            username: bet.username,
            start: 1.0,
            stop: cashoutMultiplier,
            profit: profit,
            isBot: true
          });
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
        balance: 1000
      });
      
      await ctx.reply(
        `🎉 ကြိုဆိုပါတယ် ${username}!\n\n` +
        `သင့်အကောင့်ကို စတင်ဖွင့်လှစ်လိုက်ပါပြီ။\n` +
        `လက်ကျန်ငွေ: 1000 MMK\n\n` +
        `ဂိမ်းစတင်ဆော့ကစားရန် အောက်ပါကိုနှိပ်ပါ။`
      );
    } else {
      await ctx.reply(
        `ပြန်လည်ကြိုဆိုပါတယ် ${username}!\n` +
        `သင့်လက်ကျန်ငွေ: ${user.balance} MMK`
      );
    }
    
    await ctx.reply('🎮 ဂိမ်းစတင်ရန်', {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🎲 CRASH GAME ဖွင့်ရန်', web_app: { url: 'https://crash-gamemoney.vercel.app/' } }]
        ]
      }
    });
  } catch (error) {
    console.error('Error in start command:', error);
    await ctx.reply('စနစ်ကျသင့်မှုတစ်ခုဖြစ်ပွားခဲ့ပါသည်။ နောက်မှပြန်ကြိုးစားပါ။');
  }
});

// Handle WebApp data
bot.on('message', async (ctx) => {
  if (ctx.message.web_app_data) {
    try {
      const data = JSON.parse(ctx.message.web_app_data.data);
      console.log('📱 WebApp data received:', data);
      
      if (data.type === 'deposit') {
        await handleDeposit(ctx, data);
      } else if (data.type === 'withdraw') {
        await handleWithdraw(ctx, data);
      }
    } catch (error) {
      console.error('Error handling web_app_data:', error);
    }
  }
});

async function handleDeposit(ctx, data) {
  const telegramId = ctx.from.id.toString();
  const username = ctx.from.username || `${ctx.from.first_name} ${ctx.from.last_name || ''}`.trim();
  
  console.log('Processing deposit for:', { telegramId, username, data });
  
  try {
    const transaction = await Transaction.create({
      userId: telegramId,
      username,
      type: 'deposit',
      amount: data.amount,
      screenshotUrl: data.screenshotUrl || 'manual',
      paymentMethod: data.paymentMethod || 'KPay',
      status: 'pending'
    });
    
    console.log('Transaction created:', transaction._id);
    
    if (ADMIN_GROUP_ID) {
      await ctx.telegram.sendMessage(
        ADMIN_GROUP_ID,
        `💰 *ငွေသွင်းရန် တောင်းဆိုချက်*\n\n` +
        `👤 User: ${username}\n` +
        `🆔 ID: ${telegramId}\n` +
        `💵 ပမာဏ: ${data.amount} MMK\n` +
        `💳 ငွေသွင်းနည်း: ${data.paymentMethod}\n` +
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
      console.log('Admin notification sent');
    } else {
      console.log('ADMIN_GROUP_ID not set');
    }
    
    await ctx.reply('✅ ငွေသွင်းရန် တောင်းဆိုချက်ကို လက်ခံရရှိပါသည်။ Admin အတည်ပြုပြီးပါက ငွေလက်ကျန်ထဲသို့ ထည့်ပေးပါမည်။');
  } catch (error) {
    console.error('Error in handleDeposit:', error);
    await ctx.reply('စနစ်ကျသင့်မှုတစ်ခုဖြစ်ပွားခဲ့ပါသည်။');
  }
}

async function handleWithdraw(ctx, data) {
  const telegramId = ctx.from.id.toString();
  const username = ctx.from.username || `${ctx.from.first_name} ${ctx.from.last_name || ''}`.trim();
  
  console.log('Processing withdraw for:', { telegramId, username, data });
  
  try {
    const user = await User.findOne({ telegramId });
    if (!user) {
      await ctx.reply('အကောင့်မရှိပါ။');
      return;
    }
    
    if (user.balance < data.amount) {
      await ctx.reply('လက်ကျန်ငွေ မလုံလောက်ပါ။');
      return;
    }
    
    const transaction = await Transaction.create({
      userId: telegramId,
      username,
      type: 'withdraw',
      amount: data.amount,
      accountName: data.accountName,
      accountNumber: data.accountNumber,
      status: 'pending'
    });
    
    console.log('Transaction created:', transaction._id);
    
    if (ADMIN_GROUP_ID) {
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
      console.log('Admin notification sent');
    }
    
    await ctx.reply('✅ ငွေထုတ်ရန် တောင်းဆိုချက်ကို လက်ခံရရှိပါသည်။ Admin ငွေလွှဲပြီးပါက အတည်ပြုပေးပါမည်။');
  } catch (error) {
    console.error('Error in handleWithdraw:', error);
    await ctx.reply('စနစ်ကျသင့်မှုတစ်ခုဖြစ်ပွားခဲ့ပါသည်။');
  }
}

// Admin callback handlers
bot.action(/confirm_deposit_(.+)/, async (ctx) => {
  const transactionId = ctx.match[1];
  const adminUsername = ctx.from.username || ctx.from.first_name;
  
  try {
    const transaction = await Transaction.findById(transactionId);
    if (!transaction) {
      await ctx.answerCbQuery('Transaction not found');
      return;
    }
    
    const user = await User.findOne({ telegramId: transaction.userId });
    if (user) {
      user.balance += transaction.amount;
      user.totalDeposited += transaction.amount;
      await user.save();
      
      transaction.status = 'confirmed';
      transaction.confirmedBy = adminUsername;
      transaction.confirmedAt = new Date();
      await transaction.save();
      
      await ctx.telegram.sendMessage(
        transaction.userId,
        `✅ ငွေသွင်းတောင်းဆိုချက် အတည်ပြုပြီးပါပြီ။\n` +
        `💰 ပမာဏ: ${transaction.amount} MMK\n` +
        `💳 လက်ကျန်အသစ်: ${user.balance} MMK`
      );
      
      await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
      await ctx.answerCbQuery('✅ Deposit confirmed');
      
      io.emit('balanceUpdate', { userId: transaction.userId, balance: user.balance });
    }
  } catch (error) {
    console.error('Error in confirm_deposit:', error);
    await ctx.answerCbQuery('Error processing request');
  }
});

bot.action(/confirm_withdraw_(.+)/, async (ctx) => {
  const transactionId = ctx.match[1];
  const adminUsername = ctx.from.username || ctx.from.first_name;
  
  try {
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
      
      transaction.status = 'confirmed';
      transaction.confirmedBy = adminUsername;
      transaction.confirmedAt = new Date();
      await transaction.save();
      
      await ctx.telegram.sendMessage(
        transaction.userId,
        `✅ ငွေထုတ်တောင်းဆိုချက် အတည်ပြုပြီးပါပြီ။\n` +
        `💰 ပမာဏ: ${transaction.amount} MMK ကို သင့် KPay သို့ လွှဲပေးလိုက်ပါပြီ။\n` +
        `💳 လက်ကျန်အသစ်: ${user.balance} MMK`
      );
      
      await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
      await ctx.answerCbQuery('✅ Withdraw confirmed');
      
      io.emit('balanceUpdate', { userId: transaction.userId, balance: user.balance });
    }
  } catch (error) {
    console.error('Error in confirm_withdraw:', error);
    await ctx.answerCbQuery('Error processing request');
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
        firstName: first_name || '',
        lastName: last_name || '',
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

// Socket.io connection handler
io.on('connection', (socket) => {
  console.log('🟢 Client connected:', socket.id);
  
  const userId = socket.handshake.query.userId;
  if (userId) {
    socket.userId = userId;
    console.log('User ID from query:', userId);
  }
  
  socket.emit('multiplier', {
    multiplier: gameState.currentMultiplier,
    gameState: gameState.isRunning ? 'running' : 'waiting'
  });
  
  const activeBets = Array.from(gameState.bets.values())
    .filter(b => !b.cashedAt)
    .map(b => ({
      username: b.username,
      amount: b.amount,
      isBot: b.isBot || false
    }));
  socket.emit('activeBets', { bets: activeBets });
  
  socket.on('placeBet', async (data, callback) => {
    console.log('placeBet received:', data);
    const result = await placeBet(data.userId, data.username, data.amount);
    callback(result);
  });
  
  socket.on('cashOut', async (data, callback) => {
    console.log('cashOut received:', data);
    const result = await cashOut(data.userId, data.multiplier);
    callback(result);
  });
  
  socket.on('authenticate', (data) => {
    socket.userId = data.userId;
    console.log('Socket authenticated:', data.userId);
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
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

// Graceful shutdown
process.once('SIGINT', () => {
  bot.stop('SIGINT');
  mongoose.disconnect();
  process.exit(0);
});
process.once('SIGTERM', () => {
  bot.stop('SIGTERM');
  mongoose.disconnect();
  process.exit(0);
});
