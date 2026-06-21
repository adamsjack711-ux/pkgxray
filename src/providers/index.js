"use strict";

const anthropic = require("./anthropic");
const openai = require("./openai");
const gemini = require("./gemini");

const PROVIDERS = { anthropic, openai, gemini };

function listProviders() {
  return Object.keys(PROVIDERS);
}

function getProvider(name) {
  const provider = PROVIDERS[name];
  if (!provider) {
    const error = new Error(`Unknown provider: ${name}. Available: ${listProviders().join(", ")}`);
    error.code = "REASONER_UNKNOWN_PROVIDER";
    throw error;
  }
  return provider;
}

function detectProvider(modelId) {
  if (!modelId) return null;
  for (const provider of Object.values(PROVIDERS)) {
    if (provider.detect(modelId)) return provider;
  }
  return null;
}

function resolveProvider({ provider, model } = {}) {
  if (provider) return getProvider(provider);
  if (model) {
    const detected = detectProvider(model);
    if (detected) return detected;
  }
  return anthropic;
}

function tryLoadSdk(provider) {
  try {
    if (typeof provider._loadSdk === "function") {
      provider._loadSdk();
      return true;
    }
    // Each provider lazy-loads inside call(); fall back to a probe require here.
    if (provider.name === "anthropic") require("@anthropic-ai/sdk");
    else if (provider.name === "openai") require("openai");
    else if (provider.name === "gemini") require("@google/generative-ai");
    return true;
  } catch (error) {
    return false;
  }
}

function detectAvailableProvider() {
  // Priority order: anthropic, openai, gemini. First one with both env key set
  // AND SDK loadable wins.
  for (const name of ["anthropic", "openai", "gemini"]) {
    const provider = PROVIDERS[name];
    const keyPresent = Boolean(process.env[provider.envKey]);
    if (!keyPresent) continue;
    if (!tryLoadSdk(provider)) continue;
    return provider;
  }
  return null;
}

function reasoningSetupHint() {
  const missing = [];
  for (const name of ["anthropic", "openai", "gemini"]) {
    const provider = PROVIDERS[name];
    if (process.env[provider.envKey]) {
      if (!tryLoadSdk(provider)) {
        const pkg = provider.name === "anthropic"
          ? "@anthropic-ai/sdk"
          : provider.name === "openai"
            ? "openai"
            : "@google/generative-ai";
        return `${provider.envKey} is set but ${pkg} is not installed. Run: npm install -g ${pkg}`;
      }
    } else {
      missing.push(provider.envKey);
    }
  }
  return `For LLM-grade verdicts, set one of ${missing.join(" / ")} and install the matching SDK (@anthropic-ai/sdk, openai, or @google/generative-ai).`;
}

module.exports = {
  PROVIDERS,
  listProviders,
  getProvider,
  detectProvider,
  resolveProvider,
  detectAvailableProvider,
  reasoningSetupHint
};
