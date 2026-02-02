import express from "express";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG } from "./config.js";
import { fetchKlines, fetchLastPrice } from "./data/binance.js";
import { fetchChainlinkBtcUsd } from "./data/chainlink.js";
import { startChainlinkPriceStream } from "./data/chainlinkWs.js";
import { startPolymarketChainlinkPriceStream } from "./data/polymarketLiveWs.js";
import {
  fetchMarketBySlug,
  fetchLiveEventsBySeriesId,
  flattenEventMarkets,
  pickLatestLiveMarket,
  fetchClobPrice,
  fetchOrderBook,
  summarizeOrderBook
} from "./data/polymarket.js";
import { computeSessionVwap, computeVwapSeries } from "./indicators/vwap.js";
import { computeRsi, sma, slopeLast } from "./indicators/rsi.js";
import { computeMacd } from "./indicators/macd.js";
import { computeHeikenAshi, countConsecutive } from "./indicators/heikenAshi.js";
import { detectRegime } from "./engines/regime.js";
import { scoreDirection, applyTimeAwareness } from "./engines/probability.js";
import { computeEdge, decide } from "./engines/edge.js";
import { formatNumber, formatPct, getCandleWindowTiming, sleep } from "./utils.js";
import { startBinanceTradeStream } from "./data/binanceWs.js";
import { applyGlobalProxyFromEnv } from "./net/proxy.js";
import { initTrader, isTraderReady, placeBuyOrder, getOpenOrders, cancelAllOrders, autoTrader } from "./trading/polymarketTrader.js";
import { paperTrader } from "./trading/paperTrader.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

applyGlobalProxyFromEnv();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "../public")));

// Global state
let latestData = null;
let binanceStream = null;
let polymarketLiveStream = null;
let chainlinkStream = null;

const marketCache = {
  market: null,
  fetchedAtMs: 0
};

async function resolveCurrentBtc15mMarket() {
  if (CONFIG.polymarket.marketSlug) {
    return await fetchMarketBySlug(CONFIG.polymarket.marketSlug);
  }

  if (!CONFIG.polymarket.autoSelectLatest) return null;

  const now = Date.now();
  if (marketCache.market && now - marketCache.fetchedAtMs < CONFIG.pollIntervalMs) {
    return marketCache.market;
  }

  const events = await fetchLiveEventsBySeriesId({ seriesId: CONFIG.polymarket.seriesId, limit: 25 });
  const markets = flattenEventMarkets(events);
  const picked = pickLatestLiveMarket(markets);

  marketCache.market = picked;
  marketCache.fetchedAtMs = now;
  return picked;
}

async function fetchPolymarketSnapshot() {
  const market = await resolveCurrentBtc15mMarket();

  if (!market) return { ok: false, reason: "market_not_found" };

  const outcomes = Array.isArray(market.outcomes) ? market.outcomes : (typeof market.outcomes === "string" ? JSON.parse(market.outcomes) : []);
  const outcomePrices = Array.isArray(market.outcomePrices)
    ? market.outcomePrices
    : (typeof market.outcomePrices === "string" ? JSON.parse(market.outcomePrices) : []);

  const clobTokenIds = Array.isArray(market.clobTokenIds)
    ? market.clobTokenIds
    : (typeof market.clobTokenIds === "string" ? JSON.parse(market.clobTokenIds) : []);

  let upTokenId = null;
  let downTokenId = null;
  for (let i = 0; i < outcomes.length; i += 1) {
    const label = String(outcomes[i]);
    const tokenId = clobTokenIds[i] ? String(clobTokenIds[i]) : null;
    if (!tokenId) continue;

    if (label.toLowerCase() === CONFIG.polymarket.upOutcomeLabel.toLowerCase()) upTokenId = tokenId;
    if (label.toLowerCase() === CONFIG.polymarket.downOutcomeLabel.toLowerCase()) downTokenId = tokenId;
  }

  const upIndex = outcomes.findIndex((x) => String(x).toLowerCase() === CONFIG.polymarket.upOutcomeLabel.toLowerCase());
  const downIndex = outcomes.findIndex((x) => String(x).toLowerCase() === CONFIG.polymarket.downOutcomeLabel.toLowerCase());

  const gammaYes = upIndex >= 0 ? Number(outcomePrices[upIndex]) : null;
  const gammaNo = downIndex >= 0 ? Number(outcomePrices[downIndex]) : null;

  if (!upTokenId || !downTokenId) {
    return { ok: false, reason: "missing_token_ids" };
  }

  let upBuy = null;
  let downBuy = null;
  let upBookSummary = { bestBid: null, bestAsk: null, spread: null, bidLiquidity: null, askLiquidity: null };
  let downBookSummary = { bestBid: null, bestAsk: null, spread: null, bidLiquidity: null, askLiquidity: null };

  try {
    const [yesBuy, noBuy, upBook, downBook] = await Promise.all([
      fetchClobPrice({ tokenId: upTokenId, side: "buy" }),
      fetchClobPrice({ tokenId: downTokenId, side: "buy" }),
      fetchOrderBook({ tokenId: upTokenId }),
      fetchOrderBook({ tokenId: downTokenId })
    ]);

    upBuy = yesBuy;
    downBuy = noBuy;
    upBookSummary = summarizeOrderBook(upBook);
    downBookSummary = summarizeOrderBook(downBook);
  } catch {
    upBuy = gammaYes;
    downBuy = gammaNo;
  }

  return {
    ok: true,
    market,
    tokens: { upTokenId, downTokenId },
    prices: { up: upBuy ?? gammaYes, down: downBuy ?? gammaNo },
    orderbook: { up: upBookSummary, down: downBookSummary }
  };
}

