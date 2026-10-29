# Development

Maintainer notes for verifying the packages and comparing them with the original
game CLI. Installation, usage, configuration and consumer-facing limits are in
[README.md](README.md).

## Verification

```sh
npm ci
npm run verify
npm pack --dry-run --workspaces
```

Build order is core then adapter, matching workspace dependency order. Tests use
temporary copies for edits, exercise the packaged Node CLI and a real Vite server,
and test editor interactions in a DOM environment. `scripts/verify.mjs` also packs
both workspaces, checks the tar listings, installs the tarballs into a disposable
consumer using npm's offline cache, and runs plain Node ESM/CJS, CLI and real Vite
HTTP/editor DOM checks. This requires the Vite/happy-dom dependency versions from
`npm ci` to be present in the local npm cache. It preserves tarballs, raw logs and
hashes under ignored `scratch/verification-<timestamp>` (override with `L10N_C_RECEIPTS`).
Use a fresh receipt directory per run. Optional stage names select a targeted
retry, e.g. `node scripts/verify.mjs pack-smoke`; with `L10N_C_GAME` set, `parity`
is another stage. `L10N_C_BUILD_WORKSPACE=packages/l10n-c` limits a repair build to
the core when the adapter's successful build is unchanged.
`L10N_C_TEST_FILES` accepts comma-separated test paths for a targeted repair.
`L10N_C_SKIP_HTTP=1` limits a repeated tarball check to Node/core/CLI when an
unchanged adapter already has a successful HTTP/DOM receipt. DOM tests do not establish
browser layout or real browser compatibility. `scripts/browser-smoke.mjs` supports
an explicitly authorized real-browser check against a disposable copy of game
locales; it needs an existing Playwright dependency via `L10N_C_PLAYWRIGHT_DIR`,
takes a grid screenshot, exercises edit/CSV/publish/reload, then closes its browser
and server. Follow the environment's execution/measurement policy before running. Test workers are bounded to two.
Use workspace links during development; migrate game consumers only after the
first npm release, in a separate issue.

## Parity with the source CLI

For comparison against the game's read-only checkout, use a separate temporary
working directory and the compatibility configuration in
[`scripts/parity.mjs`](scripts/parity.mjs): all three real source paths, base `ko`,
`allowedRoots: { ui: ['ui', 'speech'] }` and `referencePrefixes: ['ui.']`.
The script runs the game CLI via `bun run i18n/cli.ts` and the packaged CLI against
the same real locales (including a nonempty `--search ui.button`). It retains raw stdout/stderr, exit codes, source/locale
hashes before/after, a normalized comparison (only absolute path prefixes and the
configured scan banner), and a summary. It never mutates the game checkout.

The deterministic locale and domain order is described in
[README.md](README.md#checks-and-compatibility).

| Behavior | Original game CLI | Extracted package | Parity treatment |
| --- | --- | --- | --- |
| Locale/domain iteration | Runtime/filesystem enumeration | Base locale first, remaining codes and filenames sorted | Intended difference; retain raw diffs and compare complete records |
| Rename safety | May overwrite existing targets | Refuses cross-domain moves and preflights same-domain collisions | Intended data-loss prevention |
| Unused source scope | Fixed game paths and implicit `ui.` | Configurable paths and `referencePrefixes` | Use compatibility config above |
| Public messages/config paths | Game command wording and paths | English package messages and configured paths | Only documented wording/path normalization |

The default extracted runtime is Node. `L10N_C_PARITY_RUNTIME=bun` can compare the
same runtime; it does not disable deterministic ordering. Pre-sort evidence can
isolate former Bun/Node enumeration differences, but cannot stand in for current
package results. Optional trailing check names select a targeted rerun.
Normalization is restricted to locale path prefixes and the configured unused
scan banner; values, keys, counts, order and exits remain intact. `summary.json`
keeps `rawParityPass`/`pass` separate from `contractPass`: the former stays false
when ordering differs, while the latter requires complete matching search or
duplicate records under the documented ordering exception. The script still
exits 1 on any raw diff; inspect its raw diffs and explicit intended-difference
records. The record comparator rejects changed values, keys, counts and extra
unparsed content rather than sorting output lines.
