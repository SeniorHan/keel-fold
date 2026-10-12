// Dedicated summary model (#241 port onto v0.1.83): `/acp compact` config and
// the compress-tool routing through Pi's model registry (ctx.modelRegistry).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createAcpExtension } from "../src/index.js";
import { fitToModel, resolveModel } from "../src/compress-model.js";

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
    registerTool(tool: any) { this.tools.push(tool); },
    registerCommand(name: string, options: any) { this.commands.set(name, options); },
    getActiveTools: () => ["read", "compress"],
    getAllTools: () => [
      { name: "read", description: "Read a file", parameters: { type: "object" } },
      { name: "compress", description: "Compress", parameters: { type: "object" } },
      { name: "write", description: "inactive", parameters: { type: "object" } },
    ],
  };
  return { api, handlers };
}

function userMsg(id: string, text: string) {
  return { type: "message", id, parentId: null, timestamp: "", message: { role: "user", content: text, timestamp: Date.now() } };
}

type Call = { model: any; context: any; options: any };

function model(provider: string, id: string): any {
  return { provider, id, name: id, api: "openai-completions", contextWindow: 200_000, maxTokens: 8000 };
}

/** Registry fake: Pi >= 1.x shape (find/getAll/complete). */
function fakeRegistry(models: any[], reply: (call: Call) => Promise<any>, calls: Call[]) {
  return {
    getAll: () => models,
    find: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id),
    complete: async (m: any, context: any, options: any) => {
      const call = { model: m, context, options };
      calls.push(call);
      return reply(call);
    },
  };
}

function textReply(text: string) {
  return async () => ({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop" });
}

function fakeCtx(entries: any[], stateFile: string, cwd: string, registry: any, onNotify?: (s: string) => void, sessionModel?: any) {
  return {
    mode: "rpc",
    hasUI: false,
    cwd,
    ui: { notify: (s: string) => onNotify?.(s), confirm: async () => true, select: async () => undefined, input: async () => "", setStatus: () => {} },
    model: sessionModel ?? { contextWindow: 200_000, id: "test-model", provider: "mainprov" },
    modelRegistry: registry,
    getContextUsage: () => null,
    getSystemPrompt: () => "SESSION SYSTEM PROMPT",
    sessionManager: {
      buildContextEntries: () => entries,
      getSessionId: () => "test-session",
      getSessionFile: () => stateFile,
    },
  };
}

// Oldest message must clear minCompressRange and sit outside the protected tail.
const LONG = "lorem ipsum dolor sit amet ".repeat(400);
const FILLER = "filler text for padding purposes ".repeat(150);
function compressibleEntries(): any[] {
  const out = [userMsg("e1", LONG)];
  for (let i = 2; i <= 7; i++) out.push(userMsg(`e${i}`, FILLER));
  return out;
}

async function readBlockSummaries(stateFile: string): Promise<string[]> {
  const state = JSON.parse(await fs.readFile(`${stateFile}.acp.json`, "utf8"));
  return (state.blocks ?? []).map((b: { summary: string }) => b.summary);
}

const DEDICATED = "DEDICATED-SUMMARY: the dedicated summary model wrote this replacement for the range.";
const FALLBACK = "Caller fallback summary: lorem ipsum exploration finished; nothing pending in this range.";

let tmp: string;
let acpJsonPath: string;
const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "acp-compress-model-"));
  // os.homedir() reads USERPROFILE on Windows, HOME elsewhere — set both.
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  acpJsonPath = path.join(tmp, ".pi", "acp.json");
});

after(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await fs.rm(tmp, { recursive: true, force: true });
});

async function setup(name: string, registry: any, opts: { acpJson?: object; sessionModel?: any; notify?: (s: string) => void } = {}) {
  await fs.rm(acpJsonPath, { force: true });
  if (opts.acpJson) {
    await fs.mkdir(path.dirname(acpJsonPath), { recursive: true });
    await fs.writeFile(acpJsonPath, JSON.stringify(opts.acpJson));
  }
  const { api, handlers } = captureApi();
  createAcpExtension({ autoUpdate: false })(api as any);
  const stateFile = path.join(tmp, `${name}.session.json`);
  await fs.rm(`${stateFile}.acp.json`, { force: true });
  const ctx = fakeCtx(compressibleEntries(), stateFile, tmp, registry, opts.notify, opts.sessionModel);
  for (const h of handlers.get("session_start") ?? []) await h({ type: "session_start" }, ctx);
  await handlers.get("context")![0]!({ type: "context", messages: [] }, ctx);
  const compress = api.tools.find((t: any) => t.name === "compress")!;
  const run = async (summary: string) => {
    const out = await compress.execute("tc1", { content: [{ startId: "m00001", endId: "m00001", summary }] }, undefined, undefined, ctx);
    return out.content?.[0]?.text ?? String(out);
  };
  return { api, ctx, stateFile, compress, run };
}

