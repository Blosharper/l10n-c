# vite-plugin-l10n-c

Development-only translation editor for Vite 5+ (Node 22.12+; bundles target Node 22).

```ts
import i18n from 'vite-plugin-l10n-c'
export default { plugins: [i18n({ baseLanguage: 'en' })] }
```

Open `/i18n/` on the dev server. Inline options override
`l10n-c.config.json` in the Vite root. The package ships its editor assets.
It adds no production build or preview middleware. GET `/i18n/api/locales`
returns flattened language dictionaries; POST `/i18n/api/publish` accepts
`{ changes: { en: { 'ui.start': 'Start' } } }`. Publish writes local files.
Only exact API routes match. Language/key validation rejects traversal and
prototype keys before writes; cross-origin write requests are rejected.

Configuration uses the same options as `l10n-c`: `localesDir` (default
`public/locales`), `baseLanguage` (default `ko`), `sourcePaths`, `sourceIgnore`,
`mirrors`, `allowedRoots`, `referencePrefixes` and `languageOrder`. Paths resolve
from the Vite project root. For example:

```json
{
  "localesDir": "messages",
  "baseLanguage": "en",
  "languageOrder": ["en", "fr"]
}
```

Each `messages/en/ui.json` owns its `ui` root. Use the editor to search keys or
values, filter domains/languages, click a cell to edit and **Publish** to save.
CSV exports the filtered rows with drafts. The fixed `/i18n/` routes also apply
when Vite has a base path. File writes are sequential; a filesystem failure may
leave partial writes. Keep the dev server on a trusted development machine.

The tarball includes ESM/CommonJS builds, types, editor HTML/JS, README and MIT
license. See the [full documentation](https://github.com/Blosharper/l10n-c#readme)
for compatibility options and CLI checks.

MIT
