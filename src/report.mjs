export function filterReport(report, minConfidence) {
  return {
    ...report,
    minConfidence,
    projects: report.projects.map(project => ({
      ...project,
      totalFindingCount: project.findings.length,
      findings: project.findings.filter(finding => finding.confidence.score >= minConfidence),
    })),
  }
}

export function renderText(report, limit = 20) {
  const lines = ['ts-contract-audit — advisory matches', 'Scores are heuristics, not probabilities or approval to replace a type.', '']
  for (const project of report.projects) {
    lines.push(`${project.name}: ${project.findings.length}/${project.totalFindingCount} sites at confidence >= ${report.minConfidence}; ${project.sourceFiles} source files; ${project.sourceDiagnosticCount} source diagnostics`)
    for (const finding of project.findings.slice(0, limit)) {
      const match = finding.matches[0]
      lines.push(
        `  ${finding.confidence.score}/100 ${finding.confidence.level} ${finding.file}:${finding.line} ${finding.name.replace(/\s+/g, ' ')}`,
        `    ${match.replacement}`,
        `    ${finding.confidence.reasons.map(reason => `${reason.points >= 0 ? '+' : ''}${reason.points} ${reason.code}`).join('; ')}`,
        `    ${finding.distinctTargets} distinct matching types; contract: ${match.file}:${match.line}`,
      )
    }
    if (project.findings.length > limit) lines.push(`  ${project.findings.length - limit} more sites; use --limit or --format json.`)
    if (project.sourceDiagnosticCount) lines.push('  Source diagnostics are included in JSON. This is not a clean application typecheck.')
    lines.push('')
  }
  lines.push('Review ownership, imports, and consumers before making changes. No fixes were applied.')
  return `${lines.join('\n')}\n`
}

function safe(value) {
  return String(value).replace(/[\r\n]+/g, ' ').replace(/[<>&`]/g, character => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '`': '&#96;' })[character])
}

function code(value) {
  const content = String(value).replace(/[\r\n]+/g, ' ')
  const delimiter = '`'.repeat(Math.max(0, ...(content.match(/`+/g) ?? []).map(run => run.length)) + 1)
  return `${delimiter} ${content} ${delimiter}`
}

export function renderMarkdown(report, limit = 20) {
  const lines = ['# Type contract audit', '', '**Advisory only.** Confidence scores are heuristics, not probabilities or replacement approvals.', '']
  for (const project of report.projects) {
    lines.push(`## ${safe(project.name)}`, '',
      `- Matching sites: ${project.findings.length}/${project.totalFindingCount} at confidence ≥ ${report.minConfidence}.`,
      `- Source files: ${project.sourceFiles}; contract files: ${project.contractFiles}.`,
      `- Comparable handwritten shapes: ${project.comparableHandwrittenCandidates}/${project.handwrittenCandidates}.`,
      `- Source diagnostics: ${project.sourceDiagnosticCount}; compiler: ${project.typescriptVersion}.`, '',
      'Skipped handwritten shapes:', '',
      ...Object.entries(project.rejected.handwritten).map(([reason, count]) => `- ${safe(reason)}: ${count}`), '')
    for (const finding of project.findings.slice(0, limit)) {
      lines.push(`### ${finding.confidence.score}/100 ${finding.confidence.level}: ${safe(finding.name)}`, '',
        `${code(`${finding.file}:${finding.line}`)} — ${finding.fields.length} fields; ${finding.distinctTargets} distinct matching types.`, '')
      for (const match of finding.matches.slice(0, 3)) {
        lines.push(`- **${match.confidence.score}/100, ${match.kind}:** ${code(match.replacement)}`,
          `  - Contract: ${code(`${match.file}:${match.line}`)}`)
      }
      lines.push('', ...finding.confidence.reasons.map(reason => `- ${reason.points >= 0 ? '+' : ''}${reason.points}: ${safe(reason.message)}`), '')
    }
    if (project.findings.length > limit) lines.push(`${project.findings.length - limit} more sites; increase --limit or use JSON.`, '')
  }
  lines.push('Review ownership and exports before changing code. Run your application checks after any refactor. No fixes were applied.', '')
  return lines.join('\n')
}
