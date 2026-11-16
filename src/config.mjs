import fs from 'node:fs'
import path from 'node:path'

const defaultExclusions = [
  '**/node_modules/**', '**/*.d.ts', '**/*.gen.*', '**/*.generated.*',
  '**/*.test.*', '**/*.spec.*', '**/__tests__/**', '**/test/**', '**/dist/**',
]
const projectKeys = ['name', 'tsconfig', 'sources', 'contracts', 'exclude', 'minFields', 'maxMatches']

function object(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
}

function keys(value, allowed, label) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`${label}: unknown option ${key}`)
}

function string(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a nonempty string`)
  return value
}

function strings(value, label, allowEmpty = false) {
  if (!Array.isArray(value) || (!allowEmpty && !value.length)) throw new Error(`${label} must be ${allowEmpty ? 'an' : 'a nonempty'} array`)
  return value.map(item => string(item, label))
}

function integer(value, fallback, min, max, label) {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${label} must be an integer from ${min} to ${max}`)
  return value
}

export function normalizeConfig(config, directory) {
  object(config, 'config')
  keys(config, ['root', 'projects', ...projectKeys], 'config')
  const root = path.resolve(directory, config.root === undefined ? '.' : string(config.root, 'root'))
  let projects
  if (config.projects !== undefined) {
    if (projectKeys.some(key => config[key] !== undefined)) throw new Error('Use either projects or a single project, not both')
    if (!Array.isArray(config.projects) || !config.projects.length) throw new Error('projects must be a nonempty array')
    projects = config.projects
  } else {
    const { root: ignoredRoot, ...project } = config
    projects = [project]
  }
  const names = new Set()
  return { root, projects: projects.map((project, index) => {
    object(project, `projects[${index}]`)
    keys(project, projectKeys, `projects[${index}]`)
    const name = project.name ?? (projects.length === 1 ? 'default' : undefined)
    if (typeof name !== 'string' || !/^[a-zA-Z0-9._-]+$/.test(name)) throw new Error('Each project needs a simple name (letters, digits, dot, underscore, or dash)')
    if (names.has(name)) throw new Error(`Duplicate project name: ${name}`)
    names.add(name)
    return {
      name,
      tsconfig: string(project.tsconfig, `${name}.tsconfig`),
      sources: strings(project.sources, `${name}.sources`),
      contracts: strings(project.contracts, `${name}.contracts`),
      exclude: [...defaultExclusions, ...strings(project.exclude ?? [], `${name}.exclude`, true)],
      minFields: integer(project.minFields, 2, 2, 1000, `${name}.minFields`),
      maxMatches: integer(project.maxMatches, 5, 1, 100, `${name}.maxMatches`),
    }
  }) }
}

export function loadConfig(file) {
  const absolute = path.resolve(file)
  let config
  try {
    config = JSON.parse(fs.readFileSync(absolute, 'utf8'))
  } catch (error) {
    throw new Error(`Cannot read JSON config ${absolute}: ${error.message}`)
  }
  return normalizeConfig(config, path.dirname(absolute))
}
