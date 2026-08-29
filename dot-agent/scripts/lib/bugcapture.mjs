// Bugfix 工作队列：自动捕获、旧格式归一化、去重与复发重开。

import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { agentRoot, atomicWriteFile, nowIso, redact } from './store.mjs';

const SIGNALS = ['问题', 'bug', '报错', '异常', '失败', '不对', '不应该', '打不开', '不能', '缺失', '遗漏', '不好用', '需要修复'];
const EXPLICIT = ['记入 bug', '记入复盘'];
const NEGATED = /(?:没有|没|无)(?:任何)?\s*(?:问题|异常|报错|bug)|不是(?:一个)?\s*(?:问题|bug)|不算\s*(?:问题|bug)/i;
const HYPOTHETICAL = /(?:如果|假如|假设|以后|将来)|(?:如何|怎么)(?:管理|记录|处理)(?:问题|bug)/i;
const GENERIC = /(?:介绍|说明|讲讲|什么是).{0,8}(?:bug|问题)|(?:bug|问题)(?:管理|流程|规范)/i;
const QUOTED = /(?:文档|需求|规则|示例|原文|说明).{0,16}(?:写着|写了|提到|包含|例如|举例).{0,32}(?:问题|bug|报错|异常|失败|不对|打不开|不能|缺失)/i;
const TERMINAL = new Set(['已归档', '延后']);
const VERIFICATION = new Set(['待验证', '部分验证', '已验证待归档', '已归档', '延后']);
const LOCK_STALE_MS = 60_000;

export function bugProjectRoot() {
  return dirname(agentRoot());
}

export function bugPaths(root = bugProjectRoot()) {
  const agent = join(root, '.agent');
  return { agent, ledger: join(agent, 'bugs.json'), lock: join(agent, 'bugs.lock') };
}

function bugError(message, code = 'EBUG') {
  return Object.assign(new Error(message), { code });
}

function safeText(value, max = 4000) {
  return String(redact(String(value || '')))
    .replace(/(?<!\d)(1[3-9]\d)(\d{4})(\d{4})(?!\d)/g, '$1****$3')
    .trim()
    .slice(0, max);
}

function safeValue(value) {
  if (value == null) return value;
  if (typeof value === 'string') return safeText(value, 4000);
  if (Array.isArray(value)) return value.map(safeValue);
  if (typeof value === 'object') return Object.fromEntries(Object.entries(redact(value)).map(([key, item]) => [key, safeValue(item)]));
  return value;
}

