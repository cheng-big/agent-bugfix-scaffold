# Bug-Fix Harness 设计与使用说明

> 一套「bug 修复方法论脚手架」的设计蓝图 + 使用手册。
> 目标：让 AI/你**被引导着、一步步、可自我纠错地**把 bug 从"现象"修到"验证通过"，
> 而不是凭记忆瞎改、改完假绿。
>
> 脚手架实体已建成（本目录 `agent-bugfix-scaffold/`，引擎复用 + 10 阶段方法论 + repo-map/impact-check/bug import/report 四命令，自测全绿）。
> 本文讲清「为什么这么设计 / harness 自检 / 边界盲区」；落地用法见 `README.md`「落地到目标项目」。

---

## 一、这是什么 / 解决什么痛点

它不是一个"帮你改 bug 的脚本"，而是一个 **harness（受控执行环境）**：
给 AI 一套**有输入、有记忆、有反馈闭环、有安全网、有验收门**的流程，让它能自主迭代到 bug 真正修好。

解决四个典型翻车：
1. **凭记忆定位 = 定错位** → 先测绘系统、读真源，再定位。
2. **改完假绿** → 双轨真验证 + 截图回填，禁止"看起来没报错"就收工。
3. **改 A 弄坏 B** → 改前影响面分析 + **改后 diff 对账**（`git diff` 客观改动 × 反向调用方 vs 预测）+ 回归门。
4. **无限打转烧 token** → 尝试计数 + 卡死升级求助。

**复用现有引擎**：直接沿用同目录 `agent-dev-scaffold/dot-agent/` 的引擎
（`process.json` 阶段编排 + `agent.mjs` 零依赖 CLI + append-only 记忆层 + HTML 看板），
只换成下面这套 bug-fix 方法论，并补 3 项 bug 专属能力（Excel/Word 录入、系统测绘、双轨验证+截图回填报告）。

---

## 二、核心逻辑：10 阶段生命周期

每个阶段 = 一个记忆 task，复用状态机 / DoD / gate / 证据链。
产物真源是磁盘（`existsSync` 回读，缺失如实标 ✗，不假装做了）。

| # | 阶段 | 干什么 | 输入真源 | 硬门 (gate) |
|---|---|---|---|---|
| 00 | 🗺 orient 系统测绘 | 给目标系统建**架构图谱**，作为定位地基 | 代码库 + repo-map 扫描 | **充分性自检门**（见下） |
| 01 | 📥 intake 录入台账 | 在线/离线 Excel·Word bug 清单 → 归一化 `bugs.json` | 你的 bug 清单 | 每条有 id/现象/复现/期望/严重级/涉及端 |
| 02 | 🔁 reproduce 稳定复现 | 逐条复现，产出**运行时证据**（日志/栈/真实数据样本） | bugs.json + 目标系统 | 复现不了的挂起，**禁止猜根因** |
| 03 | 🔬 root-cause 根因定位 | 静态调用链 ∩ 动态证据，定位到 `文件:行` + 为什么 | 架构图谱 + 复现证据 | 根因 ≠ 改了哪行；定不下来回退补测绘 |
| 04 | 💥 impact 影响面 | blast radius：谁共用、波及哪、**回归清单** | 架构图谱 + 调用链 | 回归清单必须列全 |
| 05 | 🛠 fix-plan 修复方案 | 最小外科式方案；多方案**显式择一+理由**；定测试计划+验收标准 | 03/04 产物 | **★确认门：STOP 等你 OK 才进 06** |
| 06 | 🩹 fix 执行修复 | 只改必要处，贴项目风格 | 修复方案 | 改前打 git 基线；不顺手重构 |
| 07 | 🧮 reconcile 影响面复核 | 改后 diff 对账：实际改动 × 反向调用方 vs 04/05 预测 | fix 后 git diff + impact/fix-plan | **★对账门**：计划外改动/未覆盖波及逐条处置 |
| 08 | ✅ verify 双轨验证 | 真跑复现路径 + 回归清单，截图回填 | fix diff + 测试计划 | 真跑真截图，**禁假绿**；先过对账门；FAIL → 回退 |
| 09 | 📄 report 报告归档 | 单 bug/汇总 HTML：现象→根因→影响→改动→前后对比截图；根因沉淀记忆层 | 全程证据 | 报告可点、截图已嵌 |

