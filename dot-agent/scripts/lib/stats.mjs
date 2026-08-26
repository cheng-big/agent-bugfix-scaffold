// 记忆活动统计：证明「记得住」机制真被调用 + 挖出记忆里存了什么。
// 纯记忆层能力（只读 journal / tasks / decisions / evidence / checkpoints），
// 记忆项目与脚手架项目共用，不依赖任何脚手架（process/board/skills）代码。

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { listTaskIds, paths, readJson } from './store.mjs';
import { loadTask } from './task.mjs';
import { readEvents, findInterruptedSteps } from './journal.mjs';

// 从一条 journal 事件提取「简短内容/结果」——让人看清到底调了什么记忆、返回了什么。
export function eventSummary(e) {
  const p = e.payload || {};
  const cut = (s) => String(s || '').slice(0, 90);
  switch (e.event) {
    case 'task_created': return `目标：${cut(p.objective)}`;
    case 'step_started': return `意图：${cut(p.intent)}`;
    case 'verification_started': return p.of ? `验证对象：${cut(p.of)}` : '开始验证';
    case 'verification_finished': return `结果：${p.result || ''}${p.note ? ` · ${cut(p.note)}` : ''}`;
    case 'decision_recorded': return `${cut(p.title)}${p.why ? ` — ${cut(p.why)}` : ''}`;
    case 'step_committed': return cut(p.summary) || '(已提交)';
    case 'step_failed': return `原因：${cut(p.reason)}`;
    case 'artifact_written': return p.key ? `产物 ${p.key} → ${cut(p.path || p.ref)}` : cut(p.ref || p.kind);
    case 'task_blocked': return `阻塞：${cut((p.blockers || []).join('；'))}`;
    case 'task_completed': return `完成：${cut(p.objective)}`;
    case 'checkpoint_created': return `存档 seq ${p.from_seq}..${p.to_seq}`;
    case 'recovery_performed': return `动作：${cut(p.action)}`;
    default: return '';
  }
}

// 汇总所有任务的 journal 事件：任务数 / 事件总数 / 最后写入 / 最近 N 条（带内容摘要）/ 中断数。
export function memoryStats({ recent = 6 } = {}) {
  const ids = listTaskIds();
  const events = [];
  let interruptedCount = 0;
  for (const id of ids) {
    for (const e of readEvents(id)) events.push({
      task_id: id, seq: e.seq, event: e.event, timestamp: e.timestamp, step_id: e.step_id || null,
      summary: eventSummary(e),
      refs: (e.references || []).filter((r) => /^(ev:|dec:|checkpoint:|artifact:)/.test(r)),
    });
    interruptedCount += findInterruptedSteps(id).length;
  }
  events.sort((a, b) => (a.timestamp === b.timestamp ? 0 : a.timestamp < b.timestamp ? -1 : 1));
  const last = events.length ? events[events.length - 1] : null;
  return {
    taskCount: ids.length,
    eventCount: events.length,
    lastAt: last ? last.timestamp : null,
    interruptedCount,
    recent: events.slice(-recent).reverse(),
    invoked: events.length > 0,
  };
}

// 记忆全景（看板「记忆」tab / doctor 详情用）：在 memoryStats 基础上挖出——事件类型分布、
// 每任务卡片、决策、证据数、checkpoint 数、中断步骤、失败步骤、时间跨度、当前活动任务。
export function memoryDetail() {
  const base = memoryStats({ recent: 12 });
  const ids = listTaskIds();
  const eventsByType = {};
  const failed = [];
  const interrupted = [];
  let firstAt = null;
  const tasks = [];
  const decisions = [];
  let evidenceCount = 0;
  let checkpointCount = 0;

  for (const id of ids) {
    for (const e of readEvents(id)) {
      eventsByType[e.event] = (eventsByType[e.event] || 0) + 1;
      if (!firstAt || e.timestamp < firstAt) firstAt = e.timestamp;
      if (e.event === 'step_failed') failed.push({ task_id: id, step_id: e.step_id, reason: e.payload?.reason || '' });
    }
    for (const s of findInterruptedSteps(id)) interrupted.push({ task_id: id, step_id: s.step_id, intent: s.intent || '', at: s.at });
    try {
      const t = loadTask(id);
      tasks.push({
        id, objective: t.objective, status: t.status, phase: t.phase, version: t.version,
        dodMet: (t.definition_of_done || []).filter((d) => d.met).length,
        dodTotal: (t.definition_of_done || []).length,
        dod: (t.definition_of_done || []).map((d) => ({ text: d.text, met: !!d.met, evidence: d.evidence || [] })),
        references: t.references || [],
        openStep: t.open_step ? t.open_step.step_id : null,
        openStepIntent: t.open_step ? (t.open_step.intent || '') : '',
        blockers: t.blockers || [],
        nextAction: t.next_action || '',
        updatedAt: t.updated_at,
        recent: (t.recent_completed || []).slice(-3).reverse(),
      });
    } catch { /* 快照损坏不阻塞看板 */ }
    const dd = paths.decisionsDir(id);
    if (existsSync(dd)) for (const f of readdirSync(dd)) if (f.endsWith('.json')) { try { const r = readJson(join(dd, f)); decisions.push({ task_id: id, title: r.title, why: r.why, at: r.at }); } catch { /* skip */ } }
    const ed = paths.evidenceDir(id);
    if (existsSync(ed)) evidenceCount += readdirSync(ed).filter((f) => f.endsWith('.json')).length;
    const cd = paths.checkpointsDir(id);
    if (existsSync(cd)) checkpointCount += readdirSync(cd).filter((f) => f.endsWith('.md')).length;
  }

  const active = (() => { try { return readJson(paths.active()).active_task_id || null; } catch { return null; } })();
  return { ...base, firstAt, eventsByType, tasks, decisions, evidenceCount, checkpointCount, failed, interrupted, activeTaskId: active };
}
