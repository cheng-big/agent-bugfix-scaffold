// 事件日志：只追加 JSONL、扫描、幂等判定、恢复扫描。

import { existsSync, readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { paths, nowIso, shortId, redact } from './store.mjs';
import { validate } from './schema.mjs';

// 追加一条事件（先脱敏 payload/references，再 schema 校验，最后原子追加）。
export function appendEvent(taskId, event, { stepId = null, attempt = 0, taskVersion = 0, idempotencyKey = '', references = [], payload = {} } = {}) {
  const file = paths.journal(taskId);
  mkdirSync(dirname(file), { recursive: true });
  const seq = readEvents(taskId).length + 1;
  const evt = {
    event_id: shortId('ev_'),
    seq,
    event,
    task_id: taskId,
    step_id: stepId,
    attempt,
    timestamp: nowIso(),
    task_version: taskVersion,
    idempotency_key: idempotencyKey || '',
    references: redact(references),
    payload: redact(payload),
  };
  const { valid, errors } = validate('journal-event.schema.json', evt);
  if (!valid) {
    const err = new Error('事件不符合 journal schema:\n' + errors.join('\n'));
    err.code = 'ESCHEMA';
    throw err;
  }
  appendFileSync(file, JSON.stringify(evt) + '\n');
  return evt;
}

export function readEvents(taskId) {
  const file = paths.journal(taskId);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

// 幂等：某 idempotency_key 是否已存在指定事件类型（默认 step_committed）。
export function hasCommittedIdem(taskId, idempotencyKey, event = 'step_committed') {
  if (!idempotencyKey) return false;
  return readEvents(taskId).some((e) => e.event === event && e.idempotency_key === idempotencyKey);
}

// 恢复扫描：找出 step_started 但无对应 step_committed/step_failed 的步骤。
export function findInterruptedSteps(taskId) {
  const events = readEvents(taskId);
  const started = new Map(); // step_id -> {attempt, at, intent, idem}
  for (const e of events) {
    if (e.event === 'step_started' && e.step_id) {
      started.set(e.step_id, { step_id: e.step_id, attempt: e.attempt, at: e.timestamp, intent: e.payload?.intent, idempotency_key: e.idempotency_key });
    } else if ((e.event === 'step_committed' || e.event === 'step_failed') && e.step_id) {
      started.delete(e.step_id);
    }
  }
  return [...started.values()];
}

export function lastEventSeq(taskId) {
  const events = readEvents(taskId);
  return events.length ? events[events.length - 1].seq : 0;
}
