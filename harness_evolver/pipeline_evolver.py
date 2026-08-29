from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
import time
from typing import Any, Iterable

from .bug_analyzer import BugAnalyzer, scan_markdown
from .models import BugTrace, EvolutionRule, STAGE_FILES, Stage, normalized_text, stable_rule_id, text_tokens


MANAGED_START = "<!-- EVOLVER:MANAGED-START -->"
MANAGED_END = "<!-- EVOLVER:MANAGED-END -->"
PACKAGE_ROOT = Path(__file__).resolve().parent
DEFAULT_STATE = PACKAGE_ROOT / "state" / "evolution_state.json"
DEFAULT_TRACES = PACKAGE_ROOT / "state" / "bug_traces.jsonl"
DEFAULT_KNOWLEDGE = PACKAGE_ROOT / "knowledge_base"
DEFAULT_REPORTS = PACKAGE_ROOT / "reports"
ANALYZER_VERSION = 7


def atomic_write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with open(descriptor, "w", encoding="utf-8", closefd=True) as stream:
            stream.write(content)
        Path(temporary).replace(path)
    except Exception:
        Path(temporary).unlink(missing_ok=True)
        raise


def stale_lock_can_be_removed(lock_path: Path, stale_after: float) -> bool:
    try:
        if time.time() - lock_path.stat().st_mtime <= stale_after:
            return False
        content = lock_path.read_text(encoding="utf-8")
        match = re.search(r"\bpid=(\d+)\b", content)
        if not match:
            return True
        try:
            os.kill(int(match.group(1)), 0)
            return False
        except ProcessLookupError:
            return True
        except PermissionError:
            return False
    except FileNotFoundError:
        return False


@contextmanager
def evolution_lock(state_path: Path, *, timeout: float = 10.0, stale_after: float = 300.0):
    lock_path = state_path.with_suffix(state_path.suffix + ".lock")
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    descriptor: int | None = None
    while descriptor is None:
        try:
            descriptor = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            os.write(descriptor, f"pid={os.getpid()} started={datetime.now(timezone.utc).isoformat()}\n".encode("utf-8"))
        except FileExistsError:
            try:
                if stale_lock_can_be_removed(lock_path, stale_after):
                    lock_path.unlink()
                    continue
            except FileNotFoundError:
                continue
            if time.monotonic() - started >= timeout:
                raise TimeoutError(f"Evolution state is locked: {lock_path}")
            time.sleep(0.05)
    try:
        yield
    finally:
        os.close(descriptor)
        lock_path.unlink(missing_ok=True)


@dataclass(slots=True)
class EvolutionSummary:
    scanned_documents: int
    changed_documents: int
    unchanged_documents: int
    extracted_bugs: int
    stages: dict[str, int]
    rules: dict[str, int]
    added_rule_ids: list[str]
    removed_rule_ids: list[str]
    analysis_modes: dict[str, int]
    warnings: list[str]
    report_path: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "scanned_documents": self.scanned_documents,
            "changed_documents": self.changed_documents,
            "unchanged_documents": self.unchanged_documents,
            "extracted_bugs": self.extracted_bugs,
            "stages": self.stages,
            "rules": self.rules,
            "added_rule_ids": self.added_rule_ids,
            "removed_rule_ids": self.removed_rule_ids,
            "analysis_modes": self.analysis_modes,
            "warnings": self.warnings,
            "report_path": self.report_path,
        }


def empty_state() -> dict[str, Any]:
    return {
        "schema_version": 1,
        "analyzer_version": ANALYZER_VERSION,
        "documents": {},
        "records": {},
        "rules": {stage.value: [] for stage in Stage},
        "last_run": None,
    }


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def jaccard(left: set[str], right: set[str]) -> float:
    if not left and not right:
        return 1.0
    union = left | right
    return len(left & right) / len(union) if union else 0.0


