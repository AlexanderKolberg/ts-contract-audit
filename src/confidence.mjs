const genericWords = new Set([
  'list', 'get', 'set', 'create', 'update', 'delete', 'request', 'requests',
  'response', 'responses', 'result', 'input', 'output', 'data', 'global',
  'local', 'type', 'props', 'options', 'args', 'inline',
])

export function nameWords(value) {
  return new Set(value
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase().split(/[^a-z]+/)
    .filter(word => word && !genericWords.has(word)))
}

export function overlap(left, right) {
  return [...left].filter(word => right.has(word)).length
}

export function confidenceFor({ kind, fieldCount, resolvedImport, nameOverlap, importOverlap, distinctTargets }) {
  const reasons = []
  const add = (code, points, message) => reasons.push({ code, points, message })
  add('shape', kind === 'exact' ? 35 : 25,
    kind === 'exact' ? 'All supported fields match exactly.' : 'Every local field matches a contract field.')
  if (resolvedImport) add('resolved-import', 25, 'This file imports this exact contract symbol.')
  if (nameOverlap > 0) add('name-overlap', 15, 'Declaration names share meaningful words.')
  if (importOverlap > 0) add('import-name-overlap', 10, 'Other imported names share contract words; this is lexical evidence only.')
  if (fieldCount >= 3) add('field-count', fieldCount >= 4 ? 10 : 5, `${fieldCount} fields match.`)
  if (distinctTargets === 1) add('unique-target', 5, 'Only one resolved contract type matches in this search scope.')
  if (distinctTargets > 1) add('ambiguous-targets', -Math.min(15, (distinctTargets - 1) * 3), `${distinctTargets} distinct contract types match.`)
  let score = reasons.reduce((sum, reason) => sum + reason.points, 0)
  if (score > 95) {
    add('maximum-score', 95 - score, 'Heuristic scores never claim certainty.')
    score = 95
  }
  if (!resolvedImport && nameOverlap === 0) {
    const cap = importOverlap > 0 ? 59 : 39
    if (score > cap) {
      add('weak-ownership-cap', cap - score, 'No resolved import or matching declaration name establishes an owner.')
      score = cap
    }
  }
  if (fieldCount === 2 && !resolvedImport && score > 69) {
    add('small-shape-cap', 69 - score, 'Two-field shapes without a resolved import cannot score high.')
    score = 69
  }
  return { model: 'heuristic-v1', score, level: score >= 75 ? 'high' : score >= 50 ? 'medium' : 'low', reasons }
}
