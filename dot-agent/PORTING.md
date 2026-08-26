# PORTING — 把 `.agent` 移植到新项目

这套「外部任务记忆与可恢复执行机制」是**自包含、零依赖**组件（只用 Node 内置模块）。
与业务技术栈**解耦**——业务是 Java/Python/Go 都行，只要机器上有 `node`，把整个 `.agent/` 目录丢过去即可用。

## 一、三步落地（机器上有 node）

```bash
# 1) 拷整个目录到新项目根
cp -r /path/to/.agent <新项目>/.agent

# 2) 一键安装（幂等，可反复跑）：建运行时目录+.gitkeep、生成 PROJECT.md、追加 .gitignore
cd <新项目> && node .agent/scripts/agent.mjs install

# 3) 自测（应全绿：记忆层 + 脚手架层 + impact-check 对账）
node --test .agent/scripts/*.test.mjs
```

拷贝时只需带：`scripts/`、`schemas/`、`README.md`、`PORTING.md`、`PROJECT.md.template`。
运行时目录（tasks/journal/decisions/evidence/checkpoints）由 `install` 现建，无需拷。

## 二、针对新项目适配（收敛成 2 必改 + 3 可选）

### 必改 1 —— 填 `.agent/PROJECT.md`（身份来源）
`install` 会从 `PROJECT.md.template` 生成 `.agent/PROJECT.md`。**编辑它**，写清本项目的身份、不可违反规则、真源、DoD 通则。
`context/resume` 的「你是谁」直接读这里——**这是适配的核心，通常不用改任何代码**。
（若不填 PROJECT.md，机制会自动回退探测 `AGENTS.md/CLAUDE.md/CONTRIBUTING.md/README.md`，但填了更准。）

### 必改 2 —— 确认 `.gitignore` 边界
`install` 已幂等追加运行时忽略规则。确认新项目里：**提交** `scripts/ schemas/ README.md PORTING.md PROJECT.md(.template) + .gitkeep`；**忽略** `ACTIVE_TASK.json / tasks / journal / decisions / evidence / checkpoints`（每机每会话状态，提交必冲突）。

### 可选 3 —— 把工作协议接进新项目的 Agent 规范
把下面这段贴进新项目的 `AGENTS.md` / `CLAUDE.md` / `README`（有哪个用哪个）：

```markdown
## 任务记忆协议（外部状态，详见 .agent/README.md）
- 每个新会话/恢复先跑：`node .agent/scripts/agent.mjs resume`
- 重要步骤：start-step → 操作 → 核对真实结果 → evidence → verify → commit-step；失败 fail-step。无 step_committed 不算完成。
- 仅 DoD 全 met+有证据、经 verifying 才 complete；不凭聊天摘要宣布完成。
- 压缩/会话结束/阶段结束前 checkpoint；TASK 快照 ≤16KB，历史进 journal/checkpoint。
- 边界：无跨系统 ACID（幂等+补偿+reconciliation）；平台压缩不可强制拦截，钩子仅增强。
```

### 可选 4 —— 压缩前/开机钩子（仅 Claude Code）
若新项目也用 Claude Code，在其 `.claude/settings.json` 挂 `PreCompact`→`checkpoint --auto`、`SessionStart`→`context`（参考本仓库 `.claude/settings.json`）。**核心机制不依赖钩子**，失效时手动跑同名命令兜底。

### 可选 5 —— DoD/约束措辞本地化
`init` 时用新项目自己的完成标准，别照抄别的项目字样。

## 三、新项目脚本层不是 Node（且不想引入 node）

设计与语言无关：**保持目录契约 + JSON/JSONL 格式 + `schemas/` 三个 schema 不变**（它们是接口），用主语言重写 `scripts/`——把 `store/journal/statemachine/context` 的逻辑一一对应翻译即可，不用重新设计。

## 四、验证与卸载

- 验证落地：`node .agent/scripts/agent.mjs install && node --test .agent/scripts/*.test.mjs`
- 首个任务：`node .agent/scripts/agent.mjs init --objective "..." --dod "..." && node .agent/scripts/agent.mjs resume`
- 卸载：删 `.agent/` 目录 + 移除 `.gitignore` 里 `# .agent 任务记忆运行时` 段。运行时数据未进 Git，删目录即净。

## 五、目录一览

```
.agent/
├── PORTING.md            本文（移植指南，committed）
├── README.md             用法/命令/纪律（committed）
├── PROJECT.md.template   身份模板（committed）
├── PROJECT.md            ← install 生成，按新项目填（committed）
├── process/              方法论脚手架层：process.template.json + README + SKILLS.md（committed）
├── process.json          ← install 从模板生成，按新方法论编辑（committed）
├── schemas/              JSON Schema（语言无关，committed）
├── scripts/              零依赖 Node CLI + lib + 测试（committed）
├── process-state.json    ← 运行时：当前阶段/阶段↔task 映射/产物登记（忽略）
├── board.html            ← 运行时：生成的看板（忽略）
└── tasks|journal|decisions|evidence|checkpoints/  运行时（.gitkeep 提交，内容忽略）
```

### 可选 6 —— 用方法论脚手架层（阶段编排 + 强引导 + 看板）
`install` 已顺带从 `process/process.template.json` 生成 `.agent/process.json`（内置默认 10 阶段 bug 修复方法论）。
想换方法论**只改 `process.json`**（改 `skills` 指向你用的 skill、`artifacts.path` 指向你项目产物位置），不用改代码。
日常：`process init`（若没跑过 install）→ `next`（看下一步）→ `phase start <id>` → 产出后 `artifact add` → `board` 出看板。
字段说明见 `process/README.md`；本方法论引用的 skill 清单（**不随模板打包**，是引导指针）见 `process/SKILLS.md`。

**把下面这段「方法论脚手架协议」贴进新项目的 `AGENTS.md` / `CLAUDE.md`**（让后续 AI 会话遵守引导闭环）：

```markdown
## 方法论脚手架协议（启用 process 层时，详见 .agent/process/README.md）
- 开工/接手先跑 `node .agent/scripts/agent.mjs next`，照它给的**唯一下一步**做，不要自己跳阶段。
- 进入阶段：`phase start <id>`；该阶段该调哪个 skill 见提示（skill 是引导指针，需你显式调用，不自动执行；缺哪个见 process/SKILLS.md）。
- 每产出一个产物，必须 `artifact add --phase <id> --key <k> --path <真实路径>` 登记 —— **产物真源是磁盘**，登记≠存在，缺失如实标 ✗，不假绿。
- 每步做完看命令末尾的「下一步 →」；阶段收尾走记忆层硬门（verify + 每条 DoD met+证据 + complete），不凭摘要宣布完成。
- 要对齐/汇报进度：`board` 生成看板（当前站高亮 + 产出物总账），别手写进度。
- **新会话首次回复**：先跑 `resume`（会自动刷新看板），并把它输出的「📊 进度看板：<地址>」原样告诉用户——让人知道去哪查看，不用来问。
```
