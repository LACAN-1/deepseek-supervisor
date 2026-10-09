import type { SessionMessage } from 'claude-code'

import type { Finding } from '../types'
import { sanitize } from './prompt'

// The reviewer is the same kind of model as the author, and makes things up the
// same way. Each finding must quote the conversation; a quote that is not in it
// means the finding was invented, and it is dropped before the model or the person
// ever sees it.

const HAYSTACK_LIMIT = 4_000_000
const MIN_QUOTE = 4

// Both sides the same way: the reviewer's quote went through sanitize, so the
// conversation does too; then width, case and runs of whitespace stop mattering.
export const normalize = (s: string) => sanitize(s.normalize('NFKC')).replace(/\s+/g, ' ').toLowerCase().trim()

// Every string the conversation holds: the person's words, the answers, each tool
// call's arguments and what came back. The reviewer may quote any of it.
export const haystackOf = (messages: readonly SessionMessage[]) => {
  const parts: string[] = []
  let size = 0
  const walk = (v: unknown, depth: number) => {
    if (size > HAYSTACK_LIMIT || depth > 12) return
    if (typeof v === 'string') {
      if (v !== '') {
        parts.push(v)
        size += v.length
      }
    } else if (Array.isArray(v)) for (const x of v) walk(x, depth + 1)
    else if (typeof v === 'object' && v !== null) for (const x of Object.values(v)) walk(x, depth + 1)
  }
  walk(messages, 0)
  return normalize(parts.join('\n'))
}

// A quote the reviewer cut with an ellipsis anyway is found when every piece is.
export const isGrounded = (quote: string, haystack: string) => {
  const pieces = quote
    .replace(/^["'“”‘’「」『』`]+|["'“”‘’「」『』`]+$/g, '')
    .split(/…|\.\.\./)
    .map(normalize)
    .filter(p => p !== '')
  return pieces.length > 0 && pieces.join('').length >= MIN_QUOTE && pieces.every(p => haystack.includes(p))
}

export const grounded = (findings: readonly Finding[], haystack: string | null) =>
  haystack === null ? { kept: [...findings], dropped: [] as Finding[] } : {
    kept: findings.filter(f => isGrounded(f.quote, haystack)),
    dropped: findings.filter(f => !isGrounded(f.quote, haystack)),
  }

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}… [${s.length - n} more characters]` : s)

const inputOf = (input: Record<string, unknown>) => {
  try {
    return clip(JSON.stringify(input), 1500)
  } catch {
    return '{}'
  }
}

// The conversation as an independent reviewer reads it: whole while it fits, else
// its opening (the request and the project's ground rules) and its newest stretch.
export const renderTranscript = (messages: readonly SessionMessage[], budget: number) => {
  const rows = messages.map(m => {
    const lines = [m.text === '' ? '' : `${m.role === 'user' ? 'USER' : 'ASSISTANT'}: ${clip(m.text, 6000)}`]
    for (const use of m.toolUses) {
      lines.push(`ASSISTANT called ${use.tool} ${inputOf(use.input)}`)
      if (use.text !== undefined) lines.push(`${use.isError ? 'TOOL ERROR' : 'TOOL RESULT'} (${use.tool}): ${clip(use.text, 3000)}`)
    }
    return lines.filter(l => l !== '').join('\n')
  }).filter(r => r !== '')

  const whole = rows.join('\n\n')
  if (whole.length <= budget) return whole

  const head: string[] = []
  let headSize = 0
  for (const r of rows) {
    if (headSize + r.length > budget * 0.2) break
    head.push(r)
    headSize += r.length + 2
  }
  const tail: string[] = []
  let tailSize = 0
  for (const r of rows.slice(head.length).reverse()) {
    if (tailSize + r.length > budget - headSize) break
    tail.unshift(r)
    tailSize += r.length + 2
  }
  const newest = rows.at(-1)
  if (tail.length === 0 && newest !== undefined && rows.length > head.length) tail.push(clip(newest, Math.max(0, budget - headSize)))
  const left = rows.length - head.length - tail.length
  return [...head, `[… ${left} earlier messages left out …]`, ...tail].join('\n\n')
}
