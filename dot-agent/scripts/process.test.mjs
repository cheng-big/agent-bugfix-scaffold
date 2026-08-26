// node --test：方法论脚手架层。每个用例独立临时 AGENT_HOME，产物用绝对路径以避免 cwd 干扰。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

function freshHome() {
  const base = mkdtempSync(join(tmpdir(), 'proc-test-'));
  const home = join(base, '.agent');
  mkdirSync(home, { recursive: true });
  process.env.AGENT_HOME = home;
  return { base, home };
}

const store = await import('./lib/store.mjs');
const schema = await import('./lib/schema.mjs');
const proc = await import('./lib/process.mjs');
const stats = await import('./lib/stats.mjs');
const skills = await import('./lib/skills.mjs');
const board = await import('./lib/board.mjs');
const hookMod = await import('./lib/hook.mjs');
const precheck = await import('./lib/precheck.mjs');
const journalMod = await import('./lib/journal.mjs');
const taskMod = await import('./lib/task.mjs');

// 造一个 2 阶段流程，产物指向 home 下绝对路径（存在与否可控）
function makeProcess(home) {
  return {
    process_version: 1,
    name: '测试流程',
    phases: [
      {
        id: 'p1', no: '01', icon: '📖', name: '第一阶段', intent: '产出 A',
        what: 'w1', why: 'y1', skills: ['skill-a'],
        inputs: [{ key: 'prd', name: '需求文档', path: join(home, 'prd.pdf') }],
        depends_on: [],
        gates: ['gate-1'], dod: ['dod-1'],
        artifacts: [{ key: 'a', name: '产物A', desc: '这是产物A', path: join(home, 'a.txt'), required: true }],
      },
      {
        id: 'p2', no: '02', icon: '⚙️', name: '第二阶段', intent: '产出 B',
        skills: ['skill-b'], depends_on: ['p1'],
        dod: ['dod-2'],
        artifacts: [{ key: 'b', name: '产物B', desc: '这是产物B', path: join(home, 'b.txt'), required: true }],
      },
    ],
    rails: [{ id: 'dod', name: '做得实', desc: '防假绿' }],
  };
}

function writeProcess(home, p) {
  store.writeJsonAtomic(proc.processPath(), p);
  return p;
}

// makeProcess 的变体：给 p2 挂上 worklist（逐系统开发任务模板）
function makeProcessWithWorklist(home) {
  const p = makeProcess(home);
  p.phases[1].worklist = [{ key: 'be', name: '后端' }, { key: 'fe', name: '前端' }];
  return p;
}

test('P1. 内置模板与自造 process 都通过 schema；非法被拒', () => {
  freshHome();
  // 内置模板
  const tplPath = join(dirname(new URL(import.meta.url).pathname), '..', 'process', 'process.template.json');
  const tpl = store.readJson(tplPath);
  assert.equal(schema.validate('process.schema.json', tpl).valid, true, '内置模板应过 schema');
  // 阶段01 应声明输入真源（需求文档），保证装完能引导到「基于需求文档做第一步」
  assert.ok((tpl.phases[0].inputs || []).length >= 1, '阶段01 应有 inputs（需求文档）');
  // 非法：phases 缺 artifacts
  const bad = { process_version: 1, name: 'x', phases: [{ id: 'p', name: 'n' }] };
  assert.equal(schema.validate('process.schema.json', bad).valid, false);
  // state schema
  const st = proc.freshState(tpl);
  assert.equal(schema.validate('process-state.schema.json', st).valid, true);
});

