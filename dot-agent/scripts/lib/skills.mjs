// best-effort skill 探测：判断某 skill 是否在当前环境可用。
// 诚实三态：installed（命中） / not_found（已知路径均未命中） / unknown（无从探测，如根目录都不存在）。
// 隔离环境耦合：只有这一处知道 skill 的磁盘布局；换 agent 平台改 skillRoots() 即可。

import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// 已知的 skill 根目录（面向 Claude Code 布局；可按需扩展）。
export function skillRoots(cwd = process.cwd()) {
  return [
    join(cwd, '.claude', 'skills'),
    join(homedir(), '.claude', 'skills'),
  ];
}

function isDir(p) {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

// 一个 skill 名可能是 "name" 或 "plugin:name"；后者退化再试冒号后半段。
function candidateNames(name) {
  const out = [name];
  if (name.includes(':')) out.push(name.slice(name.indexOf(':') + 1));
  return out;
}

// 在某个 skill 根目录里找该 skill：<root>/<name>/ 目录，或其中的 SKILL.md。
function hitInRoot(root, name) {
  for (const n of candidateNames(name)) {
    const dir = join(root, n);
    if (isDir(dir)) return true;
    if (existsSync(join(dir, 'SKILL.md'))) return true;
  }
  return false;
}

// 返回 'installed' | 'not_found' | 'unknown'
export function detectSkill(name, { cwd = process.cwd() } = {}) {
  if (!name) return 'unknown';
  const roots = skillRoots(cwd);
  const existingRoots = roots.filter(isDir);
  if (existingRoots.length === 0) return 'unknown'; // 无处可查，不谎称一定没装
  for (const root of existingRoots) if (hitInRoot(root, name)) return 'installed';
  return 'not_found';
}

// 徽章文案（人读）
export function skillBadge(state) {
  if (state === 'installed') return '✓已装';
  if (state === 'not_found') return '✗未装';
  return '?未知';
}
