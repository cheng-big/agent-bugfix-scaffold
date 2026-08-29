// report：读 bugs.json + 各 bug 目录的阶段产物与证据截图 → 自包含 HTML 报告。
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadBugLedger } from './bugcapture.mjs';

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const readMd = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');

function bugCard(agentRoot, bug) {
  const id = bug.id || '(无id)';
  const dir = join(agentRoot, 'bugs', id);
  const stage = (f) => readMd(join(dir, `${f}.md`));
  const evDir = join(dir, 'evidence');
  let imgs = [];
  if (existsSync(evDir)) {
    try { imgs = readdirSync(evDir).filter((f) => /\.(png|jpg|jpeg|gif|webp)$/i.test(f)); } catch { /* ignore */ }
  }
  const sev = esc(bug.severity || '普通');
  const status = esc(bug.status || '待修复');
  const rawMod = bug.module || bug.raw?.['﻿模块'] || bug.raw?.['模块'] || '';
  const rawPg = bug.page || bug.raw?.['页面'] || '';
  const moduleName = esc(rawMod || '常规组件');
  const pageName = esc(rawPg || '全局/未指定');
  const reporter = esc(bug.reporter || bug.raw?.['提出人'] || '');

  const row = (label, txt, icon = '') => txt ? `
    <div class="detail-row">
      <div class="detail-key">${icon} ${label}</div>
      <div class="detail-val"><pre>${esc(txt)}</pre></div>
    </div>` : '';

  const shots = imgs.length
    ? `<div class="shots">${imgs.map((f) => `<figure><img src="../bugs/${encodeURIComponent(id)}/evidence/${encodeURIComponent(f)}" loading="lazy"><figcaption>${esc(f)}</figcaption></figure>`).join('')}</div>`
    : '<div class="empty-shot">（暂无验证证据截图——验证阶段自动存入）</div>';

  const titleText = bug.title || bug.raw?.['描述'] || id;
  const isHigh = sev === '高' || sev === 'P1' || sev === 'P0';
  const statusClass = status === '待确认' ? 'st-confirm' : status === '待开发' ? 'st-dev' : 'st-fix';

  return `<section class="bug-card" data-module="${moduleName}" data-status="${status}">
    <div class="card-header">
      <div class="header-left">
        <span class="bug-badge">${esc(id)}</span>
        <span class="tag mod-tag">📂 ${moduleName}${rawPg ? ' / ' + pageName : ''}</span>
      </div>
      <div class="header-right">
        ${reporter ? `<span class="tag reporter-tag">👤 ${reporter}</span>` : ''}
        ${isHigh ? '<span class="tag high-tag">🔥 高优先级</span>' : ''}
        <span class="tag status-tag ${statusClass}">⚡ ${status}</span>
      </div>
    </div>

    <div class="desc-box">
      <div class="desc-title">📌 问题现象与反馈描述</div>
      <div class="desc-text">${esc(titleText)}</div>
    </div>

    <div class="details-grid">
      ${row('复现步骤与现象', stage('repro') || bug.repro, '🔍')}
      ${row('根因分析', stage('root-cause'), '🎯')}
      ${row('影响面评估', stage('impact'), '⚡')}
      ${row('修复方案设计', stage('fix-plan'), '🛠️')}
      ${row('代码改动说明', stage('change'), '📝')}
      <div class="detail-row">
        <div class="detail-key">📸 验证证据</div>
        <div class="detail-val">${shots}</div>
      </div>
    </div>
  </section>`;
}

