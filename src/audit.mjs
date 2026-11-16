import fs from 'node:fs'
import path from 'node:path'
import { Node, Project, SyntaxKind, ts } from 'ts-morph'
import { compareShapes, createShapeReader, replacementFor } from './compare.mjs'
import { confidenceFor, nameWords, overlap } from './confidence.mjs'

const typeDeclarations = source => [
  ...source.getInterfaces(), ...source.getTypeAliases(),
]

function locationOf(node, root) {
  return {
    file: path.relative(root, node.getSourceFile().getFilePath()),
    line: node.getStartLineNumber(),
  }
}

function excluded(file, patterns) {
  return patterns.some(pattern => path.matchesGlob(file, pattern))
}

function inlineName(node) {
  const owner = node.getFirstAncestor(ancestor =>
    Node.isTypeAliasDeclaration(ancestor) || Node.isInterfaceDeclaration(ancestor) ||
    Node.isFunctionDeclaration(ancestor) || Node.isVariableDeclaration(ancestor))
  const member = node.getFirstAncestor(ancestor => Node.isPropertySignature(ancestor) || Node.isParameterDeclaration(ancestor))
  return [owner?.getName(), member?.getName(), 'inline'].filter(Boolean).join('.')
}

export function handwrittenCandidates(source) {
  const named = [
    ...source.getDescendantsOfKind(SyntaxKind.InterfaceDeclaration),
    ...source.getDescendantsOfKind(SyntaxKind.TypeAliasDeclaration),
  ].filter(declaration =>
    !declaration.getTypeParameters().length &&
    (Node.isInterfaceDeclaration(declaration)
      ? declaration.getExtends().length === 0
      : Node.isTypeLiteral(declaration.getTypeNode())))
  const namedNodes = new Set(named.filter(Node.isTypeAliasDeclaration).map(declaration => declaration.getTypeNode()))
  const inline = source.getDescendantsOfKind(SyntaxKind.TypeLiteral)
    .filter(node => !namedNodes.has(node))
    .filter(node => !node.getFirstAncestor(ancestor =>
      ((Node.isTypeAliasDeclaration(ancestor) || Node.isInterfaceDeclaration(ancestor)) &&
        ancestor.getTypeParameters().length > 0) ||
      (Node.isTypeAliasDeclaration(ancestor) && Node.isIntersectionTypeNode(ancestor.getTypeNode())) ||
      (Node.isInterfaceDeclaration(ancestor) && ancestor.getExtends().length > 0)))
  return [
    ...named.map(node => ({ node, type: node.getType(), name: node.getName(), kind: 'named' })),
    ...inline.map(node => ({ node, type: node.getType(), name: inlineName(node), kind: 'inline' })),
  ]
}

function inlineObjectDeclaration(type) {
  return type.getSymbol()?.getDeclarations().some(Node.isTypeLiteral) ?? false
}

export function contractCandidates(source) {
  const result = []
  function add(node, type, expression, rootName, depth, rootNode) {
    result.push({ node, type, expression, rootName, rootNode })
    if (depth >= 2 || !type.isObject() || type.isArray() || type.isReadonlyArray()) return
    for (const property of type.getProperties()) {
      const declaration = property.getDeclarations().find(Node.isPropertySignature)
      if (!declaration) continue
      const rawType = property.getTypeAtLocation(node)
      const nested = rawType.getNonNullableType()
      if (!inlineObjectDeclaration(nested)) continue
      const key = Node.isNumericLiteral(declaration.getNameNode())
        ? declaration.getNameNode().getText() : JSON.stringify(property.getName())
      const indexed = `${expression}[${key}]`
      const nextExpression = rawType.isNullable() ? `NonNullable<${indexed}>` : indexed
      add(declaration, nested, nextExpression, rootName, depth + 1, rootNode)
    }
  }
  for (const node of typeDeclarations(source)) {
    if (!node.isExported() || node.getTypeParameters().length) continue
    add(node, node.getType(), node.getName(), node.getName(), 0, node)
  }
  return result
}