test("resolveModel: provider/id, unique bare id, ambiguous bare id, unknown", () => {
  const reg = fakeRegistry([model("a", "x"), model("b", "x"), model("a", "only"), model("p", "org/model")], textReply(""), []);
  assert.equal(resolveModel(reg as any, "a/x").model?.provider, "a");
  assert.equal(resolveModel(reg as any, "only").model?.provider, "a");
  assert.equal(resolveModel(reg as any, "p/org/model").model?.id, "org/model");
  const amb = resolveModel(reg as any, "x");
  assert.equal(amb.model, null);
  assert.deepEqual(amb.ambiguous.map((m) => m.provider).sort(), ["a", "b"]);
  assert.deepEqual(resolveModel(reg as any, "nope"), { model: null, ambiguous: [] });
});

test("compress: registry model writes the summary from the extracted range", async () => {
  const calls: Call[] = [];
  const registry = fakeRegistry([model("cheap", "summarizer")], textReply(DEDICATED), calls);
  const { run, stateFile, compress } = await setup("dedicated", registry, { acpJson: { compressionModelId: "cheap/summarizer" } });
  assert.match(compress.description, /Dedicated summary model cheap\/summarizer/);
  const text = await run(FALLBACK);
  assert.match(text, /summaries written by cheap\/summarizer \(1\/1\)/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.model.id, "summarizer");
  const prompt = JSON.stringify(calls[0]!.context.messages);
  assert.ok(prompt.includes("lorem ipsum"), "range transcript must be sent");
  assert.ok(!prompt.includes("filler text"), "only the requested range is extracted");
  assert.ok(calls[0]!.options.maxTokens >= 256);
  const summaries = await readBlockSummaries(stateFile);
  assert.ok(summaries.includes(DEDICATED), JSON.stringify(summaries));
  assert.ok(!summaries.includes(FALLBACK));
});

test("compress: refolding over an active block sends its summary, not the raw messages", async () => {
  const calls: Call[] = [];
  const registry = fakeRegistry([model("cheap", "summarizer")], textReply(DEDICATED), calls);
  const { ctx, compress, run } = await setup("refold", registry, { acpJson: { compressionModelId: "cheap/summarizer" } });
  await run(FALLBACK);
  const text = (await compress.execute("tc2", { content: [{ startId: "b1", endId: "m00002", summary: FALLBACK }] }, undefined, undefined, ctx)).content?.[0]?.text;
  assert.match(String(text), /summaries written by cheap\/summarizer \(1\/1\)/);
  assert.equal(calls.length, 2);
  const prompt = JSON.stringify(calls[1]!.context.messages);
  assert.ok(prompt.includes("[earlier summary b1"), prompt.slice(0, 400));
  assert.ok(prompt.includes("DEDICATED-SUMMARY"), "the block summary stands in for its messages");
  assert.ok(!prompt.includes("lorem ipsum"), "raw messages already folded into b1 are not resent");
  assert.ok(prompt.includes("filler text"), "new messages in the range are sent raw");
  assert.match(calls[1]!.context.systemPrompt, /CARRY FORWARD/);
});

test("fitToModel: fits the summary model window, falls back to 120K chars when unknown", () => {
  const text = "x".repeat(400_000); // ~100K tokens
  assert.equal(fitToModel(text, { contextWindow: 400_000 }, 8000), text);
  const small = fitToModel(text, { contextWindow: 50_000 }, 8000);
  assert.ok(small.length < 150_000 && small.includes("[... truncated ...]"), String(small.length));
  assert.equal(fitToModel(text, {}, 8000).length, 120_000);
});

test("compress: dedicated failure keeps the caller fallback summary", async () => {
  const calls: Call[] = [];
  const registry = fakeRegistry([model("cheap", "summarizer")], async () => { throw new Error("Connection error."); }, calls);
  const { run, stateFile } = await setup("fallback", registry, { acpJson: { compressionModelId: "cheap/summarizer" } });
  const text = await run(FALLBACK);
  assert.match(text, /▣ ACP \|/);
  assert.match(text, /produced no summaries; kept caller-provided fallback summaries/);
  assert.equal(calls.length, 1);
  assert.ok((await readBlockSummaries(stateFile)).includes(FALLBACK));
});

test("compress: error stopReason and hosts without complete() fall back too", async () => {
  const errReg = fakeRegistry([model("cheap", "summarizer")], async () => ({ role: "assistant", content: [], stopReason: "error", errorMessage: "429" }), []);
  const a = await setup("stop-error", errReg, { acpJson: { compressionModelId: "cheap/summarizer" } });
  await a.run(FALLBACK);
  assert.ok((await readBlockSummaries(a.stateFile)).includes(FALLBACK));

  const oldHost = { getAll: () => [model("cheap", "summarizer")], find: () => model("cheap", "summarizer") };
  const b = await setup("no-complete", oldHost, { acpJson: { compressionModelId: "cheap/summarizer" } });
  await b.run(FALLBACK);
  assert.ok((await readBlockSummaries(b.stateFile)).includes(FALLBACK));
});