function countVwapCrosses(closes, vwapSeries, lookback) {
  if (closes.length < lookback || vwapSeries.length < lookback) return null;
  let crosses = 0;
  for (let i = closes.length - lookback + 1; i < closes.length; i += 1) {
    const prev = closes[i - 1] - vwapSeries[i - 1];
    const cur = closes[i] - vwapSeries[i];
    if (prev === 0) continue;
    if ((prev > 0 && cur < 0) || (prev < 0 && cur > 0)) crosses += 1;
  }
  return crosses;
}

let priceToBeatState = { slug: null, value: null, setAtMs: null };

async function updateData() {
  const timing = getCandleWindowTiming(CONFIG.candleWindowMinutes);

  const wsTick = binanceStream?.getLast();
  const wsPrice = wsTick?.price ?? null;

  const polymarketWsTick = polymarketLiveStream?.getLast();
  const polymarketWsPrice = polymarketWsTick?.price ?? null;

  const chainlinkWsTick = chainlinkStream?.getLast();
  const chainlinkWsPrice = chainlinkWsTick?.price ?? null;

  try {
    const chainlinkPromise = polymarketWsPrice !== null
      ? Promise.resolve({ price: polymarketWsPrice, updatedAt: polymarketWsTick?.updatedAt ?? null, source: "polymarket_ws" })
      : chainlinkWsPrice !== null
        ? Promise.resolve({ price: chainlinkWsPrice, updatedAt: chainlinkWsTick?.updatedAt ?? null, source: "chainlink_ws" })
        : fetchChainlinkBtcUsd();

    const [klines1m, klines5m, lastPrice, chainlink, poly] = await Promise.all([
      fetchKlines({ interval: "1m", limit: 240 }),
      fetchKlines({ interval: "5m", limit: 200 }),
      fetchLastPrice(),
      chainlinkPromise,
      fetchPolymarketSnapshot()
    ]);

    const settlementMs = poly.ok && poly.market?.endDate ? new Date(poly.market.endDate).getTime() : null;
    const settlementLeftMin = settlementMs ? (settlementMs - Date.now()) / 60_000 : null;
    const timeLeftMin = settlementLeftMin ?? timing.remainingMinutes;

    const candles = klines1m;
    const closes = candles.map((c) => c.close);

    const vwap = computeSessionVwap(candles);
    const vwapSeries = computeVwapSeries(candles);
    const vwapNow = vwapSeries[vwapSeries.length - 1];

    const lookback = CONFIG.vwapSlopeLookbackMinutes;
    const vwapSlope = vwapSeries.length >= lookback ? (vwapNow - vwapSeries[vwapSeries.length - lookback]) / lookback : null;
    const vwapDist = vwapNow ? (lastPrice - vwapNow) / vwapNow : null;

    const rsiNow = computeRsi(closes, CONFIG.rsiPeriod);
    const rsiSeries = [];
    for (let i = 0; i < closes.length; i += 1) {
      const sub = closes.slice(0, i + 1);
      const r = computeRsi(sub, CONFIG.rsiPeriod);
      if (r !== null) rsiSeries.push(r);
    }
    const rsiSlope = slopeLast(rsiSeries, 3);

    const macd = computeMacd(closes, CONFIG.macdFast, CONFIG.macdSlow, CONFIG.macdSignal);
    const ha = computeHeikenAshi(candles);
    const consec = countConsecutive(ha);

    const vwapCrossCount = countVwapCrosses(closes, vwapSeries, 20);
    const volumeRecent = candles.slice(-20).reduce((a, c) => a + c.volume, 0);
    const volumeAvg = candles.slice(-120).reduce((a, c) => a + c.volume, 0) / 6;

    const failedVwapReclaim = vwapNow !== null && vwapSeries.length >= 3
      ? closes[closes.length - 1] < vwapNow && closes[closes.length - 2] > vwapSeries[vwapSeries.length - 2]
      : false;

    const regimeInfo = detectRegime({
      price: lastPrice,
      vwap: vwapNow,
      vwapSlope,
      vwapCrossCount,
      volumeRecent,
      volumeAvg
    });

    const scored = scoreDirection({
      price: lastPrice,
      vwap: vwapNow,
      vwapSlope,
      rsi: rsiNow,
      rsiSlope,
      macd,
      heikenColor: consec.color,
      heikenCount: consec.count,
      failedVwapReclaim
    });

    const timeAware = applyTimeAwareness(scored.rawUp, timeLeftMin, CONFIG.candleWindowMinutes);

    const marketUp = poly.ok ? poly.prices.up : null;
    const marketDown = poly.ok ? poly.prices.down : null;
    const edge = computeEdge({ modelUp: timeAware.adjustedUp, modelDown: timeAware.adjustedDown, marketYes: marketUp, marketNo: marketDown });
    const rec = decide({ remainingMinutes: timeLeftMin, edgeUp: edge.edgeUp, edgeDown: edge.edgeDown, modelUp: timeAware.adjustedUp, modelDown: timeAware.adjustedDown });

    const spotPrice = wsPrice ?? lastPrice;
    const currentPrice = chainlink?.price ?? null;
    const marketSlug = poly.ok ? String(poly.market?.slug ?? "") : "";
    const marketStartMs = poly.ok && poly.market?.eventStartTime ? new Date(poly.market.eventStartTime).getTime() : null;

    if (marketSlug && priceToBeatState.slug !== marketSlug) {
      priceToBeatState = { slug: marketSlug, value: null, setAtMs: null };
    }

    if (priceToBeatState.slug && priceToBeatState.value === null && currentPrice !== null) {
      const nowMs = Date.now();
      const okToLatch = marketStartMs === null ? true : nowMs >= marketStartMs;
      if (okToLatch) {
        priceToBeatState = { slug: priceToBeatState.slug, value: Number(currentPrice), setAtMs: nowMs };
      }
    }

    const priceToBeat = priceToBeatState.slug === marketSlug ? priceToBeatState.value : null;

    // Determine signal
    let signal = "HOLD";
    let signalStrength = null;
    let signalSide = null;
    let signalEdge = null;

    if (rec.action === "ENTER") {
      signal = `BUY_${rec.side}`;
      signalStrength = rec.strength;
      signalSide = rec.side;
      signalEdge = rec.side === "UP" ? edge.edgeUp : edge.edgeDown;
    }

    const lastCandle = klines1m.length ? klines1m[klines1m.length - 1] : null;
    const lastClose = lastCandle?.close ?? null;
    const close1mAgo = klines1m.length >= 2 ? klines1m[klines1m.length - 2]?.close ?? null : null;
    const close3mAgo = klines1m.length >= 4 ? klines1m[klines1m.length - 4]?.close ?? null : null;
    const delta1m = lastClose !== null && close1mAgo !== null ? lastClose - close1mAgo : null;
    const delta3m = lastClose !== null && close3mAgo !== null ? lastClose - close3mAgo : null;

    const liquidity = poly.ok
      ? (Number(poly.market?.liquidityNum) || Number(poly.market?.liquidity) || null)
      : null;

    latestData = {
      timestamp: new Date().toISOString(),
      market: {
        title: poly.ok ? poly.market?.question : null,
        slug: marketSlug,
        endDate: poly.ok ? poly.market?.endDate : null,
        liquidity,
        tokens: poly.ok ? poly.tokens : null
      },
      timing: {
        timeLeftMin,
        phase: rec.phase,
        settlementMs
      },
      prices: {
        binance: spotPrice,
        chainlink: currentPrice,
        priceToBeat,
        priceDelta: currentPrice !== null && priceToBeat !== null ? currentPrice - priceToBeat : null
      },
      polymarket: {
        upPrice: marketUp,
        downPrice: marketDown,
        upPct: marketUp !== null && marketDown !== null ? (marketUp / (marketUp + marketDown)) * 100 : null,
        downPct: marketDown !== null && marketUp !== null ? (marketDown / (marketUp + marketDown)) * 100 : null
      },
      model: {
        upPct: timeAware.adjustedUp * 100,
        downPct: timeAware.adjustedDown * 100
      },
      edge: {
        up: edge.edgeUp !== null ? edge.edgeUp * 100 : null,
        down: edge.edgeDown !== null ? edge.edgeDown * 100 : null
      },
      signal: {
        action: signal,
        side: signalSide,
        strength: signalStrength,
        edge: signalEdge !== null ? signalEdge * 100 : null
      },
      indicators: {
        heikenAshi: { color: consec.color, count: consec.count },
        rsi: { value: rsiNow, slope: rsiSlope },
        macd: {
          value: macd?.macd,
          signal: macd?.signal,
          hist: macd?.hist,
          histDelta: macd?.histDelta,
          label: macd === null ? null : macd.hist > 0 ? (macd.histDelta > 0 ? "bullish (expanding)" : "bullish") : (macd.histDelta < 0 ? "bearish (expanding)" : "bearish")
        },
        vwap: { value: vwapNow, dist: vwapDist, slope: vwapSlope },
        delta: { m1: delta1m, m3: delta3m }
      },
      regime: regimeInfo.regime
    };

  } catch (err) {
    console.error("Error updating data:", err.message);
  }
}

