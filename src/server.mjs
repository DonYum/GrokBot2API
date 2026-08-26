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
      if (req.method === "GET" && req.url === "/health") {
        json(res, 200, { ok: true, model: runtime.publicModel, active: runtime.active });
        return;
      }
      if (req.method === "GET" && matchesPath(req.url, ["/v1/models", "/models"])) {
        requireAuth(req, runtime.key);
        json(res, 200, modelsResponse(runtime.publicModel));
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
    const request = normalizeResponsesRequest(body, { publicModel: runtime.publicModel });
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
  const writer = new ResponseSseWriter(res, request, runtime.publicModel);
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
  json(res, 200, nonStreamingResponse(runtime.publicModel, text || finalState.text, usageFromState(finalState)));
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