function relevantDiagnostics(node, diagnostics) {
  const start = node.getStart()
  const end = node.getEnd()
  return diagnostics.filter(diagnostic => {
    const position = diagnostic.getStart()
    if (position === undefined) return true
    return position < end && position + (diagnostic.getLength() ?? 1) > start
  })
}

export function scanProject({ project, sources, contracts, root, name, minFields = 2, maxMatches = 5, diagnostics = [] }) {
  const rejected = { handwritten: {}, contracts: {} }
  const recordRejection = (side, reason) => {
    rejected[side][reason] = (rejected[side][reason] ?? 0) + 1
  }
  const diagnosticsByFile = new Map()
  for (const diagnostic of diagnostics) {
    const file = diagnostic.getSourceFile()?.getFilePath()
    if (!file) continue
    if (!diagnosticsByFile.has(file)) diagnosticsByFile.set(file, [])
    diagnosticsByFile.get(file).push(diagnostic)
  }
  function isInvalidDeclaration(node) {
    const fileDiagnostics = diagnosticsByFile.get(node.getSourceFile().getFilePath()) ?? []
    return fileDiagnostics.some(diagnostic => [2305, 2306, 2307, 2459].includes(diagnostic.getCode())) ||
      relevantDiagnostics(node, fileDiagnostics).length > 0
  }
  const contractPaths = new Set(contracts.map(source => source.getFilePath()))
  function isContractType(type) {
    const declarations = (type.getAliasSymbol() ?? type.getSymbol())?.getDeclarations() ?? []
    return declarations.length > 0 && declarations.every(declaration =>
      contractPaths.has(declaration.getSourceFile().getFilePath()) &&
      (Node.isTypeAliasDeclaration(declaration) || Node.isInterfaceDeclaration(declaration)) && declaration.isExported())
  }
  const reader = createShapeReader({ isInvalidDeclaration, isContractType })
  function readCandidate(candidate, side) {
    if (isInvalidDeclaration(candidate.node)) {
      recordRejection(side, 'typescript-diagnostic')
      return null
    }
    const shape = reader.read(candidate.type, candidate.node)
    const reason = shape.reason ?? (shape.properties.size < minFields ? 'too-few-fields' : null)
    if (reason) {
      recordRejection(side, reason)
      return null
    }
    return { ...candidate, shape }
  }
  const contractDeclarations = contracts.flatMap(contractCandidates)
  const generated = contractDeclarations.map(candidate => readCandidate(candidate, 'contracts')).filter(Boolean)
  const index = new Map()
  for (const contract of generated) {
    for (const field of contract.shape.properties.keys()) {
      if (!index.has(field)) index.set(field, [])
      index.get(field).push(contract)
    }
  }
  const declarations = sources.flatMap(handwrittenCandidates)
  const handwritten = declarations.map(candidate => readCandidate(candidate, 'handwritten')).filter(Boolean)
  const findings = []
  for (const local of handwritten) {
    const source = local.node.getSourceFile()
    const imports = source.getImportDeclarations().flatMap(declaration => declaration.getNamedImports())
    const importedSymbols = new Set(imports.flatMap(specifier => {
      const symbol = (specifier.getAliasNode() ?? specifier.getNameNode()).getSymbol()
      const resolved = symbol && (symbol.getFlags() & ts.SymbolFlags.Alias) ? symbol.getAliasedSymbol() : symbol
      return resolved ? [resolved.compilerSymbol] : []
    }))
    const importedWords = nameWords(imports.map(specifier => specifier.getName()).join(' '))
    const localWords = nameWords(local.name)
    const buckets = [...local.shape.properties.keys()].map(field => index.get(field) ?? [])
    const candidates = buckets.sort((a, b) => a.length - b.length)[0] ?? []
    const rawMatches = candidates.flatMap(contract => {
      const comparison = compareShapes(local.shape, contract.shape)
      if (!comparison) return []
      const resolvedImport = importedSymbols.has(contract.rootNode.getSymbol()?.compilerSymbol)
      const nameOverlap = overlap(localWords, nameWords(contract.rootName))
      const importOverlap = overlap(importedWords, nameWords(contract.rootName))
      return [{
        ...locationOf(contract.node, root),
        contract: contract.expression,
        kind: comparison.kind,
        omitted: comparison.omitted,
        replacement: replacementFor(contract.expression, comparison),
        evidence: { resolvedImport, nameOverlap, importOverlap },
        targetType: contract.type.compilerType,
      }]
    })
    const distinctTargets = new Set(rawMatches.map(match => match.targetType)).size
    const matches = rawMatches.map(({ targetType, ...match }) => {
      const confidence = confidenceFor({ kind: match.kind, fieldCount: local.shape.properties.size, distinctTargets, ...match.evidence })
      return { ...match, confidence }
    }).sort((a, b) => b.confidence.score - a.confidence.score || a.contract.localeCompare(b.contract) || a.file.localeCompare(b.file))
    if (!matches.length) continue
    const top = matches[0]
    findings.push({
      ...locationOf(local.node, root),
      name: local.name,
      declarationKind: local.kind,
      fields: [...local.shape.properties.keys()],
      relatedContractEvidence: top.evidence.resolvedImport || top.evidence.nameOverlap > 0 || top.evidence.importOverlap > 0,
      confidence: top.confidence,
      distinctTargets,
      totalMatches: matches.length,
      matches: matches.slice(0, maxMatches),
    })
  }
  findings.sort((a, b) => b.confidence.score - a.confidence.score || a.file.localeCompare(b.file) || a.line - b.line)
  const sourcePaths = new Set(sources.map(source => source.getFilePath()))
  const sourceDiagnostics = diagnostics.filter(diagnostic => sourcePaths.has(diagnostic.getSourceFile()?.getFilePath()))
  const globalDiagnostics = diagnostics.filter(diagnostic => !diagnostic.getSourceFile())
  if (globalDiagnostics.length) throw new Error(project.formatDiagnosticsWithColorAndContext(globalDiagnostics))
  return {
    name,
    typescriptVersion: ts.version,
    sourceFiles: sources.length,
    contractFiles: contracts.length,
    handwrittenCandidates: declarations.length,
    comparableHandwrittenCandidates: handwritten.length,
    contractCandidates: contractDeclarations.length,
    comparableContractCandidates: generated.length,
    sourceDiagnosticCount: sourceDiagnostics.length,
    sourceDiagnosticCodes: [...new Set(sourceDiagnostics.map(diagnostic => diagnostic.getCode()))].sort(),
    sourceDiagnostics: sourceDiagnostics.map(diagnostic => ({
      file: path.relative(root, diagnostic.getSourceFile().getFilePath()),
      line: diagnostic.getLineNumber(),
      code: diagnostic.getCode(),
      message: ts.flattenDiagnosticMessageText(diagnostic.compilerObject.messageText, '\n'),
    })),
    rejected,
    findings,
  }
}

