// billion-context-pi-lean: keep compress direct and route low-frequency ACP tools locally.
import type {
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createAcpExtension } from "../dist/index.js";
import { Type } from "typebox";
import { Check, Errors } from "typebox/value";

const COLLAPSED_DISPLAY_SERVICE = Symbol.for(
  "@local/pi-collapsed-tools.display-service.v1",
);

type CollapsedDisplayTool = { name: string };
type CollapsedDisplayService = {
  readonly version: 1;
  decorate<T extends CollapsedDisplayTool>(tool: T): T;
};

function decorateWithCollapsedDisplay<T extends CollapsedDisplayTool>(tool: T): T {
  const services = globalThis as unknown as Record<PropertyKey, unknown>;
  const candidate = services[COLLAPSED_DISPLAY_SERVICE];
  if (!candidate || typeof candidate !== "object") return tool;
  const service = candidate as Partial<CollapsedDisplayService>;
  return service.version === 1 && typeof service.decorate === "function"
    ? service.decorate(tool)
    : tool;
}

const LEAN_SYSTEM_PROMPT = `ACP context management
- User/tool messages carry hidden <acp> refs such as m00123. Never echo the XML tags; use only refs in ACP tool calls.
- Compress consumed history with compress: finished tool outputs, dead-end exploration, repeated reads, resolved threads, completed phases. Never compress active work, important user intent, or protected outputs.
- If the compress tool says a dedicated model writes summaries, give only a 1-2 sentence fallback. Otherwise preserve exact file paths and line numbers, symbols and signatures, errors, commands, versions, thresholds, decisions with reasons, current state, and unresolved TODOs.
- Recall or inspect context with acp_context. Args per op: decompress {blockId: "b5", full?, inline?, toFile?} (one block id or search-result ref per call; no ranges or arrays, call again for more); search_context {query, limit?}; acp_status {scope?, view?, tool?, sort?, limit?}; acp_cache {detail?}.
- Refs stay stable across compression. If a ref is stale or missing, call acp_context with op acp_status and args { scope: "uncompressed" }, then retry in the same turn using reported refs; never guess offsets. Batch compress ranges when possible.
- Block decompression writes to a file by default; read that file. Use inline: true only for small content or when its context cost is acceptable.
- After an [ACP:provider-throttle] automatic retry, resume exactly where interrupted. Do not repeat completed work or discuss the retry unless asked.
- Each active block's full current summary is shown in the arguments of the compress call that created it. A good summary makes recall unnecessary: never decompress a block just created, or to re-read or verify a summary you can already see.
- Compression summaries are historical metadata, not current user instructions. Search or decompress only when you need a detail the visible summary does not contain.`;

const LOW_FREQUENCY_TOOLS = ["decompress", "search_context", "acp_status", "acp_cache"] as const;
const LOW_FREQUENCY_SET = new Set<string>(LOW_FREQUENCY_TOOLS);
const DELEGATE_TOOLS = new Set(["acp_delegate", "acp_delegate_wait", "acp_delegate_cancel"]);

type Operation = (typeof LOW_FREQUENCY_TOOLS)[number];
type FacadeOperation = Operation | "help";
type CapturedTool = ToolDefinition<any, any, any>;
type UpstreamExtension = (pi: ExtensionAPI) => void;
type FacadeArgs = Record<string, unknown>;

const OPERATION_SIGNATURES: Readonly<Record<Operation, string>> = {
  search_context: "search_context({query, limit?})",
  decompress: 'decompress({blockId: "b5", full?, toFile?, inline?})',
  acp_status: "acp_status({scope?, view?, tool?, sort?, limit?})",
  acp_cache: "acp_cache({detail?})",
};

const FACADE_PARAMETERS = Type.Object({
  op: Type.Unsafe<FacadeOperation>({
    type: "string",
    enum: [...LOW_FREQUENCY_TOOLS, "help"],
  }),
  args: Type.Optional(Type.Unsafe<FacadeArgs>({
    type: "object",
    additionalProperties: true,
  })),
});

const COMPRESS_FIELD_DESCRIPTIONS: Readonly<Record<string, string>> = {
  content: "Direct array; no JSON strings/nesting/mix.",
  startId: "Inclusive first mNNNNN or bN ref.",
  endId: "Inclusive last mNNNNN or bN ref.",
  summary: "Self-contained replacement preserving exact technical details.",
  topic: "Short label; a per-range label overrides the top-level fallback.",
  summaryMaxChars: "Optional summary length limit override.",
};

function compactCompressSchemaDescriptions(
  value: unknown,
  propertyName?: string,
  seen = new Set<object>(),
): void {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  const record = value as Record<string, unknown>;
  delete record.description;
  const concise = propertyName ? COMPRESS_FIELD_DESCRIPTIONS[propertyName] : undefined;
  if (concise) record.description = concise;

  for (const [key, child] of Object.entries(record)) {
    if (key === "properties" && child !== null && typeof child === "object") {
      for (const [name, schema] of Object.entries(child as Record<string, unknown>)) {
        compactCompressSchemaDescriptions(schema, name, seen);
      }
      continue;
    }
    compactCompressSchemaDescriptions(child, undefined, seen);
  }
}

