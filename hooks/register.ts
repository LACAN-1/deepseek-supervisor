import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Issue, Track } from '../types'
import { registerBand } from './band'
import type { Facts, Mode, VerifyInput, VerifyResult } from './prompt'
import { base, claimsOf, clip, COMMAND_MS, COPY_MS, factsOf, isSameItem, MODEL, noteText, parseTurn, refusal, ROUNDS, shown, squash, verifyPrompt } from './prompt'

// Claude Code's own "You should know" is hidden whenever ANTHROPIC_BASE_URL points
// away from Anthropic (observed on 2.1.290: that one variable alone), so it never
// loads on a third-party model. This is not a copy of it: that one reads the
// transcript and writes cards for a person; this one checks what the model claims
// by running it (see prompt.ts), during the work and once more when a turn ends.

// The verifier looks at most once every MIN_GAP finished steps of the main loop,
// when the model has claimed something new, and runs at most RUNS_PER_PROMPT
// checks that call a model between two of the person's prompts (each up to ROUNDS
// calls, more with retries; rechecks alone, which call none, do not count).
const MIN_GAP = 3
const RUNS_PER_PROMPT = 8
const CLAIMS_PER_RUN = 12
const SEEN_KEPT = 200
// A turn whose answer the check contradicts gets one follow-up prompt, at most one
// per prompt of the person's, so a check can never keep a session going by itself.
const FOLLOW_UPS_PER_PROMPT = 1
// "You should know" cards clear after two prompts from the person; so does the band.
const CLEAR_AFTER_PROMPTS = 2
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

const say = ($: EngineInterface, line: string) => $.ui.log(`deepseek-supervisor: ${line}`, { to: 'debug' })

