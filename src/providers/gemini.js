"use strict";

const DEFAULT_MODEL = "gemini-2.5-pro";
const ENV_KEY = "GEMINI_API_KEY";

function detect(modelId) {
  return typeof modelId === "string" && /^gemini-/i.test(modelId);
}

function loadSdk() {
  try {
    return require("@google/generative-ai");
  } catch (error) {
    if (error && error.code === "MODULE_NOT_FOUND") {
      const hint = new Error(
        "Gemini provider needs @google/generative-ai. Install with: npm install @google/generative-ai"
      );
      hint.code = "REASONER_SDK_MISSING";
      throw hint;
    }
    throw error;
  }
}

async function call({ systemPrompt, userMessage, schema, model, apiKey, maxTokens }) {
  const { GoogleGenerativeAI } = loadSdk();
  const genAI = new GoogleGenerativeAI(apiKey || process.env[ENV_KEY] || process.env.GOOGLE_API_KEY);
  const chosenModel = model || DEFAULT_MODEL;
  const generative = genAI.getGenerativeModel({
    model: chosenModel,
    systemInstruction: systemPrompt,
    generationConfig: {
      responseMimeType: "application/json",
      maxOutputTokens: maxTokens || 16000
    }
  });
  const start = Date.now();
  const result = await generative.generateContent(userMessage);
  const latencyMs = Date.now() - start;
  const response = result.response;
  const text = typeof response.text === "function" ? response.text() : "";
  if (!text) {
    const error = new Error("Gemini response had no text content");
    error.code = "REASONER_NO_TEXT";
    throw error;
  }
  const meta = response.usageMetadata || {};
  const usage = {
    input_tokens: meta.promptTokenCount || 0,
    output_tokens: meta.candidatesTokenCount || 0,
    cache_read_input_tokens: meta.cachedContentTokenCount || 0,
    cache_creation_input_tokens: 0
  };
  const finishReason =
    response.candidates && response.candidates[0] && response.candidates[0].finishReason;
  return {
    text,
    usage,
    model: chosenModel,
    latencyMs,
    stopReason: finishReason || null,
    schemaHint: schema ? "schema enforced via prompt only on Gemini" : null
  };
}

module.exports = { name: "gemini", defaultModel: DEFAULT_MODEL, envKey: ENV_KEY, detect, call };
