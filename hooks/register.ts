import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelForkResult, PluginOptions, Register, SessionMessage, TurnStepResult } from 'claude-code'

import type { Ledger, Raised } from '../types'
import { registerBand } from './band'
import { grounded, haystackOf, normalize, renderTranscript } from './ground'
import type { Ask, PassKind } from './prompt'
import { REVIEWER_SYSTEM, forkPrompt, noteText, parseVerdict, reviewPrompt, wakeText } from './prompt'

// Claude Code's own "You should know" watches Claude at work, but it is hidden
// whenever ANTHROPIC_BASE_URL points away from Anthropic (observed on 2.1.290: that
// one variable alone), so it never loads on a third-party model. It checks every
// 6 steps (the constant read off the 2.1.290 binary); so does this, by default.
//
// The loop this closes, pass by pass:
//   1. a pass every few steps, and one more when the turn ends, where "done" is said;
//   2. every finding must quote the conversation verbatim, or it is dropped;
//   3. what is left reaches the model as a note, and the person in the band;
//   4. a high-severity finding at the end of a turn wakes the model to settle it;
//   5. later passes check each item was acted on; one left lying is shown to the
//      person as ignored.

// Its cards clear after two prompts from the person; so does the band.
const CLEAR_AFTER_PROMPTS = 2
// What the watcher has already said, the newest kept; every later pass skips it.
const RAISED_KEPT = 30
// An item still open after this many later passes was let lie: the person is told.
const ESCALATE_AFTER = 2
const HISTORY = 50
// What the independent reviewer reads of the conversation, in characters.
const TRANSCRIPT_BUDGET = 240_000

// The band's two values, drawn by hooks/band.tsx, and the watcher's own record. The
// scan wants every file that writes one to name it in a const of its own;
// types/index.d.ts holds them to one shape. All three are the host's: a reload keeps them.
const cards = atom({ plugin: 'deepseek-supervisor', key: 'cards' } as const, null)
const isHidden = atom({ plugin: 'deepseek-supervisor', key: 'isHidden' } as const, false)
const EMPTY: Ledger = { steps: 0, passes: 0, told: 0, last: '', promptsSinceCards: 0, wakes: 0, nextId: 1, raised: [] }
const ledger = atom({ plugin: 'deepseek-supervisor', key: 'ledger' } as const, EMPTY)

type Config = { every: number; turnEnd: boolean; maxWakes: number; reviewerModel: string }

