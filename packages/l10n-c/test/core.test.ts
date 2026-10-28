import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  createI18n,
  createLocaleStore,
  flattenObject,
  unflattenObject,
  loadConfig,
  resolveConfig,
} from '../src/index'
const roots: string[] = []
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'l10n-c-core-'))
  roots.push(root)
  await fs.mkdir(path.join(root, 'messages/en'), { recursive: true })
  await fs.writeFile(
    path.join(root, 'messages/en/ui.json'),
    JSON.stringify({
      _meta: { version: '1' },
      ui: {
        start: 'Start',
        list: ['One', 'Two'],
        group: { a: 'Alpha', b: 'Beta' },
      },
    }),
  )
  return {
    root,
    store: createLocaleStore(
      resolveConfig(
        { localesDir: 'messages', baseLanguage: 'en', mirrors: ['mirror'] },
        root,
      ),
    ),
  }
}
afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  )
})

async function fileBytes(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {}
  async function walk(directory: string) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name)
      if (entry.isDirectory()) await walk(target)
      else result[path.relative(root, target)] = await fs.readFile(target, 'utf8')
    }
  }
  await walk(root)
  return result
}

describe('P1 source-tree preservation', () => {
  it.each(['save', 'delete', 'rename', 'replace'] as const)(
    '%s preserves numeric-keyed objects, arrays and empty nodes in touched files and mirrors',
    async (operation) => {
      const { root, store } = await fixture()
      const ui = {
        change: 'Change',
        codes: { '404': 'Not found', '500': 'Server' },
        empty: {},
        emptyList: [],
        list: ['One', { empty: {}, emptyList: [], value: 'Two' }],
        group: { a: 'Alpha', b: 'Beta', empty: {}, list: [] },
      }
      const source = { ui, _meta: { empty: {}, list: [] }, empty: {}, emptyList: [] }
      const uiFile = path.join(root, 'messages/en/ui.json')
      const untouchedFile = path.join(root, 'messages/en/errors.json')
      const untouched = '{ "errors": { "404": "Not found" }, "empty": {}, "list": [] }\n'
      await fs.writeFile(uiFile, JSON.stringify(source))
      await fs.writeFile(untouchedFile, untouched)
      await fs.mkdir(path.join(root, 'mirror/en'), { recursive: true })
      await fs.writeFile(path.join(root, 'mirror/en/errors.json'), untouched)
      if (operation === 'save') {
        await store.saveLocale('en', { 'ui.change': 'Changed', 'ui.list.1.value': 'Updated' })
        ui.change = 'Changed'
        ;(ui.list[1] as { value: string }).value = 'Updated'
      } else if (operation === 'delete') {
        expect(await store.deleteKeyAcrossLocales('ui.change')).toBe(1)
        delete (ui as Partial<typeof ui>).change
      } else if (operation === 'rename') {
        expect(await store.renameKeyAcrossLocales('ui.group', 'ui.panel')).toBe(2)
        Object.assign(ui, { panel: ui.group })
        delete (ui as Partial<typeof ui>).group
      } else {
        expect(await store.replaceTextInLocale('en', 'Change', 'Changed')).toBe(1)
        ui.change = 'Changed'
      }
      const written = await fs.readFile(uiFile, 'utf8')
      expect(JSON.parse(written)).toEqual(source)
      expect(written.indexOf('"_meta"')).toBeLessThan(written.indexOf('"ui"'))
      expect(await fs.readFile(path.join(root, 'mirror/en/ui.json'), 'utf8')).toBe(written)
      expect(await fs.readFile(untouchedFile, 'utf8')).toBe(untouched)
      expect(await fs.readFile(path.join(root, 'mirror/en/errors.json'), 'utf8')).toBe(untouched)
    },
  )

  it('creates missing numeric paths as objects while updating existing array indices as arrays', async () => {
    const { root, store } = await fixture()
    await store.saveLocale('en', {
      'ui.codes.404': 'Not found',
      'ui.list.0': 'Updated',
      'ui.list.2.404': 'New object in source array',
      'errors.500': 'Server',
    })
    const ui = JSON.parse(await fs.readFile(path.join(root, 'messages/en/ui.json'), 'utf8')).ui
    expect(ui.codes).toEqual({ '404': 'Not found' })
    expect(ui.list).toEqual(['Updated', 'Two', { '404': 'New object in source array' }])
    expect(JSON.parse(await fs.readFile(path.join(root, 'messages/en/errors.json'), 'utf8'))).toEqual({ errors: { '500': 'Server' } })
    const before = await fileBytes(root)
    await expect(store.saveLocale('en', { 'ui.list.label': 'Lost property' })).rejects.toThrow('non-index')
    await expect(store.saveLocale('en', { 'ui.start.child': 'Lost scalar' })).rejects.toThrow('scalar ancestor')
    expect(await fileBytes(root)).toEqual(before)
  })

  it('moves source arrays and numeric-keyed objects without inferring their shapes or recounting leaves', async () => {
    const { root, store } = await fixture()
    await fs.writeFile(path.join(root, 'messages/en/ui.json'), JSON.stringify({
      ui: { group: { codes: { '404': 'Not found' }, list: ['One', {}, []], empty: {}, emptyList: [] }, group_extra: 'Keep' },
    }))
    await store.saveLocale('fr', { 'ui.group.a': 'Alpha', 'ui.group.b': 'Beta' })
    expect(await store.renameKeyAcrossLocales('ui.group', 'ui.grouped', 'ui.json')).toBe(4)
    expect(JSON.parse(await fs.readFile(path.join(root, 'messages/en/ui.json'), 'utf8'))).toEqual({
      ui: { grouped: { codes: { '404': 'Not found' }, list: ['One', {}, []], empty: {}, emptyList: [] }, group_extra: 'Keep' },
    })
    expect(await store.renameKeyAcrossLocales('ui.grouped.list', 'ui.renamedList')).toBe(1)
    expect(JSON.parse(await fs.readFile(path.join(root, 'messages/en/ui.json'), 'utf8')).ui.renamedList).toEqual(['One', {}, []])
    expect(await store.renameKeyAcrossLocales('ui.grouped.codes', 'ui.renamedCodes')).toBe(1)
    expect(JSON.parse(await fs.readFile(path.join(root, 'messages/en/ui.json'), 'utf8')).ui.renamedCodes).toEqual({ '404': 'Not found' })
  })

  it('retains source array indices on delete/rename, serializing removed slots as null', async () => {
    const { root, store } = await fixture()
    expect(await store.renameKeyAcrossLocales('ui.list.0', 'ui.list.2')).toBe(1)
    expect(await store.deleteKeyAcrossLocales('ui.list.1')).toBe(1)
    expect(JSON.parse(await fs.readFile(path.join(root, 'messages/en/ui.json'), 'utf8')).ui.list).toEqual([null, null, 'One'])
  })
})

