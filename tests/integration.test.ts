import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createAcpExtension } from "../src/index.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { tmpPath } from "./tmp-path.js";

// Mock Pi's ExtensionAPI — captures the event handlers the factory registers,
// so we can invoke them with a fake ExtensionContext and assert the wiring works.
function captureApi() {
  const handlers = new Map<string, ((event: any, ctx: any) => any)[]>();
  const api = {
    on(event: string, handler: (e: any, ctx: any) => any) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    tools: [] as any[],
    commands: new Map<string, any>(),
    registerTool(tool: any) {
      this.tools.push(tool);
    },
    registerCommand(name: string, options: any) {
      this.commands.set(name, options);
    },
  };
  return { api, handlers };
}

function fakeCtx(entries: any[], stateFile: string) {
  return {
    mode: "rpc",
    hasUI: false,
    ui: { notify: () => {}, confirm: async () => true, select: async () => undefined, input: async () => "", setStatus: () => {} },
    model: { contextWindow: 200_000 },
    sessionManager: {
      buildContextEntries: () => entries,
      getSessionId: () => "test-session",
      getSessionFile: () => stateFile,
    },
  };
}

function userMsg(id: string, text: string) {
  return { type: "message", id, parentId: null, timestamp: "", message: { role: "user", content: text, timestamp: Date.now() } };
}

  test("factory registers the compress tool and 9 flat commands", () => {
  const { api, handlers } = captureApi();
  createAcpExtension()(api as any);

  assert.ok(api.tools.some((t) => t.name === "compress"), "compress tool registered");
  assert.ok(api.tools.some((t) => t.name === "acp_cache"), "acp_cache tool registered");
  assert.deepEqual([...api.commands.keys()].sort(), ["acp", "acp-cache", "acp-config", "acp-decompress", "acp-export", "acp-rule", "acp-search", "acp-status"]);
  assert.ok(handlers.has("context"), "context event wired");
  assert.ok(handlers.has("session_before_compact"), "compaction-disable wired");
  assert.ok(handlers.has("before_agent_start"), "system-prompt wired");
});

test("session_before_compact cancels Pi's auto-compaction", () => {
  const { api, handlers } = captureApi();
  createAcpExtension()(api as any);
  const result = handlers.get("session_before_compact")![0]!({}, {});
  assert.deepEqual(result, { cancel: true });
});

test("before_agent_start appends the ACP system prompt", () => {
  const { api, handlers } = captureApi();
  createAcpExtension()(api as any);
  const result = handlers.get("before_agent_start")![0]!({ systemPrompt: "BASE" }, {});
  assert.ok(result.systemPrompt.startsWith("BASE"));
  assert.ok(result.systemPrompt.includes("compress"));
  assert.ok(result.systemPrompt.includes("acp"));
});

test("context handler tags every message with a ref even when length matches event.messages", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 200_000 })(api as any);

  const entries = [userMsg("e1", "first"), userMsg("e2", "second"), userMsg("e3", "third")];
  const ctx = fakeCtx(entries, tmpPath("nonexistent-pai-acp-it.session.json"));
  // Real Pi passes event.messages with the same length/roles as the session — the
  // handler must STILL return {messages} (not undefined), or the model never sees tags.
  const sameLengthMessages = entries.map(() => ({ role: "user", content: "x", timestamp: 0 }));

  const result = await handlers.get("context")![0]!({ type: "context", messages: sameLengthMessages }, ctx);
  assert.ok(result, "must return transformed array even when length/roles match (tags must apply)");
  const out = result.messages;
  assert.equal(out.length, 3);
  const firstContent = (out[0] as any).content as any[];
  assert.ok(firstContent.some((b: any) => b.type === "text" && b.text.includes("m0000")), "first msg ref-tagged");
});

