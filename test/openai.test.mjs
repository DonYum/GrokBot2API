import assert from "node:assert/strict";
import test from "node:test";
import { normalizeResponsesRequest, sanitizeJsonSchema } from "../src/openai.mjs";

test("normalizes stable conversation ids without a default max token override", () => {
  const first = normalizeResponsesRequest({
    model: "grok-4.5",
    prompt_cache_key: "session-123",
    input: "Use a tool."
  });
  const second = normalizeResponsesRequest({
    model: "grok-4.5",
    prompt_cache_key: "session-123",
    input: [
      { type: "function_call_output", call_id: "call_1", output: "ok" }
    ]
  });

  assert.equal(first.maxTokens, undefined);
  assert.equal(first.conversationId, second.conversationId);
  assert.equal(first.conversationGroupId, second.conversationGroupId);
  assert.match(first.conversationId, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.match(first.conversationGroupId, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("honors explicit max_output_tokens", () => {
  const request = normalizeResponsesRequest({
    model: "grok-4.5",
    max_output_tokens: 128,
    input: "Say ok."
  });

  assert.equal(request.maxTokens, 128);
});

test("sanitizes tool JSON schema like the official client path", () => {
  const schema = sanitizeJsonSchema({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    markdownDescription: "not sent upstream",
    definitions: { unused: { type: "string" } },
    properties: {
      target: {
        type: "string",
        default: ".",
        markdownDescription: "Directory"
      },
      tuple: {
        type: "array",
        items: [
          { type: "string", default: "x" },
          { type: "number", additionalProperties: false }
        ],
        additionalItems: { type: "boolean", default: false }
      }
    }
  });

  assert.deepEqual(schema, {
    type: "object",
    properties: {
      target: { type: "string" },
      tuple: {
        type: "array",
        prefixItems: [
          { type: "string" },
          { type: "number" }
        ],
        items: { type: "boolean" }
      }
    }
  });
});
