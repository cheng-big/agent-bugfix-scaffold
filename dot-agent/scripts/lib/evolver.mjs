// 历史交付质量上下文桥：调用 Python harness_evolver，失败不破坏主 Harness 状态机。

import { existsSync, readFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { agentRoot } from './store.mjs';

const PROJECT_PLACEHOLDER = /<[^>\n]*(?:在此|项目名|角色|权限|需求|契约|例：)[^>\n]*>/;

export function projectRoot() {
  return dirname(agentRoot());
}

export function buildEvolutionContext({
  phaseId = '', action = '', worklistTask = '', targetPath = '', techStack = '', root = projectRoot(),
} = {}) {
  if (!phaseId || !existsSync(join(root, 'harness_evolver', 'context_injector.py'))) return '';
  const args = [
    '-m', 'harness_evolver.context_injector', '--phase', phaseId,
    '--action', action || 'context', '--max-rules', '8', '--max-examples', '3', '--max-chars', '12000',
  ];
  if (worklistTask) args.push('--worklist-task', worklistTask);
  if (targetPath) args.push('--target-path', targetPath);
  const projectMd = join(root, '.agent', 'PROJECT.md');
  const rawProjectContext = existsSync(projectMd) ? readFileSync(projectMd, 'utf8').slice(0, 4000) : '';
  const profileWarning = PROJECT_PLACEHOLDER.test(rawProjectContext)
    ? '⛔ HARNESS_CONFIG_ERROR：.agent/PROJECT.md 仍含模板占位符；先完成项目身份、权限边界、真源和 DoD 适配。\n\n'
    : '';
  const projectContext = profileWarning ? '' : rawProjectContext;
  const retrievalContext = [techStack, projectContext].filter(Boolean).join('\n');
  if (retrievalContext) args.push('--tech-stack', retrievalContext);
  const candidates = [process.env.HARNESS_EVOLVER_PYTHON, 'python3', 'python'].filter(Boolean);
  const env = { ...process.env, PYTHONPATH: [root, process.env.PYTHONPATH].filter(Boolean).join(delimiter) };
  let lastError = '';
  for (const python of candidates) {
    const result = spawnSync(python, args, { cwd: root, env, encoding: 'utf8', timeout: 15000 });
    if (result.status === 0 && result.stdout.trim()) return profileWarning + result.stdout.trim();
    if (result.error?.code === 'ENOENT') continue;
    lastError = (result.stderr || result.error?.message || `exit ${result.status}`).trim().slice(0, 300);
    break;
  }
  return `[历史交付质量反馈 · 注入告警]\n无法组装 Evolver 上下文：${lastError || '未找到可用 Python'}\n主 Harness 可继续运行，但本阶段未获得历史规则。`;
}
