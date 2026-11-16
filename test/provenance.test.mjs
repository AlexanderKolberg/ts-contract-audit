import assert from 'node:assert/strict'
import test from 'node:test'
import { Project } from 'ts-morph'
import { scanProject } from '../src/audit.mjs'
import { filterReport, renderMarkdown, renderText } from '../src/report.mjs'

const responses = `
  export interface CreateWidgetResponse { id: string; secret: string }
  export declare const client: { create(): Promise<CreateWidgetResponse> };
`
const localResponse = 'interface CreateWidgetResult { id: string; secret: string }'

function scan(contract, local) {
  const project = new Project({ useInMemoryFileSystem: true, compilerOptions: { strict: true, target: 9 } })
  const generated = project.createSourceFile('/generated.ts', contract)
  const source = project.createSourceFile('/local.ts', local)
  return scanProject({ project, sources: [source], contracts: [generated], root: '/', name: 'fixture',
    diagnostics: project.getPreEmitDiagnostics() })
}

function responseFinding(body) {
  const result = scan(responses, `import { client } from './generated'; ${localResponse}; ${body}`)
  assert.equal(result.sourceDiagnosticCount, 0)
  return result.findings.find(finding => finding.name === 'CreateWidgetResult')
}

function provenance(finding) {
  return finding.matches[0].evidence.provenance
}

test('an awaited generated call establishes response ownership without a type import', () => {
  const finding = responseFinding('async function create(): Promise<CreateWidgetResult> { return await client.create() }')
  assert.equal(provenance(finding).callResults.length, 1)
  assert.equal(provenance(finding).callResults[0].callee, 'client.create')
  assert.ok(finding.confidence.score >= 75)
})

test('same-call destructuring and field-preserving reconstruction establish response ownership', () => {
  const finding = responseFinding(`
    const create = async (): Promise<CreateWidgetResult> => {
      const { id: widgetId, secret } = await client.create()
      return { id: widgetId, secret }
    }
  `)
  assert.equal(provenance(finding).callResults.length, 1)
  assert.equal(finding.confidence.score, 90)
})

test('a const alias and its property projection retain response provenance', () => {
  const finding = responseFinding(`
    async function create(): Promise<CreateWidgetResult> {
      const result = await client.create()
      return { id: result.id, secret: result.secret }
    }
  `)
  assert.equal(provenance(finding).callResults.length, 1)
})

test('a typed const initializer can establish response ownership', () => {
  const finding = responseFinding('async function create() { const result: CreateWidgetResult = await client.create(); return result }')
  assert.equal(provenance(finding).callResults.length, 1)
})

for (const [name, body] of [
  ['an unused nearby call', `async function create(): Promise<CreateWidgetResult> {
    await client.create(); return { id: 'local', secret: 'local' }
  }`],
  ['renamed response fields', `async function create(): Promise<CreateWidgetResult> {
    const { id, secret } = await client.create(); return { id: secret, secret: id }
  }`],
  ['response defaults', `async function create(): Promise<CreateWidgetResult> {
    const { id = 'fallback', secret } = await client.create(); return { id, secret }
  }`],
  ['mixed call results', `async function create(): Promise<CreateWidgetResult> {
    const first = await client.create(); const second = await client.create(); return { id: first.id, secret: second.secret }
  }`],
  ['a fabricated return branch', `async function create(flag: boolean): Promise<CreateWidgetResult> {
    if (flag) return { id: 'local', secret: 'local' }; return await client.create()
  }`],
  ['mutable aliases', `async function create(): Promise<CreateWidgetResult> {
    let result = await client.create(); result = { id: 'local', secret: 'local' }; return result
  }`],
  ['writes to a const result', `async function create(): Promise<CreateWidgetResult> {
    const result = await client.create(); result.id = 'local'; return result
  }`],
  ['writes through a returned const alias', `async function create(): Promise<CreateWidgetResult> {
    const result = await client.create(); const alias = result; alias.id = 'local'; return alias
  }`],
  ['object destructuring writes', `async function create(): Promise<CreateWidgetResult> {
    const result = await client.create()
    ;({ id: result.id, secret: result.secret } = { id: 'local', secret: 'local' })
    return result
  }`],
  ['array destructuring writes', `async function create(): Promise<CreateWidgetResult> {
    const result = await client.create()
    ;[result.id, result.secret] = ['local', 'local']
    return result
  }`],
  ['defaulted destructuring writes', `async function create(): Promise<CreateWidgetResult> {
    const result = await client.create()
    ;[, result.id = 'fallback'] = ['local']
    return result
  }`],
  ['loop destructuring writes', `async function create(): Promise<CreateWidgetResult> {
    const result = await client.create()
    for ({ id: result.id, secret: result.secret } of [{ id: 'local', secret: 'local' }]) {}
    return result
  }`],
  ['asserted expressions', `async function create(): Promise<CreateWidgetResult> {
    return (await client.create()) as CreateWidgetResult
  }`],
]) {
  test(`does not infer response ownership from ${name}`, () => {
    assert.equal(provenance(responseFinding(body)).callResults.length, 0)
  })
}