test('P2. seedPhaseTask 建出的 task 带正确 phase/DoD/约束，并登记进 state', () => {
  const { home } = freshHome();
  const p = writeProcess(home, makeProcess(home));
  const st = proc.freshState(p);
  const { taskId, created } = proc.seedPhaseTask(p, 'p1', st);
  assert.equal(created, true);
  assert.equal(taskId, 'phase-p1');
  assert.equal(st.phase_tasks.p1, 'phase-p1');
  assert.equal(st.current_phase, 'p1');
  const t = taskMod.loadTask('phase-p1');
  assert.equal(t.phase, '第一阶段');
  assert.deepEqual(t.definition_of_done.map((d) => d.text), ['dod-1']);
  assert.deepEqual(t.critical_constraints, ['gate-1']);
});

test('P3. computeNext 五条优先级各命中一次', () => {
  const { home } = freshHome();
  const p = writeProcess(home, makeProcess(home));
  let st = proc.freshState(p);

  // (a) 未开始任何阶段 → phase-start p1，hint 带输入真源（需求文档）
  let n = proc.computeNext(p, st);
  assert.equal(n.action, 'phase-start');
  assert.equal(n.phase_id, 'p1');
  assert.match(n.hint, /需求文档/, 'phase-start 应引导先读输入真源');
  assert.match(n.hint, /prd\.pdf/);

  // 进入 p1
  proc.seedPhaseTask(p, 'p1', st);

  // (b) required 产物未在磁盘 → produce-artifact，hint 含 skill 名
  n = proc.computeNext(p, st);
  assert.equal(n.action, 'produce-artifact');
  assert.match(n.hint, /skill-a/);

  // (c) 有中断步骤 → recover（优先于缺产物）
  journalMod.appendEvent('phase-p1', 'step_started', { stepId: 'step-x', payload: { intent: 'i' } });
  n = proc.computeNext(p, st);
  assert.equal(n.action, 'recover');
  // 收尾该中断步骤，便于后续断言
  journalMod.appendEvent('phase-p1', 'step_committed', { stepId: 'step-x' });

  // (d) 产物齐但阶段未完成 → complete-phase
  writeFileSync(join(home, 'a.txt'), 'x');
  st.artifacts.push({ phase_id: 'p1', key: 'a', name: '产物A', path: join(home, 'a.txt'), status: 'done', registered_at: store.nowIso() });
  n = proc.computeNext(p, st);
  assert.equal(n.action, 'complete-phase');

  // 完成 p1 → 焦点转 p2（phase-start）
  taskMod.updateTask('phase-p1', (t) => { t.status = 'completed'; });
  n = proc.computeNext(p, st);
  assert.equal(n.phase_id, 'p2');
  assert.equal(n.action, 'phase-start');

  // (e) 全部阶段完成 → all-done
  proc.seedPhaseTask(p, 'p2', st);
  writeFileSync(join(home, 'b.txt'), 'y');
  st.artifacts.push({ phase_id: 'p2', key: 'b', name: '产物B', path: join(home, 'b.txt'), status: 'done', registered_at: store.nowIso() });
  taskMod.updateTask('phase-p2', (t) => { t.status = 'completed'; });
  n = proc.computeNext(p, st);
  assert.equal(n.done, true);
  assert.equal(n.action, 'all-done');
});

test('P4. computePhaseView 产物磁盘回读：登记但缺失判 ✗，存在判 ✓', () => {
  const { home } = freshHome();
  const p = writeProcess(home, makeProcess(home));
  const st = proc.freshState(p);
  // 登记但文件不存在
  st.artifacts.push({ phase_id: 'p1', key: 'a', name: '产物A', path: join(home, 'a.txt'), status: 'done', registered_at: store.nowIso() });
  let v = proc.computePhaseView(p.phases[0], st);
  assert.equal(v.artifacts[0].registered, true);
  assert.equal(v.artifacts[0].on_disk, false, '登记但磁盘缺失 → on_disk=false');
  // 造出文件后 → on_disk=true
  writeFileSync(join(home, 'a.txt'), 'x');
  v = proc.computePhaseView(p.phases[0], st);
  assert.equal(v.artifacts[0].on_disk, true);
});

