import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  addOperationalBug,
  bugPaths,
  classifyBugSignal,
  loadBugLedger,
  mergeImportedBugs,
} from './lib/bugcapture.mjs';
import {
  closeOperationalBug,
  importRetrospectiveMarkdown,
  loadRetrospective,
  retrospectivePaths,
} from './lib/retrospective.mjs';
import {
  assertReportCompletionGate,
  runBugfixEvolution,
} from './lib/evolution-gate.mjs';
import { buildBugReport } from './lib/report.mjs';

const cli = join(dirname(fileURLToPath(import.meta.url)), 'agent.mjs');
const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));

function freshRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'bug-learning-test-'));
  mkdirSync(join(root, '.agent'), { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function runCli(root, args) {
  return spawnSync(process.execPath, [cli, ...args, '--json'], {
    cwd: root,
    env: { ...process.env, AGENT_HOME: join(root, '.agent') },
    encoding: 'utf8',
  });
}

function jsonOutput(result) {
  const lines = String(result.stdout || '').trim().split('\n').filter(Boolean);
  return lines.length ? JSON.parse(lines.at(-1)) : {};
}

test('Bug signal classifier captures concrete defects and excludes discussion', () => {
  assert.equal(classifyBugSignal('这个页面有问题，保存失败').capture, true);
  assert.equal(classifyBugSignal('记入 Bug：地图打不开').explicit, true);
  assert.equal(classifyBugSignal('这不是 Bug，是正常行为').capture, false);
  assert.equal(classifyBugSignal('我们先讨论，如果以后报错怎么处理').capture, false);
  assert.equal(classifyBugSignal('需求文档写着“页面有问题要反馈”，请解释规则').capture, false);
  assert.equal(classifyBugSignal('请介绍 Bug 管理流程').capture, false);
});

test('operational Bug capture allocates ids, redacts, suppresses open duplicates, and remains schema-compatible', (t) => {
  const root = freshRoot(t);
  const first = addOperationalBug({
    root,
    source: 'user',
    title: '登录保存失败',
    actual: 'sk-liveabcdefghijklmnop AKIAABCDEFGHIJKLMNOP AIzaabcdefghijklmnopqrstuvwxyz github_pat_abcdefghijklmnopqrstuvwxyz，手机号 13800138000',
    phaseId: 'reproduce',
    taskId: 'phase-reproduce',
    evidence: ['browser:shot-1'],
  });
  assert.equal(first.bug.id, 'BUG-001');
  assert.equal(first.duplicate, false);
  assert.equal(first.bug.source_status, '待修复');
  assert.equal(first.bug.verification_status, '待验证');
  assert.equal(first.bug.in_scope, true);
  assert.doesNotMatch(first.bug.actual, /sk-live|AKIA|AIza|github_pat|13800138000/);
  assert.match(first.bug.actual, /138\*\*\*\*8000/);

  const duplicate = addOperationalBug({ root, source: 'user', title: '登录保存失败', actual: 'sk-liveabcdefghijklmnop AKIAABCDEFGHIJKLMNOP AIzaabcdefghijklmnopqrstuvwxyz github_pat_abcdefghijklmnopqrstuvwxyz，手机号 13800138000' });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.reopened, false);
  assert.equal(loadBugLedger(root).length, 1);
  assert.equal(existsSync(bugPaths(root).ledger), true);
});

test('legacy imported Bugs normalize in memory and terminal recurrence reopens with closure history', (t) => {
  const root = freshRoot(t);
  const paths = bugPaths(root);
  const legacy = {
    id: 'BUG-009',
    title: '历史地图问题',
    actual: '地图空白',
    status: '已归档',
    source_status: '已验收',
    verification_status: '已归档',
    in_scope: false,
    source: 'import',
    source_key: 'sheet#9',
    fingerprint: '',
  };
  writeFileSync(paths.ledger, JSON.stringify([legacy], null, 2));
  const normalized = loadBugLedger(root);
  assert.equal(normalized[0].source, 'import');
  assert.match(normalized[0].fingerprint, /^[a-f0-9]{64}$/);

  const recurrence = addOperationalBug({ root, source: 'user', title: '历史地图问题', actual: '地图空白', evidence: ['browser:shot-2'] });
  assert.equal(recurrence.duplicate, true);
  assert.equal(recurrence.reopened, true);
  assert.equal(recurrence.bug.verification_status, '待验证');
  assert.equal(recurrence.bug.in_scope, true);
  assert.equal(recurrence.bug.reopened_count, 1);
  assert.equal(recurrence.bug.previous_closures.length, 1);
  assert.deepEqual(recurrence.bug.evidence_refs, ['browser:shot-2']);
  assert.equal(JSON.parse(readFileSync(paths.ledger, 'utf8')).length, 1);
});

test('Bug ledger rejects traversal ids, redacts nested raw data, and preserves object envelope metadata', (t) => {
  const root = freshRoot(t);
  const paths = bugPaths(root);
  writeFileSync(paths.ledger, JSON.stringify([{
    id: '../../victim', title: 'bad', status: '待修复', raw: {},
  }]));
  assert.throws(() => loadBugLedger(root), /ID 非法/);
  assert.throws(() => buildBugReport(join(root, '.agent')), /ID 非法/);
  const impact = runCli(root, ['impact-check', '--bug', '../../victim']);
  assert.equal(impact.status, 1);
  assert.equal(jsonOutput(impact).code, 'EINVALID_BUG');

  writeFileSync(paths.ledger, JSON.stringify({
    version: 3,
    owner: 'team-a',
    bugs: [{
      id: 'BUG-010', title: '导入问题', actual: '失败', status: '待修复',
      reporter: '13800138000', raw: { apiKey: 'AKIAABCDEFGHIJKLMNOP', phone: '13800138000' },
    }],
  }, null, 2));
  const loaded = loadBugLedger(root);
  assert.doesNotMatch(JSON.stringify(loaded), /AKIAABCDEFGHIJKLMNOP|13800138000/);
  addOperationalBug({ root, source: 'user', title: '新问题', actual: '页面失败' });
  const persisted = JSON.parse(readFileSync(paths.ledger, 'utf8'));
  assert.equal(persisted.version, 3);
  assert.equal(persisted.owner, 'team-a');
  assert.equal(persisted.bugs.length, 2);
});

test('reimport by stable source key updates upstream fields and reopens a terminal Bug', (t) => {
  const root = freshRoot(t);
  mergeImportedBugs(root, [{
    id: 'BUG-001', title: '旧标题', actual: '旧现象', status: '已归档', source: 'import',
    source_key: 'sheet-a#row-2', source_status: '已验收', verification_status: '已归档', in_scope: false,
  }]);
  const merged = mergeImportedBugs(root, [{
    id: 'BUG-001', title: '新标题', actual: '新现象', status: '待修复', source: 'import',
    source_key: 'sheet-a#row-2', source_status: '待修复',
  }]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].title, '新标题');
  assert.equal(merged[0].verification_status, '待验证');
  assert.equal(merged[0].in_scope, true);
  assert.equal(merged[0].reopened_count, 1);
  assert.equal(merged[0].previous_closures[0].status, '已归档');
});

