import crypto from "node:crypto";
import { AppError, errorFromUnknown, openAiError } from "./errors.mjs";

export const PUBLIC_MODEL = process.env.GROKBOT_MODEL || "grok-4.5";

export function modelsResponse(model = PUBLIC_MODEL) {
  return {
    object: "list",
    data: [{
      id: model,
      object: "model",
      created: 0,
      owned_by: "grokbot2api"
    }]
  };
}

export function normalizeResponsesRequest(body, config = {}) {
  if (!isRecord(body)) throw new AppError("invalid_request_error", "Request body must be a JSON object", 400, "invalid_request_error");
  const model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : config.publicModel;
  if (model !== config.publicModel) throw new AppError("model_not_found", `Model '${model}' is not available`, 404, "invalid_request_error");
  return {
    model,
    stream: body.stream !== false,
    messages: responseInputMessages(body),
    instructions: typeof body.instructions === "string" ? body.instructions : "",
    maxTokens: integerOr(body.max_output_tokens, config.maxTokens || 4096)
  };
}

export function responseInputMessages(body) {
  const messages = [];
  if (typeof body.instructions === "string" && body.instructions.trim()) {
    messages.push({ role: "system", text: body.instructions.trim() });
  }
  appendInput(messages, body.input);
  if (!messages.length) throw new AppError("invalid_request_error", "input is required", 400, "invalid_request_error");
  return messages;
}

function appendInput(messages, input) {
  if (typeof input === "string") {
    if (input.trim()) messages.push({ role: "user", text: input });
    return;
  }
  if (!Array.isArray(input)) return;
  for (const item of input) {
    if (typeof item === "string") {
      if (item.trim()) messages.push({ role: "user", text: item });
      continue;
    }
    if (!isRecord(item)) continue;
    const role = typeof item.role === "string" ? item.role : "user";
    const text = contentText(item.content);
    if (text.trim()) messages.push({ role, text });
  }
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((part) => {
    if (typeof part === "string") return [part];
    if (!isRecord(part)) return [];
    if (typeof part.text === "string") return [part.text];
    if (typeof part.input_text === "string") return [part.input_text];
    if (typeof part.output_text === "string") return [part.output_text];
    return [];
  }).join("\n");
}

export class ResponseSseWriter {
  constructor(res, request, model) {
    this.res = res;
    this.id = `resp_${crypto.randomUUID().replaceAll("-", "")}`;
    this.created = Math.floor(Date.now() / 1000);
    this.model = model;
    this.sequence = 0;
    this.textStarted = false;
    this.closed = false;
    this.text = "";
    this.usage = null;
  }

  start() {
    this.res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no"
    });
    const base = responseBase(this.id, this.created, this.model, "in_progress", null, null);
    this.event("response.created", { type: "response.created", response: base });
    this.event("response.in_progress", { type: "response.in_progress", response: base });
  }

  delta(text) {
    if (!text) return;
    this.text += text;
    if (!this.textStarted) {
      this.textStarted = true;
      this.event("response.output_item.added", {
        type: "response.output_item.added",
        output_index: 0,
        item: messageItem(this.id, "in_progress", [])
      });
      this.event("response.content_part.added", {
        type: "response.content_part.added",
        item_id: messageItemId(this.id),
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] }
      });
    }
    this.event("response.output_text.delta", {
      type: "response.output_text.delta",
      item_id: messageItemId(this.id),
      output_index: 0,
      content_index: 0,
      delta: text
    });
  }

  complete(usage) {
    this.usage = usage;
    if (!this.textStarted) this.delta("");
    this.event("response.output_text.done", {
      type: "response.output_text.done",
      item_id: messageItemId(this.id),
      output_index: 0,
      content_index: 0,
      text: this.text
    });
    const output = [messageItem(this.id, "completed", [{ type: "output_text", text: this.text, annotations: [] }])];
    this.event("response.completed", {
      type: "response.completed",
      response: {
        ...responseBase(this.id, this.created, this.model, "completed", null, usage),
        output
      }
    });
    this.close();
  }

  fail(error) {
    const appError = errorFromUnknown(error, "upstream_error");
    this.event("error", {
      type: "error",
      error: {
        message: appError.message,
        type: appError.type,
        code: appError.code,
        status: appError.status,
        param: null
      }
    });
    this.close();
  }

  event(name, data) {
    if (this.closed) return;
    const payload = { ...data, sequence_number: this.sequence++ };
    this.res.write(`event: ${name}\n`);
    this.res.write(`data: ${JSON.stringify(payload)}\n\n`);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.res.end();
  }
}

export function nonStreamingResponse(model, text, usage) {
  const id = `resp_${crypto.randomUUID().replaceAll("-", "")}`;
  const created = Math.floor(Date.now() / 1000);
  return {
    ...responseBase(id, created, model, "completed", null, usage),
    output: [messageItem(id, "completed", [{ type: "output_text", text, annotations: [] }])]
  };
}

export function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

export function jsonError(res, error) {
  const appError = errorFromUnknown(error);
  json(res, appError.status, openAiError(appError));
}

export function responseBase(id, created, model, status, error, usage) {
  return {
    id,
    object: "response",
    created_at: created,
    status,
    error,
    incomplete_details: null,
    model,
    output: [],
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: { effort: null, summary: null },
    store: false,
    tool_choice: "auto",
    tools: [],
    truncation: "disabled",
    usage,
    user: null,
    metadata: {}
  };
}

function messageItem(id, status, content) {
  return {
    id: messageItemId(id),
    type: "message",
    status,
    role: "assistant",
    content
  };
}

function messageItemId(id) {
  return `msg_${id.slice(5)}`;
}

function integerOr(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