const numberOf = (v: unknown, fallback: number, min: number, max: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : fallback

const configOf = (options: PluginOptions | undefined): Config => ({
  every: numberOf(options?.every, 6, 1, 100),
  turnEnd: options?.turn_end !== false,
  maxWakes: numberOf(options?.max_wakes, 1, 0, 5),
  reviewerModel: typeof options?.reviewer_model === 'string' ? options.reviewer_model.trim() : '',
})

const say = ($: EngineInterface, line: string) => $.ui.log(`deepseek-supervisor: ${line}`, { to: 'debug' })

// `on` and `off` are what the person chose; with neither, it runs where the built-in
// one is hidden: ANTHROPIC_BASE_URL set to a host that is not Anthropic's.
type Mode = 'auto' | 'on' | 'off'
const modeOf = async ($: EngineInterface): Promise<Mode> => {
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
  const mode = await modeOf($)
  return mode === 'auto' ? !(await onAnthropic($)) : mode === 'on'
}

// Only what dies with the module: a pass in flight dies with it too.
let isWatching = false
// A turn that ended while a pass was out: its answer, to look at once that pass is back.
let pendingFinal: string | null = null
// Bumped by every prompt from the person: a pass that finds it moved does not wake the model.
let promptEpoch = 0

const hhmm = (ms: number) => {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

const show = async ($: EngineInterface, cfg: Config) => {
  if (!(await isOn($)))
    return $.ui.status(
      (await modeOf($)) === 'off'
        ? 'deepseek-supervisor is off (/deepseek-supervisor on)'
        : 'deepseek-supervisor idle: Anthropic endpoint, where the built-in "You should know" runs (/deepseek-supervisor on to force)',
    )
  const l = await read($, ledger)
  const open = l.raised.filter(r => r.status === 'open').length
  const ignored = l.raised.filter(r => r.status === 'escalated').length
  $.ui.status(
    `deepseek-supervisor ${isWatching ? 'reviewing…' : 'watching'}` +
      (cfg.reviewerModel === '' ? '' : ` (${cfg.reviewerModel})`) +
      ` · ${l.told} noted` +
      (open === 0 ? '' : ` · ${open} open`) +
      (ignored === 0 ? '' : ` · ${ignored} ignored`) +
      (l.last === '' ? '' : ` · last: ${l.last}`),
  )
}

const remember = async ($: EngineInterface, entry: Record<string, unknown>) => {
  const old = await $.store.get('history').catch(() => [])
  const list = Array.isArray(old) ? old : []
  await $.store.set('history', [...list, entry].slice(-HISTORY)).catch(() => undefined)
}

const costOf = (usage: { cache_read_input_tokens?: number | null; input_tokens: number; output_tokens: number }) => ({
  cached: usage.cache_read_input_tokens ?? 0,
  input: usage.input_tokens,
  output: usage.output_tokens,
})

// The notes and wakes this watcher wrote are in the transcript too; a finding may not
// quote them back as its evidence.
const isOwn = (m: SessionMessage) => m.role === 'user' && m.text.includes('[deepseek-supervisor]')

// What a step's response said and did, for a fork whose prefix may end before it.
const latestOfStep = (result: TurnStepResult) =>
  clip(
    [
      result.answer,
      ...result.toolUses.map(u => {
        let input = ''
        try {
          input = JSON.stringify(u.input)
        } catch {
          // left out
        }
        return `[called ${u.name} ${clip(input, 600)}]`
      }),
    ]
      .filter(s => s !== '')
      .join('\n'),
    4000,
  )

type Reply = { result: ModelForkResult; reviewer: string }

// The reviewer: by default a fork of the session (same model, its prompt cache);
// with reviewer_model set, that model reads the transcript fresh, outside the
// author's own framing. A failed independent call falls back to the fork.
const review = async ($: EngineInterface, cfg: Config, ask: Ask, messages: readonly SessionMessage[] | null): Promise<Reply> => {
  if (cfg.reviewerModel !== '' && messages !== null) {
    try {
      const result = await $.model.complete({
        model: cfg.reviewerModel,
        system: [{ text: REVIEWER_SYSTEM, cache: true }],
        prompt: reviewPrompt(ask, renderTranscript(messages, TRANSCRIPT_BUDGET)),
        maxTokens: 4096,
        timeoutMs: 300_000,
      })
      if (result.isAnswered || result.reason === 'empty-reply') return { result, reviewer: cfg.reviewerModel }
      say($, `${cfg.reviewerModel} gave no verdict (${result.reason}${result.reason === 'api-error' ? ` ${result.status} ${result.error}` : ''}); falling back to a fork`)
    } catch (err) {
      say($, `${cfg.reviewerModel} refused (${err}); falling back to a fork`)
    }
  }
  return { result: await $.model.fork({ prompt: forkPrompt(ask) }), reviewer: 'fork' }
}

type PassOptions = { kind: PassKind; latest: string; canWake: boolean }

// One pass over the work so far. It runs beside the turn, never in its way: the
// items reach the model as a note it reads at its next step (or as a turn of their
// own when the turn ended on something it must not leave), and the band above the
// prompt shows the person the same items.
const watch = async ($: EngineInterface, cfg: Config, pass: PassOptions) => {
  const epoch = promptEpoch
  try {
    const before = await read($, ledger)
    const ask: Ask = {
      kind: pass.kind,
      open: before.raised.filter(r => r.status === 'open'),
      settled: before.raised.filter(r => r.status !== 'open'),
      latest: pass.latest,
    }

    const all = await $.session.messages().catch((err: unknown) => {
      say($, `transcript not readable, findings go unchecked (${err})`)
      return null
    })
    const messages = all === null ? null : all.filter(m => !isOwn(m))
    const haystack = messages === null ? null : `${haystackOf(messages)}\n${normalize(pass.latest)}`

    const { result: reply, reviewer } = await review($, cfg, ask, messages)
    const at = await $.clock.now()
    if (!reply.isAnswered) {
      say($, `no verdict (${reply.reason})`)
      await remember($, { at, kind: pass.kind, reviewer, reason: reply.reason })
      return
    }

    const verdict = parseVerdict(reply.text)
    const { kept, dropped } = grounded(verdict?.findings ?? [], haystack)
    // The prompt says not to repeat itself; this holds it to that.
    const known = new Set(before.raised.map(r => `${r.category}|${normalize(r.quote)}`))
    const fresh = kept.filter(f => !known.has(`${f.category}|${normalize(f.quote)}`))
    const resolved = new Set(verdict?.resolved ?? [])

    let ignored: Raised[] = []
    const after = await update($, ledger, l => {
      // An unreadable verdict says nothing of the open items either.
      const aged = l.raised.map((r): Raised => {
        if (r.status !== 'open' || verdict === null) return r
        if (resolved.has(r.id)) return { ...r, status: 'resolved' }
        const seen = r.seen + 1
        return { ...r, seen, status: seen >= ESCALATE_AFTER ? 'escalated' : 'open' }
      })
      ignored = aged.filter(r => r.status === 'escalated' && l.raised.find(o => o.id === r.id)?.status === 'open')
      const added = fresh.map((f, i): Raised => ({ ...f, id: `R${l.nextId + i}`, at, status: 'open', seen: 0 }))
      return {
        ...l,
        passes: l.passes + 1,
        told: l.told + fresh.length,
        last: fresh.length === 0 ? l.last : `${fresh.length} at ${hhmm(at)}`,
        nextId: l.nextId + fresh.length,
        raised: [...aged, ...added].slice(-RAISED_KEPT),
      }
    })

    await remember($, {
      at,
      kind: pass.kind,
      reviewer,
      readable: verdict !== null,
      findings: fresh,
      ungrounded: dropped,
      repeated: kept.length - fresh.length,
      resolved: [...resolved],
      ignored: ignored.map(r => r.id),
      cost: costOf(reply.usage),
    })
    say($, `WATCH ${pass.kind} ${JSON.stringify({ fresh, dropped: dropped.length, resolved: [...resolved], ignored: ignored.map(r => r.id) })}`)
    if (fresh.length === 0 && ignored.length === 0) return

    await update($, ledger, l => ({ ...l, promptsSinceCards: 0 }))
    await update($, cards, () => ({ at, items: fresh, ignored }))
    await update($, isHidden, () => false)
    if (ignored.length > 0)
      $.ui.toast(`deepseek-supervisor: the model has not acted on ${ignored.length} earlier item(s); see above the prompt`)

    // The turn ended on something that gives the person a wrong result: start a turn
    // that settles it, at most max_wakes times per prompt from the person, and never
    // over a prompt the person sent meanwhile.
    const urgent = fresh.filter(f => f.severity === 'high')
    if (pass.kind === 'final' && pass.canWake && urgent.length > 0 && after.wakes < cfg.maxWakes && epoch === promptEpoch) {
      await update($, ledger, l => ({ ...l, wakes: l.wakes + 1 }))
      const woke = await $.prompt
        .submit({ text: wakeText([...fresh, ...ignored]) })
        .then(r => r.drop === undefined)
        .catch((err: unknown) => {
          say($, `wake refused (${err})`)
          return false
        })
      if (woke) return
    }

    // Refused or failed, the items are still in the band: say so, so the person can pass them on.
    const note = await $.session
      .append({ message: { type: 'user', content: [{ type: 'text', text: noteText(fresh, ignored) }] } })
      .catch((err: unknown) => ({ deny: String(err) }))
    if (note.deny !== undefined) {
      say($, `note not delivered (${note.deny})`)
      $.ui.toast('deepseek-supervisor: a note did not reach the model; see the band above the prompt')
    }
  } catch (err) {
    say($, `watch failed: ${err}`)
  } finally {
    isWatching = false
    await show($, cfg).catch(() => undefined)
    // A turn ended while this pass was out: look at its answer now.
    if (pendingFinal !== null) {
      const latest = pendingFinal
      pendingFinal = null
      if ((await read($, ledger).catch(() => EMPTY)).steps > 0) start($, cfg, { kind: 'final', latest, canWake: true })
    }
  }
}

// Off the dispatch that asked for it, which closes when that hook returns: work that
// must outlive it runs from a timer (started straight from the hook, the pass
// stalled after the fork).
const start = ($: EngineInterface, cfg: Config, pass: PassOptions) => {
  isWatching = true
  $.clock.after(0, async () => {
    await update($, ledger, l => ({ ...l, steps: 0 })).catch(() => undefined)
    await show($, cfg).catch(() => undefined)
    await watch($, cfg, pass)
  })
}

const isPerson = (kind: string) => kind === 'composer' || kind === 'bridge' || kind === 'sdk'

export const register: Register = (on, options) => {
  const cfg = configOf(options)
  registerBand(on)

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command
      .register({
        name: 'deepseek-supervisor',
        description: 'Reviews the session at work and tells the model what it notices: on, off, auto, now, status, or log',
        argumentHint: '[on|off|auto|now|status|log]',
      })
      .catch(err => say($, `command not registered: ${err}`))
    await show($, cfg)
    return result
  })

  // The person's prompts age the band, as they age "You should know" cards, and
  // give the watcher back its wakes.
  on('prompt.submit', async ($, e, next) => {
    const result = await next(e)
    if (result.drop === undefined && isPerson(e.origin.kind)) {
      promptEpoch += 1
      const l = await update($, ledger, l => ({ ...l, promptsSinceCards: l.promptsSinceCards + 1, wakes: 0 }))
      if (l.promptsSinceCards >= CLEAR_AFTER_PROMPTS) await update($, cards, () => null)
    }
    return result
  }).catch(($, e, next) => next(e))

  // The watcher counts the main loop's finished steps; a subagent's are its own.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    if (e.agentId !== undefined || result.stopReason === null || !(await isOn($))) return result
    const l = await update($, ledger, l => ({ ...l, steps: l.steps + 1 }))
    // The step that ends the turn is the end-of-turn pass's to look at.
    const endsTurn = result.stopReason === 'end_turn' && cfg.turnEnd
    if (l.steps >= cfg.every && !isWatching && !endsTurn) start($, cfg, { kind: 'step', latest: latestOfStep(result), canWake: false })
    return result
  })

  // Where the turn ends, the assistant tells the person what it did: the claims
  // worth checking are there.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (!cfg.turnEnd || e.agentId !== undefined || e.reason !== 'answer' || !(await isOn($))) return result
    if ((await read($, ledger)).steps === 0) return result
    if (isWatching) pendingFinal = clip(e.answer, 4000)
    else start($, cfg, { kind: 'final', latest: clip(e.answer, 4000), canWake: true })
    return result
  })

  on('command.run', { command: 'deepseek-supervisor' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'log') {
      const list = await $.store.get('history').catch(() => [])
      return { text: Array.isArray(list) && list.length > 0 ? JSON.stringify(list.slice(-10), null, 1) : 'No checks yet.' }
    }
    if (arg === 'status') {
      const l = await read($, ledger)
      const lines = l.raised
        .filter(r => r.status !== 'resolved')
        .map(r => `${r.id} [${r.status === 'escalated' ? 'IGNORED' : 'open'} · ${r.severity} · ${r.category}] ${r.what}`)
      return { text: `${l.passes} pass(es), ${l.told} item(s) noted.` + (lines.length === 0 ? ' Nothing open.' : `\n${lines.join('\n')}`) }
    }
    if (arg === 'now') {
      if (isWatching) return { text: 'A pass is already under way.' }
      // The person is at the prompt: the pass notes, and does not start a turn.
      start($, cfg, { kind: 'final', latest: '', canWake: false })
      return { text: 'deepseek-supervisor: a pass is under way; its items will show above the prompt.' }
    }
    if (arg === 'on' || arg === 'off' || arg === 'auto') {
      if (arg === 'auto') await $.store.delete('mode')
      else await $.store.set('mode', arg)
      if (!(await isOn($))) await update($, cards, () => null)
      await show($, cfg)
      return { text: `deepseek-supervisor is ${arg}${arg === 'auto' ? ` (${(await isOn($)) ? 'watching' : 'idle on Anthropic\'s endpoint'})` : ''}.` }
    }
    const mode = await modeOf($)
    return { text: `deepseek-supervisor is ${mode}${mode === 'auto' ? ` (${(await isOn($)) ? 'watching' : 'idle on Anthropic\'s endpoint'})` : ''}. Usage: /deepseek-supervisor [on|off|auto|now|status|log]` }
  })
}
