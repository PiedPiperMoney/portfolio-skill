/* charts.js — рисование: гильош на первом экране, линейный график (canvas), столбики (SVG).
   Графики ничего не считают: получают готовые ряды через opt.series[].get(i). */
'use strict';

/* ---------- гильош ---------- */
function drawGuilloche() {
  const cv = $('guil'), r = cv.getBoundingClientRect(), dpr = Math.min(2, window.devicePixelRatio || 1);
  const S = Math.max(10, Math.round(r.width)); cv.width = S * dpr; cv.height = S * dpr;
  const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, S, S);
  const cx = S / 2, cy = S / 2;
  const FIT = 0.485 / 0.532; // самое внешнее кольцо доходит до 0,532 — вписываем в холст с запасом
  const rings = [[0.46, 7, 0.12, C.accent, .22], [0.38, 11, 0.09, C.accent, .16], [0.29, 13, 0.07, C.gold, .22], [0.2, 17, 0.05, C.accent, .14]];
  for (const [R, k, amp, col, a] of rings) {
    for (let ph = 0; ph < 6; ph++) {
      g.beginPath();
      for (let t = 0; t <= Math.PI * 2 + 0.01; t += Math.PI / 720) {
        const rr = S * FIT * (R + amp * Math.sin(k * t + ph * Math.PI / 6) * 0.5 + 0.012 * Math.cos((k * 3) * t));
        const x = cx + rr * Math.cos(t), y = cy + rr * Math.sin(t);
        t === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
      }
      g.strokeStyle = alpha(col, a); g.lineWidth = 0.7; g.stroke();
    }
  }
}

