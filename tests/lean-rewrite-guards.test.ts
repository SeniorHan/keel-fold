// Lean request-rewrite guards: kernel truncation reaches the wire (①),
// latest user message survives emergency truncation (③), compress thinking is
// metered (④), and acp_context projects under its wrapped op (⑤).
import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultConfig, truncateLargeToolOutputs, defaultCountTokens, type CoreMessage } from "acp-kernel";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  coreOutToAgentMessages,
  entriesToCoreMessages,
  extractText,
  protectLatestUserMessage,
  EntryProjectionCache,
  TRUNCATION_MARKER,
} from "../src/messages.js";
import { keptCompressThinkingTokens } from "../src/reasoning-drop.js";

type AgentMessage = Parameters<typeof coreOutToAgentMessages>[1] extends Map<string, infer M> ? M : never;

const words = (n: number, seed: string): string => Array.from({ length: n }, (_, i) => `${seed}${i}`).join(" ");
const truncatedText = (body: string): string => `${body.slice(0, 50)}\n\n...${TRUNCATION_MARKER} — original ~999 tokens]...\n\n${body.slice(-50)}`;

function entry(id: string, message: object): SessionEntry {
  return { type: "message", id, parentId: null, timestamp: new Date().toISOString(), message } as SessionEntry;
}

test("① kernel truncation of assistant text reaches the outgoing message, thinking kept", () => {
  const body = words(2000, "a");
  const original = { role: "assistant", content: [{ type: "thinking", thinking: "plan" }, { type: "text", text: body }] } as unknown as AgentMessage;
  const core: CoreMessage = { id: "a1", role: "assistant", contentType: "text", text: truncatedText(body) };
  const [out] = coreOutToAgentMessages([core], new Map([["a1", original]]));
  const content = (out as { content: Array<{ type: string; text?: string }> }).content;
  assert.equal(content[0]!.type, "thinking");
  assert.ok(extractText(content).includes(TRUNCATION_MARKER));
  assert.ok(extractText(content).length < body.length);
});

test("① untruncated assistant text is passed through untouched", () => {
  const original = { role: "assistant", content: [{ type: "text", text: "hello" }] } as unknown as AgentMessage;
  const [out] = coreOutToAgentMessages([{ id: "a1", role: "assistant", contentType: "text", text: "hello" }], new Map([["a1", original]]));
  assert.equal(out, original);
});

test("① untagged (protected) tool result still carries kernel truncation", () => {
  const body = words(2000, "r");
  const original = { role: "toolResult", toolCallId: "c1", toolName: "skill", content: [{ type: "text", text: body }] } as unknown as AgentMessage;
  const core: CoreMessage = { id: "r1", role: "tool", contentType: "tool-result", toolName: "skill", toolCallId: "c1", text: truncatedText(body) };
  const [out] = coreOutToAgentMessages([core], new Map([["r1", original]]));
  const text = extractText((out as { content: unknown }).content);
  assert.ok(text.includes(TRUNCATION_MARKER));
  assert.ok(text.length < body.length);
});

test("③ latest user message is restored and the budget goes to other candidates", () => {
  // ~14.4K tokens total vs a 12K window: the kernel cuts the larger user text
  // first and stops, leaving the older assistant text intact.
  const config = { ...defaultConfig(), modelContextLimit: 12_000, preserveRecentMessages: 2 };
  const userText = words(6000, "u");
  const oldText = words(4000, "o");
  const inMessages: CoreMessage[] = [
    { id: "a0", role: "assistant", contentType: "text", text: oldText },
    { id: "u1", role: "user", contentType: "text", text: userText },
    { id: "a1", role: "assistant", contentType: "text", text: "ok" },
    { id: "a2", role: "assistant", contentType: "text", text: "ok" },
    { id: "a3", role: "assistant", contentType: "text", text: "ok" },
  ];
  const tokenCount = inMessages.reduce((n, m) => n + defaultCountTokens(m.text ?? ""), 0);
  const kernel = truncateLargeToolOutputs(inMessages, tokenCount, config, defaultCountTokens, { protectRecentMessages: 2, includeTextMessages: true });
  const kernelUser = kernel.messages.find((m) => m.id === "u1")!;
  assert.ok(kernelUser.text!.includes(TRUNCATION_MARKER), "precondition: kernel truncates the latest user message");
  assert.equal(kernel.messages.find((m) => m.id === "a0")!.text, oldText, "precondition: kernel leaves the older text alone");

  const guarded = protectLatestUserMessage(inMessages, kernel.messages, config, tokenCount);
  assert.equal(guarded.restoredId, "u1");
  assert.equal(guarded.messages.find((m) => m.id === "u1")!.text, userText);
  assert.ok(guarded.messages.find((m) => m.id === "a0")!.text!.includes(TRUNCATION_MARKER), "older text absorbs the cut instead");
  assert.ok(guarded.remainingTokens < tokenCount);
});

test("③ no-op when the kernel did not touch the latest user message", () => {
  const config = { ...defaultConfig(), modelContextLimit: 20_000 };
  const msgs: CoreMessage[] = [{ id: "u1", role: "user", contentType: "text", text: "hi" }];
  const guarded = protectLatestUserMessage(msgs, msgs, config, 100);
  assert.equal(guarded.restoredId, undefined);
  assert.equal(guarded.messages, msgs);
});

function compressCall(id: string, thinking: string): object {
  return { role: "assistant", content: [{ type: "thinking", thinking }, { type: "toolCall", id, name: "compress", arguments: {} }] };
}
const result = (id: string, name = "compress"): object => ({ role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text: "done" }] });

test("④ kept compress thinking: closed oversized round dropped, in-flight round counted", () => {
  const big = words(3000, "t");
  const closed = [compressCall("c1", big), result("c1"), { role: "user", content: "next" }] as unknown as AgentMessage[];
  assert.equal(keptCompressThinkingTokens(closed), 0);
  const inFlight = [compressCall("c1", big), result("c1")] as unknown as AgentMessage[];
  assert.equal(keptCompressThinkingTokens(inFlight), defaultCountTokens(big));
  assert.equal(keptCompressThinkingTokens(closed, { drop: false }), defaultCountTokens(big));
});

test("④ thinking of messages whose first call is not compress is left to estimateTokens", () => {
  const msg = { role: "assistant", content: [{ type: "thinking", thinking: "x".repeat(100) }, { type: "toolCall", id: "r", name: "read", arguments: {} }, { type: "toolCall", id: "c", name: "compress", arguments: {} }] };
  assert.equal(keptCompressThinkingTokens([msg] as unknown as AgentMessage[]), 0);
});

test("⑤ acp_context calls and results project under the wrapped operation", () => {
  const facade = (id: string, op: string): object => ({ role: "assistant", content: [{ type: "toolCall", id, name: "acp_context", arguments: { op, args: {} } }] });
  const entries = [
    entry("e1", facade("d1", "decompress")),
    entry("e2", result("d1", "acp_context")),
    entry("e3", facade("h1", "help")),
    entry("e4", result("h1", "acp_context")),
  ];
  const names = (cores: CoreMessage[]): string[] => cores.map((c) => c.toolName ?? "");
  assert.deepEqual(names(entriesToCoreMessages(entries)), ["decompress", "decompress", "acp_context", "acp_context"]);
  // The incremental projection cache yields the same names across appends.
  const cache = new EntryProjectionCache();
  cache.project(entries.slice(0, 1));
  assert.deepEqual(names(cache.project(entries)), ["decompress", "decompress", "acp_context", "acp_context"]);
});
