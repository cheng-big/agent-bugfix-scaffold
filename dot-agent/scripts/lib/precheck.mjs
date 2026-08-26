// pre-commit 兜底判定（纯函数，零依赖）。命令层收集事实喂进来，这里只判定。
// 软兜底哲学：只有「明确异常」（started 未 commit 的中断步骤）硬拦；
// 提交了业务代码却还没过 07 影响面复核（未对账）→ 默认醒目警告但放行，strict 时才升级硬拦。
// 设计意图：pre-commit 太严会逼人习惯性 --no-verify，门就形同虚设；温和提醒 + 关键项硬拦更可持续。
export function evaluatePrecommit({
  processOn = false,
  stagedBusiness = 0,
  interruptedCount = 0,
  reconcileExists = false,
  reconcileDone = false,
  strict = false,
} = {}) {
  const messages = [];
  let block = false;
  if (!processOn) return { block: false, messages }; // 非脚手架项目：完全不干预

  if (interruptedCount > 0) {
    block = true; // 软硬都拦：有活儿只 start 没 commit 就提交 = 状态与真实态不符
    messages.push({ level: 'error', text: `有 ${interruptedCount} 个 started 未 commit 的步骤未收尾——先 recover/commit-step 再提交` });
  }

  if (stagedBusiness > 0) {
    if (reconcileExists && !reconcileDone) {
      messages.push({
        level: strict ? 'error' : 'warn',
        text: `暂存了 ${stagedBusiness} 个业务文件，但「07 影响面复核」未完成——还没跑 impact-check 对账就提交，「改多了/波及别处」此刻发现不了${strict ? '（strict：已拦截）' : '（软兜底：仅提醒，未拦）'}`,
      });
      if (strict) block = true;
    } else if (reconcileExists && reconcileDone) {
      messages.push({ level: 'info', text: '✓ 已过 07 对账门（impact-check 已完成）' });
    }
  } else {
    messages.push({ level: 'info', text: '本次提交无业务代码改动（仅 .agent/ 流程产物），放行' });
  }

  return { block, messages };
}
