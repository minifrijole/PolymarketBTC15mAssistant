import fs from "node:fs";
import path from "node:path";

const DATA_FILE = "./logs/paper_trading.json";

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    }
  } catch (e) {
    console.error("[PaperTrader] Error loading data:", e.message);
  }
  return null;
}

function saveData(data) {
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), "utf8");
  } catch (e) {
    console.error("[PaperTrader] Error saving data:", e.message);
  }
}

export class PaperTrader {
  constructor(options = {}) {
    const saved = loadData();
    
    if (saved && !options.reset) {
      // Resume from saved state
      this.startingBalance = saved.startingBalance || 1000;
      this.balance = saved.balance;
      this.trades = saved.trades || [];
      this.positions = new Map(saved.positions || []);
      this.enabled = saved.enabled ?? false;
      this.startedAt = saved.startedAt;
      this.stats = saved.stats || this.initStats();
      this.sessionHistory = saved.sessionHistory || [];
      this.lifetimeStats = saved.lifetimeStats || this.initLifetimeStats();
      console.log(`[PaperTrader] Resumed with balance: $${this.balance.toFixed(2)} | Sessions: ${this.sessionHistory.length}`);
    } else {
      // Fresh start
      this.startingBalance = options.startingBalance || 1000;
      this.balance = this.startingBalance;
      this.trades = [];
      this.positions = new Map();
      this.enabled = false;
      this.startedAt = new Date().toISOString();
      this.stats = this.initStats();
      this.sessionHistory = [];
      this.lifetimeStats = this.initLifetimeStats();
    }

    // Trading parameters
    this.minEdge = options.minEdge || 0.10; // 10% minimum edge
    this.maxPositionPct = options.maxPositionPct || 0.05; // Max 5% of balance per trade (reduced from 10%)
    this.cooldownMs = options.cooldownMs || 30000; // 30 seconds between trades
    this.lastTradeTime = null;
    this.autoResetThreshold = 10; // Auto-reset when balance falls below $10
    
    // Track current market for settlement
    this.currentMarketSlug = null;
    this.pendingSettlement = null;
  }
  
  initLifetimeStats() {
    return {
      totalSessions: 0,
      totalTrades: 0,
      totalWins: 0,
      totalLosses: 0,
      totalWon: 0,
      totalLost: 0,
      sessionsWon: 0,  // Sessions that ended in profit
      sessionsLost: 0  // Sessions that got wiped
    };
  }

  initStats() {
    return {
      totalTrades: 0,
      wins: 0,
      losses: 0,
      totalWon: 0,
      totalLost: 0,
      largestWin: 0,
      largestLoss: 0,
      currentStreak: 0,
      bestStreak: 0,
      worstStreak: 0
    };
  }

  enable() {
    this.enabled = true;
    console.log("[PaperTrader] Enabled - Paper trading active");
    this.save();
  }

  disable() {
    this.enabled = false;
    console.log("[PaperTrader] Disabled");
    this.save();
  }

  isEnabled() {
    return this.enabled;
  }

  reset(startingBalance = 1000, recordSession = true) {
    // Record the ended session in history
    if (recordSession && this.stats.totalTrades > 0) {
      const sessionPnl = this.balance - this.startingBalance;
      const session = {
        id: this.sessionHistory.length + 1,
        startedAt: this.startedAt,
        endedAt: new Date().toISOString(),
        startingBalance: this.startingBalance,
        endingBalance: this.balance,
        pnl: sessionPnl,
        pnlPct: ((this.balance / this.startingBalance) - 1) * 100,
        trades: this.stats.totalTrades,
        wins: this.stats.wins,
        losses: this.stats.losses,
        winRate: this.stats.totalTrades > 0 ? (this.stats.wins / this.stats.totalTrades * 100).toFixed(1) : 0,
        wiped: this.balance < this.autoResetThreshold
      };
      
      this.sessionHistory.push(session);
      
      // Update lifetime stats
      this.lifetimeStats.totalSessions++;
      this.lifetimeStats.totalTrades += this.stats.totalTrades;
      this.lifetimeStats.totalWins += this.stats.wins;
      this.lifetimeStats.totalLosses += this.stats.losses;
      this.lifetimeStats.totalWon += this.stats.totalWon;
      this.lifetimeStats.totalLost += this.stats.totalLost;
      if (sessionPnl > 0) {
        this.lifetimeStats.sessionsWon++;
      } else {
        this.lifetimeStats.sessionsLost++;
      }
      
      console.log(`[PaperTrader] Session #${session.id} ended: ${session.wiped ? 'WIPED' : sessionPnl >= 0 ? 'PROFIT' : 'LOSS'} | PnL: $${sessionPnl.toFixed(2)} (${session.pnlPct.toFixed(1)}%)`);
    }
    
    this.startingBalance = startingBalance;
    this.balance = startingBalance;
    this.trades = [];
    this.positions = new Map();
    this.startedAt = new Date().toISOString();
    this.stats = this.initStats();
    this.lastTradeTime = null;
    console.log(`[PaperTrader] Reset with $${startingBalance} | Total sessions: ${this.sessionHistory.length}`);
    this.save();
  }
  
