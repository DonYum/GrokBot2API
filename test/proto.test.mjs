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
    messages: [
      { role: "system", text: "Follow instructions." },
      { role: "user", text: "Say ok." }
    ],
    maxTokens: 256
  });
  assert.ok(request.length > 0);

  const textFrame = protoMessage([protoField(1, 2, protoMessage([protoField(1, 2, "hello")]))]);
  const usageFrame = protoMessage([protoField(3, 2, protoMessage([
    protoField(1, 0, 10),
    protoField(2, 0, 3),
    protoField(3, 0, 13)
  ]))]);
  const decoder = new ConnectFrameDecoder();
  const state = emptyDecodeState();
  const frames = decoder.push(Buffer.concat([connectEnvelope(textFrame), connectEnvelope(usageFrame), connectEnvelope(Buffer.alloc(0), 2)]));
  for (const frame of frames) applyConnectFrame(frame, state);
  decoder.finish();

  assert.equal(state.text, "hello");
  assert.equal(state.frames, 3);
  assert.equal(state.endFrames, 1);
  assert.deepEqual(state.usage, { inputTokens: 10, outputTokens: 3, totalTokens: 13 });
});
