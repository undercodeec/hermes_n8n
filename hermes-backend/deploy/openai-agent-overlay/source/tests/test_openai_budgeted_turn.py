import sys
import types
import unittest
from decimal import Decimal
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from agent.provider_budget import BudgetAbort, BudgetPolicy, scoped_budget, enforce_openai_budget
from agent.openai_budgeted_turn import run_text_turn


def policy():
    return BudgetPolicy.from_config(dict(model="gpt-6-luna", max_calls=1,
        max_input_bytes=1000, max_input_tokens=4000, max_output_tokens=100,
        max_estimated_usd="1", input_usd_per_million="1", output_usd_per_million="1"))


class Client:
    calls = []
    def __init__(self, **kwargs):
        self.options = kwargs
        self.chat = types.SimpleNamespace(completions=self)
    def __enter__(self): return self
    def __exit__(self, *args): pass
    def create(self, **kwargs):
        self.calls.append((self.options, kwargs))
        message = types.SimpleNamespace(content='{"replyText":"ok"}', tool_calls=None, function_call=None, refusal=None)
        return types.SimpleNamespace(choices=[types.SimpleNamespace(finish_reason="stop", message=message)],
            usage=types.SimpleNamespace(prompt_tokens=10, completion_tokens=3))


class Http:
    def __init__(self, **kwargs): self.options = kwargs
    def __enter__(self): return self
    def __exit__(self, *args): pass


