import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { defaultCountTokens } from "acp-kernel";
import type { Api, AssistantMessage, Context, Model } from "@earendil-works/pi-ai";

/** Sentinel compressionModelId value meaning "use the session's own model".
 *  The compression call reuses the session's prompt prefix (system prompt +
 *  tools + messages) so it can hit the provider's prompt cache. Distinct from a
 *  model ref ("provider/id" or a bare id). */
export const SESSION_MODEL_REF = "session";

/** A model known to Pi's model registry, addressed by provider + id. */
export interface CompressionModelInfo {
  provider: string;
  id: string;
  name?: string;
}

/** `model` is set when the ref is unambiguous; `ambiguous` lists candidates
 *  when a bare id matches several providers. */
export interface ResolveResult {
  model: Model<Api> | null;
  ambiguous: CompressionModelInfo[];
}

type ModelRegistryLike = ExtensionContext["modelRegistry"];

/** Pi >= 1.x exposes request-authenticated nested completions on the
 *  registry; 0.83 typings do not declare it, so it is probed at call time. */
type RegistryComplete = (model: Model<Api>, context: Context, options?: { maxTokens?: number; signal?: AbortSignal }) => Promise<AssistantMessage>;

/** Every chat model Pi knows, including providers registered by extensions
 *  (the session's live registry — not a private models.json-only runtime). */
export function listModels(registry: ModelRegistryLike): CompressionModelInfo[] {
  return registry.getAll().map((m) => ({ provider: m.provider, id: m.id, name: m.name }));
}

/** Resolve "provider/id" (explicit, split at the first slash) or a bare id. */
export function resolveModel(registry: ModelRegistryLike, ref: string): ResolveResult {
  const refTrim = ref.trim();
  if (!refTrim) return { model: null, ambiguous: [] };
  const slash = refTrim.indexOf("/");
  if (slash > 0) {
    const model = registry.find(refTrim.slice(0, slash), refTrim.slice(slash + 1));
    if (model) return { model, ambiguous: [] };
  }
  const matches = registry.getAll().filter((m) => m.id === refTrim);
  if (matches.length === 1) return { model: matches[0]!, ambiguous: [] };
  return { model: null, ambiguous: matches.map((m) => ({ provider: m.provider, id: m.id, name: m.name })) };
}

/** Run one summary call through the session's model registry (request-time
 *  auth, extension-registered providers). Throws on host without nested
 *  completion support, API error, abort, or empty output — the caller then
 *  keeps the main model's fallback summary. */
export async function summarizeWithModel(
  ctx: ExtensionContext,
  model: Model<Api>,
  context: Context,
  maxTokens: number,
  signal?: AbortSignal,
): Promise<string> {
  const complete = (ctx.modelRegistry as unknown as { complete?: RegistryComplete }).complete;
  if (typeof complete !== "function") throw new Error("host model registry has no complete() (needs pi >= 1.x)");
  const msg = await complete.call(ctx.modelRegistry, model, context, { maxTokens, signal });
  if (msg.stopReason === "error" || msg.stopReason === "aborted") {
    throw new Error(msg.errorMessage ?? `compression model stopped: ${msg.stopReason}`);
  }
  // Hit maxTokens: the summary is cut off mid-text; keep the fallback instead.
  if (msg.stopReason === "length") {
    throw new Error(`compression model hit its output limit (${maxTokens} tokens); summary incomplete`);
  }
  const text = msg.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("")
    .trim();
  if (!text) throw new Error("compression model returned an empty summary");
  return text;
}

/** System prompt for a dedicated model: reuse the kernel's tier-1 rules so
 *  its output matches what the main model would produce. */
