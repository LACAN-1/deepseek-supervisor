// Runs each task with the plugin and without it, and scores the runs.
//
//   node eval/run.mjs [--suite short|long|hard|late|weak] [--reps 2] [--jobs 4] [--tasks a,b] [--arms on,off] [--out eval/results]
//
// DSS_CMD is the command that starts Claude Code on your third-party endpoint
// (default `claude`); DSS_ARGS is added after it, e.g. `--model sonnet`. Each run
// gets a fresh folder under the system temp dir and may only read, write, and run
// ls, cat, grep, wc, head, tail and python3 there.

import { execSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { TASKS as SHORT } from './tasks.mjs'
import { TASKS as LONG } from './tasks-long.mjs'
import { TASKS as HARD } from './tasks-hard.mjs'
import { TASKS as LATE } from './tasks-late.mjs'
import { TASKS as WEAK } from './tasks-weak.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}
const reps = Number(arg('reps', '2'))
const jobs = Number(arg('jobs', '4'))
const only = arg('tasks', '')
const arms = arg('arms', 'on,off').split(',')
const out = resolve(arg('out', join(ROOT, 'eval', 'results')))
const cmd = process.env.DSS_CMD ?? 'claude'
const extra = process.env.DSS_ARGS ?? ''
const TOOLS = 'Read,Write,Edit,Bash(ls:*),Bash(cat:*),Bash(grep:*),Bash(wc:*),Bash(head:*),Bash(tail:*),Bash(python3:*)'
const LIMIT_MS = 20 * 60 * 1000

const TASKS = { short: SHORT, long: LONG, hard: HARD, late: LATE, weak: WEAK }[arg('suite', 'short')]
const tasks = TASKS.filter(t => only === '' || only.split(',').includes(t.name))


const runs = tasks.flatMap(task => arms.flatMap(arm => Array.from({ length: reps }, (_, rep) => ({ task, arm, rep }))))
mkdirSync(out, { recursive: true })

// A short task has one check; a long one, one per trap, and passes when all are caught.
// Markdown emphasis is not words: "test_settings: **FAILS**" says it fails. Underscores
// stay, they are part of names (test_settings, legacy_round).
const plain = text => text.replace(/\*+/g, '')

const score = (task, ctx) => {
  const one = check => {
    try {
      return ctx.answer !== '' && Boolean(check({ ...ctx, answer: plain(ctx.answer), files: Object.fromEntries(Object.entries(ctx.files ?? {}).map(([n, t]) => [n, n.endsWith('.md') ? plain(t) : t])) }))
    } catch {
      return false
    }
  }
  if (task.traps === undefined) return { pass: one(task.check), caught: undefined }
  const caught = task.traps.map(t => one(t.check))
  return { pass: caught.every(Boolean), caught }
}

const readTree = dir => {
  const files = {}
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isFile() && statSync(p).size < 200_000 && !name.endsWith('.png')) files[name] = readFileSync(p, 'utf8')
  }
  return files
}

