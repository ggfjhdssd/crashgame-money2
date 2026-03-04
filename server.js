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
const ADMIN_IDS = process.env.ADMIN_IDS ? process.env.ADMIN_IDS.split(',') : [];

console.log('Bot Token:', process.env.BOT_TOKEN ? '✅ Present' : '❌ Missing');
console.log('Admin Group ID:', ADMIN_GROUP_ID ? '✅ Present' : '❌ Missing');
console.log('Admin IDs:', ADMIN_IDS);

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
  isBanned: { type: Boolean, default: false },
  bannedAt: Date,
  banReason: String,
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
  history: [],
  countdown: null,
  countdownInterval: null
};

// Bot users (Fake players) with different cashout strategies
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

// Helper function to generate crash point (max 20.0x)
function generateCrashPoint(totalBets) {
  let crashPoint;
  
  if (totalBets > 10000) {
    crashPoint = 1.1 + (Math.random() * 0.9); // 1.1x - 2.0x
  } else if (totalBets > 5000) {
    crashPoint = 1.2 + (Math.random() * 2.8); // 1.2x - 4.0x
  } else if (totalBets > 2000) {
    crashPoint = 1.5 + (Math.random() * 5.5); // 1.5x - 7.0x
  } else {
    if (Math.random() < 0.3) {
      crashPoint = 5 + (Math.random() * 15); // 5x - 20x
    } else {
      crashPoint = 1.1 + (Math.random() * 3.9); // 1.1x - 5x
    }
  }
  
  // Ensure max is 20.0x
  return Math.min(20.0, Math.round(crashPoint * 100) / 100);
}

// Game Loop
async function startGameLoop() {
  console.log('🎮 Starting game loop...');
  
  while (true) {
    // Start countdown
    await startCountdown();
    
    // Start new game
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

async function startCountdown() {
  return new Promise((resolve) => {
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
    const user = await User.findOne({ telegramId: userId });
    if (!user) {
      return { success: false, message: 'User not found' };
    }
    
    if (user.isBanned) {
      return { success: false, message: 'Your account has been banned' };
    }
    
    if (!gameState.isRunning && gameState.countdownInterval) {
      return { success: false, message: 'Please wait for countdown' };
    }
    
    if (gameState.bets.has(userId)) {
      return { success: false, message: 'You already have an active bet' };
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
      
      io.emit('newHistory', {
        username: bet.username,
        start: 1.0,
        stop: multiplier,
        profit: profit,
        isBot: bet.isBot || false
      });
      
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

// Bot functions with different strategies
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
        isBot: true,
        strategy: bot.strategy
      });
      gameState.totalBets += betAmount;
      
      console.log(`🤖 Bot ${bot.username} (${bot.strategy}) placed bet: ${betAmount}`);
    }
  });
}

