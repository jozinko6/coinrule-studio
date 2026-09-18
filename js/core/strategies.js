/**
 * strategies.js — the template library.
 *
 * Every strategy is a plain JSON-able document that the rule engine can run.
 * Templates are intentionally explicit: the protective actions (SL/TP/trailing)
 * live inside the rules so the UI can show and edit them.
 *
 * Families: trend, mean-reversion, breakout, momentum, scalping, dca, grid,
 * martingale, risk, volatility, hybrid, portfolio.
 */

import { createRule, createStrategy, uid } from './rules.js';

/* ------------------------------------------------------------- DSL helpers */

const ind = (id, params = {}) => ({ kind: 'indicator', id, params });
const num = (value) => ({ kind: 'const', value });
const px = (field = 'close') => ({ kind: 'price', field });

const cond = (left, op, right, extra = {}) => ({
  id: uid('c'), kind: 'condition', type: 'compare',
  left, op, right, right2: 0, hold: 1, offset: 0, risingBars: 3,
  ...extra,
});

const and = (...items) => ({ id: uid('g'), kind: 'group', logic: 'AND', items });
const or = (...items) => ({ id: uid('g'), kind: 'group', logic: 'OR', items });
const not = (...items) => ({ id: uid('g'), kind: 'group', logic: 'NOT', items });

const buy = (value, sizeMode = 'percent_cash') => ({ type: 'buy', sizeMode, value });
const buyQuote = (value) => ({ type: 'buy', sizeMode: 'fixed_quote', value });
const sellAll = () => ({ type: 'sell', sizeMode: 'percent_position', value: 100 });
const sellPct = (value) => ({ type: 'sell', sizeMode: 'percent_position', value });
const closePos = () => ({ type: 'close_position' });
const stopLoss = (value) => ({ type: 'stop_loss', value });
const takeProfit = (value) => ({ type: 'take_profit', value });
const trailing = (value) => ({ type: 'trailing_stop', value });

let ruleCounter = 0;
function R(slug, name, whenNode, then, extra = {}) {
  ruleCounter += 1;
  return createRule({
    id: `${slug}-r${String(ruleCounter).padStart(3, '0')}`,
    name, when: whenNode, then, ...extra,
  });
}

function S(slug, patch) {
  return createStrategy({
    id: slug,
    timeframe: '1h',
    risk: { maxPositionPct: 100, maxOpenPositions: 1, stopLossPct: 5, takeProfitPct: 10, leverage: 1 },
    ...patch,
  });
}

/* --------------------------------------------------------------- library */

