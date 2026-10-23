import { test } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { createAcpExtension } from "../src/index.js";
import { tmpPath } from "./tmp-path.js";

// With a registry summary model the nudge carries only range-selection rules;
// the full HOW TO COMPRESS rules go to the summary model. `session` mode keeps
// them because its summary call reuses the main conversation prefix.

const LIMIT = 180_000;
const MID = "lorem ".repeat(3000);

function msg(id: string, role: string, text: string, over: Record<string, unknown> = {}) {
  return { type: "message", id, parentId: null, timestamp: "", message: { role, content: text, timestamp: Date.now(), ...over } };
}

function entries(): any[] {
  return [
    msg("u0", "user", "start " + MID),
    msg("a1", "assistant", "f1 " + MID),
    msg("u2", "user", "f2 " + MID),
    msg("a3", "assistant", "f3 " + MID),
    msg("u4", "user", "f4 " + MID),
    msg("u5", "user", "f5 " + MID),
    msg("an", "assistant", "tail " + MID, { usage: { input: 140_000, cacheRead: 0, cacheWrite: 0 } }),
  ];
}

async function nudgeText(name: string, compressionModelId: string): Promise<string> {
  const stateFile = tmpPath(`pai-acp-dedicated-nudge-${name}.session.json`);
  await rm(`${stateFile}.acp.json`, { force: true });
  const handlers = new Map<string, ((e: any, ctx: any) => any)[]>();
  const api = {
    on(event: string, handler: (e: any, ctx: any) => any) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerTool() {},
    registerCommand() {},
  };
  createAcpExtension({ modelContextLimit: LIMIT, compressionModelId })(api as any);
  const branch = entries();
  const ctx = {
    mode: "rpc" as const,
    hasUI: false,
    ui: { notify: () => {}, confirm: async () => true, select: async () => undefined, input: async () => "", setStatus: () => {} },
    model: { contextWindow: LIMIT },
    sessionManager: { buildContextEntries: () => branch, getSessionId: () => name, getSessionFile: () => stateFile },
    getContextUsage: () => ({ tokens: 140_000, percent: 140_000 / LIMIT, contextWindow: LIMIT }),
  };
  const out = await handlers.get("context")![0]!({ type: "context", messages: branch.map((e) => e.message) }, ctx);
  const nudge = out.messages.filter((m: any) => m.role === "user").map((m: any) => JSON.stringify(m.content)).find((t: string) => t.includes("HOW TO COMPRESS"));
  assert.ok(nudge, "78% pressure nudge injects");
  return nudge;
}

test("registry summary model: nudge sends range-selection rules, not the full summary rules", async () => {
  const text = await nudgeText("registry", "cheap/summarizer");
  assert.match(text, /dedicated summary model active/);
  assert.match(text, /Do not provide summary fields/);
  assert.doesNotMatch(text, /KEEP VERBATIM/);
});

test("session summary model keeps the full rules in the nudge", async () => {
  const text = await nudgeText("session", "session");
  assert.match(text, /KEEP VERBATIM/);
  assert.doesNotMatch(text, /dedicated summary model active/);
});
