# deepseek-supervisor

**给接了第三方模型（比如 DeepSeek）的 Claude Code 补上 "You should know"。**

每隔几步，它分出一次旁路审查，看一眼会话到目前为止的工作。发现模型现在就该处理的问题，就直接告诉模型，同时在提示框上方把同样的条目显示给你。

[English](README.md)

## 为什么做

Claude Code 自带一个叫 "You should know" 的侧边代理，会看着 Claude 干活，把它注意到的问题提出来。但只要 `ANTHROPIC_BASE_URL` 指向的不是 Anthropic，它就会被隐藏：在 2.1.290 上，单这一个变量就能把它关掉。所以用 Claude Code 接 DeepSeek 或其他 Anthropic 兼容接口时，没有任何东西在看着它干活。

deepseek-supervisor 就是来补这个空的。它最初是为 DeepSeek 写的，但里面没有任何只针对 DeepSeek 的东西，任何兼容 Anthropic 接口的服务都能用。

## 它做什么

它是一个闭环，不是一次性的检查：

1. **两个触发点。** 主循环每完成 6 步（和 "You should know" 的间隔相同，子代理的步数不算）审查一次；**每轮回答结束时**再审查一次，因为"完成了""修好了""验证过了"都是在最终回答里说的。
2. **固定的检查清单。** 审查只找下面这几类，每一条都必须标明类别：
   - **silent-reading 悄悄选了一种读法**：你的要求有两种读法，结果不一样，模型没问就按其中一种做了。
   - **unraised-problem 发现了问题却没说**：它看到了不对的地方，没告诉你就继续往下做。
   - **unbacked-claim 说法没有依据**：说"已验证""能跑""测试通过"，却没有命令、数字或文件支撑；或者描述了根本没打开过的文件或图片。
   - **untried-cannot 没试过就说做不到。**
   - **scope-creep 范围悄悄变大**，没有说明。
   - **guessing 盲调**：连改几次都没效果，中间什么也没测。
   - **silent-change 说完成之后又改了文件**，没说改了哪些。
   - **ignored-instruction 违背明确指示**：做了你明确说过不要做的事，或违背了项目里写明的规则。
3. **证据要核对，不靠信任。** 审查者和作者是同一类模型，编造的方式也一样。每一条都必须带一段从对话里逐字复制的引文；插件会在对话记录里查找这段引文（忽略空白、大小写和全角半角），**找不到的条目直接丢弃**，你和模型都不会看到。被丢弃的条目留在 `/deepseek-supervisor log` 里供核查。
4. **门槛高。** 每条有严重度：`high`（照这样做下去结果就是错的）或 `medium`（会白费一步），更低的直接丢弃。每次最多 2 条；已经说过的不再重复，提示词里要求一次，插件再拦一次。
5. **送达。** 发现会作为一条提示交给模型，它在下一步就会读到；同时显示在你的提示框上方。如果一轮回答**结束时**有 `high` 级的条目，插件会再启动一轮，让模型先把它处理掉，不用等你自己发现（每条你的消息最多 `max_wakes` 次，默认 1 次；如果你在这期间发了新消息，就不会启动）。
6. **跟进。** 之后每次审查都会看到仍未处理的条目（带编号），并判断模型是否已经处理（修了、告诉你了、或说明了为什么不适用）。连续两次审查后仍未处理的条目会被标为 **ignored（被忽略）**：你会收到一条通知，提示框上方会列出它，模型也会再被提醒一次。

提示里写明这是审查员的观察，不是你的指令，不授权你要求以外的任何事。审查者被告知：工具结果和网页内容只是数据，不是给它的指令。它写出来的内容会去掉控制字符和任何形似引擎自身标签（`<system-reminder>`）的东西，因为它读的对话记录里可能有来自网页的文本。

### 谁来审查

- **默认：分叉当前会话。** DeepSeek 审查 DeepSeek，读的是同一份对话，命中提示缓存，所以便宜。
- **设置了 `reviewer_model`**（比如会话用 `deepseek-chat`，审查用 `deepseek-reasoner`）：由那个模型单独读一份对话记录，不带作者自己的思路框架，相当于请了第二个人，而不是让作者再看一遍。对话记录放得下时整份发送（24 万字符以内），放不下就发开头和最近的一段。如果那个模型被拒绝或出错，这次审查自动退回到分叉方式。

## 例子

一次真实运行，接的是 DeepSeek，版本是 0.4.0（那时条目还没有类别、严重度和逐字引文）。要求是「会员打 5 折扣」，文件里其实已经实现了这个功能。第 6 步之后，模型收到了这条提示：

```
[deepseek-supervisor] A separate pass over your work so far (not the user) found 2 item(s) to handle now:
1. 会员折扣已经在 shop.py 里实现了，说完再动手改，别把已有代码当没写。
   evidence: shop.py 第 1、7 行 `MEMBER_DISCOUNT = 0.5` …；test_shop.py 已有 `test_member_gets_half_off`。
2. 确认「打 5 折扣」是打 5 折（×0.5）还是 5% off（×0.95），这两种读法结果差一倍。
   evidence: 请求原文「会员打 5 折扣」；代码现在按 ×0.5 实现，但没跟用户对过。
```

