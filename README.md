# billion-context-pi-lean

[中文](README.zh-CN.md)

Context management for the [Pi coding agent](https://github.com/earendil-works/pi-coding-agent) that lets long sessions keep going: as context fills up, the model folds finished work into summary blocks, and the originals stay recoverable on demand.

This is a long-term maintained fork of [`billion-context-pi`](https://github.com/ranxianglei/billion-context-pi) **v0.1.83**. It keeps upstream's compression engine (ACP) and adds two things: **a cheap model can write the summaries**, and **fewer tokens are spent on context management itself**. Upstream has moved on to [`billion-context`](https://github.com/ranxianglei/billion-context); this fork stays on 0.1.83 and picks upstream fixes by hand. It is not affiliated with upstream.

## Main differences from upstream 0.1.83

| | Upstream 0.1.83 | This fork |
|---|---|---|
| Who writes summaries | The main model, usually the expensive one | A **dedicated summary model** of your choice, e.g. a cheap one; the main model only picks the ranges |
| Compression rules | Sent to the main model in every compression nudge | Sent only to the summary model |
| Summary quality | General compression rules; only length is checked | Also: user requests are kept apart from what tools showed; open items are split into user objectives, suggestions and unverified risks. A failed or malformed summary is not folded; the range waits for a later attempt |
| Tools and resident prompt | 5 context tools, about 5,800 tokens | `compress` + `acp_context`, about 700 tokens\* |
| System prompt | Returns a whole system prompt, which on Pi 1.x drops prompt additions from extensions loaded after it | Added as its own section; other extensions keep theirs |
| Sub-agent delegation, auto-update | Built in | Removed. Use a dedicated sub-agent extension; ACP still manages their sessions |

\* Measured on 0.1.69 with a `ceil(chars / 4)` estimate in a blank Pi process (tools and injected prompt only); not re-measured on 0.1.83.

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
pi install git:github.com/kunkun9527/billion-context-pi-lean
```

Append `@<tag>` to pin a version from [Releases](https://github.com/kunkun9527/billion-context-pi-lean/releases).

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
```

`dist/` is committed because Pi installs git packages without building them; commit it together with source changes. Maintenance notes: [MAINTENANCE.md](MAINTENANCE.md).

## License

MIT. Based on [`billion-context-pi`](https://github.com/ranxianglei/billion-context-pi) by ranxianglei and contributors (MIT), including the dedicated summary model from upstream PR #241.