class EvolutionPipeline:
    def __init__(
        self,
        *,
        project_root: str | Path | None = None,
        state_path: str | Path = DEFAULT_STATE,
        traces_path: str | Path = DEFAULT_TRACES,
        knowledge_dir: str | Path = DEFAULT_KNOWLEDGE,
        reports_dir: str | Path = DEFAULT_REPORTS,
        use_llm: str = "never",
        similarity_threshold: float = 0.72,
        max_rules_per_stage: int = 80,
    ) -> None:
        self.project_root = Path(project_root or Path.cwd()).resolve()
        self.state_path = Path(state_path)
        self.traces_path = Path(traces_path)
        self.knowledge_dir = Path(knowledge_dir)
        self.reports_dir = Path(reports_dir)
        self.analyzer = BugAnalyzer(use_llm=use_llm)
        self.similarity_threshold = similarity_threshold
        self.max_rules_per_stage = max_rules_per_stage

    def load_state(self) -> dict[str, Any]:
        if not self.state_path.exists():
            return empty_state()
        state = json.loads(self.state_path.read_text(encoding="utf-8"))
        if state.get("schema_version") != 1:
            raise RuntimeError("Unsupported evolution state schema")
        state.setdefault("documents", {})
        state.setdefault("records", {})
        state.setdefault("rules", {stage.value: [] for stage in Stage})
        state.setdefault("analyzer_version", 0)
        return state

    def source_name(self, path: Path) -> str:
        try:
            return path.resolve().relative_to(self.project_root).as_posix()
        except ValueError:
            digest = hashlib.sha1(path.resolve().as_posix().encode("utf-8")).hexdigest()[:10]
            return f"external/{path.stem}-{digest}{path.suffix}"

    def run(self, inputs: Iterable[str | Path], *, dry_run: bool = False, prune: bool = False) -> EvolutionSummary:
        with evolution_lock(self.state_path):
            return self._run(inputs, dry_run=dry_run, prune=prune)

    def _run(self, inputs: Iterable[str | Path], *, dry_run: bool = False, prune: bool = False) -> EvolutionSummary:
        documents = scan_markdown(inputs)
        if not documents:
            raise ValueError("No Markdown feedback documents found; refusing to evolve or prune state")
        state = self.load_state()
        previous_rules = {
            item["rule_id"]
            for values in state.get("rules", {}).values()
            for item in values
        }
        changed = 0
        unchanged = 0
        modes: dict[str, int] = {}
        warnings: list[str] = []
        seen_sources: set[str] = set()

        for document in documents:
            source = self.source_name(document)
            seen_sources.add(source)
            digest = sha256_file(document)
            old = state["documents"].get(source)
            expected_profile = self.analyzer.analysis_profile
            if (
                old
                and old.get("sha256") == digest
                and old.get("analyzer_version") == ANALYZER_VERSION
                and old.get("analysis_profile") == expected_profile
            ):
                unchanged += 1
                continue
            raw_bugs = self.analyzer.parse_document(document, source_name=source)
            result = self.analyzer.analyze(raw_bugs)
            modes[result.mode] = modes.get(result.mode, 0) + len(result.traces)
            if result.warning:
                warnings.append(f"{source}: {result.warning}")
            for identity in [key for key, value in state["records"].items() if value.get("source_doc") == source]:
                del state["records"][identity]
            for trace in result.traces:
                state["records"][trace.identity] = trace.to_dict()
            state["documents"][source] = {
                "sha256": digest,
                "bug_count": len(result.traces),
                "analyzer_version": ANALYZER_VERSION,
                "analysis_profile": expected_profile if result.mode != "heuristic-fallback" else f"{result.mode}:{expected_profile}",
                "updated_at": datetime.now(timezone.utc).isoformat(),
            }
            changed += 1

        if prune:
            for source in list(state["documents"]):
                if source not in seen_sources:
                    del state["documents"][source]
                    for identity in [key for key, value in state["records"].items() if value.get("source_doc") == source]:
                        del state["records"][identity]

        traces = [BugTrace.from_dict(value) for value in state["records"].values()]
        rules = self.build_rules(traces)
        state["rules"] = {
            stage.value: [rule.to_dict() for rule in rules.get(stage, [])]
            for stage in Stage
        }
        state["last_run"] = datetime.now(timezone.utc).isoformat()
        state["analyzer_version"] = ANALYZER_VERSION
        current_rules = {rule.rule_id for values in rules.values() for rule in values}
        stage_counts = {stage.value: sum(trace.stage_attribution == stage for trace in traces) for stage in Stage}
        rule_counts = {stage.value: len(rules.get(stage, [])) for stage in Stage}
        summary = EvolutionSummary(
            scanned_documents=len(documents),
            changed_documents=changed,
            unchanged_documents=unchanged,
            extracted_bugs=len(traces),
            stages=stage_counts,
            rules=rule_counts,
            added_rule_ids=sorted(current_rules - previous_rules),
            removed_rule_ids=sorted(previous_rules - current_rules),
            analysis_modes=modes,
            warnings=warnings,
        )
        if not dry_run:
            self.write_outputs(state, traces, rules)
            report = self.write_report(summary, rules)
            summary.report_path = report.as_posix()
        return summary

    def build_rules(self, traces: list[BugTrace]) -> dict[Stage, list[EvolutionRule]]:
        grouped: dict[Stage, list[dict[str, Any]]] = {stage: [] for stage in Stage}
        for trace in sorted(traces, key=lambda item: (item.stage_attribution.value, item.bug_id, item.source_doc)):
            stage_groups = grouped[trace.stage_attribution]
            guideline_tokens = text_tokens(trace.corrective_guideline)
            failure_tokens = text_tokens(trace.failure_mode)
            best = None
            best_score = 0.0
            for group in stage_groups:
                same_guideline = normalized_text(trace.corrective_guideline) == group["guideline"]
                failure_score = jaccard(failure_tokens, group["failure_tokens"])
                score = 1.0 if same_guideline else failure_score * 0.65 + jaccard(guideline_tokens, group["guideline_tokens"]) * 0.35
                if not same_guideline and failure_score < 0.35:
                    continue
                if score > best_score:
                    best, best_score = group, score
            if best is None or best_score < self.similarity_threshold:
                stage_groups.append({
                    "representative": trace,
                    "traces": [trace],
                    "guideline": normalized_text(trace.corrective_guideline),
                    "guideline_tokens": guideline_tokens,
                    "failure_tokens": failure_tokens,
                })
            else:
                best["traces"].append(trace)
                best["guideline_tokens"].update(guideline_tokens)
                best["failure_tokens"].update(failure_tokens)
                if trace.confidence > best["representative"].confidence:
                    best["representative"] = trace

        result: dict[Stage, list[EvolutionRule]] = {stage: [] for stage in Stage}
        for stage, groups in grouped.items():
            for group in groups:
                representative: BugTrace = group["representative"]
                members: list[BugTrace] = group["traces"]
                guideline = representative.corrective_guideline
                result[stage].append(
                    EvolutionRule(
                        rule_id=stable_rule_id(stage, guideline),
                        stage=stage,
                        failure_mode=representative.failure_mode,
                        guideline=guideline,
                        bug_ids=sorted({trace.bug_id for trace in members}),
                        sources=sorted({f"{trace.source_doc}:{trace.source_line}" for trace in members}),
                        tech_stack=sorted({stack for trace in members for stack in trace.tech_stack}),
                        occurrences=len(members),
                        confidence=round(sum(trace.confidence for trace in members) / len(members), 3),
                    )
                )
            result[stage].sort(key=lambda item: (-item.occurrences, -item.confidence, item.rule_id))
            result[stage] = result[stage][: self.max_rules_per_stage]
        return result

    def write_outputs(
        self,
        state: dict[str, Any],
        traces: list[BugTrace],
        rules: dict[Stage, list[EvolutionRule]],
    ) -> None:
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        self.knowledge_dir.mkdir(parents=True, exist_ok=True)
        atomic_write_text(self.state_path, json.dumps(state, ensure_ascii=False, indent=2) + "\n")
        trace_content = "".join(
            json.dumps(trace.to_dict(), ensure_ascii=False) + "\n"
            for trace in sorted(traces, key=lambda item: (item.source_doc, item.bug_id))
        )
        atomic_write_text(self.traces_path, trace_content)
        for stage, filename in STAGE_FILES.items():
            path = self.knowledge_dir / filename
            self.render_knowledge(path, stage, rules.get(stage, []))

    def render_knowledge(self, path: Path, stage: Stage, rules: list[EvolutionRule]) -> None:
        if not path.exists():
            raise RuntimeError(f"Knowledge base file is missing: {path}")
        body = path.read_text(encoding="utf-8")
        if MANAGED_START not in body or MANAGED_END not in body:
            raise RuntimeError(f"Knowledge base markers are missing: {path}")
        managed: list[str] = [MANAGED_START]
        if not rules:
            managed.append("（尚无历史反馈生成规则）")
        for rule in rules:
            managed.extend(
                [
                    f"\n### {rule.rule_id} — {rule.failure_mode}",
                    f"- **防御指引：** {rule.guideline}",
                    f"- **来源 Bug：** {', '.join(rule.bug_ids)}",
                    f"- **来源位置：** {', '.join(f'`{source}`' for source in rule.sources)}",
                    f"- **适用技术栈：** {', '.join(rule.tech_stack) if rule.tech_stack else '通用'}",
                    f"- **观测次数 / 置信度：** {rule.occurrences} / {rule.confidence:.3f}",
                ]
            )
        managed.append(MANAGED_END)
        replacement = "\n".join(managed)
        updated = re.sub(
            re.escape(MANAGED_START) + r".*?" + re.escape(MANAGED_END),
            lambda _: replacement,
            body,
            flags=re.DOTALL,
        )
        atomic_write_text(path, updated.rstrip() + "\n")

    def write_report(self, summary: EvolutionSummary, rules: dict[Stage, list[EvolutionRule]]) -> Path:
        self.reports_dir.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        report = self.reports_dir / f"{stamp}-evolution-report.md"
        lines = [
            "# 脚手架能力进化报告",
            "",
            f"- 生成时间：{datetime.now(timezone.utc).isoformat()}",
            f"- 扫描文档：{summary.scanned_documents}",
            f"- 变更 / 未变更文档：{summary.changed_documents} / {summary.unchanged_documents}",
            f"- 累计 Bug 事实：{summary.extracted_bugs}",
            f"- 分析模式：{json.dumps(summary.analysis_modes, ensure_ascii=False)}",
            "",
            "## 阶段归因",
            "",
            "| Stage | Bug 数 | 规则数 |",
            "|---|---:|---:|",
        ]
        for stage in Stage:
            lines.append(f"| {stage.value} | {summary.stages[stage.value]} | {summary.rules[stage.value]} |")
        lines.extend(
            [
                "",
                "## 规则变化",
                "",
                f"- 新增：{', '.join(summary.added_rule_ids) if summary.added_rule_ids else '无'}",
                f"- 移除：{', '.join(summary.removed_rule_ids) if summary.removed_rule_ids else '无'}",
            ]
        )
        if summary.warnings:
            lines.extend(["", "## 降级与警告", ""] + [f"- {warning}" for warning in summary.warnings])
        lines.extend(["", "## 本次高频防御规则", ""])
        for stage in Stage:
            lines.append(f"### {stage.value}")
            top = rules.get(stage, [])[:5]
            lines.extend([f"- `{rule.rule_id}` ({rule.occurrences}次) {rule.guideline}" for rule in top] or ["- 无"])
            lines.append("")
        lines.extend(
            [
                "## 更新文件",
                "",
                *[f"- `harness_evolver/knowledge_base/{filename}`" for filename in STAGE_FILES.values()],
                "- `harness_evolver/state/evolution_state.json`",
                "- `harness_evolver/state/bug_traces.jsonl`",
            ]
        )
        content = "\n".join(lines).rstrip() + "\n"
        atomic_write_text(report, content)
        atomic_write_text(self.reports_dir / "LATEST.md", content)
        return report