/* ---------- линейный график на canvas ---------- */
function niceTicks(lo, hi, n) {
  const span = hi - lo || Math.abs(hi) || 1, raw = span / n, p = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map(m => m * p).find(s => span / s <= n) || 10 * p;
  const a = Math.ceil(lo / step) * step, out = [];
  for (let v = a; v <= hi + step * 1e-9; v += step) out.push(+v.toFixed(10));
  return out;
}
function lineChart(host, opt) {
  // opt: {a, b, series:[{get(i), color, width, dash, fill, name}], height, yFmt, tip(i) -> html, compact}
  host.innerHTML = '';
  const cv = document.createElement('canvas'); host.appendChild(cv);
  const tip = document.createElement('div'); tip.className = 'tip'; tip.hidden = true; host.appendChild(tip);
  const W = host.clientWidth, H = opt.height, dpr = Math.min(2, window.devicePixelRatio || 1);
  if (!W) return;   // вкладка в фоне или блок скрыт — нарисуется при показе (redrawAll)
  cv.width = W * dpr; cv.height = H * dpr; cv.style.height = H + 'px';
  const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const { a, b } = opt;
  let lo = Infinity, hi = -Infinity;
  for (const s of opt.series) for (let i = a; i <= b; i++) { const v = s.get(i); if (v == null || isNaN(v)) continue; if (v < lo) lo = v; if (v > hi) hi = v; }
  // живая точка «сейчас» стоит на своей дате — следующий день после последнего закрытия, без отступа справа;
  // у каждой серии может быть живое значение: у первой (портфель) — ex.v, у остальных — s.live
  const ex = opt.extra || null, bx = ex ? b + 1 : b;
  const liveOf = s => !ex ? null : s === opt.series[0] ? ex.v : s.live != null ? s.live : null;
  if (ex) for (const s of opt.series) { const v = liveOf(s); if (v != null) { lo = Math.min(lo, v); hi = Math.max(hi, v); } }
  if (opt.zero) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
  const pad = (hi - lo) * 0.06 || 1; lo -= pad; hi += pad;
  const ticks = niceTicks(lo, hi, opt.compact ? 3 : 5);
  g.font = '12px ' + getComputedStyle(document.body).fontFamily;
  const yLabW = opt.compact ? 0 : Math.max(...ticks.map(t => g.measureText(opt.yFmt(t)).width)) + 10;
  const L = opt.compact ? 2 : yLabW, R = opt.compact ? 2 : 10, T = 8, B = opt.compact ? 20 : 26;
  const pw = W - L - R, ph = H - T - B;
  const X = i => L + (bx === a ? 0 : (i - a) / (bx - a) * pw), Y = v => T + (hi - v) / (hi - lo) * ph;
  // сетка
  g.lineWidth = 1; g.textBaseline = 'middle'; g.fillStyle = C.muted;
  for (const t of ticks) {
    const y = Math.round(Y(t)) + .5; g.strokeStyle = t === 0 && opt.zero ? alpha(C.muted, .6) : C.rule; g.beginPath(); g.moveTo(L, y); g.lineTo(W - R, y); g.stroke();
    if (!opt.compact) { g.textAlign = 'right'; g.fillText(opt.yFmt(t), L - 8, y); }
    else { g.textAlign = 'left'; g.fillText(opt.yFmt(t), L + 4, y - 8); }
  }
  // ось дат
  const spanDays = b - a; g.textAlign = 'center'; g.textBaseline = 'alphabetic';
  const xt = [];
  if (spanDays > 900) { for (let i = a; i <= b; i++) if (days[i].endsWith('-01-01')) xt.push([i, days[i].slice(0, 4)]); }
  else if (spanDays > 200) { for (let i = a; i <= b; i++) if (days[i].endsWith('-01') && (+days[i].slice(5, 7) - 1) % 3 === 0) xt.push([i, MONS[+days[i].slice(5, 7) - 1] + (days[i].slice(5, 7) === '01' ? ' ' + days[i].slice(0, 4) : '')]); }
  else if (spanDays > 45) { for (let i = a; i <= b; i++) if (days[i].endsWith('-01')) xt.push([i, MONS[+days[i].slice(5, 7) - 1]]); }
  else { for (let i = a; i <= b; i += 7) xt.push([i, +days[i].slice(8, 10) + ' ' + MONS[+days[i].slice(5, 7) - 1]]); }
  let lastX = -1e9; const minGap = opt.compact ? 34 : 54;
  for (const [i, t] of xt) { const x = X(i); if (x - lastX < minGap || x < L + 14 || x > W - R - 14) continue; lastX = x; g.fillText(t, x, H - 6); g.strokeStyle = C.rule; g.beginPath(); g.moveTo(Math.round(x) + .5, T + ph); g.lineTo(Math.round(x) + .5, T + ph + 4); g.stroke(); }
  // серии
  const step = Math.max(1, Math.floor((b - a) / (pw * 1.5)));
  for (const s of [...opt.series].reverse()) {
    g.beginPath(); let started = false, lx = 0;
    for (let i = a; i <= b; i += (i + step > b && i !== b ? b - i : step)) { const v = s.get(i); if (v == null || isNaN(v)) { started = false; continue; } const x = X(i), y = Y(v); if (!started) { g.moveTo(x, y); started = true; } else g.lineTo(x, y); lx = x; if (i === b) break; }
    if (s.fill) {
      g.save(); const grd = g.createLinearGradient(0, T, 0, T + ph); grd.addColorStop(0, alpha(s.color, .20)); grd.addColorStop(1, alpha(s.color, 0));
      // заливка тянется и под пунктир до живой точки «сейчас», чтобы не обрываться на последнем дне
      { const lv = liveOf(s); if (lv != null && s.get(b) != null) { lx = X(bx); g.lineTo(lx, Y(lv)); } }
      g.lineTo(lx, T + ph); g.lineTo(X(a), T + ph); g.closePath(); g.fillStyle = grd; g.fill(); g.restore();
      g.beginPath(); started = false;
      for (let i = a; i <= b; i += (i + step > b && i !== b ? b - i : step)) { const v = s.get(i); if (v == null) continue; const x = X(i), y = Y(v); if (!started) { g.moveTo(x, y); started = true; } else g.lineTo(x, y); if (i === b) break; }
    }
    g.setLineDash(s.dash || []); g.strokeStyle = s.color; g.lineWidth = s.width || 1.5; g.lineJoin = 'round'; g.stroke(); g.setLineDash([]);
    // пунктир от последнего закрытия до «сейчас»
    const lv = liveOf(s), vb = s.get(b);
    if (lv != null && vb != null) { g.setLineDash(s.dash || [3, 3]); g.strokeStyle = s.color; g.lineWidth = Math.min(1.5, s.width || 1.5); g.beginPath(); g.moveTo(X(b), Y(vb)); g.lineTo(X(bx), Y(lv)); g.stroke(); g.setLineDash([]); }
  }
  // точка на конце портфеля (или живая точка «сейчас»)
  const p0 = opt.series[0], ve = p0.get(b);
  if (ex && ve != null) {
    g.beginPath(); g.arc(X(bx), Y(ex.v), 5, 0, 7); g.fillStyle = p0.color; g.fill(); g.lineWidth = 2; g.strokeStyle = C.sheet; g.stroke();
    g.beginPath(); g.arc(X(bx), Y(ex.v), 9, 0, 7); g.strokeStyle = alpha(p0.color, .35); g.lineWidth = 1.5; g.stroke();
  } else if (ve != null) { g.beginPath(); g.arc(X(b), Y(ve), 4, 0, 7); g.fillStyle = p0.color; g.fill(); g.lineWidth = 2; g.strokeStyle = C.sheet; g.stroke(); }
  const base = g.getImageData(0, 0, cv.width, cv.height);
  function hover(clientX) {
    const r = cv.getBoundingClientRect(); const x = clientX - r.left;
    if (x < L - 4 || x > W - R + 4) { leave(); return; }
    const i = Math.max(a, Math.min(bx, Math.round(a + (x - L) / pw * (bx - a))));
    g.putImageData(base, 0, 0);
    if (i > b) { const xx = Math.round(X(bx)) + .5; g.strokeStyle = alpha(C.muted, .7); g.lineWidth = 1; g.beginPath(); g.moveTo(xx, T); g.lineTo(xx, T + ph); g.stroke(); for (const s of opt.series) { const v = liveOf(s); if (v == null) continue; g.beginPath(); g.arc(X(bx), Y(v), 3.5, 0, 7); g.fillStyle = s.color; g.fill(); g.lineWidth = 2; g.strokeStyle = C.sheet; g.stroke(); } tip.innerHTML = ex.tip; tip.hidden = false; const tw = tip.offsetWidth; let left = X(bx) - tw - 14; if (left < 0) left = 0; tip.style.left = left + 'px'; tip.style.top = (opt.compact ? 0 : 8) + 'px'; return; }
    const xx = Math.round(X(i)) + .5; g.strokeStyle = alpha(C.muted, .7); g.lineWidth = 1; g.beginPath(); g.moveTo(xx, T); g.lineTo(xx, T + ph); g.stroke();
    for (const s of opt.series) { const v = s.get(i); if (v == null) continue; g.beginPath(); g.arc(X(i), Y(v), 3.5, 0, 7); g.fillStyle = s.color; g.fill(); g.lineWidth = 2; g.strokeStyle = C.sheet; g.stroke(); }
    tip.innerHTML = opt.tip(i); tip.hidden = false;
    const tw = tip.offsetWidth; let left = X(i) + 14; if (left + tw > W) left = X(i) - tw - 14; if (left < 0) left = 0;
    tip.style.left = left + 'px'; tip.style.top = (opt.compact ? 0 : 8) + 'px';
  }
  function leave() { g.putImageData(base, 0, 0); tip.hidden = true; }
  cv.addEventListener('pointermove', e => hover(e.clientX));
  cv.addEventListener('pointerdown', e => hover(e.clientX));
  cv.addEventListener('pointerleave', leave);
  cv.setAttribute('role', 'img'); cv.setAttribute('aria-label', opt.label || 'График');
}