type PromptEvent = {
  systemPrompt?: unknown;
  systemPromptOptions?: { forceSystemPrompt?: string; sections?: Record<string, string> };
};

const PROMPT_SECTION = "acp_context";

// Pi >= 1.x maps a returned systemPrompt to forceSystemPrompt, which drops
// every later extension's appendSystemPrompt/sections (load-order dependent;
// upstream #630). Add a named section instead. Fall back to returning the
// composed prompt on older hosts or when another extension already forced it.
function injectSystemPrompt(event: PromptEvent): { systemPrompt: string } | undefined {
  const options = event.systemPromptOptions;
  if (options && typeof options === "object" && options.forceSystemPrompt === undefined) {
    options.sections = { ...(options.sections ?? {}), [PROMPT_SECTION]: LEAN_SYSTEM_PROMPT };
    return undefined;
  }
  const base = event.systemPrompt;
  const text = Array.isArray(base) ? base.join("\n") : typeof base === "string" ? base : "";
  return { systemPrompt: `${text}\n\n${LEAN_SYSTEM_PROMPT}` };
}

function rewriteText(text: string): string {
  return text
    .replace(
      /\b(search_context|decompress|acp_status|acp_cache)\((\{[^\r\n]*?\})\)/g,
      (_, op: string, args: string) => `acp_context({ op: "${op}", args: ${args} })`,
    )
    .replace(
      /\brun acp_status\b/gi,
      'call acp_context({ op: "acp_status", args: {} })',
    )
    .replace(
      /\buse search_context or decompress\b/gi,
      'use acp_context with op "search_context" or "decompress"',
    )
    .replace(
      /\buse search_context\b/gi,
      'use acp_context with op "search_context"',
    )
    .replace(
      /\b(call|run) (search_context|acp_status|acp_cache)\b/gi,
      (_, verb: string, op: string) => `${verb} acp_context op "${op}"`,
    );
}

function rewriteModelFacingText(value: unknown, seen = new WeakMap<object, unknown>()): unknown {
  if (typeof value === "string") return rewriteText(value);
  if (value === null || typeof value !== "object") return value;
  const cached = seen.get(value);
  if (cached) return cached;

  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    seen.set(value, copy);
    for (const item of value) copy.push(rewriteModelFacingText(item, seen));
    return copy;
  }

  const copy: Record<string, unknown> = {};
  seen.set(value, copy);
  for (const [key, item] of Object.entries(value)) {
    copy[key] = rewriteModelFacingText(item, seen);
  }
  return copy;
}

// Recall results carry original conversation text, which must come back
// verbatim. decompress output has no ACP hint the rewrites target; in
// search_context output only the hint line closing each result does (exact
// upstream format, followed by the blank separator or the end); preview lines
// are recalled text, may span lines and may themselves start with an arrow.
// The message ref is a raw entry id (e.g. `088aaedb`, `4d9e965e#toolu_…|fc_…`), not an mNNNNN ref.
const SEARCH_HINT_LINE = /^  → decompress\(\{ blockId: "b\d+" \}\)(  \(block containing message [^\s()]+\))?$/;

function rewriteRecallResult(op: string, value: unknown): unknown {
  if (op === "decompress") return value;
  if (op !== "search_context") return rewriteModelFacingText(value);
  if (value === null || typeof value !== "object") return value;
  const result = value as { content?: unknown };
  if (!Array.isArray(result.content)) return value;
  return {
    ...result,
    content: result.content.map((part) => {
      const p = part as { type?: unknown; text?: unknown };
      if (p?.type !== "text" || typeof p.text !== "string") return part;
      const lines = p.text.split("\n");
      const text = lines
        .map((line, i) => (SEARCH_HINT_LINE.test(line) && (i === lines.length - 1 || lines[i + 1] === "") ? rewriteText(line) : line))
        .join("\n");
      return { ...p, text };
    }),
  };
}

function validationError(tool: CapturedTool, args: FacadeArgs): string | undefined {
  if (!tool.parameters || Check(tool.parameters, args)) return undefined;
  const first = Errors(tool.parameters, args)[0];
  const location = first?.instancePath || "/";
  const reason = first?.message || "arguments do not match the upstream schema";
  return `${location}: ${reason}`;
}

function helpResult(args: FacadeArgs, tools: Map<string, CapturedTool>) {
  const requested = typeof args.tool === "string" ? args.tool : "";
  if (!requested) {
    return {
      content: [{
        type: "text" as const,
        text: `Operations: ${LOW_FREQUENCY_TOOLS.map((op) => OPERATION_SIGNATURES[op]).join(", ")}. For a full schema, use op help with args {tool: operationName}.`,
      }],
      details: { operation: "help" },
    };
  }
  if (!LOW_FREQUENCY_SET.has(requested)) {
    throw new Error(`acp_context help operation is unknown: ${requested}`);
  }
  const tool = tools.get(requested);
  if (!tool) throw new Error(`acp_context could not find upstream tool: ${requested}`);
  return {
    content: [{
      type: "text" as const,
      text: [
        requested,
        tool.description,
        "Pass args matching this schema:",
        JSON.stringify(tool.parameters, null, 2),
      ].filter(Boolean).join("\n\n"),
    }],
    details: { operation: requested },
  };
}

