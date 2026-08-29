# Harness Evolver

把下游真实 Bug/反馈逆向映射到 Harness 上游生成阶段，形成可持续更新的规则库，并在 `.agent` 执行阶段动态注入。

## 架构

```text
历史 Markdown
  -> bug_analyzer.py        解析 U/E/BUG 表格或标题
  -> LLM/heuristic mapper   REQUIREMENT | DATABASE | CODING | TESTING
  -> pipeline_evolver.py    增量状态、相似去重、规则重建
  -> knowledge_base/*.md    手工 Baseline + 托管规则
  -> context_injector.py    技术栈排序 + Few-Shot + 有界上下文
  -> .agent next/context/resume/phase start
```

模块只依赖 Python 标准库（Python 3.10+）。默认 `--use-llm never`，即使环境中已有 API Key 也不会静默外发；只有命令显式选择 `auto|always` 才使用外部模型。

## 使用

```bash
# 单文件
python3 -m harness_evolver.evolve \
  --input-docs harness_evolver/history/2026-08-fishery-three-in-one-retrospective.md

# 批量目录，与任务目标中的命令兼容
python3 -m harness_evolver.evolve --input-docs ./history_bugs/

# 查看某阶段实际注入内容
python3 -m harness_evolver.context_injector \
  --stage CODING --tech-stack "Spring Boot,Vue,uni-app"

# 不落盘预演
python3 -m harness_evolver.evolve --input-docs ./history_bugs/ --dry-run --json
```

每次正式运行会更新：

- `state/evolution_state.json`：文档摘要、Bug 事实、聚类规则。
- `state/bug_traces.jsonl`：结构化归因事实账。
- `knowledge_base/stage*.md`：四阶段可读规则库。
- `reports/<timestamp>-evolution-report.md` 与 `reports/LATEST.md`。

脚手架源仓内置 `history/2026-08-fishery-three-in-one-retrospective.md`，它是首批跨项目历史种子。新项目复制本目录后会同时继承已生成的事实账和规则；之后可继续摄入该项目自己的复盘文档。

## LLM 配置（可选）

```bash
export HARNESS_EVOLVER_API_KEY="..."
export HARNESS_EVOLVER_MODEL="..."
export HARNESS_EVOLVER_BASE_URL="https://api.openai.com/v1" # 或兼容端点
python3 -m harness_evolver.evolve --input-docs ./history_bugs/ --use-llm auto
```

- `never`（默认）：完全离线、可重复，不读取外部模型配置。
- `auto`：配置完整时用 LLM；失败后自动回退 heuristic，并在报告标注。
- `always`：LLM 失败即失败，适合 CI 强制模式。

进入事实账与 LLM payload 前会遮蔽常见 Bearer/token/password/API Key 和手机号；API Key 不写入状态、规则或报告。自动脱敏不能替代人工审查，将反馈发送给外部模型前仍须获得组织授权。

## 去重与防膨胀

- 仅分析 SHA 发生变化的文档。
- 同一文档同一 `bug_id` 更新时替换旧事实，不重复累计。
- 同阶段规则按中英文 token Jaccard 相似度聚类，来源和出现次数合并。
- 每阶段默认最多 80 条托管规则；注入默认只取 8 条规则和 3 个 Few-Shot，最多 12KB。
- 知识库 Baseline 永不被流水线覆盖，只有托管 marker 之间会重写。

## Harness 集成

`.agent/scripts/lib/evolver.mjs` 调用同一个 `context_injector.py`。以下命令自动附加历史质量上下文：

- `node .agent/scripts/agent.mjs next`
- `node .agent/scripts/agent.mjs context`
- `node .agent/scripts/agent.mjs resume`
- `node .agent/scripts/agent.mjs phase start <id>`

阶段映射位于 `config.json`。`build-systems` 中 `db/test/role/perm` 等 worklist 会覆盖 phase 默认归因，从而分别注入数据库、测试或需求边界规则。
默认开发阶段与本仓 10 个 Bugfix 阶段都已映射；`reconcile` 明确归入 CODING，同时保留原影响面对账门。项目可在 `config.json` 只写需要覆盖的项。

安装完整 Harness 后，推荐通过 `node .agent/scripts/agent.mjs feedback ...` 维护项目反馈。`feedback close`、delivery/report 完成门禁和显式复盘关键词会自动调用本模块的离线 `evolve`，无需手工重复拼命令。
