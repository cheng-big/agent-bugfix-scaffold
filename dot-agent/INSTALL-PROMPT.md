# INSTALL-PROMPT — 一段话丢给大模型，让它把这套装进要修 bug 的项目

> 用法：把下面「====」之间整段**复制给目标项目里的 AI**（Claude Code / Codex / Cursor 等），
> 把 `<模板仓库路径>` 换成 `agent-bugfix-scaffold` 仓库路径，把 `<bug清单路径>` 换成本项目 bug 清单位置。
> 前提：目标机器有 `node` 与 `python3`。

====
请把这套「任务记忆 + Bug 修复方法论脚手架」装到本项目，并带我起步修 bug。严格按下面做，每步做完如实报告，任一步失败就停下报告、不要往下走：

1. **先调查**：读本项目 README / 构建方式 / 测试方式 / 是否已有 `.agent`；看 `git status` 保护未提交改动。已装过就别重复装。
2. **拷贝两个安装单元**：
   ```bash
   cp -r <模板仓库路径>/dot-agent ./.agent
   cp -r <模板仓库路径>/harness_evolver ./harness_evolver
   ```
3. **安装**（幂等）：`node .agent/scripts/agent.mjs install`
   —— 建运行时目录、生成 `.agent/PROJECT.md` 与 `.agent/process.json`、追加 `.gitignore`、装 git hooks（post-commit 刷看板 + pre-commit 流程兜底），并检测方法论引用的 skill 装没装。
4. **自测**：
   ```bash
   node --test .agent/scripts/*.test.mjs
   python3 -m unittest discover -s harness_evolver/tests -v
   ```
   必须分别 **52/52**、**7/7** 绿。
5. **填身份**：编辑 `.agent/PROJECT.md`，写清本项目身份 / 不可违反规则 / 真源 / DoD 通则。
6. **接协议**：把 `.agent/PORTING.md` 的任务记忆、方法论和 Bugfix 自动学习三段协议贴进本项目 `CLAUDE.md` 或 `AGENTS.md`。
7. **对齐方法论**：`node .agent/scripts/agent.mjs process init`，打开 `.agent/process.json`——
   - 阶段 `00 orient` 的 `inputs.repo.path` 默认 `.`（目标代码库根），一般不用改；
   - 阶段 `01 intake` 的 `inputs.bug-inbox.path` 改成本项目 bug 清单：`<bug清单路径>`；
   - 10 阶段（系统测绘→录入台账→复现→根因→影响面→方案确认门→修→影响面复核→双轨验证→报告）默认适用；字段说明见 `.agent/process/README.md`，skill 见 `.agent/process/SKILLS.md`。
8. **建地基 + 录入**：
   - `node .agent/scripts/agent.mjs repo-map` —— 扫系统骨架到 `.agent/arch-map.md`，**你再补语义标注**（每模块职责 + 数据流）；
   - `node .agent/scripts/agent.mjs bug import --file <bug清单路径>` —— 归一化到 `.agent/bugs.json`（在线文档先导出本地或用 web-access 抓成 csv）。
   - 若已有 `docs/retrospective/项目复盘待办.md` 但没有 `feedback.jsonl`，先运行 `bug retrospective-import --file docs/retrospective/项目复盘待办.md`；CLI 会生成不覆盖的 `.legacy.md` 备份。
9. **起步**：跑 `node .agent/scripts/agent.mjs resume`（自动刷新进度看板并打印地址），**把「📊 进度看板：<地址>」原样告诉我**。再跑 `next`，照唯一下一步做——**第一步是 `00 系统测绘`**。之后每敲完一条命令看末尾「下一步 →」继续。
   - 走到 **`05 修复方案·确认门` 会 STOP 等我确认**，未确认别动代码；
   - **`06 执行修复` 改完，`07 影响面复核` 自动跑 `impact-check --bug <id>`** 对账——把「计划外改动 / 未覆盖波及」红字列给我过目，处置完才进 `08 双轨验证`。
   - `08 verify` 通过后执行 `bug close <id>`，它会校验证据、归档复盘并自动生成规则差异；不能只改 Bug 状态。
10. **报告**：告诉我——两个单元装了什么、自测结果（Node X/52、Python X/7）、自动学习协议是否接入、缺哪些 skill、录入了几条 Bug。
====

## 装完之后的日常（引导闭环）

```
node .agent/scripts/agent.mjs next                     # 随时问：现在该干啥（唯一答案）
node .agent/scripts/agent.mjs phase start <phase-id>   # 进入它让你进的阶段
（照提示读输入真源、调对应 skill 产出内容）
node .agent/scripts/agent.mjs artifact add --phase <id> --key <k> --path <真实路径>   # 登记产物（磁盘回读✓✗）
node .agent/scripts/agent.mjs impact-check --bug <id>  # 07 改后 diff 对账：改多了/波及谁，红字顶出
node .agent/scripts/agent.mjs report --open            # 台账+证据 → HTML 报告
node .agent/scripts/agent.mjs bug evolve               # 只用已归档 Bug 生成规则差异
node .agent/scripts/agent.mjs board --open             # 看板：当前站高亮 + 产物在哪 + skill 装没装
```
核心一句：**每敲完一条命令，看末尾「下一步 →」照做。** 详见 `README.md` / `process/README.md`。
