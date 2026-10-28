import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { IncomingMessage } from 'node:http'
import type { Plugin } from 'vite'
import {
  createI18n,
  assertSegment,
  validateChanges,
  type I18nConfig,
  type LocaleStore,
} from 'l10n-c'

export type { I18nConfig } from 'l10n-c'
const assetsDir =
  typeof __dirname !== 'undefined'
    ? path.resolve(__dirname, '../ui')
    : fileURLToPath(new URL('../ui', import.meta.url))

async function readChanges(
  req: IncomingMessage,
): Promise<Record<string, Record<string, string>>> {
  const origin = req.headers.origin
  if (origin && new URL(origin).host !== req.headers.host)
    throw new Error('Cross-origin writes are not allowed')
  if (!req.headers['content-type']?.startsWith('application/json'))
    throw new Error('Expected application/json')
  let body = ''
  for await (const chunk of req) {
    body += chunk.toString()
    if (Buffer.byteLength(body) > 2 * 1024 * 1024)
      throw new Error('Payload exceeds 2 MiB')
  }
  const payload: unknown = JSON.parse(body)
  if (
    !payload ||
    typeof payload !== 'object' ||
    Array.isArray(payload) ||
    !('changes' in payload)
  )
    throw new Error('Expected { changes: { language: { key: value } } }')
  const changes = payload.changes
  if (!changes || typeof changes !== 'object' || Array.isArray(changes))
    throw new Error('Changes must be an object')
  // Validate every entry before the first filesystem write.
  for (const [language, data] of Object.entries(changes)) {
    assertSegment(language, 'language')
    validateChanges(data)
  }
  return changes as Record<string, Record<string, string>>
}

/** Development-only locale editor. Open /i18n/ on the Vite dev server. */
export default function i18nPlugin(options: I18nConfig = {}): Plugin {
  let store: LocaleStore
  return {
    name: 'vite-plugin-l10n-c',
    apply: 'serve',
    async configResolved(config) {
      store = await createI18n(options, config.root)
    },
    configureServer(server) {
      const localesDir = store.config.localesDir
      server.watcher.add(localesDir)
      const onChange = (_event: string, file: string) => {
        const relative = path.relative(localesDir, path.resolve(file))
        const segments = relative.split(path.sep)
        if (
          segments.length === 2 &&
          !relative.startsWith('..') &&
          segments[1].endsWith('.json')
        ) {
          server.ws.send('i18n-update', { locale: segments[0] })
        }
      }
      server.watcher.on('all', onChange)
      server.httpServer?.once('close', () =>
        server.watcher.off('all', onChange),
      )
      server.middlewares.use(async (req, res, next) => {
        const pathname = (req.url ?? '').split('?')[0]
        const json = (status: number, data: unknown) => {
          res.statusCode = status
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(JSON.stringify(data))
        }
        try {
          if (req.method === 'GET' && pathname === '/i18n/api/locales') {
            json(200, await store.getLocales())
            return
          }
          if (req.method === 'GET' && pathname === '/i18n/api/config') {
            json(200, {
              baseLanguage: store.config.baseLanguage,
              languageOrder: store.config.languageOrder,
            })
            return
          }
          if (req.method === 'POST' && pathname === '/i18n/api/publish') {
            let changes: Record<string, Record<string, string>>
            try {
              changes = await readChanges(req)
            } catch (error) {
              json(400, { error: (error as Error).message })
              return
            }
            for (const [language, data] of Object.entries(changes)) {
              if (Object.keys(data).length)
                await store.saveLocale(language, data)
            }
            json(200, { success: true })
            return
          }
          if (
            req.method === 'GET' &&
            ['/i18n', '/i18n/', '/i18n/index.html'].includes(pathname)
          ) {
            const html = await fs.readFile(
              path.join(assetsDir, 'index.html'),
              'utf8',
            )
            res.setHeader('Content-Type', 'text/html; charset=utf-8')
            res.end(await server.transformIndexHtml('/i18n/', html))
            return
          }
          if (req.method === 'GET' && pathname === '/i18n/app.js') {
            res.setHeader('Content-Type', 'text/javascript; charset=utf-8')
            res.end(await fs.readFile(path.join(assetsDir, 'app.js'), 'utf8'))
            return
          }
          next()
        } catch (error) {
          json(500, { error: (error as Error).message })
        }
      })
    },
  }
}