### 07 reconcile 的「改后 diff 对账门」（这是防「改多了 / 波及 B」的关键）
04 影响面是**改前的主观预测**、06 change.md 是**手写自述**——唯一的客观事实源 `git diff` 必须被机器核对一遍：
- `impact-check --bug <id>` 从 `git diff` 抽**实际改动的文件 + 触碰的顶层符号**（100% 客观）。
- 对每个被改符号 grep 全库**反向调用方**，与 `impact.md` 回归清单交叉：不在清单里的调用方 → 「⚠ 未覆盖波及」。
- 改动文件不在 `fix-plan.md`/`impact.md` 提及范围 → 「⚠ 计划外改动（可能改多了）」。
- 边界诚实：符号级 grep 抓不到动态/反射/跨端调用 → 明确交 08 verify 兜底，**禁止据「没查到调用方」判定无影响**。

### 00 orient 的「充分性自检门」（这是精确定位的关键）
测绘做成**三层，按需加深**（省 token）：
- 第一层（廉价全量）：`repo-map.mjs` 扫出骨架——页面/路由清单、模块依赖、云函数清单。
- 第二层（按 bug 聚焦）：只对涉及的那条链深读源码 + 画数据流。
- 第三层（按需动态）：静态定不了位时，接 reproduce 的运行时证据。

自检门的 DoD **不是**"扫完了"，**而是**逐条 bug 能答出：
> **「它涉及哪条调用链？数据从哪来、经过谁、到哪去？」**
> 答得出 → 够了，进 root-cause；答不出 → 那就是测绘缺口，标出来补 / 或熔断问人，**禁止硬着头皮改**。

同时**登记「已知盲区」**（静态扫描看不到的，指明在后续阶段怎么补）：
1. 动态/反射调用（`this[m]()`、eventBus）— 抓不全依赖 → 运行时探针补。
2. 跨端/云边界（小程序→云函数→DB/三方 API）— 只能到调用点 → 云端日志补。
3. 配置/环境驱动分支 — 看不出实际走哪条 → 复现时确认。
4. 数据形状问题 — 读代码永远发现不了 → 真实数据样本。

---

## 三、三条纪律带 + 三个 harness 安全机制

**纪律带**（写进每阶段 critical_constraints）：
- 不猜根因（定位靠扫描+读真源+运行时证据）
- 不假绿（验证靠真跑真截图）
- 外科式修改（只改必要处，贴项目风格）

**安全机制**（让它是"能自我纠错的 harness"，而非一条直线流程）：
- **① 回退闭环**：verify FAIL → loop back 到 root-cause；`attempt` 计数 + 记录上次失败原因，别再撞同一堵墙。
- **② 隔离回滚**：每条 bug 修复前打 git 基线/开分支，改坏一键回滚（试错安全网）。
- **③ 卡死升级**：`attempt` 到上限（默认 3）仍 FAIL，或根因定不下来 → 熔断，停下求助人，不无限烧 token。
- **④ 回归门**：verify 的 PASS = 本 bug 复现路径通过 **且** impact 回归清单不破。
- **⑤ 改后对账门（07 reconcile）**：改完拿 `git diff` 客观核对——计划外改动、反向调用方未覆盖的波及，逐条处置后才进 verify；防「改多了/波及 B」溜过验证。
- **⑥ 阶段顺序命令层门**：`phase start <id>` 会校验 `depends_on` 的直接前置阶段是否真完成（task completed 且 required 产物已落盘），未完成**直接拒绝进入**（`--force` 逃生）。把阶段顺序从「靠 AI 读协议自觉」的**建议式**升级为**命令层强制**——AI 想跳过 reconcile 直奔 verify 会被命令拒掉，不再依赖人发现后喊它回流程。只要走这套 CLI 就绕不过。
- **⑦ 提交层 pre-commit 兜底门**：`install`/`hook install` 顺带装 git `pre-commit` hook，提交前跑 `precheck`（软兜底）——**有中断步骤（started 未 commit）硬拦**；提交了业务代码却还没过 07 对账则**醒目警告但放行**（`--strict` 可升级为硬拦）。这是 ⑥ 之外、连「绕开 CLI 直接改文件」也能在提交口拦一道的兜底。健壮性：node 缺失或 `.agent/scripts` 不全时 hook 自动跳过、`precheck` 自身异常一律放行——**工具失效绝不阻塞提交**；`git commit --no-verify` 是显式逃生阀。诚实边界：pre-commit 拦「提交」，拦不住「改了不提交就宣称完成」——那一层要靠平台级 Stop/PreToolUse hook。

---

## 四、双轨验证（因为验证手段随产物类型分流）
- **标准 web / html** → 浏览器探针（Playwright / DevTools，走 `flow-probe` / `browser-testing-with-devtools` skill）跑复现路径 → PASS/FAIL → PNG 截图 → 嵌进 `report.html`。
- **微信小程序 / 云函数 / 后端逻辑** → 微信开发者工具截图，或单测 / 日志断言。
- 脚手架按产物类型**自动分流**，一套流程覆盖两类。

