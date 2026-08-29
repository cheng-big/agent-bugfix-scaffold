# .agent — 外部任务记忆与可恢复执行机制

> **移植到新项目**：整目录丢过去 → `node .agent/scripts/agent.mjs install` → 填 `.agent/PROJECT.md`。详见 [`PORTING.md`](./PORTING.md)。

让任何新的大模型会话开机即可靠回答：**我是谁 / 在做什么 / 到哪一步 / 有没有中断的步骤 / 下一步唯一动作 / 完成需要什么证据**。
最终事实来自**代码 / Git / 测试 / 真实外部系统状态**，不是聊天记录。

## 唯一启动命令（每个新会话/恢复时先跑）
```bash
node .agent/scripts/agent.mjs resume
```
它 = 恢复扫描（找中断步骤）+ 生成有界启动上下文。

## 目录职责（分离，不把历史塞进 TASK）
| 路径 | 职责 | 是否提交 |
|---|---|---|
| `scripts/` | 零依赖 Node CLI + lib + 测试 | ✅ 提交 |
| `schemas/` | JSON Schema + 示例模板 | ✅ 提交 |
| `README.md` | 本说明 | ✅ 提交 |
| `ACTIVE_TASK.json` | 仅指针 `{active_task_id}` | ❌ 忽略（运行时） |
| `tasks/<id>.json` | 当前任务快照（**≤16KB**，只当前态+下一步） | ❌ 忽略 |
| `journal/<id>.jsonl` | 只追加事件日志（全过程，不整体注入上下文） | ❌ 忽略 |
| `decisions/<id>/` | 关键决策（选择/原因/影响/是否仍有效） | ❌ 忽略 |
| `evidence/<id>/` | 证据（命令输出/commit/外部回读，快照只存引用） | ❌ 忽略 |
| `checkpoints/<id>/` | 阶段摘要（可由日志重生成，不替代原始事实） | ❌ 忽略 |

> 忽略规则见根 `.gitignore`；各运行时目录保留 `.gitkeep`。状态是每机器/每会话的运行时数据，提交会与他人冲突。

## 命令速查
```
init --objective ".." [--id ..] [--phase ..] [--next ..] [--dod ..]* [--constraint ..]* [--ref ..]* [--no-activate]
switch <id> | status | context | resume
start-step --intent ".." [--step ..] [--idem ..] [--focus ..] [--force]
verify [--fail] [--evidence ev:..]* [--note ..]      # in_progress→verifying + 记录验证结果
commit-step [--step ..] [--idem ..] [--summary ..] [--evidence ev:..]*   # 幂等：同 idem 已提交则跳过
fail-step [--step ..] --reason ".."
evidence add --kind .. --ref .. [--data ..]           # 脱敏后落盘，返回 ev:id
decision add --title .. --why .. [--scope ..]         # 返回 dec:id
dod set --index N [--met|--unmet] [--evidence ev:..]*
checkpoint [--auto]
recover [--reconcile <step> --evidence ev:..] [--fail <step> --reason ..]
block --blocker ".." | complete | validate
bug detect --text ".."
bug add --source user|engineering --title .. [--actual ..] [--evidence ..]*
bug update <id> [--verification-status ..] [--evidence ..]*
bug close <id> [--status 已归档|延后] [--resolution ..]
bug retrospective-import --file docs/retrospective/项目复盘待办.md
bug evolve [--force] | bug list
```
所有命令支持 `--json`（机读输出）。改状态的命令：校验输入 → 校验状态转换 → 原子写 → 写日志 → 失败非零退出。

## 记忆到底有没有生效/被调用？怎么看
- **一屏自检**：`node .agent/scripts/agent.mjs doctor` —— 显示：装配是否完好、状态文件是否合法、任务数、
  **journal 共多少事件 / 最后写入时间 / 最近几条调用**，并判定「✅ 记忆在被调用 / ⚠️ 已装但 journal 为空还没被调用」。
- **看板区块**：`board.html` 里有「记忆活动」区块（事件总数/最后写入/中断数 + 最近调用），是「记得住」机制的心跳。
- **原理**：记忆是被动的——`journal/<id>.jsonl` 记多少取决于你/AI 调了多少。**盯 journal 增不增长 = 盯记忆有没有被真正调用**（干了活但 journal 不动 = 协议没被遵守，记忆形同摆设）。

## 一个重要步骤的标准时序（强制）
```
start-step  → 实际操作 → 核对真实结果 → evidence add → verify → commit-step
```
**没有 `step_committed` 的步骤不算完成。** 中断（只 start 未 commit）会被 `recover`/`resume` 检出。

## 状态机
`planned → in_progress → {verifying → completed | blocked}`；`* → cancelled`。
硬规则（写进 `lib/statemachine.mjs` + 测试）：
- 禁止 `in_progress` 直达 `completed`（必须先 `verifying`）。
- `→ completed` 必须有通过的验证证据（`verification_finished:pass` + 每条 DoD `met`+evidence）。
- `→ blocked` 必须带 blocker。
- `completed` 是终态，重开须显式 `reopen`（不静默重开）。

