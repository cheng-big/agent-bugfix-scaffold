from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

from .pipeline_evolver import DEFAULT_KNOWLEDGE, DEFAULT_REPORTS, DEFAULT_STATE, DEFAULT_TRACES, EvolutionPipeline


def make_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Evolve Harness rules from downstream Bug feedback")
    parser.add_argument("--input-docs", nargs="+", required=True, help="Markdown file(s) or directories")
    parser.add_argument("--project-root", default=str(Path.cwd()))
    parser.add_argument("--use-llm", choices=["auto", "always", "never"], default="never")
    parser.add_argument("--state-path", default=str(DEFAULT_STATE))
    parser.add_argument("--traces-path", default=str(DEFAULT_TRACES))
    parser.add_argument("--knowledge-dir", default=str(DEFAULT_KNOWLEDGE))
    parser.add_argument("--reports-dir", default=str(DEFAULT_REPORTS))
    parser.add_argument("--similarity", type=float, default=0.72)
    parser.add_argument("--max-rules-per-stage", type=int, default=80)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--prune", action="store_true")
    parser.add_argument("--json", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = make_parser().parse_args(argv)
    try:
        pipeline = EvolutionPipeline(
            project_root=args.project_root,
            state_path=args.state_path,
            traces_path=args.traces_path,
            knowledge_dir=args.knowledge_dir,
            reports_dir=args.reports_dir,
            use_llm=args.use_llm,
            similarity_threshold=args.similarity,
            max_rules_per_stage=args.max_rules_per_stage,
        )
        summary = pipeline.run(args.input_docs, dry_run=args.dry_run, prune=args.prune)
    except (ValueError, RuntimeError, TimeoutError) as exc:
        if args.json:
            print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        else:
            print(f"Harness evolution failed: {exc}", file=sys.stderr)
        return 2
    if args.json:
        print(json.dumps(summary.to_dict(), ensure_ascii=False))
    else:
        print("Harness evolution complete")
        print(f"  documents: {summary.scanned_documents} (changed {summary.changed_documents}, unchanged {summary.unchanged_documents})")
        print(f"  bug traces: {summary.extracted_bugs}")
        print(f"  stage attribution: {summary.stages}")
        print(f"  rule counts: {summary.rules}")
        print(f"  report: {summary.report_path or '(dry-run)'}")
        if summary.warnings:
            print("  warnings:")
            for warning in summary.warnings:
                print(f"    - {warning}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
