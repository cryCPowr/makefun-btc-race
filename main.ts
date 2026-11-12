// BTC race bot: selective momentum, long only, full-size, quick exits.
//
// Strategy (variant E: multi-arm, arm-specific exits, tuned dips):
// - Entry (buy 100% of cash) when ANY arm fires:
//   (a) momentum: the 10-bar close return is >= MOM_TH and the close is above
//       the 30-bar simple moving average (TREND_N);
//   (b) deep dip: the 60-bar close return is <= -DIP_DROP;
//   (c) shallow dip: the 30-bar close return is <= -SHALLOW_DROP and the close
//       is above the 360-bar simple moving average (TREND_DIP).
// - Exit (sell the whole position) when ANY of:
//   - the close falls below the highest close since entry by the arm-specific
//     trailing stop (TRAIL_MOM for momentum entries, TRAIL_DIP for dip entries),
//   - the close reaches the arm-specific take-profit above the entry close
//     (TP_MOM for momentum entries, TP_DIP for dip entries),
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

// --- strategy parameters (variant E: multi-arm, arm-specific exits, tuned dips) ---
const MOM_LB = 10; // momentum lookback, bars
const MOM_TH = 0.5; // momentum threshold, percent over MOM_LB bars
const TREND_N = 30; // trend filter: simple moving average length, bars
const DIP_LB = 60; // dip lookback, bars
const DIP_DROP = 1.2; // dip threshold, percent drop over DIP_LB bars
const SHALLOW_LB = 30; // shallow dip lookback, bars
const SHALLOW_DROP = 0.4; // shallow dip threshold, percent drop over SHALLOW_LB bars
const TREND_DIP = 360; // shallow-dip trend filter: simple moving average length, bars
const TRAIL_MOM = 0.8; // trailing stop for momentum entries, percent below the peak since entry
const TP_MOM = 1.0; // take-profit for momentum entries, percent above the entry close
const TRAIL_DIP = 0.4; // trailing stop for dip entries, percent below the peak since entry
const TP_DIP = 0.6; // take-profit for dip entries, percent above the entry close
const MAX_HOLD = 120; // max bars to hold a position
const COOLDOWN = 60; // bars to wait after a sell before the next entry
const MAX_SLIPPAGE_BPS = 100; // 1% past the close the order was decided on

const closes: number[] = []; // closes in USD, one per bar, in batch order
let entryClose = 0; // close of the bar on which the current position was entered
let peakClose = 0; // highest close since entry
let heldBars = 0; // bars held in the current position
let cooldown = 0; // bars left before the next entry is allowed
let entryArm: 'mom' | 'dip' | null = null; // which arm opened the current position, 'mom' or 'dip'

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
      entryArm = null;
      if (cooldown > 0) cooldown--;
      if (cooldown > 0 || closes.length <= Math.max(MOM_LB, TREND_N, DIP_LB, SHALLOW_LB, TREND_DIP)) return [];
      const mom = 100 * (closes[closes.length - 1]! / closes[closes.length - 1 - MOM_LB]! - 1);
      const dip = 100 * (closes[closes.length - 1]! / closes[closes.length - 1 - DIP_LB]! - 1);
      const shallow = 100 * (closes[closes.length - 1]! / closes[closes.length - 1 - SHALLOW_LB]! - 1);
      const trendOk = closes[closes.length - 1]! > sma(TREND_N);
      const trendDipOk = closes[closes.length - 1]! > sma(TREND_DIP);
      if (mom >= MOM_TH && trendOk) {
        entryArm = 'mom';
      } else if (dip <= -DIP_DROP) {
        entryArm = 'dip';
      } else if (shallow <= -SHALLOW_DROP && trendDipOk) {
        entryArm = 'dip';
      } else {
        return [];
      }
      entryClose = closes[closes.length - 1]!;
      peakClose = closes[closes.length - 1]!;
      heldBars = 0;
      const buy: BuyInput = { side: 'buy', symbol: SYMBOL, notional_quote_units: state.cash, max_slippage_bps: MAX_SLIPPAGE_BPS };
      return [buy];
    }

    // We hold a position: update the peak, then check the exits.
    heldBars++;
    if (closes[closes.length - 1]! > peakClose) peakClose = closes[closes.length - 1]!;
    const trail = entryArm === 'mom' ? TRAIL_MOM : TRAIL_DIP;
    const tp = entryArm === 'mom' ? TP_MOM : TP_DIP;
    let sell = false;
    if (closes[closes.length - 1]! <= peakClose * (1 - trail / 100)) sell = true;
    if (closes[closes.length - 1]! >= entryClose * (1 + tp / 100)) sell = true;
    if (heldBars >= MAX_HOLD) sell = true;
    if (sell) {
      cooldown = COOLDOWN;
      const order: SellInput = { side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS };
      return [order];
    }
    return [];
  },
});