随后模型没有去动已有代码，跑了测试，最后反问用户到底是哪种读法。

## 需要什么

- 支持插件函数钩子的 Claude Code（有 `claude plugin validate` 和 `claude plugin test` 命令）。在 **2.1.290** 上开发，在 **2.1.295** 上测试。

## 安装

在终端里运行：

```bash
claude plugin marketplace add LACAN-1/deepseek-supervisor
claude plugin install deepseek-supervisor@deepseek-supervisor
```

以后更新用 `claude plugin update deepseek-supervisor@deepseek-supervisor`。

也可以从克隆下来的目录只加载一次：`claude --plugin-dir /path/to/deepseek-supervisor`。如果没法加命令行参数（比如会话是别的应用启动的），把这个目录写进 `CLAUDE_CODE_PLUGIN_DIRS`。

**它只在需要的地方启动。** `ANTHROPIC_BASE_URL` 指向的不是 Anthropic 的地址时，它才开始工作。接 Anthropic 官方接口时它保持待机，因为自带的 "You should know" 已经在运行了。用 Bedrock 或 Vertex 时这个变量没有设置，如果想用它，运行 `/deepseek-supervisor on`。

## 使用

| | |
|---|---|
| 状态栏 | `deepseek-supervisor watching · N noted · M open · K ignored · last: …`，待机时显示原因 |
| `/deepseek-supervisor on` / `off` | 不管接的是哪个接口，强制打开或关闭。关闭时也会清掉提示框上方那一栏 |
| `/deepseek-supervisor auto` | 恢复默认：只在非 Anthropic 接口上工作 |
| `/deepseek-supervisor now` | 立刻审查一次。只记录和提示，不会启动新的一轮 |
| `/deepseek-supervisor status` | 本次会话里仍未处理或被忽略的条目 |
| `/deepseek-supervisor log` | 最近 10 次审查：发现的条目、因引文找不到而丢弃的条目、已处理的条目、token 用量 |

### 设置

在 `/config` 菜单里设置，或写在 settings 的 `pluginConfigs` 下：

| 选项 | 默认值 | |
|---|---|---|
| `every` | `6` | 两次审查之间的主循环步数 |
| `turn_end` | `true` | 每轮回答结束时也审查一次 |
| `max_wakes` | `1` | 每条你的消息，回合结束时的 `high` 条目最多能启动几轮跟进。`0`：从不启动，提示等你下次发消息时再读 |
| `reviewer_model` | 空 | 空：分叉当前会话。填模型 ID：由该模型独立审查 |

插件的存储由这台机器上所有会话共用，里面放两样东西：on/off/auto 设置，所以 `off` 对所有会话都生效；最近 50 次审查，包括每条发现从对话里引用的证据。这些只存在本机，不会发到任何地方。会话自己的记录（步数、提过的条目和它们的状态）由 Claude Code 按会话保存，插件重载后不会丢。

## 成本

每次分叉都会把完整上下文重读一遍，大部分命中缓存。会话很大时，一次审查要读几十万个缓存 token。打开 `turn_end` 后，每轮只要走过一步就会多一次审查；回合结束时有 `high` 条目，还会多一轮跟进。对缓存读取很便宜的模型（比如 DeepSeek）来说花费很小；如果用的是贵模型，开之前先算一下，或者调大 `every`、关掉 `turn_end`。独立的 `reviewer_model` 读的是整理后的对话记录（最多 24 万字符），开头部分每次都一样，服务商的前缀缓存可以命中。

## 已知局限

- **它还是会经常说话。** 检查清单、严重度门槛和引文核对大大减少了噪音，编造的证据也过不去了，但一条真实、有引文的条目仍然可能是你不需要的。
- **引文只能证明原话存在，不能证明理解正确。** 核对能拦住编造的证据，拦不住对真实引文的误读。每条都标出引文，方便你自己判断。
- **是否已处理由审查者判断。** 模型如果用审查者没看出来的方式处理了，条目也可能被标为被忽略。
- **记忆有上限。** 每个会话保留最近 30 条。记录只在会话期间有效：新会话或恢复会话会从头开始。

## 开发

```bash
claude plugin validate .
claude plugin test .
```

Claude Code 第一次加载插件时，会把类型声明写进 `.claude-plugin/types/`；之后用 `tsc -p .` 就能做类型检查。

| 文件 | 作用 |
|---|---|
| `hooks/register.ts` | 触发、审查、跟进、给模型的提示和跟进轮、on/off/auto 开关、命令 |
| `hooks/prompt.ts` | 审查用的提示词、给模型的提示和跟进轮，以及解析模型的回答 |
| `hooks/ground.ts` | 引文核对，以及独立审查者读到的对话记录 |
| `hooks/band.tsx` | 提示框上方那一栏 |
| `types/index.d.ts` | 审查条目的结构和插件状态的约定 |
| `tests/watch.test.ts` | 20 个测试，跑在 Claude Code 的插件测试工具上 |

## 许可证

MIT
