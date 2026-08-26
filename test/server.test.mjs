import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { createApp, maxBodyBytesFromEnv } from "../src/server.mjs";
import { AppError } from "../src/errors.mjs";

test("serves models behind bearer auth", async () => {
  const server = await listen();
  try {
    const denied = await request(server, "GET", "/v1/models", null, {});
    assert.equal(denied.status, 401);
    const allowed = await request(server, "GET", "/v1/models", null, authHeaders());
    assert.equal(allowed.status, 200);
    assert.equal(allowed.body.data.length, 34);
    assert.equal(allowed.body.data.some((item) => item.id === "default"), false);
    const grok45 = allowed.body.data.find((item) => item.id === "grok-4.5");
    const grok46 = allowed.body.data.find((item) => item.id === "grok-4.6");
    assert.equal(grok45.metadata.verification, "verified");
    assert.equal(grok45.metadata.status, "enabled");
    assert.equal(grok46.metadata.verification, "catalog_entitled");
    assert.equal(grok46.metadata.status, "experimental");
    assert.deepEqual(grok46.metadata.parameters.effort, ["low", "medium", "high", "xhigh"]);
  } finally {
    await close(server);
  }
});

test("serves a read-only dashboard without bearer auth", async () => {
  const server = await listen();
  try {
    const response = await request(server, "GET", "/dashboard", null, {});
    assert.equal(response.status, 200);
    assert.match(response.raw, /GrokBot2API/);
    assert.match(response.raw, /grok-4\.6/);
    assert.match(response.raw, /catalog_entitled/);
    assert.doesNotMatch(response.raw, /test-key/);
  } finally {
    await close(server);
  }
});

test("streams Grok CLI compatible Responses text events with terminal usage", async () => {
  const server = await listen({
    upstream: fakeUpstream([
      { type: "text", text: "hel" },
      { type: "text", text: "lo" },
      { type: "done", state: fakeState("hello") }
    ])
  });
  try {
    const response = await request(server, "POST", "/v1/responses", {
      model: "grok-4.5",
      stream: true,
      input: [{ role: "user", content: [{ type: "input_text", text: "Say hello." }] }]
    }, authHeaders());
    assert.equal(response.status, 200);
    const events = parseSse(response.raw);
    assert.deepEqual(events.map((event) => event.event), [
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.completed"
    ]);
    assert.deepEqual(events.map((event) => event.data.sequence_number), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    assert.equal(events[0].data.response.created_at > 0, true);
    assert.equal(events.at(-1).data.response.status, "completed");
    assert.equal(events.at(-1).data.response.output[0].content[0].text, "hello");
    assert.equal(events.at(-1).data.response.usage.total_tokens, 13);
    assert.deepEqual(events.at(-1).data.response.usage.input_tokens_details, { cached_tokens: 4 });
  } finally {
    await close(server);
  }
});

test("streams Responses function call events from upstream tool calls", async () => {
  const seen = [];
  const server = await listen({
    upstream: {
      async *stream(request) {
        seen.push(request);
        yield { type: "tool_call_delta", id: "call_1", name: "list_dir", args: "{\"target_directory\"", index: 0 };
        yield { type: "tool_call_done", id: "call_1", name: "list_dir", args: ":\".\"}", index: 0 };
        yield { type: "done", state: fakeState("") };
      }
    }
  });
  try {
    const response = await request(server, "POST", "/v1/responses", {
      model: "grok-4.5",
      stream: true,
      tools: [{
        type: "function",
        function: {
          name: "list_dir",
          description: "List a directory.",
          parameters: { type: "object", properties: { target_directory: { type: "string" } } }
        }
      }],
      input: [{ role: "user", content: [{ type: "input_text", text: "List files." }] }]
    }, authHeaders());
    assert.equal(response.status, 200);
    assert.equal(seen[0].tools.length, 1);
    assert.equal(seen[0].tools[0].name, "list_dir");
    const events = parseSse(response.raw);
    assert.deepEqual(events.map((event) => event.event), [
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.function_call_arguments.delta",
      "response.function_call_arguments.delta",
      "response.function_call_arguments.done",
      "response.output_item.done",
      "response.completed"
    ]);
    assert.deepEqual(events.map((event) => event.data.sequence_number), [0, 1, 2, 3, 4, 5, 6, 7]);
    assert.equal(events[2].data.item.type, "function_call");
    assert.equal(events[2].data.item.call_id, "call_1");
    assert.equal(events[2].data.item.name, "list_dir");
    assert.equal(events[5].data.arguments, "{\"target_directory\":\".\"}");
    assert.equal(events.at(-1).data.response.output[0].type, "function_call");
  } finally {
    await close(server);
  }
});

test("normalizes function call outputs for upstream continuation", async () => {
  const seen = [];
  const server = await listen({
    upstream: {
      async *stream(request) {
        seen.push(request);
        yield { type: "done", state: fakeState("") };
      }
    }
  });
  try {
    const response = await request(server, "POST", "/v1/responses", {
      model: "grok-4.5",
      stream: false,
      tools: [{
        type: "function",
        function: {
          name: "list_dir",
          description: "List a directory.",
          parameters: { type: "object", properties: { target_directory: { type: "string" } } }
        }
      }],
      input: [
        { role: "user", content: [{ type: "input_text", text: "List files." }] },
        { type: "function_call", call_id: "call_1", name: "list_dir", arguments: "{\"target_directory\":\".\"}" },
        { type: "function_call_output", call_id: "call_1", output: "README.md" }
      ]
    }, authHeaders());
    assert.equal(response.status, 200);
    assert.equal(seen[0].tools[0].name, "list_dir");
    assert.deepEqual(seen[0].messages.at(-2).toolCalls, [{ id: "call_1", name: "list_dir", rawArgs: "{\"target_directory\":\".\"}" }]);
    assert.deepEqual(seen[0].messages.at(-1).toolResults, [{ id: "call_1", name: "list_dir", result: "README.md" }]);
  } finally {
    await close(server);
  }
});

test("maps model parameters for catalog models", async () => {
  const seen = [];
  const server = await listen({
    upstream: {
      async *stream(request) {
        seen.push(request);
        yield { type: "done", state: fakeState("") };
      }
    }
  });
  try {
    const response = await request(server, "POST", "/v1/responses", {
      model: "grok-4.6",
      stream: false,
      effort: "xhigh",
      fast: false,
      input: "Say ok."
    }, authHeaders());
    assert.equal(response.status, 200);
    assert.equal(seen[0].model, "grok-4.6");
    assert.equal(seen[0].upstreamModel, "grok-4.6");
    assert.deepEqual(seen[0].parameters, { effort: "xhigh", fast: false });
  } finally {
    await close(server);
  }
});

test("rejects unsupported model parameters before upstream calls", async () => {
  let calls = 0;
  const server = await listen({
    upstream: {
      async *stream() {
        calls += 1;
        yield { type: "done", state: fakeState("") };
      }
    }
  });
  try {
    const response = await request(server, "POST", "/v1/responses", {
      model: "grok-4.5",
      effort: "xhigh",
      input: "Say ok."
    }, authHeaders());
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "unsupported_model_parameter");
    assert.equal(calls, 0);
  } finally {
    await close(server);
  }
});

