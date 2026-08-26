# 本方法论用到的 skill 清单（引用，不随模板打包）

Bug 修复方法论（`process.template.json`）在各阶段**引用**下列 skill 作为「该调哪个 skill」的引导指针。
**这些 skill 的本体不随本模板打包**——它们住在 `~/.claude/skills/<name>/`（或项目 `./.claude/skills/<name>/`）。
脚手架只打印 skill 名、并探测是否已装（`✓已装 / ✗未装 / ?未知`），**不自动执行**；实际起动走正常 Skill 机制。

## 清单（阶段 → skill / 内置命令 → 用途）

| 阶段 | skill / 命令 | 用途 |
|---|---|---|
| 00 系统测绘 | `repo-map`（内置命令）+ `agent-skills:debugging-and-error-recovery` | 扫骨架 → AI 语义标注架构图谱 |
| 01 录入台账 | `bug import`（内置命令）+ `web-access` | 离线 xlsx/docx/csv 直接解析；在线文档用 web-access 抓成表，需登录的（飞书/腾讯文档）可用可选脚本 `scripts/read_online_chrome.py` 借已登录 Chrome 标签抓取 |
| 02 稳定复现 | `agent-skills:debugging-and-error-recovery` | 系统化复现 + 抓运行时证据（栈/日志/数据样本） |
| 03 根因定位 | `agent-skills:debugging-and-error-recovery` | 静态调用链 ∩ 动态证据，定位到文件:行 |
| 04 影响面 | （纯分析，无 skill） | 沿架构图谱查共用方 + 回归清单 |
| 05 修复方案·确认门 | （纯分析，无 skill） | 最小方案择一 + 测试计划；STOP 等人工确认 |
| 06 执行修复 | （纯改码，无 skill） | 打 git 基线后外科式改动 |
| 07 影响面复核 | `impact-check`（内置命令） | 改后 diff 对账：实际改动×反向调用方 vs 04/05 预测，红字标计划外改动/未覆盖波及 |
| 08 双轨验证 | `flow-probe` · `agent-skills:browser-testing-with-devtools` | web/html 走浏览器探针截图；小程序走微信工具/单测 |
| 09 报告归档 | `report`（内置命令） | 台账 + 证据 → HTML 报告 |

> **双轨说明**：浏览器探针（flow-probe / browser-testing-with-devtools）只能测标准 web/html，**跑不了 wxml**。
> 微信小程序 / 云函数走右轨：微信开发者工具截图 或 单测 / 日志断言。

## 怎么确认装没装

```bash
node .agent/scripts/agent.mjs process status   # 每阶段列出 skill 及 ✓已装/✗未装/?未知
```

## 缺 skill 怎么办

- 缺了不影响记忆层/脚手架层运行——只是 `next` 提示里那个 skill 你手上没有；`repo-map`/`bug import`/`report` 是内置命令，永远可用。
- 自行获取放到 `~/.claude/skills/<name>/`，或改用等价 skill。
- **换 skill**：直接改 `.agent/process.json` 的 `phases[].skills` 字段，不用改代码。
- 探测路径面向 Claude Code（`.claude/skills`）；其他平台改 `scripts/lib/skills.mjs` 的 `skillRoots()`。
