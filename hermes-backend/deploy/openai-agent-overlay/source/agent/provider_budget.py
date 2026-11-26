"""Per-turn, pre-dispatch budget for the isolated Hermes Gemini API deployment.

No provider cancellation or refund is assumed after a dispatch, including a local timeout.
The context is copied into Hermes' API worker threads by chat_completion_helpers.
"""

from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from decimal import Decimal
import json
import logging
from pathlib import Path
import threading
import time
from typing import Any
from urllib.parse import urlparse

logger = logging.getLogger(__name__)
_current: ContextVar["BudgetLedger | None"] = ContextVar("provider_budget", default=None)
_REQUIRED_MARKER = Path("/etc/hermes/a7-d8-budget-required")


def deployment_budget_required() -> bool:
    """The overlay image must fail closed if its config mount is lost."""
    return _REQUIRED_MARKER.exists()


class BudgetAbort(Exception):
    """Terminal refusal: callers must never turn this into assistant text."""


def enforce_openai_budget(provider: Any, model: Any, policy: Any, base_url: Any = None) -> None:
    """This overlay never permits an unguarded OpenAI API route, even without its marker."""
    try:
        official_host = (urlparse(str(base_url or "")).hostname or "").lower() == "api.openai.com"
    except ValueError:
        official_host = False
    if provider in ("openai", "openai-api") or model == "gpt-6-luna" or official_host:
        if not deployment_budget_required():
            raise BudgetAbort("openai_budget_marker_missing")
        if (provider != "openai-api" or model != "gpt-6-luna"
                or not isinstance(policy, BudgetPolicy) or policy.model != model):
            raise BudgetAbort("openai_budget_policy_missing_or_route_mismatch")


def _positive_int(value: Any, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise ValueError(f"agent.provider_budget.{name} must be a positive integer")
    return value


@dataclass(frozen=True)
class BudgetPolicy:
    model: str
    max_calls: int
    max_input_bytes: int
    max_input_tokens: int
    max_output_tokens: int
    max_estimated_usd: Decimal
    input_usd_per_million: Decimal
    output_usd_per_million: Decimal

    @classmethod
    def from_config(cls, raw: Any) -> "BudgetPolicy":
        if not isinstance(raw, dict):
            raise ValueError("agent.provider_budget must be a mapping")
        model = raw.get("model")
        if not isinstance(model, str) or not (model.startswith("gemini-") or model == "gpt-6-luna"):
            raise ValueError("agent.provider_budget.model must be a supported model")
        allowed = set(cls.__dataclass_fields__)
        if set(raw) != allowed:
            raise ValueError(f"agent.provider_budget keys must be exactly {sorted(allowed)}")
        ints = {k: _positive_int(raw[k], k) for k in
                ("max_calls", "max_input_bytes", "max_input_tokens", "max_output_tokens")}
        amounts = {}
        for key in ("max_estimated_usd", "input_usd_per_million", "output_usd_per_million"):
            try:
                amounts[key] = Decimal(str(raw[key]))
            except Exception as exc:
                raise ValueError(f"agent.provider_budget.{key} is invalid") from exc
            if not amounts[key].is_finite() or amounts[key] <= 0:
                raise ValueError(f"agent.provider_budget.{key} must be positive and finite")
        policy = cls(model=model, **ints, **amounts)
        if policy.max_input_bytes * 4 > policy.max_input_tokens:
            raise ValueError("max_input_tokens must cover four tokens per UTF-8 request byte")
        if policy.max_calls * policy.call_ceiling(policy.max_input_tokens) > policy.max_estimated_usd:
            raise ValueError("configured worst-case calls exceed max_estimated_usd")
        return policy

    def call_ceiling(self, input_tokens: int) -> Decimal:
        return (Decimal(input_tokens) * self.input_usd_per_million
                + Decimal(self.max_output_tokens) * self.output_usd_per_million) / 1_000_000


def _is_text_only(request: dict) -> bool:
    if request.get("tools") or request.get("toolConfig"):
        return False
    groups = list(request.get("contents") or [])
    if request.get("systemInstruction"):
        groups.append(request["systemInstruction"])
    return all(isinstance(group, dict) and isinstance(group.get("parts"), list)
               and all(isinstance(part, dict) and isinstance(part.get("text"), str)
                       and set(part) == {"text"} for part in group["parts"])
               for group in groups)


@dataclass
class BudgetLedger:
    policy: BudgetPolicy
    calls: int = 0
    reserved_usd: Decimal = Decimal(0)
    known_input_tokens: int = 0
    known_output_tokens: int = 0
    known_thought_tokens: int = 0
    terminal_reason: str = ""
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def reserve(self, request: dict, model: str) -> int:
        with self._lock:
            reason = None
            if model != self.policy.model:
                reason = "model_mismatch"
            elif not _is_text_only(request):
                reason = "non_text_or_tools"
            elif request.get("generationConfig", {}).get("maxOutputTokens") != self.policy.max_output_tokens:
                reason = "output_cap_mismatch"
            body_bytes = len(json.dumps(request, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
            input_upper = body_bytes * 4  # includes framing; intentionally far above text tokenization
            if body_bytes > self.policy.max_input_bytes or input_upper > self.policy.max_input_tokens:
                reason = "input_limit"
            cost = self.policy.call_ceiling(input_upper)
            if self.calls >= self.policy.max_calls:
                reason = "call_limit"
            elif self.reserved_usd + cost > self.policy.max_estimated_usd:
                reason = "usd_limit"
            if reason:
                self.terminal_reason = reason
                logger.warning("provider_budget_reject reason=%s calls=%d input_upper=%d reserved_usd=%s",
                               reason, self.calls, input_upper, self.reserved_usd)
                raise BudgetAbort(reason)
            self.calls += 1  # irrevocable: timeout may continue at Google
            self.reserved_usd += cost
            logger.info("provider_budget_dispatch call=%d input_upper=%d output_cap=%d reserved_usd=%s",
                        self.calls, input_upper, self.policy.max_output_tokens, self.reserved_usd)
            return self.calls

    def finish(self, call: int, *, usage: dict | None, finish_reason: str, started: float, cause: str) -> None:
        usage = usage if isinstance(usage, dict) else {}
        with self._lock:
            if cause != "stop" and not self.terminal_reason:
                self.terminal_reason = cause
            self.known_input_tokens += int(usage.get("promptTokenCount") or 0)
            self.known_output_tokens += int(usage.get("candidatesTokenCount") or 0)
            self.known_thought_tokens += int(usage.get("thoughtsTokenCount") or 0)
            logger.info("provider_budget_finish call=%d cause=%s finish_reason=%s latency_ms=%d "
                        "known_input=%d known_output=%d known_thought=%d reserved_usd=%s",
                        call, cause, finish_reason or "unknown", int((time.monotonic() - started) * 1000),
                        self.known_input_tokens, self.known_output_tokens, self.known_thought_tokens,
                        self.reserved_usd)


def current_budget() -> BudgetLedger | None:
    return _current.get()


@contextmanager
def scoped_budget(policy: BudgetPolicy | None):
    if policy is None:
        yield None
        return
    ledger = BudgetLedger(policy)
    token = _current.set(ledger)
    try:
        yield ledger
    finally:
        logger.info("provider_budget_end calls=%d reserved_usd=%s known_input=%d known_output=%d known_thought=%d",
                    ledger.calls, ledger.reserved_usd, ledger.known_input_tokens,
                    ledger.known_output_tokens, ledger.known_thought_tokens)
        _current.reset(token)
