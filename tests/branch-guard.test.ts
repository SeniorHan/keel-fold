import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore, createInitialState, defaultConfig, defaultCountTokens, type CoreMessage } from "acp-kernel";
import { findOffBranchBlocks, markOffBranchBlocks, withBranchGuard } from "../src/branch-guard.js";

// Lean: after /tree to a point inside a block's range, the block's summary
// (which describes messages now on another branch) must not stand in for the
// few messages still in view.

const L = 200_000;
const FUTURE = "FUTURE-DECISION: switch to SiUD412ED (made after the rewind point)";
const filler = (tag: string) => `${tag} ` + "lorem ipsum dolor sit amet ".repeat(60);

function u(id: string, text: string): CoreMessage {
  return { id, role: "user", contentType: "text", text } as CoreMessage;
}
function a(id: string, text: string): CoreMessage {
  return { id, role: "assistant", contentType: "text", text } as CoreMessage;
}

function compressedState() {
  const core = withBranchGuard(createCore({ countTokens: defaultCountTokens }));
  const config = defaultConfig(L);
  const full = [u("e1", filler("q1")), a("e2", filler("a1")), u("e3", filler("q2")), a("e4", filler("a2")),
    u("e5", "tail-1"), a("e6", "tail-2"), u("e7", "tail-3"), a("e8", "tail-4"), u("e9", "tail-5"), a("e10", "tail-6")];
  const turn = core.processTurn({ messages: full, state: createInitialState(), config, tokenCount: 5_000 });
  const ref = (id: string) => turn.state.messageRefs.byRaw[id]!;
  const applied = core.applyCompression({
    ranges: [{ startRef: ref("e1"), endRef: ref("e4"), summary: `Block summary. ${FUTURE}. Padding to clear the minimum summary length.` }],
    messages: turn.messages,
    state: turn.state,
    config,
    protectedMessageIds: new Set(),
  });
  assert.equal(applied.result.blocksCreated, 1, JSON.stringify(applied.result.errors));
  return { core, config, state: applied.state, allIds: new Set(full.map((m) => m.id)) };
}

const textOf = (messages: CoreMessage[]) => messages.map((m) => String((m as { text?: unknown }).text ?? "")).join("\n");

test("Lean: a block partly on another branch is inactive; its in-view messages show raw", () => {
  const { core, config, state, allIds } = compressedState();
  // Rewound to e2: e3/e4 (and the tail) are persisted but on another branch.
  const view = [u("e1", filler("q1")), a("e2", filler("a1")), u("e11", "new question on the new branch")];
  const off = findOffBranchBlocks(state, view, allIds);
  assert.deepEqual(off, [state.blocks[0]!.blockId]);

  // Kernel alone: the summary (with the future decision) replaces e1/e2.
  const plain = core.processTurn({ messages: view, state, config, tokenCount: 5_000 });
  assert.match(textOf(plain.messages), /FUTURE-DECISION/, "baseline: kernel leaks the future summary");

  markOffBranchBlocks(state, off);
  const guarded = core.processTurn({ messages: view, state, config, tokenCount: 5_000 });
  const text = textOf(guarded.messages);
  assert.doesNotMatch(text, /FUTURE-DECISION/);
  assert.match(text, /^q1 lorem/m, "e1 is shown raw");
  assert.equal(guarded.state.blocks[0]!.active, false);
  assert.equal(guarded.state.blocks[0]!.expanded, undefined, "the mask is not persisted");
});

test("Lean: back on the full branch (or missing for other reasons) the block stays active", () => {
  const { core, config, state, allIds } = compressedState();
  const full = [u("e1", ""), a("e2", ""), u("e3", ""), a("e4", ""), u("e5", "tail-1")];
  assert.deepEqual(findOffBranchBlocks(state, full, allIds), []);
  // e3/e4 absent but never persisted (unknown ids): kernel behaviour is kept.
  assert.deepEqual(findOffBranchBlocks(state, [u("e1", ""), a("e2", "")], new Set(["e1", "e2"])), []);
  markOffBranchBlocks(state, []);
  const turn = core.processTurn({ messages: full, state, config, tokenCount: 5_000 });
  assert.equal(turn.state.blocks[0]!.active, true);
});

test("Lean: runtime.stateFor marks off-branch blocks from the session tree (pi host)", async () => {
  const { createRuntime } = await import("../src/runtime.js");
  const { offBranchBlocksOf } = await import("../src/branch-guard.js");
  const { state } = compressedState();
  const entry = (id: string, role: string, text: string) => ({ type: "message", id, parentId: null, timestamp: "", message: { role, content: text, timestamp: 0 } });
  const all = ["e1", "e2", "e3", "e4", "e5"].map((id, i) => entry(id, i % 2 ? "assistant" : "user", `t-${id}`));
  let branch = all.slice(0, 2);
  const ctx = {
    cwd: ".",
    model: { contextWindow: L, id: "m" },
    sessionManager: {
      getSessionId: () => "branch-guard",
      getSessionFile: () => undefined,
      buildContextEntries: () => branch,
      getEntries: () => all,
    },
  } as any;
  const rt = createRuntime({});
  await rt.save(state, ctx);
  const rewound = await rt.stateFor(ctx);
  assert.deepEqual([...(offBranchBlocksOf(rewound.state) ?? [])], [state.blocks[0]!.blockId]);
  branch = all;
  const back = await rt.stateFor(ctx);
  assert.equal(offBranchBlocksOf(back.state), undefined, "full branch: no mark");
});
