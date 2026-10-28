// Compare complete report records without rewriting or sorting any raw output.
import assert from 'node:assert/strict'
function sameMap(a, b, compare = (x, y) => x === y) {
  return a.size === b.size && [...a].every(([key, value]) => b.has(key) && compare(value, b.get(key)))
}
function multiset(values) {
  const counts = new Map()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  return counts
}
function searchReport(text) {
  const lines = text.split('\n')
  if (lines.pop() !== '') throw new Error('Missing trailing newline')
  const header = lines.shift(), trailer = lines.pop()
  if (!/^✅ Found \d+ results\.$/.test(trailer)) throw new Error('Invalid search trailer')
  const records = new Map()
  for (const line of lines) {
    const match = line.match(/^\[([^\]]+)\] ([^:]+): (.*)$/)
    if (!match) throw new Error('Unparsed search record')
    const key = `${match[1]}\0${match[2]}`
    if (records.has(key)) throw new Error('Repeated search key')
    records.set(key, match[3])
  }
  if (records.size !== Number(trailer.match(/\d+/)[0])) throw new Error('Search count mismatch')
  return { header, trailer, records }
}
function duplicateReport(text) {
  const headers = [...text.matchAll(/\n⚠️ \[([^\]]+)\] Found (\d+) duplicated translation value\(s\):\n/g)]
  if (!headers.length) throw new Error('No complete duplicate groups')
  const prefix = text.slice(0, headers[0].index)
  if (prefix !== '🌸 Checking for duplicated resources...\n') throw new Error('Unsupported duplicate report prefix')
  const languages = new Map()
  for (let i = 0; i < headers.length; i++) {
    const header = headers[i]
    const body = text.slice(header.index + header[0].length, headers[i + 1]?.index ?? text.length)
    const pattern = /  - Value "([\s\S]*?)" is defined in:\n((?:    👉 [^\n]*\n)+)/gy
    const values = new Map()
    let match, consumed = 0
    while ((match = pattern.exec(body))) {
      if (values.has(match[1])) throw new Error('Repeated duplicate value')
      values.set(match[1], multiset(match[2].trimEnd().split('\n').map(line => line.slice('    👉 '.length))))
      consumed = pattern.lastIndex
    }
    if (consumed !== body.length || values.size !== Number(header[2])) throw new Error('Unparsed duplicate content/count mismatch')
    if (languages.has(header[1])) throw new Error('Repeated language')
    languages.set(header[1], values)
  }
  return { prefix, languages }
}
export function compareOrderRecords(name, a, b) {
  try {
    if (name === 'search') {
      const x = searchReport(a), y = searchReport(b)
      return { equal: x.header === y.header && x.trailer === y.trailer && sameMap(x.records, y.records), records: x.records.size }
    }
    if (name === 'duplicate-check') {
      const x = duplicateReport(a), y = duplicateReport(b)
      return { equal: x.prefix === y.prefix && sameMap(x.languages, y.languages, (v, w) => sameMap(v, w, sameMap)), languages: x.languages.size, values: [...x.languages.values()].reduce((count, values) => count + values.size, 0) }
    }
    return { equal: false, error: 'No authorized order difference for this check' }
  } catch (error) { return { equal: false, error: error.message } }
}
// Parser controls: order may differ; altered/missing/extra translation records cannot pass.
const a = '🌸 Searching for "x" in all locales...\n[en] ui.z: Z\n[fr] ui.a: A\n✅ Found 2 results.\n'
const b = '🌸 Searching for "x" in all locales...\n[fr] ui.a: A\n[en] ui.z: Z\n✅ Found 2 results.\n'
assert.equal(compareOrderRecords('search', a, b).equal, true)
for (const changed of [b.replace('ui.a: A', 'ui.a: B'), b.replace('[fr] ui.a: A\n', ''), b.replace('Found 2', 'Found 3')]) assert.equal(compareOrderRecords('search', a, changed).equal, false)
const d = '🌸 Checking for duplicated resources...\n\n⚠️ [en] Found 1 duplicated translation value(s):\n  - Value "Same" is defined in:\n    👉 ui.z\n    👉 ui.a\n'
assert.equal(compareOrderRecords('duplicate-check', d, d.replace('👉 ui.z\n    👉 ui.a', '👉 ui.a\n    👉 ui.z')).equal, true)
for (const changed of [d.replace('"Same"', '"Changed"'), d.replace('👉 ui.a', '👉 ui.b'), d + 'extra\n']) assert.equal(compareOrderRecords('duplicate-check', d, changed).equal, false)
