# Demo recordings

Both recordings are real, unedited terminal sessions — nothing is mocked up
or trimmed in post. This file records exactly how they were produced so they
can be regenerated.

Recorded with [vhs](https://github.com/charmbracelet/vhs) 0.11 (needs `ttyd`
and `ffmpeg`; `brew install vhs`). The theme is a custom warm earth-tone
palette (`stik-latte`, defined inline in each tape): coffee / mocha / tan /
wheat / cream, with rust-copper on the red slots — no rainbow, no neon.

To regenerate, from the repo root:

```bash
docs/demo/setup.sh          # stage fixtures in /tmp/pkgxray-demo
vhs docs/demo/hero.tape     # → docs/demo/hero.gif
vhs docs/demo/demo.tape     # → docs/demo/pkgxray-demo.mp4
```

The `still-*.tape` files in this directory produce the terminal screenshots
in [`docs/screenshots/`](../screenshots/README.md) with the same theme and
window (vhs requires a video `Output`, so they also write a disposable
`still-scratch.txt`, which is gitignored).

[`setup.sh`](setup.sh) materializes the malicious sample from the
calibration-corpus fixture
[`benchmark/corpus/malicious/advisory-solana-web3-keytheft.json`](../../benchmark/corpus/malicious/advisory-solana-web3-keytheft.json)
(modeled on the 2024 `@solana/web3.js` compromise — the same fixture the
retired `cli-guard-block.png` screenshot used) plus a two-dependency
`package-lock.json` that pins `lodash@4.17.11` for the audit act. It also
stages the paced MCP session driver for the mcp-proxy still and builds
`pkgxray-guard` from the hookshot checkout (`$HOOKSHOT_CHECKOUT`, default
`~/Documents/GitHub/hookshot`) for the hookshot still.

## hero.gif

The README hero (~17 s loop): `pkgxray guard npm:express@4.21.0` clearing with
the npm ↔ GitHub cross-check, then `pkgxray guard ./sample-malicious-pkg`
blocking with the HIGH credential-access finding.

## pkgxray-demo.mp4

The ~60 s walkthrough, three acts: the SAFE run on `express`, the malicious
sample (its one-line source `cat`-ed first, then blocked, then `echo $?`
showing exit code 2), and `pkgxray audit package-lock.json` catching the
vulnerable `lodash` pin via OSV.

The README embeds a copy rehosted as a GitHub attachment (a bare
`github.com/user-attachments/assets/…` URL is the only form GitHub renders as
an inline player — committed files, release assets, and `<video>` tags all
render as plain links). After re-recording, re-upload by dragging the new
`.mp4` into any GitHub markdown box (an unsubmitted issue comment works),
copy the inserted URL, and swap it into README.md.

## Gotcha: `Set Framerate 8`

Both tapes pin `Set Framerate 8`. At this window size (1640×1060) vhs can only
capture ~10 fps; at the default framerate it silently falls behind and the
output plays several times too fast (a 17 s session rendered as 3 s). 8 fps is
sustainable, so wall-clock timing is preserved. If you change `Width`/`Height`
or record on a slower machine, re-check the output duration against the tape's
intended timeline before committing.
