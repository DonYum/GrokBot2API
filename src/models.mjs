export const DEFAULT_MODEL_ID = "grok-4.5";

export const MODEL_CATALOG = [
  model("grok-4.6", "Cursor Grok 4.6", "grokbot2api", 256000, {
    verification: "catalog_entitled",
    experimental: true,
    supportsImage: true,
    effortParameter: "effort",
    efforts: ["low", "medium", "high", "xhigh"],
    fast: true,
    defaults: { effort: "high", fast: true }
  }),
  model("grok-4.5", "Cursor Grok 4.5", "grokbot2api", 256000, {
    verification: "verified",
    experimental: false,
    supportsImage: true,
    effortParameter: "effort",
    efforts: ["low", "medium", "high"],
    fast: true,
    defaults: { effort: "high", fast: true }
  }),
  model("composer-2.5", "Composer 2.5", "cursor", 200000, {
    verification: "catalog_entitled",
    experimental: true,
    supportsImage: false,
    fast: true,
    defaults: { fast: true }
  }),
  model("claude-opus-5", "Claude Opus 5", "anthropic", 300000, anthropicThinking({ fast: true })),
  model("claude-opus-4-8", "Claude Opus 4.8", "anthropic", 300000, anthropicThinking({ fast: true })),
  model("claude-fable-5", "Claude Fable 5", "anthropic", 300000, anthropicThinking()),
  model("claude-sonnet-5", "Claude Sonnet 5", "anthropic", 300000, anthropicThinking()),
  model("claude-sonnet-4-6", "Claude Sonnet 4.6", "anthropic", 1000000, anthropicThinking()),
  model("claude-opus-4-7", "Claude Opus 4.7", "anthropic", 300000, anthropicThinking({ fast: true })),
  model("claude-opus-4-6", "Claude Opus 4.6", "anthropic", 1000000, anthropicThinking()),
  model("claude-opus-4-5", "Claude Opus 4.5", "anthropic", 200000, anthropicThinking({ efforts: [], contexts: [] })),
  model("claude-haiku-4-5", "Claude Haiku 4.5", "anthropic", 200000, anthropicThinking({ efforts: [], contexts: [] })),
  model("claude-sonnet-4-5", "Claude Sonnet 4.5", "anthropic", 200000, anthropicThinking({ efforts: [], contexts: [200000] })),
  model("claude-sonnet-4", "Claude Sonnet 4", "anthropic", 200000, anthropicThinking({ efforts: [], contexts: [200000] })),
  model("gpt-5.6-sol", "GPT-5.6 Sol", "openai", 272000, openAiReasoning({ contexts: [272000, 1000000] })),
  model("gpt-5.6-terra", "GPT-5.6 Terra", "openai", 272000, openAiReasoning({ contexts: [272000, 1000000] })),
  model("gpt-5.6-luna", "GPT-5.6 Luna", "openai", 272000, openAiReasoning({ contexts: [272000, 1000000] })),
  model("gpt-5.5", "GPT-5.5", "openai", 272000, openAiReasoning({ efforts: ["none", "low", "medium", "high", "extra-high"], contexts: [272000, 1000000] })),
  model("gpt-5.4", "GPT-5.4", "openai", 1000000, openAiReasoning({ efforts: ["none", "low", "medium", "high", "extra-high"], contexts: [272000, 1000000] })),
  model("gpt-5.4-mini", "GPT-5.4 Mini", "openai", 272000, openAiReasoning({ efforts: ["none", "low", "medium", "high", "xhigh"], fast: false })),
  model("gpt-5.4-nano", "GPT-5.4 Nano", "openai", 272000, openAiReasoning({ efforts: ["none", "low", "medium", "high", "xhigh"], fast: false })),
  model("gpt-5.3-codex", "GPT-5.3 Codex", "openai", 272000, openAiReasoning({ efforts: ["low", "medium", "high", "extra-high"] })),
  model("gpt-5.2", "GPT-5.2", "openai", 272000, openAiReasoning({ efforts: ["low", "medium", "high", "extra-high"] })),
  model("gpt-5.1", "GPT-5.1", "openai", 272000, openAiReasoning({ efforts: ["low", "medium", "high"], fast: false })),
  model("gpt-5-mini", "GPT-5 Mini", "openai", 272000, { verification: "catalog_entitled", experimental: true, supportsImage: true }),
  model("gemini-3.7-flash", "Gemini 3.7 Flash", "google", 1000000, {
    verification: "catalog_entitled",
    experimental: true,
    supportsImage: true,
    effortParameter: "effort",
    efforts: ["low", "medium", "high"]
  }),
  model("gemini-3.6-flash", "Gemini 3.6 Flash", "google", 1000000, {
    verification: "catalog_entitled",
    experimental: true,
    supportsImage: true,
    effortParameter: "effort",
    efforts: ["minimal", "low", "medium", "high"]
  }),
  model("gemini-3.5-flash", "Gemini 3.5 Flash", "google", 1000000, { verification: "catalog_entitled", experimental: true, supportsImage: true }),
  model("gemini-3.1-pro", "Gemini 3.1 Pro", "google", 1000000, { verification: "catalog_entitled", experimental: true, supportsImage: true }),
  model("gemini-3-flash", "Gemini 3 Flash", "google", 1000000, { verification: "catalog_entitled", experimental: true, supportsImage: true }),
  model("gemini-2.5-flash", "Gemini 2.5 Flash", "google", 1000000, { verification: "catalog_entitled", experimental: true, supportsImage: true }),
  model("kimi-k3", "Kimi K3", "moonshot", 1048576, {
    verification: "catalog_entitled",
    experimental: true,
    supportsImage: true,
    effortParameter: "reasoning",
    efforts: ["low", "high", "max"]
  }),
  model("kimi-k2.7-code", "Kimi K2.7 Code", "moonshot", 262000, { verification: "catalog_entitled", experimental: true, supportsImage: false }),
  model("glm-5.2", "GLM 5.2", "zai", 1000000, {
    verification: "catalog_entitled",
    experimental: true,
    supportsImage: true,
    effortParameter: "reasoning",
    efforts: ["high", "max"]
  })
];