export const STRATEGY_LIBRARY = [
  /* ======================================================== TREND FOLLOWING */
  S('ema-cross', {
    name: 'EMA crossover 9/21',
    family: 'trend',
    tags: ['trend', 'ema', 'klasika'],
    riskLevel: 3,
    description: 'Klasický kríž rýchlej EMA 9 a pomalej EMA 21. Vstup pri pretnutí nahor, výstup pri pretnutí nadol, plus poistky SL/TP.',
    rules: [
      R('ema-cross', 'Vstup pri zlatej kríži', and(
        cond(ind('ema', { period: 9 }), 'crosses_above', ind('ema', { period: 21 })),
        cond(px(), 'gt', ind('ema', { period: 200 })),
      ), [buy(25), stopLoss(4), takeProfit(9), trailing(3)]),
      R('ema-cross', 'Výstup pri kríži nadol', and(
        cond(ind('ema', { period: 9 }), 'crosses_below', ind('ema', { period: 21 })),
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 60, maxOpenPositions: 1, stopLossPct: 4, takeProfitPct: 9 },
  }),

  S('golden-cross', {
    name: 'Golden cross 50/200',
    family: 'trend',
    tags: ['trend', 'sma', 'dlhodobá'],
    timeframe: '4h',
    riskLevel: 2,
    description: 'Zlomový signál SMA 50 nad SMA 200 — dlhodobý býčí režim. Vhodné pre 4h/1d grafy.',
    rules: [
      R('golden-cross', 'SMA50 pretne SMA200 nahor', and(
        cond(ind('sma', { period: 50 }), 'crosses_above', ind('sma', { period: 200 })),
        cond(ind('adx', { period: 14 }), 'gt', num(15)),
      ), [buy(50), stopLoss(8), trailing(6)]),
      R('golden-cross', 'SMA50 pretne SMA200 nadol', and(
        cond(ind('sma', { period: 50 }), 'crosses_below', ind('sma', { period: 200 })),
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 80, maxOpenPositions: 1, stopLossPct: 8, takeProfitPct: 0 },
  }),

  S('triple-ma', {
    name: 'Triple MA alignment',
    family: 'trend',
    tags: ['trend', 'sma'],
    timeframe: '4h',
    riskLevel: 2,
    description: 'Vstup, keď je cena nad SMA20 > SMA50 > SMA200 (dokonalé usporiadanie). Výstup pri strate usporiadania.',
    rules: [
      R('triple-ma', 'Dokonalé usporiadanie MA', and(
        cond(px(), 'gt', ind('sma', { period: 20 })),
        cond(ind('sma', { period: 20 }), 'gt', ind('sma', { period: 50 })),
        cond(ind('sma', { period: 50 }), 'gt', ind('sma', { period: 200 })),
      ), [buy(50), stopLoss(6), trailing(5)]),
      R('triple-ma', 'Usporiadanie sa rozpadlo', and(
        cond(ind('sma', { period: 20 }), 'crosses_below', ind('sma', { period: 50 })),
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 80, maxOpenPositions: 1 },
  }),

  S('supertrend-follow', {
    name: 'Supertrend follower',
    family: 'trend',
    tags: ['trend', 'supertrend', 'atr'],
    riskLevel: 3,
    description: 'Nákup pri prepnutí Supertrendu (ATR 10, mult 3) do býčieho režimu, výstup pri prepnutí do medvedieho.',
    rules: [
      R('supertrend-follow', 'Supertrend sa otočil nahor', and(
        cond(px(), 'gt', ind('supertrend', { period: 10, mult: 3 })),
        cond(px(), 'crosses_above', ind('supertrend', { period: 10, mult: 3 })),
      ), [buy(35), stopLoss(5), trailing(4)]),
      R('supertrend-follow', 'Supertrend sa otočil nadol', and(
        cond(px(), 'crosses_below', ind('supertrend', { period: 10, mult: 3 })),
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 70, maxOpenPositions: 1 },
  }),

  S('adx-di-trend', {
    name: 'ADX + DI trend',
    family: 'trend',
    tags: ['trend', 'adx'],
    riskLevel: 3,
    description: 'Trendový vstup len pri silnom trende (ADX > 25) a pretnutí +DI nad -DI.',
    rules: [
      R('adx-di-trend', 'Silný trend a +DI pretne -DI', and(
        cond(ind('adx', { period: 14 }), 'gt', num(25)),
        cond(ind('plus_di', { period: 14 }), 'crosses_above', ind('minus_di', { period: 14 })),
      ), [buy(30), stopLoss(4), takeProfit(12), trailing(4)]),
      R('adx-di-trend', 'Trend zoslabol', or(
        cond(ind('adx', { period: 14 }), 'lt', num(18)),
        cond(ind('plus_di', { period: 14 }), 'crosses_below', ind('minus_di', { period: 14 })),
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 60, maxOpenPositions: 1 },
  }),

  S('ichimoku-breakout', {
    name: 'Ichimoku cloud breakout',
    family: 'trend',
    tags: ['trend', 'ichimoku'],
    timeframe: '4h',
    riskLevel: 3,
    description: 'Cena nad oblakom (Senkou A/B) a Tenkan pretne Kijun nahor. Výstup pri poklese pod Kijun.',
    rules: [
      R('ichimoku-breakout', 'Tenkan/Kijun kríž nad oblakom', and(
        cond(ind('ichimoku_tenkan', { tenkan: 9, kijun: 26, senkou: 52 }), 'crosses_above', ind('ichimoku_kijun', { tenkan: 9, kijun: 26, senkou: 52 })),
        cond(px(), 'gt', ind('ichimoku_kijun', { tenkan: 9, kijun: 26, senkou: 52 })),
      ), [buy(35), stopLoss(6), takeProfit(15), trailing(5)]),
      R('ichimoku-breakout', 'Cena pod Kijun', and(
        cond(px(), 'crosses_below', ind('ichimoku_kijun', { tenkan: 9, kijun: 26, senkou: 52 })),
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 65, maxOpenPositions: 1 },
  }),

  S('psar-flip', {
    name: 'Parabolic SAR flip',
    family: 'trend',
    tags: ['trend', 'psar'],
    riskLevel: 4,
    description: 'Rýchly trendový systém — vstup pri otočení SAR pod cenu, výstup pri otočení nad cenu.',
    rules: [
      R('psar-flip', 'SAR pod cenou', and(
        cond(ind('psar', { step: 0.02, max: 0.2 }), 'lt', px()),
        cond(ind('psar', { step: 0.02, max: 0.2 }), 'crosses_below', px()),
      ), [buy(30), trailing(3)]),
      R('psar-flip', 'SAR nad cenou', and(
        cond(ind('psar', { step: 0.02, max: 0.2 }), 'crosses_above', px()),
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 60, maxOpenPositions: 1 },
  }),

  S('donchian-turtle', {
    name: 'Donchian / Turtle breakout',
    family: 'breakout',
    tags: ['breakout', 'donchian', 'turtle'],
    timeframe: '1d',
    riskLevel: 3,
    description: 'Legendárny Turtle systém: nákup pri 20-dňovom maxime, výstup pri 10-dňovom minime.',
    rules: [
      R('donchian-turtle', 'Prelomenie 20-dňového maxima', and(
        cond(px(), 'gte', ind('donchian_upper', { period: 20 })),
      ), [buy(40), stopLoss(7), trailing(6)]),
      R('donchian-turtle', 'Prelomenie 10-dňového minima', and(
        cond(px(), 'lte', ind('donchian_lower', { period: 10 })),
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 70, maxOpenPositions: 1 },
  }),

  S('macd-trend', {
    name: 'MACD trend following',
    family: 'trend',
    tags: ['trend', 'macd'],
    riskLevel: 3,
    description: 'Vstup pri pretnutí MACD línie nad signál v pozitívnom teritóriu, výstup pri opačnom kríži.',
    rules: [
      R('macd-trend', 'MACD pretne signál nahor', and(
        cond(ind('macd'), 'crosses_above', ind('macd_signal')),
        cond(ind('macd'), 'gt', num(0)),
      ), [buy(35), stopLoss(4), takeProfit(10), trailing(4)]),
      R('macd-trend', 'MACD pretne signál nadol', and(
        cond(ind('macd'), 'crosses_below', ind('macd_signal')),
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 65, maxOpenPositions: 1 },
  }),

  S('aroon-trend', {
    name: 'Aroon trend rider',
    family: 'trend',
    tags: ['trend', 'aroon'],
    riskLevel: 4,
    description: 'Aroon Up > 70 a Aroon Down < 30 indikuje čistý uptrend.',
    rules: [
      R('aroon-trend', 'Aroon Up dominuje', and(
        cond(ind('aroon_up', { period: 25 }), 'gt', num(70)),
        cond(ind('aroon_down', { period: 25 }), 'lt', num(30)),
      ), [buy(30), stopLoss(5), trailing(4)]),
      R('aroon-trend', 'Aroon Up slabne', and(
        cond(ind('aroon_up', { period: 25 }), 'lt', num(50)),
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 60, maxOpenPositions: 1 },
  }),

  S('kama-rider', {
    name: 'KAMA trend rider',
    family: 'trend',
    tags: ['trend', 'kama', 'adaptívna'],
    riskLevel: 3,
    description: 'Adaptívna KAMA filtruje šum. Vstup pri kríži ceny nad KAMA + rastúci sklon regresie.',
    rules: [
      R('kama-rider', 'Cena nad KAMA v rastovom sklone', and(
        cond(px(), 'crosses_above', ind('kama', { period: 10 })),
        cond(ind('linreg_slope', { period: 20 }), 'gt', num(0)),
      ), [buy(35), stopLoss(5), trailing(4)]),
      R('kama-rider', 'Cena pod KAMA', and(
        cond(px(), 'crosses_below', ind('kama', { period: 10 })),
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 65, maxOpenPositions: 1 },
  }),

  S('hma-momentum', {
    name: 'HMA momentum',
    family: 'trend',
    tags: ['trend', 'hma'],
    riskLevel: 4,
    description: 'Hull MA reaguje rýchlo — vhodná na zachytenie začiatku trendu s malým oneskorením.',
    rules: [
      R('hma-momentum', 'Cena pretne HMA nahor', and(
        cond(px(), 'crosses_above', ind('hma', { period: 21 })),
        cond(ind('hma', { period: 21 }), 'rising', num(0), { risingBars: 2 }),
      ), [buy(30), stopLoss(4), trailing(3)]),
      R('hma-momentum', 'Cena pretne HMA nadol', and(
        cond(px(), 'crosses_below', ind('hma', { period: 21 })),
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 60, maxOpenPositions: 1 },
  }),

  S('vortex-cross', {
    name: 'Vortex indicator cross',
    family: 'trend',
    tags: ['trend', 'vortex'],
    riskLevel: 4,
    description: 'VI+ pretne VI- → začiatok trendu; opačný kríž trend ukončuje.',
    rules: [
      R('vortex-cross', 'VI+ pretne VI-', and(
        cond(ind('vortex_plus', { period: 14 }), 'crosses_above', ind('vortex_minus', { period: 14 })),
      ), [buy(30), stopLoss(5), trailing(4)]),
      R('vortex-cross', 'VI- pretne VI+', and(
        cond(ind('vortex_minus', { period: 14 }), 'crosses_above', ind('vortex_plus', { period: 14 })),
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 60, maxOpenPositions: 1 },
  }),

  S('linreg-channel-trend', {
    name: 'Linear regression channel',
    family: 'trend',
    tags: ['trend', 'regresia', 'štatistika'],
    riskLevel: 3,
    description: 'Vstup keď je regresný sklon kladný a R² > 0,7 (spoľahlivý trend) a cena je nad regresnou hodnotou.',
    rules: [
      R('linreg-channel-trend', 'Silný kladný sklon', and(
        cond(ind('linreg_slope', { period: 30 }), 'gt', num(0)),
        cond(ind('linreg_r2', { period: 30 }), 'gt', num(0.7)),
        cond(px(), 'gt', ind('sma', { period: 50 })),
      ), [buy(40), stopLoss(5), trailing(4)]),
      R('linreg-channel-trend', 'Sklon sa obrátil', and(
        cond(ind('linreg_slope', { period: 30 }), 'lt', num(0)),
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 70, maxOpenPositions: 1 },
  }),

  S('heikin-ashi-trend', {
    name: 'Three white soldiers',
    family: 'trend',
    tags: ['trend', 'pattern', 'sviečky'],
    riskLevel: 4,
    description: 'Sviečkový pattern troch bielych vojakov v kombinácii s rastúcim objemom.',
    rules: [
      R('heikin-ashi-trend', 'Traja bieli vojaci', and(
        { id: uid('c'), kind: 'condition', type: 'pattern', pattern: 'three_white_soldiers' },
        cond(ind('volume_ratio', { period: 20 }), 'gt', num(1.2)),
      ), [buy(30), stopLoss(3), takeProfit(8), trailing(3)]),
      R('heikin-ashi-trend', 'Medvedia sviečka po vstupe', and(
        { id: uid('c'), kind: 'condition', type: 'pattern', pattern: 'bearish_engulfing' },
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 50, maxOpenPositions: 1 },
  }),

  /* ======================================================== MEAN REVERSION */
  S('rsi-oversold', {
    name: 'RSI oversold bounce',
    family: 'mean-reversion',
    tags: ['mean-reversion', 'rsi', 'klasika'],
    riskLevel: 3,
    description: 'Nákup pri RSI < 30 (prepredaný trh) a výstup pri RSI > 65. Poistka stop-loss 5 %.',
    rules: [
      R('rsi-oversold', 'RSI pod 30', and(
        cond(ind('rsi', { period: 14 }), 'lt', num(30)),
        cond(px(), 'gt', ind('sma', { period: 200 })),
      ), [buy(25), stopLoss(5), takeProfit(8)]),
      R('rsi-oversold', 'RSI nad 65', and(
        cond(ind('rsi', { period: 14 }), 'gt', num(65)),
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 50, maxOpenPositions: 1 },
  }),

  S('rsi2-aggressive', {
    name: 'RSI(2) agresívna mean reversion',
    family: 'mean-reversion',
    tags: ['mean-reversion', 'rsi', 'agresívna'],
    timeframe: '1d',
    riskLevel: 5,
    description: 'Extrémna verzia: RSI(2) < 10 na dennom grafe. Krátke držanie, výstup pri RSI(2) > 70.',
    rules: [
      R('rsi2-aggressive', 'RSI(2) extrémne prepredaný', and(
        cond(ind('rsi', { period: 2 }), 'lt', num(10)),
        cond(px(), 'gt', ind('sma', { period: 200 })),
      ), [buy(30), stopLoss(6), takeProfit(4)]),
      R('rsi2-aggressive', 'RSI(2) nad 70', and(
        cond(ind('rsi', { period: 2 }), 'gt', num(70)),
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 60, maxOpenPositions: 1 },
  }),

  S('bollinger-bounce', {
    name: 'Bollinger lower band bounce',
    family: 'mean-reversion',
    tags: ['mean-reversion', 'bollinger'],
    riskLevel: 3,
    description: 'Nákup pri dotyku dolnej Bollingerovej hrany, výstup pri návrate k strednej čiare.',
    rules: [
      R('bollinger-bounce', 'Cena pod dolnou hranou', and(
        cond(px(), 'lt', ind('boll_lower', { period: 20, mult: 2 })),
      ), [buy(25), stopLoss(5), takeProfit(6)]),
      R('bollinger-bounce', 'Návrat k strednej čiare', and(
        cond(px(), 'gte', ind('boll_middle', { period: 20, mult: 2 })),
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 50, maxOpenPositions: 1 },
  }),

  S('zscore-reversion', {
    name: 'Z-Score mean reversion',
    family: 'mean-reversion',
    tags: ['mean-reversion', 'štatistika', 'zscore'],
    riskLevel: 3,
    description: 'Štatistická odchýlka: nákup pri Z-Score < -2, výstup pri Z-Score > 0.',
    rules: [
      R('zscore-reversion', 'Z-Score pod -2', and(
        cond(ind('zscore', { period: 20 }), 'lt', num(-2)),
      ), [buy(30), stopLoss(5), takeProfit(7)]),
      R('zscore-reversion', 'Z-Score nad 0', and(
        cond(ind('zscore', { period: 20 }), 'gt', num(0)),
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 55, maxOpenPositions: 1 },
  }),

  S('stochastic-reversal', {
    name: 'Stochastic reversal',
    family: 'mean-reversion',
    tags: ['mean-reversion', 'stochastic'],
    riskLevel: 3,
    description: 'Vstup pri %K < 20 pretínajúcom %D nahor, výstup pri %K > 80.',
    rules: [
      R('stochastic-reversal', '%K pretne %D v prepredanej zóne', and(
        cond(ind('stoch_k', { k: 14, d: 3, smooth: 3 }), 'lt', num(20)),
        cond(ind('stoch_k', { k: 14, d: 3, smooth: 3 }), 'crosses_above', ind('stoch_d', { k: 14, d: 3, smooth: 3 })),
      ), [buy(30), stopLoss(4), takeProfit(6)]),
      R('stochastic-reversal', '%K nad 80', and(
        cond(ind('stoch_k', { k: 14, d: 3, smooth: 3 }), 'gt', num(80)),
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 55, maxOpenPositions: 1 },
  }),

  S('cci-reversal', {
    name: 'CCI reversal',
    family: 'mean-reversion',
    tags: ['mean-reversion', 'cci'],
    riskLevel: 4,
    description: 'CCI pod -100 znamená prepredanosť; vstup pri návrate nad -100.',
    rules: [
      R('cci-reversal', 'CCI sa vracia nad -100', and(
        cond(ind('cci', { period: 20 }), 'crosses_above', num(-100)),
      ), [buy(30), stopLoss(4), takeProfit(7)]),
      R('cci-reversal', 'CCI nad +100', and(
        cond(ind('cci', { period: 20 }), 'gt', num(100)),
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 55, maxOpenPositions: 1 },
  }),

  S('williams-reversal', {
    name: 'Williams %R reversal',
    family: 'mean-reversion',
    tags: ['mean-reversion', 'williams'],
    riskLevel: 4,
    description: 'Williams %R pod -80 → prepredané, vstup pri prechode nad -80.',
    rules: [
      R('williams-reversal', '%R nad -80', and(
        cond(ind('williams_r', { period: 14 }), 'crosses_above', num(-80)),
      ), [buy(25), stopLoss(4), takeProfit(6)]),
      R('williams-reversal', '%R nad -20', and(
        cond(ind('williams_r', { period: 14 }), 'gt', num(-20)),
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 50, maxOpenPositions: 1 },
  }),

  S('mfi-oversold', {
    name: 'MFI oversold (objemový RSI)',
    family: 'mean-reversion',
    tags: ['mean-reversion', 'mfi', 'objem'],
    riskLevel: 3,
    description: 'Money Flow Index pod 20 = kapitulácia predajcov vrátane objemu.',
    rules: [
      R('mfi-oversold', 'MFI pod 20', and(
        cond(ind('mfi', { period: 14 }), 'lt', num(20)),
      ), [buy(25), stopLoss(5), takeProfit(8)]),
      R('mfi-oversold', 'MFI nad 70', and(
        cond(ind('mfi', { period: 14 }), 'gt', num(70)),
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 50, maxOpenPositions: 1 },
  }),

  S('percent-b-reversion', {
    name: 'Bollinger %B reversion',
    family: 'mean-reversion',
    tags: ['mean-reversion', 'bollinger', '%B'],
    riskLevel: 3,
    description: 'Percent B pod 0 znamená uzavretie pod dolnou hranou — vstup, výstup pri %B > 0,8.',
    rules: [
      R('percent-b-reversion', '%B pod 0', and(
        cond(ind('boll_pb', { period: 20, mult: 2 }), 'lt', num(0)),
      ), [buy(30), stopLoss(5), takeProfit(6)]),
      R('percent-b-reversion', '%B nad 0,8', and(
        cond(ind('boll_pb', { period: 20, mult: 2 }), 'gt', num(80)),
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 55, maxOpenPositions: 1 },
  }),

  S('percentile-reversion', {
    name: 'Percentilová reverzia',
    family: 'mean-reversion',
    tags: ['mean-reversion', 'percentil'],
    riskLevel: 3,
    description: 'Cena v spodných 5 % svojho 100-sviečkového rozpätia → nákup; výstup nad 50. percentilom.',
    rules: [
      R('percentile-reversion', 'Cena v spodných 5 %', and(
        cond(ind('percent_rank', { period: 100 }), 'lt', num(5)),
      ), [buy(30), stopLoss(6), takeProfit(8)]),
      R('percentile-reversion', 'Cena nad mediánom', and(
        cond(ind('percent_rank', { period: 100 }), 'gt', num(50)),
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 55, maxOpenPositions: 1 },
  }),

  S('keltner-reversion', {
    name: 'Keltner channel reversion',
    family: 'mean-reversion',
    tags: ['mean-reversion', 'keltner', 'atr'],
    riskLevel: 3,
    description: 'Nákup pri poklese pod dolnú Keltnerovu hranu, výstup pri návrate k EMA.',
    rules: [
      R('keltner-reversion', 'Cena pod dolnou Keltner hranou', and(
        cond(px(), 'lt', ind('keltner_lower', { period: 20, mult: 2 })),
      ), [buy(30), stopLoss(5), takeProfit(6)]),
      R('keltner-reversion', 'Cena nad stredom', and(
        cond(px(), 'gt', ind('ema', { period: 20 })),
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 55, maxOpenPositions: 1 },
  }),

  S('vwap-reversion', {
    name: 'VWAP reversion (intraday)',
    family: 'mean-reversion',
    tags: ['mean-reversion', 'vwap', 'intraday'],
    timeframe: '15m',
    riskLevel: 4,
    description: 'Intradenný návrat k VWAP: nákup pri odchýlke -1,5 % pod VWAP, výstup pri návrate k VWAP.',
    rules: [
      R('vwap-reversion', 'Cena 1,5 % pod VWAP', and(
        cond(px(), 'pct_below', ind('vwap'), { value: 1.5 }),
      ), [buy(25), stopLoss(2), takeProfit(2.5)]),
      R('vwap-reversion', 'Návrat k VWAP', and(
        cond(px(), 'gte', ind('vwap')),
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 40, maxOpenPositions: 1 },
  }),

  S('bullish-divergence', {
    name: 'RSI bullish divergence',
    family: 'mean-reversion',
    tags: ['mean-reversion', 'divergencia', 'rsi'],
    riskLevel: 4,
    description: 'Cena robí nižšie dno, RSI vyššie dno → býčia divergencia (skrytá sila).',
    rules: [
      R('bullish-divergence', 'Býčia divergencia RSI', and(
        { id: uid('c'), kind: 'condition', type: 'divergence', divergenceType: 'bullish', oscillator: ind('rsi', { period: 14 }) },
      ), [buy(30), stopLoss(5), takeProfit(10), trailing(4)]),
      R('bullish-divergence', 'Medvedia divergencia', and(
        { id: uid('c'), kind: 'condition', type: 'divergence', divergenceType: 'bearish', oscillator: ind('rsi', { period: 14 }) },
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 55, maxOpenPositions: 1 },
  }),

  /* ============================================================= BREAKOUT */
  S('bollinger-squeeze', {
    name: 'Bollinger squeeze breakout',
    family: 'breakout',
    tags: ['breakout', 'bollinger', 'volatilita'],
    riskLevel: 3,
    description: 'Nízka šírka pásma (squeeze) predchádza explózii. Vstup pri prelomení hornej hrany.',
    rules: [
      R('bollinger-squeeze', 'Prelomenie hornej hrany po squeeze', and(
        cond(px(), 'crosses_above', ind('boll_upper', { period: 20, mult: 2 })),
        cond(ind('boll_bw', { period: 20, mult: 2 }), 'lt', num(4)),
        cond(ind('volume_ratio', { period: 20 }), 'gt', num(1.3)),
      ), [buy(35), stopLoss(4), takeProfit(12), trailing(5)]),
      R('bollinger-squeeze', 'Návrat pod stred', and(
        cond(px(), 'crosses_below', ind('boll_middle', { period: 20, mult: 2 })),
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 60, maxOpenPositions: 1 },
  }),

  S('range-breakout', {
    name: 'Range breakout (N-sviečkové maximum)',
    family: 'breakout',
    tags: ['breakout', 'range'],
    riskLevel: 3,
    description: 'Prelomenie najvyššej ceny za posledných 50 sviečok s potvrdením objemu.',
    rules: [
      R('range-breakout', 'Prelomenie 50-sviečkového maxima', and(
        cond(px(), 'gte', ind('highest', { period: 50 })),
        cond(ind('volume_ratio', { period: 20 }), 'gt', num(1.5)),
      ), [buy(35), stopLoss(4), takeProfit(10), trailing(4)]),
      R('range-breakout', 'Návrat pod 20-sviečkové minimum', and(
        cond(px(), 'lte', ind('lowest', { period: 20 })),
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 60, maxOpenPositions: 1 },
  }),

  S('volatility-breakout', {
    name: 'Volatility expansion breakout',
    family: 'breakout',
    tags: ['breakout', 'atr', 'volatilita'],
    riskLevel: 4,
    description: 'Vstup keď sa ATR rozšíri nad svoj priemer a cena rastie — zachytáva začiatok volatility.',
    rules: [
      R('volatility-breakout', 'ATR sa rozširuje + cena rastie', and(
        cond(ind('atr', { period: 14 }), 'gt', ind('sma', { period: 50 })),
        cond(px(), 'gt', ind('ema', { period: 9 })),
        cond(ind('change_pct', { bars: 3 }), 'gt', num(1)),
      ), [buy(30), stopLoss(4), takeProfit(9), trailing(4)]),
      R('volatility-breakout', 'Cena pod EMA9', and(
        cond(px(), 'crosses_below', ind('ema', { period: 9 })),
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 55, maxOpenPositions: 1 },
  }),

  S('volume-spike-breakout', {
    name: 'Volume spike breakout',
    family: 'breakout',
    tags: ['breakout', 'objem'],
    riskLevel: 4,
    description: 'Objem 3× nad priemerom + kladná zmena ceny = inštitucionálny vstup.',
    rules: [
      R('volume-spike-breakout', 'Objemová explózia', and(
        cond(ind('volume_ratio', { period: 20 }), 'gt', num(3)),
        cond(ind('change_pct', { bars: 1 }), 'gt', num(1.5)),
      ), [buy(25), stopLoss(3), takeProfit(8), trailing(3)]),
      R('volume-spike-breakout', 'Oslabnutie', and(
        cond(ind('change_pct', { bars: 1 }), 'lt', num(-2)),
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 45, maxOpenPositions: 1 },
  }),

  S('ath-breakout', {
    name: 'Near all-time-high breakout',
    family: 'breakout',
    tags: ['breakout', 'ath', 'momentum'],
    timeframe: '1d',
    riskLevel: 4,
    description: 'Cena v horných 2 % svojho ročného rozpätia a rastie — trendové pokračovanie.',
    rules: [
      R('ath-breakout', 'Cena pri ročnom maxime', and(
        cond(ind('percent_rank', { period: 365 }), 'gt', num(98)),
        cond(px(), 'gt', ind('sma', { period: 50 })),
      ), [buy(35), stopLoss(8), trailing(7)]),
      R('ath-breakout', 'Cena pod SMA50', and(
        cond(px(), 'crosses_below', ind('sma', { period: 50 })),
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 65, maxOpenPositions: 1 },
  }),

  S('donchian-adx-breakout', {
    name: 'Donchian breakout + ADX filter',
    family: 'breakout',
    tags: ['breakout', 'donchian', 'adx'],
    timeframe: '4h',
    riskLevel: 3,
    description: 'Ako Turtle, ale vstup len keď ADX > 20 — vyhýba sa falošným prelomeniam v range.',
    rules: [
      R('donchian-adx-breakout', 'Prelomenie s trendom', and(
        cond(px(), 'gte', ind('donchian_upper', { period: 30 })),
        cond(ind('adx', { period: 14 }), 'gt', num(20)),
      ), [buy(40), stopLoss(6), trailing(5)]),
      R('donchian-adx-breakout', 'Prelomenie nadol', and(
        cond(px(), 'lte', ind('donchian_lower', { period: 15 })),
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 70, maxOpenPositions: 1 },
  }),

  S('opening-range-breakout', {
    name: 'Opening range breakout (intraday)',
    family: 'breakout',
    tags: ['breakout', 'intraday', 'čas'],
    timeframe: '15m',
    riskLevel: 5,
    description: 'Prelomenie denného maxima počas aktívnych hodín (08:00–20:00 UTC) s objemovým potvrdením.',
    rules: [
      R('opening-range-breakout', 'Prelomenie počas aktívnych hodín', and(
        { id: uid('c'), kind: 'condition', type: 'time', hours: [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20] },
        cond(px(), 'gte', ind('highest', { period: 96 })),
        cond(ind('volume_ratio', { period: 20 }), 'gt', num(1.5)),
      ), [buy(25), stopLoss(1.5), takeProfit(3)]),
      R('opening-range-breakout', 'Koniec dňa — zavri', or(
        cond(ind('change_pct', { bars: 1 }), 'lt', num(-1.5)),
        { id: uid('c'), kind: 'condition', type: 'time', hours: [21, 22, 23] },
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 35, maxOpenPositions: 1 },
  }),

  /* ============================================================ MOMENTUM */
  S('roc-momentum', {
    name: 'ROC momentum',
    family: 'momentum',
    tags: ['momentum', 'roc'],
    riskLevel: 4,
    description: 'Kladná 10-sviečková zmena nad 3 % a zrýchľujúca sa — čistý momentum vstup.',
    rules: [
      R('roc-momentum', 'Silný pozitívny momentum', and(
        cond(ind('roc', { period: 10 }), 'gt', num(3)),
        cond(ind('roc', { period: 10 }), 'rising', num(0), { risingBars: 2 }),
      ), [buy(30), stopLoss(4), takeProfit(9), trailing(4)]),
      R('roc-momentum', 'Momentum zhasol', and(
        cond(ind('roc', { period: 10 }), 'lt', num(0)),
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 55, maxOpenPositions: 1 },
  }),

  S('macd-histogram-momentum', {
    name: 'MACD histogram momentum',
    family: 'momentum',
    tags: ['momentum', 'macd'],
    riskLevel: 4,
    description: 'Histogram rastie 3 sviečky v rade a je kladný — zrýchľujúci sa trend.',
    rules: [
      R('macd-histogram-momentum', 'Histogram zrýchľuje', and(
        cond(ind('macd_hist'), 'gt', num(0)),
        cond(ind('macd_hist'), 'rising', num(0), { risingBars: 3 }),
      ), [buy(30), stopLoss(4), takeProfit(9), trailing(4)]),
      R('macd-histogram-momentum', 'Histogram klesá pod nulu', and(
        cond(ind('macd_hist'), 'lt', num(0)),
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 55, maxOpenPositions: 1 },
  }),

  S('dual-momentum', {
    name: 'Dual momentum (absolútny + relatívny)',
    family: 'momentum',
    tags: ['momentum', 'trend', 'filtr'],
    timeframe: '1d',
    riskLevel: 3,
    description: 'Vstup len ak je cena nad SMA200 (absolútny momentum) a ROC(90) > 0 (relatívny).',
    rules: [
      R('dual-momentum', 'Absolútny aj relatívny momentum kladný', and(
        cond(px(), 'gt', ind('sma', { period: 200 })),
        cond(ind('roc', { period: 90 }), 'gt', num(0)),
      ), [buy(60), stopLoss(10), trailing(8)]),
      R('dual-momentum', 'Strata absolútneho momenta', and(
        cond(px(), 'crosses_below', ind('sma', { period: 200 })),
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 80, maxOpenPositions: 1 },
  }),

  S('trix-momentum', {
    name: 'TRIX momentum',
    family: 'momentum',
    tags: ['momentum', 'trix'],
    riskLevel: 4,
    description: 'TRIX pretne nulu nahor — potvrdenie strednodobého trendu bez šumu.',
    rules: [
      R('trix-momentum', 'TRIX nad nulou', and(
        cond(ind('trix', { period: 15 }), 'crosses_above', num(0)),
      ), [buy(30), stopLoss(5), trailing(4)]),
      R('trix-momentum', 'TRIX pod nulou', and(
        cond(ind('trix', { period: 15 }), 'crosses_below', num(0)),
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 55, maxOpenPositions: 1 },
  }),

  S('kst-momentum', {
    name: 'KST momentum',
    family: 'momentum',
    tags: ['momentum', 'kst'],
    riskLevel: 4,
    description: 'Know Sure Thing pretne signálnu líniu nahor — kombinácia 4 časových rámcov.',
    rules: [
      R('kst-momentum', 'KST pretne signál', and(
        cond(ind('kst'), 'crosses_above', ind('kst_signal')),
      ), [buy(30), stopLoss(5), trailing(4)]),
      R('kst-momentum', 'KST pretne signál nadol', and(
        cond(ind('kst'), 'crosses_below', ind('kst_signal')),
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 55, maxOpenPositions: 1 },
  }),

  S('mfi-momentum', {
    name: 'Money flow momentum',
    family: 'momentum',
    tags: ['momentum', 'mfi', 'objem'],
    riskLevel: 4,
    description: 'MFI nad 60 a rastúci CMF = príliv peňazí do aktíva.',
    rules: [
      R('mfi-momentum', 'Príliv kapitálu', and(
        cond(ind('mfi', { period: 14 }), 'gt', num(60)),
        cond(ind('cmf', { period: 20 }), 'gt', num(0.05)),
      ), [buy(30), stopLoss(4), takeProfit(8), trailing(4)]),
      R('mfi-momentum', 'Odliv kapitálu', and(
        cond(ind('mfi', { period: 14 }), 'lt', num(40)),
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 55, maxOpenPositions: 1 },
  }),

  /* =========================================================== SCALPING */
  S('scalp-ema-rsi', {
    name: 'Scalp EMA9/21 + RSI filter',
    family: 'scalping',
    tags: ['scalping', 'ema', 'rsi'],
    timeframe: '5m',
    riskLevel: 5,
    description: 'Rýchly scalping na 5m: EMA9 > EMA21, RSI 50–70, rýchly TP 1,5 %.',
    rules: [
      R('scalp-ema-rsi', 'Mikro-trend nahor', and(
        cond(ind('ema', { period: 9 }), 'gt', ind('ema', { period: 21 })),
        cond(ind('rsi', { period: 14 }), 'between', num(50), { right2: 70 }),
        cond(ind('volume_ratio', { period: 20 }), 'gt', num(1.1)),
      ), [buy(20), stopLoss(0.8), takeProfit(1.5)]),
      R('scalp-ema-rsi', 'Mikro-trend sa zlomil', or(
        cond(ind('ema', { period: 9 }), 'crosses_below', ind('ema', { period: 21 })),
        cond(ind('rsi', { period: 14 }), 'gt', num(78)),
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 30, maxOpenPositions: 1 },
  }),

  S('scalp-momentum-burst', {
    name: 'Scalp momentum burst',
    family: 'scalping',
    tags: ['scalping', 'momentum', 'breakout'],
    timeframe: '5m',
    riskLevel: 5,
    description: 'Zachytí prudký pohyb: +1 % za 3 sviečky s vysokým objemom.',
    rules: [
      R('scalp-momentum-burst', 'Prudký pohyb nahor', and(
        cond(ind('change_pct', { bars: 3 }), 'gt', num(1)),
        cond(ind('volume_ratio', { period: 20 }), 'gt', num(1.8)),
      ), [buy(20), stopLoss(1), takeProfit(2), trailing(1)]),
      R('scalp-momentum-burst', 'Pohyb sa vyčerpal', and(
        cond(ind('change_pct', { bars: 2 }), 'lt', num(-0.5)),
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 25, maxOpenPositions: 1 },
  }),

  S('scalp-vwap-bounce', {
    name: 'Scalp VWAP bounce',
    family: 'scalping',
    tags: ['scalping', 'vwap'],
    timeframe: '5m',
    riskLevel: 5,
    description: 'Cena sa odrazí od VWAP nahor počas uptrendu (nad EMA200 na 5m).',
    rules: [
      R('scalp-vwap-bounce', 'Odraz od VWAP', and(
        cond(px(), 'crosses_above', ind('vwap')),
        cond(px(), 'gt', ind('ema', { period: 200 })),
      ), [buy(20), stopLoss(0.7), takeProfit(1.4)]),
      R('scalp-vwap-bounce', 'Strata VWAP', and(
        cond(px(), 'crosses_below', ind('vwap')),
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 25, maxOpenPositions: 1 },
  }),

  S('scalp-stoch-rsi', {
    name: 'Scalp Stoch RSI',
    family: 'scalping',
    tags: ['scalping', 'stochrsi'],
    timeframe: '15m',
    riskLevel: 5,
    description: 'Stoch RSI %K pretne %D z prepredanej zóny pod 20.',
    rules: [
      R('scalp-stoch-rsi', 'Stoch RSI sa otáča', and(
        cond(ind('stoch_rsi_k', { rsi: 14, stoch: 14, k: 3, d: 3 }), 'lt', num(20)),
        cond(ind('stoch_rsi_k', { rsi: 14, stoch: 14, k: 3, d: 3 }), 'crosses_above', ind('stoch_rsi_d', { rsi: 14, stoch: 14, k: 3, d: 3 })),
      ), [buy(20), stopLoss(1), takeProfit(2)]),
      R('scalp-stoch-rsi', 'Stoch RSI nad 80', and(
        cond(ind('stoch_rsi_k', { rsi: 14, stoch: 14, k: 3, d: 3 }), 'gt', num(80)),
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 25, maxOpenPositions: 1 },
  }),

  /* ================================================================= DCA */
  S('dca-weekly', {
    name: 'DCA — pravidelný nákup (týždenne)',
    family: 'dca',
    tags: ['dca', 'akumulácia', 'pasívna'],
    timeframe: '1h',
    riskLevel: 1,
    description: 'Nakupuj 50 USDT každých 168 hodín (7 dní) bez ohľadu na cenu. Nikdy nepredáva.',
    accumulation: true,
    rules: [
      R('dca-weekly', 'Týždenný nákup', and(
        { id: uid('c'), kind: 'condition', type: 'always' },
        cond(px(), 'gt', num(0)),
      ), [buyQuote(50), { type: 'log', message: 'DCA nákup vykonaný' }], { cooldownBars: 168, maxTriggers: 0 }),
    ],
    allowPyramiding: true,
    risk: { maxPositionPct: 100, maxOpenPositions: 1 },
  }),

  S('dca-daily', {
    name: 'DCA — denný nákup',
    family: 'dca',
    tags: ['dca', 'akumulácia'],
    timeframe: '1h',
    riskLevel: 1,
    description: 'Nakupuj 25 USDT každých 24 hodín. Jednoduchá akumulačná stratégia bez predaja.',
    accumulation: true,
    rules: [
      R('dca-daily', 'Denný nákup', and(
        { id: uid('c'), kind: 'condition', type: 'always' },
        cond(px(), 'gt', num(0)),
      ), [buyQuote(25)], { cooldownBars: 24 }),
    ],
    allowPyramiding: true,
    risk: { maxPositionPct: 100, maxOpenPositions: 1 },
  }),

  S('dca-dip-boost', {
    name: 'DCA + zosilnenie pri poklese',
    family: 'dca',
    tags: ['dca', 'dip', 'akumulácia'],
    timeframe: '1h',
    riskLevel: 2,
    description: 'Základný týždenný DCA + extra nákup, keď cena klesne o 7 % za 24 hodín.',
    accumulation: true,
    rules: [
      R('dca-dip-boost', 'Týždenný základ', and(
        { id: uid('c'), kind: 'condition', type: 'always' },
      ), [buyQuote(50)], { cooldownBars: 168 }),
      R('dca-dip-boost', 'Zosilnenie pri poklese -7 %', and(
        cond(ind('change_pct', { bars: 24 }), 'lt', num(-7)),
      ), [buyQuote(100)], { cooldownBars: 24 }),
    ],
    allowPyramiding: true,
    risk: { maxPositionPct: 100, maxOpenPositions: 1 },
  }),

  S('dip-buyer', {
    name: 'Dip buyer (nákup poklesov)',
    family: 'dca',
    tags: ['dip', 'mean-reversion'],
    riskLevel: 3,
    description: 'Nákup pri poklese -5 % za 6 sviečok a RSI < 35, výstup pri +6 %.',
    rules: [
      R('dip-buyer', 'Pokles a prepredanosť', and(
        cond(ind('change_pct', { bars: 6 }), 'lt', num(-5)),
        cond(ind('rsi', { period: 14 }), 'lt', num(35)),
      ), [buy(25), stopLoss(6), takeProfit(6)]),
      R('dip-buyer', 'Cieľ dosiahnutý', and(
        cond(ind('change_pct', { bars: 12 }), 'gt', num(6)),
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 50, maxOpenPositions: 1 },
  }),

  S('buy-the-fear', {
    name: 'Buy the fear (kapitulácia)',
    family: 'dca',
    tags: ['dip', 'kontrariánska', 'rsi'],
    timeframe: '4h',
    riskLevel: 4,
    description: 'Kontrariánsky vstup pri RSI < 20 a poklese -12 % za 3 dni. Postupný výstup na 50 % a 100 %.',
    rules: [
      R('buy-the-fear', 'Kapitulačný pokles', and(
        cond(ind('rsi', { period: 14 }), 'lt', num(20)),
        cond(ind('change_pct', { bars: 18 }), 'lt', num(-12)),
      ), [buy(35), stopLoss(8), takeProfit(25)]),
      R('buy-the-fear', 'Prvý cieľ +12 %', and(
        { id: uid('c'), kind: 'condition', type: 'position', state: 'profit_pct', value: 12 },
      ), [sellPct(50)]),
      R('buy-the-fear', 'Druhý cieľ +25 %', and(
        { id: uid('c'), kind: 'condition', type: 'position', state: 'profit_pct', value: 25 },
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 60, maxOpenPositions: 1 },
  }),

  S('value-averaging', {
    name: 'Value averaging',
    family: 'dca',
    tags: ['dca', 'value-averaging'],
    timeframe: '1d',
    riskLevel: 2,
    description: 'Cieľový rast portfólia o 100 USDT denne: dokupuj menej, keď cena rastie, viac keď klesá.',
    rules: [
      R('value-averaging', 'Dokúpenie podľa cieľa', and(
        { id: uid('c'), kind: 'condition', type: 'always' },
      ), [buyQuote(100)], { cooldownBars: 24 }),
      R('value-averaging', 'Realizácia zisku nad cieľom', and(
        { id: uid('c'), kind: 'condition', type: 'position', state: 'profit_pct', value: 15 },
      ), [sellPct(20)]),
    ],
    allowPyramiding: true,
    risk: { maxPositionPct: 100, maxOpenPositions: 1 },
  }),

  S('support-accumulation', {
    name: 'Accumulation at support',
    family: 'dca',
    tags: ['support', 'akumulácia'],
    timeframe: '4h',
    riskLevel: 3,
    description: 'Dokupuj pri teste supportu (percentil 10) a rastúcom objeme.',
    rules: [
      R('support-accumulation', 'Test supportu', and(
        cond(ind('percent_rank', { period: 120 }), 'lt', num(10)),
        cond(ind('volume_ratio', { period: 20 }), 'gt', num(1.2)),
      ), [buy(20)], { cooldownBars: 12 }),
      R('support-accumulation', 'Odraz +10 %', and(
        { id: uid('c'), kind: 'condition', type: 'position', state: 'profit_pct', value: 10 },
      ), [sellPct(50)]),
    ],
    allowPyramiding: true,
    risk: { maxPositionPct: 80, maxOpenPositions: 1 },
  }),

  /* ================================================================ GRID */
  S('grid-basic', {
    name: 'Grid trading (symetrická mriežka)',
    family: 'grid',
    tags: ['grid', 'range'],
    timeframe: '1h',
    riskLevel: 3,
    description: 'Mriežková aproximácia: dokup pri každom poklese 2 % proti vstupu, predaj pri +2 % zisku.',
    rules: [
      R('grid-basic', 'Prvý vstup do mriežky', and(
        { id: uid('c'), kind: 'condition', type: 'position', state: 'none' },
        cond(ind('rsi', { period: 14 }), 'lt', num(45)),
      ), [buy(20)]),
      R('grid-basic', 'Dokúpenie -2 %', and(
        { id: uid('c'), kind: 'condition', type: 'position', state: 'pnl_below', value: -2 },
      ), [buy(20)], { cooldownBars: 2 }),
      R('grid-basic', 'Predaj +2 %', and(
        { id: uid('c'), kind: 'condition', type: 'position', state: 'profit_pct', value: 2 },
      ), [sellPct(50)]),
    ],
    allowPyramiding: true,
    risk: { maxPositionPct: 70, maxOpenPositions: 1 },
  }),

  S('grid-atr', {
    name: 'Grid podľa ATR (adaptívna mriežka)',
    family: 'grid',
    tags: ['grid', 'atr', 'volatilita'],
    timeframe: '1h',
    riskLevel: 4,
    description: 'Rozostup mriežky sa prispôsobuje volatilite: 1×ATR pokles = dokúpenie, +1×ATR = predaj.',
    rules: [
      R('grid-atr', 'Vstup do ATR mriežky', and(
        { id: uid('c'), kind: 'condition', type: 'position', state: 'none' },
        cond(ind('atr', { period: 14 }), 'gt', num(0)),
      ), [buy(20)]),
      R('grid-atr', 'Pokles o 1×ATR', and(
        cond(px(), 'lt', ind('chandelier', { period: 14, mult: 1 })),
      ), [buy(20)], { cooldownBars: 3 }),
      R('grid-atr', 'Rast o 1×ATR nad vstup', and(
        { id: uid('c'), kind: 'condition', type: 'position', state: 'profit_pct', value: 1.5 },
      ), [sellPct(50)]),
    ],
    allowPyramiding: true,
    risk: { maxPositionPct: 70, maxOpenPositions: 1 },
  }),

  S('range-scalper', {
    name: 'Range scalper (bočné trhy)',
    family: 'grid',
    tags: ['range', 'mean-reversion', 'adx'],
    timeframe: '1h',
    riskLevel: 4,
    description: 'Obchoduje len keď ADX < 20 (žiadny trend): nákup pri dne, predaj pri vrchu 20-sviečkového pásma.',
    rules: [
      R('range-scalper', 'Pri dne pásma bez trendu', and(
        cond(ind('adx', { period: 14 }), 'lt', num(20)),
        cond(px(), 'lte', ind('donchian_lower', { period: 20 })),
      ), [buy(20), takeProfit(2), stopLoss(3)]),
      R('range-scalper', 'Pri vrchu pásma', and(
        cond(px(), 'gte', ind('donchian_upper', { period: 20 })),
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 40, maxOpenPositions: 1 },
  }),

  S('mean-reversion-range', {
    name: 'Sideways market maker',
    family: 'grid',
    tags: ['range', 'mfi', 'mean-reversion'],
    timeframe: '30m',
    riskLevel: 4,
    description: 'Kupuje na dne pásma s podporou objemu (MFI < 25), predáva pri strede pásma.',
    rules: [
      R('mean-reversion-range', 'Dno pásma + objem', and(
        cond(ind('percent_rank', { period: 50 }), 'lt', num(15)),
        cond(ind('mfi', { period: 14 }), 'lt', num(25)),
      ), [buy(20), takeProfit(1.5), stopLoss(2.5)]),
      R('mean-reversion-range', 'Stred pásma', and(
        cond(ind('percent_rank', { period: 50 }), 'gt', num(50)),
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 40, maxOpenPositions: 1 },
  }),

  /* =========================================================== MARTINGALE */
  S('martingale-capped', {
    name: 'Martingale (s limitom krokov)',
    family: 'martingale',
    tags: ['martingale', 'dca', 'riziko'],
    riskLevel: 5,
    description: 'Po poklese -3 % dokup s dvojnásobnou veľkosťou, maximálne 4 kroky. Vysoko rizikové — používaj s malým kapitálom.',
    rules: [
      R('martingale-capped', 'Vstup', and(
        { id: uid('c'), kind: 'condition', type: 'position', state: 'none' },
      ), [buy(5)]),
      R('martingale-capped', 'Martingale krok -3 %', and(
        { id: uid('c'), kind: 'condition', type: 'position', state: 'pnl_below', value: -3 },
      ), [buy(10)], { cooldownBars: 4, maxTriggers: 4 }),
      R('martingale-capped', 'Druhý krok -6 %', and(
        { id: uid('c'), kind: 'condition', type: 'position', state: 'pnl_below', value: -6 },
      ), [buy(20)], { maxTriggers: 2 }),
      R('martingale-capped', 'Výstup +3 %', and(
        { id: uid('c'), kind: 'condition', type: 'position', state: 'profit_pct', value: 3 },
      ), [closePos()]),
      R('martingale-capped', 'Núdzový stop -15 %', and(
        { id: uid('c'), kind: 'condition', type: 'position', state: 'loss_pct', value: 15 },
      ), [closePos()]),
    ],
    allowPyramiding: true,
    risk: { maxPositionPct: 50, maxOpenPositions: 1 },
  }),

  S('averaging-down', {
    name: 'Averaging down (limitovaný)',
    family: 'martingale',
    tags: ['dca', 'averaging', 'riziko'],
    timeframe: '4h',
    riskLevel: 4,
    description: 'Postupné priemerovanie vstupnej ceny v 3 krokoch po -5 %, -10 %, -15 %.',
    rules: [
      R('averaging-down', 'Vstup', and(
        { id: uid('c'), kind: 'condition', type: 'position', state: 'none' },
        cond(px(), 'gt', ind('sma', { period: 200 })),
      ), [buy(20)]),
      R('averaging-down', 'Priemerovanie -5 %', and(
        { id: uid('c'), kind: 'condition', type: 'position', state: 'pnl_below', value: -5 },
      ), [buy(10)], { maxTriggers: 1, cooldownBars: 6 }),
      R('averaging-down', 'Priemerovanie -10 %', and(
        { id: uid('c'), kind: 'condition', type: 'position', state: 'pnl_below', value: -10 },
      ), [buy(10)], { maxTriggers: 1, cooldownBars: 6 }),
      R('averaging-down', 'Priemerovanie -15 %', and(
        { id: uid('c'), kind: 'condition', type: 'position', state: 'pnl_below', value: -15 },
      ), [buy(10)], { maxTriggers: 1, cooldownBars: 6 }),
      R('averaging-down', 'Výstup +8 %', and(
        { id: uid('c'), kind: 'condition', type: 'position', state: 'profit_pct', value: 8 },
      ), [closePos()]),
    ],
    allowPyramiding: true,
    risk: { maxPositionPct: 50, maxOpenPositions: 1 },
  }),

  /* ================================================== RISK / EXIT SYSTEMS */
  S('trailing-stop-system', {
    name: 'Trailing stop systém',
    family: 'risk',
    tags: ['risk', 'trailing', 'exit'],
    riskLevel: 2,
    description: 'Jednoduchý vstup podľa EMA a správa pozície výhradne trailing stopom 4 % — necháva zisky bežať.',
    rules: [
      R('trailing-stop-system', 'Vstup nad EMA50', and(
        cond(px(), 'crosses_above', ind('ema', { period: 50 })),
      ), [buy(50), trailing(4)]),
      R('trailing-stop-system', 'Ochranný stop pri prepade', and(
        cond(px(), 'crosses_below', ind('ema', { period: 200 })),
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 80, maxOpenPositions: 1 },
  }),

  S('tp-ladder', {
    name: 'Take-profit ladder (3 úrovne)',
    family: 'risk',
    tags: ['risk', 'take-profit', 'postupný výstup'],
    riskLevel: 2,
    description: 'Postupný výstup: 33 % na +5 %, 33 % na +10 %, zvyšok na +20 % s trailing stopom.',
    rules: [
      R('tp-ladder', 'Vstup na EMA kríži', and(
        cond(ind('ema', { period: 20 }), 'crosses_above', ind('ema', { period: 50 })),
      ), [buy(50), stopLoss(5)]),
      R('tp-ladder', 'TP1 +5 %', and(
        { id: uid('c'), kind: 'condition', type: 'position', state: 'profit_pct', value: 5 },
      ), [sellPct(33)]),
      R('tp-ladder', 'TP2 +10 %', and(
        { id: uid('c'), kind: 'condition', type: 'position', state: 'profit_pct', value: 10 },
      ), [sellPct(50)]),
      R('tp-ladder', 'TP3 +20 %', and(
        { id: uid('c'), kind: 'condition', type: 'position', state: 'profit_pct', value: 20 },
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 80, maxOpenPositions: 1 },
  }),

  S('breakeven-protect', {
    name: 'Break-even protection',
    family: 'risk',
    tags: ['risk', 'break-even', 'stop-loss'],
    riskLevel: 2,
    description: 'Po zisku +2 % posunie stop-loss na vstupnú cenu — obchod už nemôže skončiť stratou.',
    rules: [
      R('breakeven-protect', 'Vstup pri RSI < 40 v uptrende', and(
        cond(ind('rsi', { period: 14 }), 'lt', num(40)),
        cond(px(), 'gt', ind('sma', { period: 200 })),
      ), [buy(40), stopLoss(4), takeProfit(10)]),
      R('breakeven-protect', 'Posun na break-even po +2 %', and(
        { id: uid('c'), kind: 'condition', type: 'position', state: 'profit_pct', value: 2 },
      ), [{ type: 'break_even' }], { oneShot: true }),
    ],
    risk: { maxPositionPct: 70, maxOpenPositions: 1 },
  }),

  S('chandelier-exit', {
    name: 'Chandelier / ATR trailing exit',
    family: 'risk',
    tags: ['risk', 'atr', 'chandelier'],
    timeframe: '4h',
    riskLevel: 3,
    description: 'Výstup keď cena prerazí Chandelier Exit (najvyššie maximum − 3×ATR).',
    rules: [
      R('chandelier-exit', 'Vstup nad SMA50', and(
        cond(px(), 'crosses_above', ind('sma', { period: 50 })),
      ), [buy(50), stopLoss(8)]),
      R('chandelier-exit', 'Chandelier exit prerazený', and(
        cond(px(), 'crosses_below', ind('chandelier', { period: 22, mult: 3 })),
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 75, maxOpenPositions: 1 },
  }),

  S('time-based-exit', {
    name: 'Time-based exit (max 24 sviečok)',
    family: 'risk',
    tags: ['risk', 'čas'],
    timeframe: '1h',
    riskLevel: 3,
    description: 'Vstup na objemovom prelome, ale pozícia sa zavrie po 24 sviečkach ak nie je v zisku.',
    rules: [
      R('time-based-exit', 'Vstup pri objemovom prelome', and(
        cond(ind('volume_ratio', { period: 20 }), 'gt', num(2)),
        cond(ind('change_pct', { bars: 1 }), 'gt', num(0.5)),
      ), [buy(25), stopLoss(3), takeProfit(5)], { oneShot: false }),
      R('time-based-exit', 'Zatvor po 24 sviečkach v strate', and(
        { id: uid('c'), kind: 'condition', type: 'position', state: 'pnl_below', value: 0 },
      ), [closePos()], { cooldownBars: 24 }),
    ],
    risk: { maxPositionPct: 40, maxOpenPositions: 1 },
  }),

  S('drawdown-guard', {
    name: 'Drawdown guard (ochrana kapitálu)',
    family: 'risk',
    tags: ['risk', 'drawdown', 'ochrana'],
    timeframe: '1h',
    riskLevel: 2,
    description: 'Trendový vstup s tvrdou ochranou: pri poklese portfólia o 10 % sa všetko zatvorí a stratégia sa pozastaví.',
    rules: [
      R('drawdown-guard', 'Trendový vstup', and(
        cond(px(), 'gt', ind('sma', { period: 100 })),
        cond(ind('rsi', { period: 14 }), 'between', num(45), { right2: 65 }),
      ), [buy(40), stopLoss(4), trailing(3)]),
      R('drawdown-guard', 'Portfólio v drawdowne > 10 %', and(
        { id: uid('c'), kind: 'condition', type: 'position', state: 'drawdown_above', value: 10 },
      ), [closePos(), { type: 'pause' }]),
    ],
    risk: { maxPositionPct: 60, maxOpenPositions: 1, maxDrawdownPct: 15 },
  }),

  S('volatility-target', {
    name: 'Volatility-adjusted sizing',
    family: 'risk',
    tags: ['risk', 'atr', 'position-sizing'],
    riskLevel: 3,
    description: 'Rovnaké riziko na obchod: veľkosť pozície sa počíta z ATR tak, aby 2×ATR stop = 1 % kapitálu.',
    rules: [
      R('volatility-target', 'Trendový vstup s ATR sizingom', and(
        cond(px(), 'crosses_above', ind('ema', { period: 21 })),
        cond(ind('adx', { period: 14 }), 'gt', num(20)),
      ), [{ type: 'buy', sizeMode: 'atr_risk', value: 1, atrMult: 2 }, stopLoss(3), takeProfit(9)]),
      R('volatility-target', 'Výstup pri strate trendu', and(
        cond(px(), 'crosses_below', ind('ema', { period: 21 })),
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 50, maxOpenPositions: 1 },
  }),

  S('ulcer-risk-off', {
    name: 'Ulcer index risk-off',
    family: 'risk',
    tags: ['risk', 'ulcer', 'volatilita'],
    timeframe: '4h',
    riskLevel: 3,
    description: 'Vstup len keď je Ulcer Index nízky (< 5), výstup keď riziko vyskočí nad 12.',
    rules: [
      R('ulcer-risk-off', 'Nízke riziko, kladný trend', and(
        cond(ind('ulcer', { period: 14 }), 'lt', num(5)),
        cond(px(), 'gt', ind('sma', { period: 100 })),
      ), [buy(50), stopLoss(6), trailing(5)]),
      R('ulcer-risk-off', 'Riziko vyskočilo', and(
        cond(ind('ulcer', { period: 14 }), 'gt', num(12)),
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 70, maxOpenPositions: 1 },
  }),

  /* ========================================================== VOLATILITY */
  S('atr-filter-entry', {
    name: 'ATR volatility filter',
    family: 'volatility',
    tags: ['volatilita', 'atr', 'filter'],
    riskLevel: 3,
    description: 'Obchoduj len keď je volatilita v zdravom pásme (NATR 0,5–4 %). Filtruje mŕtve aj šialené trhy.',
    rules: [
      R('atr-filter-entry', 'Zdravá volatilita + rast', and(
        cond(ind('natr', { period: 14 }), 'between', num(0.5), { right2: 4 }),
        cond(ind('ema', { period: 9 }), 'gt', ind('ema', { period: 21 })),
        cond(ind('rsi', { period: 14 }), 'gt', num(50)),
      ), [buy(35), stopLoss(3), takeProfit(8), trailing(3)]),
      R('atr-filter-entry', 'Volatilita mimo pásma', or(
        cond(ind('natr', { period: 14 }), 'gt', num(6)),
        cond(ind('ema', { period: 9 }), 'crosses_below', ind('ema', { period: 21 })),
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 60, maxOpenPositions: 1 },
  }),

  S('squeeze-accumulation', {
    name: 'Squeeze accumulation',
    family: 'volatility',
    tags: ['volatilita', 'squeeze', 'akumulácia'],
    timeframe: '4h',
    riskLevel: 3,
    description: 'Akumuluj počas najnižšej volatility za 100 sviečok — pred výbuchom.',
    rules: [
      R('squeeze-accumulation', 'Extrémne nízka volatilita', and(
        cond(ind('percent_rank', { period: 100 }), 'lt', num(50)),
        cond(ind('boll_bw', { period: 20, mult: 2 }), 'lt', num(3)),
      ), [buy(15)], { cooldownBars: 12 }),
      R('squeeze-accumulation', 'Výbuch volatility', and(
        cond(ind('natr', { period: 14 }), 'gt', num(3)),
      ), [sellPct(50)]),
    ],
    allowPyramiding: true,
    risk: { maxPositionPct: 70, maxOpenPositions: 1 },
  }),

  S('bollinger-band-width-cycle', {
    name: 'Bollinger bandwidth cycle',
    family: 'volatility',
    tags: ['volatilita', 'bollinger'],
    timeframe: '4h',
    riskLevel: 4,
    description: 'Kupuj keď je šírka pásma v spodných 10 % histórie, predávaj keď sa rozšíri nad 80 %.',
    rules: [
      R('bollinger-band-width-cycle', 'Úzka šírka pásma', and(
        cond(ind('percent_rank', { period: 120 }), 'lt', num(10)),
      ), [buy(30)]),
      R('bollinger-band-width-cycle', 'Široké pásmo', and(
        cond(ind('boll_bw', { period: 20, mult: 2 }), 'gt', ind('sma', { period: 50 })),
        { id: uid('c'), kind: 'condition', type: 'position', state: 'profit_pct', value: 5 },
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 55, maxOpenPositions: 1 },
  }),

  /* =============================================================== HYBRID */
  S('trend-pullback', {
    name: 'Trend + pullback (buy the dip in uptrend)',
    family: 'hybrid',
    tags: ['hybrid', 'trend', 'pullback'],
    riskLevel: 3,
    description: 'V uptrende (nad SMA200) čaká na pullback k EMA21 a RSI < 45 — najlepší risk/reward vstup.',
    rules: [
      R('trend-pullback', 'Pullback k EMA21 v uptrende', and(
        cond(px(), 'gt', ind('sma', { period: 200 })),
        cond(px(), 'lte', ind('ema', { period: 21 })),
        cond(ind('rsi', { period: 14 }), 'lt', num(45)),
      ), [buy(40), stopLoss(4), takeProfit(12), trailing(4)]),
      R('trend-pullback', 'Trend sa zlomil', and(
        cond(px(), 'crosses_below', ind('sma', { period: 200 })),
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 70, maxOpenPositions: 1 },
  }),

  S('breakout-retest', {
    name: 'Breakout retest',
    family: 'hybrid',
    tags: ['hybrid', 'breakout', 'retest'],
    timeframe: '4h',
    riskLevel: 4,
    description: 'Po prelomení rezistencie (50-sviečkové maximum) čaká na retest a vstupuje s menším stopom.',
    rules: [
      R('breakout-retest', 'Prelomenie', and(
        cond(px(), 'gte', ind('highest', { period: 50 })),
      ), [buy(20), stopLoss(5), takeProfit(12)], { oneShot: true }),
      R('breakout-retest', 'Retest a odraz', and(
        cond(px(), 'lte', ind('ema', { period: 9 })),
        cond(px(), 'gt', ind('ema', { period: 21 })),
      ), [buy(30), stopLoss(3), trailing(4)]),
      R('breakout-retest', 'Zlyhanie prelomu', and(
        cond(px(), 'crosses_below', ind('ema', { period: 21 })),
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 60, maxOpenPositions: 1 },
  }),

  S('macd-rsi-confluence', {
    name: 'MACD + RSI confluence',
    family: 'hybrid',
    tags: ['hybrid', 'macd', 'rsi'],
    riskLevel: 3,
    description: 'Vstup len keď sa zhodujú dva indikátory: MACD kríž nahor A RSI v pásme 45–65.',
    rules: [
      R('macd-rsi-confluence', 'Zhoda MACD a RSI', and(
        cond(ind('macd'), 'crosses_above', ind('macd_signal')),
        cond(ind('rsi', { period: 14 }), 'between', num(45), { right2: 65 }),
        cond(ind('adx', { period: 14 }), 'gt', num(18)),
      ), [buy(40), stopLoss(4), takeProfit(10), trailing(4)]),
      R('macd-rsi-confluence', 'RSI prepredané', or(
        cond(ind('rsi', { period: 14 }), 'lt', num(35)),
        cond(ind('macd'), 'crosses_below', ind('macd_signal')),
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 65, maxOpenPositions: 1 },
  }),

  S('support-resistance-bounce', {
    name: 'Support bounce s objemom',
    family: 'hybrid',
    tags: ['hybrid', 'support', 'objem'],
    timeframe: '1h',
    riskLevel: 4,
    description: 'Odraz od supportu potvrdený objemom: percentil < 15, objem > 1,5× priemer, kladná sviečka.',
    rules: [
      R('support-resistance-bounce', 'Odraz od supportu', and(
        cond(ind('percent_rank', { period: 80 }), 'lt', num(15)),
        cond(ind('volume_ratio', { period: 20 }), 'gt', num(1.5)),
        cond(ind('change_pct', { bars: 1 }), 'gt', num(0.5)),
      ), [buy(30), stopLoss(3), takeProfit(7)]),
      R('support-resistance-bounce', 'Support padol', and(
        cond(ind('change_pct', { bars: 1 }), 'lt', num(-3)),
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 50, maxOpenPositions: 1 },
  }),

  S('fibonacci-pullback', {
    name: 'Fibonacci pullback (-10 %)',
    family: 'hybrid',
    tags: ['hybrid', 'fibonacci', 'pullback'],
    timeframe: '4h',
    riskLevel: 4,
    description: 'V uptrende čaká na 10 % korekciu od lokálneho maxima (približne 0,618 Fib) a vstupuje.',
    rules: [
      R('fibonacci-pullback', 'Korekcia -10 % v uptrende', and(
        cond(px(), 'gt', ind('sma', { period: 200 })),
        cond(ind('change_pct', { bars: 12 }), 'lt', num(-10)),
        cond(ind('rsi', { period: 14 }), 'lt', num(45)),
      ), [buy(35), stopLoss(5), takeProfit(15), trailing(5)]),
      R('fibonacci-pullback', 'Korekcia sa prehlbuje', and(
        cond(ind('change_pct', { bars: 12 }), 'lt', num(-22)),
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 60, maxOpenPositions: 1 },
  }),

  /* ============================================================ PORTFOLIO */
  S('rebalance-50-50', {
    name: 'Rebalancing 50/50',
    family: 'portfolio',
    tags: ['portfolio', 'rebalancing'],
    timeframe: '1d',
    riskLevel: 1,
    description: 'Udržiava 50 % kapitálu v aktíve: ak podiel klesne pod 45 %, dokúpi; ak stúpne nad 55 %, predá.',
    rules: [
      R('rebalance-50-50', 'Podiel pod 45 %', and(
        { id: uid('c'), kind: 'condition', type: 'position', state: 'none' },
      ), [buy(50)], { cooldownBars: 24 }),
      R('rebalance-50-50', 'Realizácia pri +20 %', and(
        { id: uid('c'), kind: 'condition', type: 'position', state: 'profit_pct', value: 20 },
      ), [sellPct(50)], { cooldownBars: 24 }),
    ],
    allowPyramiding: true,
    risk: { maxPositionPct: 55, maxOpenPositions: 1 },
  }),

  S('risk-on-risk-off', {
    name: 'Risk-on / Risk-off regime',
    family: 'portfolio',
    tags: ['portfolio', 'regime', 'makro'],
    timeframe: '1d',
    riskLevel: 2,
    description: 'Risk-on (nad SMA200) = plná expozícia; risk-off = 0 %. Jednoduchý režimový filter.',
    rules: [
      R('risk-on-risk-off', 'Risk-on režim', and(
        cond(px(), 'gt', ind('sma', { period: 200 })),
        cond(ind('sma', { period: 200 }), 'rising', num(0), { risingBars: 5 }),
      ), [buy(70), trailing(10)]),
      R('risk-on-risk-off', 'Risk-off režim', and(
        cond(px(), 'crosses_below', ind('sma', { period: 200 })),
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 90, maxOpenPositions: 1 },
  }),

  S('momentum-rotation', {
    name: 'Momentum rotation (single-asset)',
    family: 'portfolio',
    tags: ['portfolio', 'momentum', 'rotácia'],
    timeframe: '1d',
    riskLevel: 3,
    description: 'Drž aktívum len ak je jeho 30-dňový momentum kladný a nad priemerom — inak buď v hotovosti.',
    rules: [
      R('momentum-rotation', 'Pozitívny momentum', and(
        cond(ind('roc', { period: 30 }), 'gt', num(2)),
        cond(px(), 'gt', ind('ema', { period: 20 })),
      ), [buy(60), stopLoss(8), trailing(7)]),
      R('momentum-rotation', 'Momentum sa obrátil', and(
        cond(ind('roc', { period: 30 }), 'lt', num(0)),
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 80, maxOpenPositions: 1 },
  }),

  S('cash-preservation', {
    name: 'Cash preservation (nízke riziko)',
    family: 'portfolio',
    tags: ['portfolio', 'konzervatívna', 'ochrana'],
    timeframe: '1d',
    riskLevel: 1,
    description: 'Vstupuje len pri veľmi silnom signáli (nad SMA200 + RSI > 60 + ADX > 25) a s malou expozíciou.',
    rules: [
      R('cash-preservation', 'Veľmi silný signál', and(
        cond(px(), 'gt', ind('sma', { period: 200 })),
        cond(ind('rsi', { period: 14 }), 'gt', num(60)),
        cond(ind('adx', { period: 14 }), 'gt', num(25)),
      ), [buy(25), stopLoss(5), takeProfit(15), trailing(5)]),
      R('cash-preservation', 'Signál vyprchal', and(
        cond(ind('rsi', { period: 14 }), 'lt', num(45)),
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 30, maxOpenPositions: 1 },
  }),

  S('btc-eth-rotation', {
    name: 'Relative strength rotation (BTC/ETH)',
    family: 'portfolio',
    tags: ['portfolio', 'rotácia', 'relatívna sila'],
    timeframe: '4h',
    riskLevel: 3,
    description: 'Drž aktívum, len ak je jeho 4h výkonnosť kladná a nad SMA100 — inak buď v hotovosti a čakaj.',
    rules: [
      R('btc-eth-rotation', 'Relatívna sila kladná', and(
        cond(ind('roc', { period: 42 }), 'gt', num(1)),
        cond(px(), 'gt', ind('sma', { period: 100 })),
        cond(ind('cmf', { period: 20 }), 'gt', num(0)),
      ), [buy(50), stopLoss(6), trailing(6)]),
      R('btc-eth-rotation', 'Relatívna sila negatívna', and(
        cond(ind('roc', { period: 42 }), 'lt', num(-1)),
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 70, maxOpenPositions: 1 },
  }),

  /* ==================================================== SPECIAL / MISC */
  S('buy-and-hold', {
    name: 'Buy & hold (benchmark)',
    family: 'portfolio',
    tags: ['benchmark', 'pasívna'],
    timeframe: '1d',
    riskLevel: 1,
    description: 'Referenčná stratégia: kúp raz na začiatku a drž. Slúži na porovnanie s ostatnými.',
    accumulation: true,
    rules: [
      R('buy-and-hold', 'Kúp raz', and(
        { id: uid('c'), kind: 'condition', type: 'position', state: 'none' },
      ), [{ type: 'buy', sizeMode: 'percent_cash', value: 98 }], { oneShot: true }),
    ],
    risk: { maxPositionPct: 100, maxOpenPositions: 1 },
  }),

  S('pairs-relative', {
    name: 'Spread reversion (párový obchod)',
    family: 'hybrid',
    tags: ['párový', 'štatistika', 'zscore'],
    timeframe: '1h',
    riskLevel: 4,
    description: 'Obchoduje extrémne odchýlky od priemeru (Z-Score ±2,5) s rýchlym návratom — vhodné na korelované trhy.',
    rules: [
      R('pairs-relative', 'Extrémna negatívna odchýlka', and(
        cond(ind('zscore', { period: 50 }), 'lt', num(-2.5)),
      ), [buy(30), stopLoss(3), takeProfit(3)]),
      R('pairs-relative', 'Návrat k priemeru', and(
        cond(ind('zscore', { period: 50 }), 'gt', num(0)),
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 45, maxOpenPositions: 1 },
  }),

  S('news-spike-fade', {
    name: 'Spike fade (vyprchanie pumpu)',
    family: 'hybrid',
    tags: ['kontrariánska', 'volatilita', 'objem'],
    timeframe: '15m',
    riskLevel: 5,
    description: 'Po prudkom pumpe (+6 % za 3 sviečky) čaká na prvé oslabenie a vstupuje do korekcie (long-only: čaká na dip).',
    rules: [
      R('news-spike-fade', 'Po pumpe čaká na dip -4 %', and(
        cond(ind('change_pct', { bars: 3 }), 'lt', num(-4)),
        cond(ind('volume_ratio', { period: 20 }), 'gt', num(2)),
      ), [buy(25), stopLoss(2), takeProfit(4)]),
      R('news-spike-fade', 'Rýchly výstup', and(
        { id: uid('c'), kind: 'condition', type: 'position', state: 'profit_pct', value: 4 },
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 30, maxOpenPositions: 1 },
  }),

  S('vwap-trend-rider', {
    name: 'VWAP trend rider (intraday)',
    family: 'trend',
    tags: ['trend', 'vwap', 'intraday'],
    timeframe: '15m',
    riskLevel: 4,
    description: 'Intradenný trend: cena nad VWAP a VWAP rastie → long, výstup pri strate VWAP.',
    rules: [
      R('vwap-trend-rider', 'Nad rastúcim VWAP', and(
        cond(px(), 'gt', ind('vwap')),
        cond(ind('vwap'), 'rising', num(0), { risingBars: 3 }),
        cond(ind('rsi', { period: 14 }), 'gt', num(52)),
      ), [buy(30), stopLoss(1.5), takeProfit(4), trailing(1.5)]),
      R('vwap-trend-rider', 'Pod VWAP', and(
        cond(px(), 'crosses_below', ind('vwap')),
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 40, maxOpenPositions: 1 },
  }),

  S('adaptive-multi-filter', {
    name: 'Adaptive multi-filter (5 filtrov)',
    family: 'hybrid',
    tags: ['hybrid', 'viacfaktorová', 'pokročilá'],
    timeframe: '4h',
    riskLevel: 3,
    description: 'Vstup len pri zhode 5 filtrov: trend (SMA200), sila (ADX>20), momentum (MACD), objem (CMF>0) a volatilita.',
    rules: [
      R('adaptive-multi-filter', 'Zhoda 5 filtrov', and(
        cond(px(), 'gt', ind('sma', { period: 200 })),
        cond(ind('adx', { period: 14 }), 'gt', num(20)),
        cond(ind('macd'), 'gt', ind('macd_signal')),
        cond(ind('cmf', { period: 20 }), 'gt', num(0)),
        cond(ind('natr', { period: 14 }), 'between', num(0.4), { right2: 5 }),
      ), [buy(40), stopLoss(5), takeProfit(14), trailing(5)]),
      R('adaptive-multi-filter', 'Filter zlyhal', or(
        cond(px(), 'crosses_below', ind('sma', { period: 200 })),
        cond(ind('macd'), 'crosses_below', ind('macd_signal')),
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 70, maxOpenPositions: 1 },
  }),

  S('weekend-effect', {
    name: 'Weekend effect (časový filter)',
    family: 'hybrid',
    tags: ['čas', 'sezonalita'],
    timeframe: '1h',
    riskLevel: 4,
    description: 'Obchoduje len v pracovných dňoch (UTC), aby sa vyhol nízkolikvidným víkendom.',
    rules: [
      R('weekend-effect', 'Vstup v pracovný deň', and(
        { id: uid('c'), kind: 'condition', type: 'time', days: [1, 2, 3, 4, 5] },
        cond(px(), 'crosses_above', ind('ema', { period: 50 })),
      ), [buy(35), stopLoss(4), takeProfit(8)]),
      R('weekend-effect', 'Víkend — zavri', and(
        { id: uid('c'), kind: 'condition', type: 'time', days: [0, 6] },
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 60, maxOpenPositions: 1 },
  }),

  S('trend-reversal-catcher', {
    name: 'Trend reversal catcher',
    family: 'hybrid',
    tags: ['hybrid', 'reversal', 'divergencia'],
    timeframe: '4h',
    riskLevel: 4,
    description: 'Hľadá koniec downtrendu: RSI divergencia + prelomenie EMA50 + rastúci objem.',
    rules: [
      R('trend-reversal-catcher', 'Známky obratu', and(
        { id: uid('c'), kind: 'condition', type: 'divergence', divergenceType: 'bullish', oscillator: ind('rsi', { period: 14 }) },
        cond(px(), 'crosses_above', ind('ema', { period: 50 })),
      ), [buy(35), stopLoss(6), takeProfit(18), trailing(6)]),
      R('trend-reversal-catcher', 'Obrat zlyhal', and(
        cond(px(), 'crosses_below', ind('ema', { period: 200 })),
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 55, maxOpenPositions: 1 },
  }),


  /* ==================================================== COINRULE TEMPLATES */
  /* 42 šablón inšpirovaných verejnou knižnicou Coinrule (help.coinrule.com).
     Ide o nezávislú implementáciu rovnakých pravidiel v našom DSL; pôvodné
     anglické názvy sú uvedené v popisoch. Platforma je long-only (spot, bez
     API kľúčov), preto sú short šablóny adaptované na ochranné výstupy. */

  S('cr-ichimoku-macd-trailing', {
    name: 'Ichimoku + MACD s trailing stopom',
    family: 'coinrule',
    tags: ['coinrule', 'ichimoku', 'macd', 'trend'],
    timeframe: '4h',
    riskLevel: 3,
    description: 'Coinrule šablóna „Ichimoku Cloud With MACD And Trailing Stop Loss Bot“: vstup nad oblakom s MACD potvrdením, výstup pri zlome MACD a trailing stop 4 %.',
    rules: [
      R('cr-ichimoku-macd-trailing', 'Nad oblakom + MACD bull', and(
        cond(px(), 'gt', ind('ichimoku_kijun', { tenkan: 9, kijun: 26, senkou: 52 })),
        cond(ind('ichimoku_tenkan', { tenkan: 9, kijun: 26, senkou: 52 }), 'gt', ind('ichimoku_kijun', { tenkan: 9, kijun: 26, senkou: 52 })),
        cond(ind('macd'), 'gt', ind('macd_signal')),
      ), [buy(30), stopLoss(5), trailing(4)]),
      R('cr-ichimoku-macd-trailing', 'MACD sa zlomil nadol', and(
        cond(ind('macd'), 'crosses_below', ind('macd_signal')),
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 60, maxOpenPositions: 1, stopLossPct: 5, takeProfitPct: 0 },
  }),

  S('cr-rsi-sma-long', {
    name: 'RSI + SMA (long-only)',
    family: 'coinrule',
    tags: ['coinrule', 'rsi', 'sma', 'mean-reversion'],
    timeframe: '1h',
    riskLevel: 3,
    description: 'Coinrule šablóna „Simple RSI And SMA Long And Short Bot“ v long-only podobe: nákup pri RSI < 35 nad SMA200, výstup pri RSI > 65 alebo +8 %.',
    rules: [
      R('cr-rsi-sma-long', 'RSI pod 35 v uptrende', and(
        cond(ind('rsi', { period: 14 }), 'lt', num(35)),
        cond(px(), 'gt', ind('sma', { period: 200 })),
      ), [buy(30), stopLoss(5), takeProfit(8)]),
      R('cr-rsi-sma-long', 'RSI nad 65 — vyber zisk', and(
        cond(ind('rsi', { period: 14 }), 'gt', num(65)),
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 50, maxOpenPositions: 1, stopLossPct: 5, takeProfitPct: 8 },
  }),

  S('cr-ichimoku-adx-trailing', {
    name: 'Ichimoku + ADX s trailing stopom',
    family: 'coinrule',
    tags: ['coinrule', 'ichimoku', 'adx', 'trend'],
    timeframe: '4h',
    riskLevel: 3,
    description: 'Coinrule šablóna „Ichimoku Cloud And ADX With Trailing Stop Loss“: vstup nad oblakom len pri silnom trende (ADX > 20), výstup pod kijun-sen s trailing stopom.',
    rules: [
      R('cr-ichimoku-adx-trailing', 'Nad oblakom so silným trendom', and(
        cond(px(), 'gt', ind('ichimoku_kijun', { tenkan: 9, kijun: 26, senkou: 52 })),
        cond(ind('adx', { period: 14 }), 'gt', num(20)),
        cond(ind('plus_di', { period: 14 }), 'gt', ind('minus_di', { period: 14 })),
      ), [buy(30), stopLoss(5), trailing(4)]),
      R('cr-ichimoku-adx-trailing', 'Pod kijun-sen', and(
        cond(px(), 'crosses_below', ind('ichimoku_kijun', { tenkan: 9, kijun: 26, senkou: 52 })),
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 60, maxOpenPositions: 1, stopLossPct: 5, takeProfitPct: 0 },
  }),

  S('cr-catch-the-bottom', {
    name: 'Chytenie dna',
    family: 'coinrule',
    tags: ['coinrule', 'rsi', 'bollinger', 'reversal'],
    timeframe: '1h',
    riskLevel: 4,
    description: 'Coinrule šablóna „Catch The Bottom Strategy“: nákup pri hlbokom prepredaní (RSI < 28) a cene pod dolným Bollingerovým pásmom s objemovým potvrdením.',
    rules: [
      R('cr-catch-the-bottom', 'Hlboké prepredanie', and(
        cond(ind('rsi', { period: 14 }), 'lt', num(28)),
        cond(px(), 'lt', ind('boll_lower', { period: 20, mult: 2 })),
        cond(ind('volume_ratio', { period: 20 }), 'gt', num(1.1)),
      ), [buy(25), stopLoss(6), takeProfit(8)]),
      R('cr-catch-the-bottom', 'Odraz späť nad RSI 60', and(
        cond(ind('rsi', { period: 14 }), 'gt', num(60)),
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 40, maxOpenPositions: 1, stopLossPct: 6, takeProfitPct: 8 },
  }),

  S('cr-ema-macd-trailing', {
    name: 'EMA + MACD s trailing stopom',
    family: 'coinrule',
    tags: ['coinrule', 'ema', 'macd', 'trend'],
    timeframe: '1h',
    riskLevel: 3,
    description: 'Coinrule šablóna „EMA And MACD With Trailing Stop Loss Bot“: vstup pri pretnutí EMA9 nad EMA21 s kladným MACD histogramom, výstup pri opačnom pretnutí.',
    rules: [
      R('cr-ema-macd-trailing', 'EMA9 nad EMA21 + MACD', and(
        cond(ind('ema', { period: 9 }), 'crosses_above', ind('ema', { period: 21 })),
        cond(ind('macd_hist'), 'gt', num(0)),
      ), [buy(30), stopLoss(4), trailing(3)]),
      R('cr-ema-macd-trailing', 'EMA9 pod EMA21', and(
        cond(ind('ema', { period: 9 }), 'crosses_below', ind('ema', { period: 21 })),
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 60, maxOpenPositions: 1, stopLossPct: 4, takeProfitPct: 0 },
  }),

  S('cr-rsi-top-scalper', {
    name: 'RSI scalper na vrcholoch (long-only)',
    family: 'coinrule',
    tags: ['coinrule', 'rsi', 'scalping'],
    timeframe: '15m',
    riskLevel: 4,
    description: 'Coinrule šablóna „RSI Top Scalper Bot“ v long-only podobe: rýchly nákup prepredaného dipu v uptrende (RSI späť nad 30) s malým ziskom a tesným stopom.',
    rules: [
      R('cr-rsi-top-scalper', 'RSI sa vracia nad 30', and(
        cond(ind('rsi', { period: 14 }), 'crosses_above', num(30)),
        cond(px(), 'gt', ind('sma', { period: 200 })),
      ), [buy(25), stopLoss(2), takeProfit(3)]),
      R('cr-rsi-top-scalper', 'RSI nad 65 — rýchly výstup', and(
        cond(ind('rsi', { period: 14 }), 'gt', num(65)),
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 35, maxOpenPositions: 1, stopLossPct: 2, takeProfitPct: 3 },
  }),

  S('cr-smart-accumulation', {
    name: 'Smart akumulácia a de-risk',
    family: 'coinrule',
    tags: ['coinrule', 'dca', 'accumulation', 'risk'],
    timeframe: '1d',
    riskLevel: 2,
    description: 'Coinrule šablóna „Smart Accumulation and De-risk“: pravidelný týždenný nákup, zosilnenie pri prepredaní a postupný výber zisku pri prehriatí.',
    rules: [
      R('cr-smart-accumulation', 'Týždenná akumulácia', and(
        { id: uid('c'), kind: 'condition', type: 'always' },
        cond(ind('rsi', { period: 14 }), 'lt', num(55)),
      ), [buyQuote(75), { type: 'log', message: 'Smart akumulácia: týždenný nákup' }], { cooldownBars: 168 }),
      R('cr-smart-accumulation', 'Zosilnenie pri RSI < 30', and(
        cond(ind('rsi', { period: 14 }), 'lt', num(30)),
      ), [buyQuote(100)], { cooldownBars: 24, maxTriggers: 6 }),
      R('cr-smart-accumulation', 'De-risk pri RSI > 75', and(
        cond(ind('rsi', { period: 14 }), 'gt', num(75)),
      ), [sellPct(25)], { cooldownBars: 24 }),
    ],
    risk: { maxPositionPct: 90, maxOpenPositions: 1, stopLossPct: 0, takeProfitPct: 0 },
  }),

  S('cr-combination-scalper', {
    name: 'Kombinovaný scalper',
    family: 'coinrule',
    tags: ['coinrule', 'ema', 'volume', 'scalping'],
    timeframe: '15m',
    riskLevel: 4,
    description: 'Coinrule šablóna „The Combination Scalper“: vstup do krátkodobého dipu cez pretnutie EMA a objem, výstup cez RSI.',
    rules: [
      R('cr-combination-scalper', 'EMA pretnutie + objem', and(
        cond(ind('ema', { period: 9 }), 'crosses_above', ind('ema', { period: 21 })),
        cond(ind('volume_ratio', { period: 20 }), 'gt', num(1.5)),
      ), [buy(25), stopLoss(2), takeProfit(3)]),
      R('cr-combination-scalper', 'RSI nad 65', and(
        cond(ind('rsi', { period: 14 }), 'gt', num(65)),
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 35, maxOpenPositions: 1, stopLossPct: 2, takeProfitPct: 3 },
  }),

  S('cr-mtf-rsi-scalping', {
    name: 'Multi-timeframe RSI scalping',
    family: 'coinrule',
    tags: ['coinrule', 'rsi', 'scalping'],
    timeframe: '15m',
    riskLevel: 4,
    description: 'Coinrule šablóna „Multi Time Frame RSI Scalping“: rýchle RSI (14) vstupuje z prepredania, pomalé RSI (56 ≈ vyšší timeframe) filtruje režim.',
    rules: [
      R('cr-mtf-rsi-scalping', 'Rýchle RSI sa otáča nahor', and(
        cond(ind('rsi', { period: 14 }), 'crosses_above', num(30)),
        cond(ind('rsi', { period: 56 }), 'lt', num(50)),
        cond(px(), 'gt', ind('ema', { period: 200 })),
      ), [buy(25), stopLoss(2), takeProfit(3)]),
      R('cr-mtf-rsi-scalping', 'Rýchle RSI nad 65', and(
        cond(ind('rsi', { period: 14 }), 'gt', num(65)),
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 35, maxOpenPositions: 1, stopLossPct: 2, takeProfitPct: 3 },
  }),

  S('cr-uptrend-breakout-scalper', {
    name: 'Breakout scalper v uptrende',
    family: 'coinrule',
    tags: ['coinrule', 'breakout', 'scalping', 'volume'],
    timeframe: '15m',
    riskLevel: 4,
    description: 'Coinrule šablóna „Uptrend Breakout Scalper“: prelomenie 20-sviečkového maxima v uptrende s objemovým potvrdením a rýchlym výstupom.',
    rules: [
      R('cr-uptrend-breakout-scalper', 'Prelomenie + objem', and(
        cond(px(), 'crosses_above', ind('donchian_upper', { period: 20 })),
        cond(ind('ema', { period: 50 }), 'gt', ind('ema', { period: 200 })),
        cond(ind('volume_ratio', { period: 20 }), 'gt', num(1.5)),
      ), [buy(25), stopLoss(2.5), trailing(3)]),
      R('cr-uptrend-breakout-scalper', 'Prehriate RSI', and(
        cond(ind('rsi', { period: 14 }), 'gt', num(72)),
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 35, maxOpenPositions: 1, stopLossPct: 2.5, takeProfitPct: 0 },
  }),

  S('cr-grid-in-range', {
    name: 'Grid v obchodnom rozpätí',
    family: 'coinrule',
    tags: ['coinrule', 'grid', 'range'],
    timeframe: '1h',
    riskLevel: 3,
    description: 'Coinrule šablóna „Grid Trading In Range“: nákupy po krokoch v bočnom trhu (ADX < 20) a predaj zisku +1,5 % z každej úrovne, s tvrdým stopom.',
    rules: [
      R('cr-grid-in-range', 'Prvý vstup do mriežky', and(
        { id: uid('c'), kind: 'condition', type: 'position', state: 'none' },
        cond(ind('adx', { period: 14 }), 'lt', num(20)),
        cond(px(), 'gt', ind('donchian_lower', { period: 50 })),
        cond(px(), 'lt', ind('donchian_upper', { period: 50 })),
      ), [buy(15)]),
      R('cr-grid-in-range', 'Dokúpenie -1,5 %', and(
        { id: uid('c'), kind: 'condition', type: 'position', state: 'pnl_below', value: -1.5 },
      ), [buy(15)], { cooldownBars: 1, maxTriggers: 6 }),
      R('cr-grid-in-range', 'Predaj +1,5 %', and(
        { id: uid('c'), kind: 'condition', type: 'position', state: 'profit_pct', value: 1.5 },
      ), [sellPct(50)], { cooldownBars: 1 }),
      R('cr-grid-in-range', 'Tvrdý stop -8 %', and(
        { id: uid('c'), kind: 'condition', type: 'position', state: 'loss_pct', value: 8 },
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 60, maxOpenPositions: 1, stopLossPct: 8, takeProfitPct: 0 },
  }),

  S('cr-mtf-buy-low-sell-high', {
    name: 'Multi-timeframe buy low, sell high',
    family: 'coinrule',
    tags: ['coinrule', 'rsi', 'ema', 'mean-reversion'],
    timeframe: '15m',
    riskLevel: 3,
    description: 'Coinrule šablóna „Multi Time Frame Buy Low Sell High - Short-Term“: nákup pri slabosti RSI podpornej silou MA, výstup pri obnovení trendu.',
    rules: [
      R('cr-mtf-buy-low-sell-high', 'RSI slabosť + silná EMA9', and(
        cond(ind('rsi', { period: 14 }), 'lt', num(35)),
        cond(ind('ema', { period: 9 }), 'gt', ind('ema', { period: 200 })),
      ), [buy(30), stopLoss(3), takeProfit(4)]),
      R('cr-mtf-buy-low-sell-high', 'Cena späť nad EMA9', and(
        cond(px(), 'gt', ind('ema', { period: 9 })),
        cond(ind('ema', { period: 9 }), 'gt', ind('ema', { period: 50 })),
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 40, maxOpenPositions: 1, stopLossPct: 3, takeProfitPct: 4 },
  }),

  S('cr-rsi-dca', {
    name: 'DCA podľa RSI',
    family: 'coinrule',
    tags: ['coinrule', 'dca', 'rsi', 'accumulation'],
    timeframe: '1d',
    riskLevel: 2,
    description: 'Coinrule šablóna „RSI-Based Dollar Cost Averaging“: pravidelný nákup a jeho zosilnenie pri prepredaní, s čiastočným výberom zisku.',
    rules: [
      R('cr-rsi-dca', 'Pravidelný nákup', and(
        { id: uid('c'), kind: 'condition', type: 'always' },
        cond(px(), 'gt', num(0)),
      ), [{ type: 'dca', sizeMode: 'fixed_quote', value: 75 }], { cooldownBars: 168 }),
      R('cr-rsi-dca', 'Zosilnenie pri RSI < 30', and(
        cond(ind('rsi', { period: 14 }), 'lt', num(30)),
      ), [{ type: 'dca', sizeMode: 'fixed_quote', value: 100 }], { cooldownBars: 24, maxTriggers: 6 }),
      R('cr-rsi-dca', 'Výber zisku +20 %', and(
        { id: uid('c'), kind: 'condition', type: 'position', state: 'profit_pct', value: 20 },
      ), [sellPct(25)]),
    ],
    risk: { maxPositionPct: 90, maxOpenPositions: 1, stopLossPct: 0, takeProfitPct: 20 },
  }),

  S('cr-uptrend-swing', {
    name: 'Uptrend swing trading',
    family: 'coinrule',
    tags: ['coinrule', 'momentum', 'supertrend', 'swing'],
    timeframe: '4h',
    riskLevel: 3,
    description: 'Coinrule šablóna „Uptrend Swing Trading“: vstup pri prudkom raste potvrdenom Supertrendom, výstup cez dynamický trailing stop.',
    rules: [
      R('cr-uptrend-swing', 'Prudký rast nad Supertrendom', and(
        cond(ind('change_pct', { bars: 4 }), 'gt', num(6)),
        cond(px(), 'gt', ind('supertrend', { period: 10, mult: 3 })),
      ), [buy(30), stopLoss(5), trailing(6)]),
      R('cr-uptrend-swing', 'Momentum slabne', and(
        cond(ind('rsi', { period: 14 }), 'lt', num(50)),
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 50, maxOpenPositions: 1, stopLossPct: 5, takeProfitPct: 0 },
  }),

  S('cr-grid-trading', {
    name: 'Grid trading stratégia',
    family: 'coinrule',
    tags: ['coinrule', 'grid', 'range'],
    timeframe: '1h',
    riskLevel: 3,
    description: 'Coinrule šablóna „Grid Trading Strategy“: nákupné a predajné úrovne v pravidelných krokoch -2 %/+2 %, vhodné pre bočné trhy.',
    rules: [
      R('cr-grid-trading', 'Základný vstup', and(
        { id: uid('c'), kind: 'condition', type: 'position', state: 'none' },
        cond(ind('adx', { period: 14 }), 'lt', num(22)),
      ), [buy(10)]),
      R('cr-grid-trading', 'Dokúpenie -2 %', and(
        { id: uid('c'), kind: 'condition', type: 'position', state: 'pnl_below', value: -2 },
      ), [buy(10)], { cooldownBars: 1, maxTriggers: 8 }),
      R('cr-grid-trading', 'Predaj +2 %', and(
        { id: uid('c'), kind: 'condition', type: 'position', state: 'profit_pct', value: 2 },
      ), [sellPct(50)], { cooldownBars: 1 }),
      R('cr-grid-trading', 'Núdzový stop -15 %', and(
        { id: uid('c'), kind: 'condition', type: 'position', state: 'loss_pct', value: 15 },
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 70, maxOpenPositions: 1, stopLossPct: 15, takeProfitPct: 0 },
  }),

  S('cr-max-scalping-trend', {
    name: 'Maximálny scalping v trende',
    family: 'coinrule',
    tags: ['coinrule', 'ema', 'rsi', 'scalping'],
    timeframe: '15m',
    riskLevel: 4,
    description: 'Coinrule šablóna „Maximized Scalping On Trend“: scalping počas uptrendu s RSI vstupom nad 40 a rýchlym výstupom pri prehriatí.',
    rules: [
      R('cr-max-scalping-trend', 'Trend + RSI nad 40', and(
        cond(ind('ema', { period: 20 }), 'gt', ind('ema', { period: 50 })),
        cond(px(), 'gt', ind('ema', { period: 20 })),
        cond(ind('rsi', { period: 14 }), 'crosses_above', num(40)),
      ), [buy(25), stopLoss(1.5), takeProfit(2.5)]),
      R('cr-max-scalping-trend', 'RSI nad 68', and(
        cond(ind('rsi', { period: 14 }), 'gt', num(68)),
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 35, maxOpenPositions: 1, stopLossPct: 1.5, takeProfitPct: 2.5 },
  }),

  S('cr-ma-scalper', {
    name: 'Moving average scalper',
    family: 'coinrule',
    tags: ['coinrule', 'ema', 'scalping'],
    timeframe: '5m',
    riskLevel: 4,
    description: 'Coinrule šablóna „Moving Average Scalper“: veľmi rýchle obchody na pretnutí EMA9/EMA21 s tesným stopom a malým cieľom.',
    rules: [
      R('cr-ma-scalper', 'EMA9 nad EMA21', and(
        cond(ind('ema', { period: 9 }), 'crosses_above', ind('ema', { period: 21 })),
      ), [buy(25), stopLoss(1.2), takeProfit(1.8)]),
      R('cr-ma-scalper', 'EMA9 pod EMA21', and(
        cond(ind('ema', { period: 9 }), 'crosses_below', ind('ema', { period: 21 })),
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 35, maxOpenPositions: 1, stopLossPct: 1.2, takeProfitPct: 1.8 },
  }),

  S('cr-falling-knife', {
    name: 'Chytenie padajúceho noža s výnimkou',
    family: 'coinrule',
    tags: ['coinrule', 'reversal', 'rsi'],
    timeframe: '1h',
    riskLevel: 4,
    description: 'Coinrule šablóna „Catch The Falling Knife With An Exception“: nákup panického výpredaja len vtedy, keď je širší trh stále v uptrende.',
    rules: [
      R('cr-falling-knife', 'Panický pokles v uptrende', and(
        cond(ind('change_pct', { bars: 1 }), 'lt', num(-7)),
        cond(ind('rsi', { period: 14 }), 'lt', num(30)),
        cond(px(), 'gt', ind('sma', { period: 200 })),
      ), [buy(20), stopLoss(5), takeProfit(6)]),
      R('cr-falling-knife', 'Rýchly odraz', and(
        cond(ind('rsi', { period: 14 }), 'gt', num(55)),
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 30, maxOpenPositions: 1, stopLossPct: 5, takeProfitPct: 6 },
  }),

  S('cr-scalping-dips-trend', {
    name: 'Scalping dips v trende',
    family: 'coinrule',
    tags: ['coinrule', 'rsi', 'scalping', 'trend'],
    timeframe: '15m',
    riskLevel: 3,
    description: 'Coinrule šablóna „Scalping Dips On Trend“: krátkodobé nákupy dipov počas uptrendu s dôrazom na ochranu kapitálu.',
    rules: [
      R('cr-scalping-dips-trend', 'Dip v uptrende', and(
        cond(ind('rsi', { period: 14 }), 'lt', num(40)),
        cond(ind('ema', { period: 50 }), 'gt', ind('ema', { period: 200 })),
        cond(px(), 'gt', ind('ema', { period: 200 })),
      ), [buy(25), stopLoss(2.5), takeProfit(3)]),
      R('cr-scalping-dips-trend', 'Návrat nad RSI 60', and(
        cond(ind('rsi', { period: 14 }), 'gt', num(60)),
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 40, maxOpenPositions: 1, stopLossPct: 2.5, takeProfitPct: 3 },
  }),

  S('cr-multi-ma-crossing', {
    name: 'Viacnásobné pretnutie MA',
    family: 'coinrule',
    tags: ['coinrule', 'ema', 'sma', 'trend'],
    timeframe: '1h',
    riskLevel: 3,
    description: 'Coinrule šablóna „Multi Moving Average Crossing“: EMA9 pretne EMA21 len v širšom uptrende (SMA50 > SMA200) a s potvrdením ADX.',
    rules: [
      R('cr-multi-ma-crossing', 'Pretnutie v uptrende', and(
        cond(ind('ema', { period: 9 }), 'crosses_above', ind('ema', { period: 21 })),
        cond(ind('sma', { period: 50 }), 'gt', ind('sma', { period: 200 })),
        cond(ind('adx', { period: 14 }), 'gt', num(18)),
      ), [buy(35), stopLoss(4), trailing(4)]),
      R('cr-multi-ma-crossing', 'Kríž sa rozpadol', and(
        cond(ind('ema', { period: 9 }), 'crosses_below', ind('ema', { period: 50 })),
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 55, maxOpenPositions: 1, stopLossPct: 4, takeProfitPct: 0 },
  }),

  S('cr-catch-price-swing', {
    name: 'Chytenie cenového swingu',
    family: 'coinrule',
    tags: ['coinrule', 'rsi', 'bollinger', 'swing'],
    timeframe: '1h',
    riskLevel: 3,
    description: 'Coinrule šablóna „Catch The Price Swing“: nákup pri prepredaní a dotyku dolného pásma, výstup pri prehriatí alebo hornom pásme.',
    rules: [
      R('cr-catch-price-swing', 'Prepredané + dolné pásmo', and(
        cond(ind('rsi', { period: 14 }), 'lt', num(30)),
        cond(ind('boll_pb', { period: 20, mult: 2 }), 'lt', num(10)),
      ), [buy(25), stopLoss(4), takeProfit(5)]),
      R('cr-catch-price-swing', 'Prehriate + horné pásmo', and(
        cond(ind('rsi', { period: 14 }), 'gt', num(65)),
        cond(ind('boll_pb', { period: 20, mult: 2 }), 'gt', num(90)),
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 40, maxOpenPositions: 1, stopLossPct: 4, takeProfitPct: 5 },
  }),
  S('cr-rebalance-trend-following', {
    name: 'Rebalancing v trende',
    family: 'coinrule',
    tags: ['coinrule', 'rebalancing', 'trend'],
    timeframe: '1d',
    riskLevel: 2,
    description: 'Coinrule šablóna „Rebalance Trend Following“: pravidelné dokupovanie v bull trhu, čiastočný výber zisku a ochrana pri strate dlhodobého trendu.',
    rules: [
      R('cr-rebalance-trend-following', 'Týždenné dokúpenie v trende', and(
        cond(px(), 'gt', ind('sma', { period: 50 })),
      ), [buy(25)], { cooldownBars: 168 }),
      R('cr-rebalance-trend-following', 'Výber zisku +10 %', and(
        { id: uid('c'), kind: 'condition', type: 'position', state: 'profit_pct', value: 10 },
      ), [sellPct(25)], { cooldownBars: 24 }),
      R('cr-rebalance-trend-following', 'Ochrana pri strate trendu', and(
        cond(px(), 'crosses_below', ind('sma', { period: 200 })),
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 80, maxOpenPositions: 1, stopLossPct: 0, takeProfitPct: 10 },
  }),

  S('cr-maximized-rsi', {
    name: 'Maximalizovaná RSI stratégia',
    family: 'coinrule',
    tags: ['coinrule', 'rsi', 'sma', 'mean-reversion'],
    timeframe: '15m',
    riskLevel: 3,
    description: 'Coinrule šablóna „Maximized RSI Strategy“: nákup pri RSI < 35 a cene pod SMA100, výstup pri RSI > 65 — dlhodobé buy-low/sell-high.',
    rules: [
      R('cr-maximized-rsi', 'RSI < 35 pod SMA100', and(
        cond(ind('rsi', { period: 14 }), 'lt', num(35)),
        cond(px(), 'lt', ind('sma', { period: 100 })),
      ), [buy(30), stopLoss(6), takeProfit(10)]),
      R('cr-maximized-rsi', 'RSI > 65 — predaj', and(
        cond(ind('rsi', { period: 14 }), 'gt', num(65)),
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 50, maxOpenPositions: 1, stopLossPct: 6, takeProfitPct: 10 },
  }),

  S('cr-bitcoin-sideways', {
    name: 'Bitcoin v bočnom trhu',
    family: 'coinrule',
    tags: ['coinrule', 'bollinger', 'range', 'scalping'],
    timeframe: '1h',
    riskLevel: 3,
    description: 'Coinrule šablóna „Bitcoin Trading In Sideways Market“: nákup pri dolnom pásme v bočnom trhu a postupný predaj pri návrate k stredu.',
    rules: [
      R('cr-bitcoin-sideways', 'Nákup pri dolnom pásme', and(
        cond(px(), 'lt', ind('boll_lower', { period: 20, mult: 2 })),
        cond(ind('rsi', { period: 14 }), 'lt', num(40)),
        cond(ind('adx', { period: 14 }), 'lt', num(20)),
      ), [buy(20), stopLoss(4), takeProfit(2.5)]),
      R('cr-bitcoin-sideways', 'Predaj pri strede pásma', and(
        cond(px(), 'gt', ind('boll_middle', { period: 20, mult: 2 })),
        cond(ind('rsi', { period: 14 }), 'gt', num(55)),
      ), [sellPct(50)]),
    ],
    risk: { maxPositionPct: 40, maxOpenPositions: 1, stopLossPct: 4, takeProfitPct: 2.5 },
  }),

  S('cr-ride-the-trend', {
    name: 'Jazda na trende',
    family: 'coinrule',
    tags: ['coinrule', 'rsi', 'trend'],
    timeframe: '4h',
    riskLevel: 3,
    description: 'Coinrule šablóna „Ride The Trend“: nákup kryptomien so silným trendom (RSI > 70 na 4h) a výstup pri +6 % alebo ochabnutí RSI pod 55.',
    rules: [
      R('cr-ride-the-trend', 'RSI nad 70 — silný trend', and(
        cond(ind('rsi', { period: 14 }), 'gt', num(70)),
        cond(px(), 'gt', ind('ema', { period: 50 })),
      ), [buy(30), takeProfit(6)]),
      R('cr-ride-the-trend', 'Trend slabne — RSI < 55', and(
        cond(ind('rsi', { period: 14 }), 'lt', num(55)),
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 50, maxOpenPositions: 1, stopLossPct: 0, takeProfitPct: 6 },
  }),

  S('cr-buy-dips-bull', {
    name: 'Nákup dipov v bull trhu',
    family: 'coinrule',
    tags: ['coinrule', 'rsi', 'sma', 'dips'],
    timeframe: '15m',
    riskLevel: 3,
    description: 'Coinrule šablóna „Buy The Dips In Bull Market“: nákup RSI dipu pod 35 len keď SMA9 zostáva nad SMA200, výstup pri obnovení trendu.',
    rules: [
      R('cr-buy-dips-bull', 'RSI < 35 + SMA9 nad SMA200', and(
        cond(ind('rsi', { period: 14 }), 'lt', num(35)),
        cond(ind('sma', { period: 9 }), 'gt', ind('sma', { period: 200 })),
      ), [buy(30), stopLoss(3), takeProfit(4)]),
      R('cr-buy-dips-bull', 'Trend obnovený', and(
        cond(ind('sma', { period: 9 }), 'gt', ind('sma', { period: 50 })),
        cond(px(), 'gt', ind('sma', { period: 9 })),
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 40, maxOpenPositions: 1, stopLossPct: 3, takeProfitPct: 4 },
  }),

  S('cr-low-volatility-buy-sell', {
    name: 'Nízka volatilita — nákup a predaj',
    family: 'coinrule',
    tags: ['coinrule', 'sma', 'volatility'],
    timeframe: '1h',
    riskLevel: 3,
    description: 'Coinrule šablóna „Low Volatility Buy And Sell“: nákup pri stlačených MA (MA50 > MA100, MA200 > MA100) so SL 3 % a TP 6 %.',
    rules: [
      R('cr-low-volatility-buy-sell', 'Stlačené kĺzavé priemery', and(
        cond(ind('sma', { period: 200 }), 'gt', ind('sma', { period: 100 })),
        cond(ind('sma', { period: 50 }), 'gt', ind('sma', { period: 100 })),
      ), [buy(30), stopLoss(3), takeProfit(6)], { cooldownBars: 12 }),
      R('cr-low-volatility-buy-sell', 'Návrat pod MA100', and(
        cond(px(), 'crosses_below', ind('sma', { period: 100 })),
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 50, maxOpenPositions: 1, stopLossPct: 3, takeProfitPct: 6 },
  }),

  S('cr-maximized-ma-crossing', {
    name: 'Maximálne pretnutie MA',
    family: 'coinrule',
    tags: ['coinrule', 'sma', 'trend'],
    timeframe: '1h',
    riskLevel: 3,
    description: 'Coinrule šablóna „Maximized Moving Average Crossing“: pretnutie SMA9 nad SMA50 s RSI filtrom proti prehriatiu a dynamickým výstupom.',
    rules: [
      R('cr-maximized-ma-crossing', 'SMA9 pretne SMA50', and(
        cond(ind('sma', { period: 9 }), 'crosses_above', ind('sma', { period: 50 })),
        cond(ind('rsi', { period: 14 }), 'lt', num(70)),
      ), [buy(35), stopLoss(5), trailing(5)]),
      R('cr-maximized-ma-crossing', 'Opačné pretnutie', and(
        cond(ind('sma', { period: 9 }), 'crosses_below', ind('sma', { period: 50 })),
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 55, maxOpenPositions: 1, stopLossPct: 5, takeProfitPct: 0 },
  }),

  S('cr-uptrend-flash-crash', {
    name: 'Nákup flash crashu v uptrende',
    family: 'coinrule',
    tags: ['coinrule', 'reversal', 'dips'],
    timeframe: '1h',
    riskLevel: 4,
    description: 'Coinrule šablóna „Buy The Uptrend Flash Crash“: nákup jednosviečkového prepadu o 5 % počas uptrendu s rýchlym cieľom a stopom.',
    rules: [
      R('cr-uptrend-flash-crash', 'Flash crash v uptrende', and(
        cond(ind('change_pct', { bars: 1 }), 'lt', num(-5)),
        cond(px(), 'gt', ind('sma', { period: 200 })),
      ), [buy(25), stopLoss(3), takeProfit(4)]),
      R('cr-uptrend-flash-crash', 'Rýchly odraz nad RSI 55', and(
        cond(ind('rsi', { period: 14 }), 'gt', num(55)),
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 35, maxOpenPositions: 1, stopLossPct: 3, takeProfitPct: 4 },
  }),

  S('cr-short-selling-ma-cross', {
    name: 'MA cross s ochranou (long-only)',
    family: 'coinrule',
    tags: ['coinrule', 'ema', 'trend'],
    timeframe: '1h',
    riskLevel: 3,
    description: 'Coinrule šablóna „Short Selling MA Cross“ v long-only podobe: long vstup pri kríži nahor a okamžitý ochranný výstup pri kríži nadol.',
    rules: [
      R('cr-short-selling-ma-cross', 'Kríž nahor (long adaptácia)', and(
        cond(ind('ema', { period: 9 }), 'crosses_above', ind('ema', { period: 50 })),
        cond(ind('adx', { period: 14 }), 'gt', num(18)),
      ), [buy(30), stopLoss(4), trailing(4)]),
      R('cr-short-selling-ma-cross', 'Kríž nadol — ochrana', and(
        cond(ind('ema', { period: 9 }), 'crosses_below', ind('ema', { period: 50 })),
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 50, maxOpenPositions: 1, stopLossPct: 4, takeProfitPct: 0 },
  }),

  S('cr-rsi-decrease-scalper', {
    name: 'RSI scalper na poklese (long-only)',
    family: 'coinrule',
    tags: ['coinrule', 'rsi', 'scalping'],
    timeframe: '15m',
    riskLevel: 4,
    description: 'Coinrule šablóna „RSI Decrease Scalper“ v long-only podobe: rýchly nákup po prepredaní v dlhodobom uptrende a výstup pri RSI 60.',
    rules: [
      R('cr-rsi-decrease-scalper', 'RSI sa vracia nad 30', and(
        cond(ind('rsi', { period: 14 }), 'crosses_above', num(30)),
        cond(px(), 'gt', ind('ema', { period: 200 })),
      ), [buy(25), stopLoss(2), takeProfit(3)]),
      R('cr-rsi-decrease-scalper', 'RSI nad 60', and(
        cond(ind('rsi', { period: 14 }), 'gt', num(60)),
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 35, maxOpenPositions: 1, stopLossPct: 2, takeProfitPct: 3 },
  }),

  S('cr-rsi-increase-scalper', {
    name: 'RSI scalper na raste',
    family: 'coinrule',
    tags: ['coinrule', 'rsi', 'scalping'],
    timeframe: '15m',
    riskLevel: 4,
    description: 'Coinrule šablóna „RSI Increase Scalper“: vstup počas uptrendu pri rastúcom RSI nad 50, výstup pri prehriatí nad 70.',
    rules: [
      R('cr-rsi-increase-scalper', 'RSI rastie nad 50', and(
        cond(ind('rsi', { period: 14 }), 'gt', num(50)),
        cond(ind('rsi', { period: 14 }), 'rising', num(0), { risingBars: 3 }),
        cond(ind('ema', { period: 9 }), 'gt', ind('ema', { period: 21 })),
      ), [buy(25), stopLoss(2), takeProfit(3)]),
      R('cr-rsi-increase-scalper', 'Prehriate RSI', and(
        cond(ind('rsi', { period: 14 }), 'gt', num(70)),
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 35, maxOpenPositions: 1, stopLossPct: 2, takeProfitPct: 3 },
  }),

  S('cr-fast-ema-slow-ema-macd', {
    name: 'Rýchla EMA nad pomalou + MACD',
    family: 'coinrule',
    tags: ['coinrule', 'ema', 'macd', 'trend'],
    timeframe: '1h',
    riskLevel: 3,
    description: 'Coinrule šablóna „Fast EMA Above Slow EMA With MACD“: vstup pri potvrdenom trende (EMA9 > EMA21, MACD bull) nad EMA200, výstup pri zlome MACD.',
    rules: [
      R('cr-fast-ema-slow-ema-macd', 'Trend + MACD bull', and(
        cond(ind('ema', { period: 9 }), 'gt', ind('ema', { period: 21 })),
        cond(ind('macd'), 'gt', ind('macd_signal')),
        cond(px(), 'gt', ind('ema', { period: 200 })),
      ), [buy(30), stopLoss(4), trailing(3)]),
      R('cr-fast-ema-slow-ema-macd', 'MACD sa zlomil', and(
        cond(ind('macd'), 'crosses_below', ind('macd_signal')),
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 55, maxOpenPositions: 1, stopLossPct: 4, takeProfitPct: 0 },
  }),

  S('cr-optimised-rsi-ma', {
    name: 'Optimalizované RSI + MA',
    family: 'coinrule',
    tags: ['coinrule', 'rsi', 'sma', 'trend'],
    timeframe: '15m',
    riskLevel: 3,
    description: 'Coinrule šablóna „Optimised RSI and MA Strategy“: nákup pri RSI < 30 nad SMA200 s trailing stopom 4 % a take-profitom 12 %.',
    rules: [
      R('cr-optimised-rsi-ma', 'RSI < 30 nad SMA200', and(
        cond(ind('rsi', { period: 14 }), 'lt', num(30)),
        cond(px(), 'gt', ind('sma', { period: 200 })),
      ), [buy(30), stopLoss(5), takeProfit(12), trailing(4)]),
      R('cr-optimised-rsi-ma', 'RSI > 65 — výber', and(
        cond(ind('rsi', { period: 14 }), 'gt', num(65)),
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 50, maxOpenPositions: 1, stopLossPct: 5, takeProfitPct: 12 },
  }),

  S('cr-bollinger-rsi-short', {
    name: 'Bollinger + RSI (long-only adaptácia shortu)',
    family: 'coinrule',
    tags: ['coinrule', 'bollinger', 'rsi', 'mean-reversion'],
    timeframe: '15m',
    riskLevel: 4,
    description: 'Coinrule šablóna „Shorting when Bollinger Band Above Price with RSI“ v long-only podobe: nákup odrazu od dolného pásma so slabým RSI, výstup na strednom pásme.',
    rules: [
      R('cr-bollinger-rsi-short', 'Odraz od dolného pásma', and(
        cond(px(), 'crosses_above', ind('boll_lower', { period: 20, mult: 2 })),
        cond(ind('rsi', { period: 14 }), 'lt', num(35)),
      ), [buy(25), stopLoss(3), takeProfit(4)]),
      R('cr-bollinger-rsi-short', 'Stredné pásmo', and(
        cond(px(), 'gte', ind('boll_middle', { period: 20, mult: 2 })),
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 35, maxOpenPositions: 1, stopLossPct: 3, takeProfitPct: 4 },
  }),

  S('cr-inverse-macd-dmi', {
    name: 'Inverzný MACD + DMI s volatilitným stopom',
    family: 'coinrule',
    tags: ['coinrule', 'macd', 'dmi', 'scalping'],
    timeframe: '5m',
    riskLevel: 4,
    description: 'Coinrule šablóna „Inverse MACD + DMI Scalping with Volatility Stop“: vstup pri MACD histograme nad 0 a DMI potvrdení, stop podľa volatility.',
    rules: [
      R('cr-inverse-macd-dmi', 'MACD histogram + DMI', and(
        cond(ind('macd_hist'), 'crosses_above', num(0)),
        cond(ind('plus_di', { period: 14 }), 'gt', ind('minus_di', { period: 14 })),
        cond(ind('natr', { period: 14 }), 'gt', num(0.3)),
      ), [buy(25), stopLoss(2), trailing(2)]),
      R('cr-inverse-macd-dmi', 'Obrat MACD', and(
        cond(ind('macd_hist'), 'crosses_below', num(0)),
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 35, maxOpenPositions: 1, stopLossPct: 2, takeProfitPct: 0 },
  }),

  S('cr-bollinger-rsi', {
    name: 'Bollingerove pásma + RSI',
    family: 'coinrule',
    tags: ['coinrule', 'bollinger', 'rsi', 'mean-reversion'],
    timeframe: '1h',
    riskLevel: 3,
    description: 'Coinrule šablóna „Bollinger Bands and RSI“: nákup pod dolným pásmom s RSI < 30 a výstup pri strede pásma alebo RSI > 65.',
    rules: [
      R('cr-bollinger-rsi', 'Dolné pásmo + RSI < 30', and(
        cond(px(), 'lt', ind('boll_lower', { period: 20, mult: 2 })),
        cond(ind('rsi', { period: 14 }), 'lt', num(30)),
      ), [buy(30), stopLoss(4), takeProfit(5)]),
      R('cr-bollinger-rsi', 'Stred pásma alebo RSI > 65', or(
        cond(px(), 'gte', ind('boll_middle', { period: 20, mult: 2 })),
        cond(ind('rsi', { period: 14 }), 'gt', num(65)),
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 45, maxOpenPositions: 1, stopLossPct: 4, takeProfitPct: 5 },
  }),

  S('cr-ichimoku-rsi', {
    name: 'Ichimoku + RSI',
    family: 'coinrule',
    tags: ['coinrule', 'ichimoku', 'rsi', 'trend'],
    timeframe: '4h',
    riskLevel: 3,
    description: 'Coinrule šablóna „Ichimoku Cloud With RSI“: vstup nad kijun-sen s RSI pretínajúcim 50, výstup pri páde pod kijun-sen.',
    rules: [
      R('cr-ichimoku-rsi', 'Nad kijun + RSI nad 50', and(
        cond(px(), 'gt', ind('ichimoku_kijun', { tenkan: 9, kijun: 26, senkou: 52 })),
        cond(ind('rsi', { period: 14 }), 'crosses_above', num(50)),
      ), [buy(30), stopLoss(5), trailing(4)]),
      R('cr-ichimoku-rsi', 'Pod kijun-sen', and(
        cond(px(), 'crosses_below', ind('ichimoku_kijun', { tenkan: 9, kijun: 26, senkou: 52 })),
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 55, maxOpenPositions: 1, stopLossPct: 5, takeProfitPct: 0 },
  }),

  S('cr-ichimoku-bollinger', {
    name: 'Ichimoku + Bollingerove pásma',
    family: 'coinrule',
    tags: ['coinrule', 'ichimoku', 'bollinger', 'trend'],
    timeframe: '4h',
    riskLevel: 3,
    description: 'Coinrule šablóna „Ichimoku Cloud and Bollinger Bands (by Coinrule)“: vstup nad kijun-sen v spodnej polovici pásma, výstup na hornom pásme.',
    rules: [
      R('cr-ichimoku-bollinger', 'Nad kijun + %B pod 50', and(
        cond(px(), 'crosses_above', ind('ichimoku_kijun', { tenkan: 9, kijun: 26, senkou: 52 })),
        cond(ind('boll_pb', { period: 20, mult: 2 }), 'lt', num(50)),
      ), [buy(30), stopLoss(5), takeProfit(6)]),
      R('cr-ichimoku-bollinger', 'Horné pásmo', and(
        cond(px(), 'gte', ind('boll_upper', { period: 20, mult: 2 })),
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 50, maxOpenPositions: 1, stopLossPct: 5, takeProfitPct: 6 },
  }),

  S('cr-short-term-rsi-sma', {
    name: 'Krátkodobá RSI + SMA zmena',
    family: 'coinrule',
    tags: ['coinrule', 'rsi', 'sma', 'dips'],
    timeframe: '15m',
    riskLevel: 4,
    description: 'Coinrule šablóna „Short Term RSI and SMA Percentage Change“: nákup krátkodobého poklesu o 3 % s RSI < 40 nad SMA200.',
    rules: [
      R('cr-short-term-rsi-sma', 'Pokles 3 % + RSI < 40', and(
        cond(ind('change_pct', { bars: 3 }), 'lt', num(-3)),
        cond(ind('rsi', { period: 14 }), 'lt', num(40)),
        cond(px(), 'gt', ind('sma', { period: 200 })),
      ), [buy(30), stopLoss(3), takeProfit(3)]),
      R('cr-short-term-rsi-sma', 'RSI nad 60', and(
        cond(ind('rsi', { period: 14 }), 'gt', num(60)),
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 40, maxOpenPositions: 1, stopLossPct: 3, takeProfitPct: 3 },
  }),

  S('cr-ichimoku-adx', {
    name: 'Ichimoku + ADX',
    family: 'coinrule',
    tags: ['coinrule', 'ichimoku', 'adx', 'trend'],
    timeframe: '4h',
    riskLevel: 3,
    description: 'Coinrule šablóna „Ichimoku Cloud with ADX“: vstup nad oblakom len pri ADX > 25 a kladnom DMI, výstup pod kijun-sen.',
    rules: [
      R('cr-ichimoku-adx', 'Nad kijun + silný trend', and(
        cond(px(), 'gt', ind('ichimoku_kijun', { tenkan: 9, kijun: 26, senkou: 52 })),
        cond(ind('adx', { period: 14 }), 'gt', num(25)),
        cond(ind('plus_di', { period: 14 }), 'gt', ind('minus_di', { period: 14 })),
      ), [buy(30), stopLoss(5), trailing(4)]),
      R('cr-ichimoku-adx', 'Pod kijun-sen', and(
        cond(px(), 'crosses_below', ind('ichimoku_kijun', { tenkan: 9, kijun: 26, senkou: 52 })),
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 55, maxOpenPositions: 1, stopLossPct: 5, takeProfitPct: 0 },
  }),

  S('cr-ichimoku-macd', {
    name: 'Ichimoku + MACD',
    family: 'coinrule',
    tags: ['coinrule', 'ichimoku', 'macd', 'trend'],
    timeframe: '4h',
    riskLevel: 3,
    description: 'Coinrule šablóna „Ichimoku Cloud with MACD“: vstup nad kijun-sen pri MACD histograme pretínajúcom nulu nahor, výstup pri opačnom pretnutí.',
    rules: [
      R('cr-ichimoku-macd', 'Nad kijun + MACD histogram', and(
        cond(px(), 'gt', ind('ichimoku_kijun', { tenkan: 9, kijun: 26, senkou: 52 })),
        cond(ind('macd_hist'), 'crosses_above', num(0)),
      ), [buy(30), stopLoss(5), takeProfit(8)]),
      R('cr-ichimoku-macd', 'MACD pod nulou', and(
        cond(ind('macd_hist'), 'crosses_below', num(0)),
      ), [closePos()]),
    ],
    risk: { maxPositionPct: 50, maxOpenPositions: 1, stopLossPct: 5, takeProfitPct: 8 },
  }),];

/* --------------------------------------------------------------- accessors */

export const STRATEGY_FAMILIES = [
  { id: 'coinrule', label: 'Coinrule knižnica' },
  { id: 'trend', label: 'Trendové' },
  { id: 'mean-reversion', label: 'Mean reversion' },
  { id: 'breakout', label: 'Breakout' },
  { id: 'momentum', label: 'Momentum' },
  { id: 'scalping', label: 'Scalping' },
  { id: 'dca', label: 'DCA / akumulácia' },
  { id: 'grid', label: 'Grid / range' },
  { id: 'martingale', label: 'Martingale' },
  { id: 'risk', label: 'Risk manažment' },
  { id: 'volatility', label: 'Volatilita' },
  { id: 'hybrid', label: 'Hybridné' },
  { id: 'portfolio', label: 'Portfólio' },
];

const BY_ID = new Map(STRATEGY_LIBRARY.map((s) => [s.id, s]));

export function getTemplate(id) {
  const t = BY_ID.get(id);
  return t ? JSON.parse(JSON.stringify(t)) : null;
}

export function templatesByFamily(family) {
  return STRATEGY_LIBRARY.filter((s) => s.family === family).map((s) => JSON.parse(JSON.stringify(s)));
}

export function searchTemplates(query) {
  const q = String(query ?? '').toLowerCase().trim();
  if (!q) return STRATEGY_LIBRARY.map((s) => JSON.parse(JSON.stringify(s)));
  return STRATEGY_LIBRARY.filter((s) => (
    s.name.toLowerCase().includes(q)
    || s.description.toLowerCase().includes(q)
    || (s.tags ?? []).some((t) => t.includes(q))
    || s.family.includes(q)
  )).map((s) => JSON.parse(JSON.stringify(s)));
}

/** Instantiate a template as an editable, independent strategy document. */
export function instantiate(templateId, { symbol, timeframe } = {}) {
  const t = getTemplate(templateId);
  if (!t) throw new Error(`Neznáma šablóna: ${templateId}`);
  t.id = `strategy_${templateId}_${Math.random().toString(36).slice(2, 8)}`;
  if (symbol) t.symbol = symbol;
  if (timeframe) t.timeframe = timeframe;
  return t;
}

export const STRATEGY_COUNT = STRATEGY_LIBRARY.length;