function writeClosureArtifacts(root, id, { omit = '' } = {}) {
  const dir = join(root, '.agent', 'bugs', id);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, 'evidence'), { recursive: true });
  const files = {
    'root-cause.md': '# 根因\nBIGINT ID 精度丢失\n',
    'impact.md': '# 影响\n列表到详情链路\n',
    'change.md': '# 改动\n统一使用字符串 ID\n',
    'impact-check.md': '# 对账\nPASS，无计划外改动\n',
  };
  for (const [name, content] of Object.entries(files)) if (name !== omit) writeFileSync(join(dir, name), content);
  if (omit !== 'evidence') writeFileSync(join(dir, 'evidence', 'verification.md'), '# 验证\nPASS\n');
}

test('bug close rejects missing artifacts and archives verified facts when evidence is complete', (t) => {
  const root = freshRoot(t);
  addOperationalBug({ root, source: 'user', title: '详情打不开', actual: '点击后提示不存在' });

  assert.throws(() => closeOperationalBug({ root, id: 'BUG-001' }), /root-cause\.md/);
  writeClosureArtifacts(root, 'BUG-001', { omit: 'impact-check.md' });
  assert.throws(() => closeOperationalBug({ root, id: 'BUG-001' }), /impact-check\.md/);
  writeClosureArtifacts(root, 'BUG-001', { omit: 'evidence' });
  assert.throws(() => closeOperationalBug({ root, id: 'BUG-001' }), /evidence/);
  writeClosureArtifacts(root, 'BUG-001');

  const result = closeOperationalBug({ root, id: 'BUG-001' });
  assert.equal(result.bug.verification_status, '已归档');
  assert.equal(result.bug.in_scope, false);
  assert.equal(result.record.operational_bug_id, 'BUG-001');
  assert.match(result.record.root_cause, /BIGINT ID 精度丢失/);
  assert.match(result.record.resolution, /字符串 ID/);
  assert.equal(loadRetrospective(root).length, 1);
  assert.equal(existsSync(retrospectivePaths(root).closedMarkdown), true);
  assert.match(readFileSync(retrospectivePaths(root).closedMarkdown, 'utf8'), /BUG-001/);

  const reopened = addOperationalBug({ root, source: 'user', title: '详情打不开', actual: '点击后提示不存在' });
  assert.equal(reopened.reopened, true);
  assert.throws(() => closeOperationalBug({ root, id: 'BUG-001' }), /本轮可回读 root-cause\.md/);
  writeClosureArtifacts(root, 'BUG-001');
  assert.equal(closeOperationalBug({ root, id: 'BUG-001' }).bug.verification_status, '已归档');
});