export const MODEL_BY_ID = new Map(MODEL_CATALOG.map((item) => [item.id, item]));

export function modelById(id) {
  return MODEL_BY_ID.get(String(id || "").trim()) || null;
}

export function modelList() {
  return MODEL_CATALOG.map((item) => ({
    id: item.id,
    object: "model",
    created: 0,
    owned_by: item.ownedBy,
    display_name: item.displayName,
    metadata: modelMetadata(item)
  }));
}

export function modelMetadata(item) {
  return {
    verification: item.verification,
    status: item.experimental ? "experimental" : "enabled",
    catalog_status: item.verification === "verified" ? "verified" : "catalog_entitled",
    context_window: item.contextWindow,
    supports_agent: true,
    supports_thinking: true,
    supports_image: item.supportsImage,
    parameters: {
      ...(item.effortParameter && item.efforts?.length ? { [item.effortParameter]: item.efforts } : {}),
      ...(item.fast ? { fast: [false, true] } : {}),
      ...(item.thinking ? { thinking: [false, true] } : {}),
      ...(item.contexts?.length ? { context: item.contexts } : {})
    },
    defaults: item.defaults || {}
  };
}

function model(id, displayName, ownedBy, contextWindow, options = {}) {
  return {
    id,
    displayName,
    ownedBy,
    contextWindow,
    verification: options.verification || "catalog_entitled",
    experimental: options.experimental !== false,
    supportsImage: options.supportsImage !== false,
    effortParameter: options.effortParameter,
    efforts: options.efforts || [],
    fast: options.fast === true,
    thinking: options.thinking === true,
    contexts: options.contexts || [],
    defaults: options.defaults || {}
  };
}

function anthropicThinking(options = {}) {
  return {
    verification: "catalog_entitled",
    experimental: true,
    supportsImage: true,
    thinking: true,
    effortParameter: "effort",
    efforts: options.efforts ?? ["low", "medium", "high", "max"],
    fast: options.fast === true,
    contexts: options.contexts ?? [200000, 1000000]
  };
}

function openAiReasoning(options = {}) {
  return {
    verification: "catalog_entitled",
    experimental: true,
    supportsImage: true,
    effortParameter: "reasoning",
    efforts: options.efforts || ["none", "low", "medium", "high", "max"],
    fast: options.fast !== false,
    contexts: options.contexts || []
  };
}
