# deepseek-supervisor

**给接了第三方模型（比如 DeepSeek）的 Claude Code 加一道检查：模型说做完了的事，拿去跑一遍。**

模型一下结论（"测试全过""修好了""总价是 59.75""图是对的"），验证者就在你工作区的一次性副本里，跑最便宜的、能证明它不成立的命令。输出和结论对不上，模型拿到的是命令和输出，你在提示框上方看到同样的内容。

[English](README.md)

## 为什么做

Claude Code 自带一个旁路代理 "You should know"，看着 Claude 干活，把注意到的事情提出来。但只要 `ANTHROPIC_BASE_URL` 指向的不是 Anthropic，它就会被隐藏：在 Claude Code 2.1.290 上，单这一个变量就能把它关掉。所以用 Claude Code 接 DeepSeek 或其他兼容 Anthropic 的接口时，没有人在看着干活。

这个插件不是它的复制品。"You should know" 读对话记录、给人写卡片，由人来回应；这里读的一方是模型，而模型能做人看卡片时不会做的事：动手去跑。这个插件早先的版本照着 "You should know" 的样子，每 6 步读一遍对话记录提意见，结果那些意见模型引一句原话就能挡回去。所以现在改成：拿命令的输出去核对结论。

它是为 DeepSeek 做的，但里面没有任何 DeepSeek 专属的东西，接任何兼容 Anthropic 的接口都能用。

## 它做什么

**干活过程中**：主循环每走完 3 步（子代理的步数不算），代码把模型自上次检查以来写下的、断言某事成立的句子收集起来（"通过""修好""已验证""正确""完成"、passes、fixed、works……）。有新的，就交给验证者，同时附上你最近一次的提示，以及代码从工具调用里读出的事实：失败的命令（包括藏在 `| tail` 后面的 Traceback）、工具生成之后没人打开过的图、模型写过的文件。

**验证者**是插件自己跑的一个小循环：模型提出命令，命令在你工作区的克隆里执行，输出再交回模型；最多 6 轮，每轮最多 3 条命令，每条限 60 秒。它从结论里挑至多 3 条值得查的，逐条判定"成立 / 不成立 / 说不清"。判"不成立"必须带上它跑的命令和与结论矛盾的输出，缺了就不算。克隆用 `cp -c`（APFS 克隆，不拷数据），用完删掉。光靠克隆挡不住脚本写你的文件（项目脚本常写绝对路径），所以每条命令还在 macOS 沙箱（`sandbox-exec`）里跑：家目录和真实工作区一律禁写，克隆除外（其他位置如 `/tmp` 仍可写）。命令里写了你真实工作区路径的，一律拒跑。克隆不了（家目录、根目录、复制超过 60 秒），或者没有沙箱（不是 macOS）时，只允许跑只读命令，未关的条目也就没法靠复查命令关掉。

**不成立的结论变成编号条目**，带着模型的原话、跑的命令、输出，以及一条复查命令：结论成立时它的退出码恰好为 0。条目作为一条提示在下一步交给模型，同时显示在你的提示框上方。

**一轮结束时**，这一轮最终答复里的结论也按同样方式查一遍，因为之后不会再有步骤去查它。有不成立的，就把条目作为一次追加提示交还给模型。你每发一次提示，最多追加一次，所以检查永远不会自己把会话一直推下去。

**还有一条不用模型的规则**：模型对一张生成后从没打开过的图下了结论，就开一条条目，模型打开那张图后自动关闭。

## 条目怎么关

不看模型怎么说。

- **fixed**：每次检查都在新的克隆里重跑它的复查命令，退出码为 0 才算。模型写 `[ysk#3 fixed]` 关不掉任何条目。
- **told**：模型在答复里把这件事告诉了你，并写上 `[ysk#3 told]`。之后由你来判断。
- **refuted**：模型在给你的答复里说明克隆误导了检查（结论依赖工作区以外的东西），写 `[ysk#3 refuted: 原因]`。

提示里写明：这是检查观察到的情况，不是你的指令，不授权你要求范围以外的任何操作。因为它带着命令输出，而项目里可能有任何内容。

## 例子

一次接 DeepSeek 的真实运行（`deepseek-flash`，Claude Code 2.1.293，2026-10-09）。项目里有个 bug：`total()` 漏掉了第一项价格。一份交接说明写着"all tests pass and total() is correct"，模型被要求什么都别跑，就照着转述了。这一轮结束时，验证者在克隆里跑测试，看到 `AssertionError: 47.25 != 59.75`。模型收到的追加提示是：

```
[deepseek-supervisor] A separate check (not the person) found 1 item(s) that do not hold. It tested what you said by running commands in a throwaway copy of your workspace:
#1 The handover's claim is wrong: the suite fails, because shop.total() skips the first price (prices[1:]) and returns 47.25 instead of 59.75, so total() is not correct and not all tests pass.
   you wrote: Handover says: "Handover from the previous session: all tests pass and total() is correct."
   ran: python3 -m unittest test_shop -v 2>&1; echo exit=$?
   saw: test_empty ... ok / test_total ... FAIL / AssertionError: 47.25 != 59.75 / Ran 2 tests in 0.000s / FAILED (failures=1) / exit=1
   closes: when `python3 -m unittest test_shop` exits 0 (the check reruns it itself)
```

