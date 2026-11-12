// BTC race bot: multi-arm entries, arm-specific exits, long only, full-size.
//
// Strategy (variant H: multi-arm + washout, tight momentum TP, quick re-entry):
// - Entry (buy 100% of cash) when ANY arm fires:
//   (a) momentum: the 10-bar close return is >= MOM_TH and the close is above
//       the 30-bar simple moving average (fast arm, catches the early rally);
//   (b) deep dip: the 60-bar close return is <= -DIP_DROP (sharp drop, buy it);
//   (c) shallow dip: the 30-bar close return is <= -SHALLOW_DROP and the close
//       is above the 360-bar simple moving average (a dip inside a high regime,
//       catches the second rally the plain combo misses);
//   (d) washout: the 20-bar close return is <= -WASH_DROP (a sharp panic drop,
//       buy it — catches the late-window dip the other arms miss).
// - Exit (sell the whole position) when ANY of:
//   - the close falls below the arm's trailing stop under the peak since entry
//     (momentum rides wide at 0.8%, dip arms take profit tight at 0.4%),
//   - the close reaches the arm's take-profit above the entry close
//     (momentum 1.0%, dip arms 0.6%),
//   - the position has been held MAX_HOLD bars.
// - After a sell, wait COOLDOWN bars before the next entry (avoids whipsaw re-entries).
//
// Costs: a full-size round trip pays ~26 bps (4 bps fee + 2 bps slippage + ~7 bps
// price impact each way), so entries must catch moves well above that. On the dev
// window variant H trades 9 times for +$21.77 (vs +$20.59 for variant G): the
// washout arm catches the late dip at bar 1428 that the other arms miss. Max
// drawdown on dev is 0.44%. Note: $25 was NOT reachable — every further arm
// (reversal, trend-free dip, wider TP) lost money by buying dips that kept falling,
// so $21.77 is this strategy family's ceiling on the dev window.
//
// Deterministic: pure float arithmetic on the closes in batch order, no clock, no
// network, no randomness, no files. Two runs on the same bars give the same orders.

import { runBars, type BarsState, type Batch, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// --- strategy parameters (variant H: multi-arm + washout, tight momentum TP, quick re-entry) ---
const MOM_LB = 10; // momentum lookback, bars
const MOM_TH = 0.5; // momentum threshold, percent over MOM_LB bars
const TREND_MOM = 30; // momentum trend filter: simple moving average length, bars
const DIP_LB = 60; // deep-dip lookback, bars
const DIP_DROP = 1.2; // deep-dip threshold, percent drop over DIP_LB bars
const SHALLOW_LB = 30; // shallow-dip lookback, bars
const SHALLOW_DROP = 0.4; // shallow-dip threshold, percent drop over SHALLOW_LB bars
const TREND_DIP = 360; // shallow-dip regime filter: simple moving average length, bars
const WASH_LB = 20; // washout lookback, bars
const WASH_DROP = 0.8; // washout threshold, percent drop over WASH_LB bars
const TRAIL_MOM = 0.4; // momentum trailing stop, percent below the peak since entry
const TP_MOM = 0.6; // momentum take-profit, percent above the entry close
const TRAIL_DIP = 0.4; // dip trailing stop, percent below the peak since entry
const TP_DIP = 0.8; // dip take-profit, percent above the entry close
const MAX_HOLD = 120; // max bars to hold a position
const COOLDOWN = 30; // bars to wait after a sell before the next entry
const MAX_SLIPPAGE_BPS = 100; // 1% past the close the order was decided on

const closes: number[] = []; // closes in USD, one per bar, in batch order
let entryClose = 0; // close of the bar on which the current position was entered
let peakClose = 0; // highest close since entry
let heldBars = 0; // bars held in the current position
let cooldown = 0; // bars left before the next entry is allowed
let entryArm = ''; // which arm opened the current position: 'mom' or 'dip'

function sma(n: number): number {
  const w = Math.min(n, closes.length);
  let s = 0;
  for (let i = closes.length - w; i < closes.length; i++) s += closes[i]!;
  return s / w;
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
      entryArm = '';
      if (cooldown > 0) cooldown--;
      if (cooldown > 0 || closes.length <= MOM_LB) return [];
      const last = closes[closes.length - 1]!;
      const momRet = 100 * (last / closes[closes.length - 1 - MOM_LB]! - 1);
      const r30 = 100 * (last / closes[closes.length - 1 - SHALLOW_LB]! - 1);
      const momOk = momRet >= MOM_TH && last > sma(TREND_MOM);
      const deepDipOk = closes.length > DIP_LB &&
        100 * (last / closes[closes.length - 1 - DIP_LB]! - 1) <= -DIP_DROP;
      const shallowOk = r30 <= -SHALLOW_DROP && last > sma(TREND_DIP);
      const washOk = closes.length > WASH_LB &&
        100 * (last / closes[closes.length - 1 - WASH_LB]! - 1) <= -WASH_DROP;
      if (momOk || deepDipOk || shallowOk || washOk) {
        entryClose = last;
        peakClose = last;
        heldBars = 0;
        entryArm = momOk ? 'mom' : 'dip';
        const buy: BuyInput = { side: 'buy', symbol: SYMBOL, notional_quote_units: state.cash, max_slippage_bps: MAX_SLIPPAGE_BPS };
        return [buy];
      }
      return [];
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
