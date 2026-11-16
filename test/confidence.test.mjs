import assert from 'node:assert/strict'
import test from 'node:test'
import { confidenceFor, nameWords } from '../src/confidence.mjs'

const base = { kind: 'exact', fieldCount: 3, resolvedImport: false, nameOverlap: 0, importOverlap: 0, distinctTargets: 1 }

test('a common shape without ownership evidence stays low', () => {
  const result = confidenceFor({ ...base, fieldCount: 2 })
  assert.equal(result.score, 39)
  assert.equal(result.level, 'low')
})

test('a resolved named contract with several fields scores high', () => {
  const result = confidenceFor({ ...base, fieldCount: 4, resolvedImport: true, nameOverlap: 1, importOverlap: 1 })
  assert.equal(result.score, 90)
  assert.equal(result.level, 'high')
  assert.equal(result.reasons.reduce((sum, reason) => sum + reason.points, 0), result.score)
})

test('a resolved import does not also earn lexical import points', () => {
  const withoutWords = confidenceFor({ ...base, resolvedImport: true })
  const withWords = confidenceFor({ ...base, resolvedImport: true, importOverlap: 4 })
  assert.equal(withWords.score, withoutWords.score)
  assert.ok(!withWords.reasons.some(reason => reason.code === 'import-name-overlap'))
})

test('contract flow replaces rather than stacks with import evidence', () => {
  const provenance = { callResults: [{}], requestTargets: [{}] }
  const flow = confidenceFor({ ...base, provenance })
  const allEvidence = confidenceFor({ ...base, provenance, resolvedImport: true, importOverlap: 3 })
  assert.equal(flow.score, allEvidence.score)
  assert.equal(allEvidence.model, 'heuristic-v2')
  assert.ok(allEvidence.reasons.some(reason => reason.code === 'contract-flow' && reason.points === 35))
  assert.ok(!allEvidence.reasons.some(reason => reason.code === 'resolved-import' || reason.code === 'import-name-overlap'))
})

test('provenance allows small shapes with no name overlap to rank high', () => {
  const result = confidenceFor({ ...base, fieldCount: 2, provenance: { callResults: [{}], requestTargets: [] } })
  assert.equal(result.score, 75)
  assert.equal(result.level, 'high')
})

test('ambiguity lowers confidence', () => {
  const unique = confidenceFor({ ...base, resolvedImport: true })
  const ambiguous = confidenceFor({ ...base, resolvedImport: true, distinctTargets: 10 })
  assert.ok(ambiguous.score < unique.score)
  assert.ok(ambiguous.reasons.some(reason => reason.code === 'ambiguous-targets'))
})

test('lexical imports alone cannot give high confidence', () => {
  const result = confidenceFor({ ...base, fieldCount: 10, importOverlap: 3 })
  assert.ok(result.score < 75)
})

test('a subset scores below an otherwise identical exact match', () => {
  assert.ok(confidenceFor({ ...base, kind: 'subset' }).score < confidenceFor(base).score)
})

test('scores are bounded and all adjustments are explained', () => {
  for (const kind of ['exact', 'subset']) for (const fieldCount of [2, 3, 8]) {
    for (const resolvedImport of [false, true]) for (const nameOverlap of [0, 1, 4]) {
      for (const importOverlap of [0, 2]) for (const distinctTargets of [1, 2, 30]) {
        const result = confidenceFor({ kind, fieldCount, resolvedImport, nameOverlap, importOverlap, distinctTargets })
        assert.ok(result.score >= 0 && result.score <= 95)
        assert.equal(result.reasons.reduce((sum, reason) => sum + reason.points, 0), result.score)
      }
    }
  }
})

test('ignores generic words but keeps domain names', () => {
  assert.deepEqual([...nameWords('ListAPIWidgetsRequest')], ['api', 'widgets'])
  assert.ok(nameWords('CustomerResponse').has('customer'))
})
