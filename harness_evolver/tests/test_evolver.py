from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch

from harness_evolver.bug_analyzer import BugAnalyzer
from harness_evolver.context_injector import ContextInjector, resolve_stage
from harness_evolver.models import RawBug, Stage, redact_sensitive_text
from harness_evolver.pipeline_evolver import ANALYZER_VERSION, EvolutionPipeline, evolution_lock


SAMPLE = """# 复盘

| 编号 | 用户反馈 / 现象 | 根因 | 本轮处置 | 状态 |
|---|---|---|---|---|
| U-01 | 审核状态遗漏 | 页面契约没有完整状态机 | 增加驳回重提状态 | 已验证 |
| S-01 | 候选规则 | 不应作为 Bug | 无 | P0 |

| 编号 | 现象 | 定位结果 | 影响 | 状态 |
|---|---|---|---|---|
| E-01 | 详情 ID 跳转失败 | MySQL BIGINT 超过 JavaScript 安全整数 | 详情打不开 | 已验证 |
"""


class BugAnalyzerTest(unittest.TestCase):
    def test_parses_bug_tables_and_skips_scaffold_candidates(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "bugs.md"
            path.write_text(SAMPLE, encoding="utf-8")
            bugs = BugAnalyzer(use_llm="never").parse_document(path, source_name="bugs.md")
        self.assertEqual([bug.bug_id for bug in bugs], ["U-01", "E-01"])
        self.assertEqual(bugs[0].title, "审核状态遗漏")
        self.assertIn("BIGINT", bugs[1].root_cause)

        secret_sample = SAMPLE.replace(
            "MySQL BIGINT 超过 JavaScript 安全整数",
            "sk-liveabcdefghijklmnop ghp_abcdefghijklmnopqrstuvwxyz eyJabcdefghijk.eyJabcdefghijk.abcdefghijk 联系 13800138000",
        )
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "secrets.md"
            path.write_text(secret_sample, encoding="utf-8")
            secret_bugs = BugAnalyzer(use_llm="never").parse_document(path, source_name="secrets.md")
        serialized = json.dumps([bug.root_cause for bug in secret_bugs], ensure_ascii=False)
        self.assertNotIn("sk-liveabcdefghijklmnop", serialized)
        self.assertIn("sk-[REDACTED]", serialized)
        self.assertIn("138****8000", serialized)
        self.assertNotIn("ghp_abcdefghijklmnopqrstuvwxyz", serialized)
        self.assertNotIn("eyJabcdefghijk", serialized)
        pem = "-----BEGIN PRIVATE KEY-----\nsecret-body\n-----END PRIVATE KEY-----"
        self.assertEqual(redact_sensitive_text(pem), "[REDACTED PRIVATE KEY]")

    def test_heuristic_maps_all_four_stages(self) -> None:
        bugs = [
            RawBug("U-01", "状态机遗漏", "需求没有定义取消态"),
            RawBug("E-01", "查询慢", "数据库缺少复合索引"),
            RawBug("E-02", "地图不恢复", "SDK loader 缓存 rejected Promise"),
            RawBug("E-03", "真机缺证据", "未安装模拟器，验收覆盖缺失"),
            RawBug("E-04", "Evolver 误合并规则", "heuristic 的 Jaccard 被公共套话主导"),
            RawBug("E-05", "agent context 身份为空", ".agent/PROJECT.md 仍是占位模板"),
            RawBug("U-06", "只有中文与业务编号边界需明确", "字段名与显示值未本地化", "监测点编号保留原值"),
        ]
        result = BugAnalyzer(use_llm="never").analyze(bugs)
        stages = {trace.bug_id: trace.stage_attribution for trace in result.traces}
        self.assertEqual(stages["U-01"], Stage.REQUIREMENT)
        self.assertEqual(stages["E-01"], Stage.DATABASE)
        self.assertEqual(stages["E-02"], Stage.CODING)
        self.assertEqual(stages["E-03"], Stage.TESTING)
        self.assertEqual(stages["E-04"], Stage.CODING)
        self.assertEqual(stages["E-05"], Stage.CODING)
        self.assertEqual(stages["U-06"], Stage.REQUIREMENT)
        by_id = {trace.bug_id: trace for trace in result.traces}
        self.assertEqual(by_id["U-06"].failure_mode, "页面信息架构与显示契约不完整")
        with patch.dict(os.environ, {"HARNESS_EVOLVER_API_KEY": "", "HARNESS_EVOLVER_MODEL": ""}):
            with self.assertRaisesRegex(RuntimeError, "requires HARNESS_EVOLVER_API_KEY"):
                BugAnalyzer(use_llm="always")


class PipelineTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.knowledge = self.root / "knowledge_base"
        shutil.copytree(Path(__file__).parents[1] / "knowledge_base", self.knowledge)
        self.document = self.root / "bugs.md"
        self.document.write_text(SAMPLE, encoding="utf-8")
        self.pipeline = EvolutionPipeline(
            project_root=self.root,
            state_path=self.root / "state" / "evolution_state.json",
            traces_path=self.root / "state" / "bug_traces.jsonl",
            knowledge_dir=self.knowledge,
            reports_dir=self.root / "reports",
            use_llm="never",
        )

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_incremental_run_and_context_injection(self) -> None:
        first = self.pipeline.run([self.document])
        self.assertEqual(first.changed_documents, 1)
        self.assertEqual(first.extracted_bugs, 2)
        self.assertTrue(Path(first.report_path or "").exists())
        database = (self.knowledge / "stage2_db_design_rules.md").read_text(encoding="utf-8")
        self.assertIn("E-01", database)
        self.assertIn("<!-- EVOLVER:MANAGED-START -->", database)
        self.assertIn("## Baseline", database)

        first_report = first.report_path
        second = self.pipeline.run([self.document])
        self.assertEqual(second.changed_documents, 0)
        self.assertEqual(second.unchanged_documents, 1)
        self.assertEqual(second.added_rule_ids, [])
        self.assertNotEqual(first_report, second.report_path)
        self.assertTrue(Path(second.report_path or "").exists())

        with self.assertRaisesRegex(ValueError, "No Markdown feedback documents"):
            self.pipeline.run([self.root / "missing"], prune=True)
        preserved = json.loads((self.root / "state" / "evolution_state.json").read_text(encoding="utf-8"))
        self.assertEqual(len(preserved["records"]), 2)

        injector = ContextInjector(
            state_path=self.root / "state" / "evolution_state.json",
            knowledge_dir=self.knowledge,
        )
        context = injector.build(Stage.DATABASE, tech_stack="MySQL Flyway", max_chars=5000)
        self.assertIn("Stage 2", context["text"])
        self.assertIn("E-01", context["text"])
        self.assertLessEqual(len(context["text"]), 5000)

    def test_changed_document_replaces_same_bug_identity(self) -> None:
        self.pipeline.run([self.document])
        changed = SAMPLE.replace("页面契约没有完整状态机", "页面契约没有定义驳回后的重新提交态")
        self.document.write_text(changed, encoding="utf-8")
        summary = self.pipeline.run([self.document])
        state = json.loads((self.root / "state" / "evolution_state.json").read_text(encoding="utf-8"))
        self.assertEqual(summary.changed_documents, 1)
        self.assertEqual(len(state["records"]), 2)
        self.assertIn("重新提交态", state["records"]["bugs.md::U-01"]["root_cause"])
        self.assertEqual(state["documents"]["bugs.md"]["analyzer_version"], ANALYZER_VERSION)
        self.assertEqual(state["documents"]["bugs.md"]["analysis_profile"], "heuristic")

        state["documents"]["bugs.md"]["analyzer_version"] = 0
        (self.root / "state" / "evolution_state.json").write_text(json.dumps(state), encoding="utf-8")
        self.assertEqual(self.pipeline.run([self.document]).changed_documents, 1)

        state = json.loads((self.root / "state" / "evolution_state.json").read_text(encoding="utf-8"))
        state["documents"]["bugs.md"]["analysis_profile"] = "different-mode"
        (self.root / "state" / "evolution_state.json").write_text(json.dumps(state), encoding="utf-8")
        self.assertEqual(self.pipeline.run([self.document]).changed_documents, 1)

    def test_exact_duplicate_guidelines_are_compacted(self) -> None:
        traces = BugAnalyzer(use_llm="never").analyze(
            [
                RawBug("E-01", "索引缺失 A", "数据库缺少复合索引"),
                RawBug("E-02", "索引缺失 B", "数据库缺少复合索引"),
            ]
        ).traces
        rules = self.pipeline.build_rules(traces)[Stage.DATABASE]
        self.assertEqual(len(rules), 1)
        self.assertEqual(rules[0].occurrences, 2)

    def test_state_lock_and_external_source_anonymization(self) -> None:
        with evolution_lock(self.pipeline.state_path):
            with self.assertRaisesRegex(TimeoutError, "Evolution state is locked"):
                with evolution_lock(self.pipeline.state_path, timeout=0.05):
                    pass
        self.assertFalse(self.pipeline.state_path.with_suffix(".json.lock").exists())
        source = self.pipeline.source_name(Path("/outside-workspace/private-bugs.md"))
        self.assertTrue(source.startswith("external/private-bugs-"))
        self.assertNotIn("outside-workspace", source)


class ContextMappingTest(unittest.TestCase):
    def test_phase_and_worklist_mapping(self) -> None:
        self.assertEqual(resolve_stage(phase="understand"), Stage.REQUIREMENT)
        self.assertEqual(resolve_stage(phase="build-systems", worklist_task="db"), Stage.DATABASE)
        self.assertEqual(resolve_stage(phase="build-systems", worklist_task="test"), Stage.TESTING)
        self.assertEqual(resolve_stage(phase="foundation", target_path="db/migration/V1.sql"), Stage.DATABASE)
        self.assertEqual(resolve_stage(phase="build-systems", worklist_task="backend"), Stage.CODING)
        self.assertEqual(resolve_stage(phase="intake"), Stage.REQUIREMENT)
        self.assertEqual(resolve_stage(phase="reproduce"), Stage.TESTING)
        self.assertEqual(resolve_stage(phase="root-cause"), Stage.CODING)
        self.assertEqual(resolve_stage(phase="reconcile"), Stage.CODING)
        self.assertEqual(resolve_stage(phase="report"), Stage.TESTING)
        partial = {"phase_stage_map": {"understand": "DATABASE"}}
        self.assertEqual(resolve_stage(phase="understand", config=partial), Stage.DATABASE)
        self.assertEqual(resolve_stage(phase="root-cause", config=partial), Stage.CODING)


if __name__ == "__main__":
    unittest.main()
