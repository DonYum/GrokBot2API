import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadCredentials, validateCredentials } from "../src/credentials.mjs";

test("loads credentials from an absolute command without shell parsing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grokbot2api-credentials-"));
  try {
    const helper = path.join(dir, "credentials-helper.mjs");
    fs.writeFileSync(helper, `#!/usr/bin/env node
console.log(JSON.stringify({
  accessToken: "${fakeJwt()}",
  machineId: "machine-id-1234567890",
  clientVersion: "0.27.0"
}));
`, { mode: 0o700 });
    const credentials = loadCredentials({ GROKBOT_CREDENTIALS_COMMAND: helper });
    validateCredentials(credentials);
    assert.equal(credentials.source, "command");
    assert.equal(credentials.machineId, "machine-id-1234567890");
    assert.equal(credentials.clientVersion, "0.27.0");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("rejects relative credential commands", () => {
  assert.throws(
    () => loadCredentials({ GROKBOT_CREDENTIALS_COMMAND: "credentials-helper" }),
    /GROKBOT_CREDENTIALS_COMMAND must be an absolute path/
  );
});

test("does not expose credential command stderr on failure", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grokbot2api-credentials-"));
  try {
    const helper = path.join(dir, "credentials-helper.mjs");
    fs.writeFileSync(helper, `#!/usr/bin/env node
console.error("secret stderr should not be relayed");
process.exit(2);
`, { mode: 0o700 });
    assert.throws(
      () => loadCredentials({ GROKBOT_CREDENTIALS_COMMAND: helper }),
      (error) => {
        assert.equal(error.code, "credentials_command_failed");
        assert.doesNotMatch(error.message, /secret stderr/);
        return true;
      }
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("rejects invalid credential command output", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grokbot2api-credentials-"));
  try {
    const helper = path.join(dir, "credentials-helper.mjs");
    fs.writeFileSync(helper, `#!/usr/bin/env node
console.log("not json");
`, { mode: 0o700 });
    assert.throws(
      () => loadCredentials({ GROKBOT_CREDENTIALS_COMMAND: helper }),
      /Grok Bot credential command returned invalid JSON/
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function fakeJwt() {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url");
  return `header.${payload}.signature`;
}
