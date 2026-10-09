import { base, claimsOf, clip, leaves, squash } from './prompt'

// Rules, not a model. The session's own tool calls say what was run, in what order,
// and how it ended; the model's words say what it believes. Where the two disagree
// about tests and builds, or about which files were touched, code can tell without
// asking anyone, at no cost, on any machine, and cannot make the evidence up. These
// are the slips that cost a person most in a long session: "tests pass" said about
// code changed since, or about a run that failed, or about no run at all.

type Use = { tool: string; input: unknown; text?: string; result?: unknown; isError?: true }
type Row = { role: string; text: string; toolUses?: readonly Use[] }

// A command whose exit says whether the work holds: tests, builds, type checks,
// linters, a test file run directly. Read at the head of each piece of a command
// line, so `grep unittest a.py` or `pip install pytest` is no run of the tests.
const RUNNER = /^(?:(?:sudo|time|nice|timeout\s+\S+|env\s+\S+=\S*|\w+=\S*|uv run|poetry run|pipenv run|hatch run|npx|pnpm exec|bunx|python3?\s+-m|py\s+-m)\s+)*/
const CHECK =
  /^(?:pytest|py\.test|unittest|nose2|tox|nox|jest|vitest|mocha|ava|rspec|phpunit|ctest|tsc|mypy|pyright|ruff|flake8|pylint|eslint|go (?:test|build|vet)|cargo (?:test|build|check|clippy)|(?:npm|pnpm|yarn|bun) (?:run )?(?:test|build|lint|check|typecheck)|deno test|bun test|node --test|dotnet (?:test|build)|swift (?:test|build)|mvn|gradle|\.\/gradlew|make|bazel test|claude plugin test|python3?\s+(?:[\w./-]*\/)?(?:test_[\w-]*|[\w-]*_test|tests?)\.py)(?=\s|$)/
export const isCheckCommand = (command: string) =>
  command
    .split(/&&|\|\||[;|\n]/)
    .map(p => p.trim().replace(RUNNER, ''))
    .some(p => CHECK.test(p))

// How a run says it failed, whatever pipe hid its exit code.
const FAILED =
  /\bFAIL(?:ED)?\b|\b[1-9]\d* (?:failed|failing|errors?)\b|\berror TS\d+|\berror\[E\d+\]|\bexit(?:=| code:? ?)[1-9]|Traceback \(most recent call last\)|\bAssertionError\b|\bcommand not found\b|^\s*✖ [1-9]/im

