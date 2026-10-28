import { afterEach, expect, it } from 'vitest'
import { createServer, type ViteDevServer } from 'vite'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import i18n from '../src/index'
const servers: ViteDevServer[] = []
const roots: string[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  )
})
it('serves the packaged editor and exact API routes, writes only valid payloads, isolates configured root', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'i18n-c-plugin-'))
  roots.push(root)
  await fs.mkdir(path.join(root, 'messages/en'), { recursive: true })
  await fs.writeFile(
    path.join(root, 'messages/en/ui.json'),
    '{"ui":{"start":"Start"}}',
  )
  const server = await createServer({
    root,
    configFile: false,
    plugins: [i18n({ localesDir: 'messages', baseLanguage: 'en' })],
    server: { port: 0, host: '127.0.0.1' },
    logLevel: 'silent',
  })
  servers.push(server)
  await server.listen()
  const address = server.httpServer!.address() as { port: number }
  const base = `http://127.0.0.1:${address.port}`
  const get = (url: string) => fetch(base + url)
  const post = (data: unknown, headers = {}) =>
    fetch(base + '/i18n/api/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(data),
    })
  expect((await get('/i18n/')).headers.get('content-type')).toContain(
    'text/html',
  )
  expect(await (await get('/i18n/')).text()).toContain('/i18n/app.js')
  expect(await (await get('/i18n/app.js')).text()).toContain(
    '/i18n/api/publish',
  )
  expect(await (await get('/i18n/api/locales?fresh=1')).json()).toEqual({
    en: { 'ui.start': 'Start' },
  })
  expect(await (await get('/i18n/api/config')).json()).toMatchObject({
    baseLanguage: 'en',
  })
  const suffix = await get('/i18n/api/locales-extra')
  expect(suffix.headers.get('content-type') ?? '').not.toContain(
    'application/json',
  )
  const valid = await post({
    changes: { en: { 'ui.start': 'Begin' }, fr: { 'shop.buy': 'Acheter' } },
  })
  expect(valid.status).toBe(200)
  expect(await valid.json()).toEqual({ success: true })
  expect(
    JSON.parse(
      await fs.readFile(path.join(root, 'messages/fr/shop.json'), 'utf8'),
    ),
  ).toEqual({ shop: { buy: 'Acheter' } })
  for (const changes of [
    { '../escape': { 'ui.start': 'X' } },
    { en: { 'ui.start': 'Changed' }, fr: { 'ui.__proto__.x': 'X' } },
    { en: { 'ui.start': 42 } },
  ]) {
    expect((await post({ changes })).status).toBe(400)
  }
  expect(
    (
      await post(
        { changes: { en: { 'ui.start': 'X' } } },
        { Origin: 'https://elsewhere.example' },
      )
    ).status,
  ).toBe(400)
  expect(
    (
      await post(
        { changes: { en: { 'ui.start': 'X' } } },
        { 'Content-Type': 'text/plain' },
      )
    ).status,
  ).toBe(400)
  expect((await (await get('/i18n/api/locales')).json()).en['ui.start']).toBe(
    'Begin',
  )
  expect(i18n().apply).toBe('serve')
})