test('existing retrospective requires import backup before close and deferred Bugs never enter Evolver input', (t) => {
  const root = freshRoot(t);
  const paths = retrospectivePaths(root);
  mkdirSync(paths.docs, { recursive: true });
  writeFileSync(paths.markdown, [
    '# 旧复盘',
    '| 编号 | 用户反馈 / 现象 | 根因 | 本轮处置 | 影响 | 状态 |',
    '|---|---|---|---|---|---|',
    '| BUG-099 | 旧问题 | 旧根因 | 旧处置 | 旧影响 | 已归档 |',
    '## 手工说明',
    '- 必须保留',
  ].join('\n'));
  addOperationalBug({ root, source: 'user', title: '新问题', actual: '新现象' });
  writeClosureArtifacts(root, 'BUG-001');
  assert.throws(() => closeOperationalBug({ root, id: 'BUG-001' }), /retrospective-import/);
  const imported = importRetrospectiveMarkdown({ root, file: paths.markdown });
  assert.equal(imported.imported, 1);
  assert.equal(existsSync(imported.backupPath), true);
  assert.match(readFileSync(imported.backupPath, 'utf8'), /必须保留/);
  assert.match(readFileSync(paths.markdown, 'utf8'), /必须保留/);
  assert.equal(closeOperationalBug({ root, id: 'BUG-001' }).bug.verification_status, '已归档');

  const pending = addOperationalBug({ root, source: 'user', title: '延期问题', actual: '等待外部系统' });
  const deferred = closeOperationalBug({ root, id: pending.bug.id, status: '延后', resolution: '等待供应商开放接口' });
  assert.equal(deferred.record.root_cause, '');
  assert.doesNotMatch(readFileSync(paths.closedMarkdown, 'utf8'), /延期问题|等待供应商/);
});

