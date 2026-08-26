// impact-check：改后 diff 对账。零依赖。
// 客观事实源=git diff（由命令层传入 diffText），对账「实际改动」vs「04/05 预测的影响面」。
// 解决翻车「改多了 / 波及了没预料的模块」：把实际改动 + 符号级反向调用方 顶到台面，
// 与 impact.md/fix-plan.md 文本交叉核对，红字标出「计划外改动」「未覆盖波及」。
// 边界：符号级 grep 是启发式，抓不到动态/反射/跨端调用 → 明确交 08 verify 兜底。
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, extname, basename } from 'node:path';

const SKIP = new Set(['node_modules', '.git', '.agent', 'dist', 'build', '.next', 'miniprogram_npm', 'coverage', '.vscode', '.idea']);
const CODE = new Set(['.js', '.ts', '.mjs', '.cjs', '.jsx', '.tsx', '.vue', '.wxml']);
// 抽符号时要剔除的关键字/常见噪音（避免把控制流当成符号）
const STOP = new Set([
  'if', 'for', 'while', 'switch', 'return', 'function', 'const', 'let', 'var', 'async', 'await',
  'export', 'import', 'default', 'new', 'typeof', 'this', 'true', 'false', 'null', 'undefined',
  'class', 'extends', 'try', 'catch', 'throw', 'case', 'break', 'continue', 'else', 'in', 'of',
]);

// ---------- 从 unified diff 抽改动文件 + 触碰的顶层符号 ----------
export function extractChanges(diffText) {
  const files = [];
  let cur = null;
  const lines = String(diffText || '').split('\n');
  for (const raw of lines) {
    const gitHdr = raw.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (gitHdr) {
      if (cur) files.push(finalizeFile(cur));
      cur = { path: gitHdr[2], added: 0, removed: 0, _syms: new Set() };
      continue;
    }
    if (!cur) continue;
    if (raw.startsWith('+++') || raw.startsWith('---')) continue; // 文件头，非内容
    if (raw.startsWith('+') || raw.startsWith('-')) {
      const isAdd = raw[0] === '+';
      if (isAdd) cur.added++; else cur.removed++;
      for (const s of symbolsInLine(raw.slice(1))) cur._syms.add(s);
    }
  }
  if (cur) files.push(finalizeFile(cur));
  return files;
}

function finalizeFile(f) {
  return { path: f.path, added: f.added, removed: f.removed, symbols: [...f._syms].sort() };
}