test('P5. detectSkill：命中判 installed，缺失判 not_found', () => {
  const { home } = freshHome();
  const cwd = dirname(home); // <base>，其下建 .claude/skills
  const skDir = join(cwd, '.claude', 'skills', 'foo');
  mkdirSync(skDir, { recursive: true });
  writeFileSync(join(skDir, 'SKILL.md'), '# foo');
  assert.equal(skills.detectSkill('foo', { cwd }), 'installed');
  assert.equal(skills.detectSkill('zzz-nonexistent-skill-xyz', { cwd }), 'not_found');
});

test('P6. buildBoardHtml 含全部阶段名/产物 desc/skillband 徽章/当前站高亮/缺失标记', () => {
  const { home } = freshHome();
  const p = writeProcess(home, makeProcess(home));
  const st = proc.freshState(p);
  proc.seedPhaseTask(p, 'p1', st); // current_phase=p1
  writeFileSync(join(home, 'a.txt'), 'x');
  st.artifacts.push({ phase_id: 'p1', key: 'a', name: '产物A', path: join(home, 'a.txt'), status: 'done', registered_at: store.nowIso() });
  journalMod.appendEvent('phase-p1', 'step_committed', { stepId: 'demo', payload: { summary: 's' } }); // 制造记忆活动
  const html = board.buildBoardHtml(p, st, { cwd: dirname(home), generatedAt: '2026-01-01T00:00:00Z' });
  assert.match(html, /第一阶段/);
  assert.match(html, /第二阶段/);
  assert.match(html, /这是产物A/);          // desc
  assert.match(html, /你在这/);              // 当前站高亮
  assert.match(html, /skpill/);              // skillband
  assert.match(html, /✓ 在磁盘/);            // p1 产物存在
  assert.match(html, /— 未产出/);            // p2 产物未产出
  assert.match(html, /输入真源/);            // 阶段展示输入真源
  assert.match(html, /prd\.pdf/);            // 需求文档路径
  // 双 tab 解耦
  assert.match(html, /data-t="flow"/);       // 流程 tab
  assert.match(html, /data-t="mem"/);        // 记忆 tab
  assert.match(html, /记忆概览/);            // 记忆 tab 内容
  assert.match(html, /任务快照/);            // 任务卡片区
  assert.match(html, /记忆在被调用/);        // journal 有事件 → 判定被调用
});

test('P8. memoryDetail 挖出事件分布/任务卡片/决策/证据/checkpoint', () => {
  const { home } = freshHome();
  const p = writeProcess(home, makeProcess(home));
  const st = proc.freshState(p);
  proc.seedPhaseTask(p, 'p1', st);
  journalMod.appendEvent('phase-p1', 'task_created', { payload: {} });
  journalMod.appendEvent('phase-p1', 'step_committed', { stepId: 's1', payload: {} });
  journalMod.appendEvent('phase-p1', 'step_committed', { stepId: 's2', payload: {} });
  journalMod.appendEvent('phase-p1', 'step_failed', { stepId: 's3', payload: { reason: '编译失败' } });
  const d = stats.memoryDetail();
  assert.equal(d.eventsByType.step_committed, 2, '事件类型分布应统计到 2 个 step_committed');
  assert.equal(d.failed.length, 1);
  assert.equal(d.failed[0].reason, '编译失败');
  assert.ok(d.tasks.find((t) => t.id === 'phase-p1'), '任务卡片应含 phase-p1');
  assert.ok(d.firstAt && d.lastAt, '应有时间跨度');
  assert.equal(typeof d.decisions, 'object');
  assert.equal(typeof d.evidenceCount, 'number');
});