// `on` and `off` are what the person chose; with neither, it runs where the built-in
// one is hidden: ANTHROPIC_BASE_URL set to a host that is not Anthropic's.
type Setting = 'auto' | 'on' | 'off'
const settingOf = async ($: EngineInterface): Promise<Setting> => {
  const v = await $.store.get('mode').catch(() => undefined)
  return v === 'on' || v === 'off' ? v : 'auto'
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

let steps = 0
let isBusy = false
let promptsSinceCards = 0
let followUps = 0
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
  $.ui.status(`deepseek-supervisor checking claims · ${told} noted` + (open === 0 ? '' : ` (${open} open)`) + (last === '' ? '' : ` · last: ${last}`))
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
    return { exitCode: r.exitCode as number | null, out: `${r.stdout}${r.stderr === '' ? '' : `\n[stderr]\n${r.stderr}`}`, ms: (await $.clock.now()) - start }
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
const boxOf = (home: string, real: readonly string[], writable: readonly string[]) =>
  [
    '(version 1)(allow default)',
    `(deny file-write* ${[home, ...new Set(real)].map(r => `(subpath ${JSON.stringify(r)})`).join(' ')})`,
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

/**
 * Checks claims by running commands. Open items that carry a recheck are
 * settled by code first: exit 0 is fixed, whatever anyone says. Never rejects.
 */
const verify = async ($: EngineInterface, input: VerifyInput): Promise<VerifyResult> => {
  const hasBox = (await $.process.run(['test', '-x', SANDBOX]).catch(() => undefined))?.exitCode === 0
  const home = (await $.process.run(['bash', '-c', 'printf %s "$HOME"']).catch(() => undefined))?.stdout ?? ''
  const copy = !hasBox || home === '' || input.cwd === '' ? undefined : await copyOf($, input.cwd).catch(() => undefined)
  const mode: Mode = copy === undefined ? 'read-only' : 'copy'
  const where = copy ?? input.cwd
  const realCopy = copy === undefined ? undefined : (await $.process.run(['realpath', copy]).catch(() => undefined))?.stdout.trim() || copy
  // The sandbox matches resolved paths: a workspace under /tmp is /private/tmp to it.
  const realCwd = !hasBox || input.cwd === '' ? '' : ((await $.process.run(['realpath', input.cwd]).catch(() => undefined))?.stdout.trim() ?? '')
  const box = !hasBox || home === '' ? undefined : boxOf(home, realCwd === '' ? [input.cwd] : [input.cwd, realCwd], copy === undefined ? [] : [copy, realCopy ?? copy])
  const result: VerifyResult = { mode, probes: [], fixed: [], ran: [], cost: { cached: 0, input: 0, output: 0, calls: 0 } }
  try {
    // Rechecks run only in a copy: they are the project's own commands and may write.
    if (mode === 'copy') {
      for (const i of input.open.filter(i => (i.recheck ?? '') !== '')) {
        const r = await runIn($, i.recheck ?? '', where, box)
        result.ran.push({ command: i.recheck ?? '', exitCode: r.exitCode, ms: r.ms })
        if (r.exitCode === 0) result.fixed.push({ id: i.id, saw: clip(squash(r.out), 300) || `\`${i.recheck}\` exited 0` })
      }
    }
    const toRecheck = input.open.filter(i => i.from === 'verify' && (mode !== 'copy' || (i.recheck ?? '') === ''))
    if (input.claims.length === 0) return result

    let transcript = verifyPrompt(input, mode, toRecheck)
    for (let round = 1; round <= ROUNDS; round++) {
      const final = round === ROUNDS
      const reply = await $.model.complete({ model: MODEL, prompt: final ? `${transcript}\n\nNo more commands: answer with the "checked" object now.` : transcript, maxTokens: 16000, timeoutMs: 180_000 })
      addCost(result.cost, reply.usage)
      if (!reply.isAnswered) return { ...result, reason: reply.reason }
      let turn = parseTurn(reply.text, input.claims)
      // One second chance for a reply that is not one JSON object.
      if (turn === null) {
        const again = await $.model.complete({ model: MODEL, prompt: `${transcript}\n\n[your reply]\n${clip(reply.text, 2000)}\n\nThat was not one JSON object. Answer again with exactly one JSON object and nothing else.`, maxTokens: 16000, timeoutMs: 180_000 })
        addCost(result.cost, again.usage)
        turn = again.isAnswered ? parseTurn(again.text, input.claims) : null
      }
      if (turn === null) return { ...result, reason: 'unreadable reply' }
      if ('checked' in turn) {
        result.probes = turn.checked
        for (const it of turn.items) if (it.status === 'fixed' && it.saw !== '' && toRecheck.some(i => i.id === it.id)) result.fixed.push({ id: it.id, saw: it.saw })
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

const IMAGE_WORDS = /图|画面|截图|chart|plot|image|figure|picture|graph/i

// A rule, not a model: an image made and never opened since, that the model has
// just said something about (named it, or spoke of a chart while at most 3 sit unopened).
const unopenedClaimed = (facts: Facts, claims: readonly string[]) =>
  facts.unopened
    .map(path => [path, claims.find(c => c.includes(base(path)) || (IMAGE_WORDS.test(c) && facts.unopened.length <= 3))] as const)
    .filter((x): x is readonly [string, string] => x[1] !== undefined)

// The model's own word that it told the person: `[ysk#3 told]`, `[ysk#3 refuted: …]`.
const TAG = /\[ysk#(\d+)\s+(told|refuted)\b[^\]]*\]/g

type Rows = { role: string; text: string; toolUses?: readonly { tool: string; input: unknown; text?: string; result?: unknown; isError?: true }[] }[]

// One check: the rule on images, the rechecks of open items, and the verifier on
// `claims`. Settles what it can and returns the new items; the caller delivers them.
const check = async ($: EngineInterface, claims: readonly string[], list: Rows, kind: 'during' | 'answer'): Promise<Issue[]> => {
  const at = await $.clock.now()
  const before = await read($, track)
  const facts = factsOf(list)
  const open = before.issues.filter(i => i.status === 'open')
  // During the work the verifier runs at most RUNS_PER_PROMPT checks per
  // prompt; a turn's answer is always checked.
  const canRun = kind === 'answer' || (before.runs ?? 0) < RUNS_PER_PROMPT
  const handed = canRun ? claims : []
  const rechecks = open.some(i => (i.recheck ?? '') !== '')
  const stillUnopened = new Set(facts.unopened)
  const images = unopenedClaimed(facts, claims)
  let v: VerifyResult | undefined
  if (handed.length > 0 || rechecks) {
    $.ui.status('deepseek-supervisor checking what the model said…')
    const fallback = list.find(r => r.role === 'user' && r.text.trim() !== '' && !r.text.includes('[deepseek-supervisor]'))?.text ?? ''
    v = await verify($, { claims: handed, asked: asked !== '' ? asked : fallback, facts, open, cwd: await $.session.cwd().catch(() => '') })
  }
  const done = await $.clock.now()
  let found: Issue[] = []
  await update($, track, t => {
    let issues = t.issues.map(i => {
      const f = v?.fixed.find(x => x.id === i.id)
      if (i.status !== 'open') return i
      if (f !== undefined) return { ...i, status: 'fixed' as const, settledAt: done, why: f.saw }
      if (i.from === 'rule' && i.probe.startsWith('Read ') && !stillUnopened.has(i.probe.slice(5))) return { ...i, status: 'fixed' as const, settledAt: done, why: `${base(i.probe.slice(5))} was opened with Read` }
      return i
    })
    const fresh: Issue[] = []
    for (const p of (v?.probes ?? []).filter(p => p.verdict === 'false')) {
      if ([...issues, ...fresh].some(i => isSameItem({ quote: p.claim }, i))) continue
      fresh.push({ id: t.nextId + fresh.length, at: done, from: 'verify', what: p.what, quote: p.claim, probe: p.command, saw: p.saw, recheck: p.recheck, cost: 'the person will act on a claim the output contradicts', status: 'open' })
    }
    for (const [path, claim] of images) {
      if ([...issues, ...fresh].some(i => i.probe === `Read ${path}`)) continue
      fresh.push({ id: t.nextId + fresh.length, at: done, from: 'rule', what: `${base(path)} was made and never opened since, yet the model has stated something about it`, quote: claim, probe: `Read ${path}`, cost: 'what the picture shows is asserted, not seen', status: 'open' })
    }
    found = fresh
    issues = [...issues, ...fresh].slice(-ISSUES_KEPT)
    const ran = v !== undefined && v.cost.calls > 0 && kind === 'during'
    return { ...t, nextId: t.nextId + fresh.length, issues, seen: [...(t.seen ?? []), ...handed].slice(-SEEN_KEPT), runs: (t.runs ?? 0) + (ran ? 1 : 0) }
  })
  if (v !== undefined)
    await remember($, {
      at: done,
      kind,
      mode: v.mode,
      claims: handed.length,
      probes: v.probes.map(p => ({ claim: p.claim, command: p.command, verdict: p.verdict, saw: p.saw })),
      fixed: v.fixed.map(f => f.id),
      found: found.map(i => i.id),
      ran: v.ran,
      reason: v.reason ?? null,
      cost: v.cost,
      ms: done - at,
    })
  say($, `CHECK ${JSON.stringify({ kind, claims: handed.length, found: found.map(i => i.id), fixed: v?.fixed.map(f => f.id) ?? [], reason: v?.reason })}`)
  return found
}

const newClaims = (texts: readonly string[], seen: readonly string[]) => {
  const known = new Set(seen)
  return [...new Set(texts.flatMap(claimsOf))].filter(c => !known.has(c)).slice(-CLAIMS_PER_RUN)
}

const showCards = async ($: EngineInterface, items: readonly Issue[]) => {
  const at = await $.clock.now()
  told += items.length
  last = `${items.length} at ${hhmm(at)}`
  promptsSinceCards = 0
  await update($, cards, () => ({ at, items: items.map(i => ({ what: `#${i.id} ${i.what}`, evidence: i.from === 'verify' ? `${i.probe} → ${i.saw ?? ''}` : i.quote, cost: i.cost })) }))
  await update($, isHidden, () => false)
}

// During the work: every MIN_GAP finished steps, the model's new claims.
const tick = async ($: EngineInterface) => {
  try {
    if (steps < MIN_GAP) return
    steps = 0
    const rows = await $.session.messages().catch(() => undefined)
    const list = (Array.isArray(rows) ? rows : []) as Rows
    const claims = newClaims(
      list.filter(r => r.role === 'assistant').map(r => r.text),
      (await read($, track)).seen ?? [],
    )
    const found = await check($, claims, list, 'during')
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

// When a turn ends: the answer's own claims, which no later step would check. What
// does not hold goes back to the model as one follow-up prompt, at most one per
// prompt of the person's.
const atAnswer = async ($: EngineInterface, answer: string) => {
  try {
    const at = await $.clock.now()
    // The model telling the person settles an item: it is then theirs to weigh.
    const tags = [...answer.matchAll(TAG)]
    if (tags.length > 0)
      await update($, track, t => ({
        ...t,
        issues: t.issues.map(i => {
          const m = tags.find(x => Number(x[1]) === i.id)
          return m === undefined || i.status !== 'open' ? i : { ...i, status: m[2] === 'refuted' ? ('refuted' as const) : ('told' as const), settledAt: at, why: m[0] }
        }),
      }))
    const claims = newClaims([answer], (await read($, track)).seen ?? [])
    if (claims.length === 0) return
    const rows = await $.session.messages().catch(() => undefined)
    const found = await check($, claims, (Array.isArray(rows) ? rows : []) as Rows, 'answer')
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

export const register: Register = on => {
  registerBand(on)

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command
      .register({ name: 'deepseek-supervisor', description: 'Checks what the model claims by running it: on, off, auto, log, or issues', argumentHint: '[on|off|auto|log|issues]' })
      .catch(err => say($, `command not registered: ${err}`))
    await show($)
    return result
  })

  // The person's prompts: what claims are checked against, a fresh budget, and the
  // band aging as "You should know" cards do.
  on('prompt.submit', async ($, e, next) => {
    const result = await next(e)
    if (e.origin.kind === 'composer' || e.origin.kind === 'bridge') {
      asked = e.text
      followUps = 0
      await update($, track, t => ({ ...t, runs: 0 })).catch(() => undefined)
      promptsSinceCards += 1
      if (promptsSinceCards >= CLEAR_AFTER_PROMPTS) await update($, cards, () => null).catch(() => undefined)
    }
    return result
  })

  // The main loop's finished steps; a subagent's are its own.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    if (e.agentId !== undefined || result.stopReason === null) return result
    steps += 1
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
    // Only a turn the model finished on its own: one the person interrupted says nothing.
    if (e.agentId !== undefined || e.reason !== 'answer' || !(await isOn($))) return result
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
            : t.issues.map(i => `#${i.id} [${i.status}] ${i.what}${i.from === 'verify' ? `\n   ran: ${i.probe}\n   saw: ${i.saw ?? ''}` : ''}${i.why === undefined ? '' : `\n   why: ${i.why}`}`).join('\n'),
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
