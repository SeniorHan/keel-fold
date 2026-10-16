# billion-context-pi-lean

<!-- token-benchmark:summary:start -->
> **Token benchmark: Lean 486, upstream `billion-context-pi@0.1.83` 8,670 — 94.4% fewer.**
<!-- token-benchmark:summary:end -->
> [See my full setup for Pi](https://github.com/kunkun9527/my-lean-pi-setup)

[中文](https://github.com/kunkun9527/billion-context-pi-lean/blob/main/README_zh-CN.md)

Context management for the [Pi coding agent](https://github.com/earendil-works/pi-coding-agent) that lets long sessions keep going: as context fills up, the model folds finished work into summary blocks, and the originals stay recoverable on demand.

This is a fork of [`billion-context-pi`](https://github.com/ranxianglei/billion-context-pi) **v0.1.83** that focuses on runtime stability and on spending fewer tokens. It keeps upstream's compression engine (ACP); the main additions are that **a cheap model can write the summaries** and that **context management itself costs fewer tokens**. Upstream has moved on to [`billion-context`](https://github.com/ranxianglei/billion-context); this fork stays on 0.1.83 and picks upstream fixes by hand. It is not affiliated with upstream.

## Context footprint benchmark

With only this extension enabled, its recurring model-facing initialization contribution is:

| Variant | Tool and prompt contribution | Total |
| --- | --- | ---: |
| Lean `billion-context-pi-lean@0.1.83-lean.10` | `compress` (231) + `acp_context` (87) + prompt (168) | **486** |
| Upstream `billion-context-pi@0.1.83` with `promptPack: "lean"` | `compress` (389) + `decompress` (271) + `search_context` (90) + `acp_status` (227) + `acp_cache` (204) + `acp_delegate` (1,452) + `acp_delegate_wait` (342) + `acp_delegate_cancel` (83) + prompt (1,819) | **4,877** |
| Upstream `billion-context-pi@0.1.83` | `compress` (549) + `decompress` (546) + `search_context` (210) + `acp_status` (339) + `acp_cache` (204) + `acp_delegate` (1,452) + `acp_delegate_wait` (342) + `acp_delegate_cancel` (83) + prompt (4,945) | **8,670** |

This saves **8,184 tokens (94.4%)** against upstream's default, and 4,391 tokens (90.0%) against its `lean` prompt pack. The three `acp_delegate*` tools (1,877 tokens) belong to sub-agent delegation, which this fork removed; leaving them out, the savings are 92.8% and 83.8%.

Compression nudges come on top of this and only when context fills up. With a dedicated summary model, the rules in each nudge drop from about 1,460 tokens to about 220 ([setup](#use-a-cheap-model-for-summaries)).

Measured with `npm run measure` on Pi 1.3.0, each variant in a separate temporary process with an empty working directory and configuration. Built-in tools, skills, context files, session history, user messages, unrelated extensions, runtime UI, and slash commands are excluded; `before_agent_start` additions are included. Tokens are a fixed character-proxy estimate using `ceil(characters / 4)`, not provider tokenizer billing.

## Main differences from upstream 0.1.83

| | Upstream 0.1.83 | This fork |
|---|---|---|
| Who writes summaries | The main model, usually the expensive one | A **dedicated summary model** of your choice, e.g. a cheap one; the main model only picks the ranges |
| Compression rules | Sent to the main model in every compression nudge (about 1,460 tokens; 720 with `promptPack: "lean"`) | Sent only to the summary model, so they no longer take up the main model's context; its nudge carries only a short range-picking note (about 220 tokens)\* |
| Summary quality | General compression rules; only length is checked | Also: user requests are kept apart from what tools showed; open items are split into user objectives, suggestions and unverified risks. A failed or malformed summary is not folded; the range waits for a later attempt |
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

## Install

```bash
pi install npm:billion-context-pi-lean
```

Append `@<version>` to pin a version from [Releases](https://github.com/kunkun9527/billion-context-pi-lean/releases). Installing from git works too: `pi install git:github.com/kunkun9527/billion-context-pi-lean`.

- The dedicated summary model needs Pi 1.x or later.
- Do not enable it together with `billion-context-pi` or `billion-context`: tools and hooks would register twice.
- Pi's built-in compaction is turned off while this extension is active.

## Use a cheap model for summaries

```text
/acp compact                    # show the current setting
/acp compact <provider/model>   # any model in Pi's model registry
/acp compact session            # the session's own model, in a separate call
/acp compact reset              # the main model writes summaries again
```

The choice is saved as `compressionModelId` in `~/.pi/acp.json` (a project's `.pi/acp.json` takes precedence).

- Write `provider/id`. A bare id shared by several providers is rejected as ambiguous.
- Models come from Pi's live registry, so providers registered by other extensions work too.
- A model being listed does not mean its provider can serve it. If the call fails, that range stays uncompressed and is retried next time; `~/.pi/acp.log` records `compression-model-failed`. Only when the model cannot be resolved at all, or the host cannot make nested calls, does the main model's short summary get used, with a warning.

## Configuration

Config files are `~/.pi/acp.json` and `<project>/.pi/acp.json`. Upstream options in [CONFIGURATION.md](CONFIGURATION.md) still apply, except:

- `autoUpdate` is always off.
- The removed delegation keys (`delegate.*`, `displayUsage`, `delegatePrompt`) are ignored.
- `promptSections.*` is ignored because the fork injects its own prompt; you get a one-time warning.

Compression timing can be tuned per provider and model:

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

## Tools the model sees

- `compress`: fold finished message ranges into summary blocks.
- `acp_context`: `decompress`, `search_context`, `acp_status`, `acp_cache` and `help`, e.g. `{ "op": "search_context", "args": { "query": "authentication" } }`.

## Development

```bash
npm ci
npm run check   # typecheck, tests, build and facade checks
npm run measure # tool + prompt footprint vs upstream (needs ../my-lean-pi-setup)
```

`dist/` is committed because Pi installs git packages without building them; commit it together with source changes. Maintenance notes: [MAINTENANCE.md](MAINTENANCE.md).

## License

MIT. Based on [`billion-context-pi`](https://github.com/ranxianglei/billion-context-pi) by ranxianglei and contributors (MIT), including the dedicated summary model from upstream PR #241.