test('P7. memoryStats 汇总 journal：任务数/事件数/最近/被调用判定', () => {
  const { home } = freshHome();
  const p = writeProcess(home, makeProcess(home));
  const st = proc.freshState(p);
  // 空 journal → 未被调用
  let m = stats.memoryStats();
  assert.equal(m.eventCount, 0);
  assert.equal(m.invoked, false);
  // 制造事件后 → 被调用，事件数/最后写入/最近可读
  proc.seedPhaseTask(p, 'p1', st);
  journalMod.appendEvent('phase-p1', 'task_created', { payload: {} });
  journalMod.appendEvent('phase-p1', 'step_committed', { stepId: 's1', payload: {} });
  m = stats.memoryStats();
  assert.equal(m.taskCount, 1);
  assert.equal(m.eventCount, 2);
  assert.equal(m.invoked, true);
  assert.ok(m.lastAt, '应有最后写入时间');
  assert.equal(m.recent[0].event, 'step_committed', '最近一条应在最前');
});

test('P9. eventSummary 提取事件内容/结果，时间线可读', () => {
  freshHome();
  assert.match(stats.eventSummary({ event: 'step_started', payload: { intent: '读需求文档' } }), /意图：读需求文档/);
  assert.match(stats.eventSummary({ event: 'step_committed', payload: { summary: '产出 arch.json' } }), /产出 arch\.json/);
  assert.match(stats.eventSummary({ event: 'verification_finished', payload: { result: 'pass' } }), /结果：pass/);
  assert.match(stats.eventSummary({ event: 'decision_recorded', payload: { title: '挂 ASSUMPTION', why: '未闭环' } }), /挂 ASSUMPTION/);
});

test('P10. board 渲染阶段验收 DoD（逐条）+ 产物路径可点/缺失降级', () => {
  const { home } = freshHome();
  const p = writeProcess(home, makeProcess(home));
  const st = proc.freshState(p);
  proc.seedPhaseTask(p, 'p1', st);                         // 建 phase-p1，dod=['dod-1'] 默认未达
  taskMod.updateTask('phase-p1', (t) => { t.definition_of_done[0].met = true; }); // 勾一条，验证计划书按真实态展示
  writeFileSync(join(home, 'a.txt'), 'x');                 // p1 产物落盘
  st.artifacts.push({ phase_id: 'p1', key: 'a', name: '产物A', path: join(home, 'a.txt'), status: 'done', registered_at: store.nowIso() });
  journalMod.appendEvent('phase-p1', 'step_committed', { stepId: 'demo', payload: { summary: 's' } });
  // outDir=home：磁盘上的 a.txt 相对 board.html(在 home) 即 'a.txt'
  const html = board.buildBoardHtml(p, st, { cwd: dirname(home), outDir: home, generatedAt: '2026-01-01T00:00:00Z' });
  assert.match(html, /阶段验收 DoD/);                      // 记忆 tab DoD 区块（计划书让名给流程 tab 的开发任务清单）
  assert.match(html, /dod-1/);                             // DoD 文案逐条展示
  assert.match(html, /<a href="a\.txt"/);                  // 在磁盘产物 → 相对可点链接
  assert.doesNotMatch(html, /<a href="b\.txt"/);           // p2 产物缺失 → 不给链接（降级纯文本）
});

test('P11. installBoardHook 幂等：重复装不重复追加、不改内容', () => {
  const { base } = freshHome();
  // 无 .git → 安静跳过
  assert.match(hookMod.installBoardHook({ cwd: base }), /未检测到 \.git/);
  mkdirSync(join(base, '.git'), { recursive: true });
  const hookFile = join(base, '.git', 'hooks', 'post-commit');
  // 首次装
  assert.match(hookMod.installBoardHook({ cwd: base }), /已装 post-commit/);
  const first = readFileSync(hookFile, 'utf8');
  assert.match(first, /agent-dev-scaffold board refresh/);
  // 再装 → 幂等跳过，内容不变、标记块只一个
  assert.match(hookMod.installBoardHook({ cwd: base }), /已含 board 刷新块/);
  const second = readFileSync(hookFile, 'utf8');
  assert.equal(second, first, '再装不应改动 hook 文件');
  assert.equal((second.match(/board refresh >>>/g) || []).length, 1, '标记块只应出现一次');
});

