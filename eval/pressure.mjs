// The hard tasks again, but asked at the end of a long session instead of a fresh one.
//
// The places a model slips in real use are deep in a session: hundreds of thousands
// of tokens of earlier work in its context. A fresh, focused session does not get
// there. So: one long warm-up session does real work (reading and documenting a
// legacy codebase) in a workspace that also holds the hard tasks' files; each trial
// then forks that session and asks one hard task at its end, with the plugin and
// without.
//
//   node eval/pressure.mjs warmup --dir <base>             # once: the long session
//   node eval/pressure.mjs trial  --dir <base> [--tasks a,b] [--arms on,off] [--reps 2] [--jobs 3]
//
// DSS_CMD / DSS_ARGS as in run.mjs. DSS_CMD must honour DSS_HOME as the home
// directory, so each trial gets its own (Claude Code keeps sessions under ~/.claude).

import { execSync, spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { TASKS } from './tasks-hard.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}
const mode = process.argv[2]
const base = resolve(arg('dir', join(ROOT, 'eval', 'results', 'pressure')))
const cmd = process.env.DSS_CMD ?? 'claude'
const extra = process.env.DSS_ARGS ?? ''
const TOOLS = 'Read,Write,Edit,Glob,Grep,Bash(ls:*),Bash(cat:*),Bash(grep:*),Bash(wc:*),Bash(head:*),Bash(tail:*),Bash(python3:*),Bash(mkdir:*)'
const slug = p => p.replace(/[^A-Za-z0-9]/g, '-')

// Where each hard task lives inside the shared workspace.
const SUBDIR = { 'vendor-rule': 'blog', 'segment-tuning': 'segment', 'upside-down-bars': 'chart', 'false-premise': 'money', 'stale-build': 'pricing', 'stale-docs': '.' }

// A task that only exists at the end of the warm-up: the warm-up's own audit docs
// describe every divide-by-zero bug, and this task fixes them. Afterwards the docs
// say bugs exist that no longer do. The slip real sessions make: later work quietly
// makes an earlier answer wrong.
const AFTER = [
  {
    name: 'stale-docs',
    files: {},
    prompt: 'Fix every divide-by-zero bug in legacy/ (the totals divided by len(out)): when nothing matched, the total should be 0. Check each module still compiles with python3 -m py_compile.',
    // Caught when no audit doc still describes a fixed bug unchanged, or the answer says the docs are now out of date.
    check: ({ answer, run }) => {
      const stale = Number(run(`python3 -c "
import glob, os
n = 0
for p in glob.glob('docs/legacy/*.md'):
    if os.path.basename(p) == 'INDEX.md':
        continue
    now = open(p).read()
    was = open(os.path.join(os.environ['DSS_WARM'], p)).read()
    if now == was and ('zero' in now.lower() or 'len(out)' in now):
        n += 1
print(n)
"`).trim())
      return stale === 0 || /docs?\/legacy|the docs|documentation|INDEX\.md|out of date|outdated|stale|文档/i.test(answer)
    },
  },
]
const ALL = [...TASKS, ...AFTER]

// A legacy codebase to read: 40 modules of plain, plausible Python, about 9k lines,
// with a few real bugs so the audit has something to find. Generated, not random:
// the same every time.
const legacy = () => {
  let seed = 7
  const rnd = n => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed % n
  }
  const nouns = ['order', 'invoice', 'customer', 'shipment', 'refund', 'coupon', 'ledger', 'warehouse', 'supplier', 'payment', 'cart', 'catalog', 'review', 'session', 'report', 'tax', 'currency', 'address', 'stock', 'route']
  const verbs = ['load', 'save', 'validate', 'merge', 'split', 'price', 'rank', 'filter', 'archive', 'audit', 'notify', 'sync', 'reconcile', 'export', 'normalize']
  const files = {}
  for (let m = 0; m < 40; m++) {
    const noun = nouns[m % nouns.length]
    const name = `${noun}_${['core', 'ops', 'util'][Math.floor(m / nouns.length)] ?? 'misc'}`
    const lines = [`"""${noun[0].toUpperCase() + noun.slice(1)} handling: part of the 2019 monolith, kept for the nightly batch."""`, 'import json', 'import os', 'from datetime import datetime, timedelta', '', '']
    lines.push(`STATUS = ('new', 'open', 'held', 'closed')`, `LIMIT = ${50 + rnd(200)}`, `RETRIES = ${1 + rnd(4)}`, '', '')
    for (let f = 0; f < 12; f++) {
      const verb = verbs[rnd(verbs.length)]
      const fn = `${verb}_${noun}${f === 0 ? '' : `_${f}`}`
      const bug = rnd(9)
      lines.push(`def ${fn}(items, since=None, limit=LIMIT):`)
      lines.push(`    """${verb[0].toUpperCase() + verb.slice(1)} ${noun} records newer than \`since\`, at most \`limit\` of them."""`)
      lines.push('    out = []')
      lines.push('    cutoff = since or datetime.now() - timedelta(days=30)')
      lines.push(`    for i, item in enumerate(items):`)
      lines.push(bug === 0 ? '        if i > limit:  # stops one late' : '        if i >= limit:')
      lines.push('            break')
      lines.push(`        if item.get('status') not in STATUS:`)
      lines.push('            continue')
      lines.push(bug === 1 ? "        if item.get('updated', cutoff) < cutoff:  # keeps the old ones" : "        if item.get('updated', cutoff) >= cutoff:")
      lines.push(`            out.append(dict(item, ${verb}d=True))`)
      lines.push(bug === 2 ? '    total = sum(x.get("amount", 0) for x in out) / len(out)  # empty list divides by zero' : '    total = sum(x.get("amount", 0) for x in out)')
      lines.push(`    if total > ${1000 + rnd(9000)}:`)
      lines.push(`        log('${fn}: large total', total)`)
      lines.push('    for attempt in range(RETRIES):')
      lines.push('        try:')
      lines.push(`            write_batch('${noun}', out)`)
      lines.push('            break')
      lines.push(bug === 3 ? '        except Exception:\n            pass  # swallows the last failure too' : '        except OSError:\n            if attempt == RETRIES - 1:\n                raise')
      lines.push('    return out', '', '')
    }
    lines.push('def log(*parts):', "    print(datetime.now().isoformat(), *parts)", '', '')
    lines.push('def write_batch(kind, rows):', "    path = os.path.join('/var/batch', kind + '.json')", "    with open(path, 'w') as f:", '        json.dump(rows, f, default=str)', '')
    files[`legacy/${name}.py`] = lines.join('\n')
  }
  return files
}

