"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { createReviewServer } = require("../review-api/server");

const TOKEN = "c".repeat(40);
function runCli(args, cwd, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, "../bin/audit.js"), ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("guard CLI flows through local authenticated API and policy adds REVIEW; no OpenAI network call", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "pkgxray-ai-review-cli-"));
  const pkg = path.join(temp, "fixture");
  await fs.mkdir(path.join(pkg, "src"), { recursive: true });
  await fs.writeFile(path.join(pkg, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0", main: "src/index.js" }));
  await fs.writeFile(path.join(pkg, "src/index.js"), 'module.exports = "payload";\n');
  await fs.writeFile(path.join(pkg, "README.md"), "A tiny synthetic fixture for offline review tests.\n");
  let providerCalls = 0;
  let sourceSeen = "";
  const server = createReviewServer({
    apiKey: "injected-test-key-not-real",
    token: TOKEN,
    model: "gpt-test-review",
    enabled: true,
    dailyLimit: 2,
    fetchImpl: async (_url, options) => {
      providerCalls++;
      const wire = JSON.parse(options.body);
      const data = JSON.parse(wire.input);
      sourceSeen = JSON.stringify(data.sources);
      const source = data.sources.find((entry) => entry.file === "src/index.js");
      return new Response(JSON.stringify({ status: "completed", output_text: JSON.stringify({ findings: [{
        category: "suspicious-runtime-flow",
        rationale: "The cited value is sent into a sensitive runtime path for human review.",
        sourceId: source.id, line: 1, quote: "payload", confidence: 0.92
      }] }) }), { status: 200 });
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const env = {
    ...process.env,
    PKGXRAY_REVIEW_URL: base,
    PKGXRAY_REVIEW_API_TOKEN: TOKEN,
    PKGXRAY_REVIEW_MODEL: "gpt-test-review",
    PKGXRAY_REVIEW_ALLOW_SOURCE_SUBMISSION: "1",
    PKGXRAY_REVIEW_TIMEOUT_MS: "8000",
    OPENAI_API_KEY: ""
  };
  try {
    const result = await runCli(["guard", pkg, "--ai-review", "--no-vulnerability-check", "--no-github", "--format", "json", "--receipt-only"], temp, env);
    assert.equal(providerCalls, 1);
    assert.match(result.stderr, /AI review pending/);
    assert.equal(result.code, 3);
    const report = JSON.parse(result.stdout);
    assert.equal(report.aiReview.status, "completed");
    assert.equal(report.aiReview.findings.length, 1);
    assert.equal(report.aiReview.findings[0].severity, "medium");
    assert.equal(report.aiReview.enforcement, "review-hold");
    assert.equal(report.decision, "review");
    assert.ok(report.report.findings.some((finding) => finding.category === "ai-review"));
    assert.match(sourceSeen, /src\/index\.js/);
    assert.ok(!result.stdout.includes(TOKEN));
    assert.ok(!result.stdout.includes("injected-test-key-not-real"));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(temp, { recursive: true, force: true });
  }
});
