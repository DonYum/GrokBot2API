import { AppError } from "./errors.mjs";

export function varint(value) {
  let current = BigInt(value);
  if (current < 0n) throw new AppError("negative_varint", "Negative varint", 500);
  const out = [];
  do {
    let byte = Number(current & 0x7fn);
    current >>= 7n;
    if (current !== 0n) byte |= 0x80;
    out.push(byte);
  } while (current !== 0n);
  return Buffer.from(out);
}

export function protoField(number, wireType, value) {
  const key = varint((BigInt(number) << 3n) | BigInt(wireType));
  if (wireType === 0) return Buffer.concat([key, varint(value)]);
  if (wireType === 2) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8");
    return Buffer.concat([key, varint(bytes.length), bytes]);
  }
  throw new AppError("unsupported_encode_wire_type", `Unsupported protobuf wire type ${wireType}`, 500);
}

export function protoMessage(fields) {
  return Buffer.concat(fields);
}

export function connectEnvelope(message, flags = 0) {
  const header = Buffer.alloc(5);
  header[0] = flags;
  header.writeUInt32BE(message.length, 1);
  return Buffer.concat([header, message]);
}

export function coreMessage(role, text) {
  return protoMessage([protoField(1, 0, role), protoField(2, 2, text)]);
}

export function modelParameter(id, value) {
  return protoMessage([protoField(1, 2, id), protoField(2, 2, value)]);
}

export function buildInferenceRequest(input) {
  const requestedModel = protoMessage([
    protoField(1, 2, input.upstreamModel),
    protoField(2, 0, 1),
    ...modelParameters(input.parameters).map(([id, value]) => protoField(3, 2, modelParameter(id, value)))
  ]);
  const modelConfig = protoMessage([protoField(1, 0, input.maxTokens || 4096)]);
  return protoMessage([
    ...input.messages.map((message) => protoField(1, 2, coreMessage(roleNumber(message.role), message.text))),
    protoField(4, 2, modelConfig),
    protoField(6, 2, input.invocationId),
    protoField(7, 2, requestedModel),
    protoField(8, 2, input.conversationId)
  ]);
}

function modelParameters(parameters = {}) {
  return Object.entries(parameters).flatMap(([id, value]) => {
    if (typeof value === "boolean") return [[id, value ? "true" : "false"]];
    if (typeof value === "number" && Number.isFinite(value)) return [[id, String(value)]];
    if (typeof value === "string" && value) return [[id, value]];
    return [];
  });
}

function roleNumber(role) {
  if (role === "assistant") return 2;
  if (role === "system" || role === "developer") return 4;
  return 1;
}

export function readVarint(bytes, start) {
  let value = 0n;
  let shift = 0n;
  let offset = start;
  while (offset < bytes.length) {
    const byte = bytes[offset++];
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, offset };
    shift += 7n;
    if (shift > 63n) throw new AppError("varint_too_long", "Varint too long", 502);
  }
  throw new AppError("truncated_varint", "Truncated varint", 502);
}

export function parseProto(bytes) {
  const fields = [];
  let offset = 0;
  while (offset < bytes.length) {
    const key = readVarint(bytes, offset);
    offset = key.offset;
    const number = Number(key.value >> 3n);
    const wireType = Number(key.value & 7n);
    if (wireType === 0) {
      const item = readVarint(bytes, offset);
      offset = item.offset;
      fields.push({ number, wireType, value: item.value });
    } else if (wireType === 2) {
      const size = readVarint(bytes, offset);
      offset = size.offset;
      const end = offset + Number(size.value);
      if (end > bytes.length) throw new AppError("truncated_length_field", "Truncated length field", 502);
      fields.push({ number, wireType, value: bytes.subarray(offset, end) });
      offset = end;
    } else if (wireType === 1) {
      if (offset + 8 > bytes.length) throw new AppError("truncated_fixed64", "Truncated fixed64", 502);
      fields.push({ number, wireType, value: bytes.subarray(offset, offset + 8) });
      offset += 8;
    } else if (wireType === 5) {
      if (offset + 4 > bytes.length) throw new AppError("truncated_fixed32", "Truncated fixed32", 502);
      fields.push({ number, wireType, value: bytes.subarray(offset, offset + 4) });
      offset += 4;
    } else {
      throw new AppError("unsupported_decode_wire_type", `Unsupported protobuf wire type ${wireType}`, 502);
    }
  }
  return fields;
}

