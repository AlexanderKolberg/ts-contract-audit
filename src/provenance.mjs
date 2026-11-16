import path from 'node:path'
import { Node, SyntaxKind, ts } from 'ts-morph'

const isFunction = node => Node.isFunctionDeclaration(node) || Node.isFunctionExpression(node) ||
  Node.isArrowFunction(node) || Node.isMethodDeclaration(node) || Node.isGetAccessorDeclaration(node)

function propertyName(node) {
  if (Node.isIdentifier(node)) return node.getText()
  if (Node.isStringLiteral(node)) return node.getLiteralText()
  return undefined
}

function unparenthesized(node) {
  while (Node.isParenthesizedExpression(node)) node = node.getExpression()
  return node
}

function calleeLabel(expression, depth = 0) {
  if (depth > 6) return '<expression>'
  const node = unparenthesized(expression)
  if (Node.isIdentifier(node)) return node.getText()
  if (node.getKind() === SyntaxKind.ThisKeyword) return 'this'
  if (node.getKind() === SyntaxKind.SuperKeyword) return 'super'
  if (Node.isPropertyAccessExpression(node)) return `${calleeLabel(node.getExpression(), depth + 1)}.${node.getName()}`
  if (Node.isElementAccessExpression(node)) return `${calleeLabel(node.getExpression(), depth + 1)}[computed]`
  return '<expression>'
}

function constDeclaration(node) {
  return Node.isVariableDeclaration(node) && node.getParentIfKind(SyntaxKind.VariableDeclarationList)?.getDeclarationKind() === 'const'
}