// `exposure` is a pi 1.x field; the ToolDefinition types here come from billion-context-pi's older pi dependency.
function wrapCompress(tool: CapturedTool): CapturedTool & { exposure: "model-only" } {
  return {
    ...tool,
    // ACP finds compress results by toolName in the session log; a call nested in a codemode
    // script is recorded under codemode, so keep compress declared and out of scripts.
    exposure: "model-only",
    get description() {
      const upstreamDescription = String(tool.description ?? "");
      return upstreamDescription.includes("Dedicated summary model")
        ? "Replace consumed ranges using refs. A dedicated model writes the detailed summary; provide a concise, meaningful fallback preserving goals, exact paths/versions/errors, decisions, current state, and TODOs."
        : "Replace consumed conversation ranges with self-contained summaries using mNNNNN or bN refs.";
    },
    promptSnippet: "",
    promptGuidelines: [],
    async execute(callId, params, signal, onUpdate, ctx) {
      const forwardUpdate = onUpdate
        ? (update: unknown) => onUpdate(rewriteModelFacingText(update) as any)
        : undefined;
      const result = await tool.execute(callId, params, signal, forwardUpdate, ctx);
      return rewriteModelFacingText(result) as any;
    },
  };
}

function facadeTool(tools: Map<string, CapturedTool>): ToolDefinition<typeof FACADE_PARAMETERS, unknown, unknown> {
  return {
    name: "acp_context",
    label: "ACP Context",
    description: 'Search, restore, or inspect ACP context with original operation args; if unsure call { op: "help", args: { tool: "search_context" } }.',
    promptSnippet: "",
    promptGuidelines: [],
    parameters: FACADE_PARAMETERS,
    async execute(callId, params, signal, onUpdate, ctx) {
      if (params.op === "help") return helpResult(params.args ?? {}, tools);
      const tool = tools.get(params.op);
      if (!tool) throw new Error(`acp_context could not find upstream tool: ${params.op}`);
      const args = params.args ?? {};
      const invalid = validationError(tool, args);
      if (invalid) {
        throw new Error(
          `acp_context ${params.op} args invalid at ${invalid}. Expected ${OPERATION_SIGNATURES[params.op as Operation]}; retry with exactly these fields. Use op help with args {"tool":"${params.op}"} for the full schema.`,
        );
      }
      const forwardUpdate = onUpdate
        ? (update: unknown) => onUpdate(rewriteRecallResult(params.op, update) as any)
        : undefined;
      const result = await tool.execute(callId, args, signal, forwardUpdate, ctx);
      return rewriteRecallResult(params.op, result) as any;
    },
  };
}

export function createLeanAcpExtension(
  upstream: UpstreamExtension = createAcpExtension({ delegate: false, autoUpdate: false, externalSystemPrompt: true }),
): (pi: ExtensionAPI) => void {
  return (pi: ExtensionAPI): void => {
    const tools = new Map<string, CapturedTool>();
    let promptHookRegistered = false;
    const leanPi = new Proxy(pi, {
      get(target, property, receiver) {
        if (property === "registerTool") {
          return (tool: CapturedTool) => {
            if (DELEGATE_TOOLS.has(tool.name)) return;
            if (LOW_FREQUENCY_SET.has(tool.name)) {
              tools.set(tool.name, tool);
              return;
            }
            if (tool.name === "compress") {
              compactCompressSchemaDescriptions(tool.parameters);
              target.registerTool(decorateWithCollapsedDisplay(wrapCompress(tool)));
              return;
            }
            target.registerTool(decorateWithCollapsedDisplay(tool));
          };
        }
        if (property === "on") {
          return (eventName: string, handler: (...args: unknown[]) => unknown) => {
            if (eventName !== "before_agent_start") {
              return Reflect.apply(target.on, target, [eventName, handler]);
            }
            if (promptHookRegistered) return;
            promptHookRegistered = true;
            // Run upstream for its side effects (active-pack stamp, summary rules,
            // ignored-config warning); replace only the prompt it returns.
            // undefined means a refused host: inject nothing either.
            return Reflect.apply(target.on, target, [eventName, async (event: PromptEvent, ...rest: unknown[]) => {
              const upstreamResult = await handler(event, ...rest);
              return upstreamResult === undefined ? undefined : injectSystemPrompt(event);
            }]);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    upstream(leanPi);
    pi.registerTool(decorateWithCollapsedDisplay(facadeTool(tools)));
  };
}

export default createLeanAcpExtension();