function processBotCashouts() {
  for (const [userId, bet] of gameState.bets.entries()) {
    if (bet.isBot && !bet.cashedAt) {
      const currentMultiplier = gameState.currentMultiplier;
      let shouldCashout = false;
      
      // Different strategies for different bots
      switch(bet.strategy) {
        case 'early':
          shouldCashout = currentMultiplier > 1.2 && currentMultiplier < 2.0 && Math.random() < 0.3;
          break;
        case 'medium':
          shouldCashout = currentMultiplier > 2.0 && currentMultiplier < 4.0 && Math.random() < 0.2;
          break;
        case 'late':
          shouldCashout = currentMultiplier > 4.0 && currentMultiplier < 8.0 && Math.random() < 0.15;
          break;
        case 'random':
          shouldCashout = Math.random() < 0.1; // Random chance at any time
          break;
      }
      
      if (shouldCashout) {
        const profit = bet.amount * (currentMultiplier - 1);
        bet.cashedAt = Date.now();
        bet.cashoutMultiplier = currentMultiplier;
        bet.profit = profit;
        
        const bot = botUsers.find(b => b.id === userId);
        if (bot) {
          bot.balance += bet.amount + profit;
        }
        
        console.log(`🤖 Bot ${bet.username} (${bet.strategy}) cashed out at ${currentMultiplier}x`);
        
        io.emit('newHistory', {
          username: bet.username,
          start: 1.0,
          stop: currentMultiplier,
          profit: profit,
          isBot: true
        });
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
      if (user.isBanned) {
        await ctx.reply('❌ သင့်အကောင့်ကို ပိတ်ပင်ထားပါသည်။');
        return;
      }
      
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

// Admin commands
bot.command('balance', async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from.id.toString())) {
    return ctx.reply('❌ သင် Admin မဟုတ်ပါ။');
  }
  
  const args = ctx.message.text.split(' ');
  if (args.length < 3) {
    return ctx.reply('Usage: /balance <user_id> <add/deduct> <amount>');
  }
  
  const targetId = args[1];
  const action = args[2];
  const amount = parseFloat(args[3]);
  
  if (isNaN(amount) || amount <= 0) {
    return ctx.reply('❌ ငွေပမာဏ မှန်ကန်စွာထည့်ပါ။');
  }
  
  try {
    const user = await User.findOne({ telegramId: targetId });
    if (!user) {
      return ctx.reply('❌ User မတွေ့ပါ။');
    }
    
    if (action === 'add') {
      user.balance += amount;
      user.totalDeposited += amount;
      await user.save();
      
      await ctx.telegram.sendMessage(
        targetId,
        `✅ သင့်အကောင့်ထဲသို့ ${amount} MMK ထည့်ပေးလိုက်ပါသည်။\nလက်ကျန်အသစ်: ${user.balance} MMK`
      );
      
      io.emit('balanceUpdate', { userId: targetId, balance: user.balance });
      
      await ctx.reply(`✅ ${targetId} အကောင့်ထဲသို့ ${amount} MMK ထည့်ပြီးပါပြီ။`);
    } else if (action === 'deduct') {
      if (user.balance < amount) {
        return ctx.reply('❌ User ရဲ့ လက်ကျန်ငေ မလုံလောက်ပါ။');
      }
      
      user.balance -= amount;
      user.totalWithdrawn += amount;
      await user.save();
      
      await ctx.telegram.sendMessage(
        targetId,
        `ℹ️ သင့်အကောင့်မှ ${amount} MMK နုတ်ယူလိုက်ပါသည်။\nလက်ကျန်အသစ်: ${user.balance} MMK`
      );
      
      io.emit('balanceUpdate', { userId: targetId, balance: user.balance });
      
      await ctx.reply(`✅ ${targetId} အကောင့်မှ ${amount} MMK နုတ်ပြီးပါပြီ။`);
    } else {
      await ctx.reply('Invalid action. Use add or deduct');
    }
  } catch (error) {
    console.error('Admin balance error:', error);
    await ctx.reply('❌ အမှားဖြစ်သွားပါသည်။');
  }
});

bot.command('ban', async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from.id.toString())) {
    return ctx.reply('❌ သင် Admin မဟုတ်ပါ။');
  }
  
  const args = ctx.message.text.split(' ');
  if (args.length < 3) {
    return ctx.reply('Usage: /ban <user_id> <reason>');
  }
  
  const targetId = args[1];
  const reason = args.slice(2).join(' ');
  
  try {
    const user = await User.findOne({ telegramId: targetId });
    if (!user) {
      return ctx.reply('❌ User မတွေ့ပါ။');
    }
    
    user.isBanned = true;
    user.bannedAt = new Date();
    user.banReason = reason;
    await user.save();
    
    await ctx.telegram.sendMessage(
      targetId,
      `❌ သင့်အကောင့်ကို ပိတ်ပင်ထားပါသည်။\nအကြောင်းရင်း: ${reason}`
    );
    
    await ctx.reply(`✅ User ${targetId} ကို Ban လိုက်ပါပြီ။`);
  } catch (error) {
    console.error('Admin ban error:', error);
    await ctx.reply('❌ အမှားဖြစ်သွားပါသည်။');
  }
});

