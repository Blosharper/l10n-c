import { afterEach, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
const exec = promisify(execFile)
const cli = path.resolve('packages/l10n-c/dist/cli.js')
const roots: string[] = []
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'l10n-c-cli-'))
  roots.push(root)
  await fs.mkdir(path.join(root, 'messages/en'), { recursive: true })
  await fs.mkdir(path.join(root, 'messages/fr'), { recursive: true })
  await fs.mkdir(path.join(root, 'src/ignored'), { recursive: true })
  await fs.writeFile(
    path.join(root, 'messages/en/ui.json'),
    JSON.stringify({
      ui: {
        used: 'Used',
        comment: { exact: 'Exact', child: 'Child' },
        live: { child: 'Live' },
        dyn_one: 'Dynamic',
        dead: 'Dead',
        short: 'Short',
        short_extra: 'Extra',
        escaped: 'Quoted',
      },
    }),
  )
  await fs.writeFile(
    path.join(root, 'messages/fr/ui.json'),
    '{"ui":{"used":"Used"}}',
  )
  await fs.writeFile(
    path.join(root, 'l10n-c.config.json'),
    JSON.stringify({
      localesDir: 'messages',
      baseLanguage: 'en',
      sourcePaths: ['src', 'missing'],
      sourceIgnore: ['ignored'],
      referencePrefixes: ['ui.'],
    }),
  )
  await fs.writeFile(
    path.join(root, 'src/app.ts'),
    "t('ui.used'); t('ui.live'); // 'ui.comment' 'ui.comment.exact'\nconst d = `ui.dyn_${n}`; t('ui.short_extra'); const x = 'https://example.com'; t('ui.escaped');",
  )
  await fs.writeFile(path.join(root, 'src/ignored/app.ts'), "t('ui.dead')")
  return root
}
async function run(root: string, ...args: string[]) {
  try {
    const result = await exec(process.execPath, [cli, ...args], { cwd: root })
    return { ...result, code: 0 }
  } catch (error) {
    const result = error as { stdout: string; stderr: string; code: number }
    return result
  }
}
afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  )
})
it('checks/searches and preserves scanner comment, subtree, dynamic, prefix and exact-match semantics', async () => {
  const root = await fixture()
  const missing = await run(root, '--missing')
  expect(missing.code).toBe(0)
  expect(missing.stdout).toContain('Base: en')
  expect(missing.stdout).toContain('ui.dead')
  const search = await run(root, '--search=used', '--domain=ui')
  expect(search.code).toBe(0)
  expect(search.stdout).toContain('Found 2 results')
  const unused = await run(root, '--unused')
  expect(unused.code).toBe(0)
  expect(unused.stdout).toContain('  - ui.comment.child')
  expect(unused.stdout).toContain('  - ui.dead')
  expect(unused.stdout).toContain('  - ui.short\n')
  expect(unused.stdout).toContain('  - ui.dyn_one')
  for (const key of [
    'ui.used',
    'ui.comment.exact',
    'ui.live.child',
    'ui.short_extra',
    'ui.escaped',
  ])
    expect(unused.stdout).not.toContain(`  - ${key}`)
  expect((await run(root, '--nest-check')).code).toBe(0)
  expect((await run(root, '--duplicate-check')).code).toBe(0)
})
it('edits through the packaged CLI and rejects removed/unknown/malformed options', async () => {
  const root = await fixture()
  expect(
    (await run(root, '--update', 'en:shop.buy=Buy', '--update=en:ui.used=New'))
      .code,
  ).toBe(0)
  expect(
    JSON.parse(
      await fs.readFile(path.join(root, 'messages/en/shop.json'), 'utf8'),
    ),
  ).toEqual({ shop: { buy: 'Buy' } })
  expect(
    (await run(root, '--publish', '{"pt-BR":{"ui.used":"Olá"}}')).code,
  ).toBe(0)
  for (const args of [
    ['--restructure'],
    ['--convert-to-tw'],
    ['--update'],
    ['--update', 'en:../oops=x'],
  ])
    expect((await run(root, ...args)).code).toBe(1)
  const help = await run(root, '--help')
  expect(help.code).toBe(0)
  expect(help.stdout).toContain('l10n-c.config.json')
  expect(help.stdout).not.toContain('--restructure')
})

