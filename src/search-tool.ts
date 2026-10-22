import { Type, type Static } from "typebox";
import type { AgentToolResult, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { searchBlocks, type SearchResult } from "acp-kernel";
import type { AcpRuntime } from "./runtime.js";
import { applyToolPromptOverrides, type ToolPromptOverrides } from "./surface.js";
import { buildSearchDocs } from "./search-index.js";
import { logThrow } from "./log.js";
import { PROXY_STAND_DOWN_MESSAGE } from "./proxy-detect.js";

const SearchParams = Type.Object({
    query: Type.String({ description: "Keywords to locate detail folded into compressed summaries or historical messages." }),
    limit: Type.Optional(Type.Number({ description: "Max results (default 10)." })),
});

type SearchArgs = Static<typeof SearchParams>;

export function makeSearchTool(runtime: AcpRuntime, overrides?: ToolPromptOverrides): ToolDefinition<typeof SearchParams> {
    return applyToolPromptOverrides({
        name: "search",
        label: "Search",
        description:
            "Search compressed blocks AND historical messages by keyword — currently visible (uncompressed) messages are NOT searched. Use to cheaply locate detail before unfolding. Returns ranked results with ref, size, preview, and the unfold command to retrieve full content.",
        promptSnippet: 'search({ query: "auth token" })',
        promptGuidelines: [
            "Search locates detail folded into summaries or past messages — cheaper than unfolding blind.",
            "Each result shows a ref (b3 block / m00350 message), size, and the exact unfold command for full content.",
            "Message hits link to the owning block — unfold that block to recover surrounding detail.",
        ],
        parameters: SearchParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<AgentToolResult<unknown>> {
        if (runtime.refused) return { details: undefined, content: [{ type: "text", text: runtime.refusalMessage ?? PROXY_STAND_DOWN_MESSAGE }] };
        let result: string;
        try {
            result = await handleSearch(params as SearchArgs, runtime, ctx);
            } catch (e) {
                logThrow("search", e, { sid: ctx.sessionManager.getSessionId(), query: (params as SearchArgs).query });
                throw e;
            }
            return { details: undefined, content: [{ type: "text", text: result }] };
        },
    }, overrides);
}

async function handleSearch(args: SearchArgs, runtime: AcpRuntime, ctx: ExtensionContext): Promise<string> {
    const { state } = await runtime.stateFor(ctx);
    const docs = buildSearchDocs(ctx, state);
    const msgCount = docs.filter((d) => d.kind === "message").length;
    const blockCount = docs.filter((d) => d.kind === "block").length;
    const results = searchBlocks(docs, args.query, { limit: args.limit });

    if (results.length === 0) {
        const blocks = state.blocks.length;
        return `No matches for "${args.query}" across ${blocks} block(s) and ${msgCount} historical message(s).`;
    }

    const lines = [`Found ${results.length} match(es) for "${args.query}" (searched ${blockCount} blocks + ${msgCount} messages):`];
    for (const r of results) lines.push("", formatResult(r));
    return lines.join("\n");
}

function formatResult(r: SearchResult): string {
    const sizeStr = r.tokens != null ? formatSize(r.tokens) : "";
    const meta = [
        r.kind === "message" ? `message ${r.ref}` : `block ${r.ref}`,
        r.role ? `(${r.role})` : "",
        `T${r.tier}`,
        `score:${r.score.toFixed(2)}`,
        sizeStr,
    ].filter(Boolean).join(" ");

    const header = `${meta}  "${truncate(r.title, 50)}"`;

    const unfoldHint = r.kind === "block"
        ? `→ unfold({ ref: "${r.ref}" })`
        : r.blockId
          ? `→ unfold({ ref: "${r.blockId}" })  (block containing message ${r.ref})`
          : `(message ${r.ref} is still visible in context)`;

    return `${header}\n  ${r.preview}\n  ${unfoldHint}`;
}

function truncate(s: string, n: number): string {
    if (s.length <= n) return s;
    return s.slice(0, n - 1) + "…";
}

function formatSize(tokens: number): string {
    if (tokens < 1000) return `${tokens}tok`;
    if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}K`;
    return `${(tokens / 1_000_000).toFixed(1)}M`;
}
