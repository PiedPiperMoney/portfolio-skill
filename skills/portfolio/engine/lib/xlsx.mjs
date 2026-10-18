// Мини-читатель и мини-писатель .xlsx без зависимостей (zip + XML; распаковка — zlib.inflateRawSync).
// Читает: общие строки, строки в ячейке, числа, логические, формулы (берёт сохранённое значение), даты
// (числа со стилем даты → 'ГГГГ-ММ-ДД' или 'ГГГГ-ММ-ДД ЧЧ:ММ:СС'), объединённые ячейки не разворачивает.
// Пишет (для проверок): листы из массивов строк, строки — inline или через общие строки, сжатие deflate.
// Старый .xls (двоичный формат Excel 97–2003) не читается — readXlsx бросает понятную ошибку.
import fs from 'node:fs';
import zlib from 'node:zlib';

// ---------- zip
export function unzip(buf) {
  // конец центрального каталога: подпись 0x06054b50, ищем с конца (комментарий до 64 КБ)
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('это не zip (и не .xlsx)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('битый zip: центральный каталог');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commLen;
    const lnameLen = buf.readUInt16LE(local + 26), lextraLen = buf.readUInt16LE(local + 28);
    const start = local + 30 + lnameLen + lextraLen;
    const raw = buf.subarray(start, start + csize);
    if (method === 0) files.set(name, Buffer.from(raw));
    else if (method === 8) files.set(name, zlib.inflateRawSync(raw));
    else throw new Error(`zip: сжатие ${method} не поддерживается (${name})`);
  }
  return files;
}

// ---------- XML
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export function decodeXml(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
    return ENT[e] ?? m;
  });
}
const attr = (tag, name) => {
  const m = tag.match(new RegExp(`\\s${name}="([^"]*)"`));
  return m ? decodeXml(m[1]) : null;
};
// текст из <t>…</t> (в том числе из нескольких <r><t>)
const textOf = (xml) => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t(?:\s[^>]*)?\/>/g)].map((m) => decodeXml(m[1] || '')).join('');