it('P1-1: numeric-keyed object and empty nodes survive unrelated CLI --update byte-for-byte and touched files retain shape', async () => {
  const root = await fixture()
  const errorsFile = path.join(root, 'messages/en/errors.json')
  const errors = '{ "errors": { "404": "Not found", "500": "Server" }, "empty": {}, "emptyList": [] }\n'
  await fs.writeFile(errorsFile, errors)
  const uiFile = path.join(root, 'messages/en/ui.json')
  const ui = { ui: { c: 'Old', codes: { '404': 'Not found' }, list: ['One', {}, []], empty: {}, emptyList: [] }, empty: {} }
  await fs.writeFile(uiFile, JSON.stringify(ui))
  const french = await fs.readFile(path.join(root, 'messages/fr/ui.json'), 'utf8')
  expect((await run(root, '--update', 'en:ui.c=C', '--update', 'en:ui.list.0=Updated', '--update', 'en:ui.newCodes.500=New')).code).toBe(0)
  expect(await fs.readFile(errorsFile, 'utf8')).toBe(errors)
  expect(await fs.readFile(path.join(root, 'messages/fr/ui.json'), 'utf8')).toBe(french)
  expect(JSON.parse(await fs.readFile(uiFile, 'utf8'))).toEqual({
    ...ui,
    ui: { ...ui.ui, c: 'C', list: ['Updated', {}, []], newCodes: { '500': 'New' } },
  })
  expect((await run(root, '--update', 'en:errors.500=Updated server')).code).toBe(0)
  expect(JSON.parse(await fs.readFile(errorsFile, 'utf8'))).toEqual({ errors: { '404': 'Not found', '500': 'Updated server' }, empty: {}, emptyList: [] })
})

it.each([
  ['later-language exact target', { target: 'Keep' }, 'ui.target', 'already exists'],
  ['subtree collision', { target: { child: 'Keep' } }, 'ui.target', 'already exists'],
  ['scalar ancestor collision', { parent: 'Keep' }, 'ui.parent.child', 'scalar ancestor'],
])('P1-2: CLI rename refuses %s before earlier language writes', async (_name, ui, target, message) => {
  const root = await fixture()
  await fs.writeFile(path.join(root, 'messages/fr/ui.json'), JSON.stringify({ ui }))
  const paths = ['en/ui.json', 'fr/ui.json'].map(file => path.join(root, 'messages', file))
  const before = await Promise.all(paths.map(file => fs.readFile(file, 'utf8')))
  const result = await run(root, '--rename', `ui.used=${target}`)
  expect(result.code).toBe(1)
  expect(result.stderr).toContain(message)
  expect(result.stdout).not.toContain('renamed successfully')
  expect(await Promise.all(paths.map(file => fs.readFile(file, 'utf8')))).toEqual(before)
})

it('P1-2: CLI rename refuses descendant-target before mutation', async () => {
  const root = await fixture()
  const paths = ['en/ui.json', 'fr/ui.json'].map(file => path.join(root, 'messages', file))
  const before = await Promise.all(paths.map(file => fs.readFile(file, 'utf8')))
  const result = await run(root, '--rename', 'ui.used=ui.used.child')
  expect(result.code).toBe(1)
  expect(result.stderr).toContain('descendant')
  expect(await Promise.all(paths.map(file => fs.readFile(file, 'utf8')))).toEqual(before)
})