// API endpoints
app.get("/api/data", (req, res) => {
  if (!latestData) {
    return res.status(503).json({ error: "Data not ready yet" });
  }
  res.json(latestData);
});

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Trading endpoints
app.get("/api/trader/status", (req, res) => {
  res.json({
    ready: isTraderReady(),
    autoTrader: autoTrader.getStatus()
  });
});

app.post("/api/trader/buy", async (req, res) => {
  const { side, size } = req.body;
  
  if (!latestData?.market?.tokens) {
    return res.status(400).json({ error: "Market data not available" });
  }

  const tokenId = side === "UP" ? latestData.market.tokens.upTokenId : latestData.market.tokens.downTokenId;
  const price = side === "UP" ? latestData.polymarket.upPrice : latestData.polymarket.downPrice;

  if (!tokenId || !price) {
    return res.status(400).json({ error: "Invalid market data" });
  }

  const result = await placeBuyOrder({
    tokenId,
    price,
    size: size || 10
  });

  res.json(result);
});

app.get("/api/trader/orders", async (req, res) => {
  const orders = await getOpenOrders();
  res.json({ orders });
});

app.post("/api/trader/cancel-all", async (req, res) => {
  const result = await cancelAllOrders();
  res.json(result);
});

app.post("/api/trader/auto/enable", (req, res) => {
  autoTrader.enable();
  res.json({ status: "enabled" });
});