class TurnTests(unittest.TestCase):
    def setUp(self):
        Client.calls = []
        self.policy = policy()
        self.agent = types.SimpleNamespace(provider="openai-api", model="gpt-6-luna",
            api_mode="chat_completions", base_url="https://api.openai.com/v1", api_key="fake", _fallback_chain=[],
            ephemeral_system_prompt="CRM policy", _build_system_prompt=lambda msg: "constructed " + (msg or ""),
            _provider_budget=self.policy)
        marker = patch("agent.provider_budget.deployment_budget_required", return_value=True)
        marker.start()
        self.addCleanup(marker.stop)
        self.modules = patch.dict(sys.modules, {"httpx": types.SimpleNamespace(Client=Http),
                                                "openai": types.SimpleNamespace(OpenAI=Client)})
        self.modules.start()
        self.addCleanup(self.modules.stop)

    def test_text_and_irrevocable_limit(self):
        with scoped_budget(self.policy) as ledger:
            result = run_text_turn(self.agent, ledger, "hello", None, [])
            self.assertEqual(result["final_response"], '{"replyText":"ok"}')
            options, request = Client.calls[0]
            self.assertEqual(options["max_retries"], 0)
            self.assertFalse(options["http_client"].options["trust_env"])
            self.assertEqual(request["max_completion_tokens"], 100)
            self.assertEqual(request["messages"][0]["content"], "constructed \n\nCRM policy")
            self.assertFalse(result["agent_persisted"])
            self.assertEqual(result["messages"], [{"role": "user", "content": "hello"},
                                                  {"role": "assistant", "content": '{"replyText":"ok"}'}])
            self.assertEqual(ledger.calls, 1)
            with self.assertRaises(BudgetAbort):
                run_text_turn(self.agent, ledger, "hello", None, [])
            self.assertEqual(len(Client.calls), 1)

    def test_unsupported_inputs_and_route_refused_before_dispatch(self):
        for kwargs in ({"stream_callback": lambda _: None}, {"moa_config": {}}, {"turn_author": {}}):
            with scoped_budget(self.policy) as ledger:
                with self.assertRaises(BudgetAbort):
                    run_text_turn(self.agent, ledger, "hi", None, [], **kwargs)
        with scoped_budget(self.policy) as ledger:
            with self.assertRaises(BudgetAbort):
                run_text_turn(self.agent, ledger, "hi", None, [{"role": "tool", "content": "x"}])
        self.agent.base_url = "https://evil.invalid/v1"
        with scoped_budget(self.policy) as ledger:
            with self.assertRaises(BudgetAbort):
                run_text_turn(self.agent, ledger, "hi", None, [])
        self.assertFalse(Client.calls)

    def test_gateway_author_id_and_prompt(self):
        with scoped_budget(self.policy) as ledger:
            result = run_text_turn(self.agent, ledger, "hi", "extra", [],
                turn_author={"id": "u", "name": None, "is_bot": False}, persist_user_platform_id="event-1")
        self.assertEqual(Client.calls[0][1]["messages"][0]["content"], "constructed extra\n\nCRM policy")
        self.assertEqual(result["messages"][0], {"role": "user", "content": "hi", "message_id": "event-1"})
        self.assertIs(result["agent_persisted"], False)

    def test_second_turn_preserves_history_but_sends_only_text(self):
        with scoped_budget(self.policy) as ledger:
            first = run_text_turn(self.agent, ledger, "first", None, [], persist_user_platform_id="msg-1")
        history = first["messages"]
        history[0].update(timestamp=1730000000.5, platform_message_id="msg-1", api_content="first on wire")
        history[1]["timestamp"] = "2026-11-25T12:00:00Z"
        snapshot = [m.copy() for m in history]
        with scoped_budget(self.policy) as ledger:
            second = run_text_turn(self.agent, ledger, "second", None, history,
                                   persist_user_platform_id="msg-2")
        self.assertEqual(history, snapshot)
        self.assertEqual(second["messages"][:2], snapshot)
        self.assertEqual(second["messages"][2]["message_id"], "msg-2")
        self.assertIs(second["agent_persisted"], False)
        self.assertEqual(Client.calls[1][1]["messages"][1:], [
            {"role": "user", "content": "first on wire"}, {"role": "assistant", "content": '{"replyText":"ok"}'},
            {"role": "user", "content": "second"}])

    def test_history_media_tools_and_unknown_fields_are_rejected(self):
        bad = [
            {"role": "user", "content": [{"type": "image_url", "image_url": {"url": "x"}}]},
            {"role": "tool", "content": "data"},
            {"role": "assistant", "content": "text", "tool_calls": []},
            {"role": "assistant", "content": "text", "function_call": None},
            {"role": "user", "content": "text", "attachment": "file"},
            {"role": "user", "content": "text", "api_content": [{"type": "text", "text": "x"}]},
            {"role": "user", "content": "text", "timestamp": float("nan")},
        ]
        for row in bad:
            with self.subTest(row=row), scoped_budget(self.policy) as ledger:
                with self.assertRaises(BudgetAbort):
                    run_text_turn(self.agent, ledger, "next", None, [row])
                self.assertEqual(ledger.calls, 0)
        self.assertEqual(Client.calls, [])

    def test_openai_requires_marker_and_policy_without_affecting_gemini_gate(self):
        with patch("agent.provider_budget.deployment_budget_required", return_value=False):
            for configured in (self.policy, None):
                with self.assertRaises(BudgetAbort):
                    enforce_openai_budget("openai-api", "gpt-6-luna", configured)
            enforce_openai_budget("gemini", "gemini-example", None)
            with scoped_budget(self.policy) as ledger:
                with self.assertRaises(BudgetAbort):
                    run_text_turn(self.agent, ledger, "hi", None, [])
                self.assertEqual(ledger.calls, 0)
        with self.assertRaises(BudgetAbort):
            enforce_openai_budget("openai-api", "gpt-6-luna", None)
        with self.assertRaises(BudgetAbort):
            enforce_openai_budget("openai-api", "other", self.policy)
        with self.assertRaises(BudgetAbort):
            enforce_openai_budget("gemini", "gpt-6-luna", self.policy)
        with self.assertRaises(BudgetAbort):
            enforce_openai_budget("custom", "other", None, "https://api.openai.com/v1")
        with self.assertRaises(BudgetAbort):
            enforce_openai_budget("openai", "other", None)
        self.assertEqual(Client.calls, [])

    def test_marker_lost_before_sdk_dispatch_is_refused(self):
        with patch("agent.provider_budget.deployment_budget_required", side_effect=[True, False]):
            with scoped_budget(self.policy) as ledger:
                with self.assertRaises(BudgetAbort):
                    run_text_turn(self.agent, ledger, "hi", None, [])
                self.assertEqual(ledger.terminal_reason, "openai_budget_marker_missing")
        self.assertFalse(Client.calls)

    def test_missing_or_failed_prompt_never_dispatches(self):
        for ephemeral, builder in [(None, lambda _: "built"), ("  ", lambda _: "built"),
                                   ("policy", lambda _: ""),
                                   ("policy", lambda _: (_ for _ in ()).throw(RuntimeError()))]:
            self.agent.ephemeral_system_prompt = ephemeral
            self.agent._build_system_prompt = builder
            with scoped_budget(self.policy) as ledger:
                with self.assertRaises(BudgetAbort):
                    run_text_turn(self.agent, ledger, "hi", None, [])
                self.assertEqual(ledger.calls, 0)
        self.assertFalse(Client.calls)

    def test_empty_response_fails_before_gateway_false_flag_can_be_lost(self):
        message = types.SimpleNamespace(content=" ", tool_calls=None, function_call=None, refusal=None)
        result = types.SimpleNamespace(choices=[types.SimpleNamespace(finish_reason="stop", message=message)])
        with patch.object(Client, "create", return_value=result):
            with scoped_budget(self.policy) as ledger:
                with self.assertRaises(BudgetAbort):
                    run_text_turn(self.agent, ledger, "hi", None, [])

    def test_non_object_json_and_invalid_json_fail_closed(self):
        for content in ("not json", "[]", "null"):
            message = types.SimpleNamespace(content=content, tool_calls=None, function_call=None, refusal=None)
            result = types.SimpleNamespace(
                choices=[types.SimpleNamespace(finish_reason="stop", message=message)],
                usage=types.SimpleNamespace(prompt_tokens=10, completion_tokens=3))
            with self.subTest(content=content), patch.object(Client, "create", return_value=result):
                with scoped_budget(self.policy) as ledger:
                    with self.assertRaises(BudgetAbort):
                        run_text_turn(self.agent, ledger, "hi", None, [])
                    self.assertEqual(ledger.terminal_reason, "invalid_json_response")

    def test_missing_usage_fails_closed(self):
        message = types.SimpleNamespace(content='{"replyText":"ok"}', tool_calls=None,
                                        function_call=None, refusal=None)
        result = types.SimpleNamespace(
            choices=[types.SimpleNamespace(finish_reason="stop", message=message)], usage=None)
        with patch.object(Client, "create", return_value=result), scoped_budget(self.policy) as ledger:
            with self.assertRaises(BudgetAbort):
                run_text_turn(self.agent, ledger, "hi", None, [])
            self.assertEqual(ledger.terminal_reason, "invalid_response")

    def test_nonstop_and_transport_fail_terminal(self):
        with patch.object(Client, "create", side_effect=RuntimeError("offline")):
            with scoped_budget(self.policy) as ledger:
                with self.assertRaises(RuntimeError):
                    run_text_turn(self.agent, ledger, "hi", None, [])
                self.assertEqual(ledger.terminal_reason, "transport_ambiguous")
                with self.assertRaises(BudgetAbort):
                    run_text_turn(self.agent, ledger, "hi", None, [])

    def test_oversized_input_and_bad_finish_fail_closed(self):
        with scoped_budget(self.policy) as ledger:
            with self.assertRaises(BudgetAbort):
                run_text_turn(self.agent, ledger, "x" * 2000, None, [])
            self.assertEqual(ledger.calls, 0)
        message = types.SimpleNamespace(content="partial", tool_calls=None, function_call=None, refusal=None)
        result = types.SimpleNamespace(choices=[types.SimpleNamespace(finish_reason="length", message=message)])
        with patch.object(Client, "create", return_value=result):
            with scoped_budget(self.policy) as ledger:
                with self.assertRaises(BudgetAbort):
                    run_text_turn(self.agent, ledger, "hi", None, [])
                self.assertEqual(ledger.terminal_reason, "invalid_response")


if __name__ == "__main__": unittest.main()
