# billion-context-pi-lean

[中文](README.zh-CN.md)

A long-term maintained fork of [`billion-context-pi`](https://github.com/ranxianglei/billion-context-pi) **v0.1.83** for the [Pi coding agent](https://github.com/earendil-works/pi-coding-agent). It keeps upstream's model-driven context compression (ACP) and focuses on two things: **staying stable for daily long sessions** and **spending as few tokens as possible**, including letting a cheap model write the summaries.

Upstream now recommends its successor [`billion-context`](https://github.com/ranxianglei/billion-context). This fork stays on the 0.1.83 runtime and cherry-picks upstream fixes when they matter; it is not affiliated with upstream.

## Differences from upstream 0.1.83

| | Upstream 0.1.83 | This fork |
|---|---|---|
| Who writes summaries | The main (usually expensive) model | Optional **dedicated summary model**, e.g. a cheap one; the main model only picks ranges and writes a 1–2 sentence fallback |
| Summary rules in every nudge | Full rules sent to the main model | Only to the summary model when one is configured |
| Re-compressing old blocks | Raw history re-sent, then cut to 120K chars head/tail | Earlier block summaries are passed in whole and carried forward; raw text is sized to the summary model's window |
| Summary visible to the main model | No (Pi adapter drops the summary messages), so models often decompress right after compressing | Yes, the full summary sits in the `compress` call |
| Model-facing tools | `compress`, `decompress`, `search_context`, `acp_status`, `acp_cache` | `compress` + one `acp_context` tool |
| Resident prompt | ~5,800 tokens | ~700 tokens |
| System prompt | Replaces Pi's prompt, so other extensions' prompt additions are dropped | Injected as its own section; other extensions keep theirs |
| Delegation, auto-update | On | Off |

Also fixed: emergency truncation that never reached the wire, emergency truncation cutting the latest user message, a token meter that ignored new messages, uncounted `compress` thinking, facade tools escaping recency policies, and tests writing into the real `~/.pi`. Details and reasons are in [MAINTENANCE.md](MAINTENANCE.md) (Chinese).

Token figures above were measured on 0.1.69 with a `ceil(chars / 4)` proxy in a blank Pi 0.85 process (tools and injected prompt only); they have not been re-measured on 0.1.83.

## Install

```bash
pi install git:github.com/kunkun9527/billion-context-pi-lean@v0.1.83-lean.6
```

Requires Pi >= 1.x for the dedicated summary model. Do not enable it together with `billion-context-pi` or `billion-context`: tools and hooks would register twice. Pi's built-in compaction is cancelled while this extension is active.

## Cheap summary model

```text
/acp compact                    # show the current setting
/acp compact <provider/model>   # any model in Pi's model registry, e.g. a cheap one
/acp compact session            # same model as the session, separate call
/acp compact reset              # main model writes summaries again
```

The choice is saved as `compressionModelId` in `~/.pi/acp.json` (a project's `.pi/acp.json` wins). Use `provider/id`: a bare id shared by several providers is ambiguous. Models come from Pi's live registry, so providers registered by extensions work too. A model being listed does not mean the provider can serve it: when the call fails, the block keeps the main model's fallback summary and `~/.pi/acp.log` records `compression-model-failed`.

Summaries are written by the summary model with rules that keep paths, numbers, decisions and open objectives verbatim. Its output is rejected (fallback kept) when it hits the output limit.

## Configuration

`~/.pi/acp.json` and `<project>/.pi/acp.json`. All upstream options in [CONFIGURATION.md](CONFIGURATION.md) apply, except: `delegate.*`, `delegatePrompt` and `autoUpdate` are forced off, and `promptSections.*` is ignored because the fork injects its own prompt (a one-time warning tells you). Compression timing can be tuned per provider and model:

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

## Model-facing tools

- `compress`: fold consumed message ranges into summary blocks.
- `acp_context`: `decompress`, `search_context`, `acp_status`, `acp_cache` and `help`, e.g. `{ "op": "search_context", "args": { "query": "authentication" } }`.

## Known limitations

- The summary model occasionally prefixes a summary with its own reasoning text (about 1 in 60 blocks observed).
- Kernel (`acp-kernel@0.0.98`) bugs are worked around in the adapter; the kernel source is not vendored yet.

## Development

```bash
npm ci
npm run check   # typecheck + tests + build + facade checks
```

`dist/` is committed because Pi installs git packages without building; commit it together with source changes. See [MAINTENANCE.md](MAINTENANCE.md).

## License

MIT. Based on [`billion-context-pi`](https://github.com/ranxianglei/billion-context-pi) by ranxianglei and contributors (MIT), including the dedicated summary model from upstream PR #241.
