"use strict";

const assert = require("node:assert/strict");
const { existsSync, readFileSync } = require("node:fs");
const { dirname, resolve } = require("node:path");
const test = require("node:test");

const ROOT = resolve(__dirname, "..");
const GUIDE_PATH = resolve(ROOT, "docs", "integrations", "coding-agents.md");
const GUIDE = readFileSync(GUIDE_PATH, "utf8");
const HOOKSHOT = readFileSync(resolve(ROOT, "examples", "hookshot", "README.md"), "utf8");

test("coding-agent guide covers every requested host and integration mode", () => {
  for (const heading of [
    "OpenAI Codex",
    "Claude Code",
    "Cursor",
    "Windsurf / Cascade",
    "Generic MCP clients",
    "Generic command-running agents",
    "Hookshot enforcement",
  ]) {
    assert.match(GUIDE, new RegExp(`## ${heading.replace("/", "\\/")}`));
  }
  for (const topic of [
    "Installation and configuration",
    "Minimal working example",
    "Blocking and review",
    "Removal",
    "limitations",
    "troubleshooting",
    "Security assumption",
  ]) {
    assert.match(GUIDE.toLowerCase(), new RegExp(topic.toLowerCase()));
  }
});

test("agent examples pin pkgxray and distinguish guidance from enforcement", () => {
  assert.doesNotMatch(GUIDE, /pkgxray@latest/);
  assert.match(GUIDE, /pkgxray@1\.0\.4/);
  assert.match(GUIDE, /advisory unless the host has an execution hook/);
  assert.match(
    GUIDE,
    /only integration in this repository\s+that claims command\s+interception/i
  );
  assert.match(GUIDE, /Transport errors are not SAFE/);
});

test("integration guide relative links resolve", () => {
  const missing = [];
  for (const match of GUIDE.matchAll(/!?\[[^\]]*]\(([^)]+)\)/g)) {
    const target = match[1];
    if (/^(?:https?:|mailto:|#)/i.test(target)) continue;
    const path = decodeURIComponent(target.split("#", 1)[0]);
    if (path && !existsSync(resolve(dirname(GUIDE_PATH), path))) missing.push(target);
  }
  assert.deepEqual(missing, []);
});

test("Hookshot setup is pinned, removable, and version-accurate", () => {
  assert.match(HOOKSHOT, /73584ae0e4df38105be9f892130b4c66ea6ce04e/);
  assert.match(HOOKSHOT, /npm install --global pkgxray@1\.0\.3/);
  assert.match(HOOKSHOT, /npm uninstall --global pkgxray/);
  assert.match(HOOKSHOT, /## Troubleshooting/);
  assert.match(HOOKSHOT, /## Security assumptions/);
  assert.doesNotMatch(HOOKSHOT, /pkgxray has no `--version`/);
});

test("checked-in Hookshot host configs remain valid JSON", () => {
  for (const name of [
    "claude-settings.json",
    "cursor-hooks.json",
    "codex-hooks.json",
    "cascade-hooks.json",
    "droid-settings.json",
  ]) {
    const path = resolve(ROOT, "examples", "hookshot", "configs", name);
    assert.doesNotThrow(() => JSON.parse(readFileSync(path, "utf8")), name);
  }
});
