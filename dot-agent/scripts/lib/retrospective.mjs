// 已验证 Bug -> 项目复盘事实。只读真实阶段产物后归档。

import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { atomicWriteFile, nowIso, redact } from './store.mjs';
import { loadBugLedger, mutateBugLedger } from './bugcapture.mjs';

const LOCK_STALE_MS = 60_000;

export function retrospectivePaths(root) {
  const docs = join(root, 'docs', 'retrospective');
  return {
    docs,
    ledger: join(docs, 'feedback.jsonl'),
    markdown: join(docs, '项目复盘待办.md'),
    closedMarkdown: join(docs, '已归档反馈.md'),
    manualNotes: join(docs, 'manual-notes.md'),
    evolution: join(docs, 'evolution.json'),
    lock: join(root, '.agent', 'retrospective', 'feedback.lock'),
  };
}

function retroError(message, code = 'ERETROSPECTIVE') {
  return Object.assign(new Error(message), { code });
}

function safeText(value, max = 4000) {
  return String(redact(String(value || '')))
    .replace(/(?<!\d)(1[3-9]\d)(\d{4})(\d{4})(?!\d)/g, '$1****$3')
    .trim()
    .slice(0, max);
}

function staleToken(file) {
  try {
    if (Date.now() - statSync(file).mtimeMs <= LOCK_STALE_MS) return '';
    const payload = JSON.parse(readFileSync(file, 'utf8'));
    if (!Number.isInteger(payload.pid)) return payload.token || '(legacy)';
    try { process.kill(payload.pid, 0); return ''; }
    catch (cause) { return cause.code === 'ESRCH' ? (payload.token || '(dead)') : ''; }
  } catch { return '(unreadable)'; }
}

function withRetroLock(root, operation) {
  const file = retrospectivePaths(root).lock;
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
    const old = staleToken(file);
    if (!old) throw retroError(`复盘账本正被另一进程锁定：${file}`, 'ELOCKED');
    let current = '';
    try { current = JSON.parse(readFileSync(file, 'utf8')).token || '(legacy)'; } catch { current = '(unreadable)'; }
    if (current !== old) throw retroError(`复盘锁持有者已变化：${file}`, 'ELOCKED');
    unlinkSync(file);
    create();
  }
  try { return operation(); }
  finally {
    try {
      const current = JSON.parse(readFileSync(file, 'utf8'));
      if (current.token === token) unlinkSync(file);
    } catch {}
  }
}

function validateRecord(record) {
  if (!/^(?:BUG|B|U|E)-?\d+$/i.test(record.id || '')) throw retroError(`复盘 ID 非法：${record.id}`, 'EINVALID_RETRO');
  if (!record.title || !record.resolution) throw retroError(`复盘记录字段不完整：${record.id}`, 'EINVALID_RETRO');
  if (!['已归档', '延后'].includes(record.status)) throw retroError(`复盘状态非法：${record.status}`, 'EINVALID_RETRO');
  if (record.status === '已归档' && !record.root_cause) throw retroError(`已归档记录缺少根因：${record.id}`, 'EINVALID_RETRO');
}

export function loadRetrospective(root) {
  const file = retrospectivePaths(root).ledger;
  if (!existsSync(file)) return [];
  const records = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); } catch { throw retroError(`复盘 JSONL 第 ${index + 1} 行非法`, 'EINVALID_RETRO'); }
  });
  const ids = new Set();
  for (const record of records) {
    validateRecord(record);
    if (ids.has(record.id)) throw retroError(`复盘存在重复 ID：${record.id}`, 'EINVALID_RETRO');
    ids.add(record.id);
  }
  return records;
}

function escapeCell(value) {
  return String(value || '').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}

function render(records, title, manualNotes = '') {
  const sorted = [...records].sort((a, b) => a.id.localeCompare(b.id));
  const last = sorted.map((record) => record.closed_at).filter(Boolean).sort().at(-1) || '（暂无记录）';
  return [
    `# ${title}`,
    '',
    '> 本文由 Bugfix Harness 自动生成；结构化真源为 `feedback.jsonl`。',
    `> 最后更新：${last}`,
    '',
    '| 编号 | 用户反馈 / 现象 | 根因 | 本轮处置 | 影响 | 状态 |',
    '|---|---|---|---|---|---|',
    ...(sorted.length ? sorted.map((record) => `| ${record.id} | ${escapeCell(record.title)} | ${escapeCell(record.root_cause)} | ${escapeCell(record.resolution)} | ${escapeCell(record.impact)} | ${record.status} |`) : ['| - | 暂无 |  |  |  |  |']),
    '',
    ...(manualNotes ? ['<!-- RETROSPECTIVE:MANUAL-START -->', manualNotes, '<!-- RETROSPECTIVE:MANUAL-END -->', ''] : []),
  ].join('\n');
}