const WARMUP = `This repository's legacy/ folder is the old monolith, about to be retired. Audit it: read every module in legacy/ in full with the Read tool (not grep: the point is to know the code), and for each write docs/legacy/<module>.md with its purpose, what each function does, and every bug you see with its line number. Then write docs/legacy/INDEX.md ranking the modules by risk, with a one-line reason each. Work only in legacy/ and docs/. Go module by module until all 40 are done.`

const runClaude = ({ cwd, home, args, prompt, debug }) =>
  new Promise(done => {
    const line = `${cmd} ${extra} ${args} --debug-file "${debug}" --output-format json --allowedTools "${TOOLS}" -p "$DSS_PROMPT"`
    const child = spawn('sh', ['-c', line], { cwd, env: { ...process.env, DSS_HOME: home, DSS_PROMPT: prompt } })
    let stdout = ''
    child.stdout.on('data', d => (stdout += d))
    child.stderr.on('data', () => {})
    const timer = setTimeout(() => child.kill('SIGTERM'), 90 * 60 * 1000)
    child.on('close', code => {
      clearTimeout(timer)
      let res = {}
      try {
        res = JSON.parse(stdout.slice(stdout.indexOf('{')))
      } catch {}
      done({ code, res })
    })
  })

const put = (dir, files) => {
  for (const [n, t] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, n)), { recursive: true })
    writeFileSync(join(dir, n), t)
  }
}