// A claim that the tests, the build or a check came out right: both what and how.
const CHECK_CLAIM = /测试|单测|用例|编译|构建|类型检查|\btests?\b|\bspecs?\b|\bbuild(?:s|ing)?\b|\bcompiles?\b|\btype ?checks?\b|\blint(?:s|er)?\b|\bci\b|\bsuite\b/i
const PASSED = /\bpass(?:es|ed|ing)?\b|\bgreen\b|\bsucce(?:ed|eds|eded|ssful(?:ly)?)\b|\bcleanly\b|\bOK\b|\bworks?\b|通过|跑通|全绿|绿了|成功|无报错|没有报错/i
// A plan, a hope or an honest "not yet" is no claim.
const NOT_A_CLAIM =
  /\b(?:will|going to|let me|let's|i'll|next|then i|should|need to|try(?:ing)? to|once|after (?:i|we)|if|not|n't|no longer|fail(?:s|ed|ing|ure)?|until)\b|将|稍后|接下来|然后|待会|需要|准备|计划|打算|让我|我来|下一步|如果|等到|等待|没|未|不|失败|报错/i
// Saying a file was changed.
const CHANGED = /\b(?:updated|changed|modified|edited|bumped|added (?:it )?to|wrote|rewrote|fixed (?:it )?in|patched)\b|修改了|更新了|改了|改好了|写入了|写进|加到了|已更新|已修改/i
const FILE = /(?<![\w.-])[~/]?(?:[\w.-]+\/)*[\w-]+\.(?:py|js|mjs|cjs|ts|tsx|jsx|json|toml|ya?ml|cfg|ini|txt|md|go|rs|java|kt|rb|php|c|cc|cpp|h|hpp|cs|swift|sh|sql|html|css|lock)\b/g
// Names of libraries, not files: "updated the Node.js handler".
const LIBRARY = /^(?:node|vue|next|nuxt|react|three|d3|chart|express|ember|backbone|socket\.io|moment)\.js$/
// What a person reads, not what runs: an edit to it leaves the tests as they were.
const PROSE = /\.(?:md|markdown|txt|rst|adoc)$|(?:^|\/)(?:NOTES|CHANGELOG|README|LICENSE|TODO)[^/]*$/i

export type CheckRun = { at: number; command: string; ok: boolean; line: string }

export type Evidence = {
  runs: CheckRun[]
  /** Each edit's position and file. */
  edits: { at: number; path: string }[]
  /** Positions where a subagent ran: what it ran is not in this transcript. */
  blind: number[]
  /** Every basename any tool call or result names. */
  named: Set<string>
  /** For each claim, the position it was said at: the tool calls before it. */
  saidAt: Map<string, number>
}

const commandOf = (u: Use) => {
  const input = (u.input ?? {}) as Record<string, unknown>
  return typeof input.command === 'string' ? input.command : ''
}

const firstLine = (s: string, re: RegExp) => s.split('\n').find(l => re.test(l)) ?? ''

// The session's main loop as a sequence of tool calls, each with its position; a
// row's text is said before the row's own tool calls run.
export const evidenceOf = (rows: readonly Row[]): Evidence => {
  const ev: Evidence = { runs: [], edits: [], blind: [], named: new Set(), saidAt: new Map() }
  let at = 0
  for (const r of rows) {
    if (r.role !== 'assistant') continue
    for (const c of claimsOf(r.text)) ev.saidAt.set(c, at)
    for (const u of r.toolUses ?? []) {
      const input = (u.input ?? {}) as Record<string, unknown>
      const out = `${u.text ?? ''}\n${leaves(u.result).join('\n')}`
      for (const s of [...leaves(input), out]) for (const m of s.matchAll(FILE)) ev.named.add(base(m[0]).toLowerCase())
      if ((u.tool === 'Write' || u.tool === 'Edit' || u.tool === 'MultiEdit' || u.tool === 'NotebookEdit') && typeof (input.file_path ?? input.notebook_path) === 'string')
        ev.edits.push({ at, path: String(input.file_path ?? input.notebook_path) })
      if (u.tool === 'Agent' || u.tool === 'Task') ev.blind.push(at)
      const command = commandOf(u)
      if (u.tool === 'Bash' && isCheckCommand(command)) {
        const ok = u.isError !== true && !FAILED.test(out)
        ev.runs.push({ at, command: clip(squash(command), 200), ok, line: ok ? '' : clip(squash(firstLine(out, FAILED) || out.split('\n')[0] || ''), 160) })
      }
      at += 1
    }
  }
  return ev
}

export type Finding = {
  kind: 'failed-check' | 'stale-check' | 'no-check' | 'untouched'
  /** What is actually so, one plain sentence. */
  what: string
  /** The model's own words. */
  quote: string
  /** What settles it, as the note shows it. */
  probe: string
  /** The model's own command, rerun in a copy where there is one; '' when none. */
  recheck: string
}

const isCode = (path: string) => !PROSE.test(path)

/**
 * What the claims say that the session's own record contradicts. A claim is held
 * against what had happened when it was said, never against what came later.
 */
export const contradictions = (ev: Evidence, claims: readonly string[]): Finding[] => {
  const found: Finding[] = []
  for (const quote of claims) {
    if (NOT_A_CLAIM.test(quote)) continue
    const at = ev.saidAt.get(quote) ?? Number.MAX_SAFE_INTEGER
    // A subagent ran somewhere before the claim: what it ran is not here to hold the claim to.
    const isBlind = ev.blind.some(b => b < at)

    if (CHECK_CLAIM.test(quote) && PASSED.test(quote) && !isBlind) {
      const runs = ev.runs.filter(r => r.at < at)
      const last = runs.at(-1)
      const lastEdit = ev.edits.filter(e => e.at < at && isCode(e.path)).at(-1)
      if (last === undefined) {
        found.push({ kind: 'no-check', what: 'No test, build or check command has run in this session, yet the work is said to pass.', quote, probe: 'Run the project\'s tests', recheck: '' })
        continue
      }
      if (!last.ok) {
        found.push({ kind: 'failed-check', what: `The last check run failed (\`${last.command}\`: ${last.line || 'it reported a failure'}), and none has passed since.`, quote, probe: `Run ${last.command}`, recheck: last.command })
        continue
      }
      if (lastEdit !== undefined && lastEdit.at > last.at) {
        found.push({ kind: 'stale-check', what: `${base(lastEdit.path)} was edited after the last passing check (\`${last.command}\`), so the pass is about code that has changed since.`, quote, probe: `Run ${last.command}`, recheck: last.command })
        continue
      }
    }

    if (CHANGED.test(quote)) {
      for (const m of quote.matchAll(FILE)) {
        const name = base(m[0]).toLowerCase()
        if (!ev.named.has(name) && !LIBRARY.test(name)) {
          found.push({ kind: 'untouched', what: `${base(m[0])} is said to be changed, but no tool call touched or even named it.`, quote, probe: `Read ${m[0]}`, recheck: '' })
          break
        }
      }
    }
  }
  return found
}

/**
 * Whether the record now settles an item a rule raised: a check that passed after
 * the last edit to code, or the file named at last. The record, never the model's
 * say-so; on a machine with no sandbox this is how such an item closes.
 */
export const settledBy = (ev: Evidence, kind: Finding['kind'], probe: string): string | undefined => {
  if (kind === 'untouched') {
    const name = base(probe.replace(/^Read /, '')).toLowerCase()
    return ev.named.has(name) ? `${name} was touched since` : undefined
  }
  const last = ev.runs.at(-1)
  const lastEdit = ev.edits.filter(e => isCode(e.path)).at(-1)
  if (last === undefined || !last.ok) return undefined
  if (lastEdit !== undefined && lastEdit.at > last.at) return undefined
  return `\`${last.command}\` passed after the last edit`
}
