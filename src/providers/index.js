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

module.exports = { PROVIDERS, listProviders, getProvider, detectProvider, resolveProvider };