> ⚠️ 注意：浏览器探针**跑不了 wxml**。当前示例项目是微信小程序，走的是右轨。

---

## 五、怎么用（落地到一个真实系统）

```bash
# 1. 把脚手架装进目标项目（脚手架建好后）
cp -r agent-bugfix-scaffold/dot-agent <目标项目>/.agent
cd <目标项目>
node .agent/scripts/agent.mjs install
node --test .agent/scripts/*.test.mjs        # 应全绿

# 2. 配置身份与流程
#   编辑 .agent/PROJECT.md          —— 项目身份
#   编辑 .agent/process.json        —— 确认 9 阶段、绑定的 skill、输入真源路径

# 3. 建架构图谱（00 orient）
node .agent/scripts/agent.mjs next            # 唯一下一步
node .agent/scripts/agent.mjs repo-map        # 扫骨架 → AI 语义标注 → arch-map

# 4. 录入 bug 台账（01 intake）
node .agent/scripts/agent.mjs bug import --file bugs.xlsx   # 离线 xlsx/docx
#   在线文档（腾讯/飞书/Sheets）先用 web-access 抓成表或导出本地，再 import

# 5. 照 next 一步步走
node .agent/scripts/agent.mjs next            # 现在该干啥（含该调的 skill + 输入真源）
node .agent/scripts/agent.mjs board --open    # 看板：流程/记忆/bug报告
node .agent/scripts/agent.mjs doctor          # 自检记忆是否真被调用
```

关键卡点：走到 **05 fix-plan** 会 **STOP 等你确认**；确认后才允许改码。

---

## 六、目录结构（脚手架建成后）

```
agent-bugfix-scaffold/
├─ README.md
└─ dot-agent/                    # 落地成目标项目的 .agent/
   ├─ process/
   │  ├─ bugfix-process.template.json   # 10 阶段 + 纪律带 + 安全机制
   │  └─ README.md  SKILLS.md            # 绑 debugging-and-error-recovery / flow-probe / browser-testing-with-devtools / verify
   ├─ schemas/bug.schema.json  verify-evidence.schema.json
   ├─ scripts/
   │  ├─ agent.mjs               # 引擎 + 注册 repo-map / impact-check / bug import / report 命令
   │  ├─ bug-import.mjs          # xlsx/docx → bugs.json（零依赖：node:zlib 解 zip）
   │  ├─ repo-map.mjs            # 扫页面/路由/依赖/云函数骨架
   │  ├─ impactcheck.mjs         # 改后 diff 对账：实际改动 × 反向调用方 vs 预测（零依赖）
   │  └─ lib/…                    # 引擎 lib，board.mjs 加 bug 报告 tab
   ├─ templates/report.template.html
   └─ PROJECT.md.template  PORTING.md  INSTALL-PROMPT.md
```

---

## 七、harness 完整性自检表

| harness 要素 | 由谁满足 |
|---|---|
| 任务输入规格 | 01 intake → bugs.json |
| 世界模型/感知 | 00 orient + repo-map |
| 状态记忆/可恢复 | 记忆层 journal + resume |
| 动作空间 | 06 fix |
| 反馈/验证回路（oracle） | 07 verify 双轨 + 截图 |
| 验收/停止条件 | 每阶段 DoD + gate |
| 人在环确认门 | 05 fix-plan 确认门 |
| 可观测性 | board + report |
| 验证失败回退闭环 | 安全机制 ① |
| 变更隔离+回滚 | 安全机制 ② |
| 卡死升级/收敛 | 安全机制 ③ |
| 回归防护 | 04 改前影响面 + 07 改后 diff 对账门 + 安全机制 ④（回归门） |

---

## 八、边界与盲区（诚实声明）
- 静态测绘负责"缩小到哪条链"，**动态证据**负责"钉到哪一行"，**自检门**逐条 bug 保证地基够——三者闭环才敢说支撑精确定位。单靠测绘不够。
- 业务规则类 bug（代码看不出的"为什么"）→ 熔断问人，不猜。
- 浏览器探针只能测标准 web；小程序走右轨。

---

## 九、与另外两个脚手架的关系

| 项目 | 定位 |
|---|---|
| agent-task-memory | 纯"任务记忆"层（防遗忘/可恢复） |
| agent-dev-scaffold | 记忆层 + **开发**方法论脚手架 + 看板 |
| **agent-bugfix-scaffold（本文）** | 记忆层 + **bug 修复**方法论脚手架 + 双轨验证 + 截图报告 |

三者共享同一引擎，方法论不同。
