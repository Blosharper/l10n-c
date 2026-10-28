import fs from 'node:fs/promises'
import path from 'node:path'
import prettier from 'prettier'
import {
  assertKey,
  assertSegment,
  loadConfig,
  type I18nConfig,
  type ResolvedConfig,
} from './config'

export function validateChanges(
  changes: unknown,
): asserts changes is Record<string, string> {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes))
    throw new Error('Changes must be an object')
  for (const [key, value] of Object.entries(changes)) {
    assertKey(key)
    if (typeof value !== 'string')
      throw new Error(`Translation must be a string: ${key}`)
  }
}
function validateDomain(domain?: string): void {
  if (domain !== undefined && domain !== '')
    assertSegment(domain.replace(/\.json$/, ''), 'domain')
}
/** Resolve existing ancestors too: a symlinked language/file cannot escape root. */
async function canonical(target: string): Promise<string> {
  try {
    return await fs.realpath(target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const parent = path.dirname(target)
    if (parent === target) throw error
    return path.join(await canonical(parent), path.basename(target))
  }
}
async function safePath(root: string, target: string): Promise<string> {
  const relative = path.relative(await canonical(root), await canonical(target))
  if (
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  )
    throw new Error('Locale path escapes configured directory')
  return target
}
export interface FlatLocaleData {
  [lang: string]: Record<string, string>
}

export function flattenObject(ob: any): Record<string, string> {
  const toReturn: Record<string, string> = Object.create(null)
  for (const i in ob) {
    if (!Object.hasOwn(ob, i)) continue
    if (typeof ob[i] === 'object' && ob[i] !== null) {
      const flatObject = flattenObject(ob[i])
      for (const x in flatObject) {
        if (!Object.hasOwn(flatObject, x)) continue
        toReturn[i + '.' + x] = flatObject[x]
      }
    } else {
      toReturn[i] = ob[i]
    }
  }
  return toReturn
}

export function unflattenObject(ob: Record<string, string>): any {
  const result: any = {}
  for (const i in ob) {
    if (!Object.hasOwn(ob, i)) continue
    assertKey(i)
    const keys = i.split('.')
    let current = result
    for (let j = 0; j < keys.length; j++) {
      const key = keys[j]
      if (j === keys.length - 1) {
        current[key] = ob[i]
      } else {
        const nextKey = keys[j + 1]

        const isArray = /^\d+$/.test(nextKey)

        if (!Object.hasOwn(current, key) || current[key] === undefined || current[key] === null) {
          current[key] = isArray ? [] : {}
        }
        current = current[key]
      }
    }
  }
  return result
}

export interface DuplicateCheckResult {
  invalidKeys: Record<string, string[]>
  invalidValues: Record<string, Record<string, string[]>>
}

function isTree(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object'
}

function treeEntry(tree: any, key: string): { exists: boolean; value?: any } {
  let current = tree
  for (const segment of key.split('.')) {
    if (!isTree(current) || !Object.hasOwn(current, segment))
      return { exists: false }
    current = current[segment]
  }
  return { exists: true, value: current }
}

// Existing arrays retain their indices; missing numeric paths are objects.
function assignmentParent(tree: any, key: string, create: boolean): any {
  const segments = key.split('.')
  let current = tree
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]
    if (!isTree(current))
      throw new Error(`Cannot assign "${key}" through a scalar ancestor`)
    if (
      Array.isArray(current) &&
      (!/^(0|[1-9]\d*)$/.test(segment) || Number(segment) >= 2 ** 32 - 1)
    )
      throw new Error(`Cannot assign non-index segment "${segment}" in array: ${key}`)
    if (i === segments.length - 1) return current
    const node = current as Record<string, any>
    if (!Object.hasOwn(node, segment)) {
      if (!create) return
      node[segment] = {}
    }
    current = node[segment]
  }
}

function assignTree(tree: any, key: string, value: any): void {
  assertKey(key)
  const parent = assignmentParent(tree, key, true)
  parent[key.split('.').at(-1)!] = value
}

