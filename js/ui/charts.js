/**
 * charts.js — dependency-free canvas charts.
 *
 * Everything is drawn with the 2D context: candlesticks with volume, overlay
 * indicator lines, trade markers, equity curves and bar histograms. No library,
 * no CDN, no SVG-from-string.
 */

import { h, fmtNum, fmtMoney, fmtDate } from './dom.js';

const COLORS = {
  grid: '#1b2532',
  axis: '#6b7c92',
  up: '#2ecc71',
  down: '#ff5c5c',
  wick: '#8fa3bb',
  line: '#f0b90b',
  line2: '#4c9aff',
  line3: '#b06bff',
  line4: '#2ee6c8',
  buy: '#2ecc71',
  sell: '#ff5c5c',
  volume: '#2c3a4d',
  text: '#c7d5e6',
};

export const LINE_COLORS = [COLORS.line, COLORS.line2, COLORS.line3, COLORS.line4, '#ff9f43', '#ff6bd6'];

function setupCanvas(canvas, cssHeight) {
  const dpr = typeof devicePixelRatio === 'number' ? Math.min(devicePixelRatio, 2) : 1;
  const cssWidth = canvas.clientWidth || canvas.parentElement?.clientWidth || 800;
  canvas.style.height = `${cssHeight}px`;
  canvas.width = Math.max(1, Math.floor(cssWidth * dpr));
  canvas.height = Math.max(1, Math.floor(cssHeight * dpr));
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssWidth, cssHeight);
  ctx.font = '11px ui-monospace, Consolas, monospace';
  ctx.textBaseline = 'middle';
  return { ctx, width: cssWidth, height: cssHeight };
}

function ensureTooltip(box) {
  let tip = box.querySelector('.chart-tooltip');
  if (!tip) {
    tip = h('div', { class: 'chart-tooltip', style: { display: 'none' } });
    box.append(tip);
  }
  return tip;
}

/**
 * Candlestick chart with volume, overlays and trade markers.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {object} opts
 * @param {Array} opts.candles
 * @param {Array<{label:string, series:Array<number|null>, color?:string}>} [opts.overlays]
 * @param {Array<{index:number, price:number, side:'buy'|'sell', label?:string}>} [opts.markers]
 * @param {number} [opts.height]
 */
