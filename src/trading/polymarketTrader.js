import { ClobClient, Side } from "@polymarket/clob-client";
import { Wallet } from "ethers";

const HOST = "https://clob.polymarket.com";
const CHAIN_ID = 137; // Polygon mainnet

let client = null;
let initialized = false;

export async function initTrader() {
  const privateKey = process.env.POLYMARKET_PRIVATE_KEY;
  
  if (!privateKey) {
    console.log("[Trader] No POLYMARKET_PRIVATE_KEY set. Trading disabled.");
    return false;
  }

  try {
    const signer = new Wallet(privateKey);
    const tempClient = new ClobClient(HOST, CHAIN_ID, signer);
    const apiCreds = await tempClient.createOrDeriveApiKey();
    const signatureType = 0; // EOA wallet
    
    client = new ClobClient(HOST, CHAIN_ID, signer, apiCreds, signatureType);
    initialized = true;
    
    console.log(`[Trader] Initialized with wallet: ${signer.address}`);
    return true;
  } catch (err) {
    console.error("[Trader] Failed to initialize:", err.message);
    return false;
  }
}

export function isTraderReady() {
  return initialized && client !== null;
}

export async function getBalance() {
  if (!isTraderReady()) return null;
  
  try {
    // Note: Balance checking may need to go through the Polygon network
    // The CLOB client primarily handles order management
    return { status: "ready" };
  } catch (err) {
    console.error("[Trader] Error getting balance:", err.message);
    return null;
  }
}

export async function getOpenOrders() {
  if (!isTraderReady()) return [];
  
  try {
    const orders = await client.getOpenOrders();
    return orders;
  } catch (err) {
    console.error("[Trader] Error getting open orders:", err.message);
    return [];
  }
}

export async function placeBuyOrder({ tokenId, price, size }) {
  if (!isTraderReady()) {
    return { success: false, error: "Trader not initialized" };
  }

  try {
    const response = await client.createAndPostOrder({
      tokenID: tokenId,
      price: price,
      size: size,
      side: Side.BUY
    });

    console.log(`[Trader] Order placed! ID: ${response.orderID}`);
    return { success: true, orderId: response.orderID, response };
  } catch (err) {
    console.error("[Trader] Error placing order:", err.message);
    return { success: false, error: err.message };
  }
}

export async function placeSellOrder({ tokenId, price, size }) {
  if (!isTraderReady()) {
    return { success: false, error: "Trader not initialized" };
  }

  try {
    const response = await client.createAndPostOrder({
      tokenID: tokenId,
      price: price,
      size: size,
      side: Side.SELL
    });

    console.log(`[Trader] Sell order placed! ID: ${response.orderID}`);
    return { success: true, orderId: response.orderID, response };
  } catch (err) {
    console.error("[Trader] Error placing sell order:", err.message);
    return { success: false, error: err.message };
  }
}

export async function cancelOrder(orderId) {
  if (!isTraderReady()) {
    return { success: false, error: "Trader not initialized" };
  }

  try {
    const response = await client.cancelOrder({ orderID: orderId });
    console.log(`[Trader] Order cancelled: ${orderId}`);
    return { success: true, response };
  } catch (err) {
    console.error("[Trader] Error cancelling order:", err.message);
    return { success: false, error: err.message };
  }
}

export async function cancelAllOrders() {
  if (!isTraderReady()) {
    return { success: false, error: "Trader not initialized" };
  }

  try {
    const response = await client.cancelAll();
    console.log("[Trader] All orders cancelled");
    return { success: true, response };
  } catch (err) {
    console.error("[Trader] Error cancelling all orders:", err.message);
    return { success: false, error: err.message };
  }
}

export async function getTrades() {
  if (!isTraderReady()) return [];

  try {
    const trades = await client.getTrades();
    return trades;
  } catch (err) {
    console.error("[Trader] Error getting trades:", err.message);
    return [];
  }
}

