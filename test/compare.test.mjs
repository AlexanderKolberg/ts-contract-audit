import assert from 'node:assert/strict'
import test from 'node:test'
import { Project } from 'ts-morph'
import { compareShapes, createShapeReader, replacementFor } from '../src/compare.mjs'

function compare(left, right, preamble = '') {
  const project = new Project({ useInMemoryFileSystem: true, compilerOptions: {
    strict: true, exactOptionalPropertyTypes: true,
  } })
  const file = project.createSourceFile('/fixture.ts', `${preamble}\ntype A = ${left};\ntype B = ${right};`)
  const reader = createShapeReader()
  const read = name => {
    const declaration = file.getTypeAliasOrThrow(name)
    return reader.read(declaration.getType(), declaration)
  }
  const a = read('A')
  const b = read('B')
  return { a, b, match: compareShapes(a, b) }
}

test('matches equivalent aliases, unions, and reordered properties', () => {
  const { match } = compare(
    '{ id: ID; status?: Status; tags: string[] }',
    '{ tags: Array<string>; status?: "closed" | "open"; id: string }',
    'type ID = string; type Status = "open" | "closed";',
  )
  assert.equal(match?.kind, 'exact')
})

test('finds a field subset and chooses the shorter derivation', () => {
  const { match } = compare('{ a: string; b?: number }', '{ a: string; b?: number; c?: boolean }')
  assert.equal(match?.kind, 'subset')
  assert.deepEqual(match?.omitted, ['c'])
  assert.equal(replacementFor('Query', match), 'Omit<Query, "c">')
  const broader = compare('{ a: string }', '{ a: string; b?: number; c?: boolean }').match
  assert.equal(replacementFor('Query', broader), 'Pick<Query, "a">')
})

for (const [name, left, right] of [
  ['optionality', '{ a?: string }', '{ a: string | undefined }'],
  ['readonly properties', '{ readonly a: string }', '{ a: string }'],
  ['readonly arrays', '{ a: readonly string[] }', '{ a: string[] }'],
  ['nullability', '{ a: string | null }', '{ a: string }'],
  ['literal narrowing', '{ a: "open" }', '{ a: string }'],
  ['different unions', '{ a: "open" | "closed" }', '{ a: "open" | "pending" }'],
  ['nested optionality', '{ a: { b?: string } }', '{ a: { b: string } }'],
  ['nested extra fields', '{ a: { b: string } }', '{ a: { b: string; c?: number } }'],
  ['missing field', '{ a: string; b: number }', '{ a: string }'],
]) {
  test(`does not conflate ${name}`, () => {
    assert.equal(compare(left, right).match, null)
  })
}

for (const [name, shape, reason, preamble = ''] of [
  ['any', '{ a: any }', 'unresolved-or-open-type'],
  ['unknown', '{ a: unknown }', 'unresolved-or-open-type'],
  ['unresolved references', '{ a: Missing }', 'unresolved-or-open-type'],
  ['callbacks', '{ a: () => void }', 'callable-type'],
  ['index signatures', '{ [key: string]: number }', 'index-signature'],
  ['mapped types', 'Readonly<{ a: string }>', 'mapped-type'],
  ['nested mapped types', '{ a: Readonly<{ b: string }> }', 'mapped-type'],
  ['recursive types', '{ value: string; next?: A }', 'recursive-type'],
  ['tuples', '{ a: [string, number] }', 'tuple-type'],
  ['intersections', '{ a: string } & { b: number }', 'not-plain-object'],
  ['nominal classes', '{ a: Model }', 'not-plain-object', 'class Model { private id = ""; value = "" }'],
  ['symbol indexes', '{ [key: symbol]: string; a: number }', 'index-signature'],
  ['numeric properties', '{ 200: string; 400: string }', 'numeric-property'],
]) {
  test(`skips ${name}`, () => {
    const { a, match } = compare(shape, '{ a: string }', preamble)
    assert.equal(a.reason, reason)
    assert.equal(match, null)
  })
}

test('does not suggest string-keyed utilities for numeric keys', () => {
  const { a, b, match } = compare('{ 200: string; 400: string }', '{ 200: string; 400: string; 404: string }')
  assert.equal(a.reason, 'numeric-property')
  assert.equal(b.reason, 'numeric-property')
  assert.equal(match, null)
})

test('keeps exact replacement expressions', () => {
  assert.equal(replacementFor('NonNullable<Data["query"]>', { kind: 'exact' }), 'NonNullable<Data["query"]>')
})