test("acp_status refs remain usable by the next compress call", async () => {
  const { api } = captureApi();
  createAcpExtension({ modelContextLimit: 200_000 })(api);
  const stateFile = tmpPath("nonexistent-pai-acp-status-compress.session.json");
  await rm(`${stateFile}.acp.json`, { force: true });
  const originalText = "This range is reported by acp_status and must remain addressable by compress. ".repeat(130);
  const persisted = [userMsg("e1", originalText), ...["two", "three", "four", "five", "six", "seven"].map((n, index) => userMsg(`e${index + 2}`, `filler ${n} `.repeat(400)))];
  const ctx = { ...fakeCtx(persisted, stateFile), sessionManager: { buildContextEntries: () => persisted, getSessionId: () => "test-session", getSessionFile: () => stateFile } };
  const statusTool = api.tools.find((tool: { name: string }) => tool.name === "acp_status")!;
  const status = await statusTool.execute("tc-status", {}, undefined, undefined, ctx);
  const targetRef = status.content[0].text.match(/m\d{5}/)![0];
  const compressTool = api.tools.find((tool: { name: string }) => tool.name === "compress")!;
  const result = await compressTool.execute("tc-status-compress", { content: [{ startId: targetRef, endId: targetRef, summary: "This range was selected by acp_status and is now safely compressed from the original entry." }] }, undefined, undefined, ctx);
  assert.match(result.content[0].text, /blocks: b\d+=/, result.content[0].text);
});

test("system prompt sources compression rules from acp-kernel (no hardcoded drift, no markers)", () => {
  const { api, handlers } = captureApi();
  createAcpExtension()(api as any);
  const result = handlers.get("before_agent_start")![0]!({ systemPrompt: "" }, {});
  const sp = result.systemPrompt;
  // kernel constants inlined (regression guard against reverting to a hardcoded copy)
  assert.ok(sp.includes("Work from summaries, not raw tool outputs"), "kernel COMPRESS_PHILOSOPHY inlined");
  assert.ok(sp.includes("HOW TO COMPRESS"), "kernel HOW_TO_COMPRESS_RULES inlined");
  assert.ok(sp.includes("TIER 2 COMPRESSION"), "kernel TIER2_DISTILL_RULES inlined");
  assert.ok(sp.includes("TIER 3 COMPRESSION"), "kernel TIER3_CONDENSE_RULES inlined");
  // marker system removed entirely from kernel constants
  assert.ok(!sp.includes("[[KEEP:"), "no KEEP marker teaching");
  assert.ok(!sp.includes("[[REF:"), "no REF marker teaching");
  assert.ok(!sp.includes("KEEP MARKERS"), "no KEEP MARKERS section");
  // old hardcoded copy removed
  assert.ok(!sp.includes("Two failure modes to avoid"), "old hardcoded philosophy removed");
  assert.ok(!sp.includes("Over-compression: Compressing too aggressively"), "old hardcoded over/under-compression section removed");
});

test("context handler persists state so a second call is idempotent on the same entries", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 200_000 })(api as any);

  const entries = [userMsg("e1", "alpha"), userMsg("e2", "beta")];
  const ctx = fakeCtx(entries, tmpPath("nonexistent-pai-acp-it2.session.json"));


  const first = await handlers.get("context")![0]!({ type: "context", messages: [] }, ctx);
  const second = await handlers.get("context")![0]!({ type: "context", messages: [] }, ctx);

  assert.equal(first.messages.length, second.messages.length);
  const tag1 = ((first.messages[0] as any).content as any[]).find((b: any) => b.type === "text" && b.text.startsWith("[m"));
  const tag2 = ((second.messages[0] as any).content as any[]).find((b: any) => b.type === "text" && b.text.startsWith("[m"));
  assert.equal(tag1?.text, tag2?.text, "refs stable across calls (loaded from persisted state)");
});
test("no delegate surface: no ACP_DELEGATE prompt section and no acp_delegate tools", () => {
  const { api, handlers } = captureApi();
  createAcpExtension()(api as any);
  const result = handlers.get("before_agent_start")![0]!({ systemPrompt: "" }, {});
  assert.ok(!result.systemPrompt.includes("ACP_DELEGATE"), "no delegate prompt section");
  assert.ok(result.systemPrompt.includes("ACP TAGS"), "core ACP prompt present");
  assert.ok(!api.tools.some((t) => t.name.startsWith("acp_delegate")), "no acp_delegate tools registered");
});

// ─── ISSUE-9: modelContextLimit changes in <cwd>/.pi/acp.json hot-reload ──

