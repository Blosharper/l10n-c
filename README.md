# l10n-c

Locale file editing for people and coding agents: search, update, rename, delete,
replace text, and check missing, nested, duplicate and unused keys. Includes a
Vite development server translation manager with inline editing and CSV export.
Extracted from Blosharper's existing translation tools.

## Packages

| Package | Role |
| --- | --- |
| [`l10n-c`](packages/l10n-c) | Bundler-independent core, JSON config/schema, and `l10n-c` CLI |
| [`vite-plugin-l10n-c`](packages/vite-plugin-l10n-c) | Development-only Vite adapter and translation web UI |

Requires Node 22.12 or later (bundles target Node 22). Both packages are on npm, published from CI with provenance.

## Usage

```sh
npm install --save-dev l10n-c vite-plugin-l10n-c
npx l10n-c --help
npx l10n-c --search start
npx l10n-c --missing
npx l10n-c --nest-check
npx l10n-c --duplicate-check
npx l10n-c --unused
npx l10n-c --update 'en:ui.start=Start'
npx l10n-c --rename 'ui.old=ui.new'
npx l10n-c --delete 'fr:ui.obsolete'
npx l10n-c --replace-text 'en:Old=New'
npx l10n-c --publish '{"en":{"ui.start":"Start"}}'
```

`--file ui` (or `--domain ui.json`) filters operations to one domain.
`--update` is repeatable. Rename/delete accept subtree keys. Rename stays within
one top-level root; cross-domain rename explicitly refuses with both domains and
`--update "LANG:target.key=VALUE"` then `--delete "source.key"` as the alternative.
A language folder can be added by publishing/updating a new language code.
Messages and help are English; translation data is preserved verbatim.

```ts
// vite.config.ts
import { defineConfig } from 'vite'
import i18n from 'vite-plugin-l10n-c'
export default defineConfig({ plugins: [i18n()] })
```

Open `/i18n/` on the dev server. Search keys or values, filter domains/languages,
click a cell to edit, then **Publish** to save drafts. CSV exports the visible
filtered data including drafts. Publish here saves locale files, not an npm
package. The plugin is `apply: 'serve'`; its UI and write API do not enter builds
or preview. The editor uses fixed `/i18n/` routes, including when Vite has a base
path. Keep the dev server on a trusted development machine.

## Data model: file = domain

```text
public/locales/
  en/
    ui.json          { "ui": { "start": "Start" } }
    shop.json        { "shop": { "buy": "Buy" } }
    _meta.json       { "parts": ["ui", "shop"] }
  ko/
    ui.json          { "ui": { "start": "시작" } }
```

Each language is a direct directory; each JSON file is one domain, whose top-level
key matches the filename. The CLI uses flattened dotted keys (`ui.start`). Nested
arrays use numeric segments (`ui.items.0`). Edits preserve source objects, arrays
and empty nodes; missing numeric paths create objects. Only touched files are
rewritten and mirrored. Deleting or moving an array element retains other indices;
the removed slot serializes as `null`. Literal dots in object
keys are not supported. Values written through the tools must be strings.
`_meta` may appear in any file and stays first on rewrite. `_meta.json` is read
but excluded from nesting and duplicate checks. `_meta.*` and `parts.N` are
excluded from unused-key scanning. There is no runtime translation library here.

New roots create their own file (`shop.buy` creates `shop.json`), while existing
roots retain file ownership. `allowedRoots` explicitly supports legacy multi-root
files such as `ui.json` containing both `ui` and `speech`. It controls nesting
checks and routes newly created roots to their mapped domain. Existing malformed
JSON is never overwritten by a mutation. Read/check routines retain the original
tool's skip-and-report behavior for malformed files, so these checks do not
replace a JSON syntax/integrity gate. Changes across files/languages/mirrors are
sequential, not transactional; a filesystem failure may leave partial writes.

## Configuration

