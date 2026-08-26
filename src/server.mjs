import http from "node:http";
import { createCredentialProvider } from "./credentials.mjs";
import { AppError, errorFromUnknown } from "./errors.mjs";
import {
  json,
  jsonError,
  modelsResponse,
  nonStreamingResponse,
  normalizeResponsesRequest,
  PUBLIC_MODEL,
  ResponseSseWriter
} from "./openai.mjs";
import { modelList } from "./models.mjs";
import { GrokBotInferenceClient, usageFromState } from "./upstream.mjs";

export function createApp(config = {}) {
  const runtime = {
    publicModel: config.publicModel || process.env.GROKBOT_MODEL || PUBLIC_MODEL,
    key: config.key ?? process.env.GROKBOT2API_KEY ?? "",
    maxBodyBytes: config.maxBodyBytes || 1024 * 1024,
    credentialProvider: config.credentialProvider || createCredentialProvider(process.env),
    upstream: config.upstream || new GrokBotInferenceClient({
      backend: process.env.GROKBOT_BACKEND,
      upstreamModel: process.env.GROKBOT_UPSTREAM_MODEL || "grok-4.5",
      timeoutMs: Number.parseInt(process.env.GROKBOT_UPSTREAM_TIMEOUT_MS || "", 10) || 90_000
    }),
    active: false
  };

  return async function app(req, res) {
    try {
      if (req.method === "GET" && req.url === "/favicon.ico") {
        noContent(res);
        return;
      }
      if (req.method === "GET" && matchesPath(req.url, ["/", "/dashboard", "/v1"])) {
        html(res, 200, dashboardHtml(req, runtime));
        return;
      }
      if (req.method === "GET" && req.url === "/health") {
        json(res, 200, healthPayload(runtime));
        return;
      }
      if (req.method === "GET" && matchesPath(req.url, ["/v1/models", "/models"])) {
        requireAuth(req, runtime.key);
        json(res, 200, modelsResponse());
        return;
      }
      if (req.method === "POST" && matchesPath(req.url, ["/v1/responses", "/responses", "/backend-api/codex/responses"])) {
        requireAuth(req, runtime.key);
        await handleResponses(req, res, runtime);
        return;
      }
      jsonError(res, new AppError("not_found", "Not found", 404, "invalid_request_error"));
    } catch (error) {
      jsonError(res, error);
    }
  };
}

export function startServer(config = {}) {
  const host = config.host || process.env.HOST || "127.0.0.1";
  const port = config.port || Number.parseInt(process.env.PORT || "8793", 10);
  validateBind(host, process.env);
  const server = http.createServer(createApp(config));
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(server));
  });
}

async function handleResponses(req, res, runtime) {
  if (runtime.active) {
    throw new AppError("concurrency_limited", "Only one Grok Bot request may run at a time", 429, "rate_limit_error");
  }
  runtime.active = true;
  try {
    const body = await readJsonBody(req, runtime.maxBodyBytes);
    const request = normalizeResponsesRequest(body, { defaultModel: runtime.publicModel });
    const credentials = await runtime.credentialProvider.get();
    if (request.stream) {
      await streamResponse(res, runtime, request, credentials);
    } else {
      await jsonResponse(res, runtime, request, credentials);
    }
  } finally {
    runtime.active = false;
  }
}

async function streamResponse(res, runtime, request, credentials) {
  const writer = new ResponseSseWriter(res, request, request.model);
  writer.start();
  let finalState;
  try {
    for await (const event of runtime.upstream.stream(request, credentials)) {
      if (event.type === "text") writer.delta(event.text);
      if (event.type === "done") finalState = event.state;
    }
    if (!finalState) throw new AppError("upstream_missing_terminal", "Grok Bot upstream did not return a terminal frame", 502);
    writer.complete(usageFromState(finalState));
  } catch (error) {
    logStreamError(request, error);
    writer.fail(error);
  }
}

async function jsonResponse(res, runtime, request, credentials) {
  let text = "";
  let finalState;
  for await (const event of runtime.upstream.stream(request, credentials)) {
    if (event.type === "text") text += event.text;
    if (event.type === "done") finalState = event.state;
  }
  if (!finalState) throw new AppError("upstream_missing_terminal", "Grok Bot upstream did not return a terminal frame", 502);
  json(res, 200, nonStreamingResponse(request.model, text || finalState.text, usageFromState(finalState)));
}

function requireAuth(req, key) {
  if (!key) throw new AppError("server_key_not_configured", "GROKBOT2API_KEY is not configured", 503);
  const authorization = String(req.headers.authorization || "");
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  if (!match || match[1] !== key) throw new AppError("unauthorized", "Missing or invalid API key", 401, "invalid_request_error");
}

