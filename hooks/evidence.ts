import { base, claimsOf, clip, leaves, squash } from './prompt'

// Rules, not a model. The session's own tool calls say what was run, in what order,
// and how it ended; the model's words say what it believes. Where the two disagree,
// code can tell without asking anyone, at no cost, on any machine, and cannot make
// the evidence up. Each rule is one way a weaker model goes wrong in a long session,
// costing the person quality (a pass claimed about code changed since, a test bent to
// fit the bug, a "don't" ignored) or time (the same failing run repeated, an edit
// retried against text that is not in the file).

type Use = { tool: string; input: unknown; text?: string; result?: unknown; isError?: true }
type Row = { role: string; text: string; toolUses?: readonly Use[] }

// A command whose exit says whether the work holds: tests, builds, type checks,
// linters, a test file run directly. Read at the head of each piece of a command
// line, so `grep unittest a.py` or `pip install pytest` is no run of the tests.
const PYTHON = String.raw`python3?(?:\.\d+)?(?:\s+-[A-Za-z]+|\s+-[XW]\s*\S+)*?`
const RUNNER = new RegExp(String.raw`^(?:(?:sudo|time|nice|timeout\s+\S+|env\s+\S+=\S*|\w+=\S*|uv run|poetry run|pipenv run|hatch run|npx|pnpm exec|bunx|${PYTHON}\s+-m|py\s+-m|coverage\s+run(?:\s+--?[\w-]+(?:=\S+)?)*?\s+-m)\s+)*`)
const CHECK =
  /^(?:pytest|py\.test|unittest|nose2|tox|nox|jest|vitest|mocha|ava|rspec|phpunit|ctest|tsc|mypy|pyright|ruff|flake8|pylint|eslint|go (?:test|build|vet)|cargo (?:test|build|check|clippy)|(?:npm|pnpm|yarn|bun) (?:run )?(?:test|build|lint|check|typecheck)|deno test|bun test|node --test|dotnet (?:test|build)|swift (?:test|build)|mvn|gradle|\.\/gradlew|make|bazel test|claude plugin test|python3?(?:\.\d+)?(?:\s+-[A-Za-z]+)*\s+(?:[\w./-]*\/)?(?:test_[\w-]*|[\w-]*_test|tests?)\.py|(?:(?:ba)?sh\s+|\.\/)[\w./-]*(?:run[_-]?)?tests?[\w-]*\.sh)(?=\s|$)/
const pieces = (command: string) => command.split(/&&|\|\||[;|\n]/).map(p => p.trim().replace(RUNNER, ''))
export const isCheckCommand = (command: string) => pieces(command).some(p => CHECK.test(p))

