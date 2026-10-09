import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type { Issue, Reading, Track } from '../types'
import { registerBand } from './band'
import { HISTORY as READINGS_KEPT, readingOf } from './weather'
import type { Finding, Kind } from './evidence'
import { changesOf, contradictions, evidenceOf, isCheckClaim, isCheckCommand, isCheckKind, isClaim, keyOf, recordFindings, settledBy, skipped, supports, unreported } from './evidence'
import type { Facts, Mode, VerifyInput, VerifyResult } from './prompt'
import { base, claimsOf, clip, COMMAND_MS, COPY_MS, factsOf, isSameItem, MODEL, noteText, parseTurn, probeRefusal, redact, refusal, ROUNDS, shown, squash, verifyPrompt } from './prompt'

// Claude Code's own "You should know" is hidden whenever ANTHROPIC_BASE_URL points
// away from Anthropic (observed on 2.1.290: that one variable alone), so it never
// loads on a third-party model. This is not a copy of it. A weaker model goes wrong
// in ways the session's own record shows, and in ways only running something shows:
//
// - after every batch of tool calls, rules on the record (evidence.ts) look for the
//   model going in circles, editing against a stale view of a file, bending a test,
//   or touching what the person said not to; what they find rides into the next
//   request with the tool results;
// - before a turn ends, the same rules hold the answer to the record (a pass claimed
//   over a failed or stale run, a failure left unsaid); what does not hold keeps the
//   turn going, at most twice per prompt of the person's, the second time only with
//   what the first did not say;
// - a verifier, a second model (by default the endpoint's stronger one), checks the
//   model's claims by running commands in a throwaway copy, and reads the turn's
//   change for a defect it can show with a command (see prompt.ts).

// The verifier looks at most once every MIN_GAP finished steps of the main loop,
// and only when the model has claimed something new (each check up to ROUNDS
// calls, more with retries). No cap per prompt: 0.8.0 had 8, and a session fed by
// another session's messages (ccds) never saw a prompt of the person's to reset it,
// so after 8 checks the work went unchecked for the rest of the session.
const MIN_GAP = 3
const CLAIMS_PER_RUN = 12
const SEEN_KEPT = 200
// A turn whose answer does not hold is kept going at most twice per prompt of the
// person's (the second time only with what is new), and a verifier that finds
// something after the turn ended sends at most one follow-up prompt: a check can never
// keep a session going by itself.
const BLOCKS_PER_PROMPT = 2
const FOLLOW_UPS_PER_PROMPT = 1
// "You should know" cards clear after two prompts from the person; so does the band.
const CLEAR_AFTER_PROMPTS = 2
// How long the verifier may take: where a turn's end waits on it, a minute; elsewhere,
// off anyone's path, three.
const WAITED_MS = 60_000
const FREE_MS = 180_000
const ISSUES_KEPT = 40
const HISTORY = 50

// The band's two values, drawn by hooks/band.tsx. The scan wants every file that
// writes one to name it in a const of its own; types/index.d.ts holds both to one shape.
const cards = atom({ plugin: 'deepseek-supervisor', key: 'cards' } as const, null)
const isHidden = atom({ plugin: 'deepseek-supervisor', key: 'isHidden' } as const, false)
// The numbered items. In $.state, not a module variable, so a hot reload neither
// forgets what the model was told nor reuses an id.
const EMPTY: Track = { nextId: 1, issues: [], seen: [], runs: 0 }
const track = atom({ plugin: 'deepseek-supervisor', key: 'track' } as const, EMPTY)

type Config = { verifierModel: string; reviewChanges: boolean }
const configOf = (options: PluginOptions | undefined): Config => ({
  // On DeepSeek's endpoint `opus` names its Pro model and `sonnet` its Flash one:
  // the work is checked by the stronger model unless the person says otherwise.
  verifierModel: typeof options?.verifier_model === 'string' && options.verifier_model.trim() !== '' ? options.verifier_model.trim() : 'opus',
  reviewChanges: options?.review_changes !== false,
})

const say = ($: EngineInterface, line: string) => $.ui.log(`deepseek-supervisor: ${line}`, { to: 'debug' })

// `on` and `off` are what the person chose, with the command or DEEPSEEK_SUPERVISOR;
// with neither, it runs where the built-in one is hidden: ANTHROPIC_BASE_URL set to
// a host that is not Anthropic's.
type Setting = 'auto' | 'on' | 'off'
const settingOf = async ($: EngineInterface): Promise<Setting> => {
  const v = await $.store.get('mode').catch(() => undefined)
  if (v === 'on' || v === 'off') return v
  const env = (await $.env.get('DEEPSEEK_SUPERVISOR').catch(() => undefined))?.trim().toLowerCase()
  return env === 'on' || env === 'off' ? env : 'auto'
}