export function auditProject(config, root) {
  const project = new Project({
    tsConfigFilePath: path.resolve(root, config.tsconfig),
    skipAddingFilesFromTsConfig: true,
  })
  const options = project.getCompilerOptions()
  if (!(options.strictNullChecks ?? options.strict ?? false)) {
    throw new Error(`${config.name}: strictNullChecks is required for nullability comparisons`)
  }
  const requestedSourceFiles = project.addSourceFilesAtPaths(config.sources.map(pattern => path.resolve(root, pattern)))
    .filter(source => !excluded(path.relative(root, source.getFilePath()), config.exclude ?? []))
  const contractPaths = [...new Set(fs.globSync(config.contracts, { cwd: root })
    .map(file => fs.realpathSync(path.resolve(root, file))))]
  const contractFiles = contractPaths.map(file => project.addSourceFileAtPath(file))
  const contractSet = new Set(contractPaths)
  const sourceFiles = requestedSourceFiles.filter(source => !contractSet.has(fs.realpathSync(source.getFilePath())))
  if (!sourceFiles.length || !contractFiles.length) throw new Error(`${config.name}: empty source or contract scope`)
  project.resolveSourceFileDependencies()
  const diagnostics = project.getPreEmitDiagnostics()
  return scanProject({ project, sources: sourceFiles, contracts: contractFiles, root, name: config.name,
    minFields: config.minFields, maxMatches: config.maxMatches, diagnostics })
}