describe('P1 rename preflight', () => {
  it.each([
    ['exact target', { target: 'Keep' }, 'ui.target'],
    ['subtree collision', { target: { child: 'Keep' } }, 'ui.target'],
    ['empty object target', { target: {} }, 'ui.target'],
    ['empty array target', { target: [] }, 'ui.target'],
    ['null target', { target: null }, 'ui.target'],
    ['scalar ancestor', { parent: 'Keep' }, 'ui.parent.child'],
    ['array non-index', { parent: ['Keep'] }, 'ui.parent.child'],
  ])('rejects %s in a later language before earlier files or mirrors change', async (_name, ui, target) => {
    const { root, store } = await fixture()
    await fs.mkdir(path.join(root, 'messages/fr'))
    // No oldKey here: collision checks still cover this language and later file.
    await fs.writeFile(path.join(root, 'messages/fr/zeta.json'), JSON.stringify({ ui }))
    const before = await fileBytes(root)
    await expect(store.renameKeyAcrossLocales('ui.start', target)).rejects.toThrow()
    expect(await fileBytes(root)).toEqual(before)
  })

  it('rejects a subtree collision in a later domain file of the same language', async () => {
    const { root, store } = await fixture()
    await fs.writeFile(path.join(root, 'messages/en/zeta.json'), '{"ui":{"target":{"child":"Keep"}}}')
    const before = await fileBytes(root)
    await expect(store.renameKeyAcrossLocales('ui.start', 'ui.target')).rejects.toThrow('already exists')
    expect(await fileBytes(root)).toEqual(before)
  })

  it.each([
    ['ui.start', 'ui.start.child', 'descendant'],
    ['ui.group', 'ui.group.child', 'descendant'],
    ['ui.group.a', 'ui.group', 'already exists'],
    ['ui.start', 'ui.start', 'already exists'],
  ])('refuses overlapping rename %s -> %s before writes', async (oldKey, newKey, message) => {
    const { root, store } = await fixture()
    const before = await fileBytes(root)
    await expect(store.renameKeyAcrossLocales(oldKey, newKey)).rejects.toThrow(message)
    expect(await fileBytes(root)).toEqual(before)
  })

  it('retains domain filtering and creates missing numeric destination paths as objects', async () => {
    const { root, store } = await fixture()
    await fs.writeFile(path.join(root, 'messages/en/zeta.json'), '{"ui":{"codes":{"404":"Outside filter"}}}')
    const outside = await fs.readFile(path.join(root, 'messages/en/zeta.json'), 'utf8')
    expect(await store.renameKeyAcrossLocales('ui.start', 'ui.codes.404', 'ui')).toBe(1)
    expect(JSON.parse(await fs.readFile(path.join(root, 'messages/en/ui.json'), 'utf8')).ui.codes).toEqual({ '404': 'Start' })
    expect(await fs.readFile(path.join(root, 'messages/en/zeta.json'), 'utf8')).toBe(outside)
  })
})
describe('locale edits', () => {
  it('roundtrips arrays, metadata and new domains; mirrors formatted writes', async () => {
    const { root, store } = await fixture()
    expect(
      unflattenObject(flattenObject({ ui: { list: ['a', 'b'] } })),
    ).toEqual({ ui: { list: ['a', 'b'] } })
    await store.saveLocale('en', {
      'ui.start': 'Begin\n{{name}}',
      'shop.buy': 'Buy',
    })
    const data = await store.getLocales()
    expect(data.en['ui.start']).toBe('Begin\n{{name}}')
    expect(data.en['ui.list.1']).toBe('Two')
    expect(
      JSON.parse(
        await fs.readFile(path.join(root, 'messages/en/shop.json'), 'utf8'),
      ),
    ).toEqual({ shop: { buy: 'Buy' } })
    const original = await fs.readFile(
      path.join(root, 'messages/en/ui.json'),
      'utf8',
    )
    expect(original.indexOf('"_meta"')).toBeLessThan(original.indexOf('"ui"'))
    expect(
      await fs.readFile(path.join(root, 'mirror/en/ui.json'), 'utf8'),
    ).toBe(original)
    expect(await store.checkLocaleNesting()).toEqual({})
  })
  it('renames and deletes subtrees, scopes language and replaces text', async () => {
    const { store } = await fixture()
    await store.saveLocale('fr', { 'ui.start': 'Start here' })
    expect(await store.renameKeyAcrossLocales('ui.group', 'ui.panel')).toBe(2)
    expect((await store.getLocales()).en['ui.panel.a']).toBe('Alpha')
    expect(await store.replaceTextInLocale('en', 'Start', 'Begin', 'ui')).toBe(
      1,
    )
    expect(
      await store.deleteKeyAcrossLocales('ui.start', 'ui.json', 'fr'),
    ).toBe(1)
    expect((await store.getLocales()).en['ui.start']).toBe('Begin')
    expect(await store.deleteKeyAcrossLocales('ui.panel')).toBe(2)
    await expect(
      store.renameKeyAcrossLocales('ui.start', 'shop.start'),
    ).rejects.toThrow('Cross-domain')
  })
  it('allows explicit legacy roots and otherwise enforces file=domain, skipping metadata file', async () => {
    const { root, store } = await fixture()
    await fs.writeFile(
      path.join(root, 'messages/en/ui.json'),
      '{"ui":{"a":"Same"},"speech":{"a":"Same"}}',
    )
    await fs.writeFile(
      path.join(root, 'messages/en/_meta.json'),
      '{"parts":["ui"]}',
    )
    expect(Object.values(await store.checkLocaleNesting())[0]).toEqual([
      'speech',
    ])
    const compat = createLocaleStore(
      resolveConfig(
        { localesDir: 'messages', allowedRoots: { ui: ['ui', 'speech'] } },
        root,
      ),
    )
    expect(await compat.checkLocaleNesting()).toEqual({})
    await compat.saveLocale('fr', { 'speech.hello': 'Hello' })
    expect(await fs.readdir(path.join(root, 'messages/fr'))).toEqual([
      'ui.json',
    ])
    await fs.writeFile(
      path.join(root, 'messages/en/other.json'),
      '{"ui":{"a":"Same"}}',
    )
    const duplicate = await store.checkLocaleDuplicates()
    expect(duplicate.invalidKeys['ui.a']).toHaveLength(2)
    expect(duplicate.invalidValues.en.Same).toContain('speech.a')
  })
  it('writes valid inherited-name roots and checks their file nesting', async () => {
    const { root, store } = await fixture()
    await store.saveLocale('en', {
      'toString.title': 'Title',
      'toString.hasOwnProperty.label': 'Nested',
      'ui.toString.label': 'UI nested',
    })
    expect(JSON.parse(await fs.readFile(path.join(root, 'messages/en/toString.json'), 'utf8'))).toEqual({
      toString: { title: 'Title', hasOwnProperty: { label: 'Nested' } },
    })
    expect((await store.getLocales()).en['ui.toString.label']).toBe('UI nested')
    await store.saveLocale('en', { 'toString.title': 'Updated' })
    expect((await store.getLocales()).en['toString.title']).toBe('Updated')
    expect(await store.checkLocaleNesting()).toEqual({})
    await fs.writeFile(path.join(root, 'messages/en/toString.json'), '{"wrong":{"title":"Wrong"}}')
    expect(Object.values(await store.checkLocaleNesting('toString'))).toEqual([['wrong']])
    const configured = createLocaleStore(resolveConfig({ localesDir: 'messages', allowedRoots: { toString: ['wrong'] } }, root))
    expect(await configured.checkLocaleNesting('toString')).toEqual({})
  })
  it('reports literal inherited-name duplicate values without skipping their files', async () => {
    const { root, store } = await fixture()
    await fs.writeFile(path.join(root, 'messages/en/values.json'), JSON.stringify({
      values: { a: 'toString', b: 'toString', c: 'hasOwnProperty', d: 'hasOwnProperty' },
    }))
    const result = await store.checkLocaleDuplicates()
    expect(result.invalidValues.en.toString).toEqual(['values.a', 'values.b'])
    expect(result.invalidValues.en.hasOwnProperty).toEqual(['values.c', 'values.d'])
    expect(Object.keys(result.invalidKeys)).toEqual([])
  })
  it('rejects traversal, prototype keys, corrupt files and symlinks before writes', async () => {
    const { root, store } = await fixture()
    for (const lang of ['../escape', '__proto__'])
      await expect(store.saveLocale(lang, { 'ui.start': 'X' })).rejects.toThrow(
        'Invalid',
      )
    for (const key of [
      '../escape',
      '__proto__.polluted',
      'ui.constructor.x',
      'ui..x',
    ])
      await expect(store.saveLocale('en', { [key]: 'X' })).rejects.toThrow(
        'Invalid',
      )
    await expect(store.getLocales('../ui')).rejects.toThrow('Invalid')
    await expect(
      store.saveLocale('en', { 'ui.start': 4 } as never),
    ).rejects.toThrow('string')
    await fs.mkdir(path.join(root, 'outside'))
    await fs.symlink(path.join(root, 'outside'), path.join(root, 'messages/es'))
    await expect(store.saveLocale('es', { 'ui.start': 'X' })).rejects.toThrow(
      'escapes',
    )
    expect(await fs.readdir(path.join(root, 'outside'))).toEqual([])
    await fs.writeFile(path.join(root, 'messages/en/ui.json'), '{broken')
    await expect(store.saveLocale('en', { 'ui.start': 'X' })).rejects.toThrow()
    expect(
      await fs.readFile(path.join(root, 'messages/en/ui.json'), 'utf8'),
    ).toBe('{broken')
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })
})
describe('configuration', () => {
  it('reads only root JSON, applies inline options, and rejects invalid config', async () => {
    const { root } = await fixture()
    await fs.writeFile(
      path.join(root, 'l10n-c.config.json'),
      '{"localesDir":"messages","baseLanguage":"en"}',
    )
    await fs.writeFile(
      path.join(root, 'l10n-c.config.ts'),
      'throw new Error("must never execute")',
    )
    expect(
      (await createI18n({ baseLanguage: 'fr' }, root)).config.baseLanguage,
    ).toBe('fr')
    expect((await loadConfig(root)).localesDir).toBe(
      path.join(root, 'messages'),
    )
    expect(() => resolveConfig({ sourcePaths: 'src' } as never)).toThrow(
      'array',
    )
    expect(() => resolveConfig({ surprise: 'ignored' } as never)).toThrow(
      'Unknown',
    )
    await fs.writeFile(path.join(root, 'l10n-c.config.json'), '{broken')
    await expect(loadConfig(root)).rejects.toThrow()
  })
})

