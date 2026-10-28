# l10n-c

> Formerly published under the working name `i18n-c`; npm reserved that name as too similar to an existing package, so the first release ships as `l10n-c`.

Locale editing CLI and bundler-independent core. Requires Node 22.12+; bundles
target Node 22. Translation strings stay verbatim; public tool messages are English.

```sh
npm install --save-dev l10n-c
npx l10n-c --help
npx l10n-c --search start
npx l10n-c --missing
npx l10n-c --nest-check
npx l10n-c --duplicate-check
npx l10n-c --unused
npx l10n-c --update 'en:ui.start=Start'
npx l10n-c --rename 'ui.old=ui.new'
npx l10n-c --delete 'fr:ui.obsolete'
```

Each locale is a directory, each JSON filename a domain: `messages/en/ui.json`
contains `{ "ui": { "start": "Start" } }`. Keys flatten to `ui.start`; nested
arrays use numeric segments. Literal dotted object keys are unsupported.
`--file ui`/`--domain ui.json` filters a domain. Mutations accept string values.
Cross-domain rename refuses with both domain names; use `--update` for each
language's target key, then `--delete` the old key. Same-domain subtrees work.
Game-only restructure and convert-to-tw commands are excluded.

Place `l10n-c.config.json` in the working directory; no upward search or TS loader:

```json
{
  "$schema": "./node_modules/l10n-c/schema.json",
  "localesDir": "messages",
  "baseLanguage": "en",
  "sourcePaths": ["src", "index.html"],
  "sourceIgnore": ["node_modules", ".git", "dist"],
  "mirrors": [],
  "allowedRoots": {},
  "referencePrefixes": [],
  "languageOrder": ["en", "fr"]
}
```

Paths resolve from the configuration root. Defaults are `public/locales`, base
`ko`, source `src`, no mirrors, allowed-root overrides or extra reference prefixes.
`allowedRoots: { "ui": ["ui", "speech"] }` permits legacy roots within one file.
`referencePrefixes: ["ui."]` recognizes implicit source references when scanning
unused keys. Mirrors receive formatted changed files; primary files remain the
read source. Cross-file writes are sequential and may partially complete on errors.

```ts
import { createI18n, type I18nConfig } from 'l10n-c'
const options: I18nConfig = { localesDir: 'messages', baseLanguage: 'en' }
const editor = await createI18n(options, process.cwd())
await editor.saveLocale('en', { 'ui.start': 'Start' })
const flat = await editor.getLocales('ui')
```

Locale iteration is deterministic: configured base first, remaining locale codes
in codepoint order, domain files by filename. Translation key order within each
file is retained. This is an intentional difference from the source tool's
runtime/filesystem order.

The core imports no Vite runtime. ESM and CommonJS exports, TypeScript declarations,
and `l10n-c/schema.json` are included. Pair with `vite-plugin-l10n-c` for the editor.

Missing keys and duplicate values are advisory (exit 0); invalid nesting, duplicate
keys, invalid input and mutation failures exit 1. Unused checks are heuristic:
code literals cover subtrees, comments only exact keys, templates flag potential
dynamic keys. Malformed read inputs may be skipped/reported, so checks are not a
complete JSON integrity gate. No tool rewrites application source.

[Full documentation](https://github.com/Blosharper/l10n-c#readme). MIT license included.
