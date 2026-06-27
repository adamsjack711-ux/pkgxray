#!/usr/bin/env bash
# Run pkgxray guard against the most-used npm packages (latest) in parallel,
# capture Decision/Grade + the parameters that scored below A, and the
# divergence reason if present. Output one TSV line per package to stdout.
set -u
cd "$(dirname "$0")/.."

PKGS=(
  react react-dom vue svelte @angular/core
  lodash underscore ramda immer
  express koa fastify next
  axios node-fetch got undici
  chalk commander yargs inquirer
  webpack rollup vite esbuild
  typescript eslint prettier @babel/core
  jest mocha vitest
  dayjs date-fns
  dotenv debug ms uuid nanoid
  cors body-parser helmet
  ws socket.io
  redux zustand rxjs
  jquery
)

OUT=$(mktemp -d)
run_one() {
  local pkg="$1" out="$2"
  local raw
  raw=$(node bin/audit.js guard "npm:${pkg}" 2>&1)
  local decision grade reasons div
  decision=$(printf '%s' "$raw" | grep -m1 -iE '^Decision:' | sed -E 's/.*\*\*([A-Z]+)\*\*.*/\1/')
  grade=$(printf '%s' "$raw" | grep -m1 -iE '^Grade:' | sed -E 's/Grade: \*\*([^*]+)\*\* \(([0-9]+)\/100\)/\1 \2/')
  # parameters scoring below A (the drivers of any downgrade)
  reasons=$(printf '%s' "$raw" | grep -E '^\- `' | grep -vE '\bA\+? \(' | sed -E 's/^- `([a-zA-Z]+)`: ([A-F][+-]?).*/\1=\2/' | paste -sd, -)
  # divergence skip/fire reason if the output mentions it
  div=$(printf '%s' "$raw" | grep -oiE 'tree-(built-before-publish|mostly-generated|layout-differs)|npm-vs-github' | head -1)
  printf '%s\t%s\t%s\t%s\t%s\n' "${pkg}" "${decision:-ERR}" "${grade:-?}" "${reasons:-none}" "${div:-}" > "${out}/${pkg//\//_}.line"
}
export -f run_one

printf '%s\n' "${PKGS[@]}" | xargs -P 6 -I{} bash -c 'run_one "$@"' _ {} "$OUT"

echo -e "PACKAGE\tDECISION\tGRADE\tFLAGGED_PARAMS\tDIVERGENCE"
cat "$OUT"/*.line | sort
rm -rf "$OUT"
