import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createAcpExtension } from "../src/index.js";
import { THROTTLE_KICK_TEXT } from "../src/throttle-retry.js";

// A kick is a user message. Pi throws `Agent is already processing. Specify
// streamingBehavior ('steer' or 'followUp')` inside its fire-and-forget wrapper
// when one is sent while a run is active — and the kick is then lost, because the
// extension cannot catch that error. agent_settled normally means idle, but the
// progressive sleep before the kick can span minutes, so a kick sent after the
// user typed something lands mid-run; it has to be steered, not thrown away.

const THROTTLE_ERROR = {
  role: "assistant",
  stopReason: "error",
  errorMessage: "ThrottlingException: Too many tokens, please wait before trying again.",
  content: [],
};

const MODEL = { provider: "openai", id: "gpt-test", api: "openai-responses", contextWindow: 180_000 };

interface Harness {
  emit(event: string, payload?: Record<string, unknown>): Promise<unknown[]>;
  sentUser: { content: string; options?: Record<string, unknown> }[];
  setIdle(value: boolean): void;
  close(): void;
}

function harness(): Harness {
  const home = mkdtempSync(path.join(os.tmpdir(), "acp-kick-"));
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  if (prevUserProfile !== undefined) process.env.USERPROFILE = home;
  const cwd = path.join(home, "project");
  mkdirSync(cwd, { recursive: true });
  const prevCwd = process.cwd();
  process.chdir(cwd);

  let idle = true;
  const handlers = new Map<string, ((event: any, ctx: any) => any)[]>();
  const sentUser: Harness["sentUser"] = [];
  const api = {
    on(event: string, handler: (e: any, ctx: any) => any) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    tools: [] as any[],
    commands: new Map<string, any>(),
    registerTool(tool: any) {
      this.tools.push(tool);
    },
    registerCommand(name: string, options: any) {
      this.commands.set(name, options);
    },
    sendMessage() {},
    sendUserMessage(content: string, options?: Record<string, unknown>) {
      sentUser.push(options === undefined ? { content } : { content, options });
    },
  };
  // 1ms kick delay: the test only cares about how the kick is delivered, not how
  // long the progressive sleep runs (the default base is 60s).
  createAcpExtension({ throttleRetry: { baseDelayMs: 1 } } as any)(api as any);

  const ctx = {
    mode: "tui",
    cwd,
    hasUI: false,
    ui: { notify: () => {}, setStatus: () => {} },
    model: MODEL,
    isIdle: () => idle,
    sessionManager: {
      getEntries: () => [],
      buildContextEntries: () => [],
      getSessionId: () => "kick-sid",
      getSessionFile: () => path.join(home, "session.json"),
    },
    getContextUsage: () => ({ tokens: 0, percent: 0, contextWindow: MODEL.contextWindow }),
  };

  return {
    async emit(event, payload = {}) {
      const results: unknown[] = [];
      for (const handler of handlers.get(event) ?? []) results.push(await handler({ type: event, ...payload }, ctx));
      return results;
    },
    sentUser,
    setIdle(value: boolean) {
      idle = value;
    },
    close() {
      process.chdir(prevCwd);
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = prevUserProfile;
      rmSync(home, { recursive: true, force: true });
    },
  };
}

test("kick is a plain user message while the agent is idle", async () => {
  const h = harness();
  try {
    await h.emit("message_end", { message: THROTTLE_ERROR });
    await h.emit("agent_settled", {});
    assert.equal(h.sentUser.length, 1);
    assert.equal(h.sentUser[0]!.content, THROTTLE_KICK_TEXT);
    assert.equal(h.sentUser[0]!.options, undefined);
  } finally {
    h.close();
  }
});

test("kick is steered while a run is active, instead of throwing and vanishing", async () => {
  const h = harness();
  try {
    await h.emit("message_end", { message: THROTTLE_ERROR });
    h.setIdle(false);
    await h.emit("agent_settled", {});
    assert.equal(h.sentUser.length, 1);
    assert.equal(h.sentUser[0]!.content, THROTTLE_KICK_TEXT);
    assert.deepEqual(h.sentUser[0]!.options, { deliverAs: "steer" });
  } finally {
    h.close();
  }
});
