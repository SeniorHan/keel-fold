# billion-context-pi-lean

<!-- token-benchmark:summary:start -->
> **Token benchmark: Lean 486, upstream `billion-context-pi@0.1.83` 8,670 — 94.4% fewer.**
<!-- token-benchmark:summary:end -->
> [See my full setup for Pi](https://github.com/kunkun9527/my-lean-pi-setup)

[中文](https://github.com/kunkun9527/billion-context-pi-lean/blob/main/README_zh-CN.md)

Context management for the [Pi coding agent](https://github.com/earendil-works/pi-coding-agent) that lets long sessions keep going: as context fills up, the model folds finished work into summary blocks, and the originals stay recoverable on demand.

This is a fork of [`billion-context-pi`](https://github.com/ranxianglei/billion-context-pi) **v0.1.83** that focuses on runtime stability and on spending fewer tokens. It keeps upstream's compression engine (ACP); the main additions are that **a cheap model can write the summaries**, that **context management itself costs fewer tokens**, and that **a long session is compressed while you are away**, before the prompt cache expires. Upstream has moved on to [`billion-context`](https://github.com/ranxianglei/billion-context); this fork stays on 0.1.83 and picks upstream fixes by hand. It is not affiliated with upstream.

## How it works

ACP does not compress on its own. When old, finished work piles up, it adds a short **compress nudge** to the next request, listing the message ranges that could be folded. The main model picks ranges and calls `compress`; the **summary model** (the main model itself unless you choose another) writes the summaries, and each range is replaced by its summary block. The originals stay in the session and can be brought back.

The model sees two tools:

- `compress`: fold finished message ranges into summary blocks.
- `acp_context`: `decompress`, `search_context`, `acp_status`, `acp_cache` and `help`, e.g. `{ "op": "search_context", "args": { "query": "authentication" } }`, to bring originals back or look things up.

With **Idle compact** on, the same nudge is also shown once when you step away, while the prompt cache is still warm, so you come back to a shorter context. When the [settings](#settings) make the nudge appear is up to you; as a last resort, at 95% of the window ACP cuts large tool outputs regardless.

## Main differences from upstream 0.1.83

| | Upstream 0.1.83 | This fork |
|---|---|---|
| Who writes summaries | The main model, usually the expensive one | A **dedicated summary model** of your choice, e.g. a cheap one; the main model only picks the ranges |
| Compression rules | Sent to the main model in every compression nudge (about 1,460 tokens; 720 with `promptPack: "lean"`) | Sent only to the summary model, so they no longer take up the main model's context; its nudge carries only a short range-picking note (about 220 tokens)\* |
| Summary quality | General compression rules; only length is checked | Also: user requests are kept apart from what tools showed; open items are split into user objectives, suggestions and unverified risks. A failed or malformed summary is not folded; the range waits for a later attempt |
| Coming back after a break | The first request rewrites the whole long context at uncached prices | **[Idle compact](#idle-compact)**: before the cache expires, the model gets one chance to compress, so the request you send on return is shorter |
| Settings | Edit `acp.json` by hand | **[`/acp-config`](#configuration) panel**: pick values in the TUI, applied at once without restarting; `acp.json` still works |
| Tools and resident prompt | 5 context tools + 3 delegation tools, about 8,700 tokens (4,900 with `promptPack: "lean"`) | `compress` + `acp_context`, 486 tokens ([benchmark](#context-footprint-benchmark)). The resident prompt keeps only rules needed before a call; the rest arrives with nudges, errors and tool results |
| System prompt | Returns a whole system prompt, which on Pi 1.x drops prompt additions from extensions loaded after it | Added as its own section; other extensions keep theirs |
| Sub-agent delegation, auto-update | Built in | Removed. Use a dedicated sub-agent extension; ACP still manages their sessions |

\* Estimated as `ceil(chars / 4)` from the length of the rule text in the nudge, not billed tokens.

<details>
<summary>Smaller upstream issues fixed in this fork</summary>

- Emergency truncation was computed but never reached the request.
- Emergency truncation could cut the latest user message.
- The token meter reused an old count and ignored newly added messages.
- Reasoning inside `compress` calls was not counted.
- Concurrent state saves could fail (`ENOENT` on a shared temp file), and releasing the session lock could let a later caller jump the queue.
- After `/tree` into the middle of a block, its summary could show decisions from messages the current branch never reached.
- Decompressing to a file failed on Windows when the message ref contained `|`.
- The test suite wrote into the real `~/.pi`.

Details: [CHANGELOG.md](CHANGELOG.md), [MAINTENANCE.md](MAINTENANCE.md) (Chinese).

</details>

## Context footprint benchmark

With only this extension enabled, its recurring model-facing initialization contribution is:

| Variant | Tool and prompt contribution | Total |
| --- | --- | ---: |
| Lean `billion-context-pi-lean@0.1.83-lean.10` | `compress` (231) + `acp_context` (87) + prompt (168) | **486** |
| Upstream `billion-context-pi@0.1.83` with `promptPack: "lean"` | `compress` (389) + `decompress` (271) + `search_context` (90) + `acp_status` (227) + `acp_cache` (204) + `acp_delegate` (1,452) + `acp_delegate_wait` (342) + `acp_delegate_cancel` (83) + prompt (1,819) | **4,877** |
| Upstream `billion-context-pi@0.1.83` | `compress` (549) + `decompress` (546) + `search_context` (210) + `acp_status` (339) + `acp_cache` (204) + `acp_delegate` (1,452) + `acp_delegate_wait` (342) + `acp_delegate_cancel` (83) + prompt (4,945) | **8,670** |

This saves **8,184 tokens (94.4%)** against upstream's default, and 4,391 tokens (90.0%) against its `lean` prompt pack. The three `acp_delegate*` tools (1,877 tokens) belong to sub-agent delegation, which this fork removed; leaving them out, the savings are 92.8% and 83.8%.

Compression nudges come on top of this and only when context fills up. With a dedicated summary model, the rules in each nudge drop from about 1,460 tokens to about 220 ([setup](#summary-model)).

Measured with `npm run measure` on Pi 1.3.0, each variant in a separate temporary process with an empty working directory and configuration. Built-in tools, skills, context files, session history, user messages, unrelated extensions, runtime UI, and slash commands are excluded; `before_agent_start` additions are included. Tokens are a fixed character-proxy estimate using `ceil(characters / 4)`, not provider tokenizer billing.

## Install

```bash
pi install npm:billion-context-pi-lean
```

Append `@<version>` to pin a version from [Releases](https://github.com/kunkun9527/billion-context-pi-lean/releases). Installing from git works too: `pi install git:github.com/kunkun9527/billion-context-pi-lean`.

- The dedicated summary model needs Pi 1.x or later.
- Do not enable it together with `billion-context-pi` or `billion-context`: tools and hooks would register twice.
- Pi's built-in compaction is turned off while this extension is active.

## Configuration

Settings live in `~/.pi/acp.json` (global) and `<project>/.pi/acp.json` (per project; it wins over the global file). There are two ways to change them:

- **`/acp-config`** (TUI) opens a settings panel with the settings below. Up/Down picks a setting, Enter or Space switches its value, Esc closes. Changes go to the global `~/.pi/acp.json` (other keys are kept) and apply at once; if the project file overrides a key, the panel tells you which value is in effect.
- **Edit `acp.json`** for anything the panel does not offer, or to set values per project or per provider.

### Settings

Ordered as in the panel, most used first. The names are the ones the panel shows.

| Setting | acp.json key | What it does | Default |
|---|---|---|---|
| Summary model | `compressionModelId` | Who writes the summaries ([details](#summary-model)). `main model` lets the main model write them; `session` reuses the current model and its cached prefix. In the panel, Enter opens the models Pi can use right now; type to filter. | `main model` |
| Idle compact | `idleCompact.enabled` | Compress once while you are away, before the prompt cache expires ([details](#idle-compact)). | `off` |
| Idle minutes | `idleCompact.idleMinutes` | Idle time before that turn. Keep it a little under your models' cache lifetime (29 fits a 30-minute cache). Locked at `off` while Idle compact is off; the stored minutes come back when you turn it on. | 29 |
| Context threshold | `compress.providers.<p>.models.<id>.maxContextLimit` | Share of the model's window above which the compress nudge stops waiting for Nudge interval and appears whenever Minimum benefit could be reclaimed. Lower keeps the context small; higher lets it run fuller. Not a hard cap. | 75% |
| Nudge interval | `….nudgeGrowthTokens` | Below Context threshold, the nudge waits until about this many tokens of old, compressible content have piled up. Bigger: fewer nudges, more folded at once. Smaller: frequent small compressions, a leaner context. | 50K |
| Minimum benefit | `….minPressureBenefitTokens` | No nudge, and no idle compact turn, when less than this could be reclaimed: rewriting a few thousand tokens is not worth breaking the cache. | larger of 5K and 1% of the window |
| Tool output cap | `toolOutputMaxBytes` | A single tool result larger than this is cut, with a note telling the model where the full output is ([tool guards](#tool-guards)). `off` keeps everything. | 50K bytes |
| bash default timeout | `toolBashDefaultTimeout` | Seconds a bash command may run when the model gave no timeout ([tool guards](#tool-guards)). `off` means no limit. | 60 |
| Debug log | `debug` | Writes detailed events to `~/.pi/acp.log` for troubleshooting. Errors and the main events are always logged. | `off` |

### Summary model

Besides the panel, `/acp compact` sets it from the command line:

```text
/acp compact                    # show the current setting
/acp compact <provider/model>   # any model in Pi's model registry
/acp compact session            # the session's own model, in a separate call
/acp compact reset              # the main model writes summaries again
```

- Write `provider/id`. A bare id shared by several providers is rejected as ambiguous.
- Models come from Pi's live registry, so providers registered by other extensions work too.
- A model being listed does not mean its provider can serve it. If the call fails, that range stays uncompressed and is retried next time; `~/.pi/acp.log` records `compression-model-failed`. Only when the model cannot be resolved at all, or the host cannot make nested calls, does the main model's short summary get used, with a warning.

### Idle compact

Coming back to a long session after the prompt cache expired means the first request rewrites the whole context uncached. With Idle compact on, after Idle minutes without activity ACP starts one idle compact turn that shows the main model the compress nudge; the model decides whether to compress.

```json
{ "idleCompact": { "enabled": true, "idleMinutes": 29 } }
```

- Idle minutes applies to every model. With a shorter cache (e.g. 5 minutes) the idle compact turn itself reads the long context uncached once.
- Activity means a real model request: your messages, but also a sub-agent waking the session, so long background work does not count as idle.
- Skipped when less than Minimum benefit could be reclaimed, outside TUI/RPC mode, or when the timer wakes more than a minute late (machine slept). At most one idle compact turn per idle period.
- During that turn only ACP tools may run. Typing, or a sub-agent result arriving, turns it into a normal turn.

### Compression timing per model

Context threshold, Nudge interval and Minimum benefit depend on the model's window and price, so the panel sets them for the **current model only**. Choosing `inherit` removes the model's own value; the provider-wide or global value (or the default) then applies. In `acp.json` you can set them at any of these levels:

```json
{
  "compressionModelId": "<provider>/<cheap-model>",
  "compress": {
    "promptPack": "lean",
    "providers": {
      "<provider>": {
        "models": {
          "<main-model>": { "maxContextLimit": 0.4, "nudgeGrowthTokens": 70000, "minPressureBenefitTokens": 30000 }
        }
      }
    }
  }
}
```

Independently of these, at 95% of the window ACP cuts large tool outputs as a last resort (`emergencyThresholdPercent`, acp.json only).

### Tool guards

Tool output cap and bash default timeout are not about compression; they stop single tool calls from blowing up the context or hanging the session.

- Tool output cap: Pi's own bash and read already stop at 50KB; the cap mainly catches MCP and other extensions' tools, which can return hundreds of KB at once.
- bash default timeout: Pi itself has no default timeout, so a stuck command would make the session wait forever. On timeout the model is told to re-run with a larger one.

ACP applies them through Pi's normal extension hooks (`tool_call` fills in the missing bash timeout, `tool_result` trims the oversized result), the same hooks any extension can use.

### Other options

Upstream options in [CONFIGURATION.md](CONFIGURATION.md) still apply in `acp.json`, except:

- `autoUpdate` is always off.
- The removed delegation keys (`delegate.*`, `displayUsage`, `delegatePrompt`) are ignored.
- `promptSections.*` is ignored because the fork injects its own prompt; you get a one-time warning.

## Development

```bash
npm ci
npm run check   # typecheck, tests, build and facade checks
npm run measure # tool + prompt footprint vs upstream (needs ../my-lean-pi-setup)
```

`dist/` is committed because Pi installs git packages without building them; commit it together with source changes. Maintenance notes: [MAINTENANCE.md](MAINTENANCE.md).

## License

MIT. Based on [`billion-context-pi`](https://github.com/ranxianglei/billion-context-pi) by ranxianglei and contributors (MIT), including the dedicated summary model from upstream PR #241.
