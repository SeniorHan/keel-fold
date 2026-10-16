import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { createAcpExtension } from "../src/index.js";
import { DEFAULT_IDLE_MINUTES, IDLE_CHECK_CUSTOM_TYPE, IDLE_LATE_MS, resolveIdleCompact } from "../src/idle-compact.js";
import { tmpPath } from "./tmp-path.js";

const LIMIT = 180_000;
const MODEL = { provider: "openai", id: "gpt-test", api: "openai-responses", contextWindow: LIMIT };
const MID = "lorem ".repeat(8000);

function msg(id: string, role: string, text: string) {
  return { type: "message", id, parentId: null, timestamp: "", message: { role, content: text, timestamp: Date.now() } };
}

// Compressible mass above the 5K minPressureBenefit floor at ~17%
// usage: far below every regular nudge threshold.
function bulk(): any[] {
  return [
    msg("u0", "user", "start " + MID),
    msg("a1", "assistant", "f1 " + MID),
    msg("u2", "user", "f2 " + MID),
    msg("a3", "assistant", "f3 " + MID),
    msg("u4", "user", "f4 " + MID),
    msg("a5", "assistant", "done"),
  ];
}

const isNudge = (m: any) => {
  if (m.role !== "user") return false;
  const t = JSON.stringify(m.content);
  return t.includes("efficiency nudge to compress early") || t.includes("Context limit reached");
};

function harness(idleCompact: unknown, opts: { mode?: string; entries?: any[] } = {}) {
  const handlers = new Map<string, ((event: any, ctx: any) => any)[]>();
  const sent: any[] = [];
  let idle = true;
  const entries = opts.entries ?? bulk();
  const stateFile = tmpPath(`pai-acp-idle-${Math.random().toString(36).slice(2)}.session.json`);
  const api = {
    on(event: string, handler: (e: any, ctx: any) => any) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerTool() {},
    registerCommand() {},
    sendMessage(message: any, options: any) { sent.push({ message, options }); },
  };
  createAcpExtension({ modelContextLimit: LIMIT, idleCompact: idleCompact as any })(api as any);
  const ctx = {
    mode: opts.mode ?? "tui",
    hasUI: false,
    ui: { notify: () => {}, setStatus: () => {} },
    model: MODEL,
    isIdle: () => idle,
    sessionManager: {
      getBranch: () => entries,
      getEntries: () => entries,
      getSessionId: () => "idle-sid",
      getSessionFile: () => stateFile,
    },
    getContextUsage: () => ({ tokens: 30_000, percent: 30_000 / LIMIT, contextWindow: LIMIT }),
  };
  const emit = async (event: string, payload: Record<string, unknown> = {}) => {
    const results = [];
    for (const h of handlers.get(event) ?? []) results.push(await h({ type: event, ...payload }, ctx));
    return results;
  };
  const context = async () => {
    const [r] = await emit("context", { messages: entries.map((e) => e.message) });
    return r.messages as any[];
  };
  /** One normal run: start, one provider request, context build, settle. */
  const run = async () => {
    idle = false;
    await emit("agent_start");
    await emit("before_provider_request", { payload: { input: [] } });
    const out = await context();
    idle = true;
    await emit("agent_settled");
    return out;
  };
  const cleanup = () => rm(`${stateFile}.acp.json`, { force: true });
  return { emit, context, run, sent, cleanup, setIdle: (v: boolean) => { idle = v; } };
}

const enabled = { enabled: true };
// Mocked timers report the tick's END time inside callbacks, so tick exactly
// to the fire point; overshooting past IDLE_LATE_MS looks like a timer that woke late.
const FIRE_AT = DEFAULT_IDLE_MINUTES * 60_000;

test("resolveIdleCompact: default off, 29 minutes, bad minutes fall back", () => {
  assert.deepEqual(resolveIdleCompact(undefined), { enabled: false, idleMinutes: 29 });
  assert.deepEqual(resolveIdleCompact(true), { enabled: true, idleMinutes: 29 });
  assert.deepEqual(resolveIdleCompact({ idleMinutes: 10 }), { enabled: false, idleMinutes: 10 });
  assert.deepEqual(resolveIdleCompact({ enabled: true, idleMinutes: 0 }), { enabled: true, idleMinutes: 29 });
  assert.deepEqual(resolveIdleCompact({ enabled: true, idleMinutes: "x" as any }), { enabled: true, idleMinutes: 29 });
});

