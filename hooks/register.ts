import { atom, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Finding } from '../types'
import { registerBand } from './band'
import { noteText, parseFindings, watchPrompt } from './prompt'

// Claude Code's own "You should know" watches Claude at work, but it is hidden
// whenever ANTHROPIC_BASE_URL points away from Anthropic (observed on 2.1.290: that
// one variable alone), so it never loads on a third-party model. It checks every
// CHECK_EVERY = 6 steps (the constant read off the 2.1.290 binary); so does this.
const CHECK_EVERY = 6
// Its cards clear after two prompts from the person; so does the band.
const CLEAR_AFTER_PROMPTS = 2
// What the watcher has already said, the newest kept; every later pass skips it.
const RAISED_KEPT = 12
const HISTORY = 50

// The band's two values, drawn by hooks/band.tsx. The scan wants every file that
// writes one to name it in a const of its own; types/index.d.ts holds both to one shape.
const cards = atom({ plugin: 'deepseek-supervisor', key: 'cards' } as const, null)
const isHidden = atom({ plugin: 'deepseek-supervisor', key: 'isHidden' } as const, false)

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

let raised: Finding[] = []
let steps = 0
let isWatching = false
let promptsSinceCards = 0
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
      (await modeOf($)) === 'off'
        ? 'deepseek-supervisor is off (/deepseek-supervisor on)'
        : 'deepseek-supervisor idle: Anthropic endpoint, where the built-in "You should know" runs (/deepseek-supervisor on to force)',
    )
  $.ui.status(`deepseek-supervisor watching · ${told} noted` + (last === '' ? '' : ` · last: ${last}`))
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

// One pass over the work so far. It runs beside the turn, never in its way: the
// items reach the model as a note it reads at its next step, and the band above the
// prompt shows the person the same items.
const watch = async ($: EngineInterface) => {
  try {
    const reply = await $.model.fork({ prompt: watchPrompt(raised) })
    if (!reply.isAnswered) {
      say($, `no verdict (${reply.reason})`)
      return
    }
    const findings = parseFindings(reply.text)
    const at = await $.clock.now()
    await remember($, { at, findings, cost: costOf(reply.usage), readable: findings !== null })
    say($, `WATCH ${JSON.stringify(findings)}`)
    if (findings === null || findings.length === 0) return

    raised = [...raised, ...findings].slice(-RAISED_KEPT)
    told += findings.length
    last = `${findings.length} at ${hhmm(at)}`
    promptsSinceCards = 0
    await update($, cards, () => ({ at, items: findings }))
    await update($, isHidden, () => false)
    // Refused or failed, the items are still in the band: say so, so the person can pass them on.
    const note = await $.session
      .append({ message: { type: 'user', content: [{ type: 'text', text: noteText(findings) }] } })
      .catch((err: unknown) => ({ deny: String(err) }))
    if (note.deny !== undefined) {
      say($, `note not delivered (${note.deny})`)
      $.ui.toast('deepseek-supervisor: a note did not reach the model; see the band above the prompt')
    }
  } catch (err) {
    say($, `watch failed: ${err}`)
  } finally {
    isWatching = false
    await show($)
  }
}

export const register: Register = on => {
  registerBand(on)

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command
      .register({ name: 'deepseek-supervisor', description: 'Watches the session at work and tells the model what it notices: on, off, auto, or log', argumentHint: '[on|off|auto|log]' })
      .catch(err => say($, `command not registered: ${err}`))
    await show($)
    return result
  })

  // The person's prompts age the band, as they age "You should know" cards.
  on('prompt.submit', async ($, e, next) => {
    const result = await next(e)
    if (e.origin.kind === 'composer' || e.origin.kind === 'bridge') {
      promptsSinceCards += 1
      if (promptsSinceCards >= CLEAR_AFTER_PROMPTS) await update($, cards, () => null).catch(() => undefined)
    }
    return result
  })

  // The watcher counts the main loop's finished steps; a subagent's are its own.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    if (e.agentId !== undefined || result.stopReason === null) return result
    steps += 1
    if (steps >= CHECK_EVERY && !isWatching && (await isOn($))) {
      steps = 0
      isWatching = true
      // Off the step's own dispatch, which closes when the step ends: work that
      // must outlive it runs from a timer (started straight from the hook, the
      // pass stalled after the fork).
      $.clock.after(0, () => {
        void watch($)
      })
    }
    return result
  })

  on('command.run', { command: 'deepseek-supervisor' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'log') {
      const list = await $.store.get('history').catch(() => [])
      return { text: Array.isArray(list) && list.length > 0 ? JSON.stringify(list.slice(-10), null, 1) : 'No checks yet.' }
    }
    if (arg === 'on' || arg === 'off' || arg === 'auto') {
      if (arg === 'auto') await $.store.delete('mode')
      else await $.store.set('mode', arg)
      if (!(await isOn($))) await update($, cards, () => null)
      await show($)
      return { text: `deepseek-supervisor is ${arg}${arg === 'auto' ? ` (${(await isOn($)) ? 'watching' : 'idle on Anthropic\'s endpoint'})` : ''}.` }
    }
    const mode = await modeOf($)
    return { text: `deepseek-supervisor is ${mode}${mode === 'auto' ? ` (${(await isOn($)) ? 'watching' : 'idle on Anthropic\'s endpoint'})` : ''}. Usage: /deepseek-supervisor [on|off|auto|log]` }
  })
}
