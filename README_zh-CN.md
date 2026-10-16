# billion-context-pi-lean

<!-- token-benchmark:summary:start -->
> **Token 基准：Lean 486，上游 `billion-context-pi@0.1.83` 8,670，减少 94.4%。**
<!-- token-benchmark:summary:end -->
> [查看我的完整 Pi 配置](https://github.com/kunkun9527/my-lean-pi-setup)

[English](README.md)

给 [Pi coding agent](https://github.com/earendil-works/pi-coding-agent) 用的上下文管理扩展，让长会话能一直做下去：上下文快满时，模型把做完的部分折叠成摘要块，原文随时可以取回。

本仓库是 [`billion-context-pi`](https://github.com/ranxianglei/billion-context-pi) **v0.1.83** 的分支，专注于运行稳定性和降低 token 消耗。它保留上游的压缩引擎（ACP），主要改动是：**摘要可以交给便宜模型写**，**上下文管理本身少花 token**。上游已转向 [`billion-context`](https://github.com/ranxianglei/billion-context)；本分支停在 0.1.83，按需手工挑选上游修复，与上游没有隶属关系。

## 上下文占用对比

只启用本扩展时，模型每次请求都会看到的初始化内容如下：

| 版本 | 工具与提示词构成 | 合计 |
| --- | --- | ---: |
| Lean `billion-context-pi-lean@0.1.83-lean.10` | `compress` (231) + `acp_context` (87) + 提示词 (168) | **486** |
| 上游 `billion-context-pi@0.1.83`，开 `promptPack: "lean"` | `compress` (389) + `decompress` (271) + `search_context` (90) + `acp_status` (227) + `acp_cache` (204) + `acp_delegate` (1,452) + `acp_delegate_wait` (342) + `acp_delegate_cancel` (83) + 提示词 (1,819) | **4,877** |
| 上游 `billion-context-pi@0.1.83` | `compress` (549) + `decompress` (546) + `search_context` (210) + `acp_status` (339) + `acp_cache` (204) + `acp_delegate` (1,452) + `acp_delegate_wait` (342) + `acp_delegate_cancel` (83) + 提示词 (4,945) | **8,670** |

比上游默认配置少 **8,184 token（94.4%）**，比上游开 `lean` 提示词包少 4,391 token（90.0%）。其中 3 个 `acp_delegate*` 工具（共 1,877 token）属于子代理委派，本分支已删除这项功能；不算它们的话，分别少 92.8% 和 83.8%。

压缩提示不在上表内，只在上下文快满时出现。配置专用摘要模型后，每次压缩提示里的规则从约 1,460 token 降到约 220（[配置方法](#用便宜模型写摘要)）。

在 Pi 1.3.0 上用 `npm run measure` 测得，每个版本各用一个临时进程，工作目录和配置都是空的。不计内置工具、skill、上下文文件、会话历史、用户消息、无关扩展、运行时 UI 和斜杠命令；计入 `before_agent_start` 追加的内容。Token 按 `ceil(字符数 / 4)` 固定估算，不是服务商分词器的计费数。

## 与上游 0.1.83 的主要区别

| | 上游 0.1.83 | 本分支 |
|---|---|---|
| 谁写摘要 | 主模型，通常是贵的那个 | 可指定**专用摘要模型**，比如便宜模型；主模型只负责选范围 |
| 压缩规则 | 每次压缩提示都发给主模型（约 1,460 token；`promptPack: "lean"` 时约 720） | 只发给摘要模型，不再占用主模型的上下文；主模型的压缩提示里只有一段约 220 token 的选范围说明\* |
| 摘要质量 | 通用压缩规则，只检查长度 | 另外：用户的要求和工具显示的内容分开记；待办分成用户目标、建议、未核实风险三类。调用失败或不合格的摘要不会折叠，这段留待下次再压缩 |
| 工具和常驻提示词 | 5 个上下文工具 + 3 个子代理工具，约 8,700 token（`promptPack: "lean"` 时约 4,900） | `compress` + `acp_context`，486 token（[对比](#上下文占用对比)）。常驻提示词只保留调用前必须知道的规则，其余说明随压缩提示、报错和工具结果给出 |
| 系统提示词 | 返回整份系统提示词，在 Pi 1.x 上会丢掉之后加载的扩展追加的提示词 | 作为独立段落注入，其他扩展的内容保留 |
| 子代理委派、自动更新 | 内置 | 已移除。子代理请用专门的扩展，它们的会话仍由 ACP 管理 |

\* 按压缩提示中规则文本的长度，以 `ceil(字符数 / 4)` 估算，不是计费 token。

<details>
<summary>本分支修好的上游小问题</summary>

- 紧急截断算出来了，却没有作用到实际请求上。
- 紧急截断可能截掉最新一条用户消息。
- token 计数沿用旧值，没有算上新增的消息。
- `compress` 调用里的思考内容没有计入 token。
- 并发保存状态可能失败（共用临时文件导致 `ENOENT`），释放会话锁时后来的调用者可能插队。
- 用 `/tree` 回到某个块的中间时，它的摘要可能带出当前分支还没走到的决定。
- 在 Windows 上，消息 ref 含 `|` 时解压到文件会失败。
- 测试会写进真实的 `~/.pi`。

详见 [CHANGELOG.md](CHANGELOG.md)、[MAINTENANCE.md](MAINTENANCE.md)。

</details>

## 安装

```bash
pi install npm:billion-context-pi-lean
```

要固定版本，在末尾加 `@<版本号>`，版本见 [Releases](https://github.com/kunkun9527/billion-context-pi-lean/releases)。也可以从 git 安装：`pi install git:github.com/kunkun9527/billion-context-pi-lean`。

- 专用摘要模型需要 Pi 1.x 及以上。
- 不要和 `billion-context-pi` 或 `billion-context` 同时启用，工具和钩子会注册两次。
- 启用本扩展期间，Pi 自带的压缩会关闭。

## 用便宜模型写摘要

```text
/acp compact                    # 查看当前设置
/acp compact <provider/model>   # Pi 模型注册表里的任意模型
/acp compact session            # 用会话当前的模型，单独调用
/acp compact reset              # 改回由主模型写摘要
```

设置保存为 `~/.pi/acp.json` 里的 `compressionModelId`（项目的 `.pi/acp.json` 优先）。

- 请写 `provider/id`。多个 provider 下同名的裸 id 会被判为有歧义。
- 模型从 Pi 的实时注册表解析，其他扩展注册的 provider 也能用。
- 注册表里有某个模型，不代表 provider 真能服务它。调用失败时这段不压缩，下次再试；`~/.pi/acp.log` 会记录 `compression-model-failed`。只有模型完全解析不到、或宿主不支持嵌套调用时，才改用主模型的短摘要，并给出警告。

## 配置

配置文件是 `~/.pi/acp.json` 和 `<项目>/.pi/acp.json`。[CONFIGURATION.zh-CN.md](CONFIGURATION.zh-CN.md) 里的上游选项照常可用，以下几项除外：

- `autoUpdate` 始终关闭。
- 已移除的委派配置（`delegate.*`、`displayUsage`、`delegatePrompt`）会被忽略。
- `promptSections.*` 会被忽略，因为本分支注入自己的提示词；会提示一次。

压缩时机可以按 provider 和模型分别调整：

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

## 模型能用的工具

- `compress`：把做完的消息范围折叠成摘要块。
- `acp_context`：包含 `decompress`、`search_context`、`acp_status`、`acp_cache` 和 `help`，例如 `{ "op": "search_context", "args": { "query": "authentication" } }`。

## 开发

```bash
npm ci
npm run check   # 类型检查、测试、构建和外壳检查
npm run measure # 对比上游的工具和提示词占用（需要同级目录 ../my-lean-pi-setup）
```

Pi 安装 git 包时不会构建，所以 `dist/` 要提交，并和源码改动放在同一个提交里。维护说明见 [MAINTENANCE.md](MAINTENANCE.md)。

## 协议与致谢

MIT。基于 ranxianglei 及贡献者的 [`billion-context-pi`](https://github.com/ranxianglei/billion-context-pi)（MIT），包括上游 PR #241 的专用摘要模型。
