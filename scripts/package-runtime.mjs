// Copied into an isolated tarball consumer by package-smoke.mjs; run with plain Node.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { createI18n } from 'i18n-c'
import i18n from 'vite-plugin-i18n-c'
import { createServer } from 'vite'
import { Window } from 'happy-dom'
const require = createRequire(import.meta.url)
for (const name of ['i18n-c', 'vite-plugin-i18n-c']) {
  const location = await fs.realpath(require.resolve(name))
  assert.ok(location.startsWith(path.join(process.cwd(), 'node_modules') + path.sep))
  const metadata = JSON.parse(await fs.readFile(path.join(path.dirname(location), '../package.json'), 'utf8'))
  assert.equal(metadata.engines.node, '>=22.12.0')
  assert.ok((await fs.readFile(path.join(path.dirname(location), '../LICENSE'), 'utf8')).includes('MIT License'))
  assert.ok((await fs.readFile(path.join(path.dirname(location), '../README.md'), 'utf8')).length > 100)
  console.log(`installed ${name}: ${location}; engines ${metadata.engines.node}; LICENSE/README present`)
}
assert.equal(typeof require('i18n-c').createI18n, 'function')
assert.equal(typeof require('vite-plugin-i18n-c').default, 'function')
assert.equal(JSON.parse(await fs.readFile(require.resolve('i18n-c/schema.json'), 'utf8')).type, 'object')
await fs.mkdir('messages/en', { recursive: true })
await fs.mkdir('src')
await fs.writeFile('src/app.js', "t('ui.start')")
await fs.writeFile('messages/en/ui.json', '{"ui":{"start":"Start","spare":"Unused"}}')
await fs.writeFile('i18n-c.config.json', JSON.stringify({ localesDir: 'messages', baseLanguage: 'en', sourcePaths: ['src'], mirrors: ['mirror'], languageOrder: ['en', 'fr'] }))
const cli = path.resolve('node_modules/i18n-c/dist/cli.js')
function command(args, expected = 0) {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' })
  console.log(JSON.stringify({ command: ['node', cli, ...args], exit: result.status, stdout: result.stdout, stderr: result.stderr }))
  assert.equal(result.status, expected)
  return result
}
assert.match(command(['--help']).stdout, /i18n-c.config.json/)
command(['--update', 'fr:ui.start=Commencer'])
assert.match(command(['--search', 'Commencer']).stdout, /Found 1 results/)
assert.match(command(['--unused']).stdout, /  - ui.spare/)
command(['--nest-check'])
assert.match(command(['--rename', 'ui.start=shop.start'], 1).stderr, /from "ui" to "shop"/)
const core = await createI18n()
await core.saveLocale('en', { 'toString.title': 'Core Node' })
assert.equal((await core.getLocales()).en['toString.title'], 'Core Node')
assert.equal(await fs.readFile('mirror/en/toString.json', 'utf8'), await fs.readFile('messages/en/toString.json', 'utf8'))
console.log('Plain Node ESM/CJS, schema, CLI edits/checks and mirror: PASS')

if (process.env.I18N_C_SKIP_HTTP === '1') { console.log('HTTP/DOM: SKIP; unchanged adapter already verified separately'); process.exit(0) }
let server, window
const http = []
async function waitFor(condition) {
  const deadline = Date.now() + 5000
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for editor state')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
try {
  server = await createServer({ root: process.cwd(), configFile: false, base: '/demo/', plugins: [i18n()], server: { port: 0, host: '127.0.0.1' }, logLevel: 'silent' })
  await server.listen()
  const base = `http://127.0.0.1:${server.httpServer.address().port}`
  async function request(route, init) {
    const response = await fetch(new URL(route, base), init)
    http.push({ route: String(route), method: init?.method ?? 'GET', status: response.status, contentType: response.headers.get('content-type') })
    return response
  }
  const htmlResponse = await request('/i18n/')
  assert.equal(htmlResponse.status, 200)
  const html = await htmlResponse.text()
  assert.match(html, /\/i18n\/app.js/)
  const scriptResponse = await request('/i18n/app.js')
  assert.equal(scriptResponse.status, 200)
  const script = await scriptResponse.text()
  assert.match(script, /\/i18n\/api\/publish/)
  assert.equal((await (await request('/i18n/api/config')).json()).baseLanguage, 'en')
  assert.equal((await (await request('/i18n/api/locales')).json()).en['ui.start'], 'Start')
  const initial = await fs.readFile('messages/en/ui.json', 'utf8')
  const rejected = await request('/i18n/api/publish', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ changes: { en: { 'ui.start': 'must not save' }, fr: { 'ui.__proto__.x': 'bad' } } }) })
  assert.equal(rejected.status, 400)
  assert.equal(await fs.readFile('messages/en/ui.json', 'utf8'), initial)
  const suffix = await request('/i18n/api/locales-extra')
  assert.ok(!suffix.headers.get('content-type')?.includes('application/json'))

  window = new Window({ url: `${base}/i18n/?language=en`, settings: { enableJavaScriptEvaluation: true, disableCSSFileLoading: true, disableJavaScriptFileLoading: true } })
  window.document.write(html.replace(/<script[\s\S]*?<\/script>/g, ''))
  class Observer {
    constructor(callback) { this.callback = callback }
    observe(target) { this.callback([{ target, isIntersecting: true }]) }
    disconnect() {}
  }
  const alerts = [], blobs = []
  Object.assign(window, { IntersectionObserver: Observer, fetch: request, alert: message => alerts.push(message) })
  window.URL.createObjectURL = blob => { blobs.push(blob); return 'blob:receipt' }
  window.URL.revokeObjectURL = () => {}
  window.eval(script)
  await waitFor(() => window.document.querySelectorAll('#table-head th').length > 0)
  const doc = window.document
  assert.equal(doc.querySelectorAll('#table-head th').length, 2)
  const search = doc.querySelector('#search')
  search.value = 'ui.start'
  search.dispatchEvent(new window.Event('input'))
  assert.equal(doc.querySelectorAll('#table-body tr').length, 1)
  const cell = doc.querySelector('.editable-cell')
  cell.dispatchEvent(new window.MouseEvent('click'))
  const editor = cell.querySelector('textarea')
  editor.value = 'Begin, Node'
  editor.dispatchEvent(new window.Event('blur'))
  assert.match(doc.querySelector('#btn-publish').textContent, /\(1\)/)
  doc.querySelector('#btn-download-csv').dispatchEvent(new window.MouseEvent('click'))
  assert.match(await blobs[0].text(), /ui.start,"Begin, Node"/)
  doc.querySelector('#btn-publish').dispatchEvent(new window.MouseEvent('click'))
  await waitFor(() => doc.querySelector('.changed') === null)
  assert.equal(doc.querySelector('.changed'), null)
  assert.equal(JSON.parse(await fs.readFile('messages/en/ui.json', 'utf8')).ui.start, 'Begin, Node')
  assert.equal((await (await request('/i18n/api/locales')).json()).en['ui.start'], 'Begin, Node')
  assert.equal(await fs.readFile('mirror/en/ui.json', 'utf8'), await fs.readFile('messages/en/ui.json', 'utf8'))
  assert.ok(http.some(record => record.method === 'POST' && record.status === 200))
  console.log(JSON.stringify({ http, alerts, csv: await blobs[0].text(), persisted: 'Begin, Node' }, null, 2))
  console.log('Installed Vite HTTP + served editor DOM edit, CSV, publish, filesystem readback: PASS')
} finally {
  if (window) await window.happyDOM.close()
  if (server) await server.close()
}
