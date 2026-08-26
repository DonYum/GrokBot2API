import assert from "node:assert/strict";
import test from "node:test";
import {
  applyConnectFrame,
  buildInferenceRequest,
  connectEnvelope,
  ConnectFrameDecoder,
  emptyDecodeState,
  protoField,
  protoMessage
} from "../src/proto.mjs";

test("encodes an inference request and decodes text/usage frames", () => {
  const request = buildInferenceRequest({
    upstreamModel: "grok-4.5",
    invocationId: "00000000-0000-4000-8000-000000000001",
    conversationId: "00000000-0000-4000-8000-000000000002",
    parameters: { effort: "xhigh", fast: false },
    messages: [
      { role: "system", text: "Follow instructions." },
      { role: "user", text: "Say ok." }
    ],
    maxTokens: 256
  });
  assert.ok(request.length > 0);
  assert.match(request.toString("utf8"), /grok-4\.5/);
  assert.match(request.toString("utf8"), /xhigh/);
  assert.match(request.toString("utf8"), /false/);

  const textFrame = protoMessage([protoField(1, 2, protoMessage([protoField(1, 2, "hello")]))]);
  const usageFrame = protoMessage([protoField(3, 2, protoMessage([
    protoField(1, 0, 10),
    protoField(2, 0, 3),
    protoField(3, 0, 13)
  ]))]);
  const decoder = new ConnectFrameDecoder();
  const state = emptyDecodeState();
  const frames = decoder.push(Buffer.concat([connectEnvelope(textFrame), connectEnvelope(usageFrame), connectEnvelope(Buffer.alloc(0), 2)]));
  const events = frames.flatMap((frame) => applyConnectFrame(frame, state));
  decoder.finish();

  assert.deepEqual(events, [{ type: "text", text: "hello" }]);
  assert.equal(state.text, "hello");
  assert.equal(state.frames, 3);
  assert.equal(state.endFrames, 1);
  assert.deepEqual(state.usage, { inputTokens: 10, outputTokens: 3, totalTokens: 13 });
});

test("encodes function tools and decodes tool call stream parts", () => {
  const request = buildInferenceRequest({
    upstreamModel: "grok-4.5",
    invocationId: "00000000-0000-4000-8000-000000000001",
    conversationId: "00000000-0000-4000-8000-000000000002",
    parameters: { effort: "high", fast: true },
    tools: [{
      name: "list_dir",
      description: "List a directory.",
      parameters: {
        type: "object",
        required: ["target_directory"],
        properties: { target_directory: { type: "string" } }
      }
    }],
    messages: [
      { role: "user", text: "List files." },
      { role: "assistant", text: "", toolCalls: [{ id: "call_1", name: "list_dir", rawArgs: "{\"target_directory\":\".\"}" }] },
      { role: "tool", text: "", toolResults: [{ id: "call_1", name: "list_dir", result: "README.md" }] }
    ],
    maxTokens: 256
  });
  assert.match(request.toString("utf8"), /list_dir/);
  assert.match(request.toString("utf8"), /target_directory/);
  assert.match(request.toString("utf8"), /README\.md/);

  const toolFrame = protoMessage([protoField(2, 2, protoMessage([
    protoField(1, 2, "call_1"),
    protoField(2, 2, "list_dir"),
    protoField(3, 2, "{\"target_directory\":\".\"}"),
    protoField(4, 0, 1),
    protoField(5, 0, 0)
  ]))]);
  const state = emptyDecodeState();
  const events = applyConnectFrame({ flags: 0, payload: toolFrame }, state);
  assert.equal(state.toolCallFrames, 1);
  assert.deepEqual(events, [{
    type: "tool_call_done",
    id: "call_1",
    name: "list_dir",
    args: "{\"target_directory\":\".\"}",
    isComplete: true,
    index: 0
  }]);
});
