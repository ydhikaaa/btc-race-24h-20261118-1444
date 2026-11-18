// DipSnap v2 — a mean-reversion cbBTC/USDC trading bot for make.fun
// btc-race-24h-20261118-1444 (protocol agent-fun/bars-replay/v1).
//
// Idea: BTC on this pool mean-reverts after sharp intraday dips. The bot
// sits in cash, buys a dip only once the turn is confirmed, and sells on
// the recovery to the mean. A second, strict momentum entry covers windows
// that trend up instead of dipping. Every decision is a pure function of
// the bars seen so far: no clock, no randomness, no environment reads.
//
// Entry (flat only, at most one open position, full size):
//   DIP  — close >= 50 bps below the 60-bar EMA of closes AND the 5-bar
//          return is positive (the dip has stopped falling).
//   MOMO — 30-bar return >= 100 bps AND close above the 60-bar EMA.
// Exit (in position):
//   DIP  — close back at/above the EMA, or +90 bps, or -60 bps, or 120 bars.
//   MOMO — close back below the EMA, or +120 bps, or -60 bps, or 120 bars.
// No new buys after 1410 scored bars: a trade opened later would be
// flattened at the window's last close with no room to recover its costs.
//
// Fills land at the next bar's open, so the entry price is read back from
// the batch's fills, never assumed from the close that triggered the order.

import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch, OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// Strategy parameters (basis points unless noted).
const EMA_BARS = 60;
const DIP_BPS = 50;
const STAB_BARS = 5;
const MOMO_BARS = 30;
const MOMO_BPS = 100;
const DIP_TAKE_BPS = 90;
const MOMO_TAKE_BPS = 120;
const STOP_BPS = 60;
const MAX_HOLD_BARS = 120;
const LAST_BUY_BAR = 1410;
const BUY_SLIPPAGE_BPS = 200;
const SELL_SLIPPAGE_BPS = 500;

type Mode = 'dip' | 'momo';

interface OpenTrade {
  mode: Mode;
  entryPrice: number; // raw price units (price_scale 5), from the fill
  holdBars: number;
}

const closes: number[] = [];
let ema: number | null = null;
let scoredBars = 0;
let openTrade: OpenTrade | null = null;
let pendingBuyId: string | null = null;
let pendingBuyMode: Mode | null = null;

function bpsChange(from: number, to: number): number {
  return ((to - from) / from) * 10000;
}

await runBars({
  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    // Settle the buy decided on the previous batch from this batch's fills.
    if (pendingBuyId !== null) {
      for (const fill of batch.fills) {
        if (fill.client_id === pendingBuyId) {
          if (fill.status === 'filled' && pendingBuyMode !== null) {
            openTrade = { mode: pendingBuyMode, entryPrice: Number(fill.price), holdBars: 0 };
          }
          pendingBuyId = null;
          pendingBuyMode = null;
          break;
        }
      }
    }

    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar === undefined) return []; // symbol absent this minute: no decision
    const close = Number(bar.c);
    closes.push(close);
    if (ema === null) {
      ema = close;
    } else {
      const alpha = 2 / (EMA_BARS + 1);
      ema = alpha * close + (1 - alpha) * ema;
    }
    if (!state.warmingUp) scoredBars += 1;

    // Safety: a position the fills did not report (e.g. a restart) still
    // gets managed from the account state.
    const held = state.positions.get(SYMBOL);
    if (openTrade === null && held !== undefined && held.qty > 0n) {
      openTrade = { mode: 'dip', entryPrice: Number(state.close(SYMBOL) ?? close), holdBars: 0 };
    }
    if (openTrade !== null && (held === undefined || held.qty === 0n)) {
      openTrade = null;
    }
    if (openTrade !== null) openTrade.holdBars += 1;

    if (state.warmingUp) return [];
    if (closes.length < EMA_BARS + STAB_BARS) return [];
    if (ema === null) return [];

    // --- Exit: one position at a time, sell it all. ---
    if (openTrade !== null && held !== undefined && held.qty > 0n) {
      const gainBps = bpsChange(openTrade.entryPrice, close);
      const recovered = openTrade.mode === 'dip' ? close >= ema : close < ema;
      const takeBps = openTrade.mode === 'dip' ? DIP_TAKE_BPS : MOMO_TAKE_BPS;
      const timedOut = openTrade.holdBars >= MAX_HOLD_BARS;
      if (recovered || gainBps >= takeBps || gainBps <= -STOP_BPS || timedOut) {
        return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: SELL_SLIPPAGE_BPS }];
      }
      return [];
    }

    // --- Entry: flat only, and only with room left in the window. ---
    if (held !== undefined && held.qty > 0n) return [];
    if (pendingBuyId !== null) return [];
    if (scoredBars >= LAST_BUY_BAR) return [];

    const dipBps = bpsChange(close, ema); // positive when close is below EMA
    const stabBps = bpsChange(closes[closes.length - 1 - STAB_BARS], close);
    let mode: Mode | null = null;
    if (dipBps >= DIP_BPS && stabBps > 0) {
      mode = 'dip';
    } else if (closes.length > MOMO_BARS) {
      const momoBps = bpsChange(closes[closes.length - 1 - MOMO_BARS], close);
      if (momoBps >= MOMO_BPS && close > ema) mode = 'momo';
    }
    if (mode === null) return [];

    const room = state.weightRoom(SYMBOL);
    const notional = state.cash < room ? state.cash : room;
    if (notional <= 0n) return [];
    const clientId = state.clientId();
    pendingBuyId = clientId;
    pendingBuyMode = mode;
    return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: BUY_SLIPPAGE_BPS, client_id: clientId }];
  },
});