it('accepts inherited-name language and domain strings without prototype lookup', async () => {
  const root = await fixture()
  const update = await run(root, '--update', 'toString:toString.title=Title')
  expect(update.code).toBe(0)
  expect(JSON.parse(await fs.readFile(path.join(root, 'messages/toString/toString.json'), 'utf8'))).toEqual({ toString: { title: 'Title' } })
  expect((await run(root, '--nest-check', '--file', 'toString')).code).toBe(0)
  await fs.writeFile(path.join(root, 'messages/toString/toString.json'), '{"wrong":{"title":"Wrong"}}')
  const nesting = await run(root, '--nest-check', '--file', 'toString')
  expect(nesting.code).toBe(1)
  expect(nesting.stdout).toContain('  - wrong')
})

it('refuses cross-domain rename with both domains and explicit update/delete alternative before writing', async () => {
  const root = await fixture()
  const before = await fs.readFile(path.join(root, 'messages/en/ui.json'), 'utf8')
  const result = await run(root, '--rename', 'ui.used=shop.used')
  expect(result.code).toBe(1)
  expect(result.stderr).toContain('from "ui" to "shop"')
  expect(result.stderr).toContain('--update "LANG:shop.used=VALUE" then --delete "ui.used"')
  expect(await fs.readFile(path.join(root, 'messages/en/ui.json'), 'utf8')).toBe(before)
  expect(await fs.readdir(path.join(root, 'messages/en'))).toEqual(['ui.json'])
  expect((await run(root, '--rename', 'ui.used=ui.renamed')).code).toBe(0)
  expect(JSON.parse(await fs.readFile(path.join(root, 'messages/en/ui.json'), 'utf8')).ui.renamed).toBe('Used')
})

it('emits identical CLI reports when readdir locale/domain order is shuffled', async () => {
  const root = await fixture()
  const configPath = path.join(root, 'l10n-c.config.json')
  const config = JSON.parse(await fs.readFile(configPath, 'utf8'))
  await fs.writeFile(configPath, JSON.stringify({ ...config, baseLanguage: 'fr' }))
  await fs.mkdir(path.join(root, 'messages/de'))
  for (const lang of ['de', 'en', 'fr']) {
    await fs.writeFile(path.join(root, 'messages', lang, 'zeta.json'), '{"wrong":{"z":"Same","a":"Same"}}')
    await fs.writeFile(path.join(root, 'messages', lang, 'alpha.json'), '{"alpha":{"z":"Same","a":"Same"}}')
  }
  const shuffle = path.join(root, 'shuffle.mjs')
  await fs.writeFile(shuffle, `import fs from 'node:fs/promises'; const readdir = fs.readdir.bind(fs); fs.readdir = async (...args) => { const result = await readdir(...args); return process.env.REVERSE_READDIR === '1' ? result.reverse() : result };`)
  async function shuffled(reverse: boolean, args: string[]) {
    try {
      const result = await exec(process.execPath, ['--import', shuffle, cli, ...args], { cwd: root, env: { ...process.env, REVERSE_READDIR: reverse ? '1' : '0' } })
      return { stdout: result.stdout, stderr: result.stderr, code: 0 }
    } catch (error) {
      const result = error as { stdout: string; stderr: string; code: number }
      return { stdout: result.stdout, stderr: result.stderr, code: result.code }
    }
  }
  for (const args of [['--search', 'Same'], ['--missing'], ['--nest-check'], ['--duplicate-check'], ['--unused']]) {
    const forward = await shuffled(false, args)
    expect(await shuffled(true, args)).toEqual(forward)
    expect(forward.code).toBe(args[0] === '--nest-check' ? 1 : 0)
    if (args[0] === '--search') {
      expect(forward.stdout.indexOf('[fr]')).toBeLessThan(forward.stdout.indexOf('[de]'))
      expect(forward.stdout.indexOf('[de]')).toBeLessThan(forward.stdout.indexOf('[en]'))
      expect(forward.stdout.indexOf('alpha.z')).toBeLessThan(forward.stdout.indexOf('alpha.a'))
      expect(forward.stdout.indexOf('alpha.a')).toBeLessThan(forward.stdout.indexOf('wrong.z'))
    }
  }
})
