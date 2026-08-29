from __future__ import annotations

import json
import os
import hashlib
from typing import Any
from urllib import error, request

from .models import RawBug, Stage


SYSTEM_PROMPT = """You are the root-cause mapper for a software-delivery Harness.
Map each downstream bug to exactly one upstream generation stage:
REQUIREMENT: requirement decomposition, states, roles, boundaries, page/API contracts.
DATABASE: DDL, indexes, keys, field sizes, audit columns, migrations, locking.
CODING: architecture and implementation patterns, transactions, errors, idempotency, SDKs, UI code.
TESTING: test strategy, mocks, boundary values, real-browser/device/runtime evidence.

Return a JSON array only. Every item must contain bug_id, stage_attribution,
failure_mode, corrective_guideline, confidence (0..1), and tech_stack (array).
The guideline must be an upstream defensive generation rule, not a description of the patch.
Do not invent facts absent from the bug input."""


class LLMMapper:
    def __init__(self) -> None:
        self.api_key = os.getenv("HARNESS_EVOLVER_API_KEY", "").strip()
        self.base_url = os.getenv("HARNESS_EVOLVER_BASE_URL", "https://api.openai.com/v1").rstrip("/")
        self.model = os.getenv("HARNESS_EVOLVER_MODEL", "").strip()
        self.timeout = int(os.getenv("HARNESS_EVOLVER_TIMEOUT", "60"))

    @property
    def configured(self) -> bool:
        return bool(self.api_key and self.model)

    @property
    def profile(self) -> str:
        prompt_digest = hashlib.sha256(SYSTEM_PROMPT.encode("utf-8")).hexdigest()[:12]
        return f"chat-completions:{self.base_url}:{self.model or '(unset)'}:{prompt_digest}"

    def map_batch(self, bugs: list[RawBug]) -> list[dict[str, Any]]:
        if not self.configured:
            raise RuntimeError("LLM mapper is not configured")
        payload = {
            "model": self.model,
            "temperature": 0,
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {
                    "role": "user",
                    "content": json.dumps(
                        [
                            {
                                "bug_id": bug.bug_id,
                                "title": bug.title,
                                "root_cause": bug.root_cause,
                                "resolution": bug.resolution,
                                "impact": bug.impact,
                            }
                            for bug in bugs
                        ],
                        ensure_ascii=False,
                    ),
                },
            ],
        }
        req = request.Request(
            f"{self.base_url}/chat/completions",
            data=json.dumps(payload).encode("utf-8"),
            headers={"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"},
            method="POST",
        )
        try:
            with request.urlopen(req, timeout=self.timeout) as response:
                body = json.loads(response.read().decode("utf-8"))
        except (error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            raise RuntimeError(f"LLM mapping failed: {type(exc).__name__}") from exc
        content = body["choices"][0]["message"]["content"].strip()
        if content.startswith("```"):
            content = content.split("\n", 1)[1].rsplit("```", 1)[0]
        result = json.loads(content)
        if not isinstance(result, list):
            raise RuntimeError("LLM mapping result must be a JSON array")
        valid_stages = {stage.value for stage in Stage}
        for item in result:
            if item.get("stage_attribution") not in valid_stages:
                raise RuntimeError("LLM mapping returned an invalid stage")
        return result
