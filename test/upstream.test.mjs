import assert from "node:assert/strict";
import test from "node:test";
import { buildUpstreamRequestBody } from "../src/upstream.mjs";

test("includes normalized tools in the upstream inference request body", () => {
  const body = buildUpstreamRequestBody({
    messages: [{ role: "user", text: "Use the tool." }],
    tools: [{
      name: "unique_live_tool_schema",
      description: "A unique tool for regression coverage.",
      parameters: {
        type: "object",
        properties: {
          unique_live_tool_argument: { type: "string" }
        }
      }
    }],
    parameters: {},
    maxTokens: 128
  }, "grok-4.5");

  const encoded = body.toString("utf8");
  assert.match(encoded, /unique_live_tool_schema/);
  assert.match(encoded, /unique_live_tool_argument/);
});
