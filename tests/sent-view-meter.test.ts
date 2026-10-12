import { test } from "node:test";
import assert from "node:assert/strict";
import { adoptedViewTokens, blockSignature, historyCanary, sentViewMeterMatches, type SentViewMeterRecord } from "../src/tokens.js";
import type { CompressionState, CoreMessage } from "acp-kernel";
import { defaultConfig } from "acp-kernel";

type B = { blockId: string; active: boolean; covered?: number; summary?: string; runId?: string };

function stateOf(blocks: B[]): CompressionState {
  // Minimal structural stand-in: the meter only reads blocks[].{active,blockId,effectiveMessageIds,runId,tier,summary}.
  return {
    blocks: blocks.map((b) => ({ runId: "r1", tier: "T1", summary: "S", ...b, effectiveMessageIds: Array.from({ length: b.covered ?? 3 }, (_, i) => `m${i}`) })),
  } as unknown as CompressionState;
}

const base: B[] = [{ blockId: "b1", active: true }, { blockId: "b2", active: false }];

const msg = (id: string): CoreMessage => ({ id, role: "user", contentType: "text", text: id });
const history = [msg("e1"), msg("e2"), msg("e3")];

function meter(over: Partial<SentViewMeterRecord>): SentViewMeterRecord {
  return { viewTokens: 100_000, rawTokens: 150_000, blockSig: blockSignature(stateOf(base)), history: historyCanary(history), limit: 868_928, usable: true, ...over };
}

const config = { ...defaultConfig(), modelContextLimit: 868_928 };

test("no meter, or unusable meter, never matches", () => {
  assert.equal(sentViewMeterMatches(undefined, stateOf(base), config, 150_000, history), false);
  assert.equal(sentViewMeterMatches(meter({ usable: false }), stateOf(base), config, 150_000, history), false);
});

test("matching signature adopts the previous view", () => {
  assert.equal(sentViewMeterMatches(meter({}), stateOf(base), config, 150_000, history), true);
});

test("window re-centering (limit change) forces a resync", () => {
  assert.equal(sentViewMeterMatches(meter({}), stateOf(base), { ...config, modelContextLimit: 150_000 }, 150_000, history), false);
});

test("block count change (compress/decompress) forces a resync", () => {
  assert.equal(sentViewMeterMatches(meter({}), stateOf([{ blockId: "b1", active: true }]), config, 150_000, history), false);
  assert.equal(sentViewMeterMatches(meter({}), stateOf([...base, { blockId: "b3", active: true }]), config, 150_000, history), false);
});

test("active-set change forces a resync even when the active count is unchanged", () => {
  // Same count (1 active of 2), different block active.
  assert.equal(sentViewMeterMatches(meter({}), stateOf([{ blockId: "b1", active: false }, { blockId: "b2", active: true }]), config, 150_000, history), false);
  // Same block, coverage grew (absorb).
  assert.equal(sentViewMeterMatches(meter({}), stateOf([{ blockId: "b1", active: true, covered: 9 }, { blockId: "b2", active: false }]), config, 150_000, history), false);
});

test("a shrinking raw estimate (rewind/rewrite) forces a resync", () => {
  assert.equal(sentViewMeterMatches(meter({}), stateOf(base), config, 149_999, history), false);
});

test("adopted view carries the raw growth appended since the measurement", () => {
  // Regression (Lean): the bare previous viewTokens was adopted, so a 32K
  // message appended after the measurement never reached the meter.
  assert.equal(adoptedViewTokens(meter({}), 150_000, history), 100_000);
  assert.equal(adoptedViewTokens(meter({}), 182_000), 132_000);
});

test("appended history matches; rewound or switched history forces a resync", () => {
  assert.equal(sentViewMeterMatches(meter({}), stateOf(base), config, 160_000, [...history, msg("e4")]), true);
  assert.equal(sentViewMeterMatches(meter({}), stateOf(base), config, 160_000, history.slice(0, 2)), false);
  // Branch switch: same length and more raw tokens, but a different tail.
  assert.equal(sentViewMeterMatches(meter({}), stateOf(base), config, 160_000, [msg("e1"), msg("e2"), msg("x3"), msg("x4")]), false);
});

test("an in-place refold (same id and coverage, rewritten summary) forces a resync", () => {
  const refolded: B[] = [{ blockId: "b1", active: true, summary: "S".repeat(4000) }, { blockId: "b2", active: false }];
  assert.equal(sentViewMeterMatches(meter({}), stateOf(refolded), config, 160_000, history), false);
  const rerun: B[] = [{ blockId: "b1", active: true, runId: "r2" }, { blockId: "b2", active: false }];
  assert.equal(sentViewMeterMatches(meter({}), stateOf(rerun), config, 160_000, history), false);
});
