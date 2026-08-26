// bug import：把在线/离线 Excel·Word·CSV·JSON 的 bug 清单归一化成结构化台账。
// 零依赖：xlsx/docx 是 zip，用 node:zlib inflateRawSync 手工解压，正则抽 XML 文本。
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { inflateRawSync } from 'node:zlib';

// ---------- 极简 unzip：读中央目录，取指定条目并解压 ----------
function unzip(buf) {
  // 找 EOCD (PK\x05\x06)，从尾部回扫
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 65536; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw Object.assign(new Error('不是合法 zip（xlsx/docx 损坏？）'), { code: 'EZIP' });
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = {};
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    entries[name] = { method, compSize, localOff };
    off += 46 + nameLen + extraLen + commentLen;
  }
  return {
    read(name) {
      const e = entries[name];
      if (!e) return null;
      // 本地头：跳过 name+extra 到 data 起点
      const lNameLen = buf.readUInt16LE(e.localOff + 26);
      const lExtraLen = buf.readUInt16LE(e.localOff + 28);
      const start = e.localOff + 30 + lNameLen + lExtraLen;
      const data = buf.subarray(start, start + e.compSize);
      const out = e.method === 0 ? data : inflateRawSync(data);
      return out.toString('utf8');
    },
    names: Object.keys(entries),
  };
}

const xmlText = (s) => s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").trim();
const colToNum = (r) => { const m = r.match(/^[A-Z]+/); let n = 0; for (const c of (m ? m[0] : 'A')) n = n * 26 + (c.charCodeAt(0) - 64); return n - 1; };

// ---------- xlsx → 二维表 ----------
function parseXlsx(buf) {
  const zip = unzip(buf);
  // sharedStrings
  const shared = [];
  const ss = zip.read('xl/sharedStrings.xml');
  if (ss) for (const si of ss.match(/<si>[\s\S]*?<\/si>/g) || []) {
    const t = (si.match(/<t[^>]*>([\s\S]*?)<\/t>/g) || []).map(xmlText).join('');
    shared.push(t);
  }
  // 第一张表
  const sheetName = zip.names.find((n) => /^xl\/worksheets\/sheet1\.xml$/.test(n)) || zip.names.find((n) => /^xl\/worksheets\/.*\.xml$/.test(n));
  const sheet = sheetName ? zip.read(sheetName) : null;
  if (!sheet) return [];
  const rows = [];
  for (const rowXml of sheet.match(/<row[\s\S]*?<\/row>/g) || []) {
    const cells = [];
    for (const c of rowXml.match(/<c\b[^>]*(?:\/>|>[\s\S]*?<\/c>)/g) || []) {
      const rAttr = (c.match(/r="([A-Z]+\d+)"/) || [])[1] || 'A1';
      const isStr = /t="s"/.test(c);
      const inline = /t="inlineStr"/.test(c);
      let val = '';
      if (inline) val = (c.match(/<t[^>]*>([\s\S]*?)<\/t>/g) || []).map(xmlText).join('');
      else { const v = c.match(/<v>([\s\S]*?)<\/v>/); if (v) val = isStr ? (shared[Number(v[1])] || '') : v[1]; }
      cells[colToNum(rAttr)] = val;
    }
    rows.push(cells);
  }
  return rows;
}

// ---------- docx → 二维表（优先第一张表格；否则空）----------
function parseDocx(buf) {
  const zip = unzip(buf);
  const doc = zip.read('word/document.xml');
  if (!doc) return [];
  const tbl = (doc.match(/<w:tbl>[\s\S]*?<\/w:tbl>/) || [])[0];
  if (!tbl) return [];
  const rows = [];
  for (const tr of tbl.match(/<w:tr\b[\s\S]*?<\/w:tr>/g) || []) {
    const cells = [];
    for (const tc of tr.match(/<w:tc\b[\s\S]*?<\/w:tc>/g) || []) {
      const t = (tc.match(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g) || []).map(xmlText).join('');
      cells.push(t);
    }
    rows.push(cells);
  }
  return rows;
}

// ---------- CSV → 二维表 ----------
function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => (c || '').trim()));
}