  checkAutoReset() {
    // Auto-reset if balance falls below threshold and no open positions
    if (this.balance < this.autoResetThreshold && this.positions.size === 0) {
      console.log(`[PaperTrader] Balance below $${this.autoResetThreshold} - Auto-resetting...`);
      this.reset(this.startingBalance, true);
      return true;
    }
    return false;
  }

  save() {
    saveData({
      startingBalance: this.startingBalance,
      balance: this.balance,
      trades: this.trades,
      positions: Array.from(this.positions.entries()),
      enabled: this.enabled,
      startedAt: this.startedAt,
      stats: this.stats,
      sessionHistory: this.sessionHistory,
      lifetimeStats: this.lifetimeStats
    });
  }

  canTrade() {
    if (!this.enabled) return { allowed: false, reason: "Paper trading disabled" };
    
    // Check for auto-reset
    if (this.checkAutoReset()) {
      return { allowed: false, reason: "Session reset - waiting for next signal" };
    }
    
    if (this.balance < this.autoResetThreshold) {
      return { allowed: false, reason: "Balance too low - waiting for positions to settle" };
    }
    
    if (this.lastTradeTime) {
      const elapsed = Date.now() - this.lastTradeTime;
      if (elapsed < this.cooldownMs) {
        return { allowed: false, reason: `Cooldown: ${Math.ceil((this.cooldownMs - elapsed) / 1000)}s` };
      }
    }

    return { allowed: true };
  }

  evaluateAndTrade(data) {
    // Check for market change - settle previous positions
    if (this.currentMarketSlug && this.currentMarketSlug !== data.market.slug) {
      this.settlePositions(this.pendingSettlement);
    }
    
    this.currentMarketSlug = data.market.slug;
    this.pendingSettlement = data;

    const canTradeResult = this.canTrade();
    if (!canTradeResult.allowed) {
      return { traded: false, reason: canTradeResult.reason };
    }

    const { signal, edge, market, polymarket, prices, timing } = data;

    // Only trade on clear signals
    if (signal.action === "HOLD" || !signal.side) {
      return { traded: false, reason: "No actionable signal" };
    }

    // Check edge threshold
    const edgeValue = signal.edge / 100;
    if (edgeValue < this.minEdge) {
      return { traded: false, reason: `Edge ${signal.edge?.toFixed(1)}% below min ${this.minEdge * 100}%` };
    }

    // Only trade STRONG or GOOD signals
    if (signal.strength !== "STRONG" && signal.strength !== "GOOD") {
      return { traded: false, reason: "Signal not strong enough" };
    }

    // Don't trade in LATE phase (too risky)
    if (timing.phase === "LATE") {
      return { traded: false, reason: "Too late in window" };
    }

    // Calculate position size based on edge (modified Kelly)
    // Kelly fraction = edge / (odds - 1), simplified for binary markets
    const price = signal.side === "UP" ? polymarket.upPrice : polymarket.downPrice;
    if (!price || price <= 0 || price >= 1) {
      return { traded: false, reason: "Invalid price" };
    }

    // Position size: min of (edge-based size) and (max position %)
    const kellyFraction = Math.min(edgeValue * 0.5, this.maxPositionPct); // Half-Kelly
    const positionSize = Math.min(this.balance * kellyFraction, this.balance * this.maxPositionPct);
    const shares = Math.floor(positionSize / price);

    if (shares < 1 || positionSize < 1) {
      return { traded: false, reason: "Position size too small" };
    }

    const cost = shares * price;
    if (cost > this.balance) {
      return { traded: false, reason: "Insufficient balance" };
    }

    // Execute paper trade
    this.balance -= cost;
    this.lastTradeTime = Date.now();

    const trade = {
      id: `PT-${Date.now()}`,
      timestamp: new Date().toISOString(),
      marketSlug: market.slug,
      side: signal.side,
      shares,
      entryPrice: price,
      cost,
      priceToBeat: prices.priceToBeat,
      currentPrice: prices.chainlink,
      edge: signal.edge,
      strength: signal.strength,
      phase: timing.phase,
      timeLeftMin: timing.timeLeftMin,
      status: "OPEN",
      pnl: null,
      exitPrice: null,
      settledAt: null
    };

    this.trades.push(trade);
    this.positions.set(trade.id, trade);

    console.log(`[PaperTrader] BUY ${shares} ${signal.side} @ ${price.toFixed(4)} = $${cost.toFixed(2)} | Edge: ${signal.edge?.toFixed(1)}%`);

    this.save();

    return {
      traded: true,
      trade,
      balance: this.balance
    };
  }

