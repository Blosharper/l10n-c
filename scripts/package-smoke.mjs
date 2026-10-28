// Exercise only installed tarballs in a disposable consumer, with no registry access.
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'

const output = path.resolve(process.argv[2] ?? 'scratch/package-smoke')
await fs.mkdir(output) // Never replace an earlier receipt.
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'i18n-c-packed-'))
const records = []
function sha(data) { return createHash('sha256').update(data).digest('hex') }
async function run(name, command, args, cwd = process.cwd()) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024 })
  for (const stream of ['stdout', 'stderr']) await fs.writeFile(path.join(output, `${name}.${stream}`), result[stream] ?? '')
  records.push({ name, command: [command, ...args], cwd, exit: result.status, signal: result.signal, error: result.error?.message, stdoutSha256: sha(result.stdout ?? ''), stderrSha256: sha(result.stderr ?? '') })
  await fs.writeFile(path.join(output, 'stages.json'), JSON.stringify(records, null, 2) + '\n')
  console.log(`${name}: exit ${result.status}`)
  if (result.status !== 0) throw new Error(`${name} failed; see ${output}`)
  return result.stdout
}
try {
  const packed = JSON.parse(await run('pack', 'npm', ['pack', '--workspaces', '--json', '--pack-destination', output, '--ignore-scripts']))
  const tarballs = []
  for (const entry of packed) {
    const tarball = path.join(output, entry.filename)
    tarballs.push(tarball)
    entry.sha256 = sha(await fs.readFile(tarball))
    const listing = await run(`tar-${entry.name}`, 'tar', ['-tzf', tarball])
    if (/package\/(?:test|src|node_modules)\//m.test(listing)) throw new Error(`Unexpected development files: ${entry.name}`)
    if (!listing.includes('package/dist/index.js') || !listing.includes('package/dist/index.cjs')) throw new Error(`Missing package outputs: ${entry.name}`)
    for (const required of ['LICENSE', 'README.md']) if (!listing.includes(`package/${required}`)) throw new Error(`Missing ${required}: ${entry.name}`)
    if (entry.name === 'vite-plugin-i18n-c' && !listing.includes('package/ui/app.js')) throw new Error('Missing editor bundle')
  }
  await fs.writeFile(path.join(output, 'tarballs.json'), JSON.stringify(packed, null, 2) + '\n')
  await fs.writeFile(path.join(temporary, 'package.json'), '{"private":true,"type":"module"}\n')
  const versions = await Promise.all(['vite', 'happy-dom'].map(async name => `${name}@${JSON.parse(await fs.readFile(`node_modules/${name}/package.json`, 'utf8')).version}`))
  await run('install-offline', 'npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', ...tarballs, ...versions], temporary)
  await fs.copyFile('scripts/package-runtime.mjs', path.join(temporary, 'runtime.mjs'))
  await run('runtime-node', process.execPath, ['runtime.mjs'], temporary)
} finally {
  await fs.rm(temporary, { recursive: true, force: true })
}
console.log(`Tarball receipts: ${output}`)