export function buildSummarizeSystemPrompt(prompts: { compressPhilosophy: string; howToCompressRules: string }, topic: string | undefined): string {
  const topicLine = topic ? `\nTopic for this range: ${topic}\n` : "";
  return (
    "You are a dedicated context-compression model. You receive a range of conversation " +
    "messages and must write the single summary that replaces them. Follow the rules exactly.\n" +
    `${topicLine}\n` +
    `${prompts.compressPhilosophy}\n\n` +
    `${prompts.howToCompressRules}\n\n` +
    "CARRY FORWARD: the content may include `[earlier summary bN]` sections — summaries already written for parts of this range. " +
    "They are the only record of those messages. Re-carry every decision with its rationale, exact value, path, constraint, " +
    "open objective, and message ref from them unless a later message in the range explicitly supersedes it " +
    "(then keep one line: what changed and why). Never drop a fact just because it is old.\n\n" +
    "Output ONLY the summary text (no preamble, no code fences)."
  );
}

/** Truncate very large content, keeping head (goal/early context) and tail
 *  (latest state) around a marker. */
export function truncateContent(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  const marker = "\n\n[... truncated ...]\n\n";
  const budget = maxChars - marker.length;
  const head = Math.ceil(budget / 2);
  return content.slice(0, head) + marker + content.slice(content.length - (budget - head));
}

/** Tokens kept free for the system prompt, instruction and wrapper. */
const PROMPT_RESERVE_TOKENS = 8000;
/** defaultCountTokens is a heuristic (CJK char = 1, else 4 chars/token); leave slack for code-heavy text. */
const TOKEN_ESTIMATE_SLACK = 0.85;
const UNKNOWN_WINDOW_MAX_CHARS = 120000;

/** A chunk of range content; pinned chunks (earlier block summaries) are never truncated. */
export interface ContentPart {
  text: string;
  pinned?: boolean;
}

function charBudget(content: string, model: { contextWindow?: number }, maxTokens: number): number {
  const window = model.contextWindow;
  if (typeof window !== "number" || !Number.isFinite(window) || window <= 0) return UNKNOWN_WINDOW_MAX_CHARS;
  const budget = Math.floor((window - maxTokens - PROMPT_RESERVE_TOKENS) * TOKEN_ESTIMATE_SLACK);
  if (budget <= 0) return UNKNOWN_WINDOW_MAX_CHARS;
  const tokens = defaultCountTokens(content);
  if (tokens <= budget) return Infinity;
  return Math.floor((content.length * budget) / tokens);
}

/** Fit extracted range content into the summary model's context window
 *  instead of a fixed 120K-char cap; truncate only what cannot fit.
 *  When truncation is needed, pinned parts (earlier block summaries) are
 *  kept whole and listed first, and only the raw messages are cut — the
 *  summaries carry the decisions the new summary must inherit. Pinned parts
 *  that cannot fit whole throw: the caller then keeps its own summary, written
 *  by the main model that saw them in full, instead of one that lost facts. */
export function fitToModel(parts: ContentPart[], model: { contextWindow?: number }, maxTokens: number): string {
  const sep = "\n\n";
  const all = parts.map((p) => p.text).join(sep);
  const maxChars = charBudget(all, model, maxTokens);
  if (all.length <= maxChars) return all;
  const pinned = parts.filter((p) => p.pinned).map((p) => p.text).join(sep);
  const raw = parts.filter((p) => !p.pinned).map((p) => p.text).join(sep);
  if (pinned.length > maxChars) {
    throw new Error(`earlier block summaries (${pinned.length} chars) exceed the compression model input budget (${maxChars} chars)`);
  }
  if (!pinned) return truncateContent(raw, maxChars);
  // Earlier summaries outrank raw messages: with too little room left for raw
  // text, drop it rather than cut into the summaries.
  const rawBudget = maxChars - pinned.length - sep.length;
  if (rawBudget < 1000) {
    const omitted = `${sep}[... ${raw.length} chars of unsummarized messages omitted ...]`;
    return pinned.length + omitted.length <= maxChars ? pinned + omitted : pinned;
  }
  return `${pinned}${sep}${truncateContent(raw, rawBudget)}`;
}