test("modelContextLimit changes in .pi/acp.json are picked up on the next context event", async () => {
  (globalThis as Record<string, unknown>).CURRENT_VERSION ??= "0.0.0-test";
  const { mkdtempSync, writeFileSync, rmSync, mkdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { formatCompactTokens } = await import("acp-kernel/panel");

  const tmp = mkdtempSync(join(tmpdir(), "acp-hotreload-"));
  const piDir = join(tmp, ".pi");
  mkdirSync(piDir, { recursive: true });
  const acpJson = join(piDir, "acp.json");
  writeFileSync(acpJson, JSON.stringify({ modelContextLimit: 100_000 }));

  try {
    const { api, handlers } = captureApi();
    createAcpExtension()(api as any);

    function ctxWithCwd() {
      return { ...fakeCtx([], join(tmp, "state.json")), cwd: tmp };
    }
    async function acpStatus(): Promise<string> {
      let captured = "";
      const ctx = {
        ...fakeCtx([], join(tmp, "state.json")),
        cwd: tmp,
        ui: { notify: (s: string) => { captured = s; }, confirm: async () => true, select: async () => undefined, input: async () => "", setStatus: () => {} },
      };
      await api.commands.get("acp").handler([], ctx);
      return captured;
    }

    await handlers.get("context")![0]!({ type: "context", messages: [] }, ctxWithCwd());
    assert.ok((await acpStatus()).includes(formatCompactTokens(100_000)), "initial limit reflects acp.json modelContextLimit=100000");

    writeFileSync(acpJson, JSON.stringify({ modelContextLimit: 250_000 }));
    await handlers.get("context")![0]!({ type: "context", messages: [] }, ctxWithCwd());
    assert.ok((await acpStatus()).includes(formatCompactTokens(250_000)), "rewritten modelContextLimit=250000 hot-reloaded on next context event");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

async function withAgentDir(agentDir: string, fn: () => Promise<void>): Promise<void> {
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  // Isolate HOME too: prompt/config assembly reads the developer's real
  // ~/.pi/acp.json — e.g. `compress.promptPack: "lean"` swaps the acpTags
  // section for its headerless short form and breaks the literal "ACP TAGS"
  // assertions in these tests. Tests must not depend on the runner's home
  // config (#484 triage: failed deterministically on any lean-pack dev box,
  // green on CI's empty HOME — masking as a fake #415 regression).
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  const home = join(dirname(agentDir), "home");
  mkdirSync(home, { recursive: true });
  process.env.HOME = home;
  if (prevUserProfile !== undefined) process.env.USERPROFILE = home;
  try {
    await fn();
  } finally {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prev;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
  }
}

test("withAgentDir restores PI_CODING_AGENT_DIR/HOME/USERPROFILE without leaking env", async () => {
  const prevAgent = process.env.PI_CODING_AGENT_DIR;
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  const tmp = mkdtempSync(join(tmpdir(), "acp-env-restore-"));
  try {
    await withAgentDir(join(tmp, "agent"), async () => {
      assert.ok(process.env.PI_CODING_AGENT_DIR?.endsWith("agent"), "PI_CODING_AGENT_DIR points at the fixture");
      assert.notEqual(process.env.HOME, prevHome, "HOME is isolated inside the fixture");
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  assert.equal(process.env.PI_CODING_AGENT_DIR, prevAgent, "PI_CODING_AGENT_DIR restored verbatim (undefined must not become \"undefined\")");
  assert.equal(process.env.HOME, prevHome, "HOME restored verbatim");
  assert.equal(process.env.USERPROFILE, prevUserProfile, "USERPROFILE restored verbatim");
});

test("Lean: emergency truncation spares the latest user message and still reaches the wire", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 12_000, preserveRecentMessages: 2 } as any)(api as any);
  const words = (n: number, seed: string): string => Array.from({ length: n }, (_, i) => `${seed}${i}`).join(" ");
  const userText = words(6000, "u");
  const assistantText = words(4000, "o");
  const assistant = (id: string, text: string) => ({ type: "message", id, parentId: null, timestamp: "", message: { role: "assistant", content: [{ type: "text", text }], timestamp: Date.now() } });
  const entries = [assistant("a0", assistantText), userMsg("u1", userText), assistant("a1", "ok"), assistant("a2", "ok"), assistant("a3", "ok")];
  const ctx = fakeCtx(entries, tmpPath("lean-latest-user.session.json"));

  const result = await handlers.get("context")![0]!({ type: "context", messages: [] }, ctx);
  const textOf = (m: any): string => (typeof m.content === "string" ? m.content : m.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n"));
  const [a0, u1] = result.messages as any[];
  assert.ok(textOf(u1).includes(userText), "latest user message kept whole");
  assert.ok(textOf(a0).includes("[truncated for context space]"), "older assistant text truncated on the wire");
  assert.ok(textOf(a0).length < assistantText.length);
});
