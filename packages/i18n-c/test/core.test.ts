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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'i18n-c-core-'))
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
      path.join(root, 'i18n-c.config.json'),
      '{"localesDir":"messages","baseLanguage":"en"}',
    )
    await fs.writeFile(
      path.join(root, 'i18n-c.config.ts'),
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
    await fs.writeFile(path.join(root, 'i18n-c.config.json'), '{broken')
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