test('Bugfix evolution is offline, fingerprinted, and report gate blocks open Bugs', (t) => {
  const root = freshRoot(t);
  addOperationalBug({ root, source: 'engineering', title: '构建失败', actual: '退出码 1' });
  assert.throws(() => assertReportCompletionGate({ root, phaseId: 'report' }), /未归档 Bug.*BUG-001/);
  assert.deepEqual(assertReportCompletionGate({ root, phaseId: 'verify' }), { gated: false, skipped: true, reason: 'phase-not-gated' });

  writeClosureArtifacts(root, 'BUG-001');
  closeOperationalBug({ root, id: 'BUG-001' });
  const report = join(root, 'harness_evolver', 'reports', 'run.md');
  mkdirSync(dirname(report), { recursive: true });
  writeFileSync(report, '# report\n');
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    return { status: 0, stdout: `${JSON.stringify({ report_path: report, added_rule_ids: ['EVR-COD-1'], removed_rule_ids: [] })}\n`, stderr: '' };
  };
  const first = runBugfixEvolution({ root, reason: 'bug-close:BUG-001', spawn });
  assert.equal(first.skipped, false);
  assert.match(calls[0].args.join(' '), /--use-llm never/);
  assert.match(calls[0].args.join(' '), /已归档反馈\.md/);
  writeFileSync(retrospectivePaths(root).closedMarkdown, '# tampered open symptom\n');
  const second = runBugfixEvolution({ root, reason: 'report-gate', spawn });
  assert.equal(second.skipped, true);
  assert.equal(calls.length, 1);
  assert.match(readFileSync(retrospectivePaths(root).closedMarkdown, 'utf8'), /BUG-001/);

  assert.throws(() => assertReportCompletionGate({ root, phaseId: 'report', spawn }), /Bug HTML 报告/);
  mkdirSync(join(root, '.agent', 'reports'), { recursive: true });
  writeFileSync(join(root, '.agent', 'reports', 'index.html'), '<html>ok</html>');
  const gate = assertReportCompletionGate({ root, phaseId: 'report', spawn });
  assert.equal(gate.skipped, true);
});

test('failed evolution records pending state and blocks report completion', (t) => {
  const root = freshRoot(t);
  addOperationalBug({ root, source: 'user', title: '地图空白', actual: '地图无法加载' });
  writeClosureArtifacts(root, 'BUG-001');
  closeOperationalBug({ root, id: 'BUG-001' });
  assert.throws(
    () => runBugfixEvolution({ root, reason: 'bug-close', spawn: () => ({ status: 2, stdout: '', stderr: 'python failed' }) }),
    /python failed/,
  );
  const state = JSON.parse(readFileSync(retrospectivePaths(root).evolution, 'utf8'));
  assert.equal(state.pending, true);
  mkdirSync(join(root, '.agent', 'reports'), { recursive: true });
  writeFileSync(join(root, '.agent', 'reports', 'index.html'), '<html>ok</html>');
  assert.throws(
    () => assertReportCompletionGate({ root, phaseId: 'report', spawn: () => ({ status: 2, stdout: '', stderr: 'still failed' }) }),
    /still failed/,
  );
});

test('report gate rejects pending state even when no retrospective records exist', (t) => {
  const root = freshRoot(t);
  const paths = retrospectivePaths(root);
  mkdirSync(paths.docs, { recursive: true });
  writeFileSync(paths.ledger, '');
  writeFileSync(paths.evolution, JSON.stringify({ schema_version: 1, pending: true, error: 'previous failure' }));
  mkdirSync(join(root, '.agent', 'reports'), { recursive: true });
  writeFileSync(join(root, '.agent', 'reports', 'index.html'), '<html>ok</html>');
  assert.throws(() => assertReportCompletionGate({ root, phaseId: 'report' }), /pending|previous failure/);
});

