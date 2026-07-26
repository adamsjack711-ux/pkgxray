/**
 * npm ↔ GitHub version-drift model for swamp.
 *
 * For each configured package pair, fetches the latest published npm version
 * (`npm view`) and the latest GitHub release tag (`gh api`), normalizes both,
 * and reports drift: in-sync, drift, npm-missing, or gh-missing. Catches
 * unpublished npm shims and repos whose release lagged behind a publish.
 *
 * @module
 */
// SPDX-License-Identifier: Apache-2.0

import { z } from "npm:zod@4";

// =============================================================================
// Schemas
// =============================================================================

const PackagePairSchema = z.object({
  npm: z.string().describe("npm package name (e.g. driftcheck-cli)"),
  repo: z.string().describe("GitHub repository in owner/name format"),
});

const GlobalArgsSchema = z.object({
  packages: z.array(PackagePairSchema).describe(
    "npm package ↔ GitHub repo pairs to compare",
  ),
});

const DriftResultSchema = z.object({
  npm: z.string(),
  repo: z.string(),
  npmVersion: z.string().nullable(),
  ghTag: z.string().nullable(),
  status: z.enum(["in-sync", "drift", "npm-missing", "gh-missing"]),
  detail: z.string(),
});

const DriftReportSchema = z.object({
  results: z.array(DriftResultSchema),
  driftCount: z.number(),
  checkedAt: z.string(),
});

// =============================================================================
// Helpers
// =============================================================================

/** Run a command with argv array (no shell), return trimmed stdout or null on failure. */
async function runCmd(bin: string, args: string[]): Promise<string | null> {
  const cmd = new Deno.Command(bin, {
    args,
    stdout: "piped",
    stderr: "piped",
  });
  const output = await cmd.output();
  if (!output.success) return null;
  return new TextDecoder().decode(output.stdout).trim();
}

/** Strip a leading "v" so v0.2.1 and 0.2.1 compare equal. */
function normalize(tag: string): string {
  return tag.replace(/^v/, "");
}

async function checkPair(
  pair: z.infer<typeof PackagePairSchema>,
): Promise<z.infer<typeof DriftResultSchema>> {
  const [npmVersion, ghTag] = await Promise.all([
    runCmd("npm", ["view", pair.npm, "version"]),
    runCmd("gh", [
      "api",
      `repos/${pair.repo}/releases/latest`,
      "--jq",
      ".tag_name",
    ]),
  ]);

  if (npmVersion === null) {
    return {
      ...pair,
      npmVersion,
      ghTag,
      status: "npm-missing",
      detail: `${pair.npm} is not published on npm`,
    };
  }
  if (ghTag === null) {
    return {
      ...pair,
      npmVersion,
      ghTag,
      status: "gh-missing",
      detail: `${pair.repo} has no GitHub release`,
    };
  }
  if (normalize(npmVersion) === normalize(ghTag)) {
    return {
      ...pair,
      npmVersion,
      ghTag,
      status: "in-sync",
      detail: `both at ${normalize(npmVersion)}`,
    };
  }
  return {
    ...pair,
    npmVersion,
    ghTag,
    status: "drift",
    detail: `npm has ${npmVersion} but latest GitHub release is ${ghTag}`,
  };
}

// =============================================================================
// Context Type
// =============================================================================

type ModelContext = {
  globalArgs: z.infer<typeof GlobalArgsSchema>;
  writeResource: (
    spec: string,
    instance: string,
    data: unknown,
  ) => Promise<{ name: string }>;
  logger: {
    info: (msg: string, props: Record<string, unknown>) => void;
  };
};

// =============================================================================
// Model Definition
// =============================================================================

/** npm ↔ GitHub version-drift model. */
export const model = {
  type: "@adamsjack711/npm-drift",
  version: "2026.07.17.1",
  globalArguments: GlobalArgsSchema,

  resources: {
    drift: {
      description:
        "npm-vs-GitHub version comparison for all configured packages",
      schema: DriftReportSchema,
      lifetime: "1h" as const,
      garbageCollection: 10,
    },
  },

  methods: {
    check: {
      description:
        "Compare latest npm version against latest GitHub release tag for every configured package (single fan-out run)",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ModelContext,
      ) => {
        const results = await Promise.all(
          context.globalArgs.packages.map(checkPair),
        );
        const driftCount =
          results.filter((r) => r.status !== "in-sync").length;

        const handle = await context.writeResource("drift", "current", {
          results,
          driftCount,
          checkedAt: new Date().toISOString(),
        });

        context.logger.info(
          "Checked {total} packages: {drift} out of sync",
          { total: results.length, drift: driftCount },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
