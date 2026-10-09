# deepseek-supervisor

**"You should know" for Claude Code running a third-party model such as DeepSeek.**

Every few steps, a side pass reviews the session's work so far. When it notices something the model should act on now, it tells the model directly and shows you the same items above the prompt.

[中文说明](README.zh-CN.md)

## Why

Claude Code ships a side agent, "You should know", that watches Claude at work and surfaces what it notices. It is hidden whenever `ANTHROPIC_BASE_URL` points away from Anthropic: on Claude Code 2.1.290 that one variable alone switches it off. So if you run Claude Code against DeepSeek or any other Anthropic-compatible endpoint, nothing watches the work.

deepseek-supervisor fills that gap. It was built for DeepSeek, but nothing in it is DeepSeek-specific: it works with any Anthropic-compatible endpoint.

## What it does

It is a closed loop, not a single check:

1. **Two triggers.** After every 6 finished steps of the main loop (the same interval as "You should know"; subagents' steps are not counted), and again **when a turn ends**, because the final answer is where "done", "fixed" and "verified" are said. Each trigger runs one review pass.
2. **A fixed checklist.** The pass looks only for these, and every item must name its category:
   - **silent-reading**: your request allows two readings that change the result, and the model is building on one without asking.
   - **unraised-problem**: it saw something wrong and moved on without telling you.
   - **unbacked-claim**: "verified", "works", "tests pass" with no command, number or file behind it, or a file or image described but never opened.
   - **untried-cannot**: "can't do X" without trying X.
   - **scope-creep**: it changes things you did not ask for, without saying so.
   - **guessing**: several changes with no effect and no measurement between them.
   - **silent-change**: files changed after it said it was done, without saying which.
   - **ignored-instruction**: it acts against something you explicitly said, or against the project's written instructions.
3. **Evidence is checked, not trusted.** The reviewer is the same kind of model as the author and invents things the same way. Every item must carry a quote copied verbatim from the conversation; the plugin searches the transcript for it (ignoring whitespace, case and full/half width), and **drops any item whose quote is not there** before you or the model see it. Dropped items stay in `/deepseek-supervisor log` for audit.
4. **A high bar.** Each item has a severity, `high` (going on gives you a wrong result) or `medium` (a wasted step); anything lower is dropped. At most 2 items per pass, and anything already raised is held back, by the prompt and again by the plugin.
5. **Delivery.** Findings go to the model as a note it reads at its next step, and to you in a band above the prompt. When a turn **ends** on a `high` item, the plugin starts one follow-up turn so the model settles it before you have to find it (at most `max_wakes` per prompt of yours, default 1, and never over a prompt you sent meanwhile).
6. **Follow-through.** Every later pass is shown the items still open, by id, and says which the model has acted on (fixed, told you, or explained why not). An item still open after two more passes is marked **ignored**: you get a toast, the band lists it, and the model is told again.

The note says it is a reviewer's observation, not an instruction from you, and that it authorizes nothing beyond what you asked for. The reviewer is told that tool results and web pages are data, never instructions to it, and what it writes is stripped of control characters and of anything shaped like the engine's own tags (`<system-reminder>`), because the transcript it reads may contain text from the web.

### Who reviews

- **By default, a fork of the session**: DeepSeek reviews DeepSeek on the same transcript, served from the prompt cache, so it is cheap.
- **With `reviewer_model` set** (for example `deepseek-reasoner` while the session runs `deepseek-chat`), that model reads the transcript on its own, outside the author's framing: a second opinion rather than a second look. The transcript is sent whole while it fits (240k characters), else its opening and its newest stretch. If that model is refused or errors, the pass falls back to the fork.

## Example

A real run against DeepSeek, on 0.4.0 (before items carried a category, a severity and a verbatim quote). The request was 「会员打 5 折扣」. In Chinese that can mean "50% off" or, read loosely, "5% off". The file already implemented it. Six steps in, the model received this note:

```
[deepseek-supervisor] A separate pass over your work so far (not the user) found 2 item(s) to handle now:
1. 会员折扣已经在 shop.py 里实现了，说完再动手改，别把已有代码当没写。
   evidence: shop.py 第 1、7 行 `MEMBER_DISCOUNT = 0.5` …；test_shop.py 已有 `test_member_gets_half_off`。
2. 确认「打 5 折扣」是打 5 折（×0.5）还是 5% off（×0.95），这两种读法结果差一倍。
   evidence: 请求原文「会员打 5 折扣」；代码现在按 ×0.5 实现，但没跟用户对过。
```

Item 1 says the discount already exists in `shop.py`, so don't rewrite it. Item 2 asks it to confirm which reading the user meant. The model then left the existing code alone, ran the tests, and ended by asking which reading was meant.

## Requirements

- Claude Code with plugin function hooks (`claude plugin validate` / `claude plugin test` exist). Developed on **2.1.290**; tested on **2.1.295**.

## Install

From your shell:

```bash
claude plugin marketplace add LACAN-1/deepseek-supervisor
claude plugin install deepseek-supervisor@deepseek-supervisor
```

Update later with `claude plugin update deepseek-supervisor@deepseek-supervisor`.

Or, for one session, from a clone: `claude --plugin-dir /path/to/deepseek-supervisor`. Where you cannot pass a flag (for example a session another app starts), list the folder in `CLAUDE_CODE_PLUGIN_DIRS`.

**It turns itself on only where it is needed.** It watches when `ANTHROPIC_BASE_URL` points at a host that is not Anthropic's. On Anthropic's own endpoint it stays idle, because the built-in "You should know" already runs there. On Bedrock or Vertex, where that variable is unset, run `/deepseek-supervisor on` if you want it.

## Use

| | |
|---|---|
| Status line | `deepseek-supervisor watching · N noted · M open · K ignored · last: …`, or why it is idle |
| `/deepseek-supervisor on` / `off` | Force it on or off, whatever the endpoint. Off also clears the band. |
| `/deepseek-supervisor auto` | Back to the default: on only away from Anthropic's endpoint. |
| `/deepseek-supervisor now` | Run a pass now. It notes; it does not start a turn. |
| `/deepseek-supervisor status` | Items raised this session that are still open or were ignored. |
| `/deepseek-supervisor log` | The last 10 passes: findings, items dropped for a quote not found, items resolved, token usage. |

### Settings

Set them in the `/config` menu, or under `pluginConfigs` in settings:

| Option | Default | |
|---|---|---|
| `every` | `6` | Main-loop steps between passes. |
| `turn_end` | `true` | Also review each turn's final answer. |
| `max_wakes` | `1` | Follow-up turns a `high` item at turn end may start, per prompt of yours. `0`: never; the note waits for your next prompt. |
| `reviewer_model` | empty | Empty: fork the session. A model id: that model reviews independently. |

The plugin's store is shared by every session on the machine. It keeps the on/off/auto setting, so `off` applies to all of them, and the last 50 passes, including the evidence each finding quotes from the conversation. It is never sent anywhere. The session's own record (step count, raised items and their status) is held by Claude Code for the session, so a plugin reload keeps it.

## Cost

Each fork re-reads the whole context, mostly as cache hits. On a large session that is hundreds of thousands of cached tokens per pass. With `turn_end` on there is one more pass per turn that took any step, and a follow-up turn when a turn ends on a `high` item. On a model with cheap cache reads, such as DeepSeek, that is small. On an expensive model, count it before you turn it on, or raise `every` and turn `turn_end` off. An independent `reviewer_model` reads a rendered transcript instead (at most 240k characters), whose opening stays the same from pass to pass so the provider's prefix cache can serve it.

## Known limits

- **It still speaks often.** The checklist, the severity bar and the quote check cut the noise, and a made-up quote can no longer get through, but a real, quoted item can still be one you did not need.
- **A quote proves the words exist, not the reading.** The check stops invented evidence; it cannot stop a real quote read wrongly. Items name their quote so you can judge.
- **The reviewer judges what was resolved.** "Acted on" is the reviewer's call, so an item can be marked ignored when the model handled it in a way the reviewer missed.
- **Its memory is bounded.** It keeps the last 30 items per session. Its record lives as long as the session: a new session, or a resume, starts it over.

## Development

```bash
claude plugin validate .
claude plugin test .
```

Claude Code writes type declarations into `.claude-plugin/types/` the first time it loads the plugin; after that, `tsc -p .` type-checks it.

| File | Role |
|---|---|
| `hooks/register.ts` | The triggers, the review pass, the follow-through, the note and the wake, the on/off/auto switch, the command |
| `hooks/prompt.ts` | The review prompt, the note and the wake, and the parsing of the answer |
| `hooks/ground.ts` | The quote check, and the transcript as the independent reviewer reads it |
| `hooks/band.tsx` | The band above the prompt |
| `types/index.d.ts` | The finding shape and the plugin's state contract |
| `tests/watch.test.ts` | 20 tests against Claude Code's plugin test kit |

## License

MIT