Only `l10n-c.config.json` in the CLI working directory (or Vite project root) is
loaded. Paths resolve from that root, independently of the caller's working
directory in the Vite adapter. There is no upward config search or TS loader.
Unknown options and malformed configuration fail. Exported `I18nConfig` provides
TypeScript completion; the package also exports `l10n-c/schema.json`.

```json
{
  "$schema": "./node_modules/l10n-c/schema.json",
  "localesDir": "public/locales",
  "baseLanguage": "en",
  "sourcePaths": ["src", "index.html"],
  "sourceIgnore": ["node_modules", ".git", "dist"],
  "mirrors": [],
  "allowedRoots": {},
  "referencePrefixes": [],
  "languageOrder": ["en", "fr", "ko"]
}
```

| Option | Default | Meaning |
| --- | --- | --- |
| `localesDir` | `public/locales` | Language directories and domain files |
| `baseLanguage` | `ko` | Base for bare `--missing` and `--unused` |
| `sourcePaths` | `["src"]` | Files/directories for unused scanning; absent paths skipped |
| `sourceIgnore` | `["node_modules", ".git", "dist"]` | Directory/file names excluded at any depth; symlinks skipped |
| `mirrors` | `[]` | Locale directory copies receiving each changed JSON file |
| `allowedRoots` | `{}` | Domain to permitted root names; otherwise filename root only |
| `referencePrefixes` | `[]` | Extra source-reference prefixes, e.g. `["ui."]` |
| `languageOrder` | `["en","de","ru","cn","tw","ja","ko"]` | Editor column order; other languages appended |

The Vite plugin accepts the same options inline, overriding JSON options by
property. The core has no Vite imports:

```ts
import { createI18n, type I18nConfig } from 'l10n-c'
const options: I18nConfig = { localesDir: 'messages', baseLanguage: 'en' }
const locales = await createI18n(options, process.cwd())
await locales.saveLocale('en', { 'ui.start': 'Start' })
const flat = await locales.getLocales('ui')
```

Mirrors are opt-in write destinations with the same `language/domain.json`
structure. Every mutation writes formatted JSON to its primary directory and
configured mirrors; reads/checks always use the primary. Existing unrelated
mirror files are preserved. This replaces the original tool's migration-only
mirror paths with intentional reusable behavior. Do not configure a live source
locale directory as a mirror during verification.

## Checks and compatibility

Search is case insensitive. Missing keys and repeated values are advisory (exit
0), matching the source CLI. Duplicate flat keys across domain files and invalid
nesting exit 1; invalid input and filesystem operation failures also exit 1.
Search with no results exits 0. Read diagnostics are not a complete integrity
check. No operation rewrites application source.

Unused scanning is a heuristic over quoted literals in TS/JS/CJS/MJS/TSX/JSX/HTML.
Code literals cover their subtrees; comments cover exact keys only. Template
prefixes classify possible dynamic keys separately; concatenation and arbitrary
runtime key generation require review. Source aliases are opt-in using
`referencePrefixes`; no game-specific source directories are scanned implicitly.
`--restructure` and `convert-to-tw` remain game-specific and are not shipped.
Unlike the source CLI, cross-domain rename is deliberately refused. Same-domain
rename preflights all selected languages/files before writing and refuses existing
targets (including subtrees and empty nodes), descendant targets and scalar or
array path conflicts. Successful renames count original moved leaves once.

The extracted CLI/core deliberately use deterministic locale and domain order:
the configured base language first, other locale codes in codepoint order, and
files/domains by filename. Translation key order within each parsed file is kept.

Parity runs against the original game CLI, the compatibility configuration and
the documented intended differences are described in
[DEVELOPMENT.md](DEVELOPMENT.md#parity-with-the-source-cli).

## Development

```sh
npm ci
npm run verify
npm pack --dry-run --workspaces
```

Build order is core then adapter, matching workspace dependency order. See
[DEVELOPMENT.md](DEVELOPMENT.md) for the verification pipeline, receipts,
targeted retries, the browser smoke check and parity runs.

See [RELEASING.md](RELEASING.md) for release-please, the owner bootstrap and OIDC.

## License

MIT