async function readJsonBody(req, maxBytes) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > maxBytes) throw new AppError("request_too_large", "Request body too large", 413, "invalid_request_error");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new AppError("invalid_json", "Invalid JSON request body", 400, "invalid_request_error");
  }
}

function logStreamError(request, error) {
  const appError = errorFromUnknown(error, "upstream_error");
  console.error(JSON.stringify({
    event: "grokbot2api_stream_error",
    model: request.model,
    messageCount: request.messages.length,
    errorType: appError.type,
    errorCode: appError.code,
    errorStatus: appError.status,
    errorMessage: appError.message
  }));
}

function healthPayload(runtime) {
  return {
    ok: true,
    default_model: runtime.publicModel,
    model_count: modelList().length,
    active: runtime.active,
    auth_configured: Boolean(runtime.key)
  };
}

function dashboardHtml(req, runtime) {
  const health = healthPayload(runtime);
  const baseUrl = process.env.GROKBOT_PUBLIC_BASE_URL || apiBaseUrl(req);
  const rows = modelList().map((item) => {
    const metadata = item.metadata || {};
    return `<tr>
      <td><code>${escapeHtml(item.id)}</code></td>
      <td>${escapeHtml(item.display_name || item.id)}</td>
      <td>${escapeHtml(metadata.status || "")}</td>
      <td>${escapeHtml(metadata.catalog_status || "")}</td>
      <td>${escapeHtml(String(metadata.context_window || ""))}</td>
    </tr>`;
  }).join("");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>GrokBot2API</title>
  <style>
    :root { color-scheme: light dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: #f6f7f9; color: #17181c; }
    main { max-width: 1120px; margin: 0 auto; padding: 32px 20px 48px; }
    h1 { margin: 0 0 8px; font-size: 30px; font-weight: 700; }
    h2 { margin: 28px 0 12px; font-size: 18px; }
    .muted { color: #667085; }
    .grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin: 20px 0 8px; }
    .metric { border: 1px solid #d6dbe3; border-radius: 8px; padding: 14px; background: #fff; }
    .label { color: #667085; font-size: 12px; }
    .value { margin-top: 6px; font-size: 18px; font-weight: 650; overflow-wrap: anywhere; }
    table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #d6dbe3; border-radius: 8px; overflow: hidden; }
    th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid #edf0f4; font-size: 14px; }
    th { background: #eef2f7; font-size: 12px; text-transform: uppercase; color: #526071; }
    tr:last-child td { border-bottom: 0; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    @media (max-width: 760px) { main { padding: 24px 14px 36px; } .grid { grid-template-columns: 1fr 1fr; } th, td { padding: 8px; font-size: 12px; } }
    @media (prefers-color-scheme: dark) {
      body { background: #111318; color: #f5f7fb; }
      .muted, .label { color: #a7b0be; }
      .metric, table { background: #181b22; border-color: #343945; }
      th { background: #202633; color: #b9c2d0; }
      th, td { border-bottom-color: #303541; }
    }
  </style>
</head>
<body>
  <main>
    <h1>GrokBot2API</h1>
    <p class="muted">Read-only test dashboard. API requests still require the bearer key.</p>
    <section class="grid">
      <div class="metric"><div class="label">Default model</div><div class="value">${escapeHtml(health.default_model)}</div></div>
      <div class="metric"><div class="label">Models</div><div class="value">${health.model_count}</div></div>
      <div class="metric"><div class="label">Active request</div><div class="value">${health.active ? "yes" : "no"}</div></div>
      <div class="metric"><div class="label">Auth configured</div><div class="value">${health.auth_configured ? "yes" : "no"}</div></div>
    </section>
    <h2>API Base</h2>
    <p><code>${escapeHtml(baseUrl)}</code></p>
    <h2>Models</h2>
    <table>
      <thead><tr><th>Model</th><th>Name</th><th>Status</th><th>Catalog</th><th>Context</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </main>
</body>
</html>`;
}

function apiBaseUrl(req) {
  const host = req.headers.host || "127.0.0.1";
  const proto = req.headers["x-forwarded-proto"] || "http";
  const prefix = String(req.headers["x-forwarded-prefix"] || "").replace(/\/$/, "");
  return `${proto}://${host}${prefix}/v1`;
}

function html(res, status, body) {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-cache, no-transform"
  });
  res.end(body);
}

function noContent(res) {
  res.writeHead(204, { "cache-control": "no-cache, no-transform" });
  res.end();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function validateBind(host, env) {
  const loopback = host === "127.0.0.1" || host === "localhost" || host === "::1";
  if (!loopback && env.GROKBOT_ALLOW_PRIVATE_BIND !== "1") {
    throw new AppError("non_loopback_bind_blocked", "Set GROKBOT_ALLOW_PRIVATE_BIND=1 before binding outside loopback", 500);
  }
}

function matchesPath(url, allowed) {
  const path = String(url || "").split("?")[0];
  return allowed.includes(path);
}
