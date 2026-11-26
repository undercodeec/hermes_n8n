"""Isolated, text-only OpenAI turn. No agent loop, tools, retries or auxiliary calls.

This deliberately does not implement session persistence, streaming, compression,
or the regular agent's system prompt/tool machinery. Unsupported inputs fail closed.
The configured per-turn prices are operator-supplied, not a monthly spend limit.
"""
import json
import math

from agent.provider_budget import BudgetAbort, current_budget, enforce_openai_budget


def _reject(ledger, reason):
    with ledger._lock:
        ledger.terminal_reason = ledger.terminal_reason or reason
    raise BudgetAbort(reason)


def run_text_turn(agent, ledger, user_message, system_message, history, **options):
    if current_budget() is not ledger or ledger.policy.model != "gpt-6-luna":
        _reject(ledger, "invalid_budget_scope")
    try:
        enforce_openai_budget(getattr(agent, "provider", None), getattr(agent, "model", None),
                              getattr(agent, "_provider_budget", None), getattr(agent, "base_url", None))
    except BudgetAbort as exc:
        _reject(ledger, str(exc))
    if agent._provider_budget is not ledger.policy:
        _reject(ledger, "budget_scope_policy_mismatch")
    if (getattr(agent, "provider", None) != "openai-api"
            or getattr(agent, "model", None) != ledger.policy.model
            or getattr(agent, "api_mode", None) != "chat_completions"
            or str(getattr(agent, "base_url", "") or "").rstrip("/") != "https://api.openai.com/v1"
            or getattr(agent, "_fallback_chain", None)):
        _reject(ledger, "route_mismatch")
    allowed_options = {"turn_author", "persist_user_platform_id", "stream_callback", "moa_config",
                       "persist_user_message", "persist_user_timestamp", "persist_user_display_kind",
                       "persist_user_display_metadata"}
    if set(options) - allowed_options:
        _reject(ledger, "unsupported_turn_options")
    # Author is consumed only by the omitted memory pipeline; never use it to
    # authorize memory writes. The gateway owns transcript writes on this route.
    author = options.get("turn_author")
    if author is not None and (not isinstance(author, dict)
            or set(author) != {"id", "name", "is_bot"}
            or type(author["is_bot"]) is not bool
            or any(author[k] is not None and not isinstance(author[k], str) for k in ("id", "name"))):
        _reject(ledger, "invalid_turn_author")
    platform_id = options.get("persist_user_platform_id")
    if platform_id is not None and (not isinstance(platform_id, str) or not platform_id):
        _reject(ledger, "invalid_platform_id")
    if any(options.get(key) is not None for key in allowed_options - {"turn_author", "persist_user_platform_id"}):
        _reject(ledger, "unsupported_turn_options")
    if not isinstance(user_message, str) or (system_message is not None and not isinstance(system_message, str)):
        _reject(ledger, "non_text_input")
    if history is None:
        history = []
    if not isinstance(history, list):
        _reject(ledger, "unsupported_history")
    wire_history = []
    for message in history:
        # Unknown keys (including tool/function calls and provider-specific media)
        # are refused, not silently stripped. api_content is the gateway's textual
        # replay sidecar and has the same precedence as build_api_messages.
        allowed = {"role", "content", "timestamp", "message_id", "platform_message_id", "_row_id", "api_content"}
        if (not isinstance(message, dict) or set(message) - allowed
                or message.get("role") not in ("user", "assistant")
                or not isinstance(message.get("content"), str)):
            _reject(ledger, "unsupported_history")
        sidecar = message.get("api_content")
        if sidecar is not None and not isinstance(sidecar, str):
            _reject(ledger, "unsupported_history")
        for field in ("timestamp", "message_id", "platform_message_id", "_row_id"):
            value = message.get(field)
            if value is not None and (type(value) not in (str, int, float) or
                                      (isinstance(value, float) and not math.isfinite(value))):
                _reject(ledger, "unsupported_history")
        wire_history.append({"role": message["role"], "content": sidecar or message["content"]})
    # Build through the real agent constructor, then append the per-turn CRM
    # instructions exactly as turn_context.build_api_messages does. Never dispatch
    # when either part is missing or the builder fails.
    ephemeral = getattr(agent, "ephemeral_system_prompt", None)
    if not isinstance(ephemeral, str) or not ephemeral.strip():
        _reject(ledger, "missing_ephemeral_system_prompt")
    try:
        built = agent._build_system_prompt(system_message)
    except Exception:
        _reject(ledger, "system_prompt_build_failed")
    if not isinstance(built, str) or not built.strip():
        _reject(ledger, "missing_built_system_prompt")
    effective_system = (built + "\n\n" + ephemeral).strip()
    transcript = [dict(m) for m in history] + [{"role": "user", "content": user_message}]
    if platform_id is not None:
        transcript[-1]["message_id"] = platform_id
    messages = [{"role": "system", "content": effective_system}] + wire_history + [
        {"role": "user", "content": user_message}]
    request = {"model": ledger.policy.model, "messages": messages,
               "max_completion_tokens": ledger.policy.max_output_tokens, "stream": False, "n": 1}
    try:
        size = len(json.dumps(request, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8"))
    except (TypeError, ValueError, UnicodeError, OverflowError):
        _reject(ledger, "invalid_request")
    with ledger._lock:
        reason = ledger.terminal_reason
        upper = size * 4
        cost = ledger.policy.call_ceiling(upper)
        if not reason and (size > ledger.policy.max_input_bytes or upper > ledger.policy.max_input_tokens):
            reason = "input_limit"
        if not reason and ledger.calls >= ledger.policy.max_calls:
            reason = "call_limit"
        if not reason and ledger.reserved_usd + cost > ledger.policy.max_estimated_usd:
            reason = "usd_limit"
        if reason:
            ledger.terminal_reason = reason
            raise BudgetAbort(reason)
        ledger.calls += 1
        ledger.reserved_usd += cost
    try:
        import httpx
        from openai import OpenAI
        # No environment proxies or SDK retries; the endpoint cannot be overridden.
        with httpx.Client(trust_env=False, follow_redirects=False, timeout=60.0) as http:
            with OpenAI(api_key=agent.api_key, base_url="https://api.openai.com/v1",
                        max_retries=0, http_client=http) as client:
                try:
                    enforce_openai_budget(getattr(agent, "provider", None), getattr(agent, "model", None),
                                          getattr(agent, "_provider_budget", None), getattr(agent, "base_url", None))
                except BudgetAbort as exc:
                    _reject(ledger, str(exc))
                if agent._provider_budget is not ledger.policy:
                    _reject(ledger, "budget_scope_policy_mismatch")
                response = client.chat.completions.create(**request)
    except BaseException:
        with ledger._lock:
            ledger.terminal_reason = ledger.terminal_reason or "transport_ambiguous"
        raise
    try:
        if (len(response.choices) != 1 or response.choices[0].finish_reason != "stop"
                or not isinstance(response.choices[0].message.content, str)
                or not response.choices[0].message.content.strip()
                or getattr(response.choices[0].message, "tool_calls", None)
                or getattr(response.choices[0].message, "function_call", None)
                or getattr(response.choices[0].message, "refusal", None)):
            _reject(ledger, "invalid_response")
        usage = response.usage
        if (type(usage.prompt_tokens) is not int or not 0 <= usage.prompt_tokens <= ledger.policy.max_input_tokens
                or type(usage.completion_tokens) is not int
                or not 0 <= usage.completion_tokens <= ledger.policy.max_output_tokens):
            _reject(ledger, "invalid_usage")
        content = response.choices[0].message.content
        try:
            if not isinstance(json.loads(content), dict):
                _reject(ledger, "invalid_json_response")
        except (ValueError, TypeError):
            _reject(ledger, "invalid_json_response")
    except (AttributeError, TypeError, IndexError):
        _reject(ledger, "invalid_response")
    return {"final_response": content, "messages": transcript + [{"role": "assistant", "content": content}],
            "api_calls": 1, "completed": True, "agent_persisted": False}
