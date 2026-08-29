# UPGRADE-PROMPT — 一段话丢给大模型，把已装的旧版 `.agent` 升级到新版

> 场景：某项目**已经装过旧版 `.agent`**（只有任务记忆层），现在要升级到新版
> （新增：方法论脚手架层 process + 进度看板 board + 记忆可观测性 doctor）。
> 用法：把「====」之间整段复制给那个项目里的 AI，`<新模板仓库路径>` 换成新版 `agent-bugfix-scaffold` 路径。
>
> 核心安全原则：**只更新 `.agent/` 里可提交的代码/schema/文档，绝不动运行时数据和我填过的文件。**

====
请把本项目已有的 `.agent`（旧版：只有任务记忆层）**升级**到新版，严格按下面做，每步做完如实报告，任一步失败就停下：

0. **先调查再动手**：`git status`。确认 `.agent/scripts` 与 `.agent/schemas` 里**没有本项目的本地改动**（若有，先告诉我，别覆盖）。以下是「我的数据 / 运行时」，**全程绝不能覆盖或删除**：
   `.agent/PROJECT.md`、`.agent/process.json`、`.agent/bugs.json`、`.agent/bugs/`、`.agent/reports/`、任务记忆运行时、`docs/retrospective/`，以及已有 `harness_evolver/{state,knowledge_base,history,reports,config.json}`。

1. **拷新版的「可提交」部分**覆盖到本项目 `.agent/`（这些是代码/schema/文档，不含任何运行时数据）：
   ```bash
   T=<新模板仓库路径>/dot-agent
   cp -R "$T/scripts/." .agent/scripts/     # 覆盖 agent.mjs + lib/（新增 process/board/skills）+ process.test.mjs
   cp -R "$T/schemas/." .agent/schemas/     # 新增 process.schema.json、process-state.schema.json
   cp -R "$T/process"   .agent/             # 新增 process/（process.template.json + README + SKILLS）
   cp "$T/README.md" "$T/PORTING.md" "$T/INSTALL-PROMPT.md" "$T/UPGRADE-PROMPT.md" "$T/FEEDBACK-PROTOCOL.md" .agent/
   ```
   注意：源模板里没有运行时数据文件、也没有 `PROJECT.md`/`process.json`，所以上面的 `cp` **不会**碰到我的数据。

2. **安装/升级 Evolver**：不存在时复制完整目录；已存在时只更新 Python 实现和测试，保留项目知识目录与 `config.json`。
   ```bash
   H=<新模板仓库路径>/harness_evolver
   if [ ! -d harness_evolver ]; then cp -R "$H" ./harness_evolver; else
     cp "$H/__init__.py" "$H/bug_analyzer.py" "$H/context_injector.py" "$H/evolve.py" "$H/llm_mapper.py" "$H/models.py" "$H/pipeline_evolver.py" "$H/README.md" harness_evolver/
     mkdir -p harness_evolver/tests && cp -R "$H/tests/." harness_evolver/tests/
   fi
   ```

3. **跑升级安装**（幂等，不覆盖已有项目数据/配置/hook）：
   ```bash
   node .agent/scripts/agent.mjs install
   node .agent/scripts/agent.mjs hook install   # 若上一步提示无 .git 而后来才 git init，可单独补装
   ```

4. **自测**：Node **52/52**、Python **7/7**：
   ```bash
   node --test .agent/scripts/*.test.mjs
   python3 -m unittest discover -s harness_evolver/tests -v
   ```

5. **确认旧数据完好**：
   ```bash
   node .agent/scripts/agent.mjs doctor    # 原有任务数 / journal 事件应仍在
   node .agent/scripts/agent.mjs resume    # 能读出原任务上下文
   ```

6. **接入自动学习协议**：保留现有 10 阶段 process；把 `.agent/PORTING.md` 的 Bugfix 自动学习协议贴入项目 Agent 规范，并运行 `context` 确认协议和阶段规则均出现。

7. **报告**：新增命令、自测结果（Node X/52、Python X/7）、旧 Bug/任务数据是否完好、Evolver 注入阶段和自动协议是否生效。
====

## 这次升级新增了什么（相对只有记忆层的旧版）

- **命令**：保留原命令并新增 `bug detect/add/update/close/evolve/list`。
- **新文件**：`harness_evolver/`、`FEEDBACK-PROTOCOL.md`、`scripts/lib/{evolver,bugcapture,retrospective,evolution-gate}.mjs` 与对应测试。
- **保留方法论**：权威 10 阶段、fix-plan 人工确认、reconcile 影响面对账、双轨验证与 pre-commit 均不改序。
- **新增闭环**：已验证 Bug 证据归档、离线 Evolver、report 完成门禁、动态规则注入；不覆盖你的运行时数据。