function ensureLegacyImported(root) {
  const paths = retrospectivePaths(root);
  if (existsSync(paths.markdown) && !existsSync(paths.ledger)) {
    throw retroError(`已有复盘文档尚未导入；先运行 bug retrospective-import --file ${paths.markdown}`, 'EIMPORT_REQUIRED');
  }
}

function persist(root, records, { allowLegacyOverwrite = false } = {}) {
  const paths = retrospectivePaths(root);
  if (!allowLegacyOverwrite) ensureLegacyImported(root);
  mkdirSync(paths.docs, { recursive: true });
  for (const record of records) validateRecord(record);
  const manualNotes = existsSync(paths.manualNotes) ? readFileSync(paths.manualNotes, 'utf8').trim() : '';
  atomicWriteFile(paths.ledger, records.length ? `${records.map((record) => JSON.stringify(record)).join('\n')}\n` : '');
  atomicWriteFile(paths.markdown, render(records, '项目复盘待办', manualNotes));
  atomicWriteFile(paths.closedMarkdown, render(records.filter((record) => record.status === '已归档'), '已归档反馈'));
}

export function refreshRetrospective(root) {
  return withRetroLock(root, () => {
    const records = loadRetrospective(root);
    if (!records.length) return { records, closedMarkdown: '' };
    persist(root, records);
    return { records, closedMarkdown: retrospectivePaths(root).closedMarkdown };
  });
}

function readableFile(file, label, notBefore = '') {
  try {
    const stat = statSync(file);
    if (!stat.isFile() || stat.size <= 0) throw new Error('empty');
    if (notBefore && stat.mtimeMs < new Date(notBefore).getTime()) throw new Error('stale');
    return safeText(readFileSync(file, 'utf8'), 6000);
  } catch { throw retroError(`bug close 缺少本轮可回读 ${label}：${file}`, 'EMISSING_BUG_EVIDENCE'); }
}

function readArtifacts(root, id, notBefore = '') {
  const dir = join(root, '.agent', 'bugs', id);
  const rootCause = readableFile(join(dir, 'root-cause.md'), 'root-cause.md', notBefore);
  const impact = readableFile(join(dir, 'impact.md'), 'impact.md', notBefore);
  const change = readableFile(join(dir, 'change.md'), 'change.md', notBefore);
  const impactCheck = readableFile(join(dir, 'impact-check.md'), 'impact-check.md', notBefore);
  const evidenceDir = join(dir, 'evidence');
  let evidence = [];
  try {
    evidence = readdirSync(evidenceDir)
      .map((name) => ({ name, file: join(evidenceDir, name) }))
      .filter(({ file }) => { try { const stat = statSync(file); return stat.isFile() && stat.size > 0 && (!notBefore || stat.mtimeMs >= new Date(notBefore).getTime()); } catch { return false; } })
      .map(({ name }) => `.agent/bugs/${id}/evidence/${name}`);
  } catch {}
  if (!evidence.length) throw retroError(`bug close 缺少可回读 evidence：${evidenceDir}`, 'EMISSING_BUG_EVIDENCE');
  return { rootCause, impact, change, impactCheck, evidence };
}

function archiveRecord(root, bug, artifacts, status, disposition) {
  ensureLegacyImported(root);
  return withRetroLock(root, () => {
    const records = loadRetrospective(root);
    const at = nowIso();
    const record = {
      id: bug.id,
      operational_bug_id: bug.id,
      source: bug.source,
      title: safeText(bug.title, 280),
      symptom: safeText(bug.actual || bug.title, 4000),
      root_cause: artifacts?.rootCause || '',
      resolution: artifacts?.change || safeText(disposition, 4000),
      impact: artifacts ? `${artifacts.impact}\n\n${artifacts.impactCheck}`.slice(0, 8000) : '',
      evidence_refs: artifacts?.evidence || [],
      status,
      fingerprint: bug.fingerprint,
      closed_at: at,
    };
    validateRecord(record);
    const index = records.findIndex((item) => item.id === bug.id);
    if (index >= 0) records[index] = record; else records.push(record);
    persist(root, records);
    return record;
  });
}

function splitRow(line) {
  return String(line).trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim().replace(/\\\|/g, '|'));
}

