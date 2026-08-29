// 存储层：路径解析、原子写、独占锁、脱敏、时间/ID 生成。零依赖。

import {
  readFileSync, writeFileSync, existsSync, mkdirSync, openSync, closeSync,
  fsyncSync, renameSync, unlinkSync, statSync, readdirSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

// 允许测试用环境变量覆盖根目录，避免污染真实运行时。
export function agentRoot() {
  return process.env.AGENT_HOME || join(process.cwd(), '.agent');
}

export const paths = {
  root: () => agentRoot(),
  active: () => join(agentRoot(), 'ACTIVE_TASK.json'),
  task: (id) => join(agentRoot(), 'tasks', `${id}.json`),
  lock: (id) => join(agentRoot(), 'tasks', `${id}.lock`),
  journal: (id) => join(agentRoot(), 'journal', `${id}.jsonl`),
  decisionsDir: (id) => join(agentRoot(), 'decisions', id),
  evidenceDir: (id) => join(agentRoot(), 'evidence', id),
  checkpointsDir: (id) => join(agentRoot(), 'checkpoints', id),
};

export function ensureDirs() {
  for (const d of ['tasks', 'journal', 'decisions', 'evidence', 'checkpoints'])
    mkdirSync(join(agentRoot(), d), { recursive: true });
}

export function nowIso() {
  return new Date().toISOString();
}

export function shortId(prefix = '') {
  return prefix + randomUUID().replace(/-/g, '').slice(0, 12);
}

// 原子写：tmp → fsync → rename。写 tmp 失败/校验失败时旧文件保持不变。
export function atomicWriteFile(target, data) {
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.tmp.${process.pid}.${randomUUID().slice(0, 8)}`;
  const fd = openSync(tmp, 'w');
  try {
    writeFileSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, target);
}

export function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function writeJsonAtomic(file, obj) {
  atomicWriteFile(file, JSON.stringify(obj, null, 2) + '\n');
}

export function byteSize(str) {
  return Buffer.byteLength(str, 'utf8');
}

// 独占锁：wx 独占创建锁文件；stale（超时）则夺锁。返回 release()。
const LOCK_STALE_MS = 30_000;

export function acquireLock(id, { staleMs = LOCK_STALE_MS } = {}) {
  const lockPath = paths.lock(id);
  mkdirSync(dirname(lockPath), { recursive: true });
  const payload = JSON.stringify({ pid: process.pid, at: nowIso() });
  try {
    const fd = openSync(lockPath, 'wx');
    writeFileSync(fd, payload);
    closeSync(fd);
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    // 已存在：判断是否 stale
    let stale = false;
    try {
      const age = Date.now() - statSync(lockPath).mtimeMs;
      stale = age > staleMs;
    } catch {
      stale = true;
    }
    if (!stale) {
      const err = new Error(`任务 ${id} 正被另一进程锁定（${lockPath}）。请稍后重试或删除陈旧锁。`);
      err.code = 'ELOCKED';
      throw err;
    }
    // 夺陈旧锁
    try { unlinkSync(lockPath); } catch {}
    const fd = openSync(lockPath, 'wx');
    writeFileSync(fd, payload);
    closeSync(fd);
  }
  let released = false;
  return function release() {
    if (released) return;
    released = true;
    try { unlinkSync(lockPath); } catch {}
  };
}

// 脱敏：把常见密钥/令牌/密码字段值替换为 [REDACTED]，防止写进日志/证据。
const SENSITIVE_KEY = /(pass(word|wd)?|secret|token|api[_-]?key|access[_-]?key|authorization|bearer|private[_-]?key|credential)/i;
const SENSITIVE_VALUE = [
  /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi,
  /\beyJ[A-Za-z0-9._-]{10,}/g,               // JWT
  /\b(?:sk|pk|ghp|gho|xox[baprs])[-_][A-Za-z0-9]{8,}/g, // 常见令牌前缀
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\bAIza[A-Za-z0-9_-]{20,}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

export function redact(value) {
  if (value == null) return value;
  if (typeof value === 'string') {
    let out = value;
    for (const re of SENSITIVE_VALUE) out = out.replace(re, '[REDACTED]');
    return out;
  }
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEY.test(k) ? '[REDACTED]' : redact(v);
    }
    return out;
  }
  return value;
}

export function listTaskIds() {
  const dir = join(agentRoot(), 'tasks');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''));
}
