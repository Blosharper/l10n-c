#!/usr/bin/env node
import fs from 'fs/promises'
import path from 'path'
import { createLocaleStore, validateChanges, type LocaleStore } from './core'
import { loadConfig } from './config'

function getRemovedText(oldStr: string, newStr: string): string {
  let prefixLen = 0
  const minLen = Math.min(oldStr.length, newStr.length)
  while (prefixLen < minLen && oldStr[prefixLen] === newStr[prefixLen]) {
    prefixLen++
  }

  let suffixLen = 0
  while (
    suffixLen < minLen - prefixLen &&
    oldStr[oldStr.length - 1 - suffixLen] ===
      newStr[newStr.length - 1 - suffixLen]
  ) {
    suffixLen++
  }

  return oldStr.substring(prefixLen, oldStr.length - suffixLen).trim()
}

let store: LocaleStore

async function getSourceFiles(
  dir: string,
  ignored: string[],
): Promise<string[]> {
  const results: string[] = []
  const list = (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  for (const file of list) {
    if (ignored.includes(file.name) || file.isSymbolicLink()) continue
    const res = path.resolve(dir, file.name)
    if (file.isDirectory()) {
      results.push(...(await getSourceFiles(res, ignored)))
    } else if (
      file.isFile() &&
      /\.(ts|js|cjs|mjs|tsx|jsx|html)$/.test(file.name)
    ) {
      results.push(res)
    }
  }
  return results
}

/** Separate code and comments; only code literals establish subtree use. */
function splitCodeAndComments(
  source: string,
  isHtml: boolean,
): { code: string; comments: string } {
  const code: string[] = []
  const comments: string[] = []
  const len = source.length

  if (isHtml) {
    let i = 0
    while (i < len) {
      const open = source.indexOf('<!--', i)
      if (open === -1) {
        code.push(source.slice(i))
        break
      }
      code.push(source.slice(i, open))
      const close = source.indexOf('-->', open + 4)
      const end = close === -1 ? len : close + 3
      comments.push(source.slice(open, end) + '\n')
      code.push('\n')
      i = end
    }
    return { code: code.join(''), comments: comments.join('') }
  }

  const regexAllowedBefore =
    /(^|[([{,;:!&|?+\-*/%~^<>=]|\b(?:return|typeof|instanceof|in|of|new|delete|void|do|else|yield|await|case))\s*$/

  const inTemplate: boolean[] = [false]
  const braceDepths: number[] = []
  let braceDepth = 0
  let tail = ''

  const emit = (s: string) => {
    code.push(s)
    tail = (tail + s).slice(-32)
  }

  let i = 0
  while (i < len) {
    const c = source[i]
    const c2 = source[i + 1]

    if (inTemplate[inTemplate.length - 1]) {
      if (c === '\\') {
        emit(source.slice(i, i + 2))
        i += 2
      } else if (c === '`') {
        inTemplate.pop()
        emit(c)
        i++
      } else if (c === '$' && c2 === '{') {
        inTemplate.push(false)
        braceDepths.push(braceDepth)
        braceDepth = 0
        emit('${')
        i += 2
      } else {
        emit(c)
        i++
      }
      continue
    }

    if (c === '/' && c2 === '/') {
      let j = i + 2
      while (j < len && source[j] !== '\n') {
        j++
      }
      comments.push(source.slice(i, j) + '\n')
      emit('\n')
      i = j
      continue
    }

    if (c === '/' && c2 === '*') {
      const close = source.indexOf('*/', i + 2)
      const end = close === -1 ? len : close + 2
      comments.push(source.slice(i, end) + '\n')
      emit('\n')
      i = end
      continue
    }

    if (c === "'" || c === '"') {
      let j = i + 1
      while (j < len && source[j] !== c && source[j] !== '\n') {
        j += source[j] === '\\' ? 2 : 1
      }
      const end = Math.min(j + 1, len)
      emit(source.slice(i, end))
      i = end
      continue
    }

    if (c === '`') {
      inTemplate.push(true)
      emit(c)
      i++
      continue
    }

    if (c === '/' && regexAllowedBefore.test(tail)) {
      let j = i + 1
      let inClass = false
      let closed = false
      while (j < len && source[j] !== '\n') {
        const d = source[j]
        if (d === '\\') {
          j += 2
          continue
        }
        if (inClass) {
          inClass = d !== ']'
        } else if (d === '[') {
          inClass = true
        } else if (d === '/') {
          closed = true
          j++
          break
        }
        j++
      }
      if (closed) {
        emit(source.slice(i, j))
        i = j
        continue
      }
    }

    if (c === '{') {
      braceDepth++
    } else if (c === '}') {
      if (braceDepth === 0 && inTemplate.length > 1) {
        inTemplate.pop()
        braceDepth = braceDepths.pop() ?? 0
        emit(c)
        i++
        continue
      }
      braceDepth--
    }
    emit(c)
    i++
  }

  return { code: code.join(''), comments: comments.join('') }
}

async function run() {
  const args = process.argv.slice(2)
  const config = await loadConfig()
  store = createLocaleStore(config)
  const compareLanguages = (a: string, b: string) =>
    Number(b === config.baseLanguage) - Number(a === config.baseLanguage) ||
    (a < b ? -1 : a > b ? 1 : 0)
  const {
    saveLocale,
    getLocales,
    deleteKeyAcrossLocales,
    renameKeyAcrossLocales,
    replaceTextInLocale,
  } = store

  let publishData = ''
  let searchKeyword = ''
  const updates: Array<{ lang: string; key: string; value: string }> = []
  let showHelp = false
  let showUnused = false
  let doNestCheck = false
  let doDuplicateCheck = false

  let deleteKey = ''
  let renameStr = ''
  let missingLang = ''
  let domainFilter = ''
  let replaceTextStr = ''

  if (args.length === 0) {
    showHelp = true
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]

    if (arg === '--help' || arg === '-h') {
      showHelp = true
    } else if (arg.startsWith('--publish=')) {
      publishData = arg.substring('--publish='.length)
    } else if (arg === '--publish') {
      publishData = requiredValue(++i)
    } else if (arg.startsWith('--search=')) {
      searchKeyword = arg.substring('--search='.length)
    } else if (arg.startsWith('-s=')) {
      searchKeyword = arg.substring('-s='.length)
    } else if (arg === '--search' || arg === '-s') {
      searchKeyword = requiredValue(++i)
    } else if (arg.startsWith('--update=')) {
      parseUpdate(arg.substring('--update='.length))
    } else if (arg.startsWith('-u=')) {
      parseUpdate(arg.substring('-u='.length))
    } else if (arg === '--update' || arg === '-u') {
      parseUpdate(requiredValue(++i))
    } else if (arg.startsWith('--delete=')) {
      deleteKey = arg.substring('--delete='.length)
    } else if (arg.startsWith('-d=')) {
      deleteKey = arg.substring('-d='.length)
    } else if (arg === '--delete' || arg === '-d') {
      deleteKey = requiredValue(++i)
    } else if (arg.startsWith('--rename=')) {
      renameStr = arg.substring('--rename='.length)
    } else if (arg.startsWith('-r=')) {
      renameStr = arg.substring('-r='.length)
    } else if (arg === '--rename' || arg === '-r') {
      renameStr = requiredValue(++i)
    } else if (arg.startsWith('--missing=')) {
      missingLang = arg.substring('--missing='.length)
    } else if (arg.startsWith('-m=')) {
      missingLang = arg.substring('-m='.length)
    } else if (arg === '--missing' || arg === '-m') {
      const nextArg = args[i + 1]
      if (nextArg && !nextArg.startsWith('-')) {
        missingLang = requiredValue(++i)
      } else {
        missingLang = config.baseLanguage
      }
    } else if (arg.startsWith('--file=') || arg.startsWith('--domain=')) {
      domainFilter = arg.substring(arg.indexOf('=') + 1)
    } else if (arg.startsWith('-f=')) {
      domainFilter = arg.substring('-f='.length)
    } else if (arg === '--file' || arg === '--domain' || arg === '-f') {
      domainFilter = requiredValue(++i)
    } else if (arg.startsWith('--replace-text=')) {
      replaceTextStr = arg.substring('--replace-text='.length)
    } else if (arg.startsWith('-R=')) {
      replaceTextStr = arg.substring('-R='.length)
    } else if (arg === '--replace-text' || arg === '-R') {
      replaceTextStr = requiredValue(++i)
    } else if (arg === '--unused' || arg === '-w') {
      showUnused = true
    } else if (arg === '--nest-check' || arg === '-N') {
      doNestCheck = true
    } else if (arg === '--duplicate-check' || arg === '-D') {
      doDuplicateCheck = true
    } else {
      throw new Error(`Unknown option: ${arg}`)
    }
  }

  function requiredValue(index: number): string {
    if (!args[index] || args[index].startsWith('--'))
      throw new Error(`Missing value for ${args[index - 1]}`)
    return args[index]
  }

  function parseUpdate(updateStr: string) {
    if (!updateStr) return
    const match = updateStr.match(/^([^:]+):([^=]+)=(.*)$/)
    if (match) {
      const lang = match[1]
      if (!/^[a-zA-Z0-9_-]+$/.test(lang)) {
        console.error(
          `❌ Unsupported language code: "${lang}". Use a simple language code such as en or pt-BR`,
        )
        process.exit(1)
      }
      updates.push({ lang, key: match[2], value: match[3] })
    } else {
      console.error(
        `❌ Invalid update format: ${updateStr}. Use lang:key=value (e.g. en:ui.start=Start)`,
      )
      process.exit(1)
    }
  }

  if (showHelp) {
    console.log(`
🌸 i18n-c

Usage: i18n-c [options]
Config: i18n-c.config.json in the current directory

  -h, --help                 Show help
  -f, --file, --domain NAME   Filter one domain (ui or ui.json)
  -s, --search TEXT          Search keys and values (case insensitive)
  -u, --update L:K=VALUE     Update a key (repeatable)
  -d, --delete [L:]KEY       Delete a key or subtree, in one or every language
  -r, --rename OLD=NEW       Rename a key or subtree within its domain
  -m, --missing[=LANG]       List missing keys relative to the configured base
  -R, --replace-text L:A=B   Replace text in one language
  -w, --unused               Scan configured source paths for unused keys
  -N, --nest-check           Check file=domain top-level nesting
  -D, --duplicate-check      Check keys across files and repeated values
  --publish JSON             Merge {"en":{"ui.start":"Start"}}

Missing keys and repeated values are advisory (exit 0).
Invalid nesting, duplicate keys and operation failures exit 1.
`)
    process.exit(0)
  }

  try {
    if (doNestCheck) {
      await performNestCheck(domainFilter)
      return
    }

    if (doDuplicateCheck) {
      await performDuplicateCheck(domainFilter)
      return
    }

    if (replaceTextStr) {
      const match = replaceTextStr.match(/^([^:]+):([^=]+)=(.*)$/)
      if (match) {
        const lang = match[1]
        if (!/^[a-zA-Z0-9_-]+$/.test(lang)) {
          console.error(
            `❌ Unsupported language code: "${lang}". Use a simple language code such as en or pt-BR`,
          )
          process.exit(1)
        }
        const oldText = match[2]
        const newText = match[3]

        const invalidFormatMatch = newText.match(
          /(?<!\{)\{[a-zA-Z0-9_]+\}(?!\})|\{{3,}[a-zA-Z0-9_]+\}{3,}/g,
        )
        if (invalidFormatMatch) {
          console.log(
            '\n⚠️ Warning: invalid placeholder format; use double braces such as {{value}}.',
          )
        }

        const targetDesc = domainFilter
          ? ` in ${domainFilter}`
          : ' in all files'
        console.log(
          `🌸 Replacing "${oldText}" with "${newText}" in [${lang}]${targetDesc}...`,
        )
        const count = await replaceTextInLocale(
          lang,
          oldText,
          newText,
          domainFilter,
        )
        if (count > 0) {
          console.log(`✅ Replaced ${count} occurrences successfully.`)
        } else {
          console.error(
            `❌ No occurrences of "${oldText}" found in [${lang}]. Nothing was replaced.`,
          )
          process.exit(1)
        }
      } else {
        console.error(
          `❌ Invalid replace format: ${replaceTextStr}. Use lang:oldText=newText`,
        )
        process.exit(1)
      }
      return
    }

    if (deleteKey) {
      const targetDesc = domainFilter ? ` (Filtered: ${domainFilter})` : ''
      const match = deleteKey.match(/^([^:]+):(.*)$/)
      let targetLang = ''
      let targetKey = deleteKey

      if (match) {
        targetLang = match[1]
        targetKey = match[2]
      }

      const scopeDesc = targetLang
        ? `from locale [${targetLang}]`
        : 'across all locales'
      console.log(`🌸 Deleting key "${targetKey}" ${scopeDesc}...${targetDesc}`)
      const deletedCount = await deleteKeyAcrossLocales(
        targetKey,
        domainFilter,
        targetLang || undefined,
      )
      if (deletedCount > 0) {
        console.log(
          `✅ Key "${targetKey}" has been deleted ${scopeDesc} successfully. (${deletedCount} entries removed)`,
        )
      } else {
        console.error(
          `❌ Key "${targetKey}" not found ${scopeDesc}. Nothing was deleted.`,
        )
        process.exit(1)
      }
      return
    }

    if (renameStr) {
      const match = renameStr.match(/^([^=]+)=([^=]+)$/)
      if (match) {
        const oldKey = match[1]
        const newKey = match[2]
        const targetDesc = domainFilter ? ` (Filtered: ${domainFilter})` : ''
        console.log(
          `🌸 Renaming key "${oldKey}" to "${newKey}" across all locales...${targetDesc}`,
        )
        const renamedCount = await renameKeyAcrossLocales(
          oldKey,
          newKey,
          domainFilter,
        )
        if (renamedCount > 0) {
          console.log(
            `✅ Key renamed successfully. (${renamedCount} entries updated)`,
          )
        } else {
          console.error(
            `❌ Key "${oldKey}" not found in any locale. Nothing was renamed.`,
          )
          process.exit(1)
        }
      } else {
        console.error(
          `❌ Invalid rename format: ${renameStr}. Use oldKey=newKey`,
        )
        process.exit(1)
      }
      return
    }

    if (missingLang) {
      const targetDesc = domainFilter ? ` (Filtered: ${domainFilter})` : ''
      console.log(
        `🌸 Checking for missing translations (Base: ${missingLang})${targetDesc}...`,
      )
      const localesData = await getLocales(domainFilter)
      const baseData = localesData[missingLang]

      if (!baseData) {
        console.error(
          `❌ Base language "${missingLang}" not found${domainFilter ? ` in ${domainFilter}` : ''}.`,
        )
        process.exit(1)
      }

      let missingFound = false
      for (const [lang, flatData] of Object.entries(localesData)) {
        if (lang === missingLang) continue

        const missingKeys: string[] = []
        for (const baseKey of Object.keys(baseData)) {
          if (flatData[baseKey] === undefined) {
            missingKeys.push(baseKey)
          }
        }

        if (missingKeys.length > 0) {
          missingFound = true
          console.log(`\n[${lang}] ⚠️ Missing ${missingKeys.length} keys:`)
          missingKeys.forEach((k) => console.log(`  - ${k}`))
        }
      }

      if (!missingFound) {
        console.log(
          `\n✅ No missing translations found! All languages are synced with "${missingLang}".`,
        )
      }
      return
    }

    if (searchKeyword) {
      const targetDesc = domainFilter ? ` (Filtered: ${domainFilter})` : ''
      console.log(
        `🌸 Searching for "${searchKeyword}" in all locales...${targetDesc}`,
      )
      const localesData = await getLocales(domainFilter)
      let foundCount = 0
      for (const [lang, flatData] of Object.entries(localesData)) {
        for (const [key, value] of Object.entries(flatData)) {
          const strValue = String(value)
          if (
            key.toLowerCase().includes(searchKeyword.toLowerCase()) ||
            strValue.toLowerCase().includes(searchKeyword.toLowerCase())
          ) {
            console.log(`[${lang}] ${key}: ${strValue}`)
            foundCount++
          }
        }
      }
      if (foundCount === 0) {
        console.log(`❌ No results found for "${searchKeyword}".`)
      } else {
        console.log(`✅ Found ${foundCount} results.`)
      }
      return
    }

    if (showUnused) {
      const targetDesc = domainFilter ? ` (Filtered: ${domainFilter})` : ''

      console.log(
        `🌸 Scanning for unused translation keys in ${config.sourcePaths.map((p) => path.relative(config.root, p)).join(', ')}...${targetDesc}`,
      )
      const sourceFiles: string[] = []
      for (const target of config.sourcePaths) {
        if (
          path
            .relative(config.root, target)
            .split(path.sep)
            .some((part) => config.sourceIgnore.includes(part))
        )
          continue
        try {
          const stat = await fs.lstat(target)
          if (stat.isSymbolicLink()) continue
          if (stat.isDirectory())
            sourceFiles.push(
              ...(await getSourceFiles(target, config.sourceIgnore)),
            )
          else if (
            stat.isFile() &&
            /\.(ts|js|cjs|mjs|tsx|jsx|html)$/.test(target)
          )
            sourceFiles.push(target)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }

      let codeContent = ''
      let commentContent = ''
      for (const file of sourceFiles) {
        const content = await fs.readFile(file, 'utf-8')
        const { code, comments } = splitCodeAndComments(
          content,
          file.endsWith('.html'),
        )
        codeContent += code + '\n'
        commentContent += comments + '\n'
      }

      const localesData = await getLocales(domainFilter)
      const baseData = localesData[config.baseLanguage]
      if (!baseData) {
        console.error(
          `❌ Base language "${config.baseLanguage}" not found for scanning.`,
        )
        process.exit(1)
      }

      const collectRefs = (text: string) => {
        const refs = new Set<string>()
        for (const m of text.matchAll(
          /(['"`])([a-z][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_]+)+)\1/g,
        )) {
          refs.add(m[2])

          for (const prefix of config.referencePrefixes)
            refs.add(`${prefix}${m[2]}`)
        }
        return refs
      }
      const codeRefs = collectRefs(codeContent)
      const commentRefs = collectRefs(commentContent)

      const dynamicPrefixes = new Set<string>()
      for (const text of [codeContent, commentContent]) {
        for (const m of text.matchAll(
          /`([a-z][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_]+)*[.a-zA-Z0-9_]*?)\$\{/g,
        )) {
          const p = m[1]
          if (p.includes('.')) {
            dynamicPrefixes.add(p)
            for (const prefix of config.referencePrefixes)
              dynamicPrefixes.add(`${prefix}${p}`)
          }
        }
      }

      //

      const subtreeRoots = [...codeRefs]
      const referenced = (key: string) =>
        codeRefs.has(key) ||
        commentRefs.has(key) ||
        subtreeRoots.some((root) => key.startsWith(root + '.'))

      const isMetaKey = (key: string) =>
        key === '_meta' || key.startsWith('_meta.') || /^parts\.\d+$/.test(key)

      const allKeys = Object.keys(baseData).filter((k) => !isMetaKey(k))
      const unusedKeys: string[] = []
      const potentialDynamicKeys: string[] = []

      for (const key of allKeys) {
        if (referenced(key)) {
          continue
        }

        const isPotentialDynamic = [...dynamicPrefixes].some((p) =>
          key.startsWith(p),
        )

        if (isPotentialDynamic) {
          potentialDynamicKeys.push(key)
        } else {
          unusedKeys.push(key)
        }
      }

      console.log(`\n🚫 Completely Unused Keys (${unusedKeys.length}):`)
      if (unusedKeys.length === 0) {
        console.log('  (None)')
      } else {
        unusedKeys.sort().forEach((k) => console.log(`  - ${k}`))
      }

      console.log(
        `\n⚡ Potentially Dynamically Constructed Keys (${potentialDynamicKeys.length}):`,
      )
      if (potentialDynamicKeys.length === 0) {
        console.log('  (None)')
      } else {
        potentialDynamicKeys.sort().forEach((k) => console.log(`  - ${k}`))
      }
      return
    }

    if (updates.length > 0) {
      console.log(`🌸 Processing ${updates.length} updates...`)

      const localesData = await getLocales(domainFilter)

      const changesByLang: Record<string, Record<string, string>> = Object.create(null)
      for (const update of updates) {
        if (!changesByLang[update.lang]) {
          changesByLang[update.lang] = Object.create(null)
        }
        changesByLang[update.lang][update.key] = update.value

        if (String(update.value).includes('\\n')) {
          console.log(
            '\n⚠️ Warning: literal \\n detected; use actual newlines in translation values.',
          )
        }

        const invalidFormatMatch = String(update.value).match(
          /(?<!\{)\{[a-zA-Z0-9_]+\}(?!\})|\{{3,}[a-zA-Z0-9_]+\}{3,}/g,
        )
        if (invalidFormatMatch) {
          console.log(
            '\n⚠️ Warning: invalid placeholder format; use double braces such as {{value}}.',
          )
        }

        const flatData = localesData[update.lang]
        if (flatData && flatData[update.key] !== undefined) {
          const oldValue = String(flatData[update.key])
          const newValue = String(update.value)

          if (oldValue !== newValue) {
            const removedText = getRemovedText(oldValue, newValue)

            if (removedText.length >= 2) {
              let foundCount = 0
              for (const [k, v] of Object.entries(flatData)) {
                if (k !== update.key && String(v).includes(removedText)) {
                  foundCount++
                }
              }

              if (foundCount > 0) {
                console.log(
                  `\n💡 Removed text '${removedText}' remains in ${foundCount} other entries in [${update.lang}].`,
                )
                console.log(
                  `Consider i18n-c -R "${update.lang}:${removedText}=..."`,
                )
              }
            }
          }
        } else {
          let existsInOtherLang = false
          for (const [otherLang, otherData] of Object.entries(localesData)) {
            if (
              otherLang !== update.lang &&
              otherData[update.key] !== undefined
            ) {
              existsInOtherLang = true
              break
            }
          }

          if (!existsInOtherLang) {
            console.log(
              `\n⚠️ Warning: new key '${update.key}' does not exist in other languages. Check its spelling.`,
            )
          }
        }
      }

      for (const lang of Object.keys(changesByLang).sort(compareLanguages)) {
        const langChanges = changesByLang[lang]
        await saveLocale(lang, langChanges)
        const existingFlat = localesData[lang] || {}
        const createdKeys = Object.keys(langChanges).filter(
          (k) => existingFlat[k] === undefined,
        )
        const updatedCount =
          Object.keys(langChanges).length - createdKeys.length
        const createdDesc =
          createdKeys.length > 0
            ? `, ${createdKeys.length} created (🆕 ${createdKeys.join(', ')})`
            : ''
        console.log(
          `✅ Saved to ${lang}: ${updatedCount} updated${createdDesc}`,
        )
      }
      console.log('🎉 All updates applied successfully.')
      return
    }

    if (publishData) {
      const changes = JSON.parse(publishData)
      if (!changes || typeof changes !== 'object' || Array.isArray(changes))
        throw new Error('Publish data must be an object')
      const langs = Object.keys(changes).sort(compareLanguages)
      for (const data of Object.values(changes)) validateChanges(data)

      for (const lang of langs) {
        if (!/^[a-zA-Z0-9_-]+$/.test(lang)) {
          console.error(
            `❌ Unsupported language code in publish data: "${lang}". Use a simple language code such as en or pt-BR`,
          )
          process.exit(1)
        }
      }

      console.log('🌸 i18n-c')
      console.log(`Processing changes for ${langs.length} languages...`)

      for (const lang of langs) {
        const langChanges = changes[lang]
        const keyCount = Object.keys(langChanges).length

        if (keyCount > 0) {
          let hasDoubleEscape = false
          let invalidFormats = new Set<string>()
          for (const val of Object.values(langChanges)) {
            if (typeof val === 'string') {
              if (val.includes('\\n')) {
                hasDoubleEscape = true
              }
              const matches = val.match(
                /(?<!\{)\{[a-zA-Z0-9_]+\}(?!\})|\{{3,}[a-zA-Z0-9_]+\}{3,}/g,
              )
              if (matches) {
                matches.forEach((m) => invalidFormats.add(m))
              }
            }
          }
          if (hasDoubleEscape) {
            console.log(
              '\n⚠️ Warning: literal \\n detected; use actual newlines in translation values.',
            )
          }
          if (invalidFormats.size > 0) {
            console.log(
              '\n⚠️ Warning: invalid placeholder format; use double braces such as {{value}}.',
            )
          }

          await saveLocale(lang, langChanges)
          console.log(`✅ Saved ${keyCount} keys to ${lang}`)
        }
      }

      console.log('🎉 All changes published successfully.')
      return
    }

    console.log('❌ No action specified. Use --help for usage information.')
    process.exit(1)
  } catch (err: any) {
    console.error(`❌ Operation failed: ${err.message}`)
    process.exit(1)
  }
}

async function performNestCheck(domainFilter?: string) {
  const targetDesc = domainFilter ? ` (Filtered: ${domainFilter})` : ''
  console.log(
    `🌸 Checking for invalid resource nesting structure${targetDesc}...`,
  )

  const invalidMap = await store.checkLocaleNesting(domainFilter)
  const files = Object.keys(invalidMap)

  if (files.length === 0) {
    console.log(`\n✅ All resource files have valid nested structures!`)
    process.exit(0)
  }

  console.log(
    `\n❌ Found ${files.length} file(s) with invalid nesting structure:`,
  )
  for (const file of files) {
    console.log(`\n[${file}] ⚠️ Invalid top-level keys:`)
    invalidMap[file].forEach((k) => console.log(`  - ${k}`))
  }
  process.exit(1)
}

async function performDuplicateCheck(domainFilter?: string) {
  const targetDesc = domainFilter ? ` (Filtered: ${domainFilter})` : ''
  console.log(`🌸 Checking for duplicated resources${targetDesc}...`)

  const { invalidKeys, invalidValues } =
    await store.checkLocaleDuplicates(domainFilter)
  let hasDuplicates = false

  const dupKeys = Object.keys(invalidKeys)
  if (dupKeys.length > 0) {
    hasDuplicates = true
    console.log(
      `\n❌ Found ${dupKeys.length} duplicated flat key(s) across files:`,
    )
    for (const key of dupKeys) {
      console.log(`  - Key "${key}" exists in:`)
      invalidKeys[key].forEach((f) => console.log(`    👉 ${f}`))
    }
  }

  for (const [lang, duplicates] of Object.entries(invalidValues)) {
    const dupVals = Object.keys(duplicates)
    if (dupVals.length > 0) {
      hasDuplicates = true
      console.log(
        `\n⚠️ [${lang}] Found ${dupVals.length} duplicated translation value(s):`,
      )
      for (const val of dupVals) {
        console.log(`  - Value "${val}" is defined in:`)
        duplicates[val].forEach((k) => console.log(`    👉 ${k}`))
      }
    }
  }

  if (!hasDuplicates) {
    console.log(`\n✅ No duplicates found! All keys and values are clean.`)
    process.exit(0)
  }

  if (dupKeys.length > 0) {
    process.exit(1)
  }
  process.exit(0)
}

run().catch((error) => {
  console.error(`❌ Operation failed: ${error.message}`)
  process.exitCode = 1
})