export function decodeResponseFrame(bytes, state = emptyDecodeState()) {
  for (const response of parseProto(bytes)) {
    if (response.wireType !== 2) continue;
    state.kinds.add(response.number);
    const nested = parseProto(response.value);
    if (response.number === 1) {
      const text = nested.find((field) => field.number === 1 && field.wireType === 2);
      if (text) {
        const delta = utf8(text);
        state.text += delta;
        state.deltas.push(delta);
      }
    } else if (response.number === 2) {
      state.toolCallFrames += 1;
    } else if (response.number === 3) {
      const usage = numericFields(response.value);
      state.usage = {
        inputTokens: usage[1] ?? 0,
        outputTokens: usage[2] ?? 0,
        totalTokens: usage[3] ?? (usage[1] ?? 0) + (usage[2] ?? 0)
      };
    } else if (response.number === 4) {
      const model = nested.find((field) => field.number === 2 && field.wireType === 2);
      const error = nested.find((field) => field.number === 5 && field.wireType === 2);
      if (model) state.upstreamModel = utf8(model);
      if (error && utf8(error).length > 0) state.errors.push({ code: "response_info_error", message: utf8(error), type: 0 });
    } else if (response.number === 5) {
      const usage = numericFields(response.value);
      state.extendedUsage = {
        inputTokens: usage[1] ?? 0,
        outputTokens: usage[2] ?? 0,
        cacheReadTokens: usage[3] ?? 0,
        cacheWriteTokens: usage[4] ?? 0,
        maxTokens: usage[5] ?? 0
      };
    } else if (response.number === 8) {
      const code = nested.find((field) => field.number === 2 && field.wireType === 2);
      const errorType = nested.find((field) => field.number === 5 && field.wireType === 0);
      state.errors.push({
        code: code ? utf8(code).slice(0, 120) : "stream_error",
        type: errorType ? Number(errorType.value) : 0
      });
    } else if (response.number === 9) {
      state.thinkingFrames += 1;
    }
  }
  return state;
}

export function emptyDecodeState() {
  return {
    frames: 0,
    endFrames: 0,
    kinds: new Set(),
    deltas: [],
    text: "",
    usage: null,
    extendedUsage: null,
    upstreamModel: null,
    toolCallFrames: 0,
    thinkingFrames: 0,
    errors: []
  };
}

export class ConnectFrameDecoder {
  constructor() {
    this.buffer = Buffer.alloc(0);
  }

  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    const frames = [];
    while (this.buffer.length >= 5) {
      const flags = this.buffer[0];
      const length = this.buffer.readUInt32BE(1);
      if (this.buffer.length < 5 + length) break;
      const payload = this.buffer.subarray(5, 5 + length);
      this.buffer = this.buffer.subarray(5 + length);
      frames.push({ flags, payload });
    }
    return frames;
  }

  finish() {
    if (this.buffer.length !== 0) throw new AppError("truncated_connect_frame", "Truncated Connect frame", 502);
  }
}

export function applyConnectFrame(frame, state) {
  state.frames += 1;
  if ((frame.flags & 0x01) !== 0) throw new AppError("compressed_connect_frame_unsupported", "Compressed Connect frame unsupported", 502);
  if ((frame.flags & 0x02) !== 0) {
    state.endFrames += 1;
    if (frame.payload.length > 0) {
      let end;
      try {
        end = JSON.parse(frame.payload.toString("utf8"));
      } catch {
        throw new AppError("invalid_connect_end_frame", "Invalid Connect end frame", 502);
      }
      if (end?.error) state.errors.push({ code: String(end.error.code || "connect_end_error"), message: String(end.error.message || ""), type: 0 });
    }
    return [];
  }
  const before = state.deltas.length;
  decodeResponseFrame(frame.payload, state);
  return state.deltas.slice(before);
}

function utf8(field) {
  return Buffer.from(field.value).toString("utf8");
}

function numericFields(bytes) {
  return Object.fromEntries(
    parseProto(bytes)
      .filter((field) => field.wireType === 0)
      .map((field) => [field.number, Number(field.value)])
  );
}