test("starts and closes a text item when upstream returns empty text", async () => {
  const server = await listen({
    upstream: fakeUpstream([
      { type: "done", state: fakeState("") }
    ])
  });
  try {
    const response = await request(server, "POST", "/v1/responses", {
      model: "grok-4.5",
      stream: true,
      input: "Say nothing."
    }, authHeaders());
    assert.equal(response.status, 200);
    const events = parseSse(response.raw);
    assert.deepEqual(events.map((event) => event.event), [
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.completed"
    ]);
    assert.deepEqual(events.map((event) => event.data.sequence_number), [0, 1, 2, 3, 4, 5, 6, 7]);
  } finally {
    await close(server);
  }
});

test("returns non-streaming Responses JSON", async () => {
  const server = await listen({
    upstream: fakeUpstream([
      { type: "text", text: "ok" },
      { type: "done", state: fakeState("ok") }
    ])
  });
  try {
    const response = await request(server, "POST", "/v1/responses", {
      model: "grok-4.5",
      stream: false,
      input: "Say ok."
    }, authHeaders());
    assert.equal(response.status, 200);
    assert.equal(response.body.object, "response");
    assert.equal(response.body.status, "completed");
    assert.equal(response.body.output[0].content[0].text, "ok");
    assert.equal(response.body.usage.input_tokens, 10);
  } finally {
    await close(server);
  }
});

test("keeps 1 MiB request body cap by default", async () => {
  let calls = 0;
  const server = await listen({
    upstream: {
      async *stream() {
        calls += 1;
        yield { type: "done", state: fakeState("") };
      }
    }
  });
  try {
    const response = await request(server, "POST", "/v1/responses", {
      model: "grok-4.5",
      stream: false,
      input: "x".repeat(1024 * 1024)
    }, authHeaders());
    assert.equal(response.status, 413);
    assert.equal(response.body.error.code, "request_too_large");
    assert.equal(calls, 0);
  } finally {
    await close(server);
  }
});

