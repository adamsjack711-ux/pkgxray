"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");

const cacheClient = require("../src/cache-client");
const github = require("../src/github");

test("parseGithubRepo accepts documented GitHub forms and rejects lookalikes", () => {
  const expected = { owner: "owner", repo: "repo" };
  for (const repository of [
    "github:owner/repo",
    "https://github.com/owner/repo",
    "git+https://github.com/owner/repo.git",
    "git://github.com/owner/repo.git",
    "git@github.com:owner/repo.git",
    "git+ssh://git@github.com/owner/repo.git",
    "owner/repo",
    { url: "https://github.com/owner/repo.git" }
  ]) assert.deepEqual(github.parseGithubRepo(repository), expected);

  for (const repository of [null, {}, 42, "https://github.example/owner/repo", "owner", "../repo",
    "github:owner/repo/extra", "github:owner/..", "github:owner/repo%2Fextra", "github:owner/repo\\extra"]) {
    assert.equal(github.parseGithubRepo(repository), null);
  }
});

test("fetchRepoMetadata reshapes cache-server data and distinguishes 404 from transient failure", async t => {
  const originalEnabled = cacheClient.isEnabled;
  const originalGet = cacheClient.getRepoJson;
  t.after(() => {
    cacheClient.isEnabled = originalEnabled;
    cacheClient.getRepoJson = originalGet;
  });
  cacheClient.isEnabled = () => true;

  cacheClient.getRepoJson = async (owner, repo, options) => {
    assert.deepEqual([owner, repo, options.token], ["Owner", "Repo", "synthetic-token"]);
    return {
      full_name: "Owner/Repo", description: "fixture", archived: false, disabled: false,
      fork: true, stargazers_count: 7, forks_count: 3, open_issues_count: 2,
      watchers_count: 5, default_branch: "main", html_url: "https://github.com/Owner/Repo",
      license: { spdx_id: "MIT" }, owner: { type: "Organization" }
    };
  };
  const found = await github.fetchRepoMetadata("github:Owner/Repo", { useCache: false, token: "synthetic-token" });
  assert.deepEqual({ found: found.found, owner: found.owner, repo: found.repo, stars: found.stars,
    forks: found.forks, fork: found.fork, license: found.license, ownerType: found.owner_type },
  { found: true, owner: "Owner", repo: "Repo", stars: 7, forks: 3, fork: true, license: "MIT", ownerType: "Organization" });

  cacheClient.getRepoJson = async () => { const error = new Error("missing"); error.statusCode = 404; throw error; };
  assert.deepEqual(await github.fetchRepoMetadata("Owner/Repo", { useCache: false, token: null }),
    { found: false, reason: "not-found", owner: "Owner", repo: "Repo" });

  cacheClient.getRepoJson = async () => { throw new Error("temporary outage"); };
  assert.deepEqual(await github.fetchRepoMetadata("Owner/Repo", { useCache: false, token: null }),
    { found: false, reason: "fetch-error", message: "temporary outage", owner: "Owner", repo: "Repo" });
  assert.deepEqual(await github.fetchRepoMetadata("https://example.com/Owner/Repo", { useCache: false }),
    { found: false, reason: "not-github" });
});

const archiveOptions = {
  skip: process.platform === "win32" ? "archive fixture uses POSIX tar paths; parsing is covered on Windows" : false
};

async function makeArchive(t, count = 3) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pkgxray-github-acquisition-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const prefix = path.join(root, "owner-repo-abc123");
  await fs.mkdir(path.join(prefix, "src", "nested"), { recursive: true });
  await fs.writeFile(path.join(prefix, "README.md"), "fixture\n");
  const relative = [];
  for (let index = 0; index < count; index++) {
    const name = `src/nested/file-${String(index).padStart(3, "0")}.js`;
    await fs.writeFile(path.join(prefix, ...name.split("/")), `module.exports=${index};\n`);
    relative.push(name);
  }
  const archive = path.join(root, "repo.tgz");
  const packed = spawnSync("tar", ["-czf", archive, "-C", root, "owner-repo-abc123"], { encoding: "utf8" });
  assert.equal(packed.status, 0, packed.stderr);
  return { root, archive, relative, prefixName: "owner-repo-abc123" };
}

