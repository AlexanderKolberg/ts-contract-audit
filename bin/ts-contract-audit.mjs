#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { loadConfig } from '../src/config.mjs'
import { CONFIDENCE_MODEL } from '../src/confidence.mjs'
import { filterReport, renderMarkdown, renderText } from '../src/report.mjs'

const help = `Usage: ts-contract-audit [options]

Find handwritten TypeScript shapes matching generated contracts.
Advisory only: scores are heuristics, not probabilities. No automatic fixes.

  --config <file>         JSON config (default: ts-contract-audit.json)
  --project <name>        Audit one configured project
  --min-confidence <n>    Show scores >= n, from 0 to 100 (default: 0)
  --format <format>       text, json, or markdown (default: text)
  --limit <n>             Sites per project in text/Markdown (default: 20)
  --output <file>         Write a new file; refuses to overwrite existing files
  --quiet                Hide progress on stderr
  --version              Print version
  --help                 Show this help

JSON includes all sites above the threshold and configured match alternatives.
Exit 0 means the audit ran, not that application types are correct.
`

function numberOption(value, min, max, label) {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) {
    throw new Error(`${label} must be an integer from ${min} to ${max}`)
  }
  return Number(value)
}

function main() {
  const { values } = parseArgs({ options: {
    config: { type: 'string', default: 'ts-contract-audit.json' },
    project: { type: 'string' },
    'min-confidence': { type: 'string', default: '0' },
    format: { type: 'string', default: 'text' },
    limit: { type: 'string', default: '20' },
    output: { type: 'string' },
    quiet: { type: 'boolean', default: false },
    version: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  } })
  if (values.help) return process.stdout.write(help)
  const packageInfo = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  if (values.version) return process.stdout.write(`${packageInfo.version}\n`)
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node.js 24 or newer is required')
  if (!['text', 'json', 'markdown'].includes(values.format)) throw new Error('--format must be text, json, or markdown')
  const minConfidence = numberOption(values['min-confidence'], 0, 100, '--min-confidence')
  const limit = numberOption(values.limit, 1, 100000, '--limit')
  const output = values.output && values.output !== '-' ? path.resolve(values.output) : null
  if (output && fs.existsSync(output)) throw new Error(`Refusing to overwrite ${output}`)
  const config = loadConfig(values.config)
  const selected = values.project ? config.projects.filter(project => project.name === values.project) : config.projects
  if (!selected.length) throw new Error(`Unknown project: ${values.project}`)
  const started = Date.now()
  const projects = selected.map(project => {
    if (!values.quiet) process.stderr.write(`Auditing ${project.name}...\n`)
    let json
    try {
      json = execFileSync(process.execPath, ['--max-old-space-size=6144', fileURLToPath(new URL('../src/worker.mjs', import.meta.url))], {
        input: JSON.stringify({ project, root: config.root }),
        encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (error) {
      throw new Error(`${project.name}: ${error.stderr?.trim() || error.message}`)
    }
    return JSON.parse(json)
  })
  const report = filterReport({
    schemaVersion: 1, toolVersion: packageInfo.version,
    confidenceModel: CONFIDENCE_MODEL, advisory: true,
    generatedAt: new Date().toISOString(), elapsedSeconds: (Date.now() - started) / 1000,
    root: config.root, configuration: { ...config, projects: selected }, projects,
  }, minConfidence)
  const content = values.format === 'json' ? `${JSON.stringify(report, null, 2)}\n`
    : values.format === 'markdown' ? renderMarkdown(report, limit) : renderText(report, limit)
  if (output) {
    fs.writeFileSync(output, content, { flag: 'wx' })
    if (!values.quiet) process.stderr.write(`Wrote ${output}\n`)
  } else {
    process.stdout.write(content)
  }
}

try {
  main()
} catch (error) {
  process.stderr.write(`ts-contract-audit: ${error.message}\n`)
  process.exitCode = 1
}
