# OpenAI Provider

`@council-of-experts/openai-provider` exposes an OpenAI-compatible API surface backed by the `council-of-experts` runtime.

Each exposed `model` is a virtual model profile. Internally, every request is executed as an ephemeral `oracle`-mode council turn.

## Features

- `GET /health`
- `GET /v1/models`
- `POST /v1/chat/completions`
- per-agent local document access via `vault.read(path)`
- OpenAI-style tool calling on the final outward oracle step
- `GET /debug/status` when `debug.enabled` is `true`
- `GET /debug/config` when `debug.enabled` is `true`
- `GET /debug/running` when `debug.enabled` is `true`
- `GET /debug/requests` when `debug.enabled` is `true`
- `GET /debug/requests/:id` when `debug.enabled` is `true`

## Limitations

- only `oracle` mode is used
- the service is stateless per request
- `stream: true` is not supported
- debug mode exposes private deliberation, raw prompts, request payloads, and internal records

## Configuration

Use a JSON config file such as [config.example.json](./config.example.json).

### Model Profiles

Each virtual model contains its own inline agent definitions plus an explicit `synthesizerAgentId` for the outward oracle step. Agent engines must declare `provider`, `model`, `contextWindow`, `charsPerToken`, and `timeoutMs`; they may also declare `promptBudgetRatio` and `promptSummaryPolicy`.

Incoming OpenAI `messages[]` are forwarded as structured chat history into the shared core prompt packer. The provider still stores a debug transcript in traces for inspection, but that transcript is no longer the actual prompt payload sent upstream.

The agent named by `synthesizerAgentId` is the outward oracle synthesizer. If the final answer needs direct document access, assign the relevant `documents` to that agent.

`virtualModels.<id>.councilPrompts` can override the embedded core library's built-in council/oracle workflow templates for that virtual model.

### Documents

Agents can also declare `documents`, resolved relative to the config file. When an agent has assigned documents, the provider exposes one internal local tool to that agent:

- `vault.read(path)` reads one of that agent's declared documents by exact path

`vault.read(path)` returns the full assigned document content. The provider does not truncate or summarize documents; assign only documents that fit the agent's prompt budget.

Those document reads are provider-local. They are not exposed as OpenAI client `tool_calls`.

### Prompt Budgeting

Top-level `prompts` can override the provider app's own request-mapping and oracle synthesis templates.

The adapter always packs prompts using `promptBudgetRatio`, which defaults to the exported `DEFAULT_PROMPT_BUDGET_RATIO`; that ratio is used for prompt construction and the remainder is reserved for response/tool flow. `promptSummaryPolicy` makes the summary compaction heuristics explicit, and the effective packing policy is exposed under `metadata.tokenEstimate.promptPack`.

If the outward oracle cannot fit its fixed inputs into that budget, the provider returns the configured `fallbacks.agentContextExhaustedMessage`.

### Debug And Limits

When debug mode is enabled, debug endpoints expose the resolved config, recent request traces, private deliberation, local `vault.read` activity, and final synthesis output.
Those traces include approximate token estimates in engine output metadata.

The provider also makes its operational limits explicit:

- `debug.traceRetention` controls how many completed traces are kept in memory
- `limits.requestBodyBytes` controls the maximum accepted JSON body size
- `fallbacks.agentContextExhaustedMessage` controls the assistant fallback returned for `agent_context_exhausted`

## Run

From the repository root:

```bash
npm run build
node packages/openai-provider/dist/index.js packages/openai-provider/config.example.json
```
