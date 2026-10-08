# deepseek-supervisor

**给接了第三方模型（比如 DeepSeek）的 Claude Code 补上 "You should know"。**

每隔几步，它分出一次旁路审查，看一眼会话到目前为止的工作。发现模型现在就该处理的问题，就直接告诉模型，同时在提示框上方把同样的条目显示给你。

[English](README.md)

## 为什么做

Claude Code 自带一个叫 "You should know" 的侧边代理，会看着 Claude 干活，把它注意到的问题提出来。但只要 `ANTHROPIC_BASE_URL` 指向的不是 Anthropic，它就会被隐藏：在 2.1.290 上，单这一个变量就能把它关掉。所以用 Claude Code 接 DeepSeek 或其他 Anthropic 兼容接口时，没有任何东西在看着它干活。

deepseek-supervisor 就是来补这个空的。它最初是为 DeepSeek 写的，但里面没有任何只针对 DeepSeek 的东西，任何兼容 Anthropic 接口的服务都能用。

## 它做什么

主循环每完成 6 步（和 "You should know" 的间隔相同，子代理的步数不算），它就分叉出一次审查。审查只找下面这几类问题：

- **悄悄选了一种读法**：你的要求有两种读法，结果不一样，模型没问就按其中一种做了。
- **发现了问题却没说**：它看到了不对的地方，没告诉你就继续往下做。
- **说法没有依据**：说"已验证""能跑""看着没问题"，却没有命令、数字或文件支撑；或者描述了一张根本没打开过的图。
- **没试过就说做不到。**
- **范围悄悄变大**，没有说明。
- **盲调**：连改几次都没效果，中间什么也没测。
- **说完成之后又改了文件**，没说改了哪些。

它默认什么都不说。每次最多报 2 条，已经说过的不再重复。发现会送到两个地方：

- **给模型**：作为一条提示，模型在下一步就会读到。提示里写明这是审查员的观察，不是你的指令，不授权你要求以外的任何事。这么写是因为审查读的会话记录里可能有来自网页的文本。
- **给你**：显示在提示框上方的一栏里，带一个 **Hide** 按钮。你再发两条消息后它会自动清掉，和 "You should know" 的卡片一样。

## 例子

一次真实运行，接的是 DeepSeek。要求是「会员打 5 折扣」，文件里其实已经实现了这个功能。第 6 步之后，模型收到了这条提示：

```
[deepseek-supervisor] A separate pass over your work so far (not the user) found 2 item(s) to handle now:
1. 会员折扣已经在 shop.py 里实现了，说完再动手改，别把已有代码当没写。
   evidence: shop.py 第 1、7 行 `MEMBER_DISCOUNT = 0.5` …；test_shop.py 已有 `test_member_gets_half_off`。
2. 确认「打 5 折扣」是打 5 折（×0.5）还是 5% off（×0.95），这两种读法结果差一倍。
   evidence: 请求原文「会员打 5 折扣」；代码现在按 ×0.5 实现，但没跟用户对过。
```

随后模型没有去动已有代码，跑了测试，最后反问用户到底是哪种读法。

## 需要什么

- 支持插件函数钩子的 Claude Code（有 `claude plugin validate` 和 `claude plugin test` 命令）。开发和测试都在 **2.1.290** 上进行。

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
| 状态栏 | `deepseek-supervisor watching · N noted · last: …`，待机时显示原因 |
| `/deepseek-supervisor on` / `off` | 不管接的是哪个接口，强制打开或关闭。关闭时也会清掉提示框上方那一栏 |
| `/deepseek-supervisor auto` | 恢复默认：只在非 Anthropic 接口上工作 |
| `/deepseek-supervisor log` | 最近 10 次审查，含发现的条目和 token 用量 |

插件的存储由这台机器上所有会话共用，里面放两样东西：on/off/auto 设置，所以 `off` 对所有会话都生效；最近 50 次审查，包括每条发现从对话里引用的证据。这些只存在本机，不会发到任何地方。

## 成本

每次审查都会分叉整个会话，也就是把完整上下文重读一遍，大部分命中缓存。会话很大时，一次审查要读几十万个缓存 token。对缓存读取很便宜的模型（比如 DeepSeek）来说花费很小；如果用的是贵模型，开之前先算一下。

## 已知局限

- **它不安静。** 作者自己用下来，它很少返回空列表，尽管提示词里写了"默认什么都不报"。报出来的条目大多具体、有证据，但忙的时候大约每几分钟就会来一条。
- **记性短。** 它只记得最近 12 条说过什么，所以同一件事偶尔会说两遍。
- **状态不会跨重载保留。** 步数和"已经说过"的清单都存在内存里，插件重载后从头开始。

## 开发

```bash
claude plugin validate .
claude plugin test .
```

Claude Code 第一次加载插件时，会把类型声明写进 `.claude-plugin/types/`；之后用 `tsc -p .` 就能做类型检查。

| 文件 | 作用 |
|---|---|
| `hooks/register.ts` | 计步、审查、给模型的提示、on/off/auto 开关、命令 |
| `hooks/prompt.ts` | 审查用的提示词，以及解析模型的回答 |
| `hooks/band.tsx` | 提示框上方那一栏 |
| `types/index.d.ts` | 审查条目的结构和插件状态的约定 |
| `tests/watch.test.ts` | 8 个测试，跑在 Claude Code 的插件测试工具上 |

## 许可证

MIT
