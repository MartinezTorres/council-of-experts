# OpenAI Provider

`@council-of-experts/openai-provider` exposes an OpenAI-compatible API surface backed by the `council-of-experts` runtime.

Each exposed `model` is a virtual model profile. Internally, every request is executed as an ephemeral `oracle`-mode council turn.

The first configured agent is used for the final outward oracle synthesis. Order agents accordingly.

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

Each virtual model contains its own inline agent definitions, including provider, model, context window, temperature, and prompt.

Agents can also declare `documents`, resolved relative to the config file. When an agent has assigned documents, the provider exposes one internal local tool to that agent:

- `vault.read(path)` reads one of that agent's declared documents by exact path

Those document reads are provider-local. They are not exposed as OpenAI client `tool_calls`.

## Run

From the repository root:

```bash
npm run build
node packages/openai-provider/dist/index.js packages/openai-provider/config.example.json
```