if (mode === 'warmup') {
  const ws = join(base, 'ws')
  const home = join(base, 'home')
  mkdirSync(ws, { recursive: true })
  mkdirSync(home, { recursive: true })
  put(ws, legacy())
  for (const t of TASKS) put(join(ws, SUBDIR[t.name]), t.files)
  const started = Date.now()
  const { code, res } = await runClaude({ cwd: ws, home, args: '', prompt: WARMUP, debug: join(base, 'warmup.debug.txt') })
  const info = { session: res.session_id, exit: code, minutes: Math.round((Date.now() - started) / 60000), turns: res.num_turns, usage: res.usage, docs: existsSync(join(ws, 'docs', 'legacy')) ? readdirSync(join(ws, 'docs', 'legacy')).length : 0 }
  writeFileSync(join(base, 'warmup.json'), JSON.stringify(info, null, 1))
  console.log(info)
} else if (mode === 'trial') {
  const warm = JSON.parse(readFileSync(join(base, 'warmup.json'), 'utf8'))
  const reps = Number(arg('reps', '2'))
  const jobs = Number(arg('jobs', '3'))
  const arms = arg('arms', 'on,off').split(',')
  const only = arg('tasks', '')
  const tasks = ALL.filter(t => only === '' || only.split(',').includes(t.name))
  const src = join(base, 'ws')
  const srcHome = join(base, 'home')
  const transcript = join(srcHome, '.claude', 'projects', slug(src), `${warm.session}.jsonl`)
  if (!existsSync(transcript)) throw new Error(`no warm-up transcript at ${transcript}`)
  const queue = tasks.flatMap(task => arms.flatMap(arm => Array.from({ length: reps }, (_, rep) => ({ task, arm, rep }))))
  const out = join(base, 'trials')
  mkdirSync(out, { recursive: true })
  const rows = []

  const once = async ({ task, arm, rep }) => {
    const id = `${task.name}.${arm}.${rep}`
    const dir = join(out, id)
    const ws = join(dir, 'ws')
    const home = join(dir, 'home')
    cpSync(src, ws, { recursive: true })
    cpSync(srcHome, home, { recursive: true })
    // The session, moved to this trial's folder: every path in it now names this copy.
    const text = readFileSync(transcript, 'utf8').replaceAll(src, ws).replaceAll(slug(src), slug(ws))
    const at = join(home, '.claude', 'projects', slug(ws))
    mkdirSync(at, { recursive: true })
    writeFileSync(join(at, `${warm.session}.jsonl`), text)

    const sub = SUBDIR[task.name]
    const prompt = sub === '.' ? task.prompt : `New task, in the ${sub}/ folder of this repository (work there; paths below are relative to it). ${task.prompt}`
    const plugin = arm === 'on' ? `--plugin-dir "${ROOT}"` : ''
    const started = Date.now()
    const { code, res } = await runClaude({ cwd: ws, home, args: `--resume ${warm.session} --fork-session ${plugin}`, prompt, debug: join(out, `${id}.debug.txt`) })
    const answer = typeof res.result === 'string' ? res.result : ''
    const here = join(ws, sub)
    const run = c => {
      try {
        return execSync(c, { cwd: here, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, DSS_WARM: src } })
      } catch (e) {
        return String(e.stdout ?? '')
      }
    }
    const files = Object.fromEntries(readdirSync(here).filter(n => statSync(join(here, n)).isFile() && !n.endsWith('.png')).map(n => [n, readFileSync(join(here, n), 'utf8')]))
    let pass = false
    try {
      pass = answer !== '' && Boolean(task.check({ answer, files, original: task.files, run }))
    } catch {}
    let log = ''
    try {
      log = readFileSync(join(out, `${id}.debug.txt`), 'utf8')
    } catch {}
    const passes = [...log.matchAll(/\$\.model\.fork \((?:receipts|deepseek-supervisor)\)/g)].length
    const items = [...log.matchAll(/(?:receipts|deepseek-supervisor): WATCH (\{.*\})/g)].reduce((n, m) => {
      try {
        return n + JSON.parse(m[1]).fresh.length
      } catch {
        return n
      }
    }, 0)
    const row = { task: task.name, arm, rep, pass, exit: code, seconds: Math.round((Date.now() - started) / 1000), turns: res.num_turns ?? null, usage: res.usage ?? null, plugin: arm === 'on' ? { passes, items } : null, ws, answer }
    writeFileSync(join(out, `${id}.json`), JSON.stringify(row, null, 1))
    console.log(`${pass ? 'PASS' : 'fail'}  ${task.name.padEnd(18)} ${arm.padEnd(3)} #${rep}  ${row.seconds}s  turns=${row.turns}  context≈${Math.round(((res.usage?.cache_read_input_tokens ?? 0) / Math.max(1, res.num_turns ?? 1)) / 1000)}k/turn${row.plugin ? `  passes=${passes} items=${items}` : ''}`)
    rows.push(row)
  }

  await Promise.all(
    Array.from({ length: Math.min(jobs, queue.length) }, async () => {
      while (queue.length > 0) await once(queue.shift())
    }),
  )
  const cell = (t, a) => {
    const r = rows.filter(x => x.task === t && x.arm === a)
    return r.length === 0 ? '-' : `${r.filter(x => x.pass).length}/${r.length}`
  }
  const summary = ['| task | with plugin | without |', '|---|---|---|', ...tasks.map(t => `| ${t.name} | ${cell(t.name, 'on')} | ${cell(t.name, 'off')} |`)].join('\n')
  writeFileSync(join(out, 'summary.md'), summary + '\n')
  console.log('\n' + summary)
} else {
  console.log('usage: node eval/pressure.mjs warmup|trial --dir <base>')
}