test("idle check fires once after idleMinutes, forces the nudge, and guards tools", async (t) => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  t.after(() => mock.timers.reset());
  const h = harness(enabled);
  t.after(h.cleanup);

  const first = await h.run();
  assert.equal(first.filter(isNudge).length, 0, "17% usage: the regular nudge stays quiet");

  mock.timers.tick(FIRE_AT - 1);
  assert.equal(h.sent.length, 0, "not yet");
  mock.timers.tick(1);
  assert.equal(h.sent.length, 1, "fires after idleMinutes");
  assert.equal(h.sent[0].message.customType, IDLE_CHECK_CUSTOM_TYPE);
  assert.equal(h.sent[0].options.triggerTurn, true);

  // The idle-check run.
  h.setIdle(false);
  await h.emit("agent_start");
  await h.emit("before_provider_request", { payload: { input: [] } });
  const forced = await h.context();
  assert.equal(forced.filter(isNudge).length, 1, "nudge forced below thresholds");
  const again = await h.context();
  assert.equal(again.filter(isNudge).length, 0, "forced only once per check");

  const blocked = (await h.emit("tool_call", { toolName: "bash", toolCallId: "t1", input: {} })).find(Boolean);
  assert.equal(blocked?.block, true, "other tools are blocked during the check");
  const allowed = (await h.emit("tool_call", { toolName: "compress", toolCallId: "t2", input: {} })).find(Boolean);
  assert.equal(allowed, undefined, "compress runs");
  h.setIdle(true);
  await h.emit("agent_settled");

  mock.timers.tick(FIRE_AT * 3);
  assert.equal(h.sent.length, 1, "one check per idle period");

  // A real run re-arms; tools are no longer guarded.
  await h.run();
  const free = (await h.emit("tool_call", { toolName: "bash", toolCallId: "t3", input: {} })).find(Boolean);
  assert.equal(free, undefined);
  mock.timers.tick(FIRE_AT);
  assert.equal(h.sent.length, 2, "next idle period gets its own check");
});

test("user input during the idle check lifts the tool guard", async (t) => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  t.after(() => mock.timers.reset());
  const h = harness(enabled);
  t.after(h.cleanup);
  await h.run();
  mock.timers.tick(FIRE_AT);
  assert.equal(h.sent.length, 1);
  h.setIdle(false);
  await h.emit("agent_start");
  await h.emit("input", { text: "back", source: "interactive" });
  const r = (await h.emit("tool_call", { toolName: "bash", toolCallId: "t1", input: {} })).find(Boolean);
  assert.equal(r, undefined, "the run is the user's now");
});

test("idleMinutes sets the delay", async (t) => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  t.after(() => mock.timers.reset());
  const h = harness({ enabled: true, idleMinutes: 10 });
  t.after(h.cleanup);
  await h.run();
  mock.timers.tick(10 * 60_000 - 1);
  assert.equal(h.sent.length, 0);
  mock.timers.tick(1);
  assert.equal(h.sent.length, 1);
});

test("no check: disabled, non-interactive mode, busy session, or too little to compress", async (t) => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  t.after(() => mock.timers.reset());
  const cases: [string, ReturnType<typeof harness>, () => void][] = [
    ["disabled", harness(undefined), () => {}],
    ["print mode", harness(enabled, { mode: "print" }), () => {}],
    ["little mass", harness(enabled, { entries: [msg("u0", "user", "hi"), msg("a1", "assistant", "hello")] }), () => {}],
  ];
  const busy = harness(enabled);
  cases.push(["busy", busy, () => busy.setIdle(false)]);
  for (const [name, h, before] of cases) {
    t.after(h.cleanup);
    await h.run();
    before();
    mock.timers.tick(FIRE_AT);
    assert.equal(h.sent.length, 0, name);
  }
});

test("a timer that wakes late (machine slept) skips the check", async (t) => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  t.after(() => mock.timers.reset());
  const h = harness(enabled);
  t.after(h.cleanup);
  await h.run();
  mock.timers.tick(FIRE_AT + IDLE_LATE_MS + 1);
  assert.equal(h.sent.length, 0);
});