const queries = `
  export type ListAdminWidgetsData = { query?: { limit?: number; status?: string; cursor?: string; direction?: string; ownerId?: string; adminId?: string } }
  export type ListWidgetsData = { query?: { limit?: number; status?: string; cursor?: string; direction?: string; ownerId?: string } }
  export declare function listWidgetsOptions(options: { query?: ListWidgetsData['query'] }): void
`
const localQuery = 'interface ListWidgetsRequest { limit?: number; status?: string; cursor?: string; direction?: string }'

test('actual query destination outranks a structurally compatible admin contract', () => {
  const result = scan(queries, `
    import { listWidgetsOptions } from './generated'; ${localQuery};
    function list(options: { req?: ListWidgetsRequest } = {}) {
      const { req } = options
      listWidgetsOptions({ query: {
        limit: req?.limit ?? 10, status: req?.status, cursor: req?.cursor, direction: req?.direction,
      } })
    }
  `)
  const finding = result.findings.find(finding => finding.name === 'ListWidgetsRequest')
  assert.equal(finding.matches[0].contract, 'NonNullable<ListWidgetsData["query"]>')
  assert.equal(provenance(finding).requestTargets.length, 1)
  assert.equal(provenance(finding).requestTargets[0].callee, 'listWidgetsOptions')
  assert.ok(finding.matches[0].confidence.score > finding.matches[1].confidence.score)
  assert.ok(finding.confidence.score >= 75)
})

test('direct arguments receive request-destination evidence', () => {
  const result = scan(queries, `import { listWidgetsOptions } from './generated'; ${localQuery};
    function list(req: ListWidgetsRequest) { listWidgetsOptions({ query: req }) }
  `)
  const finding = result.findings.find(finding => finding.name === 'ListWidgetsRequest')
  assert.equal(provenance(finding).requestTargets.length, 1)
})

for (const [name, expression] of [
  ['partial forwarding', '{ limit: req.limit, status: req.status }'],
  ['renamed fields', '{ limit: req.limit, status: req.cursor, cursor: req.status, direction: req.direction }'],
  ['asserted arguments', 'req as NonNullable<import("./generated").ListWidgetsData["query"]>'],
]) {
  test(`does not infer full request ownership from ${name}`, () => {
    const result = scan(queries, `import { listWidgetsOptions } from './generated'; ${localQuery};
      function list(req: ListWidgetsRequest) { listWidgetsOptions({ query: ${expression} }) }
    `)
    const finding = result.findings.find(finding => finding.name === 'ListWidgetsRequest')
    assert.ok(finding.matches.every(match => match.evidence.provenance.requestTargets.length === 0))
  })
}

test('request fields must come from one receiver', () => {
  const result = scan(queries, `import { listWidgetsOptions } from './generated'; ${localQuery};
    function list(a: ListWidgetsRequest, b: ListWidgetsRequest) {
      listWidgetsOptions({ query: { limit: a.limit, status: b.status, cursor: a.cursor, direction: a.direction } })
    }
  `)
  const finding = result.findings.find(finding => finding.name === 'ListWidgetsRequest')
  assert.ok(finding.matches.every(match => match.evidence.provenance.requestTargets.length === 0))
})

test('a source type error prevents ownership evidence from an invalid call', () => {
  const result = scan(queries, `import { listWidgetsOptions } from './generated'; ${localQuery};
    function list(req: ListWidgetsRequest) { listWidgetsOptions({ query: req, unsupported: true }) }
  `)
  const finding = result.findings.find(finding => finding.name === 'ListWidgetsRequest')
  assert.ok(result.sourceDiagnosticCount > 0)
  assert.ok(finding.matches.every(match => match.evidence.provenance.requestTargets.length === 0))
})

for (const [expression, label] of [
  ['createClient("SYNTHETIC_PRIVATE_TOKEN").create()', '<expression>.create'],
  ['clients["SYNTHETIC_PRIVATE_TOKEN"].create()', 'clients[computed].create'],
]) {
  test(`callee labels omit literals from ${label}`, () => {
    const result = scan(`${responses}
      export declare function createClient(token: string): typeof client
      export declare const clients: { [key: string]: typeof client }
    `, `import { createClient, clients } from './generated'; ${localResponse};
      async function create(): Promise<CreateWidgetResult> { return await ${expression} }
    `)
    assert.equal(result.sourceDiagnosticCount, 0)
    const finding = result.findings.find(finding => finding.name === 'CreateWidgetResult')
    assert.equal(provenance(finding).callResults[0].callee, label)
    const report = filterReport({ projects: [result] }, 0)
    for (const output of [JSON.stringify(report), renderText(report), renderMarkdown(report)]) {
      assert.ok(!output.includes('SYNTHETIC_PRIVATE_TOKEN'))
    }
  })
}

test('structurally equal but separately declared call types do not count as provenance', () => {
  const result = scan(responses, `${localResponse};
    declare function unrelated(): Promise<{ id: string; secret: string }>;
    async function create(): Promise<CreateWidgetResult> { return await unrelated() }
  `)
  assert.equal(provenance(result.findings.find(finding => finding.name === 'CreateWidgetResult')).callResults.length, 0)
})
