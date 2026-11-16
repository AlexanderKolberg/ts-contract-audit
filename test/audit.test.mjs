import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { Project } from 'ts-morph'
import { auditProject, contractCandidates, handwrittenCandidates, scanProject } from '../src/audit.mjs'

function setup(contract, local) {
  const project = new Project({ useInMemoryFileSystem: true, compilerOptions: { strict: true } })
  const generated = project.createSourceFile('/contract.ts', contract)
  const source = project.createSourceFile('/local.ts', local)
  return { project, generated, source }
}

function scan(fixture, options = {}) {
  return scanProject({ project: fixture.project, contracts: [fixture.generated], sources: [fixture.source],
    root: '/', name: 'fixture', ...options })
}

test('finds generated nested query contracts and preserves optionality', () => {
  const fixture = setup(
    'export type ListWidgetsData = { query?: { limit?: number; status?: "active"; customerId?: string }; url: string }',
    'interface ListWidgetsRequest { limit?: number; status?: "active" }',
  )
  const result = scan(fixture)
  assert.equal(result.findings.length, 1)
  const match = result.findings[0].matches[0]
  assert.equal(match.replacement, 'Omit<NonNullable<ListWidgetsData["query"]>, "customerId">')
  assert.equal(match.kind, 'subset')
  assert.equal(result.findings[0].relatedContractEvidence, true)
})

test('discovers function-local named declarations without duplicate inline reports', () => {
  const fixture = setup('export interface Widget { id: string; name: string }', `
    function consume() {
      interface Local { id: string; name: string }
      type Other = { id: string; name: string }
    }
  `)
  const result = scan(fixture)
  assert.equal(result.findings.length, 2)
  assert.deepEqual(new Set(result.findings.map(finding => finding.name)), new Set(['Local', 'Other']))
  assert.ok(result.findings.every(finding => finding.declarationKind === 'named'))
})

test('uses numeric indexing for nested response contracts', () => {
  const fixture = setup('export type Responses = { 200: { id: string; name: string } }',
    'interface Local { id: string; name: string }')
  assert.equal(scan(fixture).findings[0].matches[0].replacement, 'Responses[200]')
})

test('ranks a related subset above an unrelated exact match', () => {
  const fixture = setup(`
    export interface UnrelatedRequest { limit?: number; startingAfter?: string }
    export type ListWidgetsData = { query?: { limit?: number; startingAfter?: string; customerId?: string } }
  `, 'interface ListWidgetsRequest { limit?: number; startingAfter?: string }')
  const finding = scan(fixture).findings[0]
  assert.equal(finding.matches[0].contract, 'NonNullable<ListWidgetsData["query"]>')
  assert.equal(finding.matches[0].kind, 'subset')
})

test('finds a named response copy and an inline parameter copy', () => {
  const fixture = setup(
    'export interface CreateWidgetResponse { id: string; secret: string }',
    'interface CreateWidgetResult { secret: string; id: string }; function consume(value: { id: string; secret: string }) {}',
  )
  const result = scan(fixture)
  assert.equal(result.findings.length, 2)
  assert.deepEqual(new Set(result.findings.map(finding => finding.declarationKind)), new Set(['named', 'inline']))
  assert.ok(result.findings.every(finding => finding.matches[0].replacement === 'CreateWidgetResponse'))
})

test('does not count existing derived aliases or interface extensions as copies', () => {
  const fixture = setup('export interface Widget { id: string; name: string }', `
    import type { Widget } from './contract';
    type Alias = Widget;
    type Subset = Pick<Widget, 'id'>;
    type Extended = Widget & { id: string; name: string; selected: boolean };
    interface Other extends Widget { nested: { id: string; name: string }; selected: boolean }
  `)
  assert.equal(scan(fixture).findings.length, 0)
})

test('preserves identical generated references without expanding unsupported internals', () => {
  const fixture = setup(`
    export type Widget = { id: string } & { name: string };
    export interface WidgetList { data?: Widget[]; hasMore?: boolean; cursor?: string }
  `, `
    import type { Widget } from './contract';
    function normalize(data: { data?: Widget[]; hasMore?: boolean; cursor?: string }) {}
  `)
  const finding = scan(fixture).findings[0]
  assert.equal(finding.matches[0].replacement, 'WidgetList')
})