function normalized(value) {
  return String(value || '').toLowerCase().replace(/[`*_#>|]/g, ' ').replace(/\s+/g, ' ').trim();
}

function bugFingerprint(title, actual) {
  return createHash('sha256').update(`${normalized(title)}\n${normalized(actual)}`).digest('hex');
}

export function classifyBugSignal(text) {
  const value = String(text || '').trim();
  const lowered = value.toLowerCase();
  const explicit = EXPLICIT.filter((keyword) => lowered.includes(keyword));
  const keywords = SIGNALS.filter((keyword) => lowered.includes(keyword));
  if (explicit.length) return { capture: true, explicit: true, keywords: explicit, reason: 'explicit-keyword' };
  if (!keywords.length) return { capture: false, explicit: false, keywords: [], reason: 'no-signal' };
  if (NEGATED.test(value)) return { capture: false, explicit: false, keywords, reason: 'negated' };
  if (QUOTED.test(value)) return { capture: false, explicit: false, keywords, reason: 'quoted-discussion' };
  const firstSignal = Math.min(...keywords.map((keyword) => lowered.indexOf(keyword)).filter((index) => index >= 0));
  const hypothetical = value.search(HYPOTHETICAL);
  if (hypothetical >= 0 && hypothetical <= firstSignal) return { capture: false, explicit: false, keywords, reason: 'hypothetical' };
  if (GENERIC.test(value)) return { capture: false, explicit: false, keywords, reason: 'generic-discussion' };
  return { capture: true, explicit: false, keywords, reason: 'concrete-signal' };
}

function normalizeBug(input) {
  const bug = { ...safeValue(input) };
  bug.id = String(bug.id || '');
  bug.title = safeText(bug.title, 280);
  bug.actual = safeText(bug.actual || bug.title, 4000);
  bug.repro = safeText(bug.repro, 4000);
  bug.expected = safeText(bug.expected, 4000);
  if (!['user', 'engineering', 'import'].includes(bug.source)) {
    if (bug.source) bug.original_source = safeText(bug.source, 280);
    bug.source = 'import';
  }
  bug.source = bug.source || 'import';
  bug.status = safeText(bug.status || '待修复', 120);
  bug.source_status = safeText(bug.source_status || bug.status || '待修复', 120);
  bug.verification_status = bug.verification_status || (TERMINAL.has(bug.status) ? bug.status : '待验证');
  bug.in_scope = bug.in_scope !== undefined ? Boolean(bug.in_scope) : !TERMINAL.has(bug.verification_status);
  bug.fingerprint = /^[a-f0-9]{64}$/i.test(bug.fingerprint || '') ? bug.fingerprint : bugFingerprint(bug.title, bug.actual);
  bug.source_key = bug.source_key || `${bug.source}:${bug.fingerprint}`;
  bug.evidence_refs = [...new Set([].concat(bug.evidence_refs || []).map((value) => safeText(value, 500)).filter(Boolean))];
  bug.phase_id = String(bug.phase_id || '');
  bug.task_id = String(bug.task_id || '');
  bug.reporter = safeText(bug.reporter, 280);
  bug.severity = safeText(bug.severity, 120);
  bug.module = safeText(bug.module, 280);
  bug.page = safeText(bug.page, 280);
  bug.platform = safeText(bug.platform, 280);
  bug.raw = safeValue(bug.raw || {});
  validateBug(bug);
  return bug;
}

function validateBug(bug) {
  if (!bug.id || !bug.title) throw bugError('Bug 必须包含 id 和 title', 'EINVALID_BUG');
  assertSafeBugId(bug.id);
  if (!['user', 'engineering', 'import'].includes(bug.source)) throw bugError(`Bug source 非法：${bug.source}`, 'EINVALID_BUG');
  if (!VERIFICATION.has(bug.verification_status)) throw bugError(`Bug verification_status 非法：${bug.verification_status}`, 'EINVALID_BUG');
  if (!/^[a-f0-9]{64}$/i.test(bug.fingerprint)) throw bugError(`Bug fingerprint 非法：${bug.id}`, 'EINVALID_BUG');
}

export function assertSafeBugId(id) {
  const value = String(id || '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value) || value.includes('..')) throw bugError(`Bug ID 非法：${value || '(空)'}`, 'EINVALID_BUG');
  return value;
}

function staleToken(lockPath) {
  try {
    if (Date.now() - statSync(lockPath).mtimeMs <= LOCK_STALE_MS) return '';
    const payload = JSON.parse(readFileSync(lockPath, 'utf8'));
    if (!Number.isInteger(payload.pid)) return payload.token || '(legacy)';
    try { process.kill(payload.pid, 0); return ''; }
    catch (cause) { return cause.code === 'ESRCH' ? (payload.token || '(dead)') : ''; }
  } catch { return '(unreadable)'; }
}

function acquireBugLock(root) {
  const file = bugPaths(root).lock;
  mkdirSync(dirname(file), { recursive: true });
  const token = randomUUID();
  const create = () => {
    const fd = openSync(file, 'wx', 0o600);
    writeFileSync(fd, JSON.stringify({ pid: process.pid, token, at: nowIso() }));
    closeSync(fd);
  };
  try { create(); }
  catch (cause) {
    if (cause.code !== 'EEXIST') throw cause;
    const oldToken = staleToken(file);
    if (!oldToken) throw bugError(`Bug 台账正被另一进程锁定：${file}`, 'ELOCKED');
    let current = '';
    try { current = JSON.parse(readFileSync(file, 'utf8')).token || '(legacy)'; } catch { current = '(unreadable)'; }
    if (current !== oldToken) throw bugError(`Bug 锁持有者已变化：${file}`, 'ELOCKED');
    unlinkSync(file);
    create();
  }
  return () => {
    try {
      const current = JSON.parse(readFileSync(file, 'utf8'));
      if (current.token === token) unlinkSync(file);
    } catch {}
  };
}

function withBugLock(root, operation) {
  const release = acquireBugLock(root);
  try { return operation(); } finally { release(); }
}

export function mutateBugLedger(root, operation) {
  return withBugLock(root, () => {
    const bugs = loadBugLedger(root);
    const result = operation(bugs);
    persistBugLedger(root, bugs);
    return result;
  });
}

export function loadBugLedger(root = bugProjectRoot()) {
  const file = bugPaths(root).ledger;
  if (!existsSync(file)) return [];
  let parsed;
  try { parsed = JSON.parse(readFileSync(file, 'utf8')); }
  catch { throw bugError(`Bug 台账不是合法 JSON：${file}`, 'EINVALID_BUG'); }
  const records = Array.isArray(parsed) ? parsed : (parsed.bugs || []);
  const bugs = records.map(normalizeBug);
  const ids = new Set();
  for (const bug of bugs) {
    if (ids.has(bug.id)) throw bugError(`Bug 台账存在重复 ID：${bug.id}`, 'EINVALID_BUG');
    ids.add(bug.id);
  }
  return bugs;
}

function persistBugLedger(root, bugs) {
  const normalizedBugs = bugs.map(normalizeBug);
  const file = bugPaths(root).ledger;
  let output = normalizedBugs;
  if (existsSync(file)) {
    try {
      const current = JSON.parse(readFileSync(file, 'utf8'));
      if (!Array.isArray(current) && current && typeof current === 'object') output = { ...current, bugs: normalizedBugs };
    } catch { /* loadBugLedger already reports malformed state before mutation */ }
  }
  atomicWriteFile(file, `${JSON.stringify(output, null, 2)}\n`);
}

export function saveBugLedger(root, bugs) {
  return withBugLock(root, () => persistBugLedger(root, bugs));
}

export function mergeImportedBugs(root, incoming) {
  return withBugLock(root, () => {
    const existing = loadBugLedger(root);
    for (const raw of incoming) {
      const candidate = normalizeBug({ ...raw, source: raw.source || 'import' });
      const matched = existing.find((bug) =>
        (candidate.source_key && bug.source_key === candidate.source_key)
        || bug.fingerprint === candidate.fingerprint);
      if (matched) {
        const previousStatus = matched.status;
        const preserved = {
          id: matched.id,
          verification_status: matched.verification_status,
          in_scope: matched.in_scope,
          evidence_refs: matched.evidence_refs,
          previous_closures: matched.previous_closures,
          reopened_count: matched.reopened_count,
          closed_at: matched.closed_at,
        };
        const upstreamReopened = TERMINAL.has(matched.verification_status)
          && !/(已归档|已验收|已完成|已关闭|延后)/.test(candidate.source_status || candidate.status || '');
        Object.assign(matched, candidate, preserved, {
          source_status: candidate.status || candidate.source_status,
          updated_at: nowIso(),
        });
        if (upstreamReopened) {
          matched.previous_closures = [...(matched.previous_closures || []), {
            verification_status: preserved.verification_status,
            status: previousStatus,
            closed_at: preserved.closed_at || nowIso(),
          }].slice(-10);
          matched.verification_status = '待验证';
          matched.in_scope = true;
          matched.status = candidate.status || '待修复';
          matched.reopened_count = Number(matched.reopened_count || 0) + 1;
          matched.reopened_at = nowIso();
        }
        continue;
      }
      if (!candidate.id || existing.some((bug) => bug.id === candidate.id)) candidate.id = nextBugId(existing);
      existing.push(candidate);
    }
    persistBugLedger(root, existing);
    return existing;
  });
}

function nextBugId(bugs) {
  const max = bugs.reduce((value, bug) => Math.max(value, Number(String(bug.id).replace(/\D/g, '')) || 0), 0);
  return `BUG-${String(max + 1).padStart(3, '0')}`;
}

export function addOperationalBug({
  root = bugProjectRoot(), source, title, actual = '', repro = '', expected = '', evidence = [], phaseId = '', taskId = '',
}) {
  return withBugLock(root, () => {
    const bugs = loadBugLedger(root);
    const safeTitle = safeText(title, 280);
    const safeActual = safeText(actual || title, 4000);
    const fingerprint = bugFingerprint(safeTitle, safeActual);
    const duplicate = bugs.find((bug) => bug.fingerprint === fingerprint);
    if (duplicate && TERMINAL.has(duplicate.verification_status)) {
      duplicate.previous_closures = [...(duplicate.previous_closures || []), {
        verification_status: duplicate.verification_status,
        status: duplicate.status,
        closed_at: duplicate.closed_at || duplicate.updated_at || nowIso(),
      }].slice(-10);
      duplicate.verification_status = '待验证';
      duplicate.status = '待修复';
      duplicate.in_scope = true;
      duplicate.reopened_count = Number(duplicate.reopened_count || 0) + 1;
      duplicate.reopened_at = nowIso();
      duplicate.source = source;
      duplicate.actual = safeActual;
      duplicate.phase_id = String(phaseId || '');
      duplicate.task_id = String(taskId || '');
      duplicate.evidence_refs = [...new Set([...(duplicate.evidence_refs || []), ...[].concat(evidence || []).map((value) => safeText(value, 500)).filter(Boolean)])];
      duplicate.updated_at = duplicate.reopened_at;
      persistBugLedger(root, bugs);
      return { bug: duplicate, duplicate: true, reopened: true };
    }
    if (duplicate) return { bug: duplicate, duplicate: true, reopened: false };
    const at = nowIso();
    const bug = normalizeBug({
      id: nextBugId(bugs), title: safeTitle, actual: safeActual,
      repro: safeText(repro, 4000), expected: safeText(expected, 4000),
      severity: '', module: '', page: '', platform: '', status: '待修复', reporter: '', raw: {},
      source, source_key: `auto:${fingerprint}`, source_status: '待修复', verification_status: '待验证',
      in_scope: true, fingerprint, phase_id: phaseId, task_id: taskId,
      evidence_refs: evidence, created_at: at, updated_at: at,
    });
    bugs.push(bug);
    persistBugLedger(root, bugs);
    return { bug, duplicate: false, reopened: false };
  });
}

export function updateOperationalBug({ root = bugProjectRoot(), id, verificationStatus, evidence }) {
  return mutateBugLedger(root, (bugs) => {
    const bug = bugs.find((item) => item.id === id);
    if (!bug) throw bugError(`Bug 不存在：${id}`, 'ENOBUG');
    if (verificationStatus !== undefined) {
      if (TERMINAL.has(String(verificationStatus))) throw bugError('终态只能通过 bug close 设置', 'EINPUT');
      if (!VERIFICATION.has(String(verificationStatus))) throw bugError(`verification_status 非法：${verificationStatus}`, 'EINPUT');
      bug.verification_status = String(verificationStatus);
    }
    if (evidence !== undefined) bug.evidence_refs = [...new Set([...(bug.evidence_refs || []), ...[].concat(evidence || []).map((value) => safeText(value, 500)).filter(Boolean)])];
    bug.updated_at = nowIso();
    return bug;
  });
}

export function bugVerificationStatuses() {
  return [...VERIFICATION];
}