const isAnthropic = (url: string | undefined) => {
  if (url === undefined || url.trim() === '') return true
  const host = /^[a-z]+:\/\/([^/:?#]+)/i.exec(url.trim())?.[1]?.toLowerCase() ?? ''
  return host === 'anthropic.com' || host.endsWith('.anthropic.com')
}

const onAnthropic = async ($: EngineInterface) => isAnthropic(await $.env.get('ANTHROPIC_BASE_URL').catch(() => undefined))

const isOn = async ($: EngineInterface) => {
  const setting = await settingOf($)
  return setting === 'auto' ? !(await onAnthropic($)) : setting === 'on'
}

let cfg: Config = configOf(undefined)
let steps = 0
let isBusy = false
let promptsSinceCards = 0
let blocks = 0
// The items a hold this prompt already put to the model: a second hold says only what is new.
let held = new Set<number>()
let followUps = 0
// When the person's last prompt came: the items raised since are this turn's.
let turnFrom = 0
// A session nobody watches (`claude -p`, an SDK host) ends when its turn does, so a
// check that lands after the turn would land nowhere: there the verifier runs before
// the turn may end, and keeps it going if what it finds does not hold.
let isInteractive = true
// The verifier's model, once the configured one was refused: the endpoint's default.
let fellBack = false
// The person's last prompt, as they typed it: what the claims are checked against.
let asked = ''
// This session's count, for the status line; a hot reload starts it over.
let told = 0
let last = ''

const hhmm = (ms: number) => {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

const show = async ($: EngineInterface) => {
  if (!(await isOn($)))
    return $.ui.status(
      (await settingOf($)) === 'off'
        ? 'deepseek-supervisor is off (/deepseek-supervisor on)'
        : 'deepseek-supervisor idle: Anthropic endpoint, where the built-in "You should know" runs (/deepseek-supervisor on to force)',
    )
  const open = (await read($, track)).issues.filter(i => i.status === 'open').length
  $.ui.status(`deepseek-supervisor checking · ${told} noted` + (open === 0 ? '' : ` (${open} open)`) + (last === '' ? '' : ` · last: ${last}`))
}

// The context window's fill, for the line above the prompt (weather.tsx, drawn in
// band.tsx). Taken when a session starts and when a main-loop turn ends; a host
// that reports no usage leaves the line out and never breaks the check.
const readings = atom({ plugin: 'deepseek-supervisor', key: 'readings' } as const, [] as Reading[])
const takeReading = async ($: EngineInterface) => {
  const reading = readingOf((await $.session.usage().catch(() => undefined))?.context)
  if (reading !== undefined) await update($, readings, h => [...(h ?? []), reading].slice(-READINGS_KEPT)).catch(() => undefined)
}

const remember = async ($: EngineInterface, entry: Record<string, unknown>) => {
  const old = await $.store.get('history').catch(() => [])
  const list = Array.isArray(old) ? old : []
  await $.store.set('history', [...list, entry].slice(-HISTORY)).catch(() => undefined)
}

// The verifier's loop: the model proposes commands, they run in a copy, their
// output goes back, until it answers. A loop of its own, not a subagent: every
// command passes through here (where it runs, what it may touch, what it cost),
// nothing lands in the conversation but the note, and every wait is a `$` call,
// so a hook that waits on it keeps its 10 s budget.
const runIn = async ($: EngineInterface, command: string, cwd: string, box: string | undefined) => {
  const start = await $.clock.now()
  try {
    const argv = box === undefined ? ['bash', '-c', command] : ['sandbox-exec', '-p', box, 'bash', '-c', command]
    const r = await $.process.run(argv, { cwd, timeoutMs: COMMAND_MS })
    // Its output goes to the verifier's endpoint, a third party: credentials are cut out first.
    return { exitCode: r.exitCode as number | null, out: redact(`${r.stdout}${r.stderr === '' ? '' : `\n[stderr]\n${r.stderr}`}`), ms: (await $.clock.now()) - start }
  } catch (err) {
    return { exitCode: null, out: `[did not finish: ${String(err)}]`, ms: (await $.clock.now()) - start }
  }
}

// The clone keeps a command's relative paths off the real files; it does not
// keep off a script that writes to an absolute path (its own project's, or one
// under the home folder). So every command runs under the macOS sandbox: nothing
// may be written under the home folder or the real workspace, and in a clone,
// only the clone may be. With no sandbox (not macOS), no clone is used and only
// read-only commands run.
const SANDBOX = '/usr/bin/sandbox-exec'
const boxOf = (denied: readonly string[], writable: readonly string[]) =>
  [
    '(version 1)(allow default)',
    `(deny file-write* ${denied.map(d => `(subpath ${JSON.stringify(d)})`).join(' ')})`,
    ...(writable.length === 0 ? [] : [`(allow file-write* ${writable.map(w => `(subpath ${JSON.stringify(w)})`).join(' ')})`]),
  ].join('')

// A clone of the workspace (on APFS no data is copied), or nothing. The home
// folder or the root is never copied; a copy that takes too long is given up.
const copyOf = async ($: EngineInterface, real: string): Promise<string | undefined> => {
  const home = (await $.process.run(['bash', '-c', 'printf %s "$HOME"']).catch(() => undefined))?.stdout ?? ''
  if (real === '' || real === '/' || real === home) return undefined
  const made = await $.process.run(['mktemp', '-d', '-t', 'dss-verify']).catch(() => undefined)
  const dir = made?.exitCode === 0 ? made.stdout.trim() : ''
  if (dir === '') return undefined
  // `-c` clones on APFS; elsewhere (Linux), a plain recursive copy.
  const cloned = await $.process
    .run(['bash', '-c', 'cp -cR "$0/." "$1" 2>/dev/null || cp -R "$0/." "$1"', real, dir], { timeoutMs: COPY_MS })
    .catch(() => undefined)
  if (cloned?.exitCode === 0) return dir
  await drop($, dir)
  return undefined
}

const drop = async ($: EngineInterface, dir: string) => {
  // Only what mktemp made for this plugin.
  if (/\/dss-verify\.[A-Za-z0-9]+$/.test(dir)) await $.process.run(['rm', '-rf', dir]).catch(() => undefined)
}

const addCost = (cost: VerifyResult['cost'], u: { cache_read_input_tokens?: number | null; input_tokens: number; output_tokens: number }) => {
  cost.cached += u.cache_read_input_tokens ?? 0
  cost.input += u.input_tokens
  cost.output += u.output_tokens
  cost.calls += 1
}

// One call to the verifier's model. The configured one first; if the endpoint
// refuses it (an unknown name, a model this key may not use), the default alias,
// for the rest of the session.
const ask = async ($: EngineInterface, prompt: string, timeoutMs = 180_000) => {
  const model = fellBack ? MODEL : cfg.verifierModel
  const call = (m: string) => $.model.complete({ model: m, prompt, maxTokens: 16000, timeoutMs })
  const reply = await call(model).catch((err: unknown) => {
    say($, `verifier model ${model} refused: ${err}`)
    return undefined
  })
  const refused = reply === undefined || (!reply.isAnswered && reply.reason === 'api-error' && (reply.status === 400 || reply.status === 404 || reply.error === 'invalid_request'))
  if (!refused || model === MODEL) return reply ?? (await call(MODEL))
  say($, `verifier model ${model} unavailable here; using ${MODEL}`)
  fellBack = true
  return call(MODEL)
}

// What a demonstrated defect's recheck is: exit 0 exactly when the probe's output no
// longer holds the text that showed the defect.
const quoted = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
const absentFrom = (probe: string, expect: string) => `! ( ${probe} ) 2>&1 | grep -qF -- ${quoted(expect)}`

// A change, told apart from another by its length and an FNV-1a hash: what is kept to
// know the verifier read it, without keeping the change.
const signatureOfChange = (s: string) => {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193)
  return `${s.length}:${(h >>> 0).toString(16)}`
}

/**
 * Checks claims by running commands, and reads the turn's change for a defect a
 * command can show. Open items that carry a recheck are settled by code first:
 * exit 0 is fixed, whatever anyone says. Never rejects.
 */
const verify = async ($: EngineInterface, input: VerifyInput): Promise<VerifyResult> => {
  const hasBox = (await $.process.run(['test', '-x', SANDBOX]).catch(() => undefined))?.exitCode === 0
  const home = (await $.process.run(['bash', '-c', 'printf %s "$HOME"']).catch(() => undefined))?.stdout ?? ''
  const copy = !hasBox || home === '' || input.cwd === '' ? undefined : await copyOf($, input.cwd).catch(() => undefined)
  const mode: Mode = copy === undefined ? 'read-only' : 'copy'
  const where = copy ?? input.cwd
  // The sandbox matches resolved paths (/tmp is /private/tmp on macOS), so every
  // path goes in both as given and resolved.
  const both = async (p: string) => p === '' ? [] : [...new Set([p, (await $.process.run(['realpath', p]).catch(() => undefined))?.stdout.trim() || p])]
  const box = !hasBox || home === '' ? undefined : boxOf([...(await both(home)), ...(await both(input.cwd))], copy === undefined ? [] : await both(copy))
  const result: VerifyResult = { mode, probes: [], defects: [], fixed: [], ran: [], cost: { cached: 0, input: 0, output: 0, calls: 0 } }
  // What each command the verifier ran printed: a defect must be shown by one of them.
  const printed = new Map<string, string>()
  try {
    // Rechecks run only in a copy: they are the project's own commands and may write.
    if (mode === 'copy') {
      for (const i of input.open.filter(i => (i.recheck ?? '') !== '')) {
        // A recheck is the verifier's command too: kept to the copy like the rest.
        const no = refusal(i.recheck ?? '', mode, input.cwd)
        if (no !== undefined) {
          result.ran.push({ command: i.recheck ?? '', exitCode: null, ms: 0, refused: no })
          continue
        }
        const r = await runIn($, i.recheck ?? '', where, box)
        result.ran.push({ command: i.recheck ?? '', exitCode: r.exitCode, ms: r.ms })
        if (r.exitCode === 0) result.fixed.push({ id: i.id, saw: clip(squash(r.out), 300) || `\`${i.recheck}\` exited 0` })
      }
    }
    const toRecheck = input.open.filter(i => i.from === 'verify' && i.defect === undefined && (mode !== 'copy' || (i.recheck ?? '') === ''))
    // With no copy nothing runs the checks: whether they pass is the record's to say.
    if (mode === 'read-only') input = { ...input, claims: input.claims.filter(c => !isCheckClaim(c)) }
    if (input.claims.length === 0 && (input.changes ?? '') === '') return result

    let transcript = verifyPrompt(input, mode, toRecheck)
    const started = await $.clock.now()
    for (let round = 1; round <= ROUNDS; round++) {
      // Out of time: the next reply is the last, with no more commands.
      const final = round === ROUNDS || (await $.clock.now()) - started > (input.budgetMs ?? FREE_MS) * 0.6
      const left = Math.max(15_000, (input.budgetMs ?? FREE_MS) - ((await $.clock.now()) - started))
      const reply = await ask($, final ? `${transcript}\n\nNo more commands: answer with the "checked" object now.` : transcript, left)
      addCost(result.cost, reply.usage)
      if (!reply.isAnswered) return { ...result, reason: reply.reason }
      let turn = parseTurn(reply.text, input.claims)
      // One second chance for a reply that is not one JSON object.
      if (turn === null) {
        const again = await ask($, `${transcript}\n\n[your reply]\n${clip(reply.text, 2000)}\n\nThat was not one JSON object. Answer again with exactly one JSON object and nothing else.`, left)
        addCost(result.cost, again.usage)
        turn = again.isAnswered ? parseTurn(again.text, input.claims) : null
      }
      if (turn === null) return { ...result, reason: 'unreadable reply' }
      if ('checked' in turn) {
        result.probes = turn.checked
        for (const it of turn.items) if (it.status === 'fixed' && it.saw !== '' && toRecheck.some(i => i.id === it.id)) result.fixed.push({ id: it.id, saw: it.saw })
        const changed = squash(input.changes ?? '')
        for (const d of turn.defects) {
          // The line must be one the assistant changed: a defect elsewhere is not this turn's.
          if (!changed.includes(squash(d.line).replace(/^[+-]\s*/, ''))) continue
          // In a copy, shown or nothing: the command ran here and printed what shows it.
          const out = [...printed.entries()].find(([c]) => keyOf(c) === keyOf(d.command))?.[1]
          if (mode === 'copy') {
            if (out !== undefined && out.includes(d.expect)) result.defects.push({ ...d, saw: clip(squash(out), 300), demonstrated: true })
          } else {
            // Here the assistant runs the probe, under the person's own permissions: it must
            // run the project's code and do nothing else.
            const no = probeRefusal(d.command, isCheckCommand(d.command))
            if (no === undefined) result.defects.push({ ...d, saw: '', demonstrated: false })
            else result.ran.push({ command: d.command, exitCode: null, ms: 0, refused: `probe not passed on: ${no}` })
          }
        }
        return result
      }
      if (final || turn.run.length === 0) return { ...result, reason: 'no verdict' }
      const outputs: string[] = []
      for (const command of turn.run) {
        const no = refusal(command, mode, input.cwd)
        if (no !== undefined) {
          result.ran.push({ command, exitCode: null, ms: 0, refused: no })
          outputs.push(`$ ${command}\n[refused: ${no}]`)
          continue
        }
        const r = await runIn($, command, where, box)
        result.ran.push({ command, exitCode: r.exitCode, ms: r.ms })
        printed.set(command, r.out)
        outputs.push(`$ ${command}\n[exit ${r.exitCode ?? 'none'}]\n${shown(r.out)}`)
      }
      transcript = `${transcript}\n\n[your turn ${round}]\n${reply.text.trim()}\n\n[output]\n${outputs.join('\n\n')}`
    }
    return { ...result, reason: 'no verdict' }
  } catch (err) {
    return { ...result, reason: `failed: ${String(err)}` }
  } finally {
    if (copy !== undefined) await drop($, copy)
  }
}

// A rule, not a model: an image made and never opened since, that the model has
// just named and said what it shows. Speaking of "the chart" without a name no longer
// counts: 图 alone tied a claim about an image it had read to every other one unopened;
// nor does saying where a file went ("cover3.png 已更新") (2026-10-09).
const SHOWS = /显示|看到|看着|看过|看起来|画面|图里|图中|图上|上面(?:是|有)|颜色|配色|位置|居中|对齐|清晰|正确|没问题|无误|\b(?:shows?|showing|looks?|visible|appears?|displays?|depicts?|correct(?:ly)?|renders? (?:fine|correctly|well))\b/i
const unopenedClaimed = (facts: Facts, claims: readonly string[]) =>
  facts.unopened
    .map(path => [path, claims.find(c => c.includes(base(path)) && SHOWS.test(c))] as const)
    .filter((x): x is readonly [string, string] => x[1] !== undefined)

// The model's own word that it told the person: `[ysk#3 told]`, `[ysk#3 refuted: …]`.
const TAG = /\[ysk#(\d+)\s+(told|refuted)\b[^\]]*\]/g

type Rows = { role: string; text: string; toolUses?: readonly { tool: string; input: unknown; text?: string; result?: unknown; isError?: true }[] }[]

// Whether an item already stands for what a finding says: one open item per
// question (whether the checks pass is one; a file, a command, a test edit, each
// another), and what was settled is not raised again for the same reason.
const isKnown = (f: Finding, items: readonly Issue[], saidAt: (quote: string) => number) =>
  items.some(i => {
    switch (f.kind) {
      case 'stuck':
        return i.rule === 'stuck' && i.quote === f.quote && (i.status === 'open' || i.saw === f.saw)
      case 'edit-miss':
        return i.rule === 'edit-miss' && i.quote === f.quote && i.status === 'open'
      case 'weakened-test':
      case 'ignored-constraint':
        return i.rule === f.kind && i.quote === f.quote
      case 'untouched':
        return i.probe === f.probe
      case 'unreported-failure':
      case 'skipped-check':
        // About this turn's answer: one open at a time, whatever was said of earlier turns.
        return i.rule === f.kind && i.status === 'open'
      default:
        return (
          (i.status === 'open' && isCheckKind(i.rule) && i.rule !== 'unreported-failure' && i.rule !== 'skipped-check') ||
          // The model said this rule misread these words: quoting them again in the
          // corrected answer is no new claim (2026-10-09). Another rule on them still is.
          (i.status === 'refuted' && i.rule === f.kind && isSameItem({ quote: f.quote }, i)) ||
          (isSameItem({ quote: f.quote }, i) && (i.status === 'open' || saidAt(f.quote) <= (i.said ?? (i.pos ?? Number.MAX_SAFE_INTEGER) - 1)))
        )
    }
  })

const COST: Record<Kind, string> = {
  'failed-check': 'the person will rely on work that was never shown to hold',
  'stale-check': 'the person will rely on work that was never shown to hold',
  'no-check': 'the person will rely on work that was never shown to hold',
  'unreported-failure': 'the person will take a failing build for a finished one',
  'skipped-check': 'the person will believe checks ran that never did',
  untouched: 'the person will think a file was changed that was not',
  stuck: 'more steps spent on changes that do not move the failure',
  'edit-miss': 'more steps spent on edits that cannot apply',
  'weakened-test': 'the tests stop checking what they checked, and the bug they found stays',
  'ignored-constraint': 'the person said not to; they will have to find and undo it',
}

// Items that keep a turn from ending: what the person would otherwise be handed as
// done. Circles and stale edits are the work's own business while it goes on.
// Nor a claim about the machine (what is installed): true or not, the work is the same.
const ABOUT_THE_MACHINE = /\b(?:installed|not installed|isn't installed|available on|on (?:the )?PATH|versions?)\b|已安装|未安装|没有安装|没装/i
const keepsTurnGoing = (i: Issue) => i.rule !== 'stuck' && i.rule !== 'edit-miss' && !(i.from === 'verify' && i.defect === undefined && ABOUT_THE_MACHINE.test(i.quote))

type CheckOptions = {
  kind: 'during' | 'batch' | 'answer'
  /** The model's claims to hold to the record and, with `verifier`, hand to the verifier. */
  claims: readonly string[]
  /** The turn's final answer, at its end. */
  answer?: string
  /** Whether the verifier (a model, commands) may run in this check. */
  verifier: boolean
  /**
   * Whether this check raises what the rules find. The checks during the work leave
   * that to the batches and the turn's end, which deliver it where it is read.
   */
  rules?: boolean
}

// One check: the rules on the session's record and on images, the rechecks of open
// items, and the verifier on the claims and the turn's change. Settles what it can
// and returns the new items; the caller delivers them.
const check = async ($: EngineInterface, list: Rows, o: CheckOptions): Promise<Issue[]> => {
  const at = await $.clock.now()
  const before = await read($, track)
  const record = evidenceOf(list)
  const facts = { ...factsOf(list), runs: record.runs.slice(-6).map(r => `\`${clip(r.command, 100)}\`: ${r.ok ? 'passed' : `failed (${r.line || 'it reported a failure'})`}`) }
  const open = before.issues.filter(i => i.status === 'open')
  // The record first: no model, so no budget and no made-up evidence, and it works
  // where no command may run. Only what the record still contradicts now is raised:
  // a claim since made good is left alone.
  const ruled = [...contradictions(record, o.claims), ...(o.rules === false ? [] : recordFindings(record)), ...(o.answer === undefined ? [] : [...unreported(record, o.answer), ...skipped(record, o.answer)])].filter(
    f => settledBy(record, { rule: f.kind, quote: f.quote, probe: f.probe, saw: f.saw }) === undefined,
  )
  // The verifier runs whenever a check hands it a claim. A claim the record already contradicts, or
  // already bears out, is not handed to it: no model is needed for those.
  const canRun = o.verifier
  // Nor a claim said before a later edit to code: it described files that have changed since.
  const lastCodeEdit = record.edits.filter(e => !/\.(?:md|markdown|txt|rst|adoc)$/i.test(e.path)).at(-1)?.at ?? -1
  const isCurrent = (c: string) => (record.saidAt.get(c) ?? Number.MAX_SAFE_INTEGER) > lastCodeEdit
  // Plans and honest failures are no claims to check.
  const handed = canRun ? o.claims.filter(c => isClaim(c) && !ruled.some(f => f.quote === c) && !supports(record, c) && isCurrent(c)) : []
  // A change the verifier already read to the end is not read again: a second review of
  // the same lines costs a call, and can only disagree with the first.
  const turnChanges = canRun && o.kind === 'answer' && cfg.reviewChanges ? changesOf(record) : ''
  const changes = turnChanges !== '' && signatureOfChange(turnChanges) === before.reviewed ? '' : turnChanges
  const rechecks = o.verifier && open.some(i => (i.recheck ?? '') !== '')
  const stillUnopened = new Set(facts.unopened)
  const images = unopenedClaimed(facts, o.claims)
  let v: VerifyResult | undefined
  if (handed.length > 0 || changes !== '' || rechecks) {
    $.ui.status('deepseek-supervisor checking what the model said…')
    const fallback = list.find(r => r.role === 'user' && r.text.trim() !== '' && !r.text.includes('[deepseek-supervisor]'))?.text ?? ''
    v = await verify($, { claims: handed, asked: asked !== '' ? asked : fallback, facts, open, cwd: await $.session.cwd().catch(() => ''), changes, budgetMs: o.kind === 'answer' && !isInteractive ? WAITED_MS : FREE_MS })
  }
  const done = await $.clock.now()
  let found: Issue[] = []
  await update($, track, t => {
    let issues = t.issues.map((i): Issue => {
      const f = v?.fixed.find(x => x.id === i.id)
      if (i.status !== 'open') return i
      if (f !== undefined) return { ...i, status: 'fixed', settledAt: done, why: f.saw }
      if (i.rule !== undefined) {
        const why = settledBy(record, i)
        return why === undefined ? i : { ...i, status: 'fixed', settledAt: done, why }
      }
      // A defect's probe, run by the model since: its output says whether it is there.
      if (i.defect !== undefined && i.pos !== undefined) {
        const probe = keyOf(i.probe)
        const runs = record.bash.filter(b => b.at >= (i.pos ?? 0) && probe !== '' && b.key.includes(probe))
        const now = runs.at(-1)
        if (now === undefined) return i
        if (now.text.includes(i.defect.expect)) return i.defect.demonstrated ? i : { ...i, defect: { ...i.defect, demonstrated: true }, saw: clip(squash(now.text), 300) }
        return i.defect.demonstrated
          ? { ...i, status: 'fixed', settledAt: done, why: `\`${clip(i.probe, 120)}\` no longer prints ${i.defect.expect}` }
          : { ...i, status: 'refuted', settledAt: done, why: `\`${clip(i.probe, 120)}\` did not print ${i.defect.expect}: the reviewer was wrong` }
      }
      if (i.from === 'rule' && i.probe.startsWith('Read ') && !stillUnopened.has(i.probe.slice(5))) return { ...i, status: 'fixed', settledAt: done, why: `${base(i.probe.slice(5))} was opened with Read` }
      return i
    })
    const fresh: Issue[] = []
    const next = () => t.nextId + fresh.length
    for (const f of o.rules === false ? [] : ruled) {
      // A claim not in the record yet is the answer being given now: said after everything,
      // and once it lands, at the end of the record as it is now.
      if (isKnown(f, [...issues, ...fresh], q => record.saidAt.get(q) ?? Number.MAX_SAFE_INTEGER)) continue
      const said = record.saidAt.get(f.quote) ?? record.end
      fresh.push({ id: next(), at: done, from: 'rule', rule: f.kind, what: f.what, quote: f.quote, probe: f.probe, ...(f.saw === undefined ? {} : { saw: f.saw }), ...(f.recheck === '' ? {} : { recheck: f.recheck }), cost: COST[f.kind], status: 'open', pos: record.end, said })
    }
    for (const p of (v?.probes ?? []).filter(p => p.verdict === 'false')) {
      if ([...issues, ...fresh].some(i => isSameItem({ quote: p.claim }, i))) continue
      fresh.push({ id: next(), at: done, from: 'verify', what: p.what, quote: p.claim, probe: p.command, saw: p.saw, recheck: p.recheck, cost: 'the person will act on a claim the output contradicts', status: 'open', pos: record.end })
    }
    for (const d of v?.defects ?? []) {
      if ([...issues, ...fresh].some(i => i.defect !== undefined && (squash(i.quote) === squash(d.line) || keyOf(i.probe) === keyOf(d.command)))) continue
      fresh.push({
        id: next(),
        at: done,
        from: 'verify',
        what: d.what,
        quote: d.line,
        probe: d.command,
        saw: d.demonstrated ? d.saw : '',
        ...(d.demonstrated ? { recheck: absentFrom(d.command, d.expect) } : {}),
        defect: { expect: d.expect, demonstrated: d.demonstrated },
        cost: 'the person gets code that does the wrong thing for an input they will meet',
        status: 'open',
        pos: record.end,
      })
    }
    for (const [path, claim] of images) {
      if ([...issues, ...fresh].some(i => i.probe.startsWith('Read ') && base(i.probe) === base(path))) continue
      fresh.push({ id: next(), at: done, from: 'rule', what: `${base(path)} was made and never opened since, yet the model has stated something about it`, quote: claim, probe: `Read ${path}`, cost: 'what the picture shows is asserted, not seen', status: 'open' })
    }
    found = fresh
    issues = [...issues, ...fresh].slice(-ISSUES_KEPT)
    const ran = v !== undefined && v.cost.calls > 0 && o.kind === 'during'
    const readToEnd = v !== undefined && v.reason === undefined && changes !== ''
    return { ...t, nextId: t.nextId + fresh.length, issues, seen: [...(t.seen ?? []), ...handed].slice(-SEEN_KEPT), runs: (t.runs ?? 0) + (ran ? 1 : 0), ...(readToEnd ? { reviewed: signatureOfChange(changes) } : {}) }
  })
  if (v !== undefined || found.length > 0)
    await remember($, {
      at: done,
      kind: o.kind,
      mode: v?.mode ?? null,
      claims: handed.length,
      changes: changes.length,
      probes: (v?.probes ?? []).map(p => ({ claim: p.claim, command: p.command, verdict: p.verdict, saw: p.saw })),
      defects: (v?.defects ?? []).map(d => ({ line: d.line, command: d.command, expect: d.expect, demonstrated: d.demonstrated })),
      fixed: (v?.fixed ?? []).map(f => f.id),
      found: found.map(i => i.id),
      rules: found.filter(i => i.rule !== undefined).map(i => ({ id: i.id, rule: i.rule, quote: i.quote })),
      ran: v?.ran ?? [],
      reason: v?.reason ?? null,
      cost: v?.cost ?? { cached: 0, input: 0, output: 0, calls: 0 },
      ms: done - at,
    })
  if (v !== undefined || found.length > 0 || o.kind !== 'batch')
    say(
      $,
      `CHECK ${JSON.stringify({ kind: o.kind, claims: handed.length, changes: changes.length, found: found.map(i => i.id), rules: found.filter(i => i.rule !== undefined).map(i => `${i.id}:${i.rule}`), defects: found.filter(i => i.defect !== undefined).map(i => i.id), fixed: v?.fixed.map(f => f.id) ?? [], reason: v?.reason })}`,
    )
  return found
}

const newClaims = (texts: readonly string[], seen: readonly string[]) => {
  const known = new Set(seen)
  return [...new Set(texts.flatMap(claimsOf))].filter(c => !known.has(c)).slice(-CLAIMS_PER_RUN)
}

// The claims said since the last check read the session, in messages no check has
// read yet. A list shorter than before was compacted: read it all, and let `seen`
// hold back what was already checked.
const claimsSince = (list: Rows, t: Track, extra: readonly string[] = []) => {
  const from = (t.scanned ?? 0) <= list.length ? (t.scanned ?? 0) : 0
  return newClaims([...list.slice(from).filter(r => r.role === 'assistant').map(r => r.text), ...extra], t.seen ?? [])
}

const messages = async ($: EngineInterface) => {
  const rows = await $.session.messages().catch(() => undefined)
  return (Array.isArray(rows) ? rows : []) as Rows
}

const showCards = async ($: EngineInterface, items: readonly Issue[]) => {
  const at = await $.clock.now()
  told += items.length
  last = `${items.length} at ${hhmm(at)}`
  promptsSinceCards = 0
  await update($, cards, () => ({ at, items: items.map(i => ({ what: `#${i.id} ${i.what}`, evidence: i.from === 'verify' ? `${i.probe} → ${i.saw ?? ''}` : i.quote, cost: i.cost })) }))
  await update($, isHidden, () => false)
}

// The model telling the person settles an item: it is then theirs to weigh.
const settleTags = async ($: EngineInterface, answer: string) => {
  const tags = [...answer.matchAll(TAG)]
  if (tags.length === 0) return
  const at = await $.clock.now()
  await update($, track, t => ({
    ...t,
    issues: t.issues.map(i => {
      const m = tags.find(x => Number(x[1]) === i.id)
      return m === undefined || i.status !== 'open' ? i : { ...i, status: m[2] === 'refuted' ? ('refuted' as const) : ('told' as const), settledAt: at, why: m[0] }
    }),
  }))
}

// During the work: every MIN_GAP finished steps, the model's new claims, for the verifier.
const tick = async ($: EngineInterface) => {
  try {
    if (steps < MIN_GAP) return
    steps = 0
    const list = await messages($)
    // Only messages no earlier check read: an old claim pushed out of `seen` is not
    // handed over again.
    const claims = claimsSince(list, await read($, track))
    const found = await check($, list, { kind: 'during', claims, verifier: true, rules: false })
    await update($, track, t => ({ ...t, scanned: list.length }))
    if (found.length === 0) return
    await showCards($, found)
    // Refused or failed, the items are still in the band: say so, so the person can pass them on.
    const note = await $.session
      .append({ message: { type: 'user', content: [{ type: 'text', text: noteText(found) }] } })
      .catch((err: unknown) => ({ deny: String(err) }))
    if (note.deny !== undefined) {
      say($, `note not delivered (${note.deny})`)
      $.ui.toast('deepseek-supervisor: a note did not reach the model; see the band above the prompt')
    }
  } catch (err) {
    say($, `check failed: ${err}`)
  } finally {
    isBusy = false
    await show($)
  }
}

// After a turn the person watches: the verifier on the answer's claims and the
// turn's change, off the turn so nobody waits on it. What does not hold goes back
// to the model as one follow-up prompt, at most one per prompt of the person's.
const atAnswer = async ($: EngineInterface, answer: string) => {
  try {
    await settleTags($, answer)
    const list = await messages($)
    const claims = claimsSince(list, await read($, track), [answer])
    const found = await check($, list, { kind: 'answer', claims, answer, verifier: true })
    await update($, track, t => ({ ...t, scanned: list.length }))
    if (found.length === 0) return
    await showCards($, found)
    if (followUps >= FOLLOW_UPS_PER_PROMPT) return
    followUps += 1
    // The submit waits for the session to go idle; never await it inside the turn's end.
    await $.prompt.submit({ text: noteText(found) }).catch(err => say($, `follow-up not submitted: ${err}`))
  } catch (err) {
    say($, `answer check failed: ${err}`)
  } finally {
    await show($)
  }
}

export const register: Register = (on, options) => {
  cfg = configOf(options)
  registerBand(on)

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await takeReading($)
    isInteractive = e.isInteractive !== false
    // A reload starts here too: what was raised before it does not hold a turn after it.
    turnFrom = await $.clock.now()
    await $.command
      .register({ name: 'deepseek-supervisor', description: 'Checks the model at work: rules on what it ran, and a second model running its claims. on, off, auto, log, or issues', argumentHint: '[on|off|auto|log|issues]' })
      .catch(err => say($, `command not registered: ${err}`))
    await show($)
    return result
  })

  // The person's prompts: what claims are checked against, a fresh budget, and the
  // band aging as "You should know" cards do.
  on('prompt.submit', async ($, e, next) => {
    const result = await next(e)
    // The person's own: typed, from a phone, or the SDK host's turn (`claude -p`); or
    // another session's message, the way a lead session hands work over (ccds).
    if (result.drop === undefined && (e.origin.kind === 'composer' || e.origin.kind === 'bridge' || e.origin.kind === 'sdk' || e.origin.kind === 'peer')) {
      asked = e.text
      turnFrom = await $.clock.now()
      blocks = 0
      held = new Set()
      followUps = 0
      await update($, track, t => ({ ...t, runs: 0 })).catch(() => undefined)
      promptsSinceCards += 1
      if (promptsSinceCards >= CLEAR_AFTER_PROMPTS) await update($, cards, () => null).catch(() => undefined)
    }
    return result
  }).catch(($, e, next) => next(e))

  // After every batch of the main loop's tool calls, before the next request: the
  // rules on the record. What they find goes to the model with the tool results,
  // where it is read before the next step is chosen.
  on('classic.PostToolBatch', async ($, e, next) => {
    const result = await next(e)
    if (e.agent_id !== undefined || !(await isOn($))) return result
    const list = await messages($)
    const said = list.filter(r => r.role === 'assistant').map(r => r.text)
    // A `[ysk#3 told]` written in passing settles #3 as one in the final answer does.
    await settleTags($, said.join('\n'))
    const claims = [...new Set(said.flatMap(claimsOf))]
    const found = await check($, list, { kind: 'batch', claims, verifier: false })
    if (found.length === 0) return result
    await showCards($, found)
    await show($)
    return { ...result, additionalContext: [...(result.additionalContext ?? []), noteText(found)] }
  }).catch(($, e, next) => next(e))

  // Before the turn ends: the answer held to the record (and, where nobody watches,
  // to the verifier). What does not hold keeps the turn going, at most twice a prompt.
  on('classic.Stop', async ($, e, next) => {
    const result = await next(e)
    if (e.agent_id !== undefined || result.block !== undefined || !(await isOn($))) return result
    const answer = e.last_assistant_message ?? ''
    await settleTags($, answer)
    const list = await messages($)
    const found = await check($, list, { kind: 'answer', claims: claimsSince(list, await read($, track), [answer]), answer, verifier: !isInteractive })
    // Where the verifier ran here, what it read is read; where it runs after the turn, not yet.
    if (!isInteractive) await update($, track, t => ({ ...t, scanned: list.length }))
    await show($)
    if (found.length > 0) await showCards($, found)
    // What this turn raised and the record has not settled holds the turn too, whichever
    // check raised it first: an item the model never got to act on is not done with.
    const pending = (await read($, track)).issues.filter(i => i.status === 'open' && i.at >= turnFrom && !found.some(f => f.id === i.id))
    const blocking = [...found, ...pending].filter(i => keepsTurnGoing(i) && !held.has(i.id))
    if (blocking.length === 0 || blocks >= BLOCKS_PER_PROMPT) return result
    blocks += 1
    for (const i of blocking) held.add(i.id)
    return { ...result, block: noteText(blocking, { final: true }) }
  }).catch(($, e, next) => next(e))

  // The main loop's finished steps; a subagent's are its own.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    if (e.agentId !== undefined || result.stopReason === null) return result
    steps += 1
    // The step that ends the turn is the turn's end's to check: two checks of one answer
    // would ask the verifier twice.
    if (result.stopReason === 'end_turn') return result
    if (!isBusy && steps >= MIN_GAP && (await isOn($))) {
      isBusy = true
      // Off the step's own dispatch, which closes when the step ends: work that
      // must outlive it runs from a timer.
      $.clock.after(0, () => {
        void tick($)
      })
    }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) await takeReading($) // main-loop turns only
    // Only a turn the model finished on its own: one the person interrupted says nothing.
    // Where nobody watches, the verifier already ran before the turn could end.
    if (e.agentId !== undefined || e.reason !== 'answer' || !isInteractive || !(await isOn($))) return result
    const answer = e.answer
    $.clock.after(0, () => {
      void atAnswer($, answer)
    })
    return result
  })

  on('command.run', { command: 'deepseek-supervisor' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'log') {
      const list = await $.store.get('history').catch(() => [])
      return { text: Array.isArray(list) && list.length > 0 ? JSON.stringify(list.slice(-10), null, 1) : 'No checks yet.' }
    }
    if (arg === 'issues') {
      const t = await read($, track)
      return {
        text:
          t.issues.length === 0
            ? 'No items this session.'
            : t.issues
                .map(i => {
                  const kind = i.defect !== undefined ? ` (defect, ${i.defect.demonstrated ? 'shown' : 'suspected'}: \`${i.defect.expect}\`)` : i.rule !== undefined ? ` (${i.rule})` : ''
                  return `#${i.id} [${i.status}]${kind} ${i.what}${i.from === 'verify' ? `\n   ran: ${i.probe}\n   saw: ${i.saw ?? ''}` : ''}${i.why === undefined ? '' : `\n   why: ${i.why}`}`
                })
                .join('\n'),
      }
    }
    if (arg === 'on' || arg === 'off' || arg === 'auto') {
      if (arg === 'auto') await $.store.delete('mode')
      else await $.store.set('mode', arg)
      if (!(await isOn($))) await update($, cards, () => null)
      await show($)
      return { text: `deepseek-supervisor is ${arg}${arg === 'auto' ? ` (${(await isOn($)) ? 'checking' : "idle on Anthropic's endpoint"})` : ''}.` }
    }
    const setting = await settingOf($)
    return { text: `deepseek-supervisor is ${setting}${setting === 'auto' ? ` (${(await isOn($)) ? 'checking' : "idle on Anthropic's endpoint"})` : ''}. Usage: /deepseek-supervisor [on|off|auto|log|issues]` }
  })
}
