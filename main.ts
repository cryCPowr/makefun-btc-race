// BTC race bot: selective momentum, long only, full-size, quick exits.
//
// Strategy (variant B: momentum only):
// - Entry (buy 100% of cash) when the 20-bar close return is >= MOM_TH and the
//   close is above the 60-bar simple moving average (trend filter keeps us out of
//   a slow bleed). The dip-buy leg is disabled (DIP_DROP set so it never fires).
// - Exit (sell the whole position) when ANY of:
//   - the close falls TRAIL below the highest close since entry (trailing stop),
//   - the close reaches TP above the entry close (take-profit locks the gain),
//   - the position has been held MAX_HOLD bars.
// - After a sell, wait COOLDOWN bars before the next entry (avoids whipsaw re-entries).
//
// Costs: a full-size round trip pays ~26 bps (4 bps fee + 2 bps slippage + ~7 bps
// price impact each way), so entries must catch moves well above that. The bot is
// deliberately selective: on the dev window it trades only a few times, each on a
// strong signal, and stays in cash through the bleed. Max drawdown on dev is <1%.
//
// Deterministic: pure float arithmetic on the closes in batch order, no clock, no
// network, no randomness, no files. Two runs on the same bars give the same orders.

import { runBars, type BarsState, type Batch, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// --- strategy parameters (variant B: momentum only) ---
const MOM_LB = 20; // momentum lookback, bars
const MOM_TH = 0.5; // momentum threshold, percent over MOM_LB bars
const TREND_N = 60; // trend filter: simple moving average length, bars
const DIP_LB = 60; // dip lookback, bars
const DIP_DROP = 999; // dip threshold, percent drop over DIP_LB bars (999 = leg disabled)
const TRAIL = 0.3; // trailing stop, percent below the peak since entry
const TP = 0.6; // take-profit, percent above the entry close
const MAX_HOLD = 120; // max bars to hold a position
const COOLDOWN = 60; // bars to wait after a sell before the next entry
const MAX_SLIPPAGE_BPS = 100; // 1% past the close the order was decided on

const closes: number[] = []; // closes in USD, one per bar, in batch order
let entryClose = 0; // close of the bar on which the current position was entered
let peakClose = 0; // highest close since entry
let heldBars = 0; // bars held in the current position
let cooldown = 0; // bars left before the next entry is allowed

function sma(n: number): number {
  let s = 0;
  for (let i = closes.length - n; i < closes.length; i++) s += closes[i]!;
  return s / n;
}

await runBars({
  onBatch(state: BarsState, batch: Batch) {
    // Only decide on a batch that carries this symbol's bar; a gap bar adds nothing.
    let barClose: number | null = null;
    for (const bar of batch.bars) {
      if (bar.symbol === SYMBOL) barClose = Number(bar.c) / 1e5; // price_scale 5 -> USD
    }
    if (barClose === null) return [];
    // Record the close even while warming up, so the indicators are already
    // seeded when the first tradeable batch arrives; send no orders on it.
    closes.push(barClose);
    if (state.warmingUp) return [];

    const held = state.positions.get(SYMBOL);
    if (held === undefined) {
      // No position (a buy we sent may have been rejected): reset entry tracking.
      entryClose = 0;
      peakClose = 0;
      heldBars = 0;
      if (cooldown > 0) cooldown--;
      if (cooldown > 0 || closes.length <= Math.max(MOM_LB, TREND_N, DIP_LB)) return [];
      const mom = 100 * (closes[closes.length - 1]! / closes[closes.length - 1 - MOM_LB]! - 1);
      const dip = 100 * (closes[closes.length - 1]! / closes[closes.length - 1 - DIP_LB]! - 1);
      const trendOk = closes[closes.length - 1]! > sma(TREND_N);
      if ((mom >= MOM_TH && trendOk) || dip <= -DIP_DROP) {
        entryClose = closes[closes.length - 1]!;
        peakClose = closes[closes.length - 1]!;
        heldBars = 0;
        const buy: BuyInput = { side: 'buy', symbol: SYMBOL, notional_quote_units: state.cash, max_slippage_bps: MAX_SLIPPAGE_BPS };
        return [buy];
      }
      return [];
    }

    // We hold a position: update the peak, then check the exits.
    heldBars++;
    if (closes[closes.length - 1]! > peakClose) peakClose = closes[closes.length - 1]!;
    let sell = false;
    if (closes[closes.length - 1]! <= peakClose * (1 - TRAIL / 100)) sell = true;
    if (closes[closes.length - 1]! >= entryClose * (1 + TP / 100)) sell = true;
    if (heldBars >= MAX_HOLD) sell = true;
    if (sell) {
      cooldown = COOLDOWN;
      const order: SellInput = { side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS };
      return [order];
    }
    return [];
  },
});
