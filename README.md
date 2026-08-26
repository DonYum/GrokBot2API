# GrokBot2API

Private sidecar that translates a Grok Bot inference entitlement into a
Grok CLI compatible Responses text API.

This repository is intentionally separate from Cursor2API. Grok Bot uses the
Cursor/Grok Bot `aiserver.v1.InferenceService/Stream` path and Grok Bot session
state. Cursor2API uses Cursor Dashboard keys and the Cursor SDK/AgentService
path. Keeping them separate makes rollback and credential boundaries clear.

## Current scope

P0 implements a text-only Grok CLI/Sub2API Grok-account sidecar. The current
Grok CLI 1.0.5 custom-model contract was verified locally: with
`api_backend = "responses"` it sends `POST /v1/responses`,
`Accept: text/event-stream`, and a Responses-shaped body with `input[]`,
`tools`, `reasoning`, `include`, and `prompt_cache_key`.

- `GET /health`
- `GET /v1/models` and `/models`
- `POST /v1/responses`, `/responses`, and `/backend-api/codex/responses`
- streaming SSE for text deltas and terminal `response.completed`
- non-streaming JSON Responses output
- real upstream usage propagation when present
- structured error mapping
- single in-flight request guard
- Bearer downstream key
- loopback bind by default
- credential loading from env/file, plus macOS Grok Bot Safe Storage for local
  development

It only claims Grok CLI text-stream compatibility. Tool-call round trip,
tool-result handling, cancellation, disconnect semantics, and long-running Linux
credential refresh are P1/P2 gates before treating it as a complete daily Grok
CLI backend.

## Run locally

```sh
cp .env.example .env
GROKBOT2API_KEY=local-dev-key node bin/grokbot2api.mjs
```

The service defaults to `127.0.0.1:8793`. Non-loopback bind is refused unless
`GROKBOT_ALLOW_PRIVATE_BIND=1` is set.

Request:

```sh
curl -sS -N http://127.0.0.1:8793/v1/responses \
  -H 'authorization: Bearer local-dev-key' \
  -H 'content-type: application/json' \
  -d '{"model":"grok-4.5","stream":true,"input":"Say ok."}'
```

Grok CLI local configuration:

```toml
[models]
default = "grokbot"

[model."grokbot"]
model = "grok-4.5"
base_url = "http://127.0.0.1:8793/v1"
api_key = "local-dev-key"
api_backend = "responses"
context_window = 1000000
```

## Credential providers

The sidecar reads credentials on every request and never writes credentials.

Provider order:

1. `GROKBOT_ACCESS_TOKEN` + `GROKBOT_MACHINE_ID`
2. `GROKBOT_CREDENTIALS_FILE`
3. macOS Grok Bot Safe Storage, only on Darwin

For `.212` Linux deployment, first validate a Linux Grok Bot runtime such as
`Nichokas/grokbot-linux-port` in an isolated directory. The important gate is not
whether this Node service can run on Linux; it can. The gate is whether Linux can
maintain Grok Bot access token, machine id, client headers, and refresh without
manual token copying. Until that is verified, deploy only for controlled testing.

## Safety defaults

- no key, prompt, body, or tool arguments are logged by this service;
- 401, 403, and 429 from upstream are hard stops;
- concurrent calls return `429 concurrency_limited`;
- request bodies are capped;
- upstream responses are capped;
- the default bind address is loopback only.

## Verification

```sh
npm run check
npm test
```