test("allows an explicit larger request body cap", async () => {
  let calls = 0;
  const server = await listen({
    maxBodyBytes: 2 * 1024 * 1024,
    upstream: {
      async *stream() {
        calls += 1;
        yield { type: "done", state: fakeState("") };
      }
    }
  });
  try {
    const response = await request(server, "POST", "/v1/responses", {
      model: "grok-4.5",
      stream: false,
      input: "x".repeat(1024 * 1024)
    }, authHeaders());
    assert.equal(response.status, 200);
    assert.equal(calls, 1);
  } finally {
    await close(server);
  }
});

test("parses request body cap with a hard maximum", () => {
  assert.equal(maxBodyBytesFromEnv({}), 1024 * 1024);
  assert.equal(maxBodyBytesFromEnv({ GROKBOT_MAX_BODY_BYTES: String(8 * 1024 * 1024) }), 8 * 1024 * 1024);
  assert.throws(
    () => maxBodyBytesFromEnv({ GROKBOT_MAX_BODY_BYTES: "16mb" }),
    /GROKBOT_MAX_BODY_BYTES must be a positive integer/
  );
  assert.throws(
    () => maxBodyBytesFromEnv({ GROKBOT_MAX_BODY_BYTES: String(16 * 1024 * 1024 + 1) }),
    /GROKBOT_MAX_BODY_BYTES must be <=/
  );
});

test("limits concurrent requests", async () => {
  let release;
  const server = await listen({
    upstream: fakeUpstream(async function* () {
      await new Promise((resolve) => { release = resolve; });
      yield { type: "done", state: fakeState("") };
    })
  });
  try {
    const first = request(server, "POST", "/v1/responses", { model: "grok-4.5", input: "one" }, authHeaders());
    await new Promise((resolve) => setTimeout(resolve, 25));
    const second = await request(server, "POST", "/v1/responses", { model: "grokbot-4.5", input: "two" }, authHeaders());
    assert.equal(second.status, 429);
    assert.equal(second.body.error.code, "concurrency_limited");
    release();
    await first;
  } finally {
    await close(server);
  }
});

test("maps upstream stream failures to SSE error events", async () => {
  const server = await listen({
    upstream: fakeUpstream(async function* () {
      yield { type: "text", text: "partial" };
      throw new AppError("hard_stop_http_429", "Grok Bot upstream returned 429", 503);
    })
  });
  try {
    const response = await request(server, "POST", "/v1/responses", {
      model: "grok-4.5",
      input: "Say ok."
    }, authHeaders());
    const events = parseSse(response.raw);
    assert.equal(response.status, 200);
    assert.equal(events.at(-1).event, "error");
    assert.equal(events.at(-1).data.error.code, "hard_stop_http_429");
    assert.equal(events.at(-1).data.error.status, 503);
  } finally {
    await close(server);
  }
});

function listen(config = {}) {
  const app = createApp({
    publicModel: "grok-4.5",
    key: "test-key",
    credentialProvider: { get: async () => ({ accessToken: fakeJwt(), machineId: "machine-id-1234567890", clientVersion: "0.27.0" }) },
    upstream: fakeUpstream([{ type: "done", state: fakeState("") }]),
    ...config
  });
  const server = http.createServer(app);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function fakeUpstream(events) {
  return {
    async *stream() {
      if (typeof events === "function") {
        yield* events();
        return;
      }
      for (const event of events) yield event;
    }
  };
}

function fakeState(text) {
  return {
    text,
    usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13 },
    extendedUsage: { inputTokens: 10, outputTokens: 3, cacheReadTokens: 4, cacheWriteTokens: 0, maxTokens: 256000 },
    errors: []
  };
}

function request(server, method, path, body, headers) {
  const address = server.address();
  const payload = body ? Buffer.from(JSON.stringify(body), "utf8") : null;
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1",
      port: address.port,
      path,
      method,
      headers: {
        ...(payload ? { "content-type": "application/json", "content-length": String(payload.length) } : {}),
        ...headers
      }
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let parsed = null;
        try {
          parsed = raw ? JSON.parse(raw) : null;
        } catch {
          parsed = null;
        }
        resolve({ status: res.statusCode || 0, raw, body: parsed });
      });
    });
    req.on("error", reject);
    req.end(payload);
  });
}

function parseSse(raw) {
  return raw.trim().split("\n\n").map((block) => {
    const lines = block.split("\n");
    const event = lines.find((line) => line.startsWith("event: "))?.slice(7);
    const data = lines.find((line) => line.startsWith("data: "))?.slice(6);
    return { event, data: JSON.parse(data) };
  });
}

function authHeaders() {
  return { authorization: "Bearer test-key" };
}

function fakeJwt() {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url");
  return `header.${payload}.signature`;
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
