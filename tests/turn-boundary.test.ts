import { test } from "node:test";
import assert from "node:assert/strict";
import { ACP_STATUS_CUSTOM_TYPE, isCustomMessageEntry } from "../src/messages.js";
import {
  isTurnBoundary,
  lastTurnBoundaryId,
  lastTurnBoundaryIndex,
  type TurnBoundaryEntry,
} from "../src/turn-boundary.js";

const user = (id: string): TurnBoundaryEntry => ({ type: "message", id, message: { role: "user" } });
const assistant = (id: string): TurnBoundaryEntry => ({ type: "message", id, message: { role: "assistant" } });
const toolResult = (id: string): TurnBoundaryEntry => ({ type: "message", id, message: { role: "toolResult" } });
const custom = (id: string, content = "injected agent turn"): TurnBoundaryEntry => ({ type: "custom_message", id, content });
const statusPanel = (id: string): TurnBoundaryEntry => ({ type: "custom_message", id, customType: ACP_STATUS_CUSTOM_TYPE, content: "panel" });

test("isTurnBoundary: only user-role entries start a turn", () => {
  assert.equal(isTurnBoundary(user("m00001")), true);
  assert.equal(isTurnBoundary(assistant("m00002")), false);
  assert.equal(isTurnBoundary(toolResult("m00003")), false);
  assert.equal(isTurnBoundary(custom("m00004")), false, "injected custom messages never start a turn");
  assert.equal(isTurnBoundary(statusPanel("m00005")), false);
  assert.equal(isTurnBoundary({ type: "compaction", id: "x" }), false);
});

test("isCustomMessageEntry: matches the context-projection condition exactly", () => {
  assert.equal(isCustomMessageEntry(custom("a")), true);
  assert.equal(isCustomMessageEntry(statusPanel("b")), false);
  assert.equal(isCustomMessageEntry(user("c")), false);
});

test("isCustomMessageEntry: empty content never enters context", () => {
  assert.equal(isCustomMessageEntry(custom("e1", "")), false);
  assert.equal(isCustomMessageEntry(custom("e2", [{ type: "image" }])), false);
});

test("id view and index view of the boundary agree", () => {
  const entries = [user("u1"), assistant("a1"), custom("c1"), toolResult("t1"), statusPanel("s1"), user("u2"), custom("c2")];
  const idx = lastTurnBoundaryIndex(entries);
  assert.equal(idx, 5);
  assert.equal(lastTurnBoundaryId(entries), "u2");
  assert.equal(lastTurnBoundaryId([]), undefined);
  assert.equal(lastTurnBoundaryIndex([]), -1);
});

test("lastTurnBoundaryId: last user message wins, entries without message are skipped", () => {
  const entries: TurnBoundaryEntry[] = [
    { id: "a", message: { role: "user" } },
    { id: "b", message: { role: "assistant" } },
    { id: "c", message: { role: "user" } },
    { id: "d", message: { role: "toolResult" } },
  ];
  assert.equal(lastTurnBoundaryId(entries), "c");

  const noUser: TurnBoundaryEntry[] = [
    { id: "a", message: { role: "assistant" } },
    { id: "b", message: { role: "toolResult" } },
  ];
  assert.equal(lastTurnBoundaryId(noUser), undefined);

  const sparse: TurnBoundaryEntry[] = [{ id: "a" }, { id: "b", message: { role: "user" } }];
  assert.equal(lastTurnBoundaryId(sparse), "b");
});