export function drawCandles(canvas, opts = {}) {
  const { candles = [], overlays = [], markers = [], height = 380 } = opts;
  const box = canvas.parentElement;
  const { ctx, width, height: H } = setupCanvas(canvas, height);
  const tip = box ? ensureTooltip(box) : null;
  if (tip) tip.style.display = 'none';

  if (!candles.length) {
    ctx.fillStyle = COLORS.axis;
    ctx.fillText('Žiadne dáta', 12, 20);
    return;
  }

  const padL = 8;
  const padR = 66;
  const padT = 10;
  const volH = Math.round(H * 0.18);
  const plotH = H - padT - volH - 26;
  const plotW = width - padL - padR;
  const step = plotW / candles.length;
  const bodyW = Math.max(1, Math.min(12, step * 0.68));

  let min = Infinity;
  let max = -Infinity;
  let volMax = 0;
  for (const c of candles) {
    min = Math.min(min, c.low);
    max = Math.max(max, c.high);
    volMax = Math.max(volMax, c.volume ?? 0);
  }
  for (const ov of overlays) {
    for (const v of ov.series ?? []) {
      if (typeof v !== 'number' || !Number.isFinite(v)) continue;
      min = Math.min(min, v);
      max = Math.max(max, v);
    }
  }
  const span = max - min || 1;
  min -= span * 0.03;
  max += span * 0.03;

  const x = (i) => padL + i * step + step / 2;
  const y = (p) => padT + ((max - p) / (max - min)) * plotH;

  // grid + price axis
  ctx.strokeStyle = COLORS.grid;
  ctx.fillStyle = COLORS.axis;
  ctx.lineWidth = 1;
  const ticks = 5;
  for (let t = 0; t <= ticks; t += 1) {
    const price = min + ((max - min) * t) / ticks;
    const yy = Math.round(y(price)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(padL, yy);
    ctx.lineTo(padL + plotW, yy);
    ctx.stroke();
    ctx.fillText(fmtNum(price, price > 100 ? 0 : price > 1 ? 2 : 5), padL + plotW + 6, yy);
  }

  // volume
  const volTop = padT + plotH + 14;
  for (let i = 0; i < candles.length; i += 1) {
    const c = candles[i];
    const vh = volMax ? ((c.volume ?? 0) / volMax) * (volH - 6) : 0;
    ctx.fillStyle = c.close >= c.open ? 'rgba(46,204,113,.45)' : 'rgba(255,92,92,.45)';
    ctx.fillRect(x(i) - bodyW / 2, volTop + (volH - 6 - vh), bodyW, vh);
  }

  // candles
  for (let i = 0; i < candles.length; i += 1) {
    const c = candles[i];
    const up = c.close >= c.open;
    ctx.strokeStyle = up ? COLORS.up : COLORS.down;
    ctx.fillStyle = up ? COLORS.up : COLORS.down;
    ctx.beginPath();
    ctx.moveTo(Math.round(x(i)) + 0.5, y(c.high));
    ctx.lineTo(Math.round(x(i)) + 0.5, y(c.low));
    ctx.stroke();
    const yo = y(c.open);
    const yc = y(c.close);
    const top = Math.min(yo, yc);
    const hgt = Math.max(1, Math.abs(yc - yo));
    ctx.fillRect(x(i) - bodyW / 2, top, bodyW, hgt);
  }

  // overlays
  overlays.forEach((ov, idx) => {
    ctx.strokeStyle = ov.color ?? LINE_COLORS[idx % LINE_COLORS.length];
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    let started = false;
    (ov.series ?? []).forEach((v, i) => {
      if (typeof v !== 'number' || !Number.isFinite(v)) { started = false; return; }
      const px = x(i);
      const py = y(v);
      if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
    });
    ctx.stroke();
  });

  // trade markers
  for (const m of markers) {
    if (m.index < 0 || m.index >= candles.length) continue;
    const px = x(m.index);
    const py = y(m.price);
    ctx.fillStyle = m.side === 'buy' ? COLORS.buy : COLORS.sell;
    ctx.beginPath();
    if (m.side === 'buy') {
      ctx.moveTo(px, py + 12);
      ctx.lineTo(px - 5, py + 20);
      ctx.lineTo(px + 5, py + 20);
    } else {
      ctx.moveTo(px, py - 12);
      ctx.lineTo(px - 5, py - 20);
      ctx.lineTo(px + 5, py - 20);
    }
    ctx.closePath();
    ctx.fill();
  }

  // crosshair
  if (tip && box) {
    canvas.onmousemove = (ev) => {
      const rect = canvas.getBoundingClientRect();
      const mx = ev.clientX - rect.left;
      const i = Math.max(0, Math.min(candles.length - 1, Math.floor((mx - padL) / step)));
      const c = candles[i];
      tip.style.display = 'block';
      tip.style.left = `${Math.max(60, Math.min(width - 60, mx))}px`;
      tip.style.top = `${Math.max(40, ev.clientY - rect.top)}px`;
      const extra = overlays
        .filter((ov) => typeof ov.series?.[i] === 'number')
        .map((ov, idx) => `\n${ov.label ?? 'ind'}: ${fmtNum(ov.series[i], 4)}`)
        .join('');
      tip.textContent = `${fmtDate(c.time)}\nO ${fmtNum(c.open, 4)}  H ${fmtNum(c.high, 4)}\nL ${fmtNum(c.low, 4)}  C ${fmtNum(c.close, 4)}\nV ${fmtNum(c.volume ?? 0, 2)}${extra}`;
    };
    canvas.onmouseleave = () => { tip.style.display = 'none'; };
  }
}

/**
 * Equity curve with optional benchmark and drawdown shading.
 * @param {HTMLCanvasElement} canvas
 * @param {Array<{time:number, equity:number}>} points
 */
export function drawEquity(canvas, points, { height = 260, benchmark = null, label = 'Kapitál' } = {}) {
  const box = canvas.parentElement;
  const { ctx, width, height: H } = setupCanvas(canvas, height);
  const tip = box ? ensureTooltip(box) : null;
  if (tip) tip.style.display = 'none';

  if (points.length < 2) {
    ctx.fillStyle = COLORS.axis;
    ctx.fillText('Žiadne dáta', 12, 20);
    return;
  }
  const padL = 8;
  const padR = 70;
  const padT = 10;
  const padB = 22;
  const plotW = width - padL - padR;
  const plotH = H - padT - padB;

  let min = Infinity;
  let max = -Infinity;
  for (const p of points) { min = Math.min(min, p.equity); max = Math.max(max, p.equity); }
  if (benchmark?.length) {
    const base = points[0].equity;
    const b0 = benchmark[0].price;
    for (const b of benchmark) {
      const scaled = base * (b.price / b0);
      min = Math.min(min, scaled);
      max = Math.max(max, scaled);
    }
  }
  const span = max - min || 1;
  min -= span * 0.05;
  max += span * 0.05;

  const x = (i) => padL + (i / (points.length - 1)) * plotW;
  const y = (v) => padT + ((max - v) / (max - min)) * plotH;

  ctx.strokeStyle = COLORS.grid;
  ctx.fillStyle = COLORS.axis;
  for (let t = 0; t <= 4; t += 1) {
    const v = min + ((max - min) * t) / 4;
    const yy = Math.round(y(v)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(padL, yy);
    ctx.lineTo(padL + plotW, yy);
    ctx.stroke();
    ctx.fillText(fmtMoney(v, 0), padL + plotW + 6, yy);
  }

  // area
  const first = points[0].equity;
  const grad = ctx.createLinearGradient(0, padT, 0, padT + plotH);
  grad.addColorStop(0, 'rgba(240,185,11,.28)');
  grad.addColorStop(1, 'rgba(240,185,11,0)');
  ctx.beginPath();
  ctx.moveTo(x(0), y(first));
  points.forEach((p, i) => ctx.lineTo(x(i), y(p.equity)));
  ctx.lineTo(x(points.length - 1), padT + plotH);
  ctx.lineTo(x(0), padT + plotH);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // benchmark
  if (benchmark?.length) {
    const base = points[0].equity;
    const b0 = benchmark[0].price;
    ctx.strokeStyle = COLORS.line2;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    points.forEach((p, i) => {
      const b = benchmark[Math.min(benchmark.length - 1, Math.round((i / (points.length - 1)) * (benchmark.length - 1)))];
      const v = base * (b.price / b0);
      if (i === 0) ctx.moveTo(x(i), y(v)); else ctx.lineTo(x(i), y(v));
    });
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // equity line
  ctx.strokeStyle = COLORS.line;
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  points.forEach((p, i) => { if (i === 0) ctx.moveTo(x(i), y(p.equity)); else ctx.lineTo(x(i), y(p.equity)); });
  ctx.stroke();

  if (tip && box) {
    canvas.onmousemove = (ev) => {
      const rect = canvas.getBoundingClientRect();
      const i = Math.max(0, Math.min(points.length - 1, Math.round(((ev.clientX - rect.left - padL) / plotW) * (points.length - 1))));
      const p = points[i];
      tip.style.display = 'block';
      tip.style.left = `${Math.max(60, Math.min(width - 60, ev.clientX - rect.left))}px`;
      tip.style.top = `${Math.max(40, ev.clientY - rect.top)}px`;
      tip.textContent = `${fmtDate(p.time)}\n${label}: ${fmtMoney(p.equity, 2)}\n${fmtNum(((p.equity - points[0].equity) / points[0].equity) * 100, 2)} %`;
    };
    canvas.onmouseleave = () => { tip.style.display = 'none'; };
  }
}

/** Horizontal bar chart (monthly returns, trade distribution, ...). */
export function drawBars(canvas, items, { height = 180, valueKey = 'value', labelKey = 'label', zeroCentered = true } = {}) {
  const { ctx, width, height: H } = setupCanvas(canvas, height);
  if (!items.length) {
    ctx.fillStyle = COLORS.axis;
    ctx.fillText('Žiadne dáta', 12, 20);
    return;
  }
  const padL = 8;
  const padR = 60;
  const padT = 10;
  const padB = 20;
  const plotW = width - padL - padR;
  const plotH = H - padT - padB;
  const values = items.map((it) => it[valueKey]);
  const maxAbs = Math.max(...values.map((v) => Math.abs(v)), 1e-9);
  const zeroY = zeroCentered ? padT + plotH / 2 : padT + plotH;
  const scale = zeroCentered ? plotH / 2 / maxAbs : plotH / maxAbs;
  const step = plotW / items.length;

  ctx.strokeStyle = COLORS.grid;
  ctx.beginPath();
  ctx.moveTo(padL, Math.round(zeroY) + 0.5);
  ctx.lineTo(padL + plotW, Math.round(zeroY) + 0.5);
  ctx.stroke();

  ctx.fillStyle = COLORS.axis;
  items.forEach((it, i) => {
    const v = it[valueKey];
    const bh = Math.max(1, Math.abs(v) * scale);
    ctx.fillStyle = v >= 0 ? 'rgba(46,204,113,.75)' : 'rgba(255,92,92,.75)';
    ctx.fillRect(padL + i * step + step * 0.15, v >= 0 ? zeroY - bh : zeroY, step * 0.7, bh);
    if (step > 22) {
      ctx.fillStyle = COLORS.axis;
      ctx.fillText(String(it[labelKey]).slice(-5), padL + i * step + step * 0.15, H - 8);
    }
  });
}

/** Small sparkline used in cards. */
export function drawSparkline(canvas, values, { height = 44, color = COLORS.line } = {}) {
  const { ctx, width } = setupCanvas(canvas, height);
  const nums = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (nums.length < 2) return;
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const span = max - min || 1;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  nums.forEach((v, i) => {
    const px = (i / (nums.length - 1)) * (width - 4) + 2;
    const py = height - 3 - ((v - min) / span) * (height - 6);
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  });
  ctx.stroke();
}

export { COLORS };
