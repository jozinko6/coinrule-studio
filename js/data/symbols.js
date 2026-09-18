/**
 * symbols.js — the curated USDT spot universe.
 *
 * Two groups:
 *   MAJOR_SYMBOLS    large-cap, deep liquidity
 *   VOLATILE_SYMBOLS memecoins, high-beta alts and recent listings with wide
 *                    intrabar ranges (size positions accordingly)
 *
 * Everything is USDT-quoted spot. Binance occasionally delists or renames a
 * pair; an unknown symbol simply fails to load and the UI falls back to the
 * deterministic simulator, so the app keeps working.
 */

export const MAJOR_SYMBOLS = [
  'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'ADAUSDT', 'DOGEUSDT',
  'AVAXUSDT', 'DOTUSDT', 'LINKUSDT', 'LTCUSDT', 'TRXUSDT', 'ATOMUSDT', 'NEARUSDT',
  'APTUSDT', 'ARBUSDT', 'OPUSDT', 'SUIUSDT', 'TONUSDT', 'HBARUSDT', 'BCHUSDT',
  'ETCUSDT', 'FILUSDT', 'ICPUSDT', 'ALGOUSDT', 'VETUSDT', 'STXUSDT', 'IMXUSDT',
];

export const VOLATILE_SYMBOLS = [
  'PEPEUSDT', 'SHIBUSDT', 'WIFUSDT', 'BONKUSDT', 'FLOKIUSDT', 'DOGSUSDT',
  'PNUTUSDT', 'BOMEUSDT', 'ORDIUSDT', '1000SATSUSDT', 'RATSUSDT', 'MEMEUSDT',
  'NEIROUSDT', 'INJUSDT', 'SEIUSDT', 'TIAUSDT', 'JUPUSDT', 'PYTHUSDT', 'WLDUSDT',
  'CRVUSDT', 'LDOUSDT', 'ENSUSDT', 'FETUSDT', 'RENDERUSDT', 'PENDLEUSDT',
  'ENAUSDT', 'ETHFIUSDT', 'WUSDT', 'ZKUSDT', 'STRKUSDT', 'BLURUSDT', 'GMXUSDT',
  'DYDXUSDT', 'ARKMUSDT', 'MANTAUSDT', 'ALTUSDT', 'AEVOUSDT',
];

/** Every supported pair, majors first. */
export const POPULAR_SYMBOLS = [...new Set([...MAJOR_SYMBOLS, ...VOLATILE_SYMBOLS])];

/** Groups for the pair picker (order defines the optgroup order). */
export const SYMBOL_CATEGORIES = [
  { id: 'majors', label: 'Hlavné páry', symbols: MAJOR_SYMBOLS },
  { id: 'volatile', label: 'Volatilné páry', symbols: VOLATILE_SYMBOLS },
];

const VOLATILE_SET = new Set(VOLATILE_SYMBOLS);

export function isVolatileSymbol(symbol) {
  return VOLATILE_SET.has(String(symbol ?? '').toUpperCase());
}

/** USDT pairs that look well-formed (base may be 1 char, e.g. W, or contain digits, e.g. 1000SATS). */
export const SYMBOL_PATTERN = /^[A-Z0-9]{1,15}USDT$/;

export function isValidSymbol(symbol) {
  return SYMBOL_PATTERN.test(String(symbol ?? '').toUpperCase());
}