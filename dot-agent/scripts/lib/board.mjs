// 看板渲染：把 process.json + 运行时状态 + 产物磁盘回读 + 记忆全景 渲染成一份自包含 HTML。
// 双 tab 解耦：① 流程·进度（地铁线/产物总账/skill/纪律）② 记忆·记得住（真实记忆全景）。
// 零依赖，纯字符串拼接，样式内联，切换用内联 JS。产物真源=磁盘。

import { existsSync } from 'node:fs';
import { relative, resolve, isAbsolute, sep } from 'node:path';
import { computeNext, computePhaseView } from './process.mjs';
import { memoryDetail } from './stats.mjs';
import { detectSkill, skillBadge } from './skills.mjs';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// 把产物/引用路径算成「相对 board.html 所在目录」的可点击链接地址；异常返回 null。
function toHref(target, outDir, cwd) {
  try {
    const abs = isAbsolute(target) ? target : resolve(cwd, target);
    const rel = (relative(outDir, abs) || target).split(sep).join('/');
    return encodeURI(rel);
  } catch { return null; }
}
// 产物路径：磁盘上真实存在才给链接，否则纯文本（缺失态由 diskMark 另标）。
function pathLink(target, { outDir, cwd, onDisk }) {
  if (!target) return '';
  if (!onDisk) return esc(target);
  const href = toHref(target, outDir, cwd);
  return href ? `<a href="${esc(href)}">${esc(target)}</a>` : esc(target);
}
// 任务引用：形如 "输入:docs/x" 或 "docs/x"；路径在磁盘上就给链接，含 <sys> 占位的模板路径自然降级纯文本。
function refLink(ref, { outDir, cwd }) {
  const i = ref.indexOf(':');
  const label = i > 0 ? ref.slice(0, i) : '';
  const path = i > 0 ? ref.slice(i + 1) : ref;
  let onDisk = false;
  try { onDisk = existsSync(resolve(cwd, path)); } catch { onDisk = false; }
  const href = onDisk ? toHref(path, outDir, cwd) : null;
  const body = href ? `<a href="${esc(href)}">${esc(path)}</a>` : esc(path);
  return label ? `<span class="reflab">${esc(label)}</span> ${body}` : body;
}

const STATUS_LABEL = {
  not_started: '未开始', planned: '待开始', in_progress: '进行中',
  verifying: '验证中', blocked: '阻塞', completed: '已完成', cancelled: '已取消',
};
const STATUS_COLOR = {
  not_started: '#8a97a5', planned: '#8a97a5', in_progress: '#a87518',
  verifying: '#2b7fb0', blocked: '#aa4638', completed: '#15664e', cancelled: '#8a97a5',
};
const EVENT_LABEL = {
  task_created: '建任务', step_started: '开步骤', artifact_written: '记产物/证据',
  verification_started: '开始验证', verification_finished: '验证完成', decision_recorded: '记决策',
  step_committed: '提交步骤', step_failed: '步骤失败', task_blocked: '阻塞',
  task_completed: '任务完成', checkpoint_created: '存档', recovery_performed: '恢复',
};
const dt = (s) => (s ? esc(s.slice(0, 19).replace('T', ' ')) : '—');

function diskMark(v) {
  if (v.on_disk) return '<span style="color:#15664e;font-weight:700">✓ 在磁盘</span>';
  if (v.registered) return '<span style="color:#aa4638;font-weight:700">✗ 已登记但缺失</span>';
  return '<span style="color:#8a97a5">— 未产出</span>';
}
function badge(status) {
  const c = STATUS_COLOR[status] || '#8a97a5';
  return `<span class="badge" style="color:${c};border-color:${c}">${STATUS_LABEL[status] || status}</span>`;
}

