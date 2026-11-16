import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { normalizeConfig } from '../src/config.mjs'

const basic = { tsconfig: 'tsconfig.json', sources: ['src/**/*.ts'], contracts: ['generated.ts'] }

test('single-project paths resolve relative to the configuration directory', () => {
  const result = normalizeConfig({ ...basic, root: '../app' }, '/workspace/config')
  assert.equal(result.root, path.resolve('/workspace/app'))
  assert.equal(result.projects[0].name, 'default')
  assert.ok(result.projects[0].exclude.includes('**/*.test.*'))
})

test('supports multiple named projects', () => {
  const result = normalizeConfig({ projects: [{ ...basic, name: 'one' }, { ...basic, name: 'two' }] }, '.')
  assert.equal(result.projects.length, 2)
})

for (const [name, config, message] of [
  ['missing sources', { tsconfig: 'tsconfig.json', contracts: ['generated.ts'] }, /sources/],
  ['empty contracts', { ...basic, contracts: [] }, /contracts/],
  ['unknown options', { ...basic, typo: true }, /unknown option/],
  ['mixed formats', { ...basic, projects: [{ ...basic }] }, /not both/],
  ['duplicate names', { projects: [{ ...basic, name: 'same' }, { ...basic, name: 'same' }] }, /Duplicate/],
  ['invalid minimum fields', { ...basic, minFields: 1 }, /minFields/],
  ['invalid match limit', { ...basic, maxMatches: 0 }, /maxMatches/],
  ['invalid glob', { ...basic, sources: [42] }, /string/],
]) {
  test(`rejects ${name}`, () => assert.throws(() => normalizeConfig(config, '.'), message))
}
