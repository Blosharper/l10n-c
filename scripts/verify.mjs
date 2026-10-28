// Sequential stages; raw exits are preserved and no failed stage is relabelled.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
const out = path.resolve(process.env.L10N_C_RECEIPTS ?? `scratch/verification-${new Date().toISOString().replaceAll(':', '-')}`)
await fs.mkdir(path.dirname(out), { recursive: true })
await fs.mkdir(out) // Refuse to replace earlier raw receipts.
const results = []
const stages = [
  ['build', 'npm', ['run', 'build', ...(process.env.L10N_C_BUILD_WORKSPACE ? ['--workspace', process.env.L10N_C_BUILD_WORKSPACE] : [])]],
  ['typecheck', 'npm', ['run', 'typecheck']],
  ['test', 'npm', ['test', ...(process.env.L10N_C_TEST_FILES?.split(',') ?? [])]],
  ['pack-smoke', process.execPath, ['scripts/package-smoke.mjs', path.join(out, 'package-smoke')]],
  ...(process.env.L10N_C_GAME
    ? [
        [
          'parity',
          process.execPath,
          [
            'scripts/parity.mjs',
            process.env.L10N_C_GAME,
            path.join(out, 'parity'),
          ],
        ],
      ]
    : []),
]
const requested = process.argv.slice(2)
for (const name of requested) if (!stages.some(stage => stage[0] === name)) throw new Error(`Unknown verification stage: ${name}`)
for (const [name, command, args] of stages.filter(stage => !requested.length || requested.includes(stage[0]))) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
  for (const stream of ['stdout', 'stderr'])
    await fs.writeFile(
      path.join(out, `${name}.${stream}`),
      result[stream] ?? '',
    )
  const record = {
    name,
    command: [command, ...args],
    exit: result.status,
    signal: result.signal,
    error: result.error?.message,
    stdoutSha256: createHash('sha256')
      .update(result.stdout ?? '')
      .digest('hex'),
    stderrSha256: createHash('sha256')
      .update(result.stderr ?? '')
      .digest('hex'),
  }
  results.push(record)
  await fs.writeFile(
    path.join(out, 'stages.json'),
    JSON.stringify(results, null, 2) + '\n',
  )
  console.log(`${name}: exit ${result.status}`)
  if (result.status !== 0) {
    process.exitCode = 1
    break
  }
}