它读了 `shop.py`，改掉切片，重跑测试：`OK`，`exit=0`。那次检查用了 10 秒：3 次模型调用，约 1.7k 输入、2k 输出 token。

## 需要什么

- 支持插件函数钩子的 Claude Code（有 `claude plugin validate` 和 `claude plugin test` 命令）。在 **2.1.290** 上开发；0.6.0 在 **2.1.293** 上测试。需要 `bash` 和 `cp`。在克隆里跑检查需要 macOS（`sandbox-exec`）；其他系统只跑只读命令。

## 安装

在终端里运行：

```bash
claude plugin marketplace add LACAN-1/deepseek-supervisor
claude plugin install deepseek-supervisor@deepseek-supervisor
```

以后更新用 `claude plugin update deepseek-supervisor@deepseek-supervisor`。

也可以从克隆下来的目录只加载一次：`claude --plugin-dir /path/to/deepseek-supervisor`。如果没法加命令行参数（比如会话是别的应用启动的），把这个目录写进 `CLAUDE_CODE_PLUGIN_DIRS`。

**它只在需要的地方启动。** `ANTHROPIC_BASE_URL` 指向的不是 Anthropic 的地址时，它才开始检查。接 Anthropic 官方接口时它保持待机，因为自带的 "You should know" 已经在运行了。用 Bedrock 或 Vertex 时这个变量没有设置，如果想用它，运行 `/deepseek-supervisor on`。

## 使用

| | |
|---|---|
| 状态栏 | `deepseek-supervisor checking claims · N noted (M open) · last: …`，待机时显示原因 |
| `/deepseek-supervisor on` / `off` | 不管接的是哪个接口，强制打开或关闭。关闭时也会清掉提示框上方那一栏 |
| `/deepseek-supervisor auto` | 恢复默认：只在非 Anthropic 接口上工作 |
| `/deepseek-supervisor issues` | 本次会话的所有条目：各自的状态、跑的命令和输出、关闭依据 |
| `/deepseek-supervisor log` | 最近 10 次检查：查了哪些结论、跑过的每条命令（退出码、耗时、被拒的）、判定、token 用量 |

插件的存储由这台机器上所有会话共用，里面放两样东西：on/off/auto 设置，所以 `off` 对所有会话都生效；最近 50 次检查，包括结论原话和命令输出。这些只存在本机，不会发到任何地方。

## 成本

每次检查都是一次不带历史的新请求：只有结论、你的提示、事实，以及到目前为止的命令输出，不会重读整个会话。上面那次运行里，查最终答复用了约 1.7k 输入、2k 输出 token，共 3 次调用。重跑未关条目的复查命令只跑命令，不调模型。干活过程中，你每发一次提示，验证者最多做 8 次检查；每次检查最多调用 6 次模型（回复无法解析而重试时最多 12 次）。

命令在你的机器上、在克隆里、在沙箱里、用你的环境运行：就是项目自己的测试和脚本，和模型自己去跑时一样，只是除克隆外，写不到家目录和真实工作区。读不受限，网络也没断。

## 已知局限

- **它只查命令能推翻的东西。** 模型把错的事做对了，或者误解了你要什么，它说的话都成立，这道检查看不出来。
- **可能很慢。** 上面那次运行里，过程中的检查花了 72 秒（一次答复光推理就写了 1.8 万输出 token），等它的提示到达，那一轮已经结束了；最终答复的检查抓到了同一条结论。慢的检查从不拦模型，只是来得晚。
- **克隆不等于你的机器。** 依赖工作区以外东西的结论（正在跑的服务、别处的文件）在克隆里可能被判不成立。这时由模型用 `refuted` 告诉你。
- **结论检测放得很宽。** 交过去的句子大多不值得跑命令，验证者会被要求跳过它们；每次运行都有日志，可以看它挑了什么。
- **目前只有一次真实运行。** 上面的数字是 n=1。它漏掉了什么，还没有任何地方在统计。

## 开发

```bash
claude plugin validate .
claude plugin test .
```

Claude Code 第一次加载插件时，会把类型声明写进 `.claude-plugin/types/`；之后用 `tsc -p .` 就能做类型检查。

| 文件 | 作用 |
|---|---|
| `hooks/register.ts` | 什么时候查、验证者的循环（克隆、命令、模型调用）、关条目、给模型的提示和追加提示、on/off/auto 开关、命令 |
| `hooks/prompt.ts` | 结论检测、从工具调用读出的事实、验证者的提示词和对它答复的解析、什么命令能在哪里跑、给模型的提示 |
| `hooks/band.tsx` | 提示框上方那一栏 |
| `types/index.d.ts` | 条目的结构和插件状态的约定 |
| `tests/*.test.ts` | 16 个测试，跑在 Claude Code 的插件测试工具上 |

## 许可证

MIT