bot.command('unban', async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from.id.toString())) {
    return ctx.reply('❌ သင် Admin မဟုတ်ပါ။');
  }
  
  const args = ctx.message.text.split(' ');
  if (args.length < 2) {
    return ctx.reply('Usage: /unban <user_id>');
  }
  
  const targetId = args[1];
  
  try {
    const user = await User.findOne({ telegramId: targetId });
    if (!user) {
      return ctx.reply('❌ User မတွေ့ပါ။');
    }
    
    user.isBanned = false;
    user.banReason = null;
    await user.save();
    
    await ctx.telegram.sendMessage(
      targetId,
      `✅ သင့်အကောင့်ကို ပြန်ဖွင့်ပေးလိုက်ပါပြီ။`
    );
    
    await ctx.reply(`✅ User ${targetId} ကို Unban လိုက်ပါပြီ။`);
  } catch (error) {
    console.error('Admin unban error:', error);
    await ctx.reply('❌ အမှားဖြစ်သွားပါသည်။');
  }
});

bot.command('userinfo', async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from.id.toString())) {
    return ctx.reply('❌ သင် Admin မဟုတ်ပါ။');
  }
  
  const args = ctx.message.text.split(' ');
  if (args.length < 2) {
    return ctx.reply('Usage: /userinfo <user_id>');
  }
  
  const targetId = args[1];
  
  try {
    const user = await User.findOne({ telegramId: targetId });
    if (!user) {
      return ctx.reply('❌ User မတွေ့ပါ။');
    }
    
    const recentBets = await Bet.find({ userId: targetId })
      .sort({ startedAt: -1 })
      .limit(5);
    
    let betsInfo = '';
    recentBets.forEach((bet, i) => {
      betsInfo += `${i+1}. ${bet.amount} MMK - ${bet.status} ${bet.cashoutMultiplier ? `@ ${bet.cashoutMultiplier}x` : ''}\n`;
    });
    
    await ctx.reply(
      `👤 *User Information*\n\n` +
      `ID: ${user.telegramId}\n` +
      `Username: ${user.username}\n` +
      `Balance: ${user.balance} MMK\n` +
      `Status: ${user.isBanned ? '❌ Banned' : '✅ Active'}\n` +
      `Total Bets: ${user.totalBets}\n` +
      `Total Wins: ${user.totalWins}\n` +
      `Win Rate: ${user.totalBets > 0 ? Math.round((user.totalWins/user.totalBets)*100) : 0}%\n` +
      `Deposited: ${user.totalDeposited} MMK\n` +
      `Withdrawn: ${user.totalWithdrawn} MMK\n\n` +
      `*Recent Bets:*\n${betsInfo || 'No bets yet'}`,
      { parse_mode: 'Markdown' }
    );
  } catch (error) {
    console.error('Admin userinfo error:', error);
    await ctx.reply('❌ အမှားဖြစ်သွားပါသည်။');
  }
});

// ============================================
// NEW API ENDPOINTS FOR DEPOSIT/WITHDRAW (using fetch)
// ============================================