it('orders locales base-first and domains by name regardless of readdir order, retaining translation key order', async () => {
  const { root } = await fixture()
  for (const lang of ['de', 'fr']) await fs.mkdir(path.join(root, 'messages', lang))
  for (const lang of ['de', 'en', 'fr']) {
    await fs.writeFile(path.join(root, 'messages', lang, 'zeta.json'), '{"wrong":{"z":"Same","a":"Same"}}')
    await fs.writeFile(path.join(root, 'messages', lang, 'alpha.json'), '{"alpha":{"z":"Same","a":"Same"}}')
  }
  const store = createLocaleStore(resolveConfig({ localesDir: 'messages', baseLanguage: 'fr' }, root))
  const original = fs.readdir.bind(fs)
  let reverse = false
  const mock = vi.spyOn(fs, 'readdir').mockImplementation((async (...args: Parameters<typeof fs.readdir>) => {
    const entries = await original(...args)
    return reverse ? entries.reverse() : entries
  }) as typeof fs.readdir)
  try {
    const snapshot = async () => ({ locales: await store.getLocales(), nesting: await store.checkLocaleNesting(), duplicates: await store.checkLocaleDuplicates() })
    const forward = await snapshot()
    reverse = true
    const reversed = await snapshot()
    expect(JSON.stringify(reversed)).toBe(JSON.stringify(forward))
    expect(Object.keys(forward.locales)).toEqual(['fr', 'de', 'en'])
    expect(Object.keys(forward.locales.fr)).toEqual(['alpha.z', 'alpha.a', 'wrong.z', 'wrong.a'])
    expect(Object.keys(forward.duplicates.invalidValues)).toEqual(['fr', 'de', 'en'])
    expect(Object.keys(forward.nesting).map(p => path.basename(path.dirname(p)))).toEqual(['fr', 'de', 'en'])
  } finally { mock.mockRestore() }
})