export function createProvenanceReader({ project, root, isInvalidDeclaration }) {
  const checker = project.getTypeChecker()
  const sourceCache = new WeakMap()
  const symbolIds = new WeakMap()
  let nextSymbolId = 0

  function valueType(type) {
    const value = type.getAwaitedType() ?? type
    if (value.getFlags() & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) return undefined
    return value.getNonNullableType().compilerType
  }

  function symbolIdentity(symbol) {
    if (!symbol) return undefined
    if (!symbolIds.has(symbol)) symbolIds.set(symbol, ++nextSymbolId)
    return `symbol:${symbolIds.get(symbol)}`
  }

  function symbolOf(identifier) {
    const parent = identifier.getParent()
    return Node.isShorthandPropertyAssignment(parent)
      ? checker.getShorthandAssignmentValueSymbol(parent) : identifier.getSymbol()
  }

  function receiverIdentity(expression) {
    const node = unparenthesized(expression)
    if (Node.isIdentifier(node)) {
      return symbolIdentity(symbolOf(node)?.compilerSymbol)
    }
    if (Node.isPropertyAccessExpression(node)) {
      const parent = receiverIdentity(node.getExpression())
      return parent ? `${parent}.${node.getName()}` : undefined
    }
    return undefined
  }

  function sourceInfo(source) {
    const existing = sourceCache.get(source.compilerNode)
    if (existing) return existing
    const descendants = source.getDescendants()
    const mutated = new Set()
    const mark = expression => {
      let node = unparenthesized(expression)
      if (Node.isObjectLiteralExpression(node)) {
        for (const property of node.getProperties()) {
          if (Node.isPropertyAssignment(property)) mark(property.getInitializer())
          else if (Node.isShorthandPropertyAssignment(property)) mark(property.getNameNode())
          else if (Node.isSpreadAssignment(property)) mark(property.getExpression())
        }
        return
      }
      if (Node.isArrayLiteralExpression(node)) {
        for (const element of node.getElements()) if (!Node.isOmittedExpression(element)) mark(element)
        return
      }
      if (Node.isSpreadElement(node)) return mark(node.getExpression())
      if (Node.isBinaryExpression(node) && node.getOperatorToken().getKind() === SyntaxKind.EqualsToken) return mark(node.getLeft())
      while (Node.isPropertyAccessExpression(node) || Node.isElementAccessExpression(node)) node = unparenthesized(node.getExpression())
      const identity = receiverIdentity(node)
      if (identity) mutated.add(identity)
    }
    for (const node of descendants) {
      if (Node.isBinaryExpression(node) && node.getOperatorToken().getKind() >= SyntaxKind.FirstAssignment &&
          node.getOperatorToken().getKind() <= SyntaxKind.LastAssignment) mark(node.getLeft())
      if ((Node.isPrefixUnaryExpression(node) || Node.isPostfixUnaryExpression(node)) &&
          [SyntaxKind.PlusPlusToken, SyntaxKind.MinusMinusToken].includes(node.getOperatorToken())) mark(node.getOperand())
      if (Node.isDeleteExpression(node)) mark(node.getExpression())
      if ((Node.isForOfStatement(node) || Node.isForInStatement(node)) && !Node.isVariableDeclarationList(node.getInitializer())) mark(node.getInitializer())
    }
    const result = {
      calls: descendants.filter(Node.isCallExpression),
      functions: descendants.filter(isFunction),
      variables: descendants.filter(Node.isVariableDeclaration),
      mutated,
      candidates: new WeakMap(),
    }
    sourceCache.set(source.compilerNode, result)
    return result
  }

  function describe(call) {
    return {
      file: path.relative(root, call.getSourceFile().getFilePath()),
      line: call.getStartLineNumber(),
      callee: calleeLabel(call.getExpression()).slice(0, 120),
    }
  }

  function forLocal(local) {
    const source = local.node.getSourceFile()
    const info = sourceInfo(source)
    const localType = local.type.compilerType
    const cached = info.candidates.get(localType)
    if (cached) return cached
    const evidence = new Map()
    info.candidates.set(localType, evidence)
    const fields = [...local.shape.properties.keys()]

    function record(type, kind, call) {
      if (!type) return
      if (!evidence.has(type)) evidence.set(type, { callResults: [], requestTargets: [] })
      const entries = evidence.get(type)[kind]
      const entry = describe(call)
      if (entries.length < 3 && !entries.some(item => item.file === entry.file && item.line === entry.line && item.callee === entry.callee)) entries.push(entry)
    }

    function resultOrigin(expression, seen = new Set(), depth = 0) {
      if (!expression || depth > 6 || isInvalidDeclaration(expression)) return undefined
      const node = unparenthesized(expression)
      if (Node.isAwaitExpression(node)) return resultOrigin(node.getExpression(), seen, depth + 1)
      if (Node.isCallExpression(node)) {
        const type = valueType(node.getType())
        return type ? { call: node, type } : undefined
      }
      if (Node.isIdentifier(node)) {
        const symbol = symbolOf(node)
        if (!symbol || seen.has(symbol.compilerSymbol) || info.mutated.has(symbolIdentity(symbol.compilerSymbol))) return undefined
        const declarations = symbol.getDeclarations()
        if (declarations.length !== 1) return undefined
        const declaration = declarations[0]
        if (declaration.getSourceFile() !== source || declaration.getStart() >= node.getStart()) return undefined
        const next = new Set(seen).add(symbol.compilerSymbol)
        if (constDeclaration(declaration)) return resultOrigin(declaration.getInitializer(), next, depth + 1)
        if (Node.isBindingElement(declaration) && !declaration.getInitializer() && !declaration.getDotDotDotToken()) {
          const pattern = declaration.getParent()
          const variable = pattern.getParent()
          if (!Node.isObjectBindingPattern(pattern) || !constDeclaration(variable)) return undefined
          const origin = resultOrigin(variable.getInitializer(), next, depth + 1)
          const field = propertyName(declaration.getPropertyNameNode() ?? declaration.getNameNode())
          return origin && origin.field === undefined && field ? { ...origin, field } : undefined
        }
        return undefined
      }
      if (Node.isPropertyAccessExpression(node)) {
        const origin = resultOrigin(node.getExpression(), seen, depth + 1)
        return origin && origin.field === undefined ? { ...origin, field: node.getName() } : undefined
      }
      if (Node.isObjectLiteralExpression(node)) {
        const properties = node.getProperties()
        if (properties.length !== fields.length) return undefined
        let common
        const found = new Set()
        for (const property of properties) {
          if (!Node.isPropertyAssignment(property) && !Node.isShorthandPropertyAssignment(property)) return undefined
          const name = propertyName(property.getNameNode())
          if (!fields.includes(name) || found.has(name)) return undefined
          found.add(name)
          const value = Node.isPropertyAssignment(property) ? property.getInitializer() : property.getNameNode()
          const origin = resultOrigin(value, seen, depth + 1)
          if (!origin || origin.field !== name || (common && (common.call !== origin.call || common.type !== origin.type))) return undefined
          common = origin
        }
        return common ? { call: common.call, type: common.type } : undefined
      }
      return undefined
    }

    for (const fn of info.functions) {
      if (!fn.getReturnTypeNode() || valueType(fn.getReturnType()) !== localType || isInvalidDeclaration(fn)) continue
      const body = fn.getBody()
      if (!body) continue
      const returns = Node.isBlock(body)
        ? body.getDescendantsOfKind(SyntaxKind.ReturnStatement)
          .filter(statement => statement.getFirstAncestor(isFunction) === fn).map(statement => statement.getExpression())
        : [body]
      const origins = returns.map(expression => resultOrigin(expression))
      if (!origins.length || origins.some(origin => !origin || origin.field !== undefined)) continue
      if (!origins.every(origin => origin.type === origins[0].type)) continue
      for (const origin of origins) record(origin.type, 'callResults', origin.call)
    }
    for (const variable of info.variables) {
      if (!variable.getTypeNode() || !constDeclaration(variable) || valueType(variable.getType()) !== localType ||
          isInvalidDeclaration(variable) || info.mutated.has(receiverIdentity(variable.getNameNode()))) continue
      const origin = resultOrigin(variable.getInitializer())
      if (origin && origin.field === undefined) record(origin.type, 'callResults', origin.call)
    }

    function forwardedField(expression) {
      if (!expression) return undefined
      const node = unparenthesized(expression)
      if (Node.isBinaryExpression(node) && node.getOperatorToken().getKind() === SyntaxKind.QuestionQuestionToken) {
        return forwardedField(node.getLeft())
      }
      if (Node.isConditionalExpression(node)) {
        const left = forwardedField(node.getWhenTrue())
        const right = forwardedField(node.getWhenFalse())
        if (left && right) return left.field === right.field && left.receiver === right.receiver ? left : undefined
        if (left && node.getWhenFalse().getType().isUndefined()) return left
        if (right && node.getWhenTrue().getType().isUndefined()) return right
        return undefined
      }
      if (!Node.isPropertyAccessExpression(node)) return undefined
      const receiver = node.getExpression()
      if (valueType(receiver.getType()) !== localType) return undefined
      const identity = receiverIdentity(receiver)
      return identity ? { field: node.getName(), receiver: identity } : undefined
    }

    function forwardsLocal(expression) {
      const node = unparenthesized(expression)
      if (Node.isIdentifier(node) || Node.isPropertyAccessExpression(node)) return valueType(node.getType()) === localType
      if (!Node.isObjectLiteralExpression(node)) return false
      const properties = node.getProperties()
      if (properties.some(property => !Node.isPropertyAssignment(property))) return false
      let receiver
      for (const field of fields) {
        const property = properties.find(property => propertyName(property.getNameNode()) === field)
        const origin = property && forwardedField(property.getInitializer())
        if (!origin || origin.field !== field || (receiver && receiver !== origin.receiver)) return false
        receiver = origin.receiver
      }
      return Boolean(receiver)
    }

    function visitArgument(expression, call, depth = 0) {
      if (depth > 3) return
      const node = unparenthesized(expression)
      const contextual = checker.getContextualType(node)
      if (contextual && forwardsLocal(node)) record(valueType(contextual), 'requestTargets', call)
      if (!Node.isObjectLiteralExpression(node)) return
      for (const property of node.getProperties()) {
        if (Node.isPropertyAssignment(property)) visitArgument(property.getInitializer(), call, depth + 1)
      }
    }
    for (const call of info.calls) {
      if (isInvalidDeclaration(call) || !checker.getResolvedSignature(call)) continue
      for (const argument of call.getArguments()) visitArgument(argument, call)
    }
    return evidence
  }

  return {
    forLocal,
    forContract(evidence, type) {
      return evidence.get(type.compilerType) ?? { callResults: [], requestTargets: [] }
    },
  }
}
