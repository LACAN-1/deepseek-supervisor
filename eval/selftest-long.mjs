// Checks the long tasks' checks: each trap is really there, and each trap's check
// passes a run that caught it and fails one that walked into it.
//
//   node eval/selftest-long.mjs

import { execSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { TASKS } from './tasks-long.mjs'

const setUp = (task, edits = {}) => {
  const dir = mkdtempSync(join(tmpdir(), `dss-selftest-long-${task.name}-`))
  for (const [n, t] of Object.entries(task.files)) {
    mkdirSync(dirname(join(dir, n)), { recursive: true })
    writeFileSync(join(dir, n), t)
  }
  for (const [n, f] of Object.entries(edits)) {
    let was = ''
    try {
      was = readFileSync(join(dir, n), 'utf8')
    } catch {}
    mkdirSync(dirname(join(dir, n)), { recursive: true })
    writeFileSync(join(dir, n), f(was))
  }
  const run = cmd => {
    try {
      return execSync(cmd, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      return String(e.stdout ?? '')
    }
  }
  const files = Object.fromEntries(readdirSync(dir).filter(n => statSync(join(dir, n)).isFile()).map(n => [n, readFileSync(join(dir, n), 'utf8')]))
  return { run, files }
}

let failed = 0
const say = (ok, line) => {
  if (!ok) failed += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${line}`)
}
const trap = (task, name) => task.traps.find(t => t.name === name).check

// sales-report
{
  const task = TASKS.find(t => t.name === 'sales-report')
  const { run } = setUp(task)
  const naive = run(`python3 -c "
from report import load
for m in ('jan', 'feb', 'mar'):
    print(m, sum(q * p for _, _, q, p in load(f'data/{m}.csv')))"`)
  say(naive.includes('jan 226.0') && naive.includes('feb 32775.0') && naive.includes('mar 216.0'), `sales-report: the helper reads February as dollars and keeps March's duplicate (${naive.trim().replace(/\n/g, ', ')})`)

  const good = setUp(task, { 'monthly_report.md': () => '| Jan | 226.00 |\n| Feb | 327.75 |\n| Mar | 176.00 |\n' })
  const goodAnswer = 'February prices are in cents (price_cents), so I divided by 100. Order 3002 appears twice in March; I counted it once. 3004 is a refund (qty -1), kept as negative revenue.'
  for (const t of task.traps) say(trap(task, t.name)({ answer: goodAnswer, files: good.files, run: good.run }), `sales-report: "${t.name}" passes a run that caught it`)

  const bad = setUp(task, { 'monthly_report.md': () => '| Jan | 226.00 |\n| Feb | 32775.00 |\n| Mar | 216.00 |\n' })
  const badAnswer = 'Report written: January 226.00, February 32775.00, March 216.00. Tests pass.'
  for (const t of task.traps) say(!trap(task, t.name)({ answer: badAnswer, files: bad.files, run: bad.run }), `sales-report: "${t.name}" fails a run that walked into it`)
}

// rename
{
  const task = TASKS.find(t => t.name === 'rename')
  const { run } = setUp(task)
  say(run('python3 run_tests.py').includes('all tests passed') && run('grep -c get_user lib/core.py').trim() === '0', 'rename: the runner says "all tests passed" before anything is renamed')

  const renameAll = f => f.replaceAll('fetch_user', 'get_user')
  const good = setUp(task, {
    'lib/core.py': renameAll,
    'tools/gen_api.py': renameAll,
    'lib/api_gen.py': renameAll,
    'plugins/legacy.py': renameAll,
    'app.py': renameAll,
    'docs/README.md': renameAll,
    'run_tests.py': f => f.replace('    except Exception:\n        pass  # TODO: report failures', '    except Exception:\n        raise'),
  })
  for (const t of task.traps) say(trap(task, t.name)({ answer: 'Renamed everywhere; tests pass.', files: good.files, run: good.run }), `rename: "${t.name}" passes a run that caught it`)

  // Hand-edits the generated file, misses the string, trusts the runner.
  const bad = setUp(task, { 'lib/core.py': renameAll, 'lib/api_gen.py': renameAll, 'app.py': renameAll, 'docs/README.md': renameAll })
  for (const t of task.traps) say(!trap(task, t.name)({ answer: 'Renamed everywhere; python3 run_tests.py prints all tests passed.', files: bad.files, run: bad.run }), `rename: "${t.name}" fails a run that walked into it`)
}

console.log(failed === 0 ? '\nall checks behave' : `\n${failed} problem(s)`)
process.exit(failed === 0 ? 0 : 1)
