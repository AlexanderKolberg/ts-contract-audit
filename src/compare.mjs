import { Node, ts } from 'ts-morph'

export function createShapeReader({ maxDepth = 10, isInvalidDeclaration = () => false, isContractType = () => false } = {}) {
  const cache = new WeakMap()
  const references = new WeakMap()
  let nextReference = 0

  function fingerprint(type, location, ancestors = new Set(), depth = 0) {
    const result = fingerprintValue(type, location, ancestors, depth)
    if (result.reason && !['typescript-diagnostic', 'unresolved-or-open-type'].includes(result.reason) && isContractType(type)) {
      if (!references.has(type.compilerType)) references.set(type.compilerType, ++nextReference)
      return { key: `contract-reference:${references.get(type.compilerType)}` }
    }
    return result
  }

  function fingerprintValue(type, location, ancestors, depth) {
    if (depth > maxDepth) return { reason: 'depth-limit' }
    if ([...(type.getSymbol()?.getDeclarations() ?? []), ...(type.getAliasSymbol()?.getDeclarations() ?? [])].some(isInvalidDeclaration)) {
      return { reason: 'typescript-diagnostic' }
    }
    const raw = type.compilerType
    if (ancestors.has(raw)) return { reason: 'recursive-type' }
    const cached = cache.get(raw)
    if (cached) return cached
    const flags = type.getFlags()
    if (flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) {
      return { reason: 'unresolved-or-open-type' }
    }
    if (flags & ts.TypeFlags.EnumLike) return { reason: 'enum-type' }
    if (type.isIntersection()) return { reason: 'intersection-type' }
    const primitiveFlags = [
      ['string', ts.TypeFlags.String], ['number', ts.TypeFlags.Number],
      ['boolean', ts.TypeFlags.Boolean], ['bigint', ts.TypeFlags.BigInt],
      ['null', ts.TypeFlags.Null], ['undefined', ts.TypeFlags.Undefined],
      ['never', ts.TypeFlags.Never], ['void', ts.TypeFlags.Void],
    ]
    for (const [key, flag] of primitiveFlags) {
      if (flags & flag) return { key }
    }
    if (type.isStringLiteral() || type.isNumberLiteral()) {
      return { key: JSON.stringify(['literal', type.getLiteralValue()]) }
    }
    if (type.isBooleanLiteral()) return { key: type.getText() }
    const next = new Set(ancestors).add(raw)
    if (type.isUnion()) {
      const parts = type.getUnionTypes().map(part => fingerprint(part, location, next, depth + 1))
      const failure = parts.find(part => part.reason)
      if (failure) return failure
      const keys = [...new Set(parts.map(part => part.key))].sort()
      return { key: JSON.stringify(['union', keys]) }
    }
    if (type.isArray() || type.isReadonlyArray()) {
      const element = type.getArrayElementType()
      if (!element) return { reason: 'unsupported-array' }
      const result = fingerprint(element, location, next, depth + 1)
      return result.reason ? result : {
        key: JSON.stringify([type.isReadonlyArray() ? 'readonly-array' : 'array', result.key]),
      }
    }
    if (type.isTuple()) return { reason: 'tuple-type' }
    if (!type.isObject()) return { reason: 'unsupported-type' }
    const shape = readObject(type, location, next, depth + 1)
    if (shape.reason) return shape
    const result = { key: JSON.stringify(['object', [...shape.properties]]) }
    cache.set(raw, result)
    return result
  }

  function readObject(type, location, ancestors, depth) {
    if (depth > maxDepth) return { reason: 'depth-limit' }
    if ((type.getSymbol()?.getDeclarations() ?? []).some(isInvalidDeclaration)) {
      return { reason: 'typescript-diagnostic' }
    }
    if (type.isUnion() || type.isIntersection() || !type.isObject()) {
      return { reason: 'not-plain-object' }
    }
    if (type.isArray() || type.isReadonlyArray() || type.isTuple() || type.isClass()) {
      return { reason: 'not-plain-object' }
    }
    if (type.getObjectFlags() & ts.ObjectFlags.Mapped) return { reason: 'mapped-type' }
    if (type.getCallSignatures().length || type.getConstructSignatures().length) {
      return { reason: 'callable-type' }
    }
    const checker = location.getProject().getTypeChecker().compilerObject
    if (checker.getIndexInfosOfType(type.compilerType).length) return { reason: 'index-signature' }
    const properties = new Map()
    for (const property of type.getProperties().sort((a, b) => a.getName().localeCompare(b.getName()))) {
      const declarations = property.getDeclarations()
      if (declarations.some(isInvalidDeclaration)) return { reason: 'typescript-diagnostic' }
      if (!declarations.length || declarations.some(declaration => !Node.isPropertySignature(declaration))) {
        return { reason: 'non-property-member' }
      }
      if (declarations.some(declaration => Node.isComputedPropertyName(declaration.getNameNode()))) {
        return { reason: 'computed-property' }
      }
      if (declarations.some(declaration => Node.isNumericLiteral(declaration.getNameNode()))) {
        return { reason: 'numeric-property' }
      }
      const value = fingerprint(property.getTypeAtLocation(location), location, ancestors, depth)
      if (value.reason) return value
      const readonly = declarations.some(declaration => declaration.isReadonly())
      properties.set(property.getName(), JSON.stringify({
        optional: property.isOptional(), readonly, type: value.key,
      }))
    }
    if (!properties.size) return { reason: 'empty-object' }
    return { properties }
  }

  return {
    read(type, location) {
      return readObject(type, location, new Set([type.compilerType]), 0)
    },
  }
}

export function compareShapes(local, contract) {
  if (local.reason || contract.reason) return null
  for (const [name, signature] of local.properties) {
    if (contract.properties.get(name) !== signature) return null
  }
  const omitted = [...contract.properties.keys()].filter(name => !local.properties.has(name))
  return {
    kind: omitted.length ? 'subset' : 'exact',
    fields: [...local.properties.keys()],
    omitted,
  }
}

export function replacementFor(expression, comparison) {
  if (comparison.kind === 'exact') return expression
  const useOmit = comparison.omitted.length < comparison.fields.length
  const keys = useOmit ? comparison.omitted : comparison.fields
  return `${useOmit ? 'Omit' : 'Pick'}<${expression}, ${keys.map(key => JSON.stringify(key)).join(' | ')}>`
}