app.post('/api/deposit', async (req, res) => {
    try {
        const { userId, username, name, phone, amount } = req.body;
        console.log('📥 Deposit request:', { userId, username, name, phone, amount });

        // Validate
        if (!userId || !username || !name || !phone || !amount || amount < 3000) {
            return res.status(400).json({ success: false, message: 'Invalid data or amount < 3000' });
        }

        // Save transaction
        const transaction = await Transaction.create({
            userId,
            username,
            type: 'deposit',
            amount,
            accountName: name,
            accountNumber: phone,
            status: 'pending'
        });

        // Notify each admin via bot
        for (const adminId of ADMIN_IDS) {
            try {
                await bot.telegram.sendMessage(
                    adminId,
                    `💰 *ငွေသွင်းရန် တောင်းဆိုချက်*\n\n` +
                    `👤 User: ${username}\n` +
                    `🆔 ID: ${userId}\n` +
                    `💵 ပမာဏ: ${amount} MMK\n` +
                    `📝 နာမည်: ${name}\n` +
                    `📞 ဖုန်း: ${phone}\n` +
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
            } catch (e) {
                console.error(`Failed to send to admin ${adminId}:`, e);
            }
        }

        res.json({ success: true, message: 'Deposit request received' });
    } catch (error) {
        console.error('Deposit API error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

app.post('/api/withdraw', async (req, res) => {
    try {
        const { userId, username, name, phone, amount } = req.body;
        console.log('📤 Withdraw request:', { userId, username, name, phone, amount });

        // Validate
        if (!userId || !username || !name || !phone || !amount || amount <= 0) {
            return res.status(400).json({ success: false, message: 'Invalid data' });
        }

        // Check user balance
        const user = await User.findOne({ telegramId: userId });
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }
        if (user.balance < amount) {
            return res.status(400).json({ success: false, message: 'Insufficient balance' });
        }

        // Save transaction (pending)
        const transaction = await Transaction.create({
            userId,
            username,
            type: 'withdraw',
            amount,
            accountName: name,
            accountNumber: phone,
            status: 'pending'
        });

        // Notify each admin
        for (const adminId of ADMIN_IDS) {
            try {
                await bot.telegram.sendMessage(
                    adminId,
                    `💸 *ငွေထုတ်ရန် တောင်းဆိုချက်*\n\n` +
                    `👤 User: ${username}\n` +
                    `🆔 ID: ${userId}\n` +
                    `💵 ပမာဏ: ${amount} MMK\n` +
                    `📝 နာမည်: ${name}\n` +
                    `📞 ဖုန်း: ${phone}\n` +
                    `💰 လက်ကျန်: ${user.balance} MMK\n` +
                    `🆔 Transaction ID: ${transaction._id}`,
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
            } catch (e) {
                console.error(`Failed to send to admin ${adminId}:`, e);
            }
        }

        res.json({ success: true, message: 'Withdraw request received' });
    } catch (error) {
        console.error('Withdraw API error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
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
      if (user.isBanned) {
        return res.json({ 
          success: false, 
          message: 'Your account has been banned',
          banned: true 
        });
      }
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

// Admin callback handlers for transactions
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

bot.action(/reject_deposit_(.+)/, async (ctx) => {
  const transactionId = ctx.match[1];
  
  try {
    const transaction = await Transaction.findById(transactionId);
    if (!transaction) {
      await ctx.answerCbQuery('Transaction not found');
      return;
    }
    
    transaction.status = 'rejected';
    await transaction.save();
    
    await ctx.telegram.sendMessage(
      transaction.userId,
      `❌ ငွေသွင်းတောင်းဆိုချက် ငြင်းပယ်ခံရပါသည်။\n` +
      `ကျေးဇူးပြု၍ ပြန်လည်ဆက်သွယ်ပါ။`
    );
    
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
    await ctx.answerCbQuery('❌ Deposit rejected');
  } catch (error) {
    console.error('Error in reject_deposit:', error);
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

bot.action(/reject_withdraw_(.+)/, async (ctx) => {
  const transactionId = ctx.match[1];
  
  try {
    const transaction = await Transaction.findById(transactionId);
    if (!transaction) {
      await ctx.answerCbQuery('Transaction not found');
      return;
    }
    
    transaction.status = 'rejected';
    await transaction.save();
    
    await ctx.telegram.sendMessage(
      transaction.userId,
      `❌ ငွေထုတ်တောင်းဆိုချက် ငြင်းပယ်ခံရပါသည်။\n` +
      `ကျေးဇူးပြု၍ ပြန်လည်ဆက်သွယ်ပါ။`
    );
    
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
    await ctx.answerCbQuery('❌ Withdraw rejected');
  } catch (error) {
    console.error('Error in reject_withdraw:', error);
    await ctx.answerCbQuery('Error processing request');
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