// A command that never ran: refused by the person's permissions or a hook. It is no
// evidence of anything, and its message often echoes the command itself.
const DENIED = /\brequires? approval\b|contains multiple operations|permission to use .{0,80} (?:was|has been) denied|was denied by|blocked by (?:a |the )?hook|<tool_use_error>/i
// A runner that is not there ran no checks: "No module named pytest" says nothing of the code.
const MISSING = /No module named ['"]?(?:pytest|nose2|tox|nox|mypy|pyright|ruff|flake8|pylint|coverage|unittest)\b|\b(?:pytest|jest|vitest|mocha|tsc|eslint|ruff|mypy|tox|cargo|go|npm|pnpm|yarn|make|bun|deno)\b[^\n]{0,20}(?:command )?not found|command not found/i
// A command that may be the project's own way to run its checks, by its name.
const MENTIONS_CHECK = /\b(?:tests?|specs?|check|lint|build|ci|verify)\b/i

// How a run says it failed, whatever pipe hid its exit code.
const FAILED =
  /\bFAIL(?:ED)?\b|\b[1-9]\d* (?:failed|failing|errors?)\b|\berror TS\d+|\berror\[E\d+\]|\bexit(?:=| code:? ?)[1-9]|Traceback \(most recent call last\)|\bAssertionError\b|\bcommand not found\b|^\s*✖ [1-9]/im
// The line that says what went wrong, most specific first: a Python error's last
// line, an assertion's expected and received, else the line that says it failed.
const SPECIFIC = /\b\w*(?:Error|Exception)\b[:\s]|\b(?:Expected|Received|expected|received|got)\b|!=|\bpanicked at\b/

// A claim that the tests, the build or a check came out right: what and how, in one
// phrase. "How to verify everything works", beside "test cases", is not that.
const CHECKED = String.raw`(?:tests?|specs?|test suite|suite|builds?|checks?|lint(?:s|er)?|type ?checks?|tsc|ci)`
const OUTCOME = String.raw`(?:pass(?:es|ed|ing)?|green|succeed(?:s|ed)?|successful(?:ly)?|clean(?:ly)?)`
const CHECK_PASS = new RegExp(
  String.raw`\b${CHECKED}\b[^.\n]{0,40}?\b${OUTCOME}\b|\b${OUTCOME}\b[^.\n]{0,12}?\b${CHECKED}\b|\bcompiles?\b|(?:测试|单测|用例|构建|编译|类型检查)[^。\n]{0,10}(?:通过|全过|跑通|成功|全绿|绿了|没问题|无报错)|(?:全部|都)(?:通过|跑通)`,
  'i',
)
// A plan, a hope or an honest "not yet" is no claim.
// So is what held before: "the test passed before the edit" says nothing of now.
const NOT_A_CLAIM =
  /\b(?:will|going to|let me|let's|i'll|next|then i|should|need to|try(?:ing)? to|once|after (?:i|we)|if|not|no longer|fail(?:s|ed|ing|ure)?|until|before|earlier|previously|prior|originally|at first|used to|unverified|unchecked|untested|unconfirmed|claimed|(?:i|you) (?:said|stated|wrote))\b|\bwithout (?:actually |really |first )?(?:run|runn|check|test|verif)\w*|n['’]t\b|将|稍后|接下来|然后|待会|需要|准备|计划|打算|让我|我来|下一步|如果|等到|等待|没|未|不|失败|报错|之前|此前|原先|先前|原来|改动前|修改前|未验证|未经验证|没有验证/i
// An answer that owns up to a failure: whatever else it says, it said that.
const OWNS_UP = /\bfail(?:s|ed|ing|ure|ures)?\b|\berrors?\b|\bbroken\b|\bbreaks?\b|\bnot (?:yet )?pass|\b(?:doesn|don|isn|aren|didn)'?t (?:pass|work)|\bstill (?:red|failing)|\bcrash|失败|报错|错误|未通过|没通过|不通过|没有通过|还有问题|仍有问题|跑不过/i
// Saying a file was changed.
const CHANGED = /\b(?:updated|changed|modified|edited|bumped|added (?:it )?to|wrote|rewrote|fixed (?:it )?in|patched)\b|修改了|更新了|改了|改好了|写入了|写进|加到了|已更新|已修改/i
const FILE = /(?<![\w.-])[~/]?(?:[\w.-]+\/)*[\w-]+\.(?:py|js|mjs|cjs|ts|tsx|jsx|json|toml|ya?ml|cfg|ini|txt|md|go|rs|java|kt|rb|php|c|cc|cpp|h|hpp|cs|swift|sh|sql|html|css|lock)\b/g
// Names of libraries, not files: "updated the Node.js handler".
const LIBRARY = /^(?:node|vue|next|nuxt|react|three|d3|chart|express|ember|backbone|socket\.io|moment)\.js$/
// What a person reads, not what runs: an edit to it leaves the tests as they were.
const PROSE = /\.(?:md|markdown|txt|rst|adoc)$|(?:^|\/)(?:NOTES|CHANGELOG|README|LICENSE|TODO)[^/]*$/i
const isCode = (path: string) => !PROSE.test(path)

// Tests, and what makes one weaker: an assertion gone, a skip, one that cannot fail.
export const TEST_FILE = /(?:^|\/)(?:test_[^/]*\.py|[^/]*_test\.(?:py|go)|[^/]*\.(?:test|spec)\.[cm]?[jt]sx?|[^/]*Test\.(?:java|kt)|[^/]*_spec\.rb|conftest\.py)$|(?:^|\/)(?:tests?|__tests__|spec)\/[^/]+$/
const ASSERT = /\b(?:self\.)?assert\w*\s*[(\s]|\bexpect\s*\(|\bt\.(?:Error|Fatal|Fail)f?\s*\(|\bassert(?:_eq|_ne)?!\s*\(|\bassertThat\s*\(/g
const SKIP = /@pytest\.mark\.(?:skip|xfail)\b|@unittest\.(?:skip\w*|expectedFailure)\b|\bpytest\.(?:skip|xfail)\s*\(|\.skipTest\s*\(|\b(?:it|test|describe)\.skip\s*\(|\bx(?:it|describe|test)\s*\(|@Ignore\b|@Disabled\b|\bt\.Skip(?:Now|f)?\s*\(|#\[ignore\]/g
// A test, by its name: `def test_x`, `it('does x'`, `test("x"`, `func TestX`.
const TEST_NAME = /\bdef (test_\w+)|\b(?:it|test)\(\s*['"]([^'"\n]+)['"]|\bfunc (Test\w+)/g
const testNames = (s: string) => new Set([...s.matchAll(TEST_NAME)].map(m => m[1] ?? m[2] ?? m[3] ?? ''))
const TRIVIAL = /\bassert\s+True\b|\bassertTrue\(\s*True\s*\)|\bexpect\(\s*true\s*\)\.toBe\(\s*true\s*\)|\bassert\s+(\d+)\s*==\s*\1\b|\bassertEqual\(\s*([\w.]+)\s*,\s*\2\s*\)/
// The person allowed the tests to change, in so many words. "Fix the failing test" is
// not that: it asks for the test to pass.
const TESTS_MAY_CHANGE =
  /\b(?:update|change|rewrite|correct|adjust|remove|delete|skip|relax|loosen)\b[^.\n]{0,40}\btests?\b|\btests?\b[^.\n]{0,40}\b(?:is|are|was|were) (?:wrong|outdated|out of date|broken|incorrect|flaky|obsolete)\b|(?:修改|更新|调整|改|删除|删|跳过|重写)[^。\n]{0,12}测试|测试[^。\n]{0,12}(?:写错|有误|不对|过时|错了)/gi
// "Don't change the tests" names them too, and allows nothing.
const NEGATED = /(?:\b(?:do not|don't|dont|never|without|no)\s+(?:\w+\s+){0,2}|(?:不要|别|不准|禁止|不能|请勿|勿|不许)\S{0,2})$/i
const allowsTestChanges = (asked: string) => [...asked.matchAll(TESTS_MAY_CHANGE)].some(m => !NEGATED.test(asked.slice(Math.max(0, (m.index ?? 0) - 24), m.index)))

// "Don't touch X": the person's own words, with a concrete file or folder as X.
const DONT_EN =
  /\b(?:do not|don't|dont|never|without)\s+(?:modify(?:ing)?|chang(?:e|ing)|touch(?:ing)?|edit(?:ing)?|alter(?:ing)?|delet(?:e|ing)|remov(?:e|ing)|rewrit(?:e|ing))\s+(?:the\s+|any\s+|anything\s+(?:in|under)\s+|files?\s+(?:in|under)\s+)*[`'"]?([\w][\w.\/-]*)[`'"]?/gi
const DONT_ZH = /(?:不要|别|不准|禁止|不能|请勿|勿|不许|不可以)(?:去)?(?:修改|改动|更改|改|动|碰|编辑|删除|删|重写)(?:任何)?\s*[`'"「]?([\w][\w.\/-]*)[`'"」]?/g
const DIRS = /^(?:tests?|src|lib|docs?|vendor|migrations?|generated|dist|build|config|scripts?)\/?$/
// A later "now change config.yaml" / "可以改 tests/ 了": the change verb on the target itself.
// "Fix the code so the tests pass" names the tests, and lifts nothing.
const allows = (text: string, target: string) => {
  const t = target.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
  return new RegExp(
    String.raw`\b(?:modify|change|edit|update|touch|rewrite|alter|fix)\s+(?:the\s+|files?\s+(?:in|under)\s+)?[\x60'"]?${t}(?!\w|\.\w)|(?:修改|改动|更改|改|动|编辑|更新|修复|重写)\s*[\x60'"「]?${t}(?!\w|\.\w)`,
    'i',
  ).test(text)
}

export type CheckRun = { at: number; command: string; ok: boolean; line: string; text: string }
export type BashRun = { at: number; key: string; ok: boolean; sig: string; text: string }
export type Change = { at: number; path: string; old: string; new: string }

export type Evidence = {
  runs: CheckRun[]
  bash: BashRun[]
  /** Each edit that went through: its position and file. */
  edits: { at: number; path: string }[]
  /** Edits whose text to replace was not in the file. */
  misses: { at: number; path: string }[]
  reads: { at: number; path: string }[]
  /** What each edit that went through replaced, and with what (a Write: the whole file). */
  changes: Change[]
  /** Test files a command removed. */
  removed: { at: number; path: string }[]
  /** Positions where a subagent ran: what it ran is not in this transcript. */
  blind: number[]
  /** Every basename any tool call or result names. */
  named: Set<string>
  /** For each claim, the position it was said at: the tool calls before it. */
  saidAt: Map<string, number>
  /** The person's own prompts, with the position each was sent at. */
  prompts: { at: number; text: string }[]
  /** How many tool calls the record holds: a position past all of them. */
  end: number
  /** Whether any command that ran named tests, checks or a build: a runner the rules may not know. */
  mentioned: boolean
  /** Check commands the person's permissions refused: tried, never run. */
  refused: { at: number; command: string }[]
}

const inputOf = (u: Use) => (u.input ?? {}) as Record<string, unknown>
const str = (o: Record<string, unknown>, k: string) => (typeof o[k] === 'string' ? (o[k] as string) : '')
const firstLine = (s: string, re: RegExp) => s.split('\n').find(l => re.test(l)) ?? ''
const lastLine = (s: string, re: RegExp) => s.split('\n').filter(l => re.test(l)).at(-1) ?? ''

/** A command as it is retried: the pipe into tail, the echoed exit code and the redirect left off. */
export const keyOf = (command: string) =>
  squash(command)
    .replace(/\s*;\s*echo\s+["']?exit=\$\?["']?\s*$/, '')
    .replace(/\s*\|\s*(?:tail|head)(?:\s+-n)?(?:\s+-?\d+)?\s*$/, '')
    .replace(/\s*2>&1\b/g, '')
    .trim()

// What a failure said, with what changes between identical failures taken out:
// timings, addresses, line numbers.
const signatureOf = (out: string) =>
  squash(lastLine(out, SPECIFIC) || firstLine(out, FAILED) || out.trim().split('\n').at(-1) || '')
    .replace(/\bin \d+(?:\.\d+)?m?s\b/g, '')
    .replace(/\b0x[0-9a-f]+\b/gi, '0x')
    .replace(/\bline \d+\b/g, 'line')
    .trim()

// The person's rows, not the tool results, the notes this plugin wrote, or the
// engine's own reminders.
const isPerson = (r: Row) => r.role === 'user' && r.text.trim() !== '' && !r.text.includes('[deepseek-supervisor]') && !/^\s*<(?:system-reminder|command-|local-command)/.test(r.text)

// The session's main loop as a sequence of tool calls, each with its position; a
// row's text is said before the row's own tool calls run.
export const evidenceOf = (rows: readonly Row[]): Evidence => {
  const ev: Evidence = { runs: [], bash: [], edits: [], misses: [], reads: [], changes: [], removed: [], blind: [], named: new Set(), saidAt: new Map(), prompts: [], end: 0, mentioned: false, refused: [] }
  // The last text known of each file, so a Write can be held against what it replaced.
  const known = new Map<string, string>()
  let at = 0
  for (const r of rows) {
    if (isPerson(r)) ev.prompts.push({ at, text: r.text })
    if (r.role !== 'assistant') continue
    for (const c of claimsOf(r.text)) ev.saidAt.set(c, at)
    for (const u of r.toolUses ?? []) {
      const input = inputOf(u)
      const out = `${u.text ?? ''}\n${leaves(u.result).join('\n')}`
      for (const s of [...leaves(input), out]) for (const m of s.matchAll(FILE)) ev.named.add(base(m[0]).toLowerCase())
      const path = str(input, 'file_path') || str(input, 'notebook_path')
      const failed = u.isError === true

      if (u.tool === 'Read' && path !== '' && !failed) {
        ev.reads.push({ at, path })
        // Read shows each line behind its number and a tab.
        known.set(path, (u.text ?? '').split('\n').map(l => l.replace(/^\s*\d+\t/, '')).join('\n'))
      }
      if ((u.tool === 'Edit' || u.tool === 'MultiEdit' || u.tool === 'Write' || u.tool === 'NotebookEdit') && path !== '') {
        if (failed) {
          if (/not found|did not match|no match/i.test(u.text ?? '')) ev.misses.push({ at, path })
        } else {
          ev.edits.push({ at, path })
          const hunks =
            u.tool === 'Edit'
              ? [{ old: str(input, 'old_string'), new: str(input, 'new_string') }]
              : u.tool === 'MultiEdit' && Array.isArray(input.edits)
                ? (input.edits as Record<string, unknown>[]).map(x => ({ old: str(x, 'old_string'), new: str(x, 'new_string') }))
                : u.tool === 'Write'
                  ? [{ old: known.get(path) ?? '', new: str(input, 'content') }]
                  : []
          for (const h of hunks) ev.changes.push({ at, path, ...h })
          if (u.tool === 'Write') known.set(path, str(input, 'content'))
        }
      }
      if (u.tool === 'Agent' || u.tool === 'Task') ev.blind.push(at)
      if (u.tool === 'Bash' && failed && DENIED.test(u.text ?? '') && isCheckCommand(str(input, 'command')))
        ev.refused.push({ at, command: clip(squash(str(input, 'command')), 120) })
      if (u.tool === 'Bash' && !(failed && DENIED.test(u.text ?? ''))) {
        const command = str(input, 'command')
        if (MENTIONS_CHECK.test(command)) ev.mentioned = true
        const ok = !failed && !FAILED.test(out)
        ev.bash.push({ at, key: keyOf(command), ok, sig: ok ? '' : signatureOf(out), text: clip(out, 4000) })
        // The line a note shows is the one that says what failed, not "Exit code 1".
        if (isCheckCommand(command) && !MISSING.test(out)) ev.runs.push({ at, command: clip(squash(command), 200), ok, line: ok ? '' : clip(signatureOf(out), 160), text: ok ? '' : clip(out, 4000) })
        // A test file removed from the shell.
        for (const p of pieces(command)) {
          const m = /^(?:git\s+)?rm\s+(.+)$/.exec(p)
          for (const arg of m?.[1]?.split(/\s+/) ?? []) if (TEST_FILE.test(arg.replace(/["']/g, ''))) ev.removed.push({ at, path: arg.replace(/["']/g, '') })
        }
      }
      at += 1
    }
  }
  ev.end = at
  return ev
}

export type Kind =
  | 'skipped-check'
  | 'failed-check'
  | 'stale-check'
  | 'no-check'
  | 'unreported-failure'
  | 'untouched'
  | 'stuck'
  | 'edit-miss'
  | 'weakened-test'
  | 'ignored-constraint'

export type Finding = {
  kind: Kind
  /** What is actually so, one plain sentence. */
  what: string
  /** The model's own words, or for a "don't" the person's. */
  quote: string
  /** What settles it, as the note shows it. */
  probe: string
  /** The model's own command, rerun in a copy where there is one; '' when none. */
  recheck: string
  /** For `stuck`: the failure that kept coming back. */
  saw?: string
}

/** Rules whose item says whether the checks pass: one such item is open at a time. */
export const isCheckKind = (k: Kind | undefined) => k === 'failed-check' || k === 'stale-check' || k === 'no-check' || k === 'unreported-failure' || k === 'skipped-check'

/** Rules whose item only the model telling the person closes. */
export const isToldKind = (k: Kind | undefined) => k === 'weakened-test' || k === 'ignored-constraint'

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

    if (CHECK_PASS.test(quote) && !isBlind) {
      const last = ev.runs.filter(r => r.at < at).at(-1)
      const lastEdit = ev.edits.filter(e => e.at < at && isCode(e.path)).at(-1)
      if (last === undefined) {
        // A command named for tests or checks ran: the project's own runner, maybe. Say nothing.
        if (ev.mentioned) continue
        found.push({ kind: 'no-check', what: 'No test, build or check command has run in this session, yet you report how they came out.', quote, probe: 'Run the project\'s tests', recheck: '' })
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

/** Whether a sentence claims something is so now, rather than planning, hoping, owning up or recalling. */
export const isClaim = (s: string) => !NOT_A_CLAIM.test(s)

/** Whether a claim is that the tests, the build or a check pass: the record's to judge, not a model's. */
export const isCheckClaim = (s: string) => CHECK_PASS.test(s)

/** Whether the record already bears a claim out: a pass claimed after a passing run, with no edit to code since. No need to ask a model. */
export const supports = (ev: Evidence, claim: string) => {
  if (NOT_A_CLAIM.test(claim) || !CHECK_PASS.test(claim)) return false
  const at = ev.saidAt.get(claim) ?? Number.MAX_SAFE_INTEGER
  if (ev.blind.some(b => b < at)) return false
  const last = ev.runs.filter(r => r.at < at).at(-1)
  const lastEdit = ev.edits.filter(e => e.at < at && isCode(e.path)).at(-1)
  return last !== undefined && last.ok && (lastEdit === undefined || lastEdit.at < last.at)
}

const count = (s: string, re: RegExp) => [...s.matchAll(re)].length
const lines = (s: string) => new Set(s.split('\n').map(l => l.trim()).filter(l => l !== ''))
// The literals an assertion holds: numbers of two characters or more, quoted strings.
const literals = (s: string) => [...s.matchAll(/(?<![\w.])-?\d+(?:\.\d+)?(?![\w.])|'([^'\n]{2,})'|"([^"\n]{2,})"/g)].map(m => m[1] ?? m[2] ?? m[0]).filter(x => x.replace(/^-/, '').length >= 2)

/**
 * How an edit made a test weaker, if it did: what the note says it did. The edit is
 * held against what it replaced, and a value the person named is theirs to set.
 */
const weakening = (c: Change, failedBefore: string, asked: string): string | undefined => {
  // A new file, or one whose old text is not known, has nothing to be weaker than.
  if (c.old.trim() === '') return undefined
  if (count(c.new, SKIP) > count(c.old, SKIP)) return 'added a skip or an expected failure to a test'
  // A test gone by name, whatever was put in its place.
  const gone = [...testNames(c.old)].filter(n => n !== '' && !testNames(c.new).has(n))
  if (gone.length > 0) return `removed the test ${gone.join(', ')}`
  if (TRIVIAL.test(c.new) && !TRIVIAL.test(c.old)) return 'put in an assertion that cannot fail'
  const before = count(c.old, ASSERT)
  if (before > 0 && count(c.new, ASSERT) === 0 && c.old.trim() !== '') return before === 1 ? 'removed the assertion of a test' : `removed ${before} assertions`
  // An expected value set to what the failing run printed: the test bent to fit the bug.
  if (failedBefore !== '' && count(c.old, ASSERT) > 0) {
    const was = lines(c.old)
    const added = c.new.split('\n').filter(l => count(l, ASSERT) > 0 && !was.has(l.trim()))
    const oldLits = new Set(literals(c.old))
    for (const lit of added.flatMap(literals)) if (!oldLits.has(lit) && failedBefore.includes(lit) && !asked.includes(lit)) return `set an expected value to ${lit}, what the failing run printed`
  }
  return undefined
}

/**
 * What the record shows that no claim needs to be said for: a failure repeated with
 * no effect from the changes between, an edit retried against text not in the file,
 * a test made weaker, a file the person said not to touch. Each is about the record
 * as it stands; the caller keeps one open item per question.
 */
export const recordFindings = (ev: Evidence): Finding[] => {
  const found: Finding[] = []
  const asked = ev.prompts.map(p => p.text).join('\n')

  // The same command failing the same way three times in a row.
  for (const key of [...new Set(ev.bash.map(b => b.key))]) {
    const last3 = ev.bash.filter(b => b.key === key).slice(-3)
    if (last3.length < 3 || last3.some(b => b.ok) || last3.some(b => b.sig === '' || b.sig !== last3[0]?.sig)) continue
    const first = last3[0]?.at ?? 0
    const final = last3[2]?.at ?? 0
    const between = ev.edits.filter(e => e.at > first && e.at < final && isCode(e.path)).length
    found.push({
      kind: 'stuck',
      what:
        `\`${clip(key, 120)}\` failed 3 times in a row with the same error: \`${clip(last3[0]?.sig ?? '', 160)}\`. ` +
        (between > 0 ? `The ${between} edit(s) in between did not change it.` : 'Nothing changed in between.'),
      quote: key,
      probe: 'Before the next change, find out why: print the values on the failing path, or read the code that produces them',
      recheck: '',
      saw: last3[0]?.sig ?? '',
    })
  }

  // Two edits in a row to one file, each against text the file does not hold.
  for (const path of [...new Set(ev.misses.map(m => m.path))]) {
    const misses = ev.misses.filter(m => m.path === path).slice(-2)
    const [a, b] = misses
    if (a === undefined || b === undefined) continue
    const since = (x: number) => ev.reads.some(r => r.path === path && r.at > x) || ev.edits.some(e => e.path === path && e.at > x)
    if (since(a.at)) continue
    found.push({ kind: 'edit-miss', what: `Two edits to ${base(path)} failed: the text to replace is not in the file. Your copy of it is out of date.`, quote: path, probe: `Read ${path} again, then copy the text to replace exactly, indentation included`, recheck: '' })
  }

  // A test made weaker, unless the person asked for the tests to change.
  if (!allowsTestChanges(asked)) {
    for (const c of ev.changes.filter(c => TEST_FILE.test(c.path))) {
      // The assistant revising a test it wrote this session is its own work, not the person's tests bent.
      const own = ev.changes.filter(x => x.path === c.path && x.at < c.at).map(x => x.new)
      if (c.old.trim() !== '' && own.some(t => t.includes(c.old.trim()))) continue
      const failedBefore = ev.runs.filter(r => r.at < c.at && !r.ok).at(-1)?.text ?? ''
      const how = weakening(c, failedBefore, asked)
      if (how !== undefined) found.push({ kind: 'weakened-test', what: `An edit to ${base(c.path)} ${how}. The tests check the code; changing them to pass hides what they found.`, quote: clip(squash(c.new) || squash(c.old), 200), probe: `${c.path}: restore the test and fix the code, or tell the person which test you changed and why`, recheck: '' })
    }
    for (const r of ev.removed) found.push({ kind: 'weakened-test', what: `A command removed the test file ${base(r.path)}.`, quote: r.path, probe: `${r.path}: restore it, or tell the person why it had to go`, recheck: '' })
  }

  // A file or folder the person said not to touch, edited after they said so.
  for (const [i, p] of ev.prompts.entries()) {
    for (const m of [...p.text.matchAll(DONT_EN), ...p.text.matchAll(DONT_ZH)]) {
      const target = (m[1] ?? '').replace(/[.,;:!?。，；：！？]+$/, '')
      if (!(/\.\w+$/.test(target) || target.endsWith('/') || DIRS.test(target))) continue
      const dir = target.replace(/\/$/, '')
      const isFile = /\.\w+$/.test(target) && !target.endsWith('/')
      const matches = (path: string) =>
        isFile ? (target.includes('/') ? path === target || path.endsWith(`/${target}`) : base(path) === target) : path.includes(`/${dir}/`) || path.startsWith(`${dir}/`)
      // A later prompt asking for that very file or folder to change lifts this one.
      const lifted = ev.prompts.slice(i + 1).find(q => allows(q.text, dir) && ![...q.text.matchAll(DONT_EN), ...q.text.matchAll(DONT_ZH)].some(x => (x[1] ?? '').startsWith(dir)))
      const hit = ev.edits.find(e => e.at >= p.at && (lifted === undefined || e.at < lifted.at) && matches(e.path))
      if (hit !== undefined) found.push({ kind: 'ignored-constraint', what: `You were asked not to change ${target}, and an edit changed ${base(hit.path)}.`, quote: clip(squash(m[0]), 200), probe: `Undo the change to ${hit.path}, or tell the person why it could not be avoided`, recheck: '' })
    }
  }
  return found
}

// The person asking for the checks to be run: "run the tests", "run the whole suite", 跑一下测试.
// "Don't run the tests" is not that.
const ASKS_TO_RUN = /\b(?:run|re-?run|execute)\b[^.\n]{0,40}\b(?:tests?|test suite|suite|specs?|checks?|build|linter|type ?check)\b|(?:跑|运行|执行)[^。\n]{0,8}(?:测试|单测|用例|检查|构建)/gi
const asksToRun = (text: string) => [...text.matchAll(ASKS_TO_RUN)].some(m => !NEGATED.test(text.slice(Math.max(0, (m.index ?? 0) - 24), m.index)))
// An answer that says the checks did not run: owning up to that is the point.
const SAYS_NOT_RUN = /\b(?:not|never|couldn'?t|could not|unable to|wasn'?t able to)\b[^.\n]{0,30}\b(?:run|ran|execute|executed)\b|n['’]t\b[^.\n]{0,30}\b(?:run|ran|execute|executed)\b|\bwithout running\b|\b(?:approval|permission)\b|未(?:能)?运行|没(?:有)?(?:跑|运行)|无法运行|跑不了/i

/** At the end of a turn: the person asked for the checks to be run, none ran this turn, and the answer does not say so. */
export const skipped = (ev: Evidence, answer: string): Finding[] => {
  const prompt = ev.prompts.at(-1)
  if (prompt === undefined || !asksToRun(prompt.text) || SAYS_NOT_RUN.test(answer) || ev.blind.some(b => b >= prompt.at)) return []
  if (ev.runs.some(r => r.at >= prompt.at)) return []
  const tried = ev.refused.filter(r => r.at >= prompt.at).map(r => `\`${r.command}\``)
  return [
    {
      kind: 'skipped-check',
      what: `You were asked to run the checks, and none ran this turn${tried.length === 0 ? '' : ` (refused by the person's permissions: ${tried.slice(-2).join(', ')})`}; the answer does not say so.`,
      quote: clip(squash(answer) || '(an empty answer)', 200),
      probe: tried.length === 0 ? 'Run them, or tell the person they did not run' : 'Tell the person the checks did not run and why, so they can run them or allow the command',
      recheck: '',
    },
  ]
}

/** At the end of a turn: a check run this turn that failed, with nothing passing since, and an answer that does not say so. */
export const unreported = (ev: Evidence, answer: string): Finding[] => {
  // An answer that claims the checks pass is the claim rules' to hold to the record.
  if (claimsOf(answer).some(c => !NOT_A_CLAIM.test(c) && CHECK_PASS.test(c))) return []
  const since = ev.prompts.at(-1)?.at ?? 0
  const last = ev.runs.filter(r => r.at >= since).at(-1)
  if (last === undefined || last.ok || OWNS_UP.test(answer) || ev.blind.some(b => b > last.at)) return []
  return [{ kind: 'unreported-failure', what: `The last check this turn failed (\`${last.command}\`: ${last.line || 'it reported a failure'}), and the answer does not say so.`, quote: clip(squash(answer) || '(an empty answer)', 200), probe: `Fix it and run ${last.command} again, or tell the person it fails and why`, recheck: last.command }]
}

/**
 * Whether the record now settles an item a rule raised. The record, never the
 * model's say-so; on a machine with no sandbox this is how such an item closes.
 */
export const settledBy = (ev: Evidence, item: { rule?: Kind; quote: string; probe: string; saw?: string; pos?: number }): string | undefined => {
  switch (item.rule) {
    case 'untouched': {
      const name = base(item.probe.replace(/^Read /, '')).toLowerCase()
      return ev.named.has(name) ? `${name} was touched since` : undefined
    }
    case 'stuck': {
      // The quote is the command as retried, `saw` the failure it kept giving.
      const now = ev.bash.filter(b => b.key === item.quote).at(-1)
      if (now === undefined) return undefined
      if (now.ok) return 'it passes now'
      return now.sig !== item.saw ? `the error is different now: \`${clip(now.sig, 120)}\`` : undefined
    }
    case 'edit-miss': {
      // The quote is the file.
      const lastMiss = ev.misses.filter(m => m.path === item.quote).at(-1)?.at ?? -1
      return ev.reads.some(r => r.path === item.quote && r.at > lastMiss) || ev.edits.some(e => e.path === item.quote && e.at > lastMiss) ? `${base(item.quote)} was read or edited since` : undefined
    }
    case 'skipped-check':
      return ev.runs.some(r => r.at >= (item.pos ?? Number.MAX_SAFE_INTEGER)) ? 'a check has run since' : undefined
    case 'no-check':
      // "No check ran" is moot once one has: what it showed is the other rules' to hold.
      if (ev.runs.some(r => r.at >= (item.pos ?? Number.MAX_SAFE_INTEGER))) return 'a check has run since'
    // falls through: or a check that passed after the last edit settles it too
    case 'failed-check':
    case 'stale-check':
    case 'unreported-failure': {
      const last = ev.runs.at(-1)
      const lastEdit = ev.edits.filter(e => isCode(e.path)).at(-1)
      if (last === undefined || !last.ok) return undefined
      if (lastEdit !== undefined && lastEdit.at > last.at) return undefined
      return `\`${last.command}\` passed after the last edit`
    }
    default:
      return undefined
  }
}

/**
 * What the assistant changed since the person's last prompt, as hunks a reviewer
 * reads: code only, oldest first, each clipped, the whole bounded.
 */
export const changesOf = (ev: Evidence, limit = 9000) => {
  const since = ev.prompts.at(-1)?.at ?? 0
  const hunks = ev.changes
    .filter(c => c.at >= since && isCode(c.path))
    .map(c => [`--- ${c.path}`, ...clip(c.old, 1200).split('\n').filter(l => l !== '').map(l => `- ${l}`), ...clip(c.new, 1800).split('\n').map(l => `+ ${l}`)].join('\n'))
  let text = ''
  let kept = 0
  for (const h of hunks) {
    if (text.length + h.length > limit) {
      text += `\n[… ${hunks.length - kept} more change(s) left out]`
      break
    }
    text += (text === '' ? '' : '\n') + h
    kept += 1
  }
  return text
}