## 一致性与恢复
- **原子写**：tmp → fsync → rename，避免半截文件。
- **锁**：每任务独占锁文件（`wx` 创建）+ stale 超时兜底。
- **乐观版本锁**：改快照校验 `version`，冲突则拒写并要求重读。
- **幂等**：`commit-step` 前扫 journal 同 `idempotency_key`，已提交则跳过。
- **恢复**：`recover` 找出 started 未 commit 的步骤；确认真实态后 `--reconcile`（必须带证据）或 `--fail`；**不凭摘要猜完成**。

### 事务边界（诚实声明）
本机制**不提供**跨 Git / 文件系统 / 数据库 / 第三方 API 的真 ACID 事务。
跨系统一致性靠**幂等键 + 补偿操作 + reconciliation（真实态回读）**，边界即此文档所述。

## 压缩 / Checkpoint 的诚实边界
- `checkpoint` 只总结事实/决策/未完成项/证据引用，标注依据 `event seq` 范围，可由原始日志重生成；**不删原始日志**、**不把 started 当 completed**。
- **平台压缩无法由本机制强制拦截**。`.claude/settings.json` 里挂了**可选** `PreCompact`（压缩前跑 `checkpoint --auto`）与 `SessionStart`（开机跑 `context`）钩子作增强；钩子由平台触发、非本机制保证，失效时手动跑同名命令即可。核心机制不依赖钩子。

## 方法论脚手架层（可选，阶段编排 + 强引导 + 看板）
在「任务记忆」底座上加一层：把开发方法论写成 `process.json`（数据），脚手架**一步步引导你产出对应内容**，
并用 HTML 看板实时展示「进行到哪一步 / 产物是什么、在哪 / 下一步干啥」。每个**阶段 = 一个记忆 task**（复用状态机/DoD/证据/恢复）。

```
process init            # 从模板生成 .agent/process.json（install 已顺带生成）
next                    # 打印唯一的下一步（如：phase start understand）
phase start <id>        # 惰性建阶段 task 并切为活动任务；末尾提示该调哪个 skill 产出什么
（用提示的 skill 生成内容）→ artifact add --phase <id> --key <k> --path <真实路径>
system add <key> --name <名>   # 登记业务系统：按 worklist 模板铺开该系统的标准开发任务（数据库/API/前后端/角色/权限/测试）
system list                    # 列出已登记系统 + 各自完成进度
worklist set --system <k> --task <t> --status <s>   # 推进某系统某开发任务状态（开发到哪标到哪）
board [--out ..] [--open]   # 生成看板：地铁线当前站高亮 + 逐系统开发任务清单 + 产出物总账(路径可点) + skillband
hook install                # 装 git post-commit：每次提交后自动刷新 board.html（install 已顺带装）
```

- **开发任务清单上看板（逐系统）**：`逐系统建造` 阶段在 `process.json` 里配一份 `worklist`（标准开发任务模板）；`system add` 为每个业务系统铺开一套，`worklist set` 推进状态，流程 tab 渲染成「系统 × 任务」矩阵——即「这个后台要做哪些开发任务、每个系统每步到哪了」，随提交刷新。
- **阶段验收 DoD**：记忆 tab 的任务卡片把该阶段 task 的 DoD 逐条展开成「✓/○」清单 + 进行中步骤 + 依据文档链接，反映该阶段的验收进度。
- **可点跳转**：产出物总账路径、任务卡片「依据」在磁盘上真实存在的文件渲染成相对链接，点开即原文件（如页面契约 `blueprint.json` / 渲染蓝图 `blueprint.html`）；缺失则纯文本 + ✗。
- **提交后自动刷新**：`install` / `hook install` 装的 `post-commit` hook 每次 `git commit` 后重跑 `board`，看板即最新态；对已有 hook 幂等、不覆盖。
- **强引导**：`phase start / artifact add / commit-step / verify / complete / dod set / resume` 成功后都在末尾追加一行 `下一步 → …`，共用纯函数 `computeNext()`。
- **产物真源=磁盘**：登记只是索引，`next/board/artifact list/process status` 一律 `existsSync` 回读——登记了但文件不在→如实 ✗，不假绿。
- **skill 只绑定不执行**：`process.json` 里 `skills` 是「该调哪个 skill」的引导指针；看板标 ✓已装/✗未装/?未知，实际起动走正常 Skill 机制。skill 本体**不随模板打包**，清单见 `process/SKILLS.md`（install 完成时会提示缺哪个）。
- 分层：`process.json`（配置，提交）；`process-state.json` / `board.html`（运行时，忽略）。字段与换方法论见 `process/README.md`。
- **给 AI 的工作协议**：把 `PORTING.md` 的「方法论脚手架协议」段贴进 `AGENTS.md` / `CLAUDE.md`，让后续会话遵守引导闭环。

## 后续 Agent 工作协议
见 `AGENTS.md` / `CLAUDE.md` 的「任务记忆协议」节。

## Bugfix Harness Evolver

同级 `../harness_evolver/` 维护四阶段历史规则。自动捕获先进入 `.agent/bugs.json`；只有 `bug close` 通过根因、影响、改动、impact-check 和 evidence 回读后才写入 `docs/retrospective/feedback.jsonl` 与 `已归档反馈.md`，并自动运行离线 Evolver。

`report` 阶段 `complete` 会检查所有 `in_scope` Bug 已归档/延后、演进状态不 pending、Evolver 报告和 Bug HTML 报告可回读。`FEEDBACK-PROTOCOL.md` 在每次 context/resume 中始终注入。