test('Bug CLI detects, adds, closes with evidence, evolves, and lists', (t) => {
  const root = freshRoot(t);
  cpSync(join(repoRoot, 'harness_evolver'), join(root, 'harness_evolver'), { recursive: true });
  let result = runCli(root, ['bug', 'detect', '--text', '这个详情有问题，点击后打不开']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(jsonOutput(result).capture, true);

  result = runCli(root, ['bug', 'add', '--source', 'user', '--title', '详情打不开', '--actual', '点击后页面空白']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(jsonOutput(result).bug.id, 'BUG-001');
  const imported = join(root, 'imported-bugs.json');
  writeFileSync(imported, JSON.stringify([{ id: 'BUG-001', title: '导入的构建问题', actual: '构建退出码 1', status: '待修复' }]));
  result = runCli(root, ['bug', 'import', '--file', imported]);
  assert.equal(result.status, 0, result.stderr);
  result = runCli(root, ['bug', 'list']);
  assert.equal(jsonOutput(result).items.length, 2);
  assert.equal(jsonOutput(result).items.find((bug) => bug.id === 'BUG-001').title, '详情打不开');
  writeFileSync(imported, JSON.stringify([{ id: 'BUG-001', title: '导入构建问题已更新', actual: '构建退出码 2', status: '待修复' }]));
  result = runCli(root, ['bug', 'import', '--file', imported]);
  assert.equal(result.status, 0, result.stderr);
  result = runCli(root, ['bug', 'list']);
  assert.equal(jsonOutput(result).items.length, 2);
  assert.equal(jsonOutput(result).items.find((bug) => bug.id === 'BUG-002').title, '导入构建问题已更新');
  const sourceA = join(root, 'a', 'bugs.json');
  const sourceB = join(root, 'b', 'bugs.json');
  mkdirSync(dirname(sourceA), { recursive: true });
  mkdirSync(dirname(sourceB), { recursive: true });
  writeFileSync(sourceA, JSON.stringify([{ id: 'BUG-77', title: '来源 A', actual: 'A 现象', status: '待修复' }]));
  writeFileSync(sourceB, JSON.stringify([{ id: 'BUG-77', title: '来源 B', actual: 'B 现象', status: '待修复' }]));
  assert.equal(runCli(root, ['bug', 'import', '--file', sourceA]).status, 0);
  assert.equal(runCli(root, ['bug', 'import', '--file', sourceB]).status, 0);
  result = runCli(root, ['bug', 'list']);
  assert.equal(jsonOutput(result).items.length, 4);
  assert.equal(jsonOutput(result).items.some((bug) => bug.title === '来源 A'), true);
  assert.equal(jsonOutput(result).items.some((bug) => bug.title === '来源 B'), true);
  writeClosureArtifacts(root, 'BUG-001');

  result = runCli(root, ['bug', 'close', 'BUG-001']);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const closed = jsonOutput(result);
  assert.equal(closed.bug.verification_status, '已归档');
  assert.equal(closed.evolution.pending, false);
  assert.equal(existsSync(join(root, closed.evolution.report_path)), true);

  result = runCli(root, ['bug', 'evolve']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(jsonOutput(result).skipped, true);

  result = runCli(root, ['bug', 'list']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(jsonOutput(result).items.length, 4);
});

test('complete returns EOPEN_BUGS for manual report task with unresolved Bug', (t) => {
  const root = freshRoot(t);
  rmSync(join(root, '.agent'), { recursive: true, force: true });
  cpSync(join(repoRoot, 'dot-agent'), join(root, '.agent'), { recursive: true });
  cpSync(join(repoRoot, 'harness_evolver'), join(root, 'harness_evolver'), { recursive: true });
  let result = runCli(root, ['install']);
  assert.equal(result.status, 0, result.stderr);
  result = runCli(root, ['init', '--id', 'manual-report', '--objective', 'manual report', '--phase', 'report', '--dod', 'done']);
  assert.equal(result.status, 0, result.stderr);
  result = runCli(root, ['context']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(jsonOutput(result).context, /Bugfix 自动学习协议/);
  assert.match(jsonOutput(result).context, /历史交付质量反馈/);
  result = runCli(root, ['bug', 'add', '--source', 'engineering', '--title', '构建失败', '--actual', '退出码 1']);
  assert.equal(result.status, 0, result.stderr);
  result = runCli(root, ['complete']);
  assert.equal(result.status, 1);
  assert.equal(jsonOutput(result).code, 'EOPEN_BUGS');
  assert.match(jsonOutput(result).error, /BUG-001/);
});