export function buildBugReport(agentRoot) {
  const bugsPath = join(agentRoot, 'bugs.json');
  if (!existsSync(bugsPath)) throw Object.assign(new Error('缺 .agent/bugs.json（先跑 `bug import`）'), { code: 'ENOBUGS' });
  const bugs = loadBugLedger(dirname(agentRoot));

  const total = bugs.length;
  const pendingFix = bugs.filter((b) => (b.status || b.raw?.['状态']) === '待修复').length;
  const pendingDev = bugs.filter((b) => (b.status || b.raw?.['状态']) === '待开发').length;
  const pendingConfirm = bugs.filter((b) => (b.status || b.raw?.['状态']) === '待确认').length;
  const highSev = bugs.filter((b) => (b.severity || b.raw?.['优先级']) === '高' || b.severity === 'P1').length;

  const modules = Array.from(new Set(bugs.map((b) => (b.module || b.raw?.['﻿模块'] || b.raw?.['模块'] || '常规组件').trim()).filter(Boolean)));

  const cards = bugs.map((b) => bugCard(agentRoot, b)).join('\n');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Bug 深度分析与修复报告</title>
<style>
  :root {
    --bg: #0b0f19;
    --panel: #151d2a;
    --panel-header: #1e293b;
    --border: #283548;
    --fg: #f1f5f9;
    --muted: #94a3b8;
    --accent: #38bdf8;
    --red: #f43f5e;
    --red-bg: #4c1d24;
    --amber: #fbbf24;
    --amber-bg: #453010;
    --blue: #60a5fa;
    --blue-bg: #1e3a8a;
    --green: #10b981;
    --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", sans-serif;
    --font-mono: ui-monospace, SFMono-Regular, Consolas, monospace;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--fg);
    font-family: var(--font-sans);
    line-height: 1.6;
    font-size: 14px;
    padding-bottom: 60px;
  }
  header {
    background: linear-gradient(180deg, #1e293b 0%, #0f172a 100%);
    border-bottom: 1px solid var(--border);
    padding: 32px 36px;
  }
  .header-content {
    max-width: 1200px;
    margin: 0 auto;
  }
  .header-title-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-wrap: wrap;
    gap: 16px;
  }
  h1 {
    margin: 0;
    font-size: 24px;
    font-weight: 700;
    color: #ffffff;
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .sub-title {
    color: var(--muted);
    font-size: 13px;
    margin-top: 6px;
  }
  .stats-bar {
    display: flex;
    gap: 12px;
    flex-wrap: wrap;
    margin-top: 20px;
  }
  .stat-card {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 10px 18px;
    display: flex;
    flex-direction: column;
    min-width: 130px;
  }
  .stat-card .num {
    font-size: 20px;
    font-weight: 700;
    font-family: var(--font-mono);
    color: var(--accent);
  }
  .stat-card.red .num { color: var(--red); }
  .stat-card.amber .num { color: var(--amber); }
  .stat-card.high .num { color: #f87171; }
  .stat-card .label {
    font-size: 12px;
    color: var(--muted);
    margin-top: 2px;
  }
  main {
    max-width: 1200px;
    margin: 24px auto;
    padding: 0 20px;
  }
  .filter-bar {
    display: flex;
    gap: 10px;
    align-items: center;
    flex-wrap: wrap;
    margin-bottom: 24px;
    padding: 14px 18px;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 10px;
  }
  .filter-label {
    font-weight: 600;
    color: var(--muted);
    font-size: 13px;
    margin-right: 6px;
  }
  .filter-btn {
    appearance: none;
    background: var(--panel-header);
    border: 1px solid var(--border);
    color: var(--fg);
    border-radius: 20px;
    padding: 5px 14px;
    font-size: 12px;
    cursor: pointer;
    transition: all 0.2s;
  }
  .filter-btn:hover { border-color: var(--accent); color: var(--accent); }
  .filter-btn.active { background: var(--accent); color: #000000; border-color: var(--accent); font-weight: 700; }
  .bugs-list {
    display: flex;
    flex-direction: column;
    gap: 20px;
  }
  .bug-card {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 22px 24px;
    box-shadow: 0 4px 16px rgba(0,0,0,0.3);
    transition: transform 0.15s, border-color 0.15s;
  }
  .bug-card:hover {
    border-color: #3b82f6;
  }
  .card-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-wrap: wrap;
    gap: 12px;
    border-bottom: 1px solid var(--border);
    padding-bottom: 14px;
    margin-bottom: 16px;
  }
  .header-left, .header-right {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }
  .bug-badge {
    font-family: var(--font-mono);
    font-size: 13px;
    font-weight: 700;
    color: var(--accent);
    background: #0c4a6e;
    padding: 4px 10px;
    border-radius: 6px;
    border: 1px solid #0284c7;
  }
  .tag {
    font-size: 12px;
    padding: 3px 10px;
    border-radius: 20px;
    border: 1px solid var(--border);
    background: var(--panel-header);
  }
  .mod-tag { color: #cbd5e1; }
  .reporter-tag { color: var(--muted); }
  .high-tag { background: #450a0a; color: #fca5a5; border-color: #991b1b; font-weight: 600; }
  .status-tag.st-fix { background: var(--red-bg); color: #fca5a5; border-color: var(--red); font-weight: 600; }
  .status-tag.st-dev { background: var(--amber-bg); color: #fde047; border-color: var(--amber); font-weight: 600; }
  .status-tag.st-confirm { background: var(--blue-bg); color: #93c5fd; border-color: var(--blue); }
  .desc-box {
    background: #0f172a;
    border: 1px solid #1e293b;
    border-left: 4px solid var(--accent);
    border-radius: 8px;
    padding: 16px 20px;
    margin-bottom: 16px;
  }
  .desc-title {
    font-size: 12px;
    font-weight: 700;
    color: var(--accent);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 6px;
  }
  .desc-text {
    font-size: 15px;
    font-weight: 600;
    color: #ffffff;
    white-space: pre-wrap;
    word-break: break-word;
    line-height: 1.6;
  }
  .details-grid {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .detail-row {
    display: grid;
    grid-template-columns: 140px 1fr;
    gap: 16px;
    padding: 10px 0;
    border-top: 1px dashed #1e293b;
  }
  .detail-key {
    color: var(--muted);
    font-size: 13px;
    font-weight: 600;
  }
  .detail-val pre {
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
    font-family: var(--font-mono);
    font-size: 13px;
    color: #e2e8f0;
  }
  .shots { display: flex; flex-wrap: wrap; gap: 12px; }
  .shots img { max-width: 340px; border: 1px solid var(--border); border-radius: 8px; display: block; }
  figcaption { color: var(--muted); font-size: 11px; margin-top: 4px; }
  .empty-shot { color: var(--muted); font-style: italic; font-size: 12px; }
</style>
</head>
<body>
<header>
  <div class="header-content">
    <div class="header-title-row">
      <div>
        <h1>🩹 Bug 深度分析与修复报告</h1>
        <div class="sub-title">数据同步自 bug 反馈清单 · 归一化分析与修复追踪全景视图</div>
      </div>
    </div>
    <div class="stats-bar">
      <div class="stat-card">
        <span class="num">${total}</span>
        <span class="label">待干预 Bug 总数</span>
      </div>
      <div class="stat-card red">
        <span class="num">${pendingFix}</span>
        <span class="label">🔴 待修复</span>
      </div>
      <div class="stat-card amber">
        <span class="num">${pendingDev}</span>
        <span class="label">🟡 待开发</span>
      </div>
      <div class="stat-card">
        <span class="num">${pendingConfirm}</span>
        <span class="label">🔵 待确认</span>
      </div>
      <div class="stat-card high">
        <span class="num">${highSev}</span>
        <span class="label">🔥 高优先级</span>
      </div>
    </div>
  </div>
</header>

<main>
  <div class="filter-bar">
    <span class="filter-label">模块筛选:</span>
    <button class="filter-btn active" data-mod="ALL">全部模块 (${total})</button>
    ${modules.map((m) => {
      const count = bugs.filter((b) => (b.module || b.raw?.['﻿模块'] || b.raw?.['模块'] || '常规组件').trim() === m).length;
      return `<button class="filter-btn" data-mod="${esc(m)}">${esc(m)} (${count})</button>`;
    }).join('')}
  </div>

  <div class="bugs-list" id="bugsContainer">
    ${cards || '<p class="empty-shot">暂无待处理 Bug 记录</p>'}
  </div>
</main>

<script>
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const mod = btn.dataset.mod;
      document.querySelectorAll('.bug-card').forEach(card => {
        if (mod === 'ALL' || card.dataset.module === mod) {
          card.style.display = 'block';
        } else {
          card.style.display = 'none';
        }
      });
    });
  });
</script>
</body>
</html>`;
}
