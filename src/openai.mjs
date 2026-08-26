import crypto from "node:crypto";
import { AppError, errorFromUnknown, openAiError } from "./errors.mjs";
import { DEFAULT_MODEL_ID, modelById, modelList } from "./models.mjs";

export const PUBLIC_MODEL = process.env.GROKBOT_MODEL || DEFAULT_MODEL_ID;

export function modelsResponse() {
  return {
    object: "list",
    data: modelList()
  };
}

export function normalizeResponsesRequest(body, config = {}) {
  if (!isRecord(body)) throw new AppError("invalid_request_error", "Request body must be a JSON object", 400, "invalid_request_error");
  const model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : config.defaultModel || PUBLIC_MODEL;
  const modelInfo = modelById(model);
  if (!modelInfo) throw new AppError("model_not_found", `Model '${model}' is not available`, 404, "invalid_request_error");
  const parameters = requestModelParameters(body, modelInfo);
  return {
    model,
    upstreamModel: modelInfo.id,
    parameters,
    stream: body.stream !== false,
    tools: responseTools(body.tools),
    messages: responseInputMessages(body),
    instructions: typeof body.instructions === "string" ? body.instructions : "",
    maxTokens: integerOr(body.max_output_tokens, config.maxTokens || 4096)
  };
}

function requestModelParameters(body, modelInfo) {
  const parameters = { ...(modelInfo.defaults || {}) };
  const explicitEffort = stringFrom(body.effort) || stringFrom(body.reasoning?.effort);
  if (explicitEffort) setEffortParameter(parameters, modelInfo, explicitEffort);
  const fast = booleanFrom(body.fast);
  if (fast !== undefined) {
    if (!modelInfo.fast) throw new AppError("unsupported_model_parameter", `Model '${modelInfo.id}' does not support fast`, 400, "invalid_request_error");
    parameters.fast = fast;
  }
  const thinking = booleanFrom(body.thinking);
  if (thinking !== undefined) {
    if (!modelInfo.thinking) throw new AppError("unsupported_model_parameter", `Model '${modelInfo.id}' does not support thinking`, 400, "invalid_request_error");
    parameters.thinking = thinking;
  }
  const context = integerOr(body.context, 0);
  if (context > 0) {
    if (!modelInfo.contexts?.includes(context)) throw new AppError("unsupported_model_parameter", `Model '${modelInfo.id}' does not support context ${context}`, 400, "invalid_request_error");
    parameters.context = context;
  }
  return parameters;
}

function setEffortParameter(parameters, modelInfo, effort) {
  if (!modelInfo.effortParameter || !modelInfo.efforts?.length) {
    throw new AppError("unsupported_model_parameter", `Model '${modelInfo.id}' does not support effort`, 400, "invalid_request_error");
  }
  if (!modelInfo.efforts.includes(effort)) {
    throw new AppError("unsupported_model_parameter", `Model '${modelInfo.id}' does not support effort '${effort}'`, 400, "invalid_request_error");
  }
  parameters[modelInfo.effortParameter] = effort;
}

