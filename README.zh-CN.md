# billion-context-pi-lean

[English](README.md)

[`billion-context-pi`](https://github.com/ranxianglei/billion-context-pi) **v0.1.83** 的长期维护分支，用于 [Pi coding agent](https://github.com/earendil-works/pi-coding-agent)。保留上游由模型驱动的上下文压缩（ACP），重点做两件事：**日常长会话稳定可用**，以及**尽量少花 token**，包括让便宜模型来写摘要。

上游现在推荐它的后继项目 [`billion-context`](https://github.com/ranxianglei/billion-context)。本仓库停留在 0.1.83 运行时，上游有值得要的修复时手工挑过来；与上游无隶属关系。

## 与上游 0.1.83 的区别

| | 上游 0.1.83 | 本仓库 |
|---|---|---|
| 谁写摘要 | 主模型（通常是贵的那个） | 可选**专用摘要模型**，比如便宜模型；主模型只挑压缩范围，写 1–2 句回退摘要 |
| 每次 Nudge 带的摘要规则 | 完整规则发给主模型 | 配了专用模型时，完整规则只发给它 |
| 重新压缩旧块 | 重发原始历史，再按 12 万字符掐头去尾 | 旧块摘要完整传入并要求原样继承；原文按摘要模型的窗口裁剪 |
| 主模型能否看到摘要 | 看不到（Pi 适配层丢掉了摘要消息），模型常常压缩完立刻解压 | 看得到，完整摘要就在 `compress` 调用里 |
| 模型可见工具 | `compress`、`decompress`、`search_context`、`acp_status`、`acp_cache` | `compress` + 一个 `acp_context` |
| 常驻提示 | 约 5,800 tokens | 约 700 tokens |
| 系统提示 | 替换 Pi 的提示，其它扩展追加的提示会丢 | 作为独立段落注入，其它扩展的提示保留 |
| 子代理（`acp_delegate`、fleet 面板） | 内置 | 已移除——这是上下文管理扩展，子代理请用专门的扩展 |
| 自动更新 | 默认开启 | 关闭 |

另外修复了：紧急截断没有真正作用到发出的请求、紧急截断会截掉最近一条用户消息、token 计量忽略新消息、`compress` 的 thinking 没计入、合并后的工具绕过“最近内容”策略、测试会写进真实的 `~/.pi`。细节和原因见 [MAINTENANCE.md](MAINTENANCE.md)。

上表的 token 数据测于 0.1.69：空白 Pi 0.85 进程，只计工具和注入的提示，按 `ceil(字符数 / 4)` 估算，尚未在 0.1.83 上重测。

## 安装

```bash
pi install git:github.com/kunkun9527/billion-context-pi-lean@v0.1.83-lean.7
```

专用摘要模型需要 Pi >= 1.x。不要与 `billion-context-pi` 或 `billion-context` 同时启用，否则工具和钩子会注册两次。启用后 Pi 自带的 compaction 会被取消。

## 用便宜模型写摘要

```text
/acp compact                    # 查看当前设置
/acp compact <provider/model>   # Pi 模型注册表里的任意模型，比如便宜模型
/acp compact session            # 用会话同一个模型，单独调用
/acp compact reset              # 恢复由主模型写摘要
```

设置保存为 `~/.pi/acp.json` 里的 `compressionModelId`（项目的 `.pi/acp.json` 优先）。请写 `provider/id`：多个 provider 下同名的裸 id 会被判为歧义。模型从 Pi 的实时注册表解析，扩展注册的 provider 也能用。注册表里有某个模型，不代表 provider 真能服务它：某个范围调用失败时，这个范围不压缩（稍后重试），`~/.pi/acp.log` 记录 `compression-model-failed`。模型根本解析不到、或宿主不支持嵌套调用时，才用主模型的回退摘要并给出警告。

摘要模型按规则原样保留路径、数值、决策和未完成目标；输出被长度上限截断时会被拒收，这个范围不压缩。

## 配置

`~/.pi/acp.json` 和 `<项目>/.pi/acp.json`。[CONFIGURATION.md](CONFIGURATION.zh-CN.md) 里的上游选项都适用，除了：`autoUpdate` 强制关闭；已移除的子代理配置（`delegate.*`、`displayUsage`、`delegatePrompt`）会被忽略；`promptSections.*` 不生效，因为本仓库注入自己的提示（会提示一次）。压缩时机可以按 provider 和模型单独调：

```json
{
  "compressionModelId": "<provider>/<便宜模型>",
  "compress": {
    "promptPack": "lean",
    "providers": {
      "<provider>": {
        "models": {
          "<主模型>": { "maxContextLimit": 0.4, "nudgeGrowthTokens": 70000, "minPressureBenefitTokens": 30000 }
        }
      }
    }
  }
}
```

## 模型可见工具

- `compress`：把已用完的消息范围折叠成摘要块。
- `acp_context`：`decompress`、`search_context`、`acp_status`、`acp_cache` 和 `help`，例如 `{ "op": "search_context", "args": { "query": "authentication" } }`。

## 已知限制

- 摘要模型偶尔会把自己的推理文字写在摘要开头（实测约 1/60 个块）。
- 内核（`acp-kernel@0.0.98`）的问题目前在适配层绕开，内核源码还没纳入仓库。

## 开发

```bash
npm ci
npm run check   # typecheck + 测试 + build + 外壳检查
```

Pi 用 git 安装时不会 build，所以 `dist/` 提交在仓库里，要和源码改动一起提交。详见 [MAINTENANCE.md](MAINTENANCE.md)。

## 协议与致谢

MIT。基于 ranxianglei 及贡献者的 [`billion-context-pi`](https://github.com/ranxianglei/billion-context-pi)（MIT），专用摘要模型移植自上游 PR #241。
