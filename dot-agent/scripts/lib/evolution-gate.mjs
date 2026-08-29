// Bugfix 复盘演进与 report 完成门禁。

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { delimiter, isAbsolute, join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { nowIso, writeJsonAtomic } from './store.mjs';
import { loadBugLedger } from './bugcapture.mjs';
import { assertRetrospectiveImported, loadRetrospective, refreshRetrospective, retrospectivePaths } from './retrospective.mjs';

function gateError(message, code = 'EEVOLUTION') {
  return Object.assign(new Error(message), { code });
}

function readableNonemptyFile(file) {
  try { const stat = statSync(file); return stat.isFile() && stat.size > 0; } catch { return false; }
}

function loadState(root) {
  const file = retrospectivePaths(root).evolution;
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch { throw gateError(`演进状态不是合法 JSON：${file}`, 'EINVALID_EVOLUTION'); }
}

function parseOutput(stdout) {
  const lines = String(stdout || '').trim().split('\n').filter(Boolean);
  if (!lines.length) throw gateError('Evolver 未返回 JSON');
  try { return JSON.parse(lines.at(-1)); } catch { throw gateError('Evolver 返回不可解析'); }
}

function invoke({ root, input, spawn }) {
  const args = ['-m', 'harness_evolver.evolve', '--input-docs', input, '--use-llm', 'never', '--project-root', root, '--json'];
  const env = { ...process.env, PYTHONPATH: [root, process.env.PYTHONPATH].filter(Boolean).join(delimiter) };
  const candidates = [process.env.HARNESS_EVOLVER_PYTHON, 'python3', 'python'].filter(Boolean);
  let failure = '';
  for (const command of candidates) {
    const result = spawn(command, args, { cwd: root, env, encoding: 'utf8', timeout: 120_000 });
    if (result.status === 0) return { command, args, output: parseOutput(result.stdout) };
    if (result.error?.code === 'ENOENT') continue;
    failure = String(result.stderr || result.stdout || result.error?.message || `exit ${result.status}`).trim().slice(0, 600);
    break;
  }
  throw gateError(`Bugfix 规则演进失败：${failure || '未找到 Python'}`);
}

function persistPending(root, previous, inputSha, reason, message) {
  const state = {
    schema_version: 1, input_sha256: inputSha, report_path: previous?.report_path || '',
    evolved_at: previous?.evolved_at || null, attempted_at: nowIso(), reason,
    pending: true, error: message, added_rule_ids: previous?.added_rule_ids || [], removed_rule_ids: previous?.removed_rule_ids || [],
  };
  writeJsonAtomic(retrospectivePaths(root).evolution, state);
  return state;
}

export function runBugfixEvolution({ root, reason = 'manual', force = false, spawn = spawnSync } = {}) {
  const paths = retrospectivePaths(root);
  assertRetrospectiveImported(root);
  const previous = loadState(root);
  const refreshed = refreshRetrospective(root);
  if (!refreshed.records.length || !existsSync(paths.closedMarkdown)) {
    if (previous?.pending) throw gateError(`Evolver 仍处于 pending：${previous.error || '上次演进失败'}`, 'EPENDING_EVOLUTION');
    return { gated: true, skipped: true, reason: 'no-archived-feedback', state: previous };
  }
  const inputSha = createHash('sha256').update(readFileSync(paths.closedMarkdown)).digest('hex');
  const previousReport = previous?.report_path ? join(root, previous.report_path) : '';
  if (!force && previous?.pending === false && previous.input_sha256 === inputSha && readableNonemptyFile(previousReport)) {
    return { gated: true, skipped: true, reason: 'unchanged', state: previous };
  }
  try {
    const { command, args, output } = invoke({ root, input: paths.closedMarkdown, spawn });
    if (output.ok === false) throw gateError(output.error || 'Evolver 返回失败');
    const report = output.report_path || '';
    const absolute = isAbsolute(report) ? report : join(root, report);
    if (!report || !readableNonemptyFile(absolute)) throw gateError(`Evolver 报告不可回读或不是非空文件：${report || '(空)'}`);
    const relativeReport = relative(realpathSync(root), realpathSync(absolute));
    if (relativeReport.startsWith('..') || isAbsolute(relativeReport)) throw gateError(`Evolver 报告越出项目根：${report}`);
    const state = {
      schema_version: 1, input_sha256: inputSha, report_path: relativeReport,
      evolved_at: nowIso(), attempted_at: nowIso(), reason, pending: false, error: '',
      added_rule_ids: output.added_rule_ids || [], removed_rule_ids: output.removed_rule_ids || [], analyzer_stages: output.stages || {},
      command,
      args: args.map((value) => value === root ? '.' : (value === paths.closedMarkdown ? relative(root, value) : value)),
    };
    writeJsonAtomic(paths.evolution, state);
    return { gated: true, skipped: false, reason, state, output };
  } catch (cause) {
    persistPending(root, previous, inputSha, reason, cause.message);
    throw cause;
  }
}

export function assertReportCompletionGate({ root, phaseId, spawn = spawnSync } = {}) {
  if (String(phaseId || '') !== 'report') return { gated: false, skipped: true, reason: 'phase-not-gated' };
  const bugs = loadBugLedger(root);
  const open = bugs.filter((bug) => bug.in_scope && !['已归档', '延后'].includes(bug.verification_status));
  if (open.length) throw gateError(`report 门禁发现未归档 Bug：${open.map((bug) => bug.id).join(', ')}`, 'EOPEN_BUGS');
  const archived = new Set(loadRetrospective(root).map((record) => record.operational_bug_id));
  const missing = bugs.filter((bug) => ['已归档', '延后'].includes(bug.verification_status) && !archived.has(bug.id));
  if (missing.length) throw gateError(`Bug 状态与复盘不一致：${missing.map((bug) => bug.id).join(', ')}`, 'ERETRO_MISMATCH');
  const evolution = runBugfixEvolution({ root, reason: 'report-completion-gate', spawn });
  const html = join(root, '.agent', 'reports', 'index.html');
  if (!readableNonemptyFile(html)) throw gateError(`Bug HTML 报告不可回读：${html}`, 'EMISSING_REPORT');
  return evolution;
}
