"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  PROVIDERS,
  listProviders,
  getProvider,
  detectProvider,
  resolveProvider,
  detectAvailableProvider,
  reasoningSetupHint
} = require("../src/providers");

test("ships three providers", () => {
  assert.deepEqual(listProviders().sort(), ["anthropic", "gemini", "openai"]);
});

test("getProvider returns the named provider", () => {
  assert.equal(getProvider("anthropic").name, "anthropic");
  assert.equal(getProvider("openai").name, "openai");
  assert.equal(getProvider("gemini").name, "gemini");
});

test("getProvider throws on unknown name", () => {
  assert.throws(() => getProvider("ollama"), /Unknown provider/);
});

test("detectProvider routes by model prefix", () => {
  assert.equal(detectProvider("claude-opus-4-7").name, "anthropic");
  assert.equal(detectProvider("claude-sonnet-4-6").name, "anthropic");
  assert.equal(detectProvider("gpt-5").name, "openai");
  assert.equal(detectProvider("gpt-4o").name, "openai");
  assert.equal(detectProvider("o3-mini").name, "openai");
  assert.equal(detectProvider("chatgpt-4o-latest").name, "openai");
  assert.equal(detectProvider("gemini-2.5-pro").name, "gemini");
  assert.equal(detectProvider("gemini-2.5-flash").name, "gemini");
  assert.equal(detectProvider("mistral-large"), null);
  assert.equal(detectProvider(undefined), null);
});

test("resolveProvider prefers explicit provider over model detection", () => {
  assert.equal(resolveProvider({ provider: "openai", model: "claude-opus-4-7" }).name, "openai");
});

test("resolveProvider falls back to anthropic when nothing matches", () => {
  assert.equal(resolveProvider({}).name, "anthropic");
  assert.equal(resolveProvider({ model: "mistral-large" }).name, "anthropic");
});

test("each provider declares its required env key", () => {
  assert.equal(PROVIDERS.anthropic.envKey, "ANTHROPIC_API_KEY");
  assert.equal(PROVIDERS.openai.envKey, "OPENAI_API_KEY");
  assert.equal(PROVIDERS.gemini.envKey, "GEMINI_API_KEY");
});

test("each provider declares a default model", () => {
  assert.equal(PROVIDERS.anthropic.defaultModel, "claude-opus-4-7");
  assert.equal(PROVIDERS.openai.defaultModel, "gpt-5");
  assert.equal(PROVIDERS.gemini.defaultModel, "gemini-2.5-pro");
});

test("detectAvailableProvider returns null when no key set", () => {
  const saved = {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY
  };
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  try {
    assert.equal(detectAvailableProvider(), null);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v !== undefined) process.env[k] = v;
    }
  }
});

test("reasoningSetupHint mentions all env vars when none set", () => {
  const saved = {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY
  };
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  try {
    const hint = reasoningSetupHint();
    assert.match(hint, /ANTHROPIC_API_KEY/);
    assert.match(hint, /OPENAI_API_KEY/);
    assert.match(hint, /GEMINI_API_KEY/);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v !== undefined) process.env[k] = v;
    }
  }
});