function deleteTree(tree: any, key: string): void {
  const segments = key.split('.')
  const last = segments.pop()!
  const parent = segments.length ? treeEntry(tree, segments.join('.')).value : tree
  if (isTree(parent)) delete parent[last]
}

export function createLocaleStore(config: ResolvedConfig) {
  const LOCALES_DIR = config.localesDir
  const compareLanguages = (a: string, b: string) =>
    Number(b === config.baseLanguage) - Number(a === config.baseLanguage) ||
    (a < b ? -1 : a > b ? 1 : 0)
  async function writeFormattedJson(
    filePath: string,
    data: unknown,
  ): Promise<void> {
    await safePath(LOCALES_DIR, filePath)
    if (isTree(data) && !Array.isArray(data) && Object.hasOwn(data, '_meta')) {
      const { _meta, ...rest } = data as Record<string, unknown>
      data = { _meta, ...rest }
    }
    const json = JSON.stringify(data, null, 2)
    let formatted: string
    try {
      formatted = await prettier.format(json, {
        ...((await prettier.resolveConfig(filePath)) ?? {}),
        filepath: filePath,
        parser: 'json',
      })
    } catch {
      formatted = json + '\n'
    }
    const destinations = [filePath]
    for (const mirror of config.mirrors)
      destinations.push(
        await safePath(
          mirror,
          path.join(mirror, path.relative(LOCALES_DIR, filePath)),
        ),
      )
    for (const destination of destinations) {
      await fs.mkdir(path.dirname(destination), { recursive: true })
      await fs.writeFile(destination, formatted, 'utf8')
    }
  }

  async function getLocales(domainFilter?: string): Promise<FlatLocaleData> {
    validateDomain(domainFilter)
    const entries = await fs.readdir(LOCALES_DIR, { withFileTypes: true })
    const langDirs = entries
      .filter((e) => e.isDirectory())
      .map((e) => {
        assertSegment(e.name, 'language')
        return e.name
      })
      .sort(compareLanguages)
    const localesData: FlatLocaleData = Object.create(null)

    for (const lang of langDirs) {
      localesData[lang] = Object.create(null)
      const langDirPath = path.join(LOCALES_DIR, lang)
      let files: string[] = []
      try {
        files = await fs.readdir(langDirPath)
      } catch (e) {
        continue
      }

      let jsonFiles = files.filter((f) => f.endsWith('.json')).sort()
      if (domainFilter) {
        const filterName = domainFilter.endsWith('.json')
          ? domainFilter
          : domainFilter + '.json'
        jsonFiles = jsonFiles.filter((f) => f === filterName)
      }

      for (const file of jsonFiles) {
        try {
          const content = await fs.readFile(
            await safePath(LOCALES_DIR, path.join(langDirPath, file)),
            'utf-8',
          )
          const parsed = JSON.parse(content)
          const flat = flattenObject(parsed)
          Object.assign(localesData[lang], flat)
        } catch (err) {
          console.error(`Error reading ${lang}/${file}:`, err)
        }
      }
    }

    return localesData
  }

  async function saveLocale(
    lang: string,
    newData: Record<string, string>,
  ): Promise<void> {
    assertSegment(lang, 'language')
    validateChanges(newData)
    const langDirPath = path.join(LOCALES_DIR, lang)

    await safePath(LOCALES_DIR, langDirPath)
    await fs.mkdir(langDirPath, { recursive: true })

    let files: string[] = []
    try {
      files = await fs.readdir(langDirPath)
    } catch (e) {}

    const jsonFiles = files.filter((f) => f.endsWith('.json')).sort()

    const fileDataMap: Record<string, any> = Object.create(null)
    const touchedFiles = new Set<string>()

    const segmentToFileMap: Record<string, string> = Object.create(null)

    for (const file of jsonFiles) {
      fileDataMap[file] = Object.create(null)
      try {
        const content = await fs.readFile(
          await safePath(LOCALES_DIR, path.join(langDirPath, file)),
          'utf-8',
        )
        const parsed = JSON.parse(content)
        fileDataMap[file] = parsed

        for (const key of Object.keys(parsed)) {
          segmentToFileMap[key] = file
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      }
    }

    for (const [flatKey, value] of Object.entries(newData)) {
      const rootSegment = flatKey.split('.')[0]

      const mappedDomain = Object.entries(config.allowedRoots).find(
        ([, roots]) => roots.includes(rootSegment),
      )?.[0]
      const targetFile =
        segmentToFileMap[rootSegment] || `${mappedDomain ?? rootSegment}.json`

      if (!fileDataMap[targetFile]) {
        fileDataMap[targetFile] = Object.create(null)
      }
      assignTree(fileDataMap[targetFile], flatKey, value)
      touchedFiles.add(targetFile)

      segmentToFileMap[rootSegment] = targetFile
    }

    for (const file of [...touchedFiles].sort()) {
      await writeFormattedJson(path.join(langDirPath, file), fileDataMap[file])
    }
  }

  async function deleteKeyAcrossLocales(
    keyToDelete: string,
    domainFilter?: string,
    targetLang?: string,
  ): Promise<number> {
    assertKey(keyToDelete)
    validateDomain(domainFilter)
    if (targetLang) assertSegment(targetLang, 'language')
    const entries = await fs.readdir(LOCALES_DIR, { withFileTypes: true })
    const langDirs = entries
      .filter((e) => e.isDirectory())
      .map((e) => {
        assertSegment(e.name, 'language')
        return e.name
      })
      .sort(compareLanguages)
    let deletedCount = 0

    for (const lang of langDirs) {
      if (targetLang && lang !== targetLang) continue
      const langDirPath = path.join(LOCALES_DIR, lang)
      let files: string[] = []
      try {
        files = await fs.readdir(langDirPath)
      } catch (e) {
        continue
      }

      let jsonFiles = files.filter((f) => f.endsWith('.json')).sort()
      if (domainFilter) {
        const filterName = domainFilter.endsWith('.json')
          ? domainFilter
          : domainFilter + '.json'
        jsonFiles = jsonFiles.filter((f) => f === filterName)
      }

      for (const file of jsonFiles) {
        const filePath = path.join(langDirPath, file)
        try {
          const content = await fs.readFile(
            await safePath(LOCALES_DIR, filePath),
            'utf-8',
          )
          const parsed = JSON.parse(content)
          const flat = flattenObject(parsed)

          const deletedKeys = Object.keys(flat).filter(
            (key) => key === keyToDelete || key.startsWith(keyToDelete + '.'),
          )
          if (deletedKeys.length) {
            deleteTree(parsed, keyToDelete)
            deletedCount += deletedKeys.length
            await writeFormattedJson(filePath, parsed)
          }
        } catch (err) {
          throw err
        }
      }
    }

    return deletedCount
  }

  async function renameKeyAcrossLocales(
    oldKey: string,
    newKey: string,
    domainFilter?: string,
  ): Promise<number> {
    assertKey(oldKey)
    assertKey(newKey)
    validateDomain(domainFilter)
    const sourceDomain = oldKey.split('.')[0]
    const targetDomain = newKey.split('.')[0]
    if (sourceDomain !== targetDomain)
      throw new Error(
        `Cross-domain rename from "${sourceDomain}" to "${targetDomain}" is not supported; use --update "LANG:${newKey}=VALUE" then --delete "${oldKey}" instead`,
      )
    if (newKey.startsWith(oldKey + '.'))
      throw new Error(`Cannot rename "${oldKey}" into its own descendant "${newKey}"`)
    const entries = await fs.readdir(LOCALES_DIR, { withFileTypes: true })
    const langDirs = entries
      .filter((e) => e.isDirectory())
      .map((e) => {
        assertSegment(e.name, 'language')
        return e.name
      })
      .sort(compareLanguages)
    let renamedCount = 0
    const pending: { filePath: string; parsed: any; keys: string[]; value: any }[] = []

    for (const lang of langDirs) {
      const langDirPath = path.join(LOCALES_DIR, lang)
      let files: string[] = []
      try {
        files = await fs.readdir(langDirPath)
      } catch (e) {
        continue
      }

      let jsonFiles = files.filter((f) => f.endsWith('.json')).sort()
      if (domainFilter) {
        const filterName = domainFilter.endsWith('.json')
          ? domainFilter
          : domainFilter + '.json'
        jsonFiles = jsonFiles.filter((f) => f === filterName)
      }

      for (const file of jsonFiles) {
        const filePath = path.join(langDirPath, file)
        try {
          const content = await fs.readFile(
            await safePath(LOCALES_DIR, filePath),
            'utf-8',
          )
          const parsed = JSON.parse(content)
          const flat = flattenObject(parsed)

          // Preflight every selected language/file, even those without oldKey.
          if (
            treeEntry(parsed, newKey).exists ||
            Object.keys(flat).some((key) => key === newKey || key.startsWith(newKey + '.'))
          )
            throw new Error(`Rename target "${newKey}" already exists in ${lang}/${file}`)
          assignmentParent(parsed, newKey, false)
          const keys = Object.keys(flat).filter(
            (key) => key === oldKey || key.startsWith(oldKey + '.'),
          )
          if (keys.length)
            pending.push({ filePath, parsed, keys, value: treeEntry(parsed, oldKey).value })
        } catch (err) {
          throw err
        }
      }
    }

    // Mutate only after collision checks finish; count the original leaves once.
    for (const { filePath, parsed, keys, value } of pending) {
      deleteTree(parsed, oldKey)
      assignTree(parsed, newKey, value)
      await writeFormattedJson(filePath, parsed)
      renamedCount += keys.length
    }

    return renamedCount
  }

  async function replaceTextInLocale(
    lang: string,
    oldText: string,
    newText: string,
    domainFilter?: string,
  ): Promise<number> {
    assertSegment(lang, 'language')
    validateDomain(domainFilter)
    if (!oldText) throw new Error('Replacement text must be nonempty')
    const langDirPath = path.join(LOCALES_DIR, lang)
    let files: string[] = []
    try {
      files = await fs.readdir(langDirPath)
    } catch (err) {
      return 0
    }

    let jsonFiles = files.filter((f) => f.endsWith('.json')).sort()
    if (domainFilter) {
      const filterName = domainFilter.endsWith('.json')
        ? domainFilter
        : domainFilter + '.json'
      jsonFiles = jsonFiles.filter((f) => f === filterName)
    }

    let replaceCount = 0

    for (const file of jsonFiles) {
      const filePath = path.join(langDirPath, file)
      try {
        const content = await fs.readFile(
          await safePath(LOCALES_DIR, filePath),
          'utf-8',
        )
        const parsed = JSON.parse(content)
        const flat = flattenObject(parsed)
        let modified = false

        for (const key of Object.keys(flat)) {
          const val = String(flat[key])
          if (val.includes(oldText)) {
            assignTree(parsed, key, val.replaceAll(oldText, newText))
            replaceCount++
            modified = true
          }
        }

        if (modified) {
          await writeFormattedJson(filePath, parsed)
        }
      } catch (err) {
        throw err
      }
    }

    return replaceCount
  }

  async function checkLocaleNesting(
    domainFilter?: string,
  ): Promise<Record<string, string[]>> {
    validateDomain(domainFilter)
    const ALLOWED_KEYS_BY_DOMAIN = config.allowedRoots

    const entries = await fs.readdir(LOCALES_DIR, { withFileTypes: true })
    const langDirs = entries
      .filter((e) => e.isDirectory())
      .map((e) => {
        assertSegment(e.name, 'language')
        return e.name
      })
      .sort(compareLanguages)
    const invalidKeysMap: Record<string, string[]> = Object.create(null)

    for (const lang of langDirs) {
      const langDirPath = path.join(LOCALES_DIR, lang)
      let files: string[] = []
      try {
        files = await fs.readdir(langDirPath)
      } catch (e) {
        continue
      }

      let jsonFiles = files.filter((f) => f.endsWith('.json')).sort()
      if (domainFilter) {
        const filterName = domainFilter.endsWith('.json')
          ? domainFilter
          : domainFilter + '.json'
        jsonFiles = jsonFiles.filter((f) => f === filterName)
      }

      for (const file of jsonFiles) {
        if (file === '_meta.json') continue

        const filePath = path.join(langDirPath, file)
        const domain = file.replace('.json', '')
        const allowedKeys = Object.hasOwn(ALLOWED_KEYS_BY_DOMAIN, domain)
          ? ALLOWED_KEYS_BY_DOMAIN[domain]
          : [domain]

        try {
          const content = await fs.readFile(
            await safePath(LOCALES_DIR, filePath),
            'utf-8',
          )
          const parsed = JSON.parse(content)
          const topLevelKeys = Object.keys(parsed)

          const invalidKeys = topLevelKeys.filter(
            (key) => !allowedKeys.includes(key) && key !== '_meta',
          )
          if (invalidKeys.length > 0) {
            const relativePath = path.relative(process.cwd(), filePath)
            invalidKeysMap[relativePath] = invalidKeys
          }
        } catch (err) {}
      }
    }

    return invalidKeysMap
  }

  async function checkLocaleDuplicates(
    domainFilter?: string,
  ): Promise<DuplicateCheckResult> {
    validateDomain(domainFilter)
    const entries = await fs.readdir(LOCALES_DIR, { withFileTypes: true })
    const langDirs = entries
      .filter((e) => e.isDirectory())
      .map((e) => {
        assertSegment(e.name, 'language')
        return e.name
      })
      .sort(compareLanguages)

    const invalidKeys: Record<string, string[]> = Object.create(null)
    const invalidValues: Record<string, Record<string, string[]>> = Object.create(null)

    for (const lang of langDirs) {
      const langDirPath = path.join(LOCALES_DIR, lang)
      let files: string[] = []
      try {
        files = await fs.readdir(langDirPath)
      } catch (e) {
        continue
      }

      let jsonFiles = files.filter((f) => f.endsWith('.json')).sort()
      if (domainFilter) {
        const filterName = domainFilter.endsWith('.json')
          ? domainFilter
          : domainFilter + '.json'
        jsonFiles = jsonFiles.filter((f) => f === filterName)
      }

      const keyFileMap: Record<string, string[]> = Object.create(null)
      const valueKeyMap: Record<string, string[]> = Object.create(null)

      for (const file of jsonFiles) {
        if (file === '_meta.json') continue

        const filePath = path.join(langDirPath, file)
        const relativePath = path.relative(process.cwd(), filePath)

        try {
          const content = await fs.readFile(
            await safePath(LOCALES_DIR, filePath),
            'utf-8',
          )
          const parsed = JSON.parse(content)
          const flat = flattenObject(parsed)

          for (const [key, value] of Object.entries(flat)) {
            if (!keyFileMap[key]) {
              keyFileMap[key] = []
            }
            keyFileMap[key].push(relativePath)

            const strVal = String(value).trim()
            if (strVal.length >= 2) {
              if (!valueKeyMap[strVal]) {
                valueKeyMap[strVal] = []
              }
              valueKeyMap[strVal].push(key)
            }
          }
        } catch (err) {}
      }

      for (const [key, fileList] of Object.entries(keyFileMap)) {
        if (fileList.length > 1) {
          invalidKeys[key] = fileList
        }
      }

      const langDuplicates: Record<string, string[]> = Object.create(null)
      for (const [val, keyList] of Object.entries(valueKeyMap)) {
        if (keyList.length > 1) {
          langDuplicates[val] = keyList
        }
      }

      if (Object.keys(langDuplicates).length > 0) {
        invalidValues[lang] = langDuplicates
      }
    }

    return { invalidKeys, invalidValues }
  }

  return {
    config,
    getLocales,
    saveLocale,
    deleteKeyAcrossLocales,
    renameKeyAcrossLocales,
    replaceTextInLocale,
    checkLocaleNesting,
    checkLocaleDuplicates,
  }
}
export type LocaleStore = ReturnType<typeof createLocaleStore>
export async function createI18n(
  options: I18nConfig = {},
  root = process.cwd(),
): Promise<LocaleStore> {
  return createLocaleStore(await loadConfig(root, options))
}