const colIndex = (ref) => {
  let n = 0;
  for (const ch of ref.match(/^[A-Z]+/)[0]) n = n * 26 + ch.charCodeAt(0) - 64;
  return n - 1;
};
const colName = (i) => {
  let s = '';
  for (i += 1; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  return s;
};

const DATE_BUILTIN = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);
function dateStyles(stylesXml) {
  if (!stylesXml) return [];
  const custom = {};
  for (const m of stylesXml.matchAll(/<numFmt\s[^>]*>/g)) {
    const id = Number(attr(m[0], 'numFmtId')), code = attr(m[0], 'formatCode') || '';
    // дата — если в формате есть d, m, y или h вне кавычек и скобок
    custom[id] = /[dmyh]/i.test(code.replace(/"[^"]*"|\[[^\]]*\]/g, ''));
  }
  const xfs = stylesXml.match(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/);
  if (!xfs) return [];
  return [...xfs[1].matchAll(/<xf\s[^>]*?(?:\/>|>)/g)].map((m) => {
    const id = Number(attr(m[0], 'numFmtId') || 0);
    return DATE_BUILTIN.has(id) || custom[id] === true;
  });
}
const serialToIso = (v) => {
  const ms = Date.UTC(1899, 11, 30) + Math.round(v * 864e5);
  const iso = new Date(ms).toISOString();
  return Math.abs(v - Math.round(v)) < 1e-9 ? iso.slice(0, 10) : `${iso.slice(0, 10)} ${iso.slice(11, 19)}`;
};

// Прочитать книгу: { sheets: [{ name, rows: [[значение…]…] }] }; пустые ячейки — ''
export function readXlsx(fileOrBuf) {
  const buf = Buffer.isBuffer(fileOrBuf) ? fileOrBuf : fs.readFileSync(fileOrBuf);
  if (buf.readUInt32LE(0) === 0xe011cfd0) {
    const e = new Error('это старый формат Excel (.xls) — его нужно пересохранить в .xlsx');
    e.code = 'XLS_OLD';
    throw e;
  }
  const z = unzip(buf);
  const str = (n) => (z.has(n) ? z.get(n).toString('utf8') : null);
  const shared = [];
  const sst = str('xl/sharedStrings.xml');
  if (sst) for (const m of sst.matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(textOf(m[1]));
  const isDate = dateStyles(str('xl/styles.xml'));
  const wb = str('xl/workbook.xml') || '';
  const rels = str('xl/_rels/workbook.xml.rels') || '';
  const target = {};
  for (const m of rels.matchAll(/<Relationship\s[^>]*>/g)) target[attr(m[0], 'Id')] = attr(m[0], 'Target');
  const sheets = [];
  for (const m of wb.matchAll(/<sheet\s[^>]*>/g)) {
    const name = attr(m[0], 'name');
    let t = target[attr(m[0], 'r:id')] || '';
    t = t.startsWith('/') ? t.slice(1) : `xl/${t}`;
    const xml = str(t.replace(/\/\.\//g, '/'));
    if (!xml) continue;
    const rows = [];
    for (const rm of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>|<row\b([^>]*)\/>/g)) {
      const rAttr = rm[1] || rm[3] || '';
      const rNum = Number((rAttr.match(/\sr="(\d+)"/) || [])[1]) || rows.length + 1;
      const row = [];
      for (const cm of (rm[2] || '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const a = ` ${cm[1]}`, body = cm[2] || '';
        const ref = attr(a, 'r');
        const ci = ref ? colIndex(ref) : row.length;
        const type = attr(a, 't') || 'n';
        const v = (body.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        let val = '';
        if (type === 's') val = shared[Number(v)] ?? '';
        else if (type === 'inlineStr') val = textOf(body);
        else if (type === 'str' || type === 'e') val = v != null ? decodeXml(v) : '';
        else if (type === 'b') val = v === '1';
        else if (v != null && v !== '') {
          val = Number(v);
          const s = Number(attr(a, 's') || 0);
          if (isDate[s] && Number.isFinite(val)) val = serialToIso(val);
        }
        while (row.length < ci) row.push('');
        row[ci] = val;
      }
      while (rows.length < rNum - 1) rows.push([]);
      rows[rNum - 1] = row;
    }
    sheets.push({ name, rows });
  }
  return { sheets };
}

// ---------- писатель (для проверок и образцов)
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function zip(files) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, content] of files) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const comp = zlib.deflateRawSync(data);
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nameBuf.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    locals.push(lh, nameBuf, comp);
    centrals.push(ch, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// sheets: [{ name, rows: [[…]] }]; значение { date: 'ГГГГ-ММ-ДД' } пишется числом со стилем даты
export function writeXlsx(sheets, { sharedStrings = true } = {}) {
  const sst = [], sstIdx = new Map();
  const sIndex = (s) => { if (!sstIdx.has(s)) { sstIdx.set(s, sst.length); sst.push(s); } return sstIdx.get(s); };
  const sheetXml = (rows) => {
    const out = [];
    rows.forEach((row, r) => {
      const cells = [];
      row.forEach((v, c) => {
        if (v === '' || v == null) return;
        const ref = `${colName(c)}${r + 1}`;
        if (typeof v === 'number') cells.push(`<c r="${ref}"><v>${v}</v></c>`);
        else if (typeof v === 'boolean') cells.push(`<c r="${ref}" t="b"><v>${v ? 1 : 0}</v></c>`);
        else if (v && typeof v === 'object' && v.date) {
          const serial = (Date.parse(`${v.date.slice(0, 10)}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 864e5;
          cells.push(`<c r="${ref}" s="1"><v>${serial}</v></c>`);
        } else if (sharedStrings) cells.push(`<c r="${ref}" t="s"><v>${sIndex(String(v))}</v></c>`);
        else cells.push(`<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`);
      });
      out.push(`<row r="${r + 1}">${cells.join('')}</row>`);
    });
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${out.join('')}</sheetData></worksheet>`;
  };
  const files = [];
  sheets.forEach((s, i) => files.push([`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s.rows)]));
  files.unshift(['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sharedStrings ? '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>' : ''}</Types>`]);
  files.push(['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>']);
  files.push(['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`]);
  files.push(['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>${sharedStrings ? `<Relationship Id="rId${sheets.length + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>` : ''}</Relationships>`]);
  files.push(['xl/styles.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="dd\\.mm\\.yyyy"/></numFmts><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="164" applyNumberFormat="1"/></cellXfs></styleSheet>']);
  if (sharedStrings) files.push(['xl/sharedStrings.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${sst.length}" uniqueCount="${sst.length}">${sst.map((s) => `<si><t xml:space="preserve">${esc(s)}</t></si>`).join('')}</sst>`]);
  return zip(files);
}