// Auto-trading logic
export class AutoTrader {
  constructor(options = {}) {
    this.enabled = false;
    this.maxPositionSize = options.maxPositionSize || 10; // Max shares per trade
    this.minEdge = options.minEdge || 0.10; // Min 10% edge to trade
    this.maxDailyLoss = options.maxDailyLoss || 50; // Max daily loss in USDC
    this.dailyPnL = 0;
    this.lastTradeTime = null;
    this.cooldownMs = options.cooldownMs || 60000; // 1 minute between trades
    this.positions = new Map(); // Track current positions
  }

  enable() {
    this.enabled = true;
    console.log("[AutoTrader] Enabled");
  }

  disable() {
    this.enabled = false;
    console.log("[AutoTrader] Disabled");
  }

  isEnabled() {
    return this.enabled;
  }

  canTrade() {
    if (!this.enabled) return { allowed: false, reason: "Auto-trading disabled" };
    if (!isTraderReady()) return { allowed: false, reason: "Trader not initialized" };
    if (this.dailyPnL <= -this.maxDailyLoss) return { allowed: false, reason: "Daily loss limit reached" };
    
    if (this.lastTradeTime) {
      const elapsed = Date.now() - this.lastTradeTime;
      if (elapsed < this.cooldownMs) {
        return { allowed: false, reason: `Cooldown: ${Math.ceil((this.cooldownMs - elapsed) / 1000)}s remaining` };
      }
    }

    return { allowed: true };
  }

  async evaluateAndTrade(data) {
    const canTradeResult = this.canTrade();
    if (!canTradeResult.allowed) {
      return { traded: false, reason: canTradeResult.reason };
    }

    const { signal, edge, market, polymarket } = data;

    // Check if signal is strong enough
    if (signal.action === "HOLD" || !signal.side) {
      return { traded: false, reason: "No actionable signal" };
    }

    // Check edge threshold
    const edgeValue = signal.edge / 100; // Convert from percentage
    if (edgeValue < this.minEdge) {
      return { traded: false, reason: `Edge ${signal.edge.toFixed(1)}% below minimum ${this.minEdge * 100}%` };
    }

    // Only trade STRONG signals for auto-trading
    if (signal.strength !== "STRONG") {
      return { traded: false, reason: "Only STRONG signals are auto-traded" };
    }

    // Get the token ID for the side we want to buy
    const tokenId = signal.side === "UP" ? market.tokens?.upTokenId : market.tokens?.downTokenId;
    if (!tokenId) {
      return { traded: false, reason: "Missing token ID" };
    }

    // Calculate position size based on edge (Kelly-lite)
    const price = signal.side === "UP" ? polymarket.upPrice : polymarket.downPrice;
    if (!price || price <= 0) {
      return { traded: false, reason: "Invalid market price" };
    }

    // Simple position sizing: edge * bankroll factor, capped at maxPositionSize
    const kellyFraction = Math.min(edgeValue / 2, 0.1); // Max 10% of edge
    const shares = Math.min(Math.floor(this.maxPositionSize * kellyFraction * 10), this.maxPositionSize);
    
    if (shares < 1) {
      return { traded: false, reason: "Calculated position too small" };
    }

    // Place the order
    console.log(`[AutoTrader] Placing order: BUY ${shares} shares of ${signal.side} at ${price}`);
    
    const result = await placeBuyOrder({
      tokenId,
      price,
      size: shares
    });

    if (result.success) {
      this.lastTradeTime = Date.now();
      this.positions.set(tokenId, {
        side: signal.side,
        shares,
        entryPrice: price,
        timestamp: Date.now()
      });

      return {
        traded: true,
        side: signal.side,
        shares,
        price,
        orderId: result.orderId
      };
    }

    return { traded: false, reason: result.error };
  }

  getStatus() {
    return {
      enabled: this.enabled,
      dailyPnL: this.dailyPnL,
      maxDailyLoss: this.maxDailyLoss,
      positions: Array.from(this.positions.entries()),
      canTrade: this.canTrade()
    };
  }
}

// Export singleton auto-trader
export const autoTrader = new AutoTrader();