export function buildBoardHtml(p, state, { cwd = process.cwd(), generatedAt = new Date().toISOString(), outDir } = {}) {
  const linkDir = outDir || cwd;
  const phases = p.phases || [];
  const views = phases.map((ph) => computePhaseView(ph, state));
  const next = computeNext(p, state);
  const mem = memoryDetail();
  const doneCount = views.filter((v) => v.status === 'completed').length;

  // 读 bugs.json 计算 Bug 统计
  let bugCount = 0, bugPendingFix = 0, bugPendingDev = 0, bugPendingConfirm = 0, bugHigh = 0;
  try {
    const bugsPath = resolve(cwd, '.agent/bugs.json');
    if (existsSync(bugsPath)) {
      const bList = JSON.parse(readFileSync(bugsPath, 'utf8'));
      const bugs = Array.isArray(bList) ? bList : (bList.bugs || []);
      bugCount = bugs.length;
      bugPendingFix = bugs.filter((b) => (b.status || b.raw?.['状态']) === '待修复').length;
      bugPendingDev = bugs.filter((b) => (b.status || b.raw?.['状态']) === '待开发').length;
      bugPendingConfirm = bugs.filter((b) => (b.status || b.raw?.['状态']) === '待确认').length;
      bugHigh = bugs.filter((b) => (b.severity || b.raw?.['优先级']) === '高' || b.severity === 'P1').length;
    }
  } catch { /* ignore */ }

  // ===== 重点展示 Bug 报告 Banner =====
  const reportHero = `
  <div class="report-hero">
    <div class="rh-left">
      <div class="rh-tag">🔥 核心关键报告</div>
      <h2>🐞 Bug 深度分析与修复报告 (reports/index.html)</h2>
      <p class="rh-desc">已归一化 <b>${bugCount}</b> 条真实待修复/待开发 Bug，涵盖现象分析、影响面评估与修复方案设计。</p>
    </div>
    <div class="rh-right">
      <div class="rh-stats">
        <div class="rhs-item red"><b>${bugPendingFix}</b><span>🔴 待修复</span></div>
        <div class="rhs-item amber"><b>${bugPendingDev}</b><span>🟡 待开发</span></div>
        <div class="rhs-item blue"><b>${bugPendingConfirm}</b><span>🔵 待确认</span></div>
        <div class="rhs-item high"><b>${bugHigh}</b><span>🔥 高优先级</span></div>
      </div>
      <a href="reports/index.html" target="_blank" class="rh-btn">📄 打开 Bug 深度分析报告 (reports/index.html) ↗</a>
    </div>
  </div>`;

  // ===== 流程 tab =====
  const nextBar = `
  <div class="nextbar">
    <span class="nb-k">下一步</span>
    <span class="nb-hint">${esc(next.hint)}</span>
    ${next.skills && next.skills.length ? `<span class="nb-sk">skill：${esc(next.skills.join(' / '))}</span>` : ''}
  </div>`;

  const stops = views.map((v) => {
    const cur = state.current_phase === v.phase.id;
    const col = STATUS_COLOR[v.status] || '#8a97a5';
    const done = v.artifacts.filter((a) => a.on_disk).length;
    return `
      <div class="stop${cur ? ' cur' : ''}">
        <div class="dot" style="border-color:${col};color:${col}">${esc(v.phase.icon || v.phase.no || '')}</div>
        <div class="no">${esc(v.phase.no || '')}</div>
        <div class="nm">${esc(v.phase.name)}</div>
        <div class="st" style="color:${col}">${STATUS_LABEL[v.status] || v.status}</div>
        <div class="ct">产物 ${done}/${v.artifacts.length}</div>
        ${cur ? '<div class="here">← 你在这</div>' : ''}
      </div>`;
  }).join('');

  const inputsCell = (ph) => {
    const ins = ph.inputs || [];
    if (!ins.length) return '';
    return `<div class="ins"><span class="inslab">输入真源</span>${ins.map((i) => `<div class="inrow">${esc(i.name)}<span class="path"> ${esc(i.path)}</span></div>`).join('')}</div>`;
  };
  const rows = views.map((v) => v.artifacts.map((a, i) => {
    const isReport = a.target_path && a.target_path.includes('reports/index.html');
    return `
      <tr${isReport ? ' style="background:#edf7f3;"' : ''}>
        ${i === 0 ? `<td rowspan="${v.artifacts.length}"><b>${esc(v.phase.no || '')} ${esc(v.phase.name)}</b>${inputsCell(v.phase)}</td>` : ''}
        <td>${esc(a.name)}${isReport ? ' <span class="report-badge">⭐ 重点报告</span>' : (a.required ? '' : ' <span class="opt">(可选)</span>')}</td>
        <td>${esc(a.desc)}</td>
        <td class="path">${pathLink(a.target_path, { outDir: linkDir, cwd, onDisk: a.on_disk })}</td>
        <td>${diskMark(a)}</td>
      </tr>`;
  }).join('')).join('');

  const skillSet = new Map();
  for (const ph of phases) for (const s of (ph.skills || [])) if (!skillSet.has(s)) skillSet.set(s, detectSkill(s, { cwd }));
  const bandRows = phases.map((ph) => {
    const sks = (ph.skills || []).map((s) => {
      const stt = skillSet.get(s);
      const c = stt === 'installed' ? '#15664e' : stt === 'not_found' ? '#aa4638' : '#8a97a5';
      return `<span class="skpill" style="border-color:${c};color:${c}">${esc(s)} ${skillBadge(stt)}</span>`;
    }).join(' ');
    return `<div class="bandrow"><span class="bp">${esc(ph.no || '')} ${esc(ph.name)}</span><span class="bs">${sks || '<span class="dim">（未绑定 skill）</span>'}</span></div>`;
  }).join('');

  const rails = (p.rails || []).map((r) => `
    <div class="rail"><h3>${esc(r.name)}</h3><p>${esc(r.desc || '')}</p></div>`).join('');

  // ===== 开发任务清单 · 逐系统（页面契约之后，按系统铺开标准开发任务）=====
  const worklistPhase = phases.find((ph) => (ph.worklist || []).length);
  const systems = state.systems || [];
  let worklistPanel = '';
  if (worklistPhase && systems.length) {
    const wl = worklistPhase.worklist;
    const head = wl.map((w) => `<th title="${esc(w.desc || '')}">${esc(w.name)}</th>`).join('');
    const bodyRows = systems.map((s) => {
      const byKey = Object.fromEntries((s.tasks || []).map((t) => [t.key, t.status]));
      const cells = wl.map((w) => {
        const stt = byKey[w.key] || 'not_started';
        const c = STATUS_COLOR[stt] || '#8a97a5';
        return `<td><span class="wlcell" style="color:${c};border-color:${c}">${STATUS_LABEL[stt] || stt}</span></td>`;
      }).join('');
      const dc = wl.filter((w) => byKey[w.key] === 'completed').length;
      return `<tr><td class="wlsys"><b>${esc(s.name)}</b> <span class="wlprog">${dc}/${wl.length}</span></td>${cells}</tr>`;
    }).join('');
    worklistPanel = `
  <h2>开发任务清单 · 逐系统（${esc(worklistPhase.no || '')} ${esc(worklistPhase.name)}）</h2>
  <p class="lede">页面契约确定后按系统铺开：每个系统一套标准开发任务，状态随提交更新。</p>
  <div class="wlwrap"><table class="wl"><thead><tr><th>系统</th>${head}</tr></thead><tbody>${bodyRows}</tbody></table></div>`;
  }

  const flowPanel = `
  ${nextBar}
  <h2>开发生命周期 · 地铁线</h2>
  <div class="metro">${stops}</div>
  ${worklistPanel}
  <h2>产出物总账 · 是什么 / 在哪 / 磁盘状态</h2>
  <table class="acct">
    <thead><tr><th>阶段</th><th>产出物</th><th>是什么</th><th>期望路径</th><th>磁盘</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <h2>skill 归属带 · 每阶段该调哪个 skill（是否已装）</h2>
  <div class="band">${bandRows}</div>
  <h2>贯穿纪律</h2>
  <div class="rails">${rails || '<div class="rail"><p class="dim">（未定义纪律带）</p></div>'}</div>`;

  // ===== Bug 深度报告 tab =====
  const reportPanel = `
  <div class="rep-panel-header">
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;margin-bottom:12px;">
      <h2 style="border-top:0;padding-top:0;margin:0;">🩹 Bug 深度分析与修复报告 (reports/index.html)</h2>
      <a href="reports/index.html" target="_blank" class="rh-btn">📄 全屏新页面打开报告 ↗</a>
    </div>
    <p class="lede">以下为 <code>.agent/reports/index.html</code> 实时报告预览。数据源于 <code>.agent/bugs.json</code> 归一化的真实待处理 Bug。</p>
  </div>
  <div class="iframe-container">
    <iframe src="reports/index.html" class="report-iframe" title="Bug深度分析与修复报告"></iframe>
  </div>`;

  // ===== 记忆 tab =====
  const memState = `<div class="memstate ${mem.invoked ? 'ok' : 'warn'}">${mem.invoked
    ? '✅ 记忆在被调用（journal 有事件在累积，机制真在生效）'
    : '⚠️ 机制已装好，但 journal 还是空的 —— 还没有人/AI 真正调用记忆（走 start-step / commit-step / artifact add 才会记）'}</div>`;

  const stat = (n, l) => `<div class="stat"><b>${n}</b><span>${l}</span></div>`;
  const statGrid = `
  <div class="statgrid">
    ${stat(mem.taskCount, '任务')}
    ${stat(mem.eventCount, 'journal 事件')}
    ${stat(mem.decisions.length, '决策')}
    ${stat(mem.evidenceCount, '证据')}
    ${stat(mem.checkpointCount, 'checkpoint')}
    ${stat(mem.interruptedCount, '中断步骤')}
    ${stat(mem.failed.length, '失败步骤')}
    ${stat(dt(mem.lastAt), '最后写入')}
  </div>
  <p class="span">记忆覆盖：${dt(mem.firstAt)} → ${dt(mem.lastAt)}${mem.activeTaskId ? ` · 当前活动任务 <code>${esc(mem.activeTaskId)}</code>` : ''}</p>`;

  const evEntries = Object.entries(mem.eventsByType).sort((a, b) => b[1] - a[1]);
  const evDist = evEntries.length
    ? `<div class="pills">${evEntries.map(([k, n]) => `<span class="evpill"><b>${n}</b> ${EVENT_LABEL[k] || esc(k)}</span>`).join('')}</div>`
    : '<p class="dim">（暂无事件）</p>';

  const taskCards = mem.tasks.length ? `<div class="tcards">${mem.tasks.map((t) => `
    <div class="tcard">
      <div class="tc-h">${badge(t.status)} <b>${esc(t.id)}</b>${t.id === mem.activeTaskId ? ' <span class="cur-tag">活动</span>' : ''}</div>
      <div class="tc-o">${esc(t.objective)}</div>
      <div class="tc-m">阶段 <b>${esc(t.phase)}</b> · v${t.version} · DoD ${t.dodMet}/${t.dodTotal}</div>
      ${t.dod && t.dod.length ? `<div class="tc-plan"><div class="plan-h">阶段验收 DoD · ${t.dodMet}/${t.dodTotal}</div>${t.dod.map((d) => `<div class="planrow${d.met ? ' done' : ''}"><span class="ck">${d.met ? '✓' : '○'}</span>${esc(d.text)}</div>`).join('')}</div>` : ''}
      ${t.openStep ? `<div class="tc-open">▸ 进行中步骤 ${esc(t.openStep)}${t.openStepIntent ? ` — ${esc(t.openStepIntent)}` : ''}（未提交）</div>` : ''}
      ${t.blockers.length ? `<div class="tc-b">阻塞：${t.blockers.map(esc).join('；')}</div>` : ''}
      ${t.recent.length ? `<div class="tc-r">最近完成：${t.recent.map((r) => esc(r.summary)).join(' ／ ')}</div>` : '<div class="tc-r dim">（还没提交过步骤）</div>'}
      ${t.references && t.references.length ? `<div class="tc-ref">依据：${t.references.map((r) => refLink(r, { outDir: linkDir, cwd })).join(' · ')}</div>` : ''}
      <div class="tc-f">下一步：${esc(t.nextAction)} · 更新 ${dt(t.updatedAt)}</div>
    </div>`).join('')}</div>` : '<p class="dim">（还没有任务；phase start 或 init 会建）</p>';

  const decList = mem.decisions.length
    ? `<div class="declist">${mem.decisions.map((d) => `<div class="deca"><b>${esc(d.title || '(无题)')}</b><span>${esc(d.why || '')}</span><span class="dim">@${esc(d.task_id)} · ${dt(d.at)}</span></div>`).join('')}</div>`
    : '<p class="dim">（暂无决策记录 —— 用 <code>decision add</code> 记「为什么这么选」）</p>';

  const anomalies = (mem.interrupted.length || mem.failed.length)
    ? `${mem.interrupted.map((s) => `<div class="anom warnc">⚠ 中断步骤 ${esc(s.step_id)}（${esc(s.task_id)}）：${esc(s.intent)} · 起于 ${dt(s.at)} —— 需 recover 核对</div>`).join('')}
       ${mem.failed.map((f) => `<div class="anom redc">✗ 失败步骤 ${esc(f.step_id || '')}（${esc(f.task_id)}）：${esc(f.reason)}</div>`).join('')}`
    : '<p class="okc">✓ 无中断、无失败步骤 —— 没有悬空的活。</p>';

  const timeline = mem.recent.length
    ? `<table class="memtab"><thead><tr><th>时间</th><th>类型</th><th>内容 · 结果</th><th>任务</th></tr></thead><tbody>${mem.recent.map((e) => `
        <tr><td class="path">#${e.seq} ${esc(e.timestamp.slice(11, 19))}</td><td>${EVENT_LABEL[e.event] || esc(e.event)}${e.step_id ? ` <span class="dim">${esc(e.step_id)}</span>` : ''}</td><td>${esc(e.summary) || '<span class="dim">—</span>'}${e.refs && e.refs.length ? ` <span class="refs">[${e.refs.map(esc).join(' ')}]</span>` : ''}</td><td class="path">${esc(e.task_id)}</td></tr>`).join('')}</tbody></table>`
    : '<p class="dim">（暂无事件）</p>';

  const memPanel = `
  ${memState}
  <h2>记忆概览 · 记得住机制存了些什么</h2>
  ${statGrid}
  <h2>记了些什么 · 事件类型分布</h2>
  ${evDist}
  <h2>任务快照 · 每个任务记到哪了</h2>
  ${taskCards}
  <h2>关键决策 · 为什么这么做</h2>
  ${decList}
  <h2>异常 · 中断 / 失败步骤</h2>
  ${anomalies}
  <h2>最近调用 · 时间线</h2>
  ${timeline}`;

  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>${esc(p.name)} · 进度看板</title>
<style>
  :root{--paper:#f4f6f2;--surface:#fbfcfa;--ink:#17211d;--sub:#5f6d66;--dim:#8a97a5;--line:#cbd4ce;--green:#15664e;--red:#aa4638;--amber:#a87518;--serif:"Songti SC","Noto Serif CJK SC",Georgia,serif;--sans:"PingFang SC","Noto Sans CJK SC",sans-serif;--mono:"SFMono-Regular",Consolas,monospace}
  *{box-sizing:border-box}
  body{margin:0;background:var(--paper);color:var(--ink);font-family:var(--sans);line-height:1.7;font-size:15px}
  .wrap{width:min(1120px,calc(100% - 40px));margin:0 auto}
  h1{font-family:var(--serif);font-size:2rem;margin:28px 0 4px}
  h2{font-family:var(--serif);font-size:1.3rem;margin:34px 0 12px;border-top:1px solid var(--line);padding-top:18px}
  .lede{color:var(--sub);margin:0 0 8px}
  code,.path{font-family:var(--mono);font-size:.82em}
  .dim{color:var(--dim)} .okc{color:var(--green)} .warnc{color:var(--amber)} .redc{color:var(--red)}

  .report-hero{margin:18px 0 14px;background:linear-gradient(135deg, #0f172a 0%, #1e293b 100%);color:#ffffff;border-radius:14px;padding:22px 26px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:20px;box-shadow:0 8px 24px rgba(15,23,42,0.15);border:1px solid #334155}
  .rh-tag{background:#0369a1;color:#e0f2fe;font-size:11px;font-weight:700;padding:2px 10px;border-radius:20px;display:inline-block;margin-bottom:6px}
  .rh-left h2{font-family:var(--sans);font-size:1.3rem;margin:0 0 6px;border-top:0;padding-top:0;color:#ffffff}
  .rh-desc{margin:0;color:#94a3b8;font-size:.9rem;max-width:580px}
  .rh-right{display:flex;flex-direction:column;align-items:flex-end;gap:12px}
  .rh-stats{display:flex;gap:10px}
  .rhs-item{background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);padding:6px 12px;border-radius:8px;text-align:center;min-width:75px}
  .rhs-item b{display:block;font-size:1.2rem;font-family:var(--mono);line-height:1.2}
  .rhs-item.red b{color:#f87171} .rhs-item.amber b{color:#fbbf24} .rhs-item.blue b{color:#60a5fa} .rhs-item.high b{color:#f43f5e}
  .rhs-item span{font-size:10px;color:#94a3b8}
  .rh-btn{background:#38bdf8;color:#0f172a;font-weight:700;font-size:.88rem;padding:8px 18px;border-radius:8px;text-decoration:none;transition:all .2s;display:inline-block;box-shadow:0 4px 12px rgba(56,189,248,0.3)}
  .rh-btn:hover{background:#7dd3fc;transform:translateY(-1px)}
  .report-badge{background:#15664e;color:#ffffff;font-size:11px;font-weight:700;padding:1px 8px;border-radius:4px}

  .tabs{position:sticky;top:0;z-index:10;display:flex;gap:8px;background:var(--paper);padding:14px 0 12px;margin:6px 0 4px}
  .tab{appearance:none;flex:1;cursor:pointer;font-family:var(--serif);font-size:1.05rem;font-weight:600;color:var(--sub);background:var(--surface);border:1.5px solid var(--line);border-radius:12px;padding:14px 18px;display:flex;align-items:center;justify-content:center;gap:8px;transition:.15s}
  .tab .ic{font-size:1.2rem}
  .tab .cnt{font-family:var(--mono);font-size:.72rem;font-weight:700;background:var(--line);color:var(--sub);border-radius:20px;padding:1px 9px}
  .tab:hover{border-color:var(--green);color:var(--green)}
  .tab.on{background:var(--green);color:#fff;border-color:var(--green);box-shadow:0 4px 14px rgba(21,102,78,.28)}
  .tab.on .cnt{background:rgba(255,255,255,.25);color:#fff}
  .panel[hidden]{display:none}

  .iframe-container{width:100%;height:850px;border-radius:12px;overflow:hidden;border:1px solid var(--line);box-shadow:0 4px 20px rgba(0,0,0,0.08);background:#0b0f19}
  .report-iframe{width:100%;height:100%;border:0}

  .nextbar{display:flex;flex-wrap:wrap;align-items:center;gap:10px 14px;margin:8px 0;border:1px solid var(--green);border-left:5px solid var(--green);border-radius:8px;background:#e3eee8;padding:14px 18px}
  .nb-k{color:var(--green);font-weight:700;font-size:.78rem;letter-spacing:.06em}
  .nb-hint{color:var(--ink);font-size:.95rem} .nb-sk{color:var(--green);font-family:var(--mono);font-size:.78rem}
  .metro{display:grid;grid-template-columns:repeat(${phases.length || 1},minmax(0,1fr));border-block:1px solid var(--ink)}
  .stop{position:relative;border-left:1px solid var(--line);padding:16px 12px 20px;text-align:center}
  .stop:first-child{border-left:0} .stop.cur{background:#e3eee8}
  .dot{width:40px;height:40px;border-radius:50%;border:2px solid;display:grid;place-items:center;margin:0 auto 10px;font-size:18px;background:var(--surface)}
  .stop .no{font-family:var(--mono);font-size:.7rem;color:var(--red)}
  .stop .nm{font-family:var(--serif);font-weight:600;margin-top:2px}
  .stop .st{font-size:.78rem;font-weight:700;margin-top:4px}
  .stop .ct{font-size:.72rem;color:var(--dim);margin-top:2px}
  .stop .here{margin-top:6px;font-size:.72rem;color:var(--green);font-weight:700}
  table{width:100%;border-collapse:collapse;table-layout:fixed;border-block:1px solid var(--ink);margin-top:8px}
  th,td{border-bottom:1px solid var(--line);padding:11px 13px;text-align:left;vertical-align:top;overflow-wrap:anywhere;font-size:.84rem}
  th{color:var(--green);font-size:.72rem}
  table.acct td:first-child{width:15%;color:var(--ink)} table.acct td:nth-child(2){width:16%} table.acct td:nth-child(3){width:27%} table.acct td:nth-child(4){width:27%} table.acct td:nth-child(5){width:15%}
  .opt{color:var(--dim);font-size:.9em}
  .ins{margin-top:8px;padding-top:6px;border-top:1px dashed var(--line)}
  .inslab{display:block;color:var(--amber);font-size:.68rem;font-weight:700;margin-bottom:2px}
  .inrow{font-size:.76rem;color:var(--sub)}
  .bandrow{display:flex;gap:12px;align-items:baseline;padding:8px 0;border-bottom:1px solid var(--line)}
  .bandrow .bp{flex:0 0 150px;font-family:var(--serif);font-weight:600}
  .bandrow .bs{flex:1;display:flex;flex-wrap:wrap;gap:6px}
  .skpill,.evpill{border:1px solid var(--line);border-radius:20px;padding:2px 10px;font-size:.72rem}
  .skpill{font-family:var(--mono)}
  .wlwrap{overflow-x:auto;border-block:1px solid var(--ink)}
  table.wl{table-layout:auto;border-block:0;margin:0;min-width:100%}
  table.wl th{white-space:nowrap} table.wl td{text-align:center}
  table.wl td.wlsys{text-align:left;white-space:nowrap;background:var(--surface)}
  .wlsys b{font-family:var(--serif)} .wlprog{font-family:var(--mono);font-size:.72rem;color:var(--dim)}
  .wlcell{display:inline-block;border:1px solid;border-radius:20px;padding:1px 9px;font-size:.72rem;font-weight:700;white-space:nowrap}
  .rails{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));border-block:1px solid var(--ink)}
  .rail{padding:18px 16px;border-left:1px solid var(--line)} .rail:first-child{border-left:0}
  .rail h3{margin:0 0 6px;font-family:var(--serif);font-size:1rem;color:var(--green)} .rail p{margin:0;color:var(--sub);font-size:.85rem}
  .memstate{margin-top:8px;padding:12px 16px;border-radius:6px;font-size:.9rem}
  .memstate.ok{background:#e3eee8;color:var(--green);border:1px solid var(--green)}
  .memstate.warn{background:#f5eddc;color:var(--amber);border:1px solid var(--amber)}
  .statgrid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));border-block:1px solid var(--ink)}
  .stat{padding:16px 14px;border-left:1px solid var(--line)} .stat:nth-child(4n+1){border-left:0}
  .stat b{display:block;font-family:var(--serif);font-size:1.25rem;color:var(--green);font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
  .stat span{font-size:.72rem;color:var(--dim)}
  .span{color:var(--sub);font-size:.82rem;margin:10px 0 0}
  .pills{display:flex;flex-wrap:wrap;gap:8px} .evpill b{color:var(--green)}
  .tcards{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
  .tcard{border:1px solid var(--line);border-radius:8px;padding:14px 16px;background:var(--surface)}
  .tc-h{display:flex;align-items:center;gap:8px} .tc-h b{font-family:var(--mono);font-size:.85rem}
  .badge{border:1px solid;border-radius:4px;padding:1px 8px;font-size:.72rem;font-weight:700}
  .cur-tag{background:var(--green);color:#fff;border-radius:4px;padding:1px 7px;font-size:.68rem}
  .tc-o{margin:8px 0 6px;font-size:.86rem} .tc-m{font-size:.8rem;color:var(--sub)}
  .tc-b{margin-top:6px;font-size:.8rem;color:var(--amber)} .tc-r{margin-top:6px;font-size:.8rem;color:var(--sub)}
  .tc-plan{margin-top:8px;border-top:1px dashed var(--line);padding-top:8px}
  .plan-h{font-size:.72rem;color:var(--green);font-weight:700;margin-bottom:4px}
  .planrow{font-size:.8rem;color:var(--sub);display:flex;gap:6px;padding:2px 0;overflow-wrap:anywhere}
  .planrow .ck{color:var(--dim);font-weight:700;flex:0 0 auto}
  .planrow.done{color:var(--ink)} .planrow.done .ck{color:var(--green)}
  .tc-open{margin-top:6px;font-size:.8rem;color:var(--amber)}
  .tc-ref{margin-top:6px;font-size:.76rem;color:var(--sub);overflow-wrap:anywhere}
  .tc-ref a,.acct a{color:var(--green);text-decoration:none;border-bottom:1px solid var(--line)}
  .tc-ref a:hover,.acct a:hover{border-bottom-color:var(--green)}
  .reflab{color:var(--amber);font-size:.9em}
  .tc-f{margin-top:8px;padding-top:8px;border-top:1px dashed var(--line);font-size:.75rem;color:var(--dim)}
  .declist{border-top:1px solid var(--line)} .deca{display:flex;flex-direction:column;gap:2px;padding:10px 0;border-bottom:1px solid var(--line)}
  .deca b{font-size:.88rem} .deca span{font-size:.8rem;color:var(--sub)}
  .anom{padding:8px 12px;border-radius:6px;background:var(--surface);border:1px solid var(--line);margin:6px 0;font-size:.82rem}
  .memtab td:first-child{width:15%} .memtab td:nth-child(2){width:17%} .memtab td:nth-child(4){width:20%}
  footer{color:var(--dim);font-size:.75rem;padding:28px 0 48px;border-top:1px solid var(--line);margin-top:28px}
  @media(max-width:760px){.report-hero{flex-direction:column;align-items:flex-start}.rh-right{align-items:flex-start;width:100%}.rh-stats{width:100%;justify-content:space-between}.metro{grid-template-columns:repeat(2,1fr)}.statgrid{grid-template-columns:repeat(2,1fr)}.stat:nth-child(4n+1){border-left:1px solid var(--line)}.stat:nth-child(2n+1){border-left:0}.tcards{grid-template-columns:1fr}.rails{grid-template-columns:1fr}.rail{border-left:0;border-top:1px solid var(--line)}.rail:first-child{border-top:0}.bandrow{flex-direction:column;gap:4px}.bandrow .bp{flex:auto}}
</style></head>
<body><div class="wrap">
  <h1>${esc(p.name)} · 进度看板</h1>
  <p class="lede">数据来自 <code>.agent</code> 真实状态（产物磁盘回读、bug 台账与记忆），非聊天记录。</p>
  
  ${reportHero}

  <div class="tabs">
    <button class="tab on" data-t="flow"><span class="ic">🧭</span> 流程 · 进度 <span class="cnt">${doneCount}/${phases.length}</span></button>
    <button class="tab" data-t="report"><span class="ic">🩹</span> Bug 深度分析报告 <span class="cnt">${bugCount}</span></button>
    <button class="tab" data-t="mem"><span class="ic">🧬</span> 记忆 · 记得住 <span class="cnt">${mem.eventCount}</span></button>
  </div>
  <div id="flow" class="panel">${flowPanel}</div>
  <div id="report" class="panel" hidden>${reportPanel}</div>
  <div id="mem" class="panel" hidden>${memPanel}</div>
  <footer>数据源：.agent 真实状态（产物磁盘回读 + journal，非聊天记录） · 生成时间 ${esc(generatedAt)}</footer>
</div>
<script>
  document.querySelectorAll('.tab').forEach(function(b){
    b.addEventListener('click',function(){
      document.querySelectorAll('.tab').forEach(function(x){x.classList.remove('on')});
      document.querySelectorAll('.panel').forEach(function(x){x.hidden=true});
      b.classList.add('on');
      var el=document.getElementById(b.dataset.t); if(el){el.hidden=false;}
    });
  });
</script>
</body></html>
`;
}