function stringFrom(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function booleanFrom(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string" && ["true", "false"].includes(value.toLowerCase())) return value.toLowerCase() === "true";
  return undefined;
}

export function responseInputMessages(body) {
  const messages = [];
  const toolNamesByCallId = new Map();
  if (typeof body.instructions === "string" && body.instructions.trim()) {
    messages.push({ role: "system", text: body.instructions.trim() });
  }
  appendInput(messages, body.input, toolNamesByCallId);
  if (!messages.length) throw new AppError("invalid_request_error", "input is required", 400, "invalid_request_error");
  return messages;
}

function appendInput(messages, input, toolNamesByCallId) {
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
    if (item.type === "function_call") {
      const callId = stringFrom(item.call_id);
      const name = stringFrom(item.name);
      const args = typeof item.arguments === "string" ? item.arguments : "";
      if (callId && name) {
        toolNamesByCallId.set(callId, name);
        messages.push({ role: "assistant", text: "", toolCalls: [{ id: callId, name, rawArgs: args }] });
      }
      continue;
    }
    if (item.type === "function_call_output") {
      const callId = stringFrom(item.call_id);
      const output = typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? "");
      if (callId) messages.push({ role: "tool", text: "", toolResults: [{ id: callId, name: toolNamesByCallId.get(callId) || "", result: output }] });
      continue;
    }
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

function responseTools(tools) {
  if (!Array.isArray(tools)) return [];
  return tools.flatMap((tool) => {
    if (!isRecord(tool) || tool.type !== "function") return [];
    const spec = isRecord(tool.function) ? tool.function : tool;
    const name = stringFrom(spec.name);
    if (!name) return [];
    return [{
      name,
      description: typeof spec.description === "string" ? spec.description : "",
      parameters: isRecord(spec.parameters) ? spec.parameters : {}
    }];
  });
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
    this.outputCount = 0;
    this.textOutputIndex = null;
    this.toolCalls = new Map();
    this.output = [];
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
    this.ensureTextStarted();
    this.event("response.output_text.delta", {
      type: "response.output_text.delta",
      item_id: messageItemId(this.id),
      output_index: this.textOutputIndex,
      content_index: 0,
      delta: text
    });
  }

  toolCallDelta(part) {
    const call = this.ensureToolCall(part);
    if (!part.args) return;
    call.arguments += part.args;
    this.event("response.function_call_arguments.delta", {
      type: "response.function_call_arguments.delta",
      item_id: call.item.id,
      output_index: call.outputIndex,
      delta: part.args
    });
  }

  toolCallDone(part) {
    const call = this.ensureToolCall(part);
    if (part.args) {
      call.arguments += part.args;
      this.event("response.function_call_arguments.delta", {
        type: "response.function_call_arguments.delta",
        item_id: call.item.id,
        output_index: call.outputIndex,
        delta: part.args
      });
    }
    const item = { ...call.item, status: "completed", arguments: call.arguments };
    call.completed = true;
    call.item = item;
    this.output[call.outputIndex] = item;
    this.event("response.function_call_arguments.done", {
      type: "response.function_call_arguments.done",
      item_id: item.id,
      output_index: call.outputIndex,
      arguments: call.arguments
    });
    this.event("response.output_item.done", {
      type: "response.output_item.done",
      output_index: call.outputIndex,
      item
    });
  }

  complete(usage) {
    this.usage = usage;
    if (this.textStarted || this.output.length === 0) this.completeTextItem();
    const output = this.output.filter(Boolean);
    this.event("response.completed", {
      type: "response.completed",
      response: {
        ...responseBase(this.id, this.created, this.model, "completed", null, usage),
        output
      }
    });
    this.close();
  }

  ensureTextStarted() {
    if (this.textStarted) return;
    this.textStarted = true;
    this.textOutputIndex = this.outputCount++;
    this.event("response.output_item.added", {
      type: "response.output_item.added",
      output_index: this.textOutputIndex,
      item: messageItem(this.id, "in_progress", [])
    });
    this.event("response.content_part.added", {
      type: "response.content_part.added",
      item_id: messageItemId(this.id),
      output_index: this.textOutputIndex,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] }
    });
  }

  completeTextItem() {
    this.ensureTextStarted();
    const part = { type: "output_text", text: this.text, annotations: [] };
    const item = messageItem(this.id, "completed", [part]);
    this.output[this.textOutputIndex] = item;
    this.event("response.output_text.done", {
      type: "response.output_text.done",
      item_id: messageItemId(this.id),
      output_index: this.textOutputIndex,
      content_index: 0,
      text: this.text
    });
    this.event("response.content_part.done", {
      type: "response.content_part.done",
      item_id: messageItemId(this.id),
      output_index: this.textOutputIndex,
      content_index: 0,
      part
    });
    this.event("response.output_item.done", {
      type: "response.output_item.done",
      output_index: this.textOutputIndex,
      item
    });
  }

  ensureToolCall(part) {
    const callId = stringFrom(part.id) || `call_${this.id.slice(5)}_${this.toolCalls.size}`;
    const existing = this.toolCalls.get(callId);
    if (existing) return existing;
    const outputIndex = Number.isInteger(part.index) && part.index >= 0 ? part.index : this.outputCount;
    this.outputCount = Math.max(this.outputCount, outputIndex + 1);
    const item = {
      id: `fc_${crypto.randomUUID().replaceAll("-", "")}`,
      type: "function_call",
      status: "in_progress",
      call_id: callId,
      name: stringFrom(part.name) || "unknown",
      arguments: ""
    };
    const call = { item, outputIndex, arguments: "", completed: false };
    this.toolCalls.set(callId, call);
    this.output[outputIndex] = item;
    this.event("response.output_item.added", {
      type: "response.output_item.added",
      output_index: outputIndex,
      item
    });
    return call;
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

export function nonStreamingResponse(model, text, usage, toolCalls = []) {
  const id = `resp_${crypto.randomUUID().replaceAll("-", "")}`;
  const created = Math.floor(Date.now() / 1000);
  const output = toolCalls.length > 0
    ? toolCalls.map((call) => functionCallItem(call, "completed"))
    : [messageItem(id, "completed", [{ type: "output_text", text, annotations: [] }])];
  return {
    ...responseBase(id, created, model, "completed", null, usage),
    output
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

function functionCallItem(call, status) {
  return {
    id: `fc_${crypto.randomUUID().replaceAll("-", "")}`,
    type: "function_call",
    status,
    call_id: call.id,
    name: call.name,
    arguments: call.arguments || ""
  };
}

function integerOr(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