app.post("/api/trader/auto/disable", (req, res) => {
  autoTrader.disable();
  res.json({ status: "disabled" });
});

app.post("/api/trader/auto/config", (req, res) => {
  const { maxPositionSize, minEdge, maxDailyLoss, cooldownMs } = req.body;
  
  if (maxPositionSize !== undefined) autoTrader.maxPositionSize = maxPositionSize;
  if (minEdge !== undefined) autoTrader.minEdge = minEdge;
  if (maxDailyLoss !== undefined) autoTrader.maxDailyLoss = maxDailyLoss;
  if (cooldownMs !== undefined) autoTrader.cooldownMs = cooldownMs;

  res.json({ status: "updated", config: autoTrader.getStatus() });
});

// Paper Trading endpoints
app.get("/api/paper/status", (req, res) => {
  res.json(paperTrader.getStatus());
});

app.post("/api/paper/enable", (req, res) => {
  paperTrader.enable();
  res.json({ status: "enabled", ...paperTrader.getStatus() });
});

app.post("/api/paper/disable", (req, res) => {
  paperTrader.disable();
  res.json({ status: "disabled", ...paperTrader.getStatus() });
});

app.post("/api/paper/reset", (req, res) => {
  const { startingBalance } = req.body;
  paperTrader.reset(startingBalance || 500);
  res.json({ status: "reset", ...paperTrader.getStatus() });
});

app.post("/api/paper/settle", (req, res) => {
  const { outcome } = req.body; // "UP" or "DOWN"
  if (outcome) {
    paperTrader.forceSettle(outcome);
  }
  res.json(paperTrader.getStatus());
});

// Start the data update loop
async function startDataLoop() {
  // Initialize trader if private key is provided
  await initTrader();

  binanceStream = startBinanceTradeStream({ symbol: CONFIG.symbol });
  polymarketLiveStream = startPolymarketChainlinkPriceStream({});
  chainlinkStream = startChainlinkPriceStream({});

  while (true) {
    await updateData();
    
    // Run auto-trader if enabled and data is available
    if (latestData && autoTrader.isEnabled()) {
      try {
        const tradeResult = await autoTrader.evaluateAndTrade(latestData);
        if (tradeResult.traded) {
          console.log(`[AutoTrader] Trade executed: ${tradeResult.side} ${tradeResult.shares} shares at ${tradeResult.price}`);
        }
      } catch (err) {
        console.error("[AutoTrader] Error:", err.message);
      }
    }

    // Run paper trader if enabled
    if (latestData && paperTrader.isEnabled()) {
      try {
        const tradeResult = paperTrader.evaluateAndTrade(latestData);
        if (tradeResult.traded) {
          // Logged inside paperTrader
        }
      } catch (err) {
        console.error("[PaperTrader] Error:", err.message);
      }
    }

    await sleep(CONFIG.pollIntervalMs);
  }
}

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  startDataLoop();
});
