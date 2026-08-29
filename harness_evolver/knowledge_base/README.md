# Harness Evolution Knowledge Base

这四个文件会被 Harness 阶段任务动态注入。每个文件分为两部分：

1. `Baseline`：团队维护的稳定规则，Evolver 不覆盖。
2. `EVOLVER:MANAGED`：由历史 Bug 重新聚类和渲染，禁止手工编辑。

规则的结构化真源位于 `../state/evolution_state.json`。执行：

```bash
python3 -m harness_evolver.evolve --input-docs harness_evolver/history
python3 -m harness_evolver.context_injector --stage CODING --tech-stack "Spring Boot,Vue"
```

注入内容有长度与条数上限，不会把整个 Bug 历史塞进模型上下文。