function parseLegacy(markdown) {
  const lines = markdown.split('\n');
  const records = [];
  let lastFeedbackLine = -1;
  for (let index = 0; index < lines.length - 1; index += 1) {
    if (!lines[index].trim().startsWith('|') || !/^\s*\|?(?:\s*:?-+:?\s*\|)+/.test(lines[index + 1])) continue;
    const headers = splitRow(lines[index]);
    const titleIndex = headers.findIndex((header) => /用户反馈|现象|问题|title|bug/i.test(header));
    const causeIndex = headers.findIndex((header) => /根因|定位结果|cause/i.test(header));
    const resolutionIndex = headers.findIndex((header) => /本轮处置|修复|解决|corrective/i.test(header));
    const impactIndex = headers.findIndex((header) => /影响|impact/i.test(header));
    const statusIndex = headers.findIndex((header) => /状态|status/i.test(header));
    let cursor = index + 2;
    while (cursor < lines.length && lines[cursor].trim().startsWith('|')) {
      const cells = splitRow(lines[cursor]);
      const id = cells[0] || '';
      const rawStatus = cells[statusIndex] || '';
      const status = /延后/.test(rawStatus) ? '延后' : (/(已归档|复盘已关闭|已验证|已完成)/.test(rawStatus) ? '已归档' : '');
      if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(id) && !id.includes('..')) lastFeedbackLine = cursor;
      if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(id) && !id.includes('..') && status) {
        const rootCause = status === '已归档' ? safeText(cells[causeIndex] || '', 6000) : '';
        const resolution = safeText(cells[resolutionIndex] || cells[impactIndex] || '', 6000);
        if ((status === '已归档' && (!rootCause || !resolution)) || (status === '延后' && !resolution)) {
          cursor += 1;
          continue;
        }
        const record = {
          id,
          operational_bug_id: id,
          source: 'import',
          title: safeText(cells[titleIndex >= 0 ? titleIndex : 1], 280),
          symptom: safeText(cells[titleIndex >= 0 ? titleIndex : 1], 4000),
          root_cause: rootCause,
          resolution,
          impact: status === '已归档' ? safeText(cells[impactIndex] || '', 6000) : '',
          evidence_refs: [], status, fingerprint: '', closed_at: nowIso(),
        };
        record.fingerprint = createHash('sha256').update(`${record.id}\n${record.title}\n${record.root_cause}`).digest('hex');
        validateRecord(record);
        records.push(record);
      }
      cursor += 1;
    }
    index = cursor - 1;
  }
  const manualNotes = lastFeedbackLine >= 0 ? lines.slice(lastFeedbackLine + 1).join('\n').trim() : markdown.trim();
  return { records, manualNotes };
}

function backupPath(file) {
  const extension = extname(file);
  const stem = basename(file, extension);
  let candidate = join(dirname(file), `${stem}.legacy${extension}`);
  let number = 2;
  while (existsSync(candidate)) { candidate = join(dirname(file), `${stem}.legacy-${number}${extension}`); number += 1; }
  return candidate;
}

export function importRetrospectiveMarkdown({ root, file }) {
  return withRetroLock(root, () => {
    const paths = retrospectivePaths(root);
    const source = String(file || paths.markdown);
    if (!existsSync(source)) throw retroError(`复盘文档不存在：${source}`, 'EINPUT');
    if (existsSync(paths.ledger)) throw retroError('复盘 JSONL 已存在，拒绝重复导入', 'EEXISTS');
    if (existsSync(paths.markdown) && resolve(source) !== resolve(paths.markdown)) throw retroError(`主复盘已存在，必须先导入：${paths.markdown}`, 'EIMPORT_REQUIRED');
    const original = readFileSync(source, 'utf8');
    const { records, manualNotes } = parseLegacy(original);
    const legacy = backupPath(source);
    atomicWriteFile(legacy, original);
    mkdirSync(paths.docs, { recursive: true });
    if (manualNotes) atomicWriteFile(paths.manualNotes, `${manualNotes}\n`);
    persist(root, records, { allowLegacyOverwrite: true });
    return { imported: records.length, backupPath: legacy };
  });
}

export function assertRetrospectiveImported(root) {
  ensureLegacyImported(root);
}

export function closeOperationalBug({ root, id, status = '已归档', resolution = '' }) {
  if (!['已归档', '延后'].includes(status)) throw retroError('bug close 的 status 只允许 已归档 或 延后', 'EINPUT');
  const bug = loadBugLedger(root).find((item) => item.id === id);
  if (!bug) throw retroError(`Bug 不存在：${id}`, 'ENOBUG');
  let artifacts = null;
  if (status === '已归档') artifacts = readArtifacts(root, id, bug.reopened_at || '');
  else if (!safeText(resolution)) throw retroError('延后 Bug 必须提供 --resolution 说明', 'EINPUT');
  const record = archiveRecord(root, bug, artifacts, status, resolution);
  const updated = mutateBugLedger(root, (bugs) => {
    const target = bugs.find((item) => item.id === id);
    target.verification_status = status;
    target.status = status;
    target.in_scope = false;
    target.closed_at = record.closed_at;
    target.evidence_refs = [...new Set([...(target.evidence_refs || []), ...(record.evidence_refs || [])])];
    target.updated_at = nowIso();
    return target;
  });
  return { bug: updated, record, artifacts };
}
