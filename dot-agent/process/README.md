# process — 方法论脚手架层（阶段编排 + 强引导 + 产物对齐看板）

在「任务记忆」底座之上加一层**方法论脚手架**：把一套开发方法论写成 `process.json`（数据），
让脚手架**一步步引导你产出对应内容**，并用一份 HTML 看板**实时展示「进行到哪一步 / 产物是什么 / 在哪」**。

> **这份文档分两类读者**：
> - **给人看**：本文（引导闭环、字段说明、换方法论）+ `SKILLS.md`（本方法论用哪些 skill、去哪装）+ `board.html`（看板）。
> - **给 AI 看**：把 `PORTING.md` 里「**方法论脚手架协议**」那段贴进项目 `AGENTS.md` / `CLAUDE.md`，
>   让后续会话遵守「照 `next` 走、产物必须 `artifact add` 登记、不跳阶段、拿 `board` 对齐、不假绿」。

- 每个**阶段（phase）** = 一个记忆 task（复用状态机/DoD/证据/中断恢复）。
- 每执行完一步，命令末尾**直接提示下一步**；`next` 命令随时问「现在干啥」得到唯一答案。
- 产物**真源是磁盘**：登记只是索引，`next/board/artifact list` 一律 `existsSync` 回读，缺失如实标 ✗。
- 阶段绑定的 **skill 只是引导指针**（该调哪个 skill），脚手架不自动执行；看板标注 skill 是否已装。
- 项目根存在 `harness_evolver/` 时，`next/context/resume/phase start` 会按 Bugfix 阶段注入历史防御规则；`reconcile` 保留原影响面对账门并归入 CODING 规则。
- `report` 阶段 complete 会先检查 `.agent/bugs.json` 全部本轮 Bug 已归档/延后、复盘一致、Evolver 不 pending 且两类报告可回读。

## 引导闭环（照着做下一步）

```
process init            # 从本模板生成 .agent/process.json
next                    # → 唯一下一步（如：phase start understand）
phase start <id>        # 惰性建该阶段 task 并切为活动任务；末尾提示该调哪个 skill 产出什么
（用提示的 skill 生成内容）
artifact add ...        # 登记产物（existsSync 回读）；末尾提示下一步
...（照提示循环）...
board                   # 生成/刷新 HTML 看板：地铁线当前站高亮 + 产出物总账 + skillband
```

> **进度看板去哪看**：`install` / `resume` / `next` 的输出都会**自带一行「📊 进度看板：<绝对地址>」**——不用问人。
> `resume`（新会话第一条命令）还会**自动刷新**看板。注意看板是**按需生成的快照**，不会实时自动变：状态改了要重跑 `board`（或下次 `resume`）才更新；产物真源始终是磁盘（`existsSync` 回读）。

## process.json 字段说明

| 字段 | 说明 |
|---|---|
| `process_version` | 版本号（整数） |
| `name` | 方法论名字 |
| `phases[]` | 阶段列表，按 `depends_on` 表达顺序 |
| `phases[].id` | 阶段标识（字母数字/._-），命令用它引用 |
| `phases[].no / icon / name` | 展示用编号 / 图标 / 名称 |
| `phases[].intent / what / why` | 一句话目标 / 做了什么 / 为什么（看板展示，帮对齐） |
| `phases[].skills[]` | 本阶段该调哪些 skill（**引导指针，不自动执行**） |
| `phases[].inputs[]` | 本阶段的**输入真源**（该读什么）。如阶段01 的需求文档；`next`/看板会提示「先读 X → 产出 Y」。装完把 `path` 改成本项目真实需求文档路径 |
| `phases[].depends_on[]` | 前置阶段 id（决定 `next` 取下一阶段的顺序） |
| `phases[].gates[]` | 硬约束/纪律（写进阶段 task 的 critical_constraints） |
| `phases[].dod[]` | 完成标准（写进阶段 task 的 definition_of_done） |
| `phases[].artifacts[]` | 本阶段应产出的产物 |
| `artifacts[].key` | 产物标识（`artifact add --key` 用） |
| `artifacts[].name / desc` | 产物名 / **是什么**（看板对齐关键） |
| `artifacts[].path` | 期望产出路径（`existsSync` 就查它；`<sys>` 是占位，实际登记时填真实路径） |
| `artifacts[].required` | 是否必需（`next` 只对必需且未在磁盘的产物催产出） |
| `rails[]` | 贯穿纪律带（展示用，如「记得住」「做得实」） |

## 换一套方法论

`process.json` 是配置、可提交。想换方法论（比如通用「spec→plan→build→test→ship」流），
**只改这个文件**：重写 `phases`（改 `skills` 指向你用的 skill，如 `agent-skills:spec` / `agent-skills:build`；
改 `artifacts.path` 指向你项目的产物位置），不用动任何代码。

最小示例：
```json
{
  "process_version": 1,
  "name": "通用增量开发",
  "phases": [
    { "id": "spec", "no": "01", "name": "写规格", "intent": "先定清楚要做什么",
      "skills": ["agent-skills:spec"], "depends_on": [],
      "dod": ["规格评审通过"],
      "artifacts": [{ "key": "spec", "name": "规格", "desc": "结构化需求", "path": "docs/spec.md", "required": true }] },
    { "id": "build", "no": "02", "name": "实现", "intent": "按规格增量实现",
      "skills": ["agent-skills:build"], "depends_on": ["spec"],
      "dod": ["构建绿 + 测试过"],
      "artifacts": [{ "key": "src", "name": "实现", "desc": "落地代码", "path": "src", "required": true }] }
  ],
  "rails": [{ "id": "dod", "name": "做得实", "desc": "测试验证意图而非仅行为" }]
}
```

## 分层（提交 vs 运行时）

| 文件 | 职责 | 是否提交 |
|---|---|---|
| `process/process.template.json` | 内置默认方法论模板 | ✅ 提交 |
| `.agent/process.json` | 本项目方法论配置（install 从模板生成） | ✅ 提交 |
| `.agent/process-state.json` | 运行时：当前阶段/阶段↔task 映射/产物登记表 | ❌ 忽略 |
| `.agent/board.html` | 生成的看板 | ❌ 忽略 |
