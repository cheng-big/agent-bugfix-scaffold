// node --test 覆盖验收 12 条。每个测试用独立临时 AGENT_HOME，互不污染。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 每个用例前设独立根。lib 读的是 process.env.AGENT_HOME（惰性 agentRoot()）。
function freshHome() {
  const home = join(mkdtempSync(join(tmpdir(), 'agent-test-')), '.agent');
  process.env.AGENT_HOME = home;
  return home;
}

// 动态 import（带 cache-buster 无必要，因 lib 无模块级缓存状态依赖根路径）
const store = await import('./lib/store.mjs');
const task = await import('./lib/task.mjs');
const journal = await import('./lib/journal.mjs');
const sm = await import('./lib/statemachine.mjs');
const ctx = await import('./lib/context.mjs');

function makeTask(id = 't1', over = {}) {
  const t = task.newTask({ taskId: id, objective: 'obj', dod: ['d1'] });
  return { ...t, ...over };
}

test('1. TASK 超过 16KB 被拒绝', () => {
  freshHome();
  const t = makeTask();
  t.objective = 'x'.repeat(400);
  t.current_focus = 'y'.repeat(490);
  // 用大量 references 撑爆体积（单项≤200，条数≤20 → 仍不足 16KB，故直接测 assertValidTask 的字节门用超长 constraints 组合）
  t.critical_constraints = Array.from({ length: 12 }, () => 'c'.repeat(280));
  t.recent_completed = Array.from({ length: 10 }, () => ({ at: '2026-01-01', summary: 's'.repeat(280), evidence: ['ev:1', 'ev:2', 'ev:3', 'ev:4', 'ev:5', 'ev:6'] }));
  t.references = Array.from({ length: 20 }, () => 'r'.repeat(200));
  t.definition_of_done = Array.from({ length: 20 }, () => ({ text: 'd'.repeat(280), met: false, evidence: ['ev:1', 'ev:2', 'ev:3', 'ev:4', 'ev:5', 'ev:6'] }));
  const size = store.byteSize(JSON.stringify(t));
  assert.ok(size > 16 * 1024, `构造体积应 >16KB，实际 ${size}`);
  assert.throws(() => task.assertValidTask(t), /ETOOBIG|上限/);
});

test('2. recent_completed 超过 10 项被拒绝（明确规则）', () => {
  freshHome();
  const t = makeTask();
  t.recent_completed = Array.from({ length: 11 }, (_, i) => ({ at: '2026-01-01', summary: `s${i}` }));
  assert.throws(() => task.assertValidTask(t), /recent_completed|maxItems|上限/);
});

test('3. Schema 错误时拒绝更新', () => {
  freshHome();
  const t = makeTask();
  t.status = 'not-a-status';
  assert.throws(() => task.assertValidTask(t), /schema|枚举|ESCHEMA/i);
});

test('4. 原子写失败不破坏旧状态', () => {
  freshHome();
  const t = makeTask();
  task.writeTaskChecked(t);
  const good = readFileSync(store.paths.task('t1'), 'utf8');
  // 尝试写一个非法（超枚举）版本 → 应抛错且旧文件不变
  const bad = task.loadTask('t1');
  bad.status = 'bogus';
  assert.throws(() => task.writeTaskChecked(bad, { expectedVersion: 1 }));
  assert.equal(readFileSync(store.paths.task('t1'), 'utf8'), good, '旧状态必须保持不变');
});

test('5. 版本冲突不会覆盖新状态', () => {
  freshHome();
  const t = makeTask();
  task.writeTaskChecked(t); // version 1
  task.updateTask('t1', (x) => { x.phase = '推进'; }); // → version 2
  // 拿旧 version=1 的副本再写 → 冲突
  const stale = { ...t, phase: '旧改', version: 1 };
  assert.throws(() => task.writeTaskChecked(stale, { expectedVersion: 1 }), /ECONFLICT|冲突/);
  assert.equal(task.loadTask('t1').phase, '推进', '磁盘应保留较新状态');
});

test('6. 重复 idempotency_key 不重复提交', () => {
  freshHome();
  const t = makeTask();
  task.writeTaskChecked(t);
  journal.appendEvent('t1', 'step_committed', { stepId: 's1', idempotencyKey: 'idem-x' });
  assert.equal(journal.hasCommittedIdem('t1', 'idem-x'), true);
  assert.equal(journal.hasCommittedIdem('t1', 'idem-other'), false);
});

test('7. started 未 committed 的步骤被恢复识别', () => {
  freshHome();
  const t = makeTask();
  task.writeTaskChecked(t);
  journal.appendEvent('t1', 'step_started', { stepId: 's1', idempotencyKey: 'i1', payload: { intent: 'do' } });
  journal.appendEvent('t1', 'step_started', { stepId: 's2', idempotencyKey: 'i2' });
  journal.appendEvent('t1', 'step_committed', { stepId: 's2', idempotencyKey: 'i2' });
  const interrupted = journal.findInterruptedSteps('t1');
  assert.equal(interrupted.length, 1);
  assert.equal(interrupted[0].step_id, 's1');
});

