import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApp } from "../src/server.mjs";

const DEFAULT_GROK_CLI = "/Users/yunfeng/.grok/bin/grok";

test("current Grok CLI can consume the sidecar Responses stream", { skip: !existsSync(grokCliPath()) }, async () => {
  const seen = [];
  const server = await listen({
    upstream: {
      async *stream(request) {
        seen.push({
          model: request.model,
          messageCount: request.messages.length,
          maxTokens: request.maxTokens,
          conversationId: request.conversationId,
          conversationGroupId: request.conversationGroupId
        });
        yield { type: "text", text: "GROK_CLI_COMPAT_OK" };
        yield { type: "done", state: fakeState("GROK_CLI_COMPAT_OK") };
      }
    }
  });
  try {
    const result = await runGrokCli(server);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /GROK_CLI_COMPAT_OK/);
    assert.ok(seen.length >= 1);
    assert.ok(seen.some((request) => request.model === "grok-4.5"));
    assert.ok(seen.every((request) => ["grok-4.5", "grok-4.6"].includes(request.model)));
    assert.ok(seen.some((request) => request.messageCount >= 1));
    assert.ok(seen.every((request) => request.conversationId));
    assert.ok(seen.every((request) => request.conversationGroupId));
  } finally {
    await close(server);
  }
});

test("current Grok CLI executes a Responses function call and returns tool output", { skip: !existsSync(grokCliPath()) }, async () => {
  const seen = [];
  const server = await listen({
    upstream: {
      async *stream(request) {
        seen.push({
          tools: request.tools.map((tool) => tool.name),
          hasToolResult: request.messages.some((message) => Array.isArray(message.toolResults) && message.toolResults.length > 0),
          conversationId: request.conversationId,
          conversationGroupId: request.conversationGroupId,
          maxTokens: request.maxTokens
        });
        if (request.tools.some((tool) => tool.name === "list_dir") && !seen.at(-1).hasToolResult) {
          yield { type: "tool_call_done", id: "call_list", name: "list_dir", args: "{\"target_directory\":\".\"}", index: 0 };
          yield { type: "done", state: fakeState("") };
          return;
        }
        yield { type: "text", text: "GROK_CLI_TOOL_ROUNDTRIP_OK" };
        yield { type: "done", state: fakeState("GROK_CLI_TOOL_ROUNDTRIP_OK") };
      }
    }
  });
  try {
    const result = await runGrokCli(server, { prompt: "List files in the current directory." });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /GROK_CLI_TOOL_ROUNDTRIP_OK/);
    assert.equal(seen.some((request) => request.tools.includes("list_dir")), true);
    assert.equal(seen.some((request) => request.hasToolResult), true);
    const toolLoop = seen.filter((request) => request.tools.includes("list_dir") || request.hasToolResult);
    assert.equal(new Set(toolLoop.map((request) => request.conversationId)).size, 1);
    assert.equal(new Set(toolLoop.map((request) => request.conversationGroupId)).size, 1);
  } finally {
    await close(server);
  }
});

function listen(config = {}) {
  const app = createApp({
    publicModel: "grok-4.5",
    key: "test-key",
    credentialProvider: {
      get: async () => ({
        accessToken: fakeJwt(),
        machineId: "machine-id-1234567890",
        clientVersion: "0.27.0"
      })
    },
    ...config
  });
  const server = http.createServer(app);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function runGrokCli(server, options = {}) {
  const home = mkdtempSync(join(tmpdir(), "grokbot2api-cli-"));
  mkdirSync(join(home, ".grok"), { recursive: true });
  writeFileSync(join(home, "fixture.txt"), "fixture");
  writeFileSync(join(home, ".grok", "config.toml"), grokConfig(server.address().port));
  return new Promise((resolve, reject) => {
    const child = spawn(grokCliPath(), ["--no-alt-screen", "-p", options.prompt || "compat ping", "-m", "local-grok"], {
      cwd: home,
      env: {
        ...process.env,
        HOME: home,
        XDG_CONFIG_HOME: join(home, ".config"),
        XDG_CACHE_HOME: join(home, ".cache"),
        XDG_DATA_HOME: join(home, ".local", "share")
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), 15_000);
    child.stdout.on("data", (data) => { stdout += data.toString(); });
    child.stderr.on("data", (data) => { stderr += data.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function grokConfig(port) {
  return `[models]
default = "local-grok"

[model."local-grok"]
model = "grok-4.5"
base_url = "http://127.0.0.1:${port}/v1"
api_key = "test-key"
api_backend = "responses"
context_window = 1000000
`;
}

function fakeState(text) {
  return {
    text,
    usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
    extendedUsage: {
      inputTokens: 10,
      outputTokens: 4,
      cacheReadTokens: 2,
      cacheWriteTokens: 0,
      maxTokens: 256000
    },
    errors: []
  };
}

function fakeJwt() {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url");
  return `header.${payload}.signature`;
}

function grokCliPath() {
  return process.env.GROK_CLI_PATH || DEFAULT_GROK_CLI;
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