test('P12. installBoardHook 追加到用户已有 hook，不覆盖原逻辑', () => {
  const { base } = freshHome();
  mkdirSync(join(base, '.git', 'hooks'), { recursive: true });
  const hookFile = join(base, '.git', 'hooks', 'post-commit');
  writeFileSync(hookFile, '#!/bin/sh\necho "用户原有钩子"\n');
  assert.match(hookMod.installBoardHook({ cwd: base }), /追加到现有/);
  const content = readFileSync(hookFile, 'utf8');
  assert.match(content, /用户原有钩子/, '原逻辑必须保留');
  assert.match(content, /board refresh/, '刷新块已追加');
});

test('P14. addSystem/setWorklistStatus：铺开任务、幂等、状态更新与非法校验', () => {
  const { home } = freshHome();
  const p = writeProcess(home, makeProcessWithWorklist(home));
  const st = proc.freshState(p);
  const r = proc.addSystem(p, st, 'match', '赛事系统');
  assert.equal(r.created, true);
  assert.equal(r.count, 2, 'worklist 有 2 项');
  assert.equal(st.systems[0].tasks.length, 2);
  assert.equal(st.systems[0].tasks[0].status, 'not_started', '铺开时初始未开始');
  // 幂等：重复登记不新增
  assert.equal(proc.addSystem(p, st, 'match', '赛事系统').created, false);
  assert.equal(st.systems.length, 1);
  // 状态更新
  proc.setWorklistStatus(p, st, 'match', 'be', 'completed');
  assert.equal(st.systems[0].tasks.find((t) => t.key === 'be').status, 'completed');
  // 非法任务 / 未登记系统 → 报错
  assert.throws(() => proc.setWorklistStatus(p, st, 'match', 'nope', 'completed'), /不在 worklist/);
  assert.throws(() => proc.setWorklistStatus(p, st, 'ghost', 'be', 'completed'), /未登记系统/);
  // 带 systems 的 state 仍过 schema（saveState 会校验）
  proc.saveState(st);
});

test('P15. computeNext worklist 分支：无系统→add-system，有待办→worklist-task，做完→落后续', () => {
  const { home } = freshHome();
  const p = writeProcess(home, makeProcessWithWorklist(home));
  const st = proc.freshState(p);
  // 完成 p1，让焦点转到带 worklist 的 p2
  proc.seedPhaseTask(p, 'p1', st);
  writeFileSync(join(home, 'a.txt'), 'x');
  st.artifacts.push({ phase_id: 'p1', key: 'a', name: '产物A', path: join(home, 'a.txt'), status: 'done', registered_at: store.nowIso() });
  taskMod.updateTask('phase-p1', (t) => { t.status = 'completed'; });
  proc.seedPhaseTask(p, 'p2', st);
  // 无系统 → add-system
  assert.equal(proc.computeNext(p, st).action, 'add-system');
  // 登记后 → 指向第一个待办任务（be=后端）
  proc.addSystem(p, st, 'match', '赛事系统');
  let n = proc.computeNext(p, st);
  assert.equal(n.action, 'worklist-task');
  assert.match(n.hint, /赛事系统/);
  assert.match(n.hint, /后端/);
  // 全部任务完成 → 不再是 worklist-task（落到缺产物 produce-artifact）
  proc.setWorklistStatus(p, st, 'match', 'be', 'completed');
  proc.setWorklistStatus(p, st, 'match', 'fe', 'completed');
  assert.notEqual(proc.computeNext(p, st).action, 'worklist-task');
});