test('does not equate distinct opaque generated types', () => {
  const fixture = setup(`
    export type Widget = { id: string } & { name: string };
    export type Other = { id: string } & { name: string };
    export interface WidgetList { data?: Widget[]; hasMore?: boolean }
  `, `
    import type { Other } from './contract';
    function normalize(data: { data?: Other[]; hasMore?: boolean }) {}
  `)
  assert.equal(scan(fixture).findings.length, 0)
})

test('canonicalizes symlinked contract files before comparing generated references', t => {
  const directory = fs.mkdtempSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixture-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  fs.writeFileSync(path.join(directory, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
    strict: true, target: 'ES2023', module: 'ESNext', moduleResolution: 'Bundler', skipLibCheck: true,
  } }))
  fs.mkdirSync(path.join(directory, 'actual'))
  fs.mkdirSync(path.join(directory, 'node_modules'))
  fs.writeFileSync(path.join(directory, 'actual/package.json'), JSON.stringify({ name: 'fixture-api', types: './index.d.ts' }))
  fs.writeFileSync(path.join(directory, 'actual/index.d.ts'), `
    export type Widget = { id: string } & { name: string };
    export interface WidgetList { data?: Widget[]; hasMore?: boolean }
  `)
  fs.symlinkSync(path.join(directory, 'actual'), path.join(directory, 'node_modules/fixture-api'))
  fs.writeFileSync(path.join(directory, 'local.ts'), `
    import type { Widget } from 'fixture-api';
    export function normalize(data: { data?: Widget[]; hasMore?: boolean }) { return data }
  `)
  const result = auditProject({ name: 'symlink', tsconfig: 'tsconfig.json', sources: ['local.ts'], contracts: ['node_modules/fixture-api/index.d.ts'] }, directory)
  assert.equal(result.findings[0]?.matches[0]?.replacement, 'WidgetList')
})

test('resolved import evidence follows aliases to the actual exported declaration', () => {
  const fixture = setup('export interface Widget { id: string; name: string }', `
    import type { Widget as ApiWidget } from './contract';
    interface Local { id: string; name: string }
  `)
  assert.equal(scan(fixture).findings[0].matches[0].evidence.resolvedImport, true)
})

test('a same-named import from another module is not resolved ownership evidence', () => {
  const fixture = setup('export interface Widget { id: string; name: string }', `
    import type { Widget } from './other';
    interface Local { id: string; name: string }
  `)
  fixture.project.createSourceFile('/other.ts', 'export interface Widget { id: string; name: string }')
  assert.equal(scan(fixture).findings[0].matches[0].evidence.resolvedImport, false)
})

test('does not advertise a non-exported contract', () => {
  const fixture = setup('interface Hidden { id: string; name: string }', 'interface Local { id: string; name: string }')
  assert.equal(contractCandidates(fixture.generated).length, 0)
  assert.equal(scan(fixture).findings.length, 0)
})

test('reports ambiguous structural matches instead of choosing a business owner', () => {
  const fixture = setup(`
    export interface Customer { id: string; label: string }
    export interface Organization { id: string; label: string }
  `, 'interface MenuEntry { id: string; label: string }')
  const finding = scan(fixture).findings[0]
  assert.equal(finding.totalMatches, 2)
  assert.equal(finding.relatedContractEvidence, false)
})

test('skips generic declarations and one-field shapes', () => {
  const fixture = setup('export interface Contract { id: string; name: string }', `
    interface Generic<T> { id: T; name: string }
    type Nested<T> = { inner: { id: T; name: string } }
    type Single = { id: string }
  `)
  assert.equal(handwrittenCandidates(fixture.source).length, 1)
  assert.equal(scan(fixture).findings.length, 0)
})

test('suppresses diagnostic-affected source declarations', () => {
  const fixture = setup('export interface Contract { id: string; name: string }',
    'interface Local { id: string; name: string }; interface Local { name: number }')
  const diagnostics = fixture.project.getPreEmitDiagnostics()
  assert.ok(diagnostics.length > 0)
  const result = scan(fixture, { diagnostics })
  assert.equal(result.findings.length, 0)
  assert.ok(result.rejected.handwritten['typescript-diagnostic'] > 0)
})

test('keeps nested field differences out of exact-match reports', () => {
  const fixture = setup('export interface Contract { id: string; config: { enabled: boolean; required: string } }',
    'interface Local { id: string; config: { enabled: boolean } }')
  const result = scan(fixture)
  assert.equal(result.findings.length, 0)
})
