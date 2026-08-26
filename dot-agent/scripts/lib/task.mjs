// 任务快照模型：加载/校验/有界/乐观版本锁/原子保存。

import { existsSync } from 'node:fs';
import {
  paths, readJson, writeJsonAtomic, byteSize, nowIso, acquireLock, ensureDirs,
} from './store.mjs';
import { validate } from './schema.mjs';

export const SCHEMA_VERSION = 1;
export const MAX_TASK_BYTES = 16 * 1024; // 16KB 硬上限
export const MAX_RECENT = 10;

export function taskExists(id) {
  return existsSync(paths.task(id));
}

export function loadTask(id) {
  if (!taskExists(id)) {
    const e = new Error(`任务不存在：${id}`);
    e.code = 'ENOTASK';
    throw e;
  }
  return readJson(paths.task(id));
}

// 校验快照：schema + 16KB 上限。抛错即拒写（不静默截断）。
export function assertValidTask(task) {
  const { valid, errors } = validate('task.schema.json', task);
  if (!valid) {
    const e = new Error('TASK 不符合 schema（拒绝写入）:\n  - ' + errors.join('\n  - '));
    e.code = 'ESCHEMA';
    throw e;
  }
  const size = byteSize(JSON.stringify(task));
  if (size > MAX_TASK_BYTES) {
    const e = new Error(`TASK 快照 ${size} 字节 > 上限 ${MAX_TASK_BYTES} 字节（拒绝写入；请把历史/大内容移入 journal/checkpoint/evidence）`);
    e.code = 'ETOOBIG';
    throw e;
  }
  if ((task.recent_completed || []).length > MAX_RECENT) {
    const e = new Error(`recent_completed ${task.recent_completed.length} 项 > 上限 ${MAX_RECENT}（拒绝写入；旧项归档到 journal/checkpoint）`);
    e.code = 'ETOOMANY';
    throw e;
  }
}

// 直接写并做乐观版本检查：expectedVersion 必须等于磁盘现值，否则冲突拒写。
export function writeTaskChecked(task, { expectedVersion } = {}) {
  ensureDirs();
  const release = acquireLock(task.task_id);
  try {
    if (expectedVersion !== undefined && taskExists(task.task_id)) {
      const disk = loadTask(task.task_id);
      if (disk.version !== expectedVersion) {
        const e = new Error(`版本冲突：磁盘 version=${disk.version}，期望 ${expectedVersion}。请重新读取后再改（本次不覆盖）。`);
        e.code = 'ECONFLICT';
        throw e;
      }
    }
    assertValidTask(task);
    writeJsonAtomic(paths.task(task.task_id), task);
    return task;
  } finally {
    release();
  }
}

// 安全更新：锁内读最新 → mutator 改副本 → 自增 version → 校验 → 原子写。
export function updateTask(id, mutator) {
  ensureDirs();
  const release = acquireLock(id);
  try {
    const cur = loadTask(id);
    const next = structuredClone(cur);
    mutator(next);
    next.version = cur.version + 1;
    next.updated_at = nowIso();
    assertValidTask(next);
    writeJsonAtomic(paths.task(id), next);
    return next;
  } finally {
    release();
  }
}

export function newTask({ taskId, objective, phase = '规划', nextAction = '定义首个步骤', dod = [], constraints = [], references = [] }) {
  const ts = nowIso();
  return {
    schema_version: SCHEMA_VERSION,
    task_id: taskId,
    objective,
    status: 'planned',
    phase,
    current_focus: '',
    next_action: nextAction,
    blockers: [],
    critical_constraints: constraints,
    recent_completed: [],
    definition_of_done: dod.map((t) => (typeof t === 'string' ? { text: t, met: false, evidence: [] } : t)),
    references,
    open_step: null,
    version: 1,
    created_at: ts,
    updated_at: ts,
  };
}

// ACTIVE_TASK 指针
export function loadActive() {
  const p = paths.active();
  if (!existsSync(p)) return { active_task_id: null, updated_at: nowIso() };
  return readJson(p);
}

export function setActive(id) {
  ensureDirs();
  const obj = { active_task_id: id, updated_at: nowIso() };
  const { valid, errors } = validate('active-task.schema.json', obj);
  if (!valid) throw new Error('ACTIVE_TASK 非法:\n' + errors.join('\n'));
  writeJsonAtomic(paths.active(), obj);
  return obj;
}

export function requireActiveId() {
  const a = loadActive();
  if (!a.active_task_id) {
    const e = new Error('当前无活动任务。先 `init` 建任务或 `switch <id>` 切换。');
    e.code = 'ENOACTIVE';
    throw e;
  }
  return a.active_task_id;
}