// 从一行代码抽「被定义的顶层符号名」。宁缺毋滥：只认明确的定义形态。
function symbolsInLine(line) {
  const out = new Set();
  const push = (n) => { if (n && n.length > 2 && !STOP.has(n) && /^[A-Za-z_$][\w$]*$/.test(n)) out.add(n); };
  let m;
  // function foo( / async function foo(
  const reFn = /\bfunction\s+([A-Za-z_$][\w$]*)/g;
  while ((m = reFn.exec(line))) push(m[1]);
  // const/let/var foo =
  const reVar = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g;
  while ((m = reVar.exec(line))) push(m[1]);
  // exports.foo = / module.exports.foo =
  const reExp = /\b(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=/g;
  while ((m = reExp.exec(line))) push(m[1]);
  // 对象方法/class 方法：  foo( ... ) {   或   foo: function / foo: (
  const reMethod = /^\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^;=]*\)\s*\{/;
  if ((m = line.match(reMethod))) push(m[1]);
  const reProp = /^\s*([A-Za-z_$][\w$]*)\s*:\s*(?:async\s+)?(?:function\b|\()/;
  if ((m = line.match(reProp))) push(m[1]);
  return out;
}

// ---------- 反向依赖：全库 grep 符号的调用方（排除改动文件自身）----------
function walk(dir, root, acc, depth = 0) {
  let ents;
  try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (e.name.startsWith('.') && e.name !== '.') continue;
    if (SKIP.has(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) { if (depth < 8) walk(full, root, acc, depth + 1); }
    else if (e.isFile() && CODE.has(extname(e.name))) acc.push(relative(root, full));
  }
}

// symbols: string[]；excludeFiles: 改动文件的 repo 相对路径集合（不算自我调用）
// 返回 { sym: [callerRelPath...] }
export function findCallers(root, symbols, excludeFiles = []) {
  const result = {};
  const syms = [...new Set(symbols)].filter((s) => s && s.length > 2 && !STOP.has(s));
  if (!syms.length) return result;
  const exclude = new Set(excludeFiles);
  const codeFiles = [];
  walk(root, root, codeFiles);
  const res = syms.map((s) => ({ s, re: new RegExp(`\\b${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`) }));
  for (const rel of codeFiles) {
    if (exclude.has(rel)) continue;
    let src;
    try { src = readFileSync(join(root, rel), 'utf8'); } catch { continue; }
    for (const { s, re } of res) {
      if (re.test(src)) (result[s] || (result[s] = [])).push(rel);
    }
  }
  return result;
}

// ---------- 对账：实际改动 / 波及 vs 预测文本 ----------
// 文本「提到」某文件：以 basename 出现为准（路径写法可能不同，basename 最稳）。
function mentions(text, filePath) {
  if (!text) return false;
  const base = basename(filePath);
  return text.includes(filePath) || (base.length > 2 && text.includes(base));
}

export function reconcile({ changedFiles = [], callers = {}, planText = '', impactText = '' }) {
  const planAll = `${planText}\n${impactText}`;
  // 越界：改了但计划(fix-plan)+影响面(impact) 都没提到 → 计划外改动
  const outOfScope = changedFiles.filter((f) => !mentions(planAll, f));
  // 漏测：符号的调用方文件不在 impact 回归清单文本里 → 波及未覆盖
  const uncoveredCallers = [];
  const seen = new Set();
  for (const [sym, files] of Object.entries(callers)) {
    for (const f of files) {
      if (mentions(impactText, f)) continue;
      const k = `${sym}::${f}`;
      if (seen.has(k)) continue;
      seen.add(k);
      uncoveredCallers.push({ sym, file: f });
    }
  }
  return { outOfScope, uncoveredCallers };
}

// ---------- 组装对账报告 + 统计 ----------
export function buildImpactCheck({ root, diffText, planText = '', impactText = '', bugId = '', base = 'HEAD' }) {
  const changes = extractChanges(diffText);
  const changedFiles = changes.map((c) => c.path);
  const allSymbols = [...new Set(changes.flatMap((c) => c.symbols))];
  const callers = findCallers(root, allSymbols, changedFiles);
  const { outOfScope, uncoveredCallers } = reconcile({ changedFiles, callers, planText, impactText });
  const callerCount = Object.values(callers).reduce((n, a) => n + a.length, 0);

  const L = [];
  L.push(`# 影响面对账（impact-check）— ${bugId || '(未命名 bug)'}`, '');
  L.push(`> 基线 \`${base}\`　客观事实源：git diff。本报告把「实际改动」与「04 影响面 / 05 方案」交叉核对。`, '');
  if (!planText && !impactText) L.push('> ⚠ 未读到 fix-plan.md / impact.md 文本，本次只列客观改动，越界/漏测判定跳过——请补齐计划文本后重跑。', '');

  L.push('## 一、实际改动（git diff 客观事实）');
  if (!changes.length) L.push('- （未检测到改动——先完成 06 fix，或检查 --base）');
  for (const c of changes) {
    const syms = c.symbols.length ? `　触碰符号：${c.symbols.join(', ')}` : '';
    L.push(`- ${c.path}（+${c.added} -${c.removed}）${syms}`);
  }
  L.push('');

  L.push('## 二、计划外改动（⚠ 可能「改多了」）');
  if (!outOfScope.length) L.push('- ✓ 无：所有改动文件都在 fix-plan/impact 提及范围内。');
  else for (const f of outOfScope) L.push(`- ⚠ ${f}　—— fix-plan/impact 都没提到它，请确认是否越界；不必要则撤除（外科式修改）。`);
  L.push('');

  L.push('## 三、反向依赖波及（符号级，启发式）');
  if (!allSymbols.length) L.push('- （diff 未抽出顶层符号，跳过反向依赖）');
  else if (!callerCount) L.push('- 未发现静态调用方（注意：动态/反射/跨端调用抓不到，见第四节）。');
  else {
    for (const [sym, files] of Object.entries(callers)) {
      L.push(`- \`${sym}\` ← 被 ${files.join('、')} 调用`);
    }
    if (uncoveredCallers.length) {
      L.push('', '  其中 ⚠ 调用方**不在 impact 回归清单**里（可能漏测）：');
      for (const u of uncoveredCallers) L.push(`  - ⚠ ${u.file}（因改动 \`${u.sym}\`）→ 补进回归清单，或说明为何无需回归。`);
    } else {
      L.push('', '  ✓ 全部调用方都已在 impact 回归清单覆盖。');
    }
  }
  L.push('');

  L.push('## 四、诚实边界（本命令抓不到，交 08 verify 兜底）');
  L.push('- 动态/反射调用（`this[m]()`、eventBus.emit）、跨端/云边界（页面→云函数→DB/三方）、配置驱动分支、数据形状问题——静态 grep 一律看不到。');
  L.push('- 因此第三节「未发现调用方」**不等于**「无影响」；最终以 08 双轨验证真跑为准。');
  L.push('');

  L.push('## 五、逐条核对结论（AI 填，过门条件）');
  L.push('- [ ] 第二节每处「计划外改动」已逐条确认必要，或已撤除。');
  L.push('- [ ] 第三节每处「未覆盖波及」已补进 impact 回归清单，或已说明无需回归。');
  L.push('- [ ] 剩余不确定项已在此列明，交 08 verify 真跑覆盖。');
  L.push('');

  return {
    markdown: L.join('\n'),
    stats: {
      changedFiles: changedFiles.length,
      symbols: allSymbols.length,
      callers: callerCount,
      outOfScope: outOfScope.length,
      uncoveredCallers: uncoveredCallers.length,
    },
  };
}
