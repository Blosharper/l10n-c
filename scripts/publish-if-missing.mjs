// Publish a workspace package unless its current version is already on npm.
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const workspace = process.argv[2]
if (!workspace) throw new Error('usage: publish-if-missing.mjs <workspace-dir>')
const { name, version } = JSON.parse(await fs.readFile(path.join(workspace, 'package.json'), 'utf8'))

// `npm view` exits non-zero with E404 when the version does not exist.
const view = spawnSync('npm', ['view', `${name}@${version}`, 'version'], { encoding: 'utf8' })
if (view.status === 0 && view.stdout.trim() === version) {
  console.log(`${name}@${version} is already on npm; skipping`)
  process.exit(0)
}
if (view.status !== 0 && !/E404/.test(view.stderr)) {
  process.stderr.write(view.stderr)
  throw new Error(`could not query ${name}@${version} on npm`)
}

const publish = spawnSync('npm', ['publish', '--provenance', '--access', 'public', '--workspace', workspace], { stdio: 'inherit' })
process.exit(publish.status ?? 1)
