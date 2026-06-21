"use strict";

const DEFAULT_MODEL = "gpt-5";
const ENV_KEY = "OPENAI_API_KEY";

function detect(modelId) {
  if (typeof modelId !== "string") return false;
  return /^(gpt-|o\d|chatgpt-)/i.test(modelId);
}

function loadSdk() {
  try {
    const mod = require("openai");
    return mod.default || mod.OpenAI || mod;
  } catch (error) {
    if (error && error.code === "MODULE_NOT_FOUND") {
      const hint = new Error(
        "OpenAI provider needs the openai package. Install with: npm install openai"
      );
      hint.code = "REASONER_SDK_MISSING";
      throw hint;
    }
    throw error;
  }
}

async function call({ systemPrompt, userMessage, schema, model, apiKey, maxTokens }) {
  const OpenAI = loadSdk();
  const client = new OpenAI({ apiKey });
  const chosenModel = model || DEFAULT_MODEL;
  const start = Date.now();
  const completion = await client.chat.completions.create({
    model: chosenModel,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage }
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "supply_chain_verdict",
        strict: true,
        schema
      }
    },
    max_completion_tokens: maxTokens || 16000
  });
  const latencyMs = Date.now() - start;
  const choice = completion.choices && completion.choices[0];
  if (!choice || !choice.message || typeof choice.message.content !== "string") {
    const error = new Error("OpenAI response had no message content");
    error.code = "REASONER_NO_TEXT";
    throw error;
  }
  const usage = completion.usage
    ? {
        input_tokens: completion.usage.prompt_tokens,
        output_tokens: completion.usage.completion_tokens,
        cache_read_input_tokens:
          (completion.usage.prompt_tokens_details &&
            completion.usage.prompt_tokens_details.cached_tokens) ||
          0,
        cache_creation_input_tokens: 0
      }
    : null;
  return {
    text: choice.message.content,
    usage,
    model: chosenModel,
    latencyMs,
    stopReason: choice.finish_reason || null
  };
}

module.exports = { name: "openai", defaultModel: DEFAULT_MODEL, envKey: ENV_KEY, detect, call };
