# agent-bugfix-scaffold — Bug 修复方法论脚手架

> 在「外部任务记忆」底座之上，加一层 **bug 修复方法论**：把「测绘系统 → 录入台账 → 复现 → 定位 → 影响面 → 方案(确认门) → 修 → 影响面复核 → 双轨验证 → 报告」写成可配置的 `process.json`，
> 让 AI/你**被引导着、一步步、可自我纠错地**把 bug 从"现象"修到"验证通过"——而不是凭记忆瞎改、改完假绿。
>
> 复用 `agent-dev-scaffold` 的引擎（零依赖 CLI + 记忆层 + HTML 看板），只换方法论 + 补 4 个 bug 专属命令。

本仓是**源模板**——`dot-agent/` 就是将来落到目标项目里的 `.agent/` 目录。不要在这里跑 install。
完整设计（为什么这么做、harness 自检、边界盲区）见 [`DESIGN.md`](./DESIGN.md)。

## 它解决什么

1. **凭记忆定位 = 定错位** → `00 系统测绘` 先扫系统建架构图谱，读真源再定位。
2. **改完假绿** → `07 双轨验证` 真跑 + 截图回填，禁止"看着没报错"就收工。
3. **改 A 弄坏 B** → `04 影响面` 改前列回归清单 + `07 影响面复核` 改后拿 `git diff` 客观对账（越界改动/未覆盖波及红字顶出）+ verify 回归门。
4. **无限打转烧 token** → verify 失败回退计数，试满上限熔断求助。

## 10 阶段生命周期

`00 系统测绘 → 01 录入台账 → 02 稳定复现 → 03 根因定位 → 04 影响面 → 05 修复方案·确认门 → 06 执行修复 → 07 影响面复核 → 08 双轨验证 → 09 报告归档`

- **05 是确认门**：方案 + 测试计划出来后 **STOP，等你确认才放行改码**。
- **07 是改后对账门**：改完跑 `impact-check`，把 `git diff` 客观改动 + 符号级反向调用方 与 04/05 预测交叉核对——「改多了」「波及了没预料的模块」当场红字顶出，过了才进验证。
- **阶段顺序是命令层强制的**：`phase start <id>` 会校验前置阶段是否真完成（产物已落盘），没完成**直接拒绝进入**——AI 想跳过对账/验证会被命令拒掉，不靠人盯（确需跳加 `--force`）。
- **提交口还有一道 pre-commit 兜底**：`install` 顺带装 git `pre-commit` hook，提交前软兜底检查——有中断步骤硬拦、提交业务码却没对账则醒目警告（`git commit --no-verify` 可显式跳过；工具失效不挡提交）。
- **5 条纪律带**：记得住 / 不猜根因 / 不假绿 / 外科式修改 / harness 安全网（打基线可回滚·FAIL 回退重试·卡死升级·回归门）。

## 4 个 bug 专属命令（内置，零依赖）

```bash
repo-map [--root <目标代码库>]              # 扫页面/路由/依赖/云函数骨架 → .agent/arch-map.md
impact-check --bug <id> [--base <ref>]      # 改后 diff 对账：实际改动×反向调用方 vs 04/05 预测 → .agent/bugs/<id>/impact-check.md（计划外改动/未覆盖波及红字列出 + AI 自查清单）
bug import --file <bugs.xlsx|docx|csv|json> # 录入台账 → .agent/bugs.json（识别 现象/复现/期望/严重级/模块/页面/状态/提出人；自动过滤已验收/已完成）
report [--out ..] [--open]                  # 台账+证据 → .agent/reports/index.html（统计概览 + 状态徽章 + 模块筛选）

# 可选：bug 清单在需登录的在线文档（飞书/腾讯文档）时，借已登录 Chrome 标签抓文本，再喂 AI 归一化成 bugs.json
python3 dot-agent/scripts/read_online_chrome.py "feishu.cn/wiki/xxx"
```

## 怎么用（核心：你跟 AI 对话，AI 驱动流程，命令不用你敲）

**这套脚手架是给大模型用的，不是给你背命令的。** 下面那些 `node .agent/...` 命令都是 **AI 照流程自动执行**的内部动作；你（人）只做三件事：

### ① 初始化（一次性）——把一段话发给项目里的 AI
打开 [`dot-agent/INSTALL-PROMPT.md`](./dot-agent/INSTALL-PROMPT.md)，把里面「====」之间**整段复制**，发给你目标项目里的 AI（Claude Code / Cursor / Codex 等），按提示把 `<模板路径>`、`<bug清单路径>` 换成真实值。AI 会自己完成全部装配：

> 拷 `.agent/` → `install` → 自测 → 填 `PROJECT.md` 身份 → 把工作协议接进你项目的 `CLAUDE.md` → `repo-map` 建架构图谱 → `bug import` 录入台账 → `resume` 起步。

**你不用自己敲任何 node 命令**，也不用记流程——AI 装完会把「装了什么、自测结果、录了几条 bug、还需你确认什么」报告给你。

### ② 日常修 bug——用自然语言指挥
直接对 AI 说「照 `next` 继续修下一个 bug」。它会自己按 10 阶段一步步走：`next` 取唯一下一步 → `phase start` 进阶段 → 产物 `artifact add` 登记 → `impact-check` 改后对账 → 跑验证 → `report` 出报告。全程照命令末尾的「下一步 →」推进，**不用你干预命令**。

### ③ 你只在两个「门」上拍板
- **`05 修复方案·确认门`**：AI 把方案 + 测试计划摆出来会 **STOP 等你确认**，你说「可以」它才动代码。
- **`07 影响面复核`**：AI 把「是不是改多了 / 波及了哪些没预料的模块」红字列给你过目（这正是你担心的场景，现在被自动顶出来）。

> 看板 `board.html` 和报告 `reports/index.html` 是给**你**看进度/结果的，AI 会把地址告诉你，浏览器打开即可。

<details>
<summary>底层命令一览（AI 替你执行，列出仅供你了解发生了什么，不用自己敲）</summary>

```bash
cp -r dot-agent <目标项目>/.agent && cd <目标项目>
node .agent/scripts/agent.mjs install          # 装：建目录 / 生成 PROJECT.md·process.json / 追加 .gitignore
node --test .agent/scripts/*.test.mjs           # 自测（应全绿，含 impact-check 对账用例）
node .agent/scripts/agent.mjs process init      # 生成方法论定义
node .agent/scripts/agent.mjs repo-map          # 00 建架构图谱骨架 → AI 补语义标注
node .agent/scripts/agent.mjs bug import --file bugs.xlsx   # 01 录入台账
node .agent/scripts/agent.mjs next              # 唯一下一步（AI 反复问它）
node .agent/scripts/agent.mjs impact-check --bug <id>      # 07 改后对账
node .agent/scripts/agent.mjs board --open      # 进度看板
node .agent/scripts/agent.mjs report --open     # bug 报告
```
</details>

## 与另外两个脚手架的关系

| 项目 | 定位 |
|---|---|
| agent-task-memory | 纯"任务记忆"层（防遗忘/可恢复） |
| agent-dev-scaffold | 记忆层 + **开发**方法论 + 看板 |
| **agent-bugfix-scaffold（本仓）** | 记忆层 + **bug 修复**方法论 + 双轨验证 + 截图报告 |

三者共享同一引擎，方法论不同。命令全集见 `dot-agent/README.md`，字段/换方法论见 `dot-agent/process/README.md`，skill 清单见 `dot-agent/process/SKILLS.md`。
