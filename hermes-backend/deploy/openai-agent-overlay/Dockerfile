# Builds the agent, not the NestJS backend. Source is the verified A7-D8 overlay.
# Do not publish before the OpenAI guard implementation and tests are reviewed.
FROM nousresearch/hermes-agent@sha256:99641e57ec762c59e54cb44aa6746b7fc68c18b3c5ddb088af54234c613d9294

ARG PATCH_REVISION
LABEL org.opencontainers.image.revision="${PATCH_REVISION}" \
      org.opencontainers.image.base.digest="sha256:99641e57ec762c59e54cb44aa6746b7fc68c18b3c5ddb088af54234c613d9294" \
      io.undercode.hermes.component="agent"

COPY --chown=root:root deploy/openai-agent-overlay/UPSTREAM-LICENSE /opt/hermes/LICENSE
COPY --chown=root:root deploy/openai-agent-overlay/source/agent/agent_init.py /opt/hermes/agent/agent_init.py
COPY --chown=root:root deploy/openai-agent-overlay/source/agent/gemini_native_adapter.py /opt/hermes/agent/gemini_native_adapter.py
COPY --chown=root:root deploy/openai-agent-overlay/source/agent/provider_budget.py /opt/hermes/agent/provider_budget.py
COPY --chown=root:root deploy/openai-agent-overlay/source/agent/openai_budgeted_turn.py /opt/hermes/agent/openai_budgeted_turn.py
COPY --chown=root:root deploy/openai-agent-overlay/source/agent/transports/chat_completions.py /opt/hermes/agent/transports/chat_completions.py
COPY --chown=root:root deploy/openai-agent-overlay/source/agent/turn_facade.py /opt/hermes/agent/turn_facade.py
COPY --chown=root:root deploy/openai-agent-overlay/source/agent/chat_completion_helpers.py /opt/hermes/agent/chat_completion_helpers.py
COPY --chown=root:root deploy/openai-agent-overlay/source/agent/auxiliary_client.py /opt/hermes/agent/auxiliary_client.py
COPY --chown=root:root deploy/openai-agent-overlay/source/agent/codex_runtime.py /opt/hermes/agent/codex_runtime.py
COPY --chown=root:root deploy/openai-agent-overlay/source/gateway/platforms/api_server.py /opt/hermes/gateway/platforms/api_server.py

RUN /opt/hermes/.venv/bin/python3 -m py_compile \
      /opt/hermes/agent/agent_init.py \
      /opt/hermes/agent/gemini_native_adapter.py \
      /opt/hermes/agent/provider_budget.py \
      /opt/hermes/agent/openai_budgeted_turn.py \
      /opt/hermes/agent/transports/chat_completions.py \
      /opt/hermes/agent/turn_facade.py \
      /opt/hermes/agent/chat_completion_helpers.py \
      /opt/hermes/agent/auxiliary_client.py \
      /opt/hermes/agent/codex_runtime.py \
      /opt/hermes/gateway/platforms/api_server.py \
 && PATCH_REVISION="${PATCH_REVISION}" /opt/hermes/.venv/bin/python3 -c 'import json,os,pathlib; p=pathlib.Path("/etc/hermes/image-provenance.json"); d=json.loads(p.read_text()); d["base_revision"]=d.get("revision"); d["revision"]=os.environ["PATCH_REVISION"]; d["patch_id"]="HERMES_AGENT_OPENAI"; p.chmod(0o644); p.write_text(json.dumps(d,sort_keys=True,separators=(",",":"))+"\n"); p.chmod(0o444)' \
 && touch /etc/hermes/a7-d8-budget-required \
 && chmod 0444 /etc/hermes/a7-d8-budget-required
