/* app.js — запуск: заголовок, навигация, тема, первая отрисовка, обновление цен раз в минуту.
   Новый раздел: разметка в index.html (<section class="sec" id="..." data-title="...">), свой файл js/<раздел>.js
   с функцией render…(), подключить его в index.html перед app.js и вызвать здесь в start() и, если он зависит от цен, в rerenderLive().
   Свои доработки человека лучше держать в custom.js (подключён перед app.js, обновление навыка его не трогает):
   там заполняют CUSTOM.before / start / live / redraw — списки функций, которые app.js вызывает в нужный момент. */
'use strict';

/* доработки из custom.js: before — до навигации (вставить свои разделы), start — после первой отрисовки,
   live — после новых цен, redraw — после смены темы или ширины. Ошибка в доработке не ломает страницу. */
function runCustom(stage) {
  const list = (window.CUSTOM && window.CUSTOM[stage]) || [];
  for (const fn of list) { try { fn(); } catch (e) { console.error('custom.js (' + stage + '):', e); } }
}

/* что перерисовать после новых цен */
function rerenderLive() { recompute(); renderOverview(); renderAssets(); renderChain(); renderData(); drawMini(); renderReturns(); runCustom('live'); }
/* что перерисовать после смены темы или ширины окна (графики рисуются цветами темы) */
function redrawAll() { drawGuilloche(); drawMini(); renderStruct(); renderReturns(); if (renderPayouts.draw) renderPayouts.draw(); runCustom('redraw'); }

/* ---------- навигация ---------- */
let secs = [];
function markActive() {
  let cur = secs[0]; const y = 120;
  for (const s of secs) if (s.getBoundingClientRect().top - y <= 0) cur = s;
  if ((window.innerHeight + window.scrollY) >= document.body.scrollHeight - 4) cur = secs[secs.length - 1];
  document.querySelectorAll('[data-s]').forEach(a => a.classList.toggle('on', a.dataset.s === cur.id));
  $('curSec').textContent = cur.dataset.title;
}
function initNav() {
  secs = [...document.querySelectorAll('section.sec')];
  $('nav').innerHTML = secs.map(s => `<a href="#${s.id}" data-s="${s.id}">${s.dataset.title}</a>`).join('');
  $('menu').innerHTML = $('nav').innerHTML;
  $('menuBtn').onclick = e => { const m = $('menu'); m.hidden = !m.hidden; $('menuBtn').setAttribute('aria-expanded', String(!m.hidden)); e.stopPropagation(); };
  $('menu').onclick = () => { $('menu').hidden = true; $('menuBtn').setAttribute('aria-expanded', 'false'); };
  document.addEventListener('click', e => { if (!$('menu').hidden && !$('menu').contains(e.target)) { $('menu').hidden = true; $('menuBtn').setAttribute('aria-expanded', 'false'); } });
  window.addEventListener('scroll', markActive, { passive: true });
}

/* ---------- переключатель портфеля: «Все счета», брокеры и их счета (только если счетов больше одного) ---------- */
function initPortfolioSwitch() {
  const sel = $('pfSel');
  if (!sel) return;
  if (!PF.list.length) { sel.hidden = true; return; }
  const opt = p => `<option value="${esc(p.id)}"${p.id === PF.id ? ' selected' : ''}>${esc(p.label)}</option>`;
  let html = `<option value="all"${PF.id === 'all' ? ' selected' : ''}>Все счета</option>`;
  PF.list.filter(p => !p.parent).forEach(p => {
    if (p.kind !== 'broker') { html += opt(p); return; }
    html += `<optgroup label="${esc(p.label)}">` + opt(Object.assign({}, p, { label: 'Все счета ' + p.label })) + PF.list.filter(x => x.parent === p.id).map(opt).join('') + '</optgroup>';
  });
  sel.innerHTML = html;
  sel.hidden = false;
  sel.title = 'Портфель: ' + PF.label;
  document.body.classList.add('has-pf');
  sel.onchange = () => selectPortfolio(sel.value);
}

/* ---------- тема: как в системе → светлая → тёмная ---------- */
const THEMES = ['system', 'light', 'dark'], TNAME = { system: 'как в системе', light: 'светлая', dark: 'тёмная' };
let theme = 'system';
function applyTheme() {
  if (theme === 'system') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', theme);
  $('themeLabel').textContent = ': ' + TNAME[theme]; $('themeBtn').setAttribute('aria-label', 'Тема оформления: ' + TNAME[theme]);
  readColors(); redrawAll();
}
function initTheme() {
  try { theme = localStorage.getItem('pf-theme') || 'system'; } catch (e) {}
  if (!THEMES.includes(theme)) theme = 'system';
  $('themeBtn').onclick = () => { theme = THEMES[(THEMES.indexOf(theme) + 1) % 3]; try { localStorage.setItem('pf-theme', theme); } catch (e) {} applyTheme(); };
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (theme === 'system') { readColors(); redrawAll(); } });
}

/* ---------- обновление раз в минуту ---------- */
let busy = false;
async function tick() {
  if (document.hidden || busy) return; busy = true;
  try { await Promise.all([refreshQuotes(), refreshWatch()]); } catch (e) { console.warn(e); } finally { busy = false; }
}

/* ---------- запуск ---------- */
function start() {
  if (!D || !Array.isArray(D.days) || !D.days.length || !Array.isArray(D.value)) {
    document.body.insertAdjacentHTML('afterbegin', '<p style="padding:24px">Не найден файл dashboard-data.js рядом со страницей (или в нём нет истории стоимости). Соберите данные и откройте страницу снова.</p>');
    return;
  }
  const title = D.title || 'Мой портфель';
  document.title = PF.cur ? title + ' — ' + PF.label : title; $('brand').textContent = title;
  initPortfolioSwitch();
  initCore();
  runCustom('before');
  initNav(); initTheme(); initAssets(); initReturns(); initOps(); initWatch();
  readColors();
  recompute();
  renderOverview(); renderAssets(); renderChain(); renderPayouts(); renderOps(); renderData(); renderWatch();
  runCustom('start');
  applyTheme(); markActive();
  // первый показ: сохранённые цены прошлого открытия; их нет — экран загрузки вместо цен дня сборки
  if (!loadQuoteCache()) document.body.classList.add('pf-loading');
  else rerenderLive();
  busy = true;
  Promise.all([refreshQuotes(), refreshWatch()]).catch(e => console.warn(e)).finally(() => { busy = false; document.body.classList.remove('pf-loading'); if (LIVE.state === 'error') redrawAll(); });
  setInterval(tick, 60000);
  document.addEventListener('visibilitychange', () => { if (document.hidden) return; redrawAll(); if (Date.now() - LIVE.at > 60000) tick(); });
  let rw = window.innerWidth, rt;
  window.addEventListener('resize', () => { if (window.innerWidth === rw) return; rw = window.innerWidth; clearTimeout(rt); rt = setTimeout(redrawAll, 120); });
  window.__dash = { compare, yearAgo, idxOf, setPeriod };
}
start();
