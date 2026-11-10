import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

// Only creates archives. Fixture code is executed exclusively inside a sandbox.
export async function fixture(root, name, scripts, files) {
  const packageRoot = path.join(root, name, "package");
  await fsp.mkdir(packageRoot, { recursive: true });
  await fsp.writeFile(path.join(packageRoot, "package.json"), JSON.stringify({
    name: `resolver-${name}`, version: "1.0.0", main: "index.js", scripts
  }));
  await fsp.writeFile(path.join(packageRoot, "index.js"), "module.exports = 42;\n");
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(packageRoot, relative);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    if (content && typeof content === "object" && content.symlink) await fsp.symlink(content.symlink, target);
    else await fsp.writeFile(target, content);
  }
  const archive = path.join(root, `${name}.tgz`);
  const tar = spawnSync("tar", ["-czf", archive, "-C", path.dirname(packageRoot), "package"], {
    encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024
  });
  if (tar.status !== 0) throw new Error(`Fixture tar failed: ${tar.error?.message || tar.stderr}`);
  const sha256 = crypto.createHash("sha256").update(await fsp.readFile(archive)).digest("hex");
  return { archive, sha256 };
}
