# Bugfix Harness Evolver Design

## Goal

Add feedback-driven self-evolution to the Bugfix Harness without replacing its 10-stage workflow, confirmation gate, impact reconciliation, pre-commit checks, or existing `.agent/bugs.json` work queue.

## Architecture

The installed project keeps two distinct facts with one-way promotion:

- `.agent/bugs.json`: operational queue, answering “what is currently being fixed?”
- `docs/retrospective/feedback.jsonl`: committed learning ledger, answering “what verified failure and upstream prevention did this project establish?”

An incoming Bug enters only `bugs.json`. It enters the retrospective only after `bug close` proves that root cause, impact, code change, reconciliation, and verification evidence exist on disk. Harness Evolver reads a generated closed-only Markdown projection, never the open work queue.

The source repository ships two installable units:

- `dot-agent/`: Bugfix workflow, commands, memory, gates, hooks, and automatic Bug protocol.
- `harness_evolver/`: shared Python analyzer, four-stage knowledge base, state, and reports.

## Existing Behavior Preserved

The following Bugfix-specific behavior is authoritative and must survive the port:

- 10 phases: `orient -> intake -> reproduce -> root-cause -> impact -> fix-plan -> fix -> reconcile -> verify -> report`.
- `fix-plan` remains a human confirmation boundary.
- `phase start` continues enforcing dependency completion and required artifacts.
- `impact-check` remains mandatory before verification.
- post-commit board refresh and pre-commit safety checks remain installed.
- Existing `repo-map`, `bug import`, `impact-check`, and HTML `report` commands remain compatible.

No whole-directory overwrite from `agent-dev-scaffold/dot-agent` is allowed.

## Automatic Bug Capture

### Session Protocol

`FEEDBACK-PROTOCOL.md` is always injected by `context/resume`. For each incoming user message, the Agent classifies whether it asserts a concrete defect in the current project.

Candidate signals include `问题`, `bug`, `报错`, `异常`, `失败`, `不对`, `不应该`, `打不开`, `不能`, `缺失`, `遗漏`, `不好用`, and `需要修复`.

The Agent records a Bug before implementation work continues:

```bash
node .agent/scripts/agent.mjs bug add \
  --source user \
  --title "页面保存失败" \
  --actual "点击保存后页面报错"
```

Hypothetical discussion, quoted documentation, negation, generic Bug-management questions, and issues outside the scoped project do not trigger capture. Engineering failures require reproduction or evidence and use `--source engineering --evidence <ref>`.

The CLI cannot observe conversations outside an active Agent session and does not claim to be a background chat monitor.

### Operational Bug Fields

Imported and automatically captured records retain existing fields and add:

- `source`: `user | engineering | import`
- `source_key`: stable source row or `auto:<fingerprint>`
- `source_status`: source-system status, never overwritten by verification
- `verification_status`: `待验证 | 部分验证 | 已验证待归档 | 已归档 | 延后`
- `in_scope`: whether this run must process the Bug
- `fingerprint`: normalized source/title/actual digest
- `phase_id`, `task_id`, `evidence_refs[]`
- `previous_closures[]`, `reopened_count`

The existing `status` remains for backward-compatible display. New automatic records start with `status=待修复`, `source_status=待修复`, `verification_status=待验证`, and `in_scope=true`.

A duplicate open Bug is suppressed. If a matching Bug was `已归档|延后`, the same record reopens as `待验证`, retains a bounded closure snapshot, and becomes `in_scope=true`.

## Commands

The existing `bug import` and `bug list` remain. New actions are:

```text
bug detect --text "<incoming user message>"
bug add --source user|engineering --title .. [--actual ..] [--repro ..] [--expected ..] [--evidence ..]*
bug update <id> [--verification-status ..] [--evidence ..]*
bug close <id> [--status 已归档|延后]
bug evolve [--force]
```

Terminal verification states can only be set through `bug close`; `bug update` cannot bypass archival validation or Evolver.

Explicit user keywords map to:

| Keyword | Action |
|---|---|
| `记入 Bug` / `记入复盘` | Run `bug add` for the current concrete defect. |
| `生成规则差异` / `项目复盘` | Run `bug evolve`. |
| `进化脚手架` | Run project-local evolution and prepare reusable rule IDs for later promotion. |

Promotion into the canonical scaffold remains a separate explicit global-write boundary.

## Bug Close Evidence Gate

`bug close <id>` resolves `.agent/bugs/<id>/` and rejects closure unless these facts are readable:

