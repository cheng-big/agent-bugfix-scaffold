from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from .models import BugTrace, EvolutionRule, STAGE_FILES, Stage, text_tokens
from .pipeline_evolver import DEFAULT_KNOWLEDGE, DEFAULT_STATE


DEFAULT_PHASE_STAGE = {
    "understand": Stage.REQUIREMENT,
    "reverse-design": Stage.REQUIREMENT,
    "page-contract": Stage.REQUIREMENT,
    "foundation": Stage.CODING,
    "build-systems": Stage.CODING,
    "verify": Stage.TESTING,
    "delivery": Stage.TESTING,
    "orient": Stage.REQUIREMENT,
    "intake": Stage.REQUIREMENT,
    "reproduce": Stage.TESTING,
    "root-cause": Stage.CODING,
    "impact": Stage.REQUIREMENT,
    "fix-plan": Stage.CODING,
    "fix": Stage.CODING,
    "reconcile": Stage.CODING,
    "report": Stage.TESTING,
}
DEFAULT_WORKLIST_STAGE = {
    "db": Stage.DATABASE.value,
    "api": Stage.CODING.value,
    "backend": Stage.CODING.value,
    "frontend": Stage.CODING.value,
    "role": Stage.REQUIREMENT.value,
    "perm": Stage.REQUIREMENT.value,
    "test": Stage.TESTING.value,
}
DEFAULT_CONFIG = Path(__file__).resolve().parent / "config.json"


def resolve_stage(
    *,
    stage: str | None = None,
    phase: str | None = None,
    action: str | None = None,
    worklist_task: str | None = None,
    target_path: str | None = None,
    config: dict[str, Any] | None = None,
) -> Stage:
    config = config or {}
    worklist_map = {**DEFAULT_WORKLIST_STAGE, **config.get("worklist_stage_map", {})}
    phase_map = {**DEFAULT_PHASE_STAGE, **config.get("phase_stage_map", {})}
    database_hints = config.get("database_target_hints", ("migration", "ddl", "database", "data-model", "数据库", "迁移"))
    if stage:
        return Stage(stage.upper())
    if worklist_task and worklist_task in worklist_map:
        return Stage(worklist_map[worklist_task])
    combined = " ".join([action or "", target_path or ""]).lower()
    if any(token.lower() in combined for token in database_hints):
        return Stage.DATABASE
    return Stage(phase_map.get(phase or "", Stage.CODING.value))


class ContextInjector:
    def __init__(
        self,
        *,
        state_path: str | Path = DEFAULT_STATE,
        knowledge_dir: str | Path = DEFAULT_KNOWLEDGE,
    ) -> None:
        self.state_path = Path(state_path)
        self.knowledge_dir = Path(knowledge_dir)

    def load_state(self) -> dict[str, Any]:
        if not self.state_path.exists():
            return {"records": {}, "rules": {}}
        return json.loads(self.state_path.read_text(encoding="utf-8"))

    def build(
        self,
        stage: Stage,
        *,
        tech_stack: str = "",
        max_rules: int = 8,
        max_examples: int = 3,
        max_chars: int = 12000,
    ) -> dict[str, Any]:
        state = self.load_state()
        rules = [EvolutionRule.from_dict(value) for value in state.get("rules", {}).get(stage.value, [])]
        traces = [BugTrace.from_dict(value) for value in state.get("records", {}).values()]
        stack_tokens = text_tokens(tech_stack)

        def score(rule: EvolutionRule) -> tuple[float, int, str]:
            overlap = len(stack_tokens & text_tokens(" ".join(rule.tech_stack))) if stack_tokens else 0
            return (rule.occurrences * 3 + rule.confidence + overlap * 4, rule.occurrences, rule.rule_id)

        selected = sorted(rules, key=score, reverse=True)[: max(0, max_rules)]
        selected_ids = {bug_id for rule in selected for bug_id in rule.bug_ids}
        examples = [
            trace
            for trace in traces
            if trace.stage_attribution == stage and (not selected_ids or trace.bug_id in selected_ids)
        ]
        examples.sort(key=lambda item: (-item.confidence, item.bug_id))
        examples = examples[: max(0, max_examples)]
        knowledge_path = self.knowledge_dir / STAGE_FILES[stage]
        baseline = self._baseline(knowledge_path)
        lines = [
            "[历史交付质量反馈 · 动态注入]",
            f"归因阶段：{stage.value}",
            f"规则库：{knowledge_path.as_posix()}",
            "以下规则是当前任务的附加硬约束；与项目真源冲突时，以项目真源为准并记录冲突。",
            "",
            baseline.strip(),
        ]
        if selected:
            lines.extend(["", "## 历史 Bug 提炼规则"])
            for rule in selected:
                stacks = f" [{', '.join(rule.tech_stack)}]" if rule.tech_stack else ""
                lines.append(f"- `{rule.rule_id}`{stacks} {rule.guideline}")
        if examples:
            lines.extend(["", "## Few-shot 反例 → 上游防御"])
            for trace in examples:
                lines.extend(
                    [
                        f"### {trace.bug_id} · {trace.title}",
                        f"- 下游失败：{trace.failure_mode}",
                        f"- 上游约束：{trace.corrective_guideline}",
                    ]
                )
        text = "\n".join(lines).strip()
        if len(text) > max_chars:
            text = text[: max_chars - 80].rstrip() + "\n…（上下文达到长度上限，完整规则见知识库文件）"
        return {
            "stage": stage.value,
            "knowledge_file": knowledge_path.as_posix(),
            "rule_ids": [rule.rule_id for rule in selected],
            "example_bug_ids": [trace.bug_id for trace in examples],
            "text": text,
        }

    def _baseline(self, path: Path) -> str:
        if not path.exists():
            return "（规则库文件不存在，请先运行 harness_evolver.evolve）"
        body = path.read_text(encoding="utf-8")
        return body.split("<!-- EVOLVER:MANAGED-START -->", 1)[0].rstrip()


def make_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Assemble feedback-derived Harness context")
    parser.add_argument("--stage", choices=[stage.value for stage in Stage])
    parser.add_argument("--phase")
    parser.add_argument("--action")
    parser.add_argument("--worklist-task")
    parser.add_argument("--target-path")
    parser.add_argument("--tech-stack", default="")
    parser.add_argument("--max-rules", type=int, default=8)
    parser.add_argument("--max-examples", type=int, default=3)
    parser.add_argument("--max-chars", type=int, default=12000)
    parser.add_argument("--format", choices=["text", "json"], default="text")
    parser.add_argument("--state-path", default=str(DEFAULT_STATE))
    parser.add_argument("--knowledge-dir", default=str(DEFAULT_KNOWLEDGE))
    parser.add_argument("--config", default=str(DEFAULT_CONFIG))
    return parser


def main(argv: list[str] | None = None) -> int:
    args = make_parser().parse_args(argv)
    config_path = Path(args.config)
    config = json.loads(config_path.read_text(encoding="utf-8")) if config_path.exists() else {}
    stage = resolve_stage(
        stage=args.stage,
        phase=args.phase,
        action=args.action,
        worklist_task=args.worklist_task,
        target_path=args.target_path,
        config=config,
    )
    result = ContextInjector(state_path=args.state_path, knowledge_dir=args.knowledge_dir).build(
        stage,
        tech_stack=args.tech_stack,
        max_rules=args.max_rules,
        max_examples=args.max_examples,
        max_chars=args.max_chars,
    )
    print(json.dumps(result, ensure_ascii=False) if args.format == "json" else result["text"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
