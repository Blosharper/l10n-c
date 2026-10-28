import { expect, it, vi } from 'vitest'
import { Window } from 'happy-dom'
import fs from 'node:fs/promises'
import path from 'node:path'
it('filters languages/keys, edits and publishes a draft, and downloads filtered CSV', async () => {
  const window = new Window({
    url: 'http://localhost/i18n/?language=en,unknown',
    settings: {
      enableJavaScriptEvaluation: true,
      disableCSSFileLoading: true,
      disableJavaScriptFileLoading: true,
    },
  })
  try {
    const html = await fs.readFile(
      path.resolve('packages/vite-plugin-l10n-c/ui/index.html'),
      'utf8',
    )
    window.document.write(html.replace(/<script[\s\S]*?<\/script>/g, ''))
    const observed: Element[] = []
    class Observer {
      callback: (entries: unknown[]) => void
      constructor(callback: (entries: unknown[]) => void) {
        this.callback = callback
      }
      observe(target: Element) {
        observed.push(target)
        this.callback([{ target, isIntersecting: true }])
      }
      disconnect() {}
    }
    Object.assign(window, { IntersectionObserver: Observer })
    let saved: unknown
    const fetched = vi.fn(async (url: string, init?: { body?: string }) => {
      if (url.endsWith('/config'))
        return { ok: true, json: async () => ({ languageOrder: ['en', 'fr'] }) }
      if (url.endsWith('/publish')) {
        saved = JSON.parse(init!.body!)
        return { ok: true }
      }
      return {
        ok: true,
        json: async () => ({
          en: { 'ui.start': 'Start', 'shop.buy': 'Buy' },
          fr: { 'ui.start': 'Commencer' },
        }),
      }
    })
    Object.assign(window, { fetch: fetched, alert: vi.fn() })
    const blobs: unknown[] = []
    window.URL.createObjectURL = (blob: unknown) => {
      blobs.push(blob)
      return 'blob:test'
    }
    window.URL.revokeObjectURL = vi.fn()
    const script = await fs.readFile(
      path.resolve('packages/vite-plugin-l10n-c/ui/app.js'),
      'utf8',
    )
    window.eval(script)
    await window.happyDOM.whenAsyncComplete()
    const doc = window.document
    expect(doc.querySelectorAll('#table-head th')).toHaveLength(2)
    const search = doc.querySelector('#search') as unknown as HTMLInputElement
    search.value = 'start'
    search.dispatchEvent(new window.Event('input'))
    expect(doc.querySelectorAll('#table-body tr')).toHaveLength(1)
    const cell = doc.querySelector('.editable-cell')!
    cell.dispatchEvent(new window.MouseEvent('click'))
    const editor = cell.querySelector(
      'textarea',
    ) as unknown as HTMLTextAreaElement
    editor.value = 'Begin, now'
    editor.dispatchEvent(new window.Event('blur'))
    expect(doc.querySelector('#btn-publish')!.textContent).toContain('(1)')
    doc
      .querySelector('#btn-download-csv')!
      .dispatchEvent(new window.MouseEvent('click'))
    expect(blobs).toHaveLength(1)
    expect(await (blobs[0] as Blob).text()).toContain('ui.start,"Begin, now"')
    doc
      .querySelector('#btn-publish')!
      .dispatchEvent(new window.MouseEvent('click'))
    await window.happyDOM.whenAsyncComplete()
    expect(saved).toEqual({
      changes: { en: { 'ui.start': 'Begin, now' }, fr: {} },
    })
    expect(doc.querySelector('.changed')).toBeNull()
    expect(observed.length).toBeGreaterThan(0)
  } finally {
    await window.happyDOM.close()
  }
})