- `root-cause.md`: non-empty confirmed root cause.
- `impact.md`: non-empty blast radius and regression scope.
- `change.md`: non-empty implemented change record.
- `impact-check.md`: non-empty post-change reconciliation output.
- `evidence/`: at least one non-empty evidence file.

For `已归档`, all five are required. `延后` requires a non-empty disposition reason supplied with `--resolution`; it does not claim a verified fix.

After validation, close updates `bugs.json`, projects the closed Bug into the retrospective, and automatically runs offline Evolver. If evolution fails, the Bug closure remains durable but `docs/retrospective/evolution.json` records `pending=true`; report phase completion remains blocked.

## Retrospective Projection

Committed project-learning files are:

- `docs/retrospective/feedback.jsonl`: structured closed Bug facts.
- `docs/retrospective/已归档反馈.md`: closed-only Evolver input.
- `docs/retrospective/项目复盘待办.md`: human-readable closed/open summary.
- `docs/retrospective/evolution.json`: last successful input fingerprint, report, and rule delta.

Each retrospective record links to the operational Bug ID and contains title, symptom, root cause, impact, resolution, evidence references, technology hints, and closure status. Secret and phone redaction matches Harness Evolver before persistence.

Existing projects with a retrospective Markdown but no JSONL ledger must import it before mutation. Import creates a non-overwriting `.legacy.md` backup and preserves manually maintained trailing sections.

## Evolution Triggers

Evolution uses `--use-llm never` automatically and receives only `已归档反馈.md`.

It runs when:

1. `bug close` successfully archives or defers a Bug.
2. The Agent runs `bug evolve` due to an explicit keyword.
3. The `report` phase task attempts `complete` and the closed-only input fingerprint differs from the last successful run.

Repeated runs with the same fingerprint skip. An automatic trigger never enables an external LLM.

## Report Completion Gate

Before the existing task-completion mutation for phase `report`, the CLI requires:

1. Every `in_scope=true` Bug has `verification_status=已归档|延后`.
2. `docs/retrospective/evolution.json` is not pending.
3. Dirty closed feedback has successfully evolved.
4. The Evolver report is a readable, non-empty regular file inside the project root.
5. The existing Bug HTML report artifact remains readable.
6. Existing task verification and DoD evidence gates still pass.

Malformed ledgers, missing retrospective import, or unknown statuses fail closed with machine-readable error codes.

## Dynamic Context Injection

The shared four-stage model maps to Bugfix phases:

| Bugfix phase | Evolver stage |
|---|---|
| `orient`, `intake`, `impact` | `REQUIREMENT` |
| `reproduce`, `verify`, `report` | `TESTING` |
| `root-cause`, `fix-plan`, `fix`, `reconcile` | `CODING` |

Target-path database hints may override a phase to `DATABASE`. `next`, `context`, `resume`, and `phase start` inject at most eight rules and three cases within the existing bounded context.

## Installation And Upgrade

New projects copy both `dot-agent/` and `harness_evolver/`. Install reports whether Evolver is present and always injects `FEEDBACK-PROTOCOL.md`.

Upgrades may replace committed implementation/tests/docs, but must preserve:

- `.agent/bugs.json`, `.agent/bugs/`, reports, task memory, process configuration, and hooks.
- `docs/retrospective/` project-learning files.
- `harness_evolver/state`, `knowledge_base`, `history`, `reports`, and project `config.json`.

## Safety

- Use exclusive owner-token locks and atomic replacement for `bugs.json`, retrospective facts, generated Markdown, and evolution state.
- Validate every loaded Bug and retrospective record before gate decisions.
- Redact Bearer/JWT/OpenAI/GitHub/AWS/Google/Slack tokens, PEM private keys, password-like values, and phone numbers before persistence or transmission.
- Never infer root cause, verification success, or closure from a keyword.
- Accept an evolution report only when it is a readable, non-empty regular file inside the project root.
- Preserve source status separately from verification status.

## Verification

Affected tests must prove:

- concrete-signal detection plus quoted/negated/hypothetical exclusions;
- `bug add` ID allocation, deduplication, redaction, and terminal recurrence reopening;
- imported Bug backward compatibility;
- `bug close` rejection for every missing artifact and acceptance with complete evidence;
- retrospective projection contains verified root cause and links to the operational Bug;
- close-time offline evolution, fingerprint skip, and pending recovery;
- report completion blocks open Bugs, malformed ledgers, missing reports, and pending evolution;
- all 10 phase dependency, impact-check, precheck, task-memory, board, and existing report tests remain green;
- clean installation preserves Bugfix-specific commands and automatically injects the protocol and phase-specific Evolver context.
