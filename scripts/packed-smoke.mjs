import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const archive = path.join(root, 'tmp', `${manifest.name}-${manifest.version}.tgz`)
const directory = fs.mkdtempSync(path.join(root, 'tmp/packed-'))
try {
  execFileSync('npm', ['install', '--prefix', directory, '--ignore-scripts', '--no-audit', '--no-fund', archive], { stdio: 'pipe' })
  const installed = path.join(directory, 'node_modules', manifest.name)
  const cli = path.join(installed, 'bin/ts-contract-audit.mjs')
  const version = execFileSync(process.execPath, [cli, '--version'], { encoding: 'utf8' }).trim()
  assert.equal(version, manifest.version)
  const report = JSON.parse(execFileSync(process.execPath, [
    cli, '--config', path.join(installed, 'examples/basic/ts-contract-audit.json'), '--format', 'json', '--quiet',
  ], { encoding: 'utf8' }))
  assert.equal(report.projects[0].findings.length, 3)
  assert.equal(report.projects[0].sourceDiagnosticCount, 0)
  assert.equal(report.projects[0].findings[0].confidence.level, 'high')
  console.log('Packed CLI installed and audited its bundled example successfully.')
} finally {
  fs.rmSync(directory, { recursive: true, force: true })
}
