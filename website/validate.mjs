#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const ORIGIN = "https://pkgxray.ca";
const errors = [];

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

const files = walk(ROOT);
const htmlFiles = files.filter((file) => extname(file) === ".html");
const rel = (file) => relative(ROOT, file).split(sep).join("/");
const fail = (file, message) => errors.push(`${rel(file)}: ${message}`);

for (const file of files.filter((candidate) => [".html", ".js", ".mjs"].includes(extname(candidate)))) {
  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(/\b(href|src)\s*=/gi)) {
    const remainder = source.slice(match.index + match[0].length);
    if (!/^\s*(["'])/.test(remainder)) {
      fail(file, `malformed ${match[1]} attribute near byte ${match.index}`);
    }
  }
}

function pageForPath(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const clean = decoded.replace(/^\/+/, "");
  const candidates = [];
  if (!clean || clean.endsWith("/")) candidates.push(join(ROOT, clean, "index.html"));
  candidates.push(join(ROOT, clean));
  if (!extname(clean)) candidates.push(join(ROOT, `${clean}.html`));
  return candidates.find((candidate) => existsSync(candidate)) || null;
}

function checkUrl(file, value, attribute) {
  if (!value) {
    fail(file, `${attribute} must not be empty`);
    return;
  }
  if (/\s/.test(value)) {
    fail(file, `${attribute} contains whitespace: ${JSON.stringify(value)}`);
    return;
  }
  if (/^javascript:/i.test(value)) {
    fail(file, `${attribute} uses a javascript: URL`);
    return;
  }
  if (/^(?:mailto:|tel:|data:)/i.test(value)) return;

  let url;
  try {
    const basePath = `/${rel(file)}`;
    url = new URL(value, new URL(basePath, `${ORIGIN}/`));
  } catch {
    fail(file, `invalid ${attribute} URL: ${JSON.stringify(value)}`);
    return;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    fail(file, `unsupported ${attribute} protocol: ${url.protocol}`);
    return;
  }
  if (url.origin !== ORIGIN) return;

  const target = pageForPath(url.pathname);
  if (!target) {
    fail(file, `${attribute} target does not exist: ${value}`);
    return;
  }
  if (url.hash && extname(target) === ".html") {
    const id = decodeURIComponent(url.hash.slice(1));
    const targetHtml = readFileSync(target, "utf8");
    const ids = new Set(
      [...targetHtml.matchAll(/\bid\s*=\s*(["'])(.*?)\1/gis)].map((match) => match[2])
    );
    if (!ids.has(id)) fail(file, `${attribute} fragment does not exist: ${value}`);
  }
}

for (const file of htmlFiles) {
  const html = readFileSync(file, "utf8");
  if (!/^<!doctype html>/i.test(html)) fail(file, "missing HTML5 doctype");
  if (!/<html\b[^>]*\blang\s*=/i.test(html)) fail(file, "html element needs a lang attribute");
  for (const element of ["head", "title", "body"]) {
    if (!new RegExp(`<${element}\\b`, "i").test(html)) fail(file, `missing <${element}>`);
  }
  if (!/<meta\b[^>]*\bname\s*=\s*(["'])description\1/i.test(html)) {
    fail(file, "missing meta description");
  }

  const ids = [...html.matchAll(/\bid\s*=\s*(["'])(.*?)\1/gis)].map((match) => match[2]);
  for (const id of new Set(ids.filter((id, index) => ids.indexOf(id) !== index))) {
    fail(file, `duplicate id: ${id}`);
  }

  const canonicalMatches = [
    ...html.matchAll(/<link\b[^>]*\brel\s*=\s*(["'])canonical\1[^>]*>/gis),
  ];
  if (canonicalMatches.length !== 1) {
    fail(file, `expected one canonical link, found ${canonicalMatches.length}`);
  }

  const tags = html.match(/<(?:a|link|script|img|video|source)\b[^>]*>/gis) || [];
  for (const tag of tags) {
    const assignments = [...tag.matchAll(/\b(href|src|poster)\s*=/gi)];
    const attributes = [
      ...tag.matchAll(/\b(href|src|poster)\s*=\s*(["'])(.*?)\2/gis),
    ];
    if (assignments.length !== attributes.length) {
      fail(file, `malformed href/src/poster attribute in ${tag.replace(/\s+/g, " ")}`);
      continue;
    }
    for (const [, attribute, , value] of attributes) checkUrl(file, value, attribute);
  }

  const canonical = html.match(
    /<link\b[^>]*\brel\s*=\s*(["'])canonical\1[^>]*\bhref\s*=\s*(["'])(.*?)\2/is
  );
  if (canonical && !canonical[3].startsWith(`${ORIGIN}/`)) {
    fail(file, `canonical must use ${ORIGIN}: ${canonical[3]}`);
  }

  for (const property of ["og:url", "og:image", "twitter:image"]) {
    const escaped = property.replace(":", "\\:");
    const match = html.match(
      new RegExp(
        `<meta\\b[^>]*(?:property|name)\\s*=\\s*([\"'])${escaped}\\1[^>]*\\bcontent\\s*=\\s*([\"'])(.*?)\\2`,
        "is"
      )
    );
    if (!match || !match[3].startsWith(`${ORIGIN}/`)) {
      fail(file, `${property} must use ${ORIGIN}`);
    }
  }
}

for (const file of files.filter((candidate) => extname(candidate) === ".css")) {
  const css = readFileSync(file, "utf8");
  for (const match of css.matchAll(/url\(\s*(["']?)(.*?)\1\s*\)/gis)) {
    const value = match[2];
    if (/^(?:data:|https?:)/i.test(value)) continue;
    const target = resolve(dirname(file), value.split(/[?#]/, 1)[0]);
    if (!existsSync(target)) fail(file, `CSS asset does not exist: ${value}`);
  }
}

const dataDir = join(ROOT, "stats", "data");
const runFiles = readdirSync(dataDir).filter((name) =>
  /^\d{4}-\d{2}-\d{2}(?:-[a-z0-9-]+)?\.json$/.test(name)
);
if (!runFiles.length) errors.push("stats/data: no calibration artifacts found");

for (const name of runFiles) {
  const source = readFileSync(join(dataDir, name), "utf8");
  const run = JSON.parse(source);
  const html = join(ROOT, "stats", `${run.runId}.html`);
  const publishedJson = join(ROOT, "stats", `${run.runId}.json`);
  if (!existsSync(html)) errors.push(`stats: missing generated page for ${run.runId}`);
  if (!existsSync(publishedJson)) errors.push(`stats: missing published JSON for ${run.runId}`);
  else if (readFileSync(publishedJson, "utf8") !== source) {
    errors.push(`stats/${run.runId}.json: generated copy is stale`);
  }
  if (!pageForPath(run.methodologyUrl)) {
    errors.push(`${rel(join(dataDir, name))}: methodologyUrl does not exist`);
  }
  for (const [field, value] of [
    ["reproInputs", run.reproInputs],
    ["corrections.contact", run.corrections?.contact],
  ]) {
    try {
      new URL(value);
    } catch {
      errors.push(`${rel(join(dataDir, name))}: ${field} is not a valid absolute URL`);
    }
  }
  // Denominator composition must stay internally consistent so the "5,000"
  // story cannot silently drift out of sync across pages again (item 2 / 39).
  if (run.scope && Array.isArray(run.scope.denominator)) {
    const sum = run.scope.denominator.reduce((n, d) => n + (Number(d.count) || 0), 0);
    if (sum !== run.scope.denominatorTotal) {
      errors.push(
        `${rel(join(dataDir, name))}: scope.denominator sums to ${sum}, not denominatorTotal ${run.scope.denominatorTotal}`
      );
    }
    if (run.scope.denominatorTotal !== run.headline?.packagesScanned) {
      errors.push(
        `${rel(join(dataDir, name))}: scope.denominatorTotal ${run.scope.denominatorTotal} != headline.packagesScanned ${run.headline?.packagesScanned}`
      );
    }
    for (const entry of [...run.scope.denominator, ...(run.scope.separateSets || [])]) {
      try {
        new URL(entry.source);
      } catch {
        errors.push(
          `${rel(join(dataDir, name))}: scope source is not a valid absolute URL: ${JSON.stringify(entry.source)}`
        );
      }
    }
  }
}

for (const required of ["stats/index.html", "stats/methodology.html", "assets/og.jpg"]) {
  if (!existsSync(join(ROOT, required))) errors.push(`${required}: required generated file is missing`);
}

// Security headers must not silently regress (item 28).
const headersPath = join(ROOT, "_headers");
if (!existsSync(headersPath)) {
  errors.push("_headers: file is missing");
} else {
  const headers = readFileSync(headersPath, "utf8");
  for (const header of [
    "Content-Security-Policy",
    "Strict-Transport-Security",
    "Permissions-Policy",
    "X-Content-Type-Options",
    "X-Frame-Options",
    "Referrer-Policy",
  ]) {
    if (!new RegExp(`^\\s*${header}\\s*:`, "im").test(headers)) {
      errors.push(`_headers: missing required security header ${header}`);
    }
  }
}

if (errors.length) {
  console.error(`Website validation failed with ${errors.length} error(s):`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(
  `Website validation passed: ${htmlFiles.length} HTML pages, ${runFiles.length} calibration runs.`
);
