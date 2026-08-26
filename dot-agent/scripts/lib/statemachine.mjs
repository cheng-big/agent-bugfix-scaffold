// 任务状态机：转换表 + 守卫。转换规则写进代码（配套测试断言），非仅文档。

export const STATES = ['planned', 'in_progress', 'blocked', 'verifying', 'completed', 'cancelled'];

// 允许的转换（含自转换：同状态内更新字段允许）。
const TRANSITIONS = {
  planned: ['planned', 'in_progress', 'cancelled'],
  in_progress: ['in_progress', 'verifying', 'blocked', 'cancelled'],
  blocked: ['blocked', 'in_progress', 'cancelled'],
  verifying: ['verifying', 'in_progress', 'blocked', 'completed'],
  completed: ['completed'], // 终态，重开需显式 reopen（走 planned/in_progress，见 guard）
  cancelled: ['cancelled'], // 终态
};

export function canTransition(from, to) {
  if (!STATES.includes(from) || !STATES.includes(to)) return false;
  return (TRANSITIONS[from] || []).includes(to);
}

// 守卫：某些转换需满足业务不变量。返回 {ok, reason?}。
// ctx: { hasBlocker, hasVerificationEvidence, reopen }
export function guard(from, to, ctx = {}) {
  // 重开：仅在显式 reopen 时允许 completed → planned/in_progress，绕过终态限制。
  if (from === 'completed') {
    if (to === 'completed') return { ok: true };
    if (!ctx.reopen)
      return { ok: false, reason: 'completed 为终态；重开必须显式 reopen，禁止静默重开' };
    if (to === 'planned' || to === 'in_progress') return { ok: true };
    return { ok: false, reason: `重开只能回到 planned/in_progress，不能到 ${to}` };
  }

  if (!canTransition(from, to))
    return { ok: false, reason: `非法状态转换：${from} → ${to}` };

  if (to === 'blocked' && !ctx.hasBlocker)
    return { ok: false, reason: '进入 blocked 必须记录至少一个 blocker' };

  if (to === 'completed') {
    if (from !== 'verifying')
      return { ok: false, reason: '进入 completed 必须先经 verifying（禁止 in_progress 直达 completed）' };
    if (!ctx.hasVerificationEvidence)
      return { ok: false, reason: '进入 completed 必须有通过的验证证据（verification_finished + evidence 引用）' };
  }
  return { ok: true };
}
