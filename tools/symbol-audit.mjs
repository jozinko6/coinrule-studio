/**
 * symbol-audit.mjs — check the curated universe against Binance exchangeInfo.
 *
 *   node tools/symbol-audit.mjs
 *
 * Uses only public endpoints (no keys, no orders). Exit codes:
 *   0 = every curated pair is TRADING
 *   1 = at least one pair is missing / suspended (update js/data/symbols.js)
 *   2 = the audit could not run (offline)
 */

import { MAJOR_SYMBOLS, VOLATILE_SYMBOLS } from '../js/data/symbols.js';
import { BinancePublic } from '../js/data/binance.js';

const client = new BinancePublic();

try {
  const info = await client.exchangeInfo();
  const status = new Map(info.symbols.map((s) => [s.symbol, s.status]));
  let bad = 0;

  for (const [group, list] of [['Hlavné', MAJOR_SYMBOLS], ['Volatilné', VOLATILE_SYMBOLS]]) {
    for (const symbol of list) {
      const state = status.get(symbol);
      if (state !== 'TRADING') {
        bad += 1;
        process.stdout.write(`[CHYBA] ${group}: ${symbol} -> ${state ?? 'na Binance neexistuje'}\n`);
      }
    }
  }

  const total = MAJOR_SYMBOLS.length + VOLATILE_SYMBOLS.length;
  process.stdout.write(bad === 0
    ? `Všetkých ${total} párov je TRADING.\n`
    : `${bad} pár(ov) nie je TRADING — uprav js/data/symbols.js.\n`);
  process.exit(bad === 0 ? 0 : 1);
} catch (err) {
  process.stderr.write(`Audit sa nepodarilo spustiť (sieť?): ${err.message}\n`);
  process.exit(2);
}
