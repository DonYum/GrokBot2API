import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { createApp } from "../src/server.mjs";
import { AppError } from "../src/errors.mjs";

test("serves models behind bearer auth", async () => {
  const server = await listen();
  try {
    const denied = await request(server, "GET", "/v1/models", null, {});
    assert.equal(denied.status, 401);
    const allowed = await request(server, "GET", "/v1/models", null, authHeaders());
    assert.equal(allowed.status, 200);
    assert.equal(allowed.body.data[0].id, "grok-4.5");
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