test('P16. board 流程 tab 渲染逐系统开发任务清单', () => {
  const { home } = freshHome();
  const p = writeProcess(home, makeProcessWithWorklist(home));
  const st = proc.freshState(p);
  proc.seedPhaseTask(p, 'p2', st);
  proc.addSystem(p, st, 'match', '赛事系统');
  proc.setWorklistStatus(p, st, 'match', 'be', 'completed');
  const html = board.buildBoardHtml(p, st, { cwd: dirname(home), outDir: home });
  assert.match(html, /开发任务清单 · 逐系统/);
  assert.match(html, /赛事系统/);
  assert.match(html, /wlcell/);
});

test('P17. blockingDeps 阶段顺序硬门：前置未完成→拦、完成且产物齐→放行、无依赖→恒放行', () => {
  const { home } = freshHome();
  const p = writeProcess(home, makeProcess(home)); // p1 无依赖；p2 depends_on p1
  const st = proc.freshState(p);
  // p1 无前置 → 恒放行
  assert.deepEqual(proc.blockingDeps(p, st, 'p1'), []);
  // p2 依赖 p1，p1 未开始 → 被拦
  let b = proc.blockingDeps(p, st, 'p2');
  assert.equal(b.length, 1);
  assert.equal(b[0].id, 'p1');
  // p1 已 completed 但 required 产物未落盘 → 仍拦（advanceable=false），并报出缺失产物名
  proc.seedPhaseTask(p, 'p1', st);
  taskMod.updateTask('phase-p1', (t) => { t.status = 'completed'; });
  b = proc.blockingDeps(p, st, 'p2');
  assert.equal(b.length, 1, '产物未落盘应仍拦');
  assert.ok(b[0].missing.includes('产物A'), '应报出缺失的 required 产物名');
  // 产物落盘 + task completed → 放行
  writeFileSync(join(home, 'a.txt'), 'x');
  st.artifacts.push({ phase_id: 'p1', key: 'a', name: '产物A', path: join(home, 'a.txt'), status: 'done', registered_at: store.nowIso() });
  assert.deepEqual(proc.blockingDeps(p, st, 'p2'), [], '前置完成且产物齐 → 放行');
});

test('P13. 内置模板：bug-fix 依赖链衔接，fix-plan 是确认门、verify 双轨可回退守回归', () => {
  freshHome();
  const tplPath = join(dirname(new URL(import.meta.url).pathname), '..', 'process', 'process.template.json');
  const tpl = store.readJson(tplPath);
  const ids = (tpl.phases || []).map((ph) => ph.id);
  // 起点=系统测绘（先测绘再定位，不凭记忆），终点=报告
  const orient = tpl.phases.find((ph) => ph.id === 'orient');
  assert.ok(orient && (orient.depends_on || []).length === 0, 'orient 应为起点（无前置）');
  assert.ok(ids.includes('report'), '应有 report 终点阶段');
  // fix-plan = 人工确认门：依赖影响面，gate 含确认卡点（这是"我确认后再改"的落点）
  const fp = tpl.phases.find((ph) => ph.id === 'fix-plan');
  assert.ok(fp, '应有 fix-plan 阶段');
  assert.deepEqual(fp.depends_on, ['impact'], 'fix-plan 依赖影响面分析');
  assert.ok((fp.gates || []).some((g) => /确认/.test(g)), 'fix-plan 必须含人工确认门');
  // reconcile = 改后 diff 对账门：依赖 fix，gate 含 impact-check 对账 + 启发式边界声明
  const rc = tpl.phases.find((ph) => ph.id === 'reconcile');
  assert.ok(rc, '应有 reconcile 影响面复核阶段（改后 diff 对账）');
  assert.deepEqual(rc.depends_on, ['fix'], 'reconcile 依赖 fix（改完才能对账）');
  assert.ok((rc.gates || []).some((g) => /impact-check/.test(g)), 'reconcile 必须引导跑 impact-check 对账');
  assert.ok((rc.artifacts || []).some((a) => a.key === 'impact-check'), 'reconcile 产出对账清单');
  // verify = harness 闭环：改为依赖 reconcile（对账先于验证），gate 体现失败回退 + 回归门（不假绿）
  const vf = tpl.phases.find((ph) => ph.id === 'verify');
  assert.deepEqual(vf.depends_on, ['reconcile'], 'verify 依赖 reconcile（先过对账门再验证）');
  assert.equal(vf.no, '08', 'verify 编号顺延为 08');
  assert.ok((vf.gates || []).some((g) => /对账|impact-check|复核/.test(g)), 'verify PASS 前须确认对账无未决项');
  assert.ok((vf.gates || []).some((g) => /回退|FAIL/.test(g)), 'verify 必须含失败回退闭环');
  assert.ok((vf.gates || []).some((g) => /回归/.test(g)), 'verify 必须守回归门');
  // 依赖链完整：每个阶段的 depends_on 都指向真实存在的阶段（不悬空）
  for (const ph of tpl.phases) {
    for (const d of (ph.depends_on || [])) assert.ok(ids.includes(d), `阶段 ${ph.id} 依赖的 ${d} 应存在`);
  }
});

