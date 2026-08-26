# UPGRADE-PROMPT — 一段话丢给大模型，把已装的旧版 `.agent` 升级到新版

> 场景：某项目**已经装过旧版 `.agent`**（只有任务记忆层），现在要升级到新版
> （新增：方法论脚手架层 process + 进度看板 board + 记忆可观测性 doctor）。
> 用法：把「====」之间整段复制给那个项目里的 AI，`<新模板路径>` 换成新版 `dot-agent` 的真实路径。
>
> 核心安全原则：**只更新 `.agent/` 里可提交的代码/schema/文档，绝不动运行时数据和我填过的文件。**

====
请把本项目已有的 `.agent`（旧版：只有任务记忆层）**升级**到新版，严格按下面做，每步做完如实报告，任一步失败就停下：

0. **先调查再动手**：`git status`。确认 `.agent/scripts` 与 `.agent/schemas` 里**没有本项目的本地改动**（若有，先告诉我，别覆盖）。以下是「我的数据 / 运行时」，**全程绝不能覆盖或删除**：
   `.agent/PROJECT.md`、`.agent/process.json`（若已存在）、`.agent/tasks/`、`.agent/journal/`、`.agent/decisions/`、`.agent/evidence/`、`.agent/checkpoints/`、`.agent/ACTIVE_TASK.json`、`.agent/process-state.json`、`.agent/board.html`。

1. **拷新版的「可提交」部分**覆盖到本项目 `.agent/`（这些是代码/schema/文档，不含任何运行时数据）：
   ```bash
   T=<新模板路径>/dot-agent
   cp -R "$T/scripts/." .agent/scripts/     # 覆盖 agent.mjs + lib/（新增 process/board/skills）+ process.test.mjs
   cp -R "$T/schemas/." .agent/schemas/     # 新增 process.schema.json、process-state.schema.json
   cp -R "$T/process"   .agent/             # 新增 process/（process.template.json + README + SKILLS）
   cp "$T/README.md" "$T/PORTING.md" "$T/INSTALL-PROMPT.md" "$T/UPGRADE-PROMPT.md" .agent/
   ```
   注意：源模板里没有运行时数据文件、也没有 `PROJECT.md`/`process.json`，所以上面的 `cp` **不会**碰到我的数据。

2. **跑升级安装**（幂等；会补生成 `.agent/process.json`、把 `process-state.json`/`board.html` 补进 `.gitignore` 的运行时块、装 git `post-commit` hook 让提交后自动刷新看板；不覆盖已有 PROJECT.md/运行时/用户已有 hook）：
   ```bash
   node .agent/scripts/agent.mjs install
   node .agent/scripts/agent.mjs hook install   # 若上一步提示无 .git 而后来才 git init，可单独补装
   ```

3. **自测**：`node --test .agent/scripts/*.test.mjs` —— 应 **29/29 绿**（记忆层 13 + 脚手架层 16），不绿停下报告。

4. **确认旧数据完好**：
   ```bash
   node .agent/scripts/agent.mjs doctor    # 原有任务数 / journal 事件应仍在
   node .agent/scripts/agent.mjs resume    # 能读出原任务上下文
   ```

5. **（可选）启用方法论脚手架层**：编辑 `.agent/process.json`（把阶段 01 `inputs` 的需求文档 `path` 改成本项目真实路径；默认 7 阶段不适用就改 `phases`）。把 `.agent/PORTING.md` 里「**方法论脚手架协议**」段贴进本项目 `CLAUDE.md`/`AGENTS.md`。
   - **注意**：若你**已有旧版 `process.json`**（install 不覆盖它），新版模板把「页面契约·约束优先」独立成一个阶段（原 6 阶段→7 阶段，`blueprint` 从逆向设计迁到新阶段、产 JSON+渲染 HTML 两份）——想用这个新阶段，对照 `process/process.template.json` 手动把 `page-contract` 阶段并入你的 `process.json` 并顺延后续阶段 `no`。

6. **报告**：新增了哪些命令、自测结果（X/29）、`doctor`/`resume` 是否证明旧数据完好、还需我确认什么。
====

## 这次升级新增了什么（相对只有记忆层的旧版）

- **命令**：`process init/status`、`next`、`phase start <id>`、`artifact add/list`、`system add/list`、`worklist set`、`board`、`hook install`、`doctor`
- **新文件**：`scripts/lib/{process,board,skills,hook}.mjs`、`scripts/process.test.mjs`、`schemas/{process,process-state}.schema.json`、`process/`（模板+README+SKILLS）、`INSTALL-PROMPT.md`、`UPGRADE-PROMPT.md`
- **改的文件**：`scripts/agent.mjs`（加新命令 + 下一步收口 + 看板地址 + 装 git hook + doctor）、`README.md`、`PORTING.md`
- **看板增强**：流程 tab「逐系统开发任务清单」矩阵（`worklist` + `system`/`worklist set` 驱动）、任务卡片展开「阶段验收 DoD」、产物/依据路径可点跳转、`post-commit` 提交后自动刷新
- **方法论**：新增独立阶段「页面契约·约束优先」（原 6→7 阶段），产页面契约 JSON + 渲染 HTML 两份
- **没动**：现有 `lib/{store,task,journal,schema,statemachine,context}.mjs`、现有三个 schema、`agent.test.mjs`、以及你的一切运行时数据。
