// Мини-разбор HTML-таблиц без зависимостей: все <table> документа (вложенные — отдельно), строки, ячейки
// с учётом colspan, текст ячеек без тегов. У каждой таблицы — title: последний непустой текст перед ней
// (заголовок раздела вида «Сделки купли/продажи ценных бумаг»).
import { decodeXml } from './xlsx.mjs';

const NAMED = { nbsp: ' ', laquo: '«', raquo: '»', mdash: '—', ndash: '–', minus: '−', hellip: '…', shy: '', thinsp: ' ', ensp: ' ', emsp: ' ', no: '№', numero: '№' };
export function htmlText(s) {
  return decodeXml(String(s)
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&([a-z]+);/gi, (m, e) => (e.toLowerCase() in NAMED ? NAMED[e.toLowerCase()] : m)))
    .replace(/[\s ]+/g, ' ')
    .trim();
}

// Таблицы: [{ title, rows: [[текст…]…], index }]
export function htmlTables(html) {
  const src = String(html).replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '');
  // границы таблиц с учётом вложенности
  const re = /<(\/?)table\b[^>]*>/gi;
  const stack = [], spans = [];
  let m;
  while ((m = re.exec(src))) {
    if (!m[1]) stack.push({ start: m.index, innerStart: re.lastIndex });
    else if (stack.length) {
      const t = stack.pop();
      spans.push({ start: t.start, innerStart: t.innerStart, innerEnd: m.index, end: re.lastIndex, depth: stack.length });
    }
  }
  spans.sort((a, b) => a.start - b.start);
  const tables = [];
  let prevEnd = 0;
  for (const sp of spans) {
    // внутренность без вложенных таблиц
    let inner = src.slice(sp.innerStart, sp.innerEnd);
    inner = inner.replace(/<table\b[\s\S]*<\/table>/gi, ' ');
    const rows = [];
    for (const rm of inner.matchAll(/<tr\b[^>]*>([\s\S]*?)(?=<tr\b|<\/tr>|<\/tbody>|<\/thead>|$)/gi)) {
      const cells = [];
      for (const cm of rm[1].matchAll(/<(td|th)\b([^>]*)>([\s\S]*?)(?=<td\b|<th\b|<\/tr>|$)/gi)) {
        const text = htmlText(cm[3].replace(/<\/t[dh]>[\s\S]*$/i, ''));
        const span = Number((cm[2].match(/colspan\s*=\s*["']?(\d+)/i) || [])[1]) || 1;
        cells.push(text);
        for (let k = 1; k < span; k++) cells.push('');
      }
      if (cells.length) rows.push(cells);
    }
    // заголовок: текст между концом предыдущей таблицы того же уровня и началом этой
    const seg = src.slice(Math.min(prevEnd, sp.start), sp.start);
    const title = seg.split(/<\/?(?:p|div|h\d|br|tr|td|th|li|section|header)\b[^>]*>/i).map(htmlText).filter(Boolean).pop() || '';
    tables.push({ title, rows, index: tables.length });
    if (sp.depth === 0) prevEnd = sp.end;
  }
  return tables;
}