test("listTarballEntries inventories files and implicit parent directories", archiveOptions, async t => {
  const fixture = await makeArchive(t);
  const listed = await github.listTarballEntries(fixture.archive);
  assert.equal(listed.prefix, `${fixture.prefixName}/`);
  assert.ok(listed.entries.has("README.md"));
  assert.ok(listed.fileEntries.has("src/nested/file-000.js"));
  assert.ok(listed.dirEntries.has("src"));
  assert.ok(listed.dirEntries.has("src/nested"));
  assert.equal(listed.fileEntries.has("../escape"), false);
});

test("extractTarballSubset handles empty, argv and bounded list-file paths", archiveOptions, async t => {
  const fixture = await makeArchive(t, 401);

  const empty = path.join(fixture.root, "empty");
  await github.extractTarballSubset(fixture.archive, empty, []);
  assert.deepEqual(await fs.readdir(empty), []);

  const small = path.join(fixture.root, "small");
  await github.extractTarballSubset(fixture.archive, small,
    [`${fixture.prefixName}/README.md`, `${fixture.prefixName}/${fixture.relative[0]}`]);
  assert.equal(await fs.readFile(path.join(small, "README.md"), "utf8"), "fixture\n");
  assert.match(await fs.readFile(path.join(small, fixture.relative[0]), "utf8"), /module\.exports=0/);

  const large = path.join(fixture.root, "large");
  await github.extractTarballSubset(fixture.archive, large,
    fixture.relative.map(name => `${fixture.prefixName}/${name}`));
  assert.match(await fs.readFile(path.join(large, fixture.relative.at(-1)), "utf8"), /module\.exports=400/);
  await assert.rejects(fs.stat(path.join(large, ".pkgxray-extract-list")), { code: "ENOENT" });
});

test("tarball acquisition falls back across refs, commits atomically and reuses the cache", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pkgxray-github-cache-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const originalEnabled = cacheClient.isEnabled;
  const originalStream = cacheClient.streamTarball;
  t.after(() => {
    cacheClient.isEnabled = originalEnabled;
    cacheClient.streamTarball = originalStream;
  });
  cacheClient.isEnabled = () => true;
  const refs = [];
  cacheClient.streamTarball = async (owner, repo, ref, output) => {
    refs.push([owner, repo, ref]);
    if (ref === "v1.2.3") {
      const error = new Error("missing tag");
      error.statusCode = 404;
      throw error;
    }
    output.write(Buffer.from("bounded archive fixture"));
  };

  const first = await github.fetchRepoTarballForVersion("owner", "repo", "1.2.3", "main", { cacheDir: root });
  assert.equal(first.ref, "1.2.3");
  assert.equal(first.fromCache, false);
  assert.equal(await fs.readFile(first.archivePath, "utf8"), "bounded archive fixture");
  assert.deepEqual(refs, [["owner", "repo", "v1.2.3"], ["owner", "repo", "1.2.3"]]);
  assert.equal((await fs.readdir(root)).some(name => name.startsWith(".download-")), false);

  const secondRefs = [];
  cacheClient.streamTarball = async (_owner, _repo, ref) => {
    secondRefs.push(ref);
    if (ref === "v1.2.3") { const error = new Error("still missing"); error.statusCode = 404; throw error; }
    throw new Error("cached successful ref should avoid transport");
  };
  const second = await github.fetchRepoTarballForVersion("owner", "repo", "1.2.3", "main", { cacheDir: root });
  assert.deepEqual(second, { ref: "1.2.3", archivePath: first.archivePath, fromCache: true });
  assert.deepEqual(secondRefs, ["v1.2.3"]);
});

test("tarball acquisition surfaces transient failures and removes partial downloads", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pkgxray-github-cache-failure-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const originalEnabled = cacheClient.isEnabled;
  const originalStream = cacheClient.streamTarball;
  t.after(() => {
    cacheClient.isEnabled = originalEnabled;
    cacheClient.streamTarball = originalStream;
  });
  cacheClient.isEnabled = () => true;
  cacheClient.streamTarball = async (_owner, _repo, _ref, output) => {
    output.write(Buffer.from("partial"));
    throw new Error("upstream reset");
  };
  await assert.rejects(
    github.fetchRepoTarballForVersion("owner", "repo", "9.9.9", "main", { cacheDir: root }),
    /upstream reset/
  );
  assert.deepEqual(await fs.readdir(root), []);
  assert.equal(await github.fetchRepoTarballForVersion("owner", "repo", null, null, { cacheDir: root }), null);
});