  settlePositions(finalData) {
    if (!finalData || this.positions.size === 0) return;

    const { prices } = finalData;
    const currentPrice = prices?.chainlink;
    const priceToBeat = prices?.priceToBeat;

    if (currentPrice === null || priceToBeat === null) return;

    // Determine outcome: UP wins if currentPrice > priceToBeat
    const outcome = currentPrice > priceToBeat ? "UP" : "DOWN";

    for (const [id, trade] of this.positions.entries()) {
      if (trade.status !== "OPEN") continue;

      const won = trade.side === outcome;
      const payout = won ? trade.shares * 1.0 : 0; // Winners get $1 per share
      const pnl = payout - trade.cost;

      trade.status = "SETTLED";
      trade.exitPrice = won ? 1.0 : 0;
      trade.pnl = pnl;
      trade.settledAt = new Date().toISOString();
      trade.outcome = outcome;
      trade.finalPrice = currentPrice;

      this.balance += payout;

      // Update stats
      this.stats.totalTrades++;
      if (pnl > 0) {
        this.stats.wins++;
        this.stats.totalWon += pnl;
        this.stats.largestWin = Math.max(this.stats.largestWin, pnl);
        this.stats.currentStreak = Math.max(0, this.stats.currentStreak) + 1;
        this.stats.bestStreak = Math.max(this.stats.bestStreak, this.stats.currentStreak);
      } else {
        this.stats.losses++;
        this.stats.totalLost += Math.abs(pnl);
        this.stats.largestLoss = Math.max(this.stats.largestLoss, Math.abs(pnl));
        this.stats.currentStreak = Math.min(0, this.stats.currentStreak) - 1;
        this.stats.worstStreak = Math.min(this.stats.worstStreak, this.stats.currentStreak);
      }

      const emoji = won ? "✅" : "❌";
      console.log(`[PaperTrader] ${emoji} ${trade.side} ${won ? "WON" : "LOST"} | PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} | Balance: $${this.balance.toFixed(2)}`);

      this.positions.delete(id);
    }

    this.save();
  }

  // Force settle all positions (for testing or end of session)
  forceSettle(outcome) {
    for (const [id, trade] of this.positions.entries()) {
      if (trade.status !== "OPEN") continue;

      const won = trade.side === outcome;
      const payout = won ? trade.shares * 1.0 : 0;
      const pnl = payout - trade.cost;

      trade.status = "FORCE_SETTLED";
      trade.exitPrice = won ? 1.0 : 0;
      trade.pnl = pnl;
      trade.settledAt = new Date().toISOString();
      trade.outcome = outcome;

      this.balance += payout;

      this.stats.totalTrades++;
      if (pnl > 0) {
        this.stats.wins++;
        this.stats.totalWon += pnl;
      } else {
        this.stats.losses++;
        this.stats.totalLost += Math.abs(pnl);
      }

      this.positions.delete(id);
    }

    this.save();
  }

  getStatus() {
    // Check for auto-reset before returning status
    this.checkAutoReset();
    
    const openPositions = Array.from(this.positions.values()).filter(t => t.status === "OPEN");
    const openValue = openPositions.reduce((sum, t) => sum + t.cost, 0);

    return {
      enabled: this.enabled,
      startingBalance: this.startingBalance,
      currentBalance: this.balance,
      openPositionsValue: openValue,
      totalValue: this.balance + openValue,
      pnl: (this.balance + openValue) - this.startingBalance,
      pnlPct: (((this.balance + openValue) / this.startingBalance) - 1) * 100,
      startedAt: this.startedAt,
      currentSession: this.sessionHistory.length + 1,
      stats: {
        ...this.stats,
        winRate: this.stats.totalTrades > 0 ? (this.stats.wins / this.stats.totalTrades * 100).toFixed(1) : 0,
        avgWin: this.stats.wins > 0 ? (this.stats.totalWon / this.stats.wins).toFixed(2) : 0,
        avgLoss: this.stats.losses > 0 ? (this.stats.totalLost / this.stats.losses).toFixed(2) : 0,
        profitFactor: this.stats.totalLost > 0 ? (this.stats.totalWon / this.stats.totalLost).toFixed(2) : "∞"
      },
      lifetimeStats: {
        ...this.lifetimeStats,
        winRate: this.lifetimeStats.totalTrades > 0 
          ? (this.lifetimeStats.totalWins / this.lifetimeStats.totalTrades * 100).toFixed(1) 
          : 0,
        netPnl: this.lifetimeStats.totalWon - this.lifetimeStats.totalLost
      },
      sessionHistory: this.sessionHistory.slice(-10).reverse(), // Last 10 sessions
      openPositions,
      recentTrades: this.trades.slice(-20).reverse()
    };
  }
}

// Export singleton
export const paperTrader = new PaperTrader({ startingBalance: 1000 });