test('8. 无验证证据不能完成任务（状态机守卫）', () => {
  freshHome();
  // in_progress 直达 completed → 拒
  assert.equal(sm.guard('in_progress', 'completed', { hasVerificationEvidence: true }).ok, false);
  // verifying 但无证据 → 拒
  assert.equal(sm.guard('verifying', 'completed', { hasVerificationEvidence: false }).ok, false);
  // verifying + 证据 → 允许
  assert.equal(sm.guard('verifying', 'completed', { hasVerificationEvidence: true }).ok, true);
  // blocked 无 blocker → 拒
  assert.equal(sm.guard('in_progress', 'blocked', { hasBlocker: false }).ok, false);
  // completed 静默重开 → 拒
  assert.equal(sm.guard('completed', 'in_progress', {}).ok, false);
  assert.equal(sm.guard('completed', 'in_progress', { reopen: true }).ok, true);
});

test('9. checkpoint 不把未完成步骤总结成已完成', () => {
  freshHome();
  const t = makeTask();
  task.writeTaskChecked(t);
  journal.appendEvent('t1', 'step_started', { stepId: 's1', payload: { intent: '干活中' } });
  const { markdown } = ctx.buildCheckpoint(task.loadTask('t1'), {});
  assert.match(markdown, /未完成 \/ 中断步骤/);
  assert.match(markdown, /s1.*未 commit/s);
  // 已确认完成区应为空（无 step_committed）
  assert.match(markdown, /已确认完成（step_committed，共 0）/);
});

test('10. 上下文生成器不注入整份日志', () => {
  freshHome();
  const t = makeTask();
  task.writeTaskChecked(t);
  // 造 50 条事件
  for (let i = 0; i < 50; i++) journal.appendEvent('t1', 'artifact_written', { payload: { marker: `UNIQUE_MARK_${i}` } });
  const text = ctx.buildContext(task.loadTask('t1'), {});
  const markers = (text.match(/UNIQUE_MARK_\d+/g) || []).length;
  assert.ok(markers <= 8, `上下文不应含全部 50 条，实际含 ${markers} 个 marker`);
  assert.match(text, /日志事件总数=50/);
});

test('11. 敏感字段不写入日志', () => {
  freshHome();
  const t = makeTask();
  task.writeTaskChecked(t);
  journal.appendEvent('t1', 'artifact_written', {
    references: ['Bearer abcdef1234567890TOKEN'],
    payload: { password: 'hunter2', note: 'token=eyJhbGciOiJIUzI1NiClaimClaimClaim', nested: { api_key: 'sk-livesecretkey123456' } },
  });
  const raw = readFileSync(store.paths.journal('t1'), 'utf8');
  assert.doesNotMatch(raw, /hunter2/);
  assert.doesNotMatch(raw, /sk-livesecretkey/);
  assert.doesNotMatch(raw, /eyJhbGciOiJIUzI1NiC/);
  assert.match(raw, /REDACTED/);
});

test('12. 多任务状态与日志不混淆', () => {
  freshHome();
  task.writeTaskChecked(makeTask('alpha', { objective: 'A' }));
  task.writeTaskChecked(makeTask('beta', { objective: 'B' }));
  journal.appendEvent('alpha', 'step_started', { stepId: 'a1' });
  journal.appendEvent('beta', 'step_started', { stepId: 'b1' });
  journal.appendEvent('beta', 'step_committed', { stepId: 'b1' });
  assert.equal(journal.findInterruptedSteps('alpha').length, 1);
  assert.equal(journal.findInterruptedSteps('beta').length, 0);
  assert.equal(task.loadTask('alpha').objective, 'A');
  assert.equal(task.loadTask('beta').objective, 'B');
  // alpha 的日志不含 beta 的 step（按解析后的 step_id 断言，避免误匹配 event_id 子串）
  const alphaStepIds = journal.readEvents('alpha').map((e) => e.step_id);
  assert.ok(!alphaStepIds.includes('b1'), 'alpha 日志不应含 beta 的步骤 b1');
  assert.ok(alphaStepIds.includes('a1'));
});

test('附加：完整状态机转换表符合预期', () => {
  assert.equal(sm.canTransition('planned', 'in_progress'), true);
  assert.equal(sm.canTransition('in_progress', 'completed'), false); // 必须过 verifying
  assert.equal(sm.canTransition('verifying', 'completed'), true);
  assert.equal(sm.canTransition('cancelled', 'in_progress'), false);
});