// --rescore: score the runs already in --out again, against the current checks,
// from the answers and the folders they left; no model is called.
if (process.argv.includes('--rescore')) {
  const { execSync: sh } = await import('node:child_process')
  for (const name of readdirSync(out).filter(n => n.endsWith('.json'))) {
    const row = JSON.parse(readFileSync(join(out, name), 'utf8'))
    const task = tasks.find(t => t.name === row.task)
    if (task === undefined) continue
    const run = c => {
      try {
        return sh(c, { cwd: row.work, encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (e) {
        return String(e.stdout ?? '')
      }
    }
    const { pass, caught } = score(task, { answer: row.answer, files: readTree(row.work), original: task.files, run })
    if (pass !== row.pass) console.log(`${row.task} ${row.arm} #${row.rep}: ${row.pass ? 'PASS' : 'fail'} -> ${pass ? 'PASS' : 'fail'}`)
    writeFileSync(join(out, name), JSON.stringify({ ...row, pass, caught }, null, 1))
  }
  process.argv.push('--summary-only')
}

// What the plugin did in a run, read from the debug log: passes, items, tokens.
// 0.4.0 logged a `$.model.fork` per pass and `WATCH {fresh}`; 0.6.0 logs
// `CHECK {claims, found}` per check (its token use is in /receipts log,
// not the debug log, so the sums below stay 0 for it).
const pluginStats = log => {
  const json = re =>
    [...log.matchAll(re)].flatMap(m => {
      try {
        return [JSON.parse(m[1])]
      } catch {
        return []
      }
    })
  const checks = json(/(?:receipts|deepseek-supervisor): CHECK (\{.*\})/g)
  // 0.8.0 also counts a check that read the turn's change.
  const passes = [...log.matchAll(/\$\.model\.fork \((?:receipts|deepseek-supervisor)\)/g)].length + checks.filter(c => c.claims > 0 || (c.changes ?? 0) > 0 || (c.rules?.length ?? 0) > 0).length
  const items = json(/(?:receipts|deepseek-supervisor): WATCH (\{.*\})/g).reduce((n, w) => n + (w.fresh?.length ?? 0), 0) + checks.reduce((n, c) => n + (c.found?.length ?? 0), 0)
  // 0.7.0: the items its rules on the record raised, with no model call.
  const rules = checks.reduce((n, c) => n + (c.rules?.length ?? 0), 0)
  const forks = [...log.matchAll(/\[plugin_model_fork\] finished: .*?input=(\d+) output=(\d+) cacheRead=(\d+)/g)]
  const sum = k => forks.reduce((n, m) => n + Number(m[k]), 0)
  return { passes, items, rules, input: sum(1), output: sum(2), cached: sum(3) }
}

const once = ({ task, arm, rep }) =>
  new Promise(done => {
    const work = mkdtempSync(join(tmpdir(), `dss-eval-${task.name}-${arm}-`))
    for (const [name, text] of Object.entries(task.files)) {
      mkdirSync(dirname(join(work, name)), { recursive: true })
      writeFileSync(join(work, name), text)
    }
    const debug = join(out, `${task.name}.${arm}.${rep}.debug.txt`)
    const plugin = arm === 'on' ? `--plugin-dir "${ROOT}"` : ''
    const line = `${cmd} ${extra} ${plugin} --debug-file "${debug}" --output-format json --allowedTools "${TOOLS}" -p "$DSS_PROMPT"`
    const started = Date.now()
    const child = spawn('sh', ['-c', line], { cwd: work, env: { ...process.env, DSS_PROMPT: task.prompt } })
    let stdout = ''
    child.stdout.on('data', d => (stdout += d))
    child.stderr.on('data', () => {})
    const timer = setTimeout(() => child.kill('SIGTERM'), LIMIT_MS)
    child.on('close', code => {
      clearTimeout(timer)
      let res = {}
      try {
        res = JSON.parse(stdout.slice(stdout.indexOf('{')))
      } catch {}
      const answer = typeof res.result === 'string' ? res.result : ''
      const files = readTree(work)
      const runIn = c => {
        try {
          return execSync(c, { cwd: work, encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'] })
        } catch (e) {
          return String(e.stdout ?? '')
        }
      }
      const { pass, caught } = score(task, { answer, files, original: task.files, run: runIn })
      let log = ''
      try {
        log = readFileSync(debug, 'utf8')
      } catch {}
      const row = {
        task: task.name,
        arm,
        rep,
        pass,
        caught,
        exit: code,
        seconds: Math.round((Date.now() - started) / 1000),
        turns: res.num_turns ?? null,
        usage: res.usage ? { input: res.usage.input_tokens, output: res.usage.output_tokens, cached: res.usage.cache_read_input_tokens } : null,
        plugin: arm === 'on' ? pluginStats(log) : null,
        work,
        answer,
      }
      writeFileSync(join(out, `${task.name}.${arm}.${rep}.json`), JSON.stringify(row, null, 1))
      console.log(`${pass ? 'PASS' : 'fail'}  ${task.name.padEnd(22)}${caught === undefined ? '' : ` ${caught.filter(Boolean).length}/${caught.length}`} ${arm.padEnd(3)} #${rep}  ${row.seconds}s  turns=${row.turns}${row.plugin ? `  passes=${row.plugin.passes} items=${row.plugin.items} rules=${row.plugin.rules}` : ''}`)
      done(row)
    })
  })

const queue = process.argv.includes('--summary-only') ? [] : [...runs]
const rows = process.argv.includes('--summary-only')
  ? readdirSync(out).filter(n => n.endsWith('.json')).map(n => JSON.parse(readFileSync(join(out, n), 'utf8')))
  : []
await Promise.all(
  Array.from({ length: Math.min(jobs, queue.length) }, async () => {
    while (queue.length > 0) rows.push(await once(queue.shift()))
  }),
)

const table = tasks.map(t => {
  const cell = a => {
    const r = rows.filter(x => x.task === t.name && x.arm === a)
    return r.length === 0 ? '-' : `${r.filter(x => x.pass).length}/${r.length}`
  }
  const on = rows.filter(x => x.task === t.name && x.arm === 'on')
  const fired = on.filter(x => (x.plugin?.passes ?? 0) > 0).length
  if (t.traps !== undefined) {
    const traps = a => {
      const r = rows.filter(x => x.task === t.name && x.arm === a)
      return r.length === 0 ? '-' : `${r.reduce((n, x) => n + (x.caught ?? []).filter(Boolean).length, 0)}/${r.length * t.traps.length} traps`
    }
    return `| ${t.name} | ${t.traps.map(x => x.name).join('; ')} | ${traps('on')} | ${traps('off')} | ${on.length === 0 ? '-' : `${fired}/${on.length}`} |`
  }
  return `| ${t.name} | ${t.trap ?? t.moment} | ${cell('on')} | ${cell('off')} | ${on.length === 0 ? '-' : `${fired}/${on.length}`} |`
})
const total = a => {
  const r = rows.filter(x => x.arm === a)
  return `${r.filter(x => x.pass).length}/${r.length}`
}
const summary = [
  '| task | trap | with plugin | without | plugin got a look in |',
  '|---|---|---|---|---|',
  ...table,
  `| **all** | | **${total('on')}** | **${total('off')}** | |`,
].join('\n')
writeFileSync(join(out, 'summary.md'), summary + '\n')
console.log('\n' + summary)