test('P18. installPrecommitHook 幂等：装/再装不重复；node 缺失自动跳过块；追加不覆盖原逻辑', () => {
  const { base } = freshHome();
  // 无 .git → 安静跳过
  assert.match(hookMod.installPrecommitHook({ cwd: base }), /未检测到 \.git/);
  mkdirSync(join(base, '.git', 'hooks'), { recursive: true });
  const hookFile = join(base, '.git', 'hooks', 'pre-commit');
  // 首次装
  assert.match(hookMod.installPrecommitHook({ cwd: base }), /已装 pre-commit/);
  const first = readFileSync(hookFile, 'utf8');
  assert.match(first, /precommit guard/);
  assert.match(first, /command -v node/);   // node 缺失自动跳过，不阻塞提交
  assert.match(first, /precheck/);
  // 再装幂等：内容不变、标记块只一个
  assert.match(hookMod.installPrecommitHook({ cwd: base }), /已含流程兜底块/);
  const second = readFileSync(hookFile, 'utf8');
  assert.equal(second, first);
  assert.equal((second.match(/precommit guard >>>/g) || []).length, 1);
});

test('P19. evaluatePrecommit 软兜底：非脚手架不干预、中断步骤硬拦、未对账仅警告、strict 升级、已对账放行', () => {
  // 非脚手架项目 → 完全不干预
  assert.deepEqual(precheck.evaluatePrecommit({ processOn: false, stagedBusiness: 5 }), { block: false, messages: [] });
  // 中断步骤 → 软硬都硬拦
  let r = precheck.evaluatePrecommit({ processOn: true, interruptedCount: 1 });
  assert.equal(r.block, true);
  assert.ok(r.messages.some((m) => m.level === 'error' && /未收尾/.test(m.text)));
  // 提交业务码但未过对账，软兜底 → 警告不拦
  r = precheck.evaluatePrecommit({ processOn: true, stagedBusiness: 2, reconcileExists: true, reconcileDone: false, strict: false });
  assert.equal(r.block, false);
  assert.ok(r.messages.some((m) => m.level === 'warn'));
  // 同上但 strict → 升级硬拦
  r = precheck.evaluatePrecommit({ processOn: true, stagedBusiness: 2, reconcileExists: true, reconcileDone: false, strict: true });
  assert.equal(r.block, true);
  // 已过对账 → info 放行
  r = precheck.evaluatePrecommit({ processOn: true, stagedBusiness: 2, reconcileExists: true, reconcileDone: true });
  assert.equal(r.block, false);
  assert.ok(r.messages.some((m) => m.level === 'info' && /对账门/.test(m.text)));
  // 仅 .agent 产物、无业务码 → 放行
  r = precheck.evaluatePrecommit({ processOn: true, stagedBusiness: 0, reconcileExists: true });
  assert.equal(r.block, false);
});
