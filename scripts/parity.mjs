import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { compareOrderRecords } from './parity-records.mjs'

const game = path.resolve(process.argv[2] ?? '')
const output = path.resolve(process.argv[3] ?? '')
if (process.argv.length < 4)
  throw new Error(
    'Usage: node scripts/parity.mjs GAME_CHECKOUT NEW_RECEIPT_DIRECTORY [CHECK...]',
  )
const cli = path.resolve('packages/l10n-c/dist/cli.js')
const extractedRuntime = process.env.L10N_C_PARITY_RUNTIME === 'bun' ? 'bun' : process.execPath
const requested = process.argv.slice(4)
const commands = [
  ['search', ['--search', 'ui.button']],
  ['missing', ['--missing']],
  ['nest-check', ['--nest-check']],
  ['duplicate-check', ['--duplicate-check']],
  ['unused', ['--unused']],
]
for (const name of requested) if (!commands.some(command => command[0] === name)) throw new Error(`Unknown parity check: ${name}`)
const selected = commands.filter(command => !requested.length || requested.includes(command[0]))
const localeRoot = path.join(game, 'public/locales')
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'l10n-c-parity-'))
await fs.mkdir(output) // Deliberately refuse to overwrite an old receipt.
const config = {
  localesDir: localeRoot,
  baseLanguage: 'ko',
  sourcePaths: ['src', 'electron', 'index.html'].map((p) => path.join(game, p)),
  sourceIgnore: [],
  mirrors: [],
  allowedRoots: {
    db: ['db'],
    game: ['game'],
    story: ['story'],
    ui: ['ui', 'speech'],
  },
  referencePrefixes: ['ui.'],
}
await fs.writeFile(
  path.join(temporary, 'l10n-c.config.json'),
  JSON.stringify(config, null, 2) + '\n',
)
await fs.writeFile(
  path.join(output, 'compatibility-config.json'),
  JSON.stringify(config, null, 2) + '\n',
)
async function inventory() {
  const files = []
  async function walk(target, mode) {
    let stat
    try {
      stat = await fs.lstat(target)
    } catch (error) {
      if (error.code === 'ENOENT') return
      throw error
    }
    if (stat.isSymbolicLink()) {
      files.push([
        path.relative(game, target),
        `symlink:${await fs.readlink(target)}`,
      ])
      return
    }
    if (stat.isDirectory()) {
      for (const name of (await fs.readdir(target)).sort())
        await walk(path.join(target, name), mode)
    } else if (
      mode !== 'sources' ||
      /\.(ts|js|cjs|mjs|tsx|jsx|html)$/.test(target)
    ) {
      files.push([
        path.relative(game, target),
        createHash('sha256')
          .update(await fs.readFile(target))
          .digest('hex'),
      ])
    }
  }
  await walk(localeRoot, 'all')
  for (const target of config.sourcePaths) await walk(target, 'sources')
  for (const file of [
    'cli.ts',
    'core.ts',
    'plugin.ts',
    'app.ts',
    'index.html',
    'I18N_TRANSLATION.md',
  ])
    await walk(path.join(game, 'i18n', file), 'all')
  return Object.fromEntries(files.sort(([a], [b]) => a.localeCompare(b)))
}
function sha(text) {
  return createHash('sha256').update(text).digest('hex')
}
const normalize = (text, cwd) =>
  text
    .replaceAll(path.relative(cwd, localeRoot), '<locales>')
    .replace(
      /^🌸 Scanning for unused translation keys in .*\.\.\.(.*)$/m,
      '🌸 Scanning for unused translation keys in <configured sources>...$1',
    )
const before = await inventory()
await fs.writeFile(
  path.join(output, 'game-inputs-before.json'),
  JSON.stringify(before, null, 2) + '\n',
)
const results = []
try {
  for (const [name, args] of selected) {
    const runs = []
    for (const [side, executable, argv, cwd] of [
      ['game', 'bun', ['run', 'i18n/cli.ts', ...args], game],
      ['extracted', extractedRuntime, [cli, ...args], temporary],
    ]) {
      const run = spawnSync(executable, argv, {
        cwd,
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
        timeout: 60000,
      })
      const stdout = run.stdout ?? '',
        stderr = run.stderr ?? ''
      await fs.writeFile(path.join(output, `${name}.${side}.stdout`), stdout)
      await fs.writeFile(path.join(output, `${name}.${side}.stderr`), stderr)
      runs.push({
        side,
        command: [executable, ...argv],
        cwd,
        exit: run.status,
        signal: run.signal,
        error: run.error?.message,
        stdoutSha256: sha(stdout),
        stderrSha256: sha(stderr),
        normalizedStdout: normalize(stdout, cwd),
        normalizedStderr: normalize(stderr, cwd),
      })
    }
    for (const run of runs) {
      await fs.writeFile(path.join(output, `${name}.${run.side}.normalized.stdout`), run.normalizedStdout)
      await fs.writeFile(path.join(output, `${name}.${run.side}.normalized.stderr`), run.normalizedStderr)
    }
    for (const stream of ['stdout', 'stderr']) {
      const diff = spawnSync('diff', ['-u', path.join(output, `${name}.game.normalized.${stream}`), path.join(output, `${name}.extracted.normalized.${stream}`)], { encoding: 'utf8' })
      await fs.writeFile(path.join(output, `${name}.${stream}.diff`), (diff.stdout ?? '') + (diff.stderr ?? ''))
      if (![0, 1].includes(diff.status)) throw new Error(`diff failed: ${diff.status}`)
    }
    const equal =
      runs.every((run) => run.exit !== null && !run.error) &&
      runs[0].exit === runs[1].exit &&
      runs[0].normalizedStdout === runs[1].normalizedStdout &&
      runs[0].normalizedStderr === runs[1].normalizedStderr
    const orderRecords = !equal && runs[0].exit === runs[1].exit && runs[0].normalizedStderr === runs[1].normalizedStderr
      ? compareOrderRecords(name, runs[0].normalizedStdout, runs[1].normalizedStdout)
      : undefined
    results.push({ name, equal, orderRecords, intendedDifference: orderRecords?.equal ? 'HQ ed5987e0: deterministic base-first locale and filename order; raw diff retained' : undefined, runs })
    console.log(
      `${name}: ${equal ? 'MATCH' : 'MISMATCH'} (exits ${runs.map((run) => run.exit).join('/')})`,
    )
  }
} finally {
  const after = await inventory()
  await fs.writeFile(
    path.join(output, 'game-inputs-after.json'),
    JSON.stringify(after, null, 2) + '\n',
  )
  const unchanged = JSON.stringify(before) === JSON.stringify(after)
  const summary = {
    game,
    cli,
    compatibilityConfig: config,
    extractedRuntime,
    selectedChecks: selected.map(command => command[0]),
    gameInputCount: Object.keys(before).length,
    gameInputsUnchanged: unchanged,
    pass:
      unchanged &&
      results.length === selected.length &&
      results.every((result) => result.equal),
    contractPass:
      unchanged && results.length === selected.length && results.every(result => result.equal || result.orderRecords?.equal),
    rawParityPass: unchanged && results.length === selected.length && results.every(result => result.equal),
    normalization: [
      'locale directory prefix',
      'configured unused scan banner only',
    ],
    results,
  }
  await fs.writeFile(
    path.join(output, 'summary.json'),
    JSON.stringify(summary, null, 2) + '\n',
  )
  await fs.rm(temporary, { recursive: true, force: true })
  if (!summary.pass) process.exitCode = 1
  console.log(`Receipt: ${output}; game inputs unchanged: ${unchanged}`)
}
