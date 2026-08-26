import crypto from "node:crypto";
import https from "node:https";
import {
  applyConnectFrame,
  buildInferenceRequest,
  connectEnvelope,
  ConnectFrameDecoder,
  emptyDecodeState
} from "./proto.mjs";
import { cursorChecksum } from "./credentials.mjs";
import { AppError, hardStopStatus } from "./errors.mjs";

const BACKEND = new URL("https://api2.cursor.sh/aiserver.v1.InferenceService/Stream");

export class GrokBotInferenceClient {
  constructor(config = {}) {
    this.backend = new URL(config.backend || BACKEND);
    this.upstreamModel = config.upstreamModel || "grok-4.5";
    this.timeoutMs = config.timeoutMs || 90_000;
    this.maxResponseBytes = config.maxResponseBytes || 8 * 1024 * 1024;
  }

  async *stream(request, credentials) {
    const state = emptyDecodeState();
    const body = connectEnvelope(buildInferenceRequest({
      messages: request.messages,
      upstreamModel: request.upstreamModel || this.upstreamModel,
      parameters: request.parameters,
      maxTokens: request.maxTokens,
      invocationId: crypto.randomUUID(),
      conversationId: crypto.randomUUID()
    }));
    const response = await this.open(credentials, body);
    if (response.status !== 200) {
      if (hardStopStatus(response.status)) {
        throw new AppError(`hard_stop_http_${response.status}`, `Grok Bot upstream returned ${response.status}`, 503);
      }
      throw new AppError(`upstream_http_${response.status}`, `Grok Bot upstream returned ${response.status}`, 502);
    }

    const decoder = new ConnectFrameDecoder();
    let receivedBytes = 0;
    for await (const chunk of response.body) {
      receivedBytes += chunk.length;
      if (receivedBytes > this.maxResponseBytes) throw new AppError("upstream_response_too_large", "Upstream response too large", 502);
      for (const frame of decoder.push(chunk)) {
        const deltas = applyConnectFrame(frame, state);
        for (const delta of deltas) yield { type: "text", text: delta };
      }
    }
    decoder.finish();
    if (state.errors.length > 0) {
      const first = state.errors[0];
      throw new AppError(String(first.code || "upstream_stream_error"), first.message || "Grok Bot upstream stream error", 502);
    }
    yield { type: "done", state };
  }

  open(credentials, body) {
    return new Promise((resolve, reject) => {
      const request = https.request(this.backend, {
        method: "POST",
        headers: {
          "content-type": "application/connect+proto",
          "connect-protocol-version": "1",
          "user-agent": "connect-es/1.6.1",
          authorization: `Bearer ${credentials.accessToken}`,
          "x-cursor-checksum": cursorChecksum(credentials.machineId),
          "x-cursor-client-type": "sand",
          "x-cursor-client-version": credentials.clientVersion || "0.27.0",
          "x-sand-box-namespace": "prod",
          "x-ghost-mode": "true",
          "x-request-id": crypto.randomUUID(),
          "content-length": String(body.length)
        },
        timeout: this.timeoutMs
      }, (response) => {
        resolve({ status: response.statusCode || 0, headers: response.headers, body: response });
      });
      request.on("timeout", () => request.destroy(new AppError("upstream_timeout", "Grok Bot upstream request timed out", 504)));
      request.on("error", reject);
      request.end(body);
    });
  }
}

export function usageFromState(state) {
  const usage = state.usage || {
    inputTokens: state.extendedUsage?.inputTokens || 0,
    outputTokens: state.extendedUsage?.outputTokens || 0,
    totalTokens: (state.extendedUsage?.inputTokens || 0) + (state.extendedUsage?.outputTokens || 0)
  };
  return {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    total_tokens: usage.totalTokens,
    input_tokens_details: {
      cached_tokens: state.extendedUsage?.cacheReadTokens || 0
    },
    output_tokens_details: {
      reasoning_tokens: Math.max(0, (state.extendedUsage?.outputTokens || usage.outputTokens) - visibleTokenEstimate(state.text))
    }
  };
}

function visibleTokenEstimate(text) {
  return Math.ceil(String(text || "").length / 4);
}
