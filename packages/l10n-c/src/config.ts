import fs from 'node:fs/promises'
import path from 'node:path'

/** Options shared by the CLI, core and Vite adapter. Paths are relative to root. */
export interface I18nConfig {
  $schema?: string
  localesDir?: string
  baseLanguage?: string
  sourcePaths?: string[]
  /** Directory names excluded at every depth by the unused-key scanner. */
  sourceIgnore?: string[]
  mirrors?: string[]
  /** Overrides the file=domain rule, e.g. { ui: ['ui', 'speech'] }. */
  allowedRoots?: Record<string, string[]>
  /** Extra prefixes accepted for literal and dynamic source references. */
  referencePrefixes?: string[]
  languageOrder?: string[]
}
export interface ResolvedConfig extends Required<Omit<I18nConfig, '$schema'>> {
  root: string
}
export function assertSegment(value: string, kind = 'path segment'): void {
  if (
    typeof value !== 'string' ||
    !/^[a-zA-Z0-9_-]+$/.test(value) ||
    ['__proto__', 'constructor', 'prototype'].includes(value)
  ) {
    throw new Error(`Invalid ${kind}: ${value}`)
  }
}
export function assertKey(key: string): void {
  if (typeof key !== 'string' || !key)
    throw new Error('A nonempty translation key is required')
  key.split('.').forEach((segment) => assertSegment(segment, 'key segment'))
}
export function resolveConfig(
  options: I18nConfig = {},
  root = process.cwd(),
): ResolvedConfig {
  if (!options || typeof options !== 'object' || Array.isArray(options))
    throw new Error('Config must be an object')
  const allowed = [
    '$schema',
    'localesDir',
    'baseLanguage',
    'sourcePaths',
    'sourceIgnore',
    'mirrors',
    'allowedRoots',
    'referencePrefixes',
    'languageOrder',
  ]
  for (const key of Object.keys(options))
    if (!allowed.includes(key)) throw new Error(`Unknown config option: ${key}`)
  for (const key of ['localesDir', 'baseLanguage'] as const) {
    if (
      options[key] !== undefined &&
      (typeof options[key] !== 'string' || !options[key])
    )
      throw new Error(`${key} must be a nonempty string`)
  }
  for (const key of [
    'sourcePaths',
    'sourceIgnore',
    'mirrors',
    'referencePrefixes',
    'languageOrder',
  ] as const) {
    if (
      options[key] !== undefined &&
      (!Array.isArray(options[key]) ||
        !options[key].every((v) => typeof v === 'string' && v.length > 0))
    )
      throw new Error(`${key} must be an array of nonempty strings`)
  }
  const allowedRoots = options.allowedRoots ?? {}
  if (
    !allowedRoots ||
    typeof allowedRoots !== 'object' ||
    Array.isArray(allowedRoots)
  )
    throw new Error('allowedRoots must be an object')
  for (const [domain, roots] of Object.entries(allowedRoots)) {
    assertSegment(domain, 'domain')
    if (!Array.isArray(roots) || roots.length === 0)
      throw new Error('allowedRoots entries must be nonempty arrays')
    roots.forEach((root) => assertSegment(root, 'root'))
  }
  const baseLanguage = options.baseLanguage ?? 'ko'
  assertSegment(baseLanguage, 'language')
  options.languageOrder?.forEach((lang) => assertSegment(lang, 'language'))
  options.referencePrefixes?.forEach((prefix) =>
    assertKey(prefix.replace(/\.$/, '')),
  )
  root = path.resolve(root)
  return {
    root,
    localesDir: path.resolve(root, options.localesDir ?? 'public/locales'),
    baseLanguage,
    sourcePaths: (options.sourcePaths ?? ['src']).map((p) =>
      path.resolve(root, p),
    ),
    sourceIgnore: options.sourceIgnore ?? ['node_modules', '.git', 'dist'],
    mirrors: (options.mirrors ?? []).map((p) => path.resolve(root, p)),
    allowedRoots,
    referencePrefixes: options.referencePrefixes ?? [],
    languageOrder: options.languageOrder ?? [
      'en',
      'de',
      'ru',
      'cn',
      'tw',
      'ja',
      'ko',
    ],
  }
}
/** Only this JSON file is read. No code execution, upward search or TS loader. */
export async function loadConfig(
  root = process.cwd(),
  inline: I18nConfig = {},
): Promise<ResolvedConfig> {
  let file: I18nConfig = {}
  try {
    file = JSON.parse(
      await fs.readFile(path.resolve(root, 'l10n-c.config.json'), 'utf8'),
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  resolveConfig(file, root)
  return resolveConfig({ ...file, ...inline }, root)
}
