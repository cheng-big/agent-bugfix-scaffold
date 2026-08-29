# Bugfix Harness Evolver Implementation Plan

> **For agentic workers:** Execute inline on `codex/bugfix-harness-evolver`. Use test-first changes and preserve all Bugfix-specific workflow behavior.

**Goal:** Add automatic Bug capture, verified retrospective archival, offline evolution, dynamic rule injection, and report completion gates to the Bugfix Harness.

**Architecture:** Port the proven standard-library Python Evolver as a second installable unit. Keep `.agent/bugs.json` as the operational queue, add focused Node modules for Bug capture and verified archival, and invoke Evolver only from closed retrospective facts. Integrate additively with the existing 10-stage CLI, impact-check, dependency gates, hooks, and report.

**Tech Stack:** Node.js ESM standard library, Python 3 standard library, JSON/JSONL/Markdown.

**Spec:** `docs/superpowers/specs/2026-08-29-bugfix-harness-evolver-design.md`

## Global Constraints

- Never overwrite `dot-agent/` wholesale from another scaffold.
- Preserve `impact-check`, precheck hooks, phase dependency enforcement, existing Bug import/report, task memory, and process template.
- Automatic evolution always uses `--use-llm never` and closed-only feedback.
- Terminal Bug state requires evidence-backed `bug close`.
- Project-learning files are committed; locks and task/process runtime remain ignored.

---

### Task 1: Shared Evolver And Bugfix Stage Injection

**Files:**
- Create: `harness_evolver/**`
- Create: `dot-agent/scripts/lib/evolver.mjs`
- Create: `dot-agent/scripts/evolver.test.mjs`
- Modify: `dot-agent/scripts/lib/context.mjs`
- Modify: `dot-agent/scripts/agent.mjs`

**Interfaces:**
- Python: `python3 -m harness_evolver.evolve --input-docs <closed-feedback.md>`
- Node: `buildEvolutionContext({ phaseId, action, targetPath, techStack, root }): string`
- Mapping: orient/intake/impact -> REQUIREMENT; reproduce/verify/report -> TESTING; root-cause/fix-plan/fix/reconcile -> CODING.

- [x] Write a failing Node bridge test for bounded `root-cause` injection and optional absence.
- [x] Run the focused test and verify the module-not-found failure.
- [x] Copy the reviewed Python package and add Bugfix phase mappings without changing project knowledge semantics.
- [x] Implement the timeout-bounded Node bridge and additive injection into `next/context/resume/phase start` while retaining phase dependency checks.
- [x] Run Node bridge and Python tests.

### Task 2: Operational Bug Auto-Capture

**Files:**
- Create: `dot-agent/scripts/lib/bugcapture.mjs`
- Create: `dot-agent/scripts/learning.test.mjs`
- Modify: `dot-agent/schemas/bug.schema.json`
- Modify: `dot-agent/scripts/lib/store.mjs`

**Interfaces:**
- `classifyBugSignal(text): Detection`
- `loadBugLedger(root): BugRecord[]`
- `addOperationalBug({ root, source, title, actual, repro, expected, evidence, phaseId, taskId }): { bug, duplicate, reopened }`
- `updateOperationalBug({ root, id, verificationStatus, evidence }): BugRecord`

- [x] Write failing tests for concrete/quoted/negated/hypothetical signals, ID allocation, import compatibility, redaction, duplicate suppression, and terminal recurrence reopening.
- [x] Verify failure because `bugcapture.mjs` is absent.
- [x] Implement schema-compatible locked atomic mutation of `.agent/bugs.json`, source/verification status separation, fingerprints, bounded closure history, and secret/phone redaction.
- [x] Run focused capture tests.

### Task 3: Evidence-Backed Close, Retrospective, And Evolution Gate

**Files:**
- Create: `dot-agent/scripts/lib/retrospective.mjs`
- Create: `dot-agent/scripts/lib/evolution-gate.mjs`
- Extend: `dot-agent/scripts/learning.test.mjs`

**Interfaces:**
- `closeOperationalBug({ root, id, status, resolution }): ClosedBug`
- `archiveBugFeedback({ root, bug, artifacts }): RetrospectiveRecord`
- `runBugfixEvolution({ root, reason, force, spawn }): EvolutionResult`
- `assertReportCompletionGate({ root, phaseId, spawn }): EvolutionResult`

- [x] Write failing tests for each missing close artifact, successful closure, retrospective linkage, closed-only input, offline subprocess args, unchanged skip, failed pending state, report containment, and report-phase blocking.
- [x] Verify failures because retrospective/gate modules are absent.
- [x] Implement artifact readback, deterministic projections, owner-token locks, atomic state, relative report validation, and report completion enforcement.
- [x] Run focused closure/gate tests.

### Task 4: CLI, Always-Injected Protocol, Install/Upgrade Docs

**Files:**
- Create: `dot-agent/FEEDBACK-PROTOCOL.md`
- Modify: `dot-agent/scripts/agent.mjs`
- Modify: `dot-agent/scripts/lib/context.mjs`
- Modify: `dot-agent/PROJECT.md.template`
- Modify: `dot-agent/README.md`
- Modify: `dot-agent/PORTING.md`
- Modify: `dot-agent/INSTALL-PROMPT.md`
- Modify: `dot-agent/UPGRADE-PROMPT.md`
- Modify: `README.md`
- Modify: `DESIGN.md`
- Extend: `dot-agent/scripts/learning.test.mjs`

**Interfaces:**
- CLI: `bug detect|add|import|list|update|close|evolve`
- `complete`: invokes report completion gate before existing task completion mutation.
- Protocol: automatic capture keywords plus explicit `记入 Bug|记入复盘|生成规则差异|项目复盘|进化脚手架`.

- [x] Write failing CLI tests for detect/add/update/close/evolve and machine-readable report-gate errors.
- [x] Integrate new Bug actions without regressing import/list, impact-check, precheck, report, or phase start.
- [x] Always inject the automatic protocol and document the active-session boundary.
- [x] Update two-unit install/upgrade instructions and exact test counts.
- [x] Run focused CLI tests.

### Task 5: Full Verification And Integration Exercise

**Files:**
- Update: `docs/superpowers/plans/2026-08-29-bugfix-harness-evolver-plan.md`

**Interfaces:** Clean source template and clean installed target.

- [x] Run all Node and Python tests plus syntax/diff/credential scans.
- [x] Install both units into a fresh temporary project.
- [x] Verify protocol injection, automatic BUG allocation, evidence-gated close, close-time evolution, fingerprint skip, recurrence reopening, and report-phase blocking.
- [x] Verify all 10 phase IDs still enforce dependencies and `impact-check`/precheck behavior remains green.
- [x] Request focused code review and resolve all Critical/Important findings.