test("compress: unresolvable model ref keeps the caller summary and warns", async () => {
  const registry = fakeRegistry([model("cheap", "summarizer")], textReply(DEDICATED), []);
  const { run, stateFile } = await setup("unresolved", registry, { acpJson: { compressionModelId: "ghost/model" } });
  const text = await run(FALLBACK);
  assert.match(text, /summary model ghost\/model is not resolvable/);
  assert.ok((await readBlockSummaries(stateFile)).includes(FALLBACK));
});

test("compress: session mode reuses the captured prefix, system prompt and active tools", async () => {
  const calls: Call[] = [];
  const session = model("mainprov", "main-model");
  const registry = fakeRegistry([session], textReply(DEDICATED), calls);
  const { run, stateFile } = await setup("session", registry, { acpJson: { compressionModelId: "session" }, sessionModel: session });
  const text = await run(FALLBACK);
  assert.match(text, /summaries written by session model mainprov\/main-model \(1\/1, shared prefix\)/);
  const { context } = calls[0]!;
  assert.equal(context.systemPrompt, "SESSION SYSTEM PROMPT");
  assert.deepEqual(context.tools.map((t: any) => t.name), ["read", "compress"]);
  const msgs = JSON.stringify(context.messages);
  assert.ok(msgs.includes("lorem ipsum") && msgs.includes("filler text"), "whole captured prefix is sent");
  assert.match(String(context.messages.at(-1).content), /Write the single detailed summary replacing m00001 through m00001/);
  assert.ok((await readBlockSummaries(stateFile)).includes(DEDICATED));
});

test("no compressionModelId: main-model summary, no side call, original description", async () => {
  const calls: Call[] = [];
  const registry = fakeRegistry([model("cheap", "summarizer")], textReply(DEDICATED), calls);
  const { run, stateFile, compress } = await setup("unset", registry);
  assert.match(compress.description, /detailed summaries you write/);
  const text = await run(FALLBACK);
  assert.doesNotMatch(text, /summar(y|ies) (model|written)/);
  assert.equal(calls.length, 0);
  assert.ok((await readBlockSummaries(stateFile)).includes(FALLBACK));
});

test("/acp compact: status, set provider/id, session, reset, ambiguous, unknown", async () => {
  const registry = fakeRegistry([model("cheap", "summarizer"), model("a", "dup"), model("b", "dup")], textReply(DEDICATED), []);
  let out = "";
  const { api, ctx, compress } = await setup("cmd", registry, { notify: (s) => (out = s), acpJson: { compress: { promptPack: "lean" } } });
  const acp = api.commands.get("acp");

  await acp.handler("compact", ctx);
  assert.match(out, /not set/);

  await acp.handler("compact summarizer", ctx);
  assert.match(out, /set to cheap\/summarizer/);
  let written = JSON.parse(await fs.readFile(acpJsonPath, "utf8"));
  assert.equal(written.compressionModelId, "cheap/summarizer");
  assert.deepEqual(written.compress, { promptPack: "lean" }, "unrelated keys preserved");
  assert.match(compress.description, /Dedicated summary model cheap\/summarizer/);

  await acp.handler("compact dup", ctx);
  assert.match(out, /Ambiguous model id "dup"[\s\S]*a\/dup[\s\S]*b\/dup/);

  await acp.handler("compact nope", ctx);
  assert.match(out, /not found[\s\S]*cheap\/summarizer/);

  await acp.handler("compact session", ctx);
  assert.match(out, /set to session/);
  await acp.handler("compact", ctx);
  assert.match(out, /Summary model: session/);

  await acp.handler("compact reset", ctx);
  assert.match(out, /cleared/);
  written = JSON.parse(await fs.readFile(acpJsonPath, "utf8"));
  assert.equal(written.compressionModelId, undefined);
  assert.doesNotMatch(compress.description, /Dedicated summary model/);
});

test("/acp compact refuses to overwrite an unparseable global acp.json", async () => {
  const registry = fakeRegistry([model("cheap", "summarizer")], textReply(DEDICATED), []);
  const { api, ctx } = await setup("badjson", registry);
  await fs.mkdir(path.dirname(acpJsonPath), { recursive: true });
  await fs.writeFile(acpJsonPath, "{ not json");
  await assert.rejects(() => api.commands.get("acp").handler("compact cheap/summarizer", ctx));
  assert.equal(await fs.readFile(acpJsonPath, "utf8"), "{ not json");
});
