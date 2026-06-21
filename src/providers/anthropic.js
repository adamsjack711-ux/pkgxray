"use strict";

const DEFAULT_MODEL = "claude-opus-4-7";
const ENV_KEY = "ANTHROPIC_API_KEY";

function detect(modelId) {
  return typeof modelId === "string" && modelId.startsWith("claude-");
}

function loadSdk() {
  try {
    const mod = require("@anthropic-ai/sdk");
    return mod.default || mod;
  } catch (error) {
    if (error && error.code === "MODULE_NOT_FOUND") {
      const hint = new Error(
        "Anthropic provider needs @anthropic-ai/sdk. Install with: npm install @anthropic-ai/sdk"
      );
      hint.code = "REASONER_SDK_MISSING";
      throw hint;
    }
    throw error;
  }
}

async function call({ systemPrompt, userMessage, schema, model, apiKey, maxTokens, effort }) {
  const Anthropic = loadSdk();
  const client = new Anthropic({ apiKey });
  const chosenModel = model || DEFAULT_MODEL;
  const start = Date.now();
  const response = await client.messages.create({
    model: chosenModel,
    max_tokens: maxTokens || 16000,
    thinking: { type: "adaptive" },
    output_config: {
      effort: effort || "high",
      format: { type: "json_schema", schema }
    },
    system: [
      {
        type: "text",
        text: systemPrompt,
        cache_control: { type: "ephemeral" }
      }
    ],
    messages: [{ role: "user", content: userMessage }]
  });
  const latencyMs = Date.now() - start;
  const textBlock = response.content.find((block) => block.type === "text");
  if (!textBlock) {
    const error = new Error("Anthropic response had no text content");
    error.code = "REASONER_NO_TEXT";
    throw error;
  }
  return {
    text: textBlock.text,
    usage: response.usage || null,
    model: chosenModel,
    latencyMs,
    stopReason: response.stop_reason || null
  };
}

module.exports = { name: "anthropic", defaultModel: DEFAULT_MODEL, envKey: ENV_KEY, detect, call };
