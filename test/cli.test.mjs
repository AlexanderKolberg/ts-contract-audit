import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cli = path.join(root, 'bin/ts-contract-audit.mjs')
const example = path.join(root, 'examples/basic/ts-contract-audit.json')
const run = (...args) => spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8', timeout: 60000 })

function fixture(t) {
  fs.mkdirSync(path.join(root, 'tmp'), { recursive: true })
  const directory = fs.mkdtempSync(path.join(root, 'tmp/cli-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}

test('help and version do not require a config', () => {
  assert.equal(run('--help').status, 0)
  assert.match(run('--help').stdout, /heuristics, not probabilities/)
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  assert.equal(run('--version').stdout, `${manifest.version}\n`)
})

test('JSON scores are machine readable and generated source is not audited against itself', () => {
  const result = run('--config', example, '--format', 'json', '--quiet')
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stderr, '')
  const report = JSON.parse(result.stdout)
  assert.equal(report.advisory, true)
  assert.equal(report.confidenceModel, 'heuristic-v2')
  assert.equal(report.projects[0].sourceFiles, 1)
  const findings = report.projects[0].findings
  assert.equal(findings.length, 3)
  assert.ok(findings.every(finding => finding.confidence.model === report.confidenceModel))
  assert.equal(findings.find(finding => finding.name === 'CreateWidgetResult').confidence.level, 'high')
  assert.equal(findings.find(finding => finding.name === 'EmptyState').confidence.level, 'low')
})

test('confidence filtering retains the unfiltered count', () => {
  const result = run('--config', example, '--format', 'json', '--min-confidence', '75')
  assert.equal(result.status, 0, result.stderr)
  const report = JSON.parse(result.stdout)
  assert.equal(report.projects[0].totalFindingCount, 3)
  assert.equal(report.projects[0].findings.length, 2)
  assert.ok(report.projects[0].findings.every(finding => finding.confidence.score >= 75))
})

test('Markdown suggestions preserve TypeScript angle brackets', () => {
  const result = run('--config', example, '--format', 'markdown')
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Omit<NonNullable<ListWidgetsData\["query"\]>, "customerId">/)
  assert.doesNotMatch(result.stdout, /Omit&lt;/)
  assert.match(result.stdout, /from call ` createWidget `/)
  assert.match(result.stdout, /to call ` listWidgets `/)
})

test('explicit output writes a new file and refuses to clobber it', t => {
  const output = path.join(fixture(t), 'audit.json')
  const first = run('--config', example, '--format', 'json', '--output', output)
  assert.equal(first.status, 0, first.stderr)
  const original = fs.readFileSync(output, 'utf8')
  assert.equal(JSON.parse(original).schemaVersion, 1)
  const second = run('--config', example, '--output', output)
  assert.equal(second.status, 1)
  assert.match(second.stderr, /Refusing to overwrite/)
  assert.equal(fs.readFileSync(output, 'utf8'), original)
})

test('runs one project from a multi-project config without git', t => {
  const directory = fixture(t)
  const config = path.join(directory, 'config.json')
  const single = JSON.parse(fs.readFileSync(example, 'utf8'))
  fs.writeFileSync(config, JSON.stringify({ root: path.dirname(example), projects: [
    { ...single, name: 'one' }, { ...single, name: 'two' },
  ] }))
  const result = run('--config', config, '--project', 'two', '--format', 'json')
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout).projects.map(project => project.name), ['two'])
})

for (const [name, args, message] of [
  ['invalid score', ['--min-confidence', '101'], /integer/],
  ['invalid score text', ['--min-confidence', '70abc'], /integer/],
  ['invalid limit', ['--limit', '0'], /integer/],
  ['invalid format', ['--format', 'xml'], /format/],
  ['missing config', ['--config', 'does-not-exist.json'], /Cannot read JSON config/],
  ['unknown project', ['--config', example, '--project', 'missing'], /Unknown project/],
]) {
  test(`fails clearly on ${name}`, () => {
    const result = run(...args)
    assert.equal(result.status, 1)
    assert.match(result.stderr, message)
    assert.equal(result.stdout, '')
  })
}
