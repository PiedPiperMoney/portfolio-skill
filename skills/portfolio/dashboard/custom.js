/* custom.js — свои доработки дашборда. Этот файл ваш: обновление навыка его не перезаписывает.
   Подключён в index.html перед js/app.js; всё из js/*.js (D, P, TOTAL, rub, pct, esc, $ и т. д.) уже доступно.
   Функции в списках app.js вызывает сам:
     before — до построения меню: вставить разметку своих разделов (<section class="sec" id="..." data-title="...">);
     start  — после первой отрисовки;  live — после новых цен;  redraw — после смены темы или ширины окна.
   Пример:
     CUSTOM.before.push(() => document.querySelector('main').insertAdjacentHTML('beforeend',
       '<section class="sec" id="goal" data-title="Цель"><div class="sec-head"><h2>Цель</h2></div><div class="panel" id="goalBox"></div></section>'));
     CUSTOM.start.push(renderGoal); CUSTOM.live.push(renderGoal);
     function renderGoal() { $('goalBox').innerHTML = '<p>Стоимость: ' + rub(TOTAL) + '</p>'; }
*/
'use strict';
window.CUSTOM = { before: [], start: [], live: [], redraw: [] };