/* ---------- столбики (SVG) ---------- */
function barChart(host, opt) {
  // opt: {cats:[label], groups:[{name,color,vals:[], stackTop?:[]}], height, yFmt, onClick(i), selected, tip(i)}
  const W = Math.max(280, host.clientWidth), H = opt.height;
  const all = []; opt.groups.forEach(gr => gr.vals.forEach((v, i) => all.push(v + (gr.top ? gr.top[i] : 0))));
  let lo = Math.min(0, ...all), hi = Math.max(0, ...all); const ticks = niceTicks(lo, hi, 4); lo = Math.min(lo, ticks[0]); hi = Math.max(hi, ticks[ticks.length - 1]);
  const L = 54, R = 6, T = 10, B = 26, pw = W - L - R, ph = H - T - B;
  const Y = v => T + (hi - v) / (hi - lo) * ph, n = opt.cats.length, cw = pw / n, ng = opt.groups.length;
  const bw = Math.min(26, (cw - 10) / ng);
  let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" aria-label="${esc(opt.label || '')}">`;
  for (const t of ticks) s += `<line x1="${L}" x2="${W - R}" y1="${Y(t)}" y2="${Y(t)}" stroke="${t === 0 ? alpha(C.muted, .7) : C.rule}" stroke-width="1"/><text x="${L - 8}" y="${Y(t) + 4}" text-anchor="end" font-size="12" fill="${C.muted}">${esc(opt.yFmt(t))}</text>`;
  opt.cats.forEach((c, i) => {
    const cx = L + cw * i + cw / 2, x0 = cx - (bw * ng + 2 * (ng - 1)) / 2;
    if (opt.selected === i) s += `<rect x="${L + cw * i + 2}" y="${T}" width="${cw - 4}" height="${ph}" rx="6" fill="${alpha(C.accent, .08)}"/>`;
    opt.groups.forEach((gr, j) => {
      const v = gr.vals[i], x = x0 + j * (bw + 2);
      const y1 = Y(Math.max(0, v)), y2 = Y(Math.min(0, v)), h = Math.max(1, y2 - y1);
      s += `<rect x="${x}" y="${y1}" width="${bw}" height="${h}" rx="3" fill="${gr.color}" opacity="${gr.opacity || 1}"/>`;
      if (gr.top) { const t = gr.top[i]; if (t > 0) s += `<rect x="${x}" y="${Y(v + t)}" width="${bw}" height="${Math.max(1, Y(v) - Y(v + t) - 2)}" rx="3" fill="${gr.color}" opacity=".32"/>`; }
    });
    s += `<text x="${cx}" y="${H - 8}" text-anchor="middle" font-size="12" fill="${opt.selected === i ? C.ink : C.muted}" ${opt.selected === i ? 'font-weight="600"' : ''}>${esc(c)}</text>`;
    s += `<rect class="hit" data-i="${i}" x="${L + cw * i}" y="${T}" width="${cw}" height="${ph + B}" fill="transparent" style="cursor:${opt.onClick ? 'pointer' : 'default'}"/>`;
  });
  s += '</svg>';
  host.innerHTML = s;
  const tip = document.createElement('div'); tip.className = 'tip'; tip.hidden = true; host.appendChild(tip);
  host.querySelectorAll('.hit').forEach(r => {
    const i = +r.dataset.i;
    const show = () => { tip.innerHTML = opt.tip(i); tip.hidden = false; const cx = (L + cw * i + cw / 2) * host.clientWidth / W; let left = cx + 12; if (left + tip.offsetWidth > host.clientWidth) left = cx - tip.offsetWidth - 12; tip.style.left = Math.max(0, left) + 'px'; tip.style.top = '0px'; };
    r.addEventListener('pointerenter', show); r.addEventListener('pointerleave', () => tip.hidden = true);
    if (opt.onClick) r.addEventListener('click', () => opt.onClick(i));
  });
}
