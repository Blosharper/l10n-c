// Explicit HQ-authorized local browser check; game files are read-only inputs.
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { createServer } from 'vite'
import i18n from '../packages/vite-plugin-i18n-c/dist/index.js'

const game = path.resolve(process.argv[2])
const output = path.resolve(process.argv[3])
const dependency = process.env.I18N_C_PLAYWRIGHT_DIR
if (!dependency) throw new Error('Set I18N_C_PLAYWRIGHT_DIR to existing read-only Playwright dependency')
await fs.mkdir(output)
const { chromium } = await import(pathToFileURL(path.join(dependency, 'index.mjs')).href)
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'i18n-c-browser-'))
const original = path.join(game, 'public/locales')
const copied = path.join(temporary, 'locales')
async function inventory(root) {
  const entries = {}
  async function walk(relative) {
    for (const item of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
      const file = path.join(relative, item.name)
      if (item.isSymbolicLink()) throw new Error(`Unexpected symlink: ${file}`)
      if (item.isDirectory()) await walk(file)
      else entries[file] = createHash('sha256').update(await fs.readFile(path.join(root, file))).digest('hex')
    }
  }
  await walk('')
  return entries
}
const before = await inventory(original)
await fs.writeFile(path.join(output, 'source-before.json'), JSON.stringify(before, null, 2) + '\n')
let server, browser
const errors = [], responses = []
let proof = {}
try {
  await fs.cp(original, copied, { recursive: true, errorOnExist: true })
  assert.deepEqual(await inventory(copied), before)
  await fs.writeFile(path.join(temporary, 'i18n-c.config.json'), JSON.stringify({ localesDir: 'locales', baseLanguage: 'ko', allowedRoots: { ui: ['ui', 'speech'] }, languageOrder: ['en', 'ko'], mirrors: [] }))
  server = await createServer({ root: temporary, configFile: false, plugins: [i18n()], server: { port: 0, host: '127.0.0.1' }, logLevel: 'silent' })
  await server.listen()
  const url = `http://127.0.0.1:${server.httpServer.address().port}/i18n/?language=en,ko`
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 })
  page.on('pageerror', error => errors.push(error.message))
  page.on('response', response => { if (response.url().includes('/i18n/')) responses.push({ url: response.url(), status: response.status() }) })
  await page.goto(url, { waitUntil: 'networkidle' })
  await page.locator('#table-body .editable-cell').first().waitFor()
  await page.locator('#search').fill('ui.button')
  await page.waitForFunction(() => document.querySelectorAll('#table-body tr').length > 0)
  const rows = await page.locator('#table-body tr').count()
  assert.equal(rows, 20)
  assert.equal(await page.locator('#table-head th').count(), 3)
  await page.screenshot({ path: path.join(output, '1048-manager.png'), fullPage: true })
  const row = page.locator('#table-body tr').filter({ hasText: 'ui.button.hit' })
  const english = row.locator('.editable-cell').first()
  await english.click()
  const editor = english.locator('textarea')
  await editor.fill('Play [browser verification]')
  await editor.press('Tab')
  await page.getByRole('button', { name: /Publish.*\(1\)/ }).waitFor()
  const downloadPromise = page.waitForEvent('download')
  await page.locator('#btn-download-csv').click()
  const download = await downloadPromise
  await download.saveAs(path.join(output, 'filtered.csv'))
  assert.match(await fs.readFile(path.join(output, 'filtered.csv'), 'utf8'), /Play \[browser verification\]/)
  const saved = page.waitForResponse(response => response.url().endsWith('/i18n/api/publish') && response.request().method() === 'POST')
  await page.locator('#btn-publish').click()
  assert.equal((await saved).status(), 200)
  await page.waitForFunction(() => !document.querySelector('.changed'))
  assert.equal(JSON.parse(await fs.readFile(path.join(copied, 'en/ui.json'), 'utf8')).ui.button.hit, 'Play [browser verification]')
  await page.reload({ waitUntil: 'networkidle' })
  await page.locator('#search').fill('ui.button.hit')
  await page.getByText('Play [browser verification]', { exact: true }).waitFor()
  assert.deepEqual(errors, [])
  proof = { pass: true, browser: browser.version(), executable: chromium.executablePath(), dependency, fixture: temporary, localeCopy: copied, originalFileCount: Object.keys(before).length, rows, columns: 3, savedAndReloaded: 'Play [browser verification]', screenshot: path.join(output, '1048-manager.png'), csv: path.join(output, 'filtered.csv'), errors, responses }
} finally {
  if (browser) await browser.close()
  if (server) await server.close()
  const after = await inventory(original)
  await fs.writeFile(path.join(output, 'source-after.json'), JSON.stringify(after, null, 2) + '\n')
  const unchanged = JSON.stringify(before) === JSON.stringify(after)
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ ...proof, originalUnchanged: unchanged, ownBrowserClosed: !!browser, ownServerClosed: !!server, fixtureRemoved: true }, null, 2) + '\n')
  await fs.rm(temporary, { recursive: true, force: true })
  assert.ok(unchanged, 'Original game locales changed')
}
console.log(`Browser edit, CSV, publish, reload and screenshot: PASS; ${output}`)
