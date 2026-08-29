from __future__ import annotations

from dataclasses import asdict, dataclass, field
from enum import Enum
import hashlib
import re
from typing import Any


class Stage(str, Enum):
    REQUIREMENT = "REQUIREMENT"
    DATABASE = "DATABASE"
    CODING = "CODING"
    TESTING = "TESTING"


STAGE_FILES = {
    Stage.REQUIREMENT: "stage1_requirements_checklist.md",
    Stage.DATABASE: "stage2_db_design_rules.md",
    Stage.CODING: "stage3_coding_guardrails.md",
    Stage.TESTING: "stage4_test_case_matrix.md",
}


@dataclass(slots=True)
class RawBug:
    bug_id: str
    title: str
    root_cause: str = ""
    resolution: str = ""
    impact: str = ""
    status: str = ""
    source_doc: str = ""
    source_line: int = 0

    @property
    def identity(self) -> str:
        return f"{self.source_doc}::{self.bug_id}"


@dataclass(slots=True)
class BugTrace:
    bug_id: str
    title: str
    stage_attribution: Stage
    failure_mode: str
    corrective_guideline: str
    root_cause: str = ""
    resolution: str = ""
    impact: str = ""
    source_doc: str = ""
    source_line: int = 0
    confidence: float = 0.0
    tech_stack: list[str] = field(default_factory=list)
    analysis_mode: str = "heuristic"

    @property
    def identity(self) -> str:
        return f"{self.source_doc}::{self.bug_id}"

    @property
    def content_digest(self) -> str:
        body = "\n".join(
            [
                self.bug_id,
                self.title,
                self.stage_attribution.value,
                self.failure_mode,
                self.corrective_guideline,
                self.root_cause,
            ]
        )
        return hashlib.sha256(body.encode("utf-8")).hexdigest()

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data["stage_attribution"] = self.stage_attribution.value
        return data

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "BugTrace":
        value = dict(data)
        value["stage_attribution"] = Stage(value["stage_attribution"])
        return cls(**value)


@dataclass(slots=True)
class EvolutionRule:
    rule_id: str
    stage: Stage
    failure_mode: str
    guideline: str
    bug_ids: list[str] = field(default_factory=list)
    sources: list[str] = field(default_factory=list)
    tech_stack: list[str] = field(default_factory=list)
    occurrences: int = 1
    confidence: float = 0.0

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data["stage"] = self.stage.value
        return data

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "EvolutionRule":
        value = dict(data)
        value["stage"] = Stage(value["stage"])
        return cls(**value)


def normalized_text(value: str) -> str:
    value = re.sub(r"[`*_#>|]", " ", value or "")
    value = re.sub(r"https?://\S+", " ", value)
    value = re.sub(r"\s+", " ", value).strip().lower()
    return value


def redact_sensitive_text(value: str) -> str:
    redacted = value or ""
    redacted = re.sub(
        r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----.*?-----END [A-Z0-9 ]*PRIVATE KEY-----",
        "[REDACTED PRIVATE KEY]",
        redacted,
        flags=re.DOTALL,
    )
    redacted = re.sub(r"(?i)\bBearer\s+[A-Za-z0-9._~+/-]+=*", "Bearer [REDACTED]", redacted)
    redacted = re.sub(r"(?i)\bsk-[A-Za-z0-9_-]{12,}", "sk-[REDACTED]", redacted)
    redacted = re.sub(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b", "[REDACTED JWT]", redacted)
    redacted = re.sub(r"\bgh[pousr]_[A-Za-z0-9]{16,}\b", "[REDACTED GITHUB TOKEN]", redacted)
    redacted = re.sub(r"\bgithub_pat_[A-Za-z0-9_]{20,}\b", "[REDACTED GITHUB TOKEN]", redacted)
    redacted = re.sub(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b", "[REDACTED AWS ACCESS KEY]", redacted)
    redacted = re.sub(r"\bAIza[A-Za-z0-9_-]{20,}\b", "[REDACTED GOOGLE API KEY]", redacted)
    redacted = re.sub(r"\bxox[baprs]-[A-Za-z0-9-]{16,}\b", "[REDACTED SLACK TOKEN]", redacted)
    redacted = re.sub(
        r"(?i)\b(api[_-]?key|access[_-]?token|secret|password|passwd)\s*[:=]\s*[^\s,;]+",
        lambda match: f"{match.group(1)}=[REDACTED]",
        redacted,
    )
    redacted = re.sub(
        r"(?<!\d)(1[3-9]\d)(\d{4})(\d{4})(?!\d)",
        lambda match: f"{match.group(1)}****{match.group(3)}",
        redacted,
    )
    return redacted


def text_tokens(value: str) -> set[str]:
    normalized = normalized_text(value)
    latin = set(re.findall(r"[a-z0-9_.:+/-]{2,}", normalized))
    chinese_blocks = re.findall(r"[\u4e00-\u9fff]+", normalized)
    chinese: set[str] = set()
    for block in chinese_blocks:
        if len(block) == 1:
            chinese.add(block)
        else:
            chinese.update(block[index : index + 2] for index in range(len(block) - 1))
    return latin | chinese


def stable_rule_id(stage: Stage, guideline: str) -> str:
    digest = hashlib.sha1(normalized_text(guideline).encode("utf-8")).hexdigest()[:10]
    return f"EVR-{stage.value[:3]}-{digest}"
