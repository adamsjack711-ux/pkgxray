#!/usr/bin/env bash
# Materializes the staging directory the demo tapes record against.
# Everything comes from files already in this repo — the malicious sample is
# the calibration-corpus fixture used for the old cli-guard-block screenshot.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
STAGE=/tmp/pkgxray-demo

rm -rf "$STAGE"
mkdir -p "$STAGE/sample-malicious-pkg"

node -e '
  const fs = require("fs");
  const fixture = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const stage = process.argv[2];
  fs.writeFileSync(stage + "/sample-malicious-pkg/index.js", fixture.evidence.sourceFiles["index.js"]);
  fs.writeFileSync(stage + "/sample-malicious-pkg/package.json", JSON.stringify({
    name: fixture.evidence.packageName,
    version: "1.2.0",
    main: "index.js",
    description: "Helper utilities for Solana web3 apps"
  }, null, 2) + "\n");
' "$REPO_ROOT/benchmark/corpus/malicious/advisory-solana-web3-keytheft.json" "$STAGE"

cat > "$STAGE/package-lock.json" <<'EOF'
{
  "name": "demo-app",
  "version": "1.0.0",
  "lockfileVersion": 3,
  "packages": {
    "": { "name": "demo-app", "version": "1.0.0", "dependencies": { "express": "4.21.0", "lodash": "4.17.11" } },
    "node_modules/express": { "version": "4.21.0", "resolved": "https://registry.npmjs.org/express/-/express-4.21.0.tgz" },
    "node_modules/lodash": { "version": "4.17.11", "resolved": "https://registry.npmjs.org/lodash/-/lodash-4.17.11.tgz" }
  }
}
EOF

# For the mcp-proxy still: the demo server plus a paced JSON-RPC session
# (1 s between frames so the proxy's manifest audit lands between them).
cp "$REPO_ROOT/docs/screenshots/demo-mcp-server.js" "$STAGE/"
cat > "$STAGE/frames.sh" <<'EOF'
#!/usr/bin/env bash
# Paced MCP session: initialize, list tools, call the injected tool, call a clean one.
while IFS= read -r frame; do printf '%s\n' "$frame"; sleep 1; done <<'FRAMES'
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"demo-client","version":"1.0.0"}}}
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"summarize_page","arguments":{"url":"https://example.com"}}}
{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"convert_units","arguments":{"value":5,"from":"km","to":"mi"}}}
FRAMES
EOF
chmod +x "$STAGE/frames.sh"

# For the hookshot still: build the guard hook from the hookshot checkout
# (the example's go.mod `replace` needs to resolve against ../..).
HOOKSHOT_CHECKOUT="${HOOKSHOT_CHECKOUT:-$HOME/Documents/GitHub/hookshot}"
if [ -d "$HOOKSHOT_CHECKOUT/examples/pkgxray-guard" ]; then
  (cd "$HOOKSHOT_CHECKOUT/examples/pkgxray-guard" && go build -o "$STAGE/pkgxray-guard" .)
else
  echo "note: hookshot checkout not found at $HOOKSHOT_CHECKOUT — skipping pkgxray-guard build (needed only for still-hookshot.tape)" >&2
fi

echo "staged demo fixtures in $STAGE"
