// 有界上下文生成 + checkpoint 生成。绝不注入整份 journal。

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readEvents, findInterruptedSteps, lastEventSeq } from './journal.mjs';
import { agentRoot } from './store.mjs';

const RECENT_EVENTS_TAIL = 8; // 上下文只带日志尾部 N 条摘要
const RECENT_COMPLETED_SHOW = 5;

// 「你是谁」身份来源（移植友好，无项目硬编码）：
// 优先 .agent/PROJECT.md（新项目适配时填它即可，不用改代码）；
// 无则回退探测仓库常见规范文件（AGENTS/CLAUDE/CONTRIBUTING/README）。
function identityLines(cwd) {
  const projectMd = join(agentRoot(), 'PROJECT.md');
  if (existsSync(projectMd)) {
    const body = readFileSync(projectMd, 'utf8').split('\n').filter((l) => l.trim()).slice(0, 14);
    return ['[.agent/PROJECT.md]', ...body.map((l) => l.slice(0, 200))];
  }
  const out = [];
  for (const f of ['AGENTS.md', 'CLAUDE.md', 'CONTRIBUTING.md', 'README.md']) {
    const p = join(cwd, f);
    if (!existsSync(p)) continue;
    const head = readFileSync(p, 'utf8').split('\n').filter((l) => l.trim()).slice(0, 3);
    out.push(`[${f}] ${head.join(' / ').slice(0, 240)}`);
    if (out.length >= 2) break;
  }
  if (!out.length) out.push('（未找到 .agent/PROJECT.md 或 AGENTS/CLAUDE/README；请填 .agent/PROJECT.md）');
  return out;
}

function evtSummary(e) {
  const bits = [`#${e.seq}`, e.event];
  if (e.step_id) bits.push(e.step_id);
  const p = e.payload || {};
  const note = p.intent || p.summary || p.reason || p.title || '';
  if (note) bits.push(String(note).slice(0, 80));
  return bits.join(' · ');
}

// 生成有界启动上下文（字符串）。不含整份日志。
export function buildContext(task, { cwd = process.cwd(), branch = '', repoName = '' } = {}) {
  const events = readEvents(task.task_id);
  const interrupted = findInterruptedSteps(task.task_id);
  const recentDone = (task.recent_completed || []).slice(-RECENT_COMPLETED_SHOW);
  const tail = events.slice(-RECENT_EVENTS_TAIL);

  const L = [];
  L.push('你是谁：');
  for (const l of identityLines(cwd)) L.push('  ' + l);
  L.push('  唯一操作人身份从会话上下文取；不凭聊天摘要宣布完成。');
  L.push('');

  L.push('你在哪里：');
  L.push(`  项目=${repoName || '(repo)'}  分支=${branch || '(unknown)'}`);
  L.push(`  任务=${task.task_id}  阶段=${task.phase}  状态=${task.status}  version=${task.version}`);
  L.push(`  日志事件总数=${events.length}（尾 ${tail.length} 条摘要，非全量）`);
  if (recentDone.length) {
    L.push('  最近确认完成：');
    for (const r of recentDone) L.push(`    - ${r.summary}${r.evidence?.length ? ` [${r.evidence.join(',')}]` : ''}`);
  } else {
    L.push('  最近确认完成：（无）');
  }
  L.push('');

  L.push('是否存在中断：');
  if (interrupted.length) {
    for (const s of interrupted)
      L.push(`  ⚠ 步骤 ${s.step_id}（attempt ${s.attempt}）已 started 未 committed/failed，意图：${s.intent || '(未记)'}`);
    L.push('  → 先核对代码/Git/测试/外部系统真实态，再决定 reconcile / 重试 / block。');
  } else {
    L.push('  无未提交的中断步骤。');
  }
  L.push('');

  L.push('你要去哪里：');
  L.push(`  目标：${task.objective}`);
  L.push(`  当前关注：${task.current_focus || '(无)'}`);
  L.push(`  下一步（唯一动作）：${task.next_action}`);
  if (task.blockers?.length) {
    L.push('  阻塞项：');
    for (const b of task.blockers) L.push(`    - ${b}`);
  }
  L.push('  完成标准（DoD）：');
  for (const d of task.definition_of_done || [])
    L.push(`    [${d.met ? 'x' : ' '}] ${d.text}${d.evidence?.length ? ` [${d.evidence.join(',')}]` : ''}`);
  L.push('');

  L.push('重要约束：');
  for (const c of task.critical_constraints || []) L.push(`  - ${c}`);
  if (task.references?.length) L.push('  相关引用：' + task.references.join(' , '));
  L.push('');

  L.push('执行要求：');
  L.push('  先验证真实态再继续；无证据不得宣布完成；每步 start→work→verify→commit；');
  L.push('  失败记 fail-step；保持 TASK 有界，历史进 journal/checkpoint。');

  return L.join('\n');
}

// 生成 checkpoint（Markdown）。只总结事实/决策/未完成项/证据引用；
// 不把 step_started 当 completed；标注依据日志范围。
export function buildCheckpoint(task, { trigger = 'manual' } = {}) {
  const events = readEvents(task.task_id);
  const fromSeq = events.length ? events[0].seq : 0;
  const toSeq = lastEventSeq(task.task_id);
  const committed = events.filter((e) => e.event === 'step_committed');
  const failed = events.filter((e) => e.event === 'step_failed');
  const decisions = events.filter((e) => e.event === 'decision_recorded');
  const interrupted = findInterruptedSteps(task.task_id);

  const L = [];
  L.push(`# Checkpoint — ${task.task_id}`);
  L.push('');
  L.push(`- 生成时间：${new Date().toISOString()}`);
  L.push(`- 触发：${trigger}`);
  L.push(`- 依据日志范围：event seq ${fromSeq}..${toSeq}（共 ${events.length} 条；本摘要可由该范围原始日志重生成）`);
  L.push(`- 任务状态：${task.status}  阶段：${task.phase}  version：${task.version}`);
  L.push('');
  L.push('## 目标');
  L.push(task.objective);
  L.push('');
  L.push(`## 已确认完成（step_committed，共 ${committed.length}）`);
  if (committed.length) for (const e of committed) L.push(`- ${e.step_id || '(step)'}：${e.payload?.summary || e.payload?.intent || ''} ${e.references?.length ? `[${e.references.join(',')}]` : ''}`);
  else L.push('- （无）');
  L.push('');
  L.push('## 未完成 / 中断步骤（不视为完成）');
  if (interrupted.length) for (const s of interrupted) L.push(`- ⚠ ${s.step_id}（attempt ${s.attempt}）started 未 commit：${s.intent || ''}`);
  else L.push('- （无）');
  if (failed.length) { L.push(''); L.push('## 失败记录'); for (const e of failed) L.push(`- ${e.step_id}：${e.payload?.reason || ''}`); }
  L.push('');
  L.push('## 关键决策');
  if (decisions.length) for (const e of decisions) L.push(`- ${e.payload?.title || ''}：${e.payload?.why || ''}（${e.references?.join(',') || ''}）`);
  else L.push('- （无）');
  L.push('');
  L.push('## 下一步');
  L.push(task.next_action);
  L.push('');
  return { markdown: L.join('\n'), fromSeq, toSeq };
}
