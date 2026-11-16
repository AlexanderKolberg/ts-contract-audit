import fs from 'node:fs'
import { auditProject } from './audit.mjs'

try {
  const { project, root } = JSON.parse(fs.readFileSync(0, 'utf8'))
  process.stdout.write(JSON.stringify(auditProject(project, root)))
} catch (error) {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
}