// ---------- 表头列名 → bug 字段（中英模糊匹配）----------
function mapHeader(h) {
  const s = String(h || '').toLowerCase().replace(/\s/g, '');
  if (/(编号|序号|id|no\.?|编码)/.test(s)) return 'id';
  if (/(描述|标题|现象|问题|内容|title|summary|desc|bug)/.test(s)) return 'title';
  if (/(复现|重现|步骤|repro|step)/.test(s)) return 'repro';
  if (/(期望|预期|应该|expect)/.test(s)) return 'expected';
  if (/(实际|actual)/.test(s)) return 'actual';
  if (/(严重|优先级|级别|severity|priority|p[0-3])/.test(s)) return 'severity';
  if (/(模块|module)/.test(s)) return 'module';
  if (/(页面|page)/.test(s)) return 'page';
  if (/(端|平台|platform)/.test(s)) return 'platform';
  if (/(状态|status)/.test(s)) return 'status';
  if (/(提出人|报告人|创建人|提交人|reporter|author)/.test(s)) return 'reporter';
  return null;
}

function rowsToBugs(rows) {
  if (!rows.length) return { bugs: [], warnings: ['空表'] };
  const header = rows[0];
  const map = header.map(mapHeader);
  const hasHeader = map.some(Boolean);
  const warnings = [];
  if (!hasHeader) warnings.push('未识别表头列名，按位置回退：第1列=id/title，其余进 raw');
  const bugs = [];
  const body = hasHeader ? rows.slice(1) : rows;
  let bugSeq = 1;

  body.forEach((r) => {
    if (!r.some((c) => (c || '').trim())) return;
    const bug = { id: '', title: '', repro: '', expected: '', actual: '', severity: '', module: '', page: '', platform: '', status: '', reporter: '', raw: {} };
    r.forEach((val, ci) => {
      const key = hasHeader ? map[ci] : (ci === 0 ? 'title' : null);
      const col = header[ci] || `col${ci}`;
      const textVal = String(val || '').trim();
      if (key && !bug[key]) bug[key] = textVal;
      if (hasHeader && col) bug.raw[col] = textVal;
    });

    const statusVal = (bug.status || bug.raw['状态'] || '').trim();
    // 过滤排除已完成/已验收/已关闭状态（根据用户明确规则：仅待修复、待开发等为真实待处理 Bug）
    if (/(已验收|已完成|已关闭|已解决|已退回)/.test(statusVal)) {
      return;
    }

    bug.status = statusVal || '待修复';

    // 模块与页面组合平台标识
    const mod = bug.module || bug.raw['模块'] || '';
    const pg = bug.page || bug.raw['页面'] || '';
    const platParts = [mod, pg].filter(Boolean);
    bug.platform = platParts.length ? platParts.join(' / ') : (bug.platform || bug.raw['端'] || bug.raw['平台'] || '常规');
    bug.module = mod;
    bug.page = pg;
    bug.reporter = bug.reporter || bug.raw['提出人'] || '';
    bug.severity = bug.severity || bug.raw['优先级'] || '';

    if (!bug.id) bug.id = `BUG-${String(bugSeq++).padStart(3, '0')}`;
    if (!bug.title) bug.title = Object.values(bug.raw)[0] || bug.id;
    bugs.push(bug);
  });
  return { bugs, warnings };
}

export function importBugs(filePath) {
  const ext = extname(filePath).toLowerCase();
  if (ext === '.json') {
    const j = JSON.parse(readFileSync(filePath, 'utf8'));
    const arr = Array.isArray(j) ? j : (j.bugs || []);
    return { bugs: arr, warnings: [] };
  }
  let rows;
  if (ext === '.xlsx') rows = parseXlsx(readFileSync(filePath));
  else if (ext === '.docx') rows = parseDocx(readFileSync(filePath));
  else if (ext === '.csv') rows = parseCsv(readFileSync(filePath, 'utf8'));
  else throw Object.assign(new Error(`不支持的格式：${ext}（支持 .xlsx/.docx/.csv/.json；在线文档先导出本地或用 web-access 抓成 csv）`), { code: 'EFORMAT' });
  return rowsToBugs(rows);
}

