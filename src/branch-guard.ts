import type { CompressionCore, CompressionState, CoreMessage } from "acp-kernel";

/**
 * Lean: branch-aware block activity.
 *
 * The kernel's syncBlocks keeps a block active while ANY of its covered
 * messages is still in view. After `/tree` (or any rewind) to a point inside a
 * block's range, the block's summary — which describes messages that are now
 * on another branch — would replace the few messages still in view, showing
 * the model decisions from a future it has not reached.
 *
 * A block is "off-branch" when some of its covered messages are in view and
 * some are persisted session entries that are NOT on the current branch. Such
 * a block is masked as expanded for the kernel turn (so its in-view messages
 * show raw) and the original `expanded` flag is restored on the result, so
 * nothing is persisted: returning to the full branch reactivates it.
 * Messages missing for other reasons (never persisted, host-side live ids)
 * keep the kernel's behaviour.
 */

const marks = new WeakMap<CompressionState, ReadonlySet<string>>();

function baseIdOf(id: string): string {
  const hash = id.indexOf("#");
  return hash > 0 ? id.substring(0, hash) : id;
}

export function findOffBranchBlocks(state: CompressionState, messages: readonly CoreMessage[], persistedIds: ReadonlySet<string>): string[] {
  const present = new Set<string>();
  for (const m of messages) if (typeof m.id === "string") present.add(baseIdOf(m.id));
  const off: string[] = [];
  for (const block of state.blocks) {
    if (block.expanded) continue;
    let inView = false;
    let elsewhere = false;
    for (const id of block.effectiveMessageIds) {
      const base = baseIdOf(id);
      if (present.has(base)) inView = true;
      else if (persistedIds.has(base)) elsewhere = true;
      if (inView && elsewhere) break;
    }
    if (inView && elsewhere) off.push(block.blockId);
  }
  return off;
}

/** Record the off-branch blocks for this state object (in-memory only). */
export function markOffBranchBlocks(state: CompressionState, blockIds: readonly string[]): void {
  if (blockIds.length > 0) marks.set(state, new Set(blockIds));
  else marks.delete(state);
}

export function offBranchBlocksOf(state: CompressionState): ReadonlySet<string> | undefined {
  return marks.get(state);
}

/** Wrap a kernel core so processTurn honours the marks above, and marks carry
 *  over to the states processTurn / applyCompression return. */
export function withBranchGuard(core: CompressionCore): CompressionCore {
  return {
    ...core,
    processTurn(input) {
      const off = marks.get(input.state);
      if (!off || off.size === 0) return core.processTurn(input);
      const originalExpanded = new Map<string, boolean | undefined>();
      const masked: CompressionState = {
        ...input.state,
        blocks: input.state.blocks.map((b) => {
          if (!off.has(b.blockId)) return b;
          originalExpanded.set(b.blockId, b.expanded);
          return { ...b, expanded: true };
        }),
      };
      const out = core.processTurn({ ...input, state: masked });
      const restored: CompressionState = {
        ...out.state,
        blocks: out.state.blocks.map((b) => {
          if (!originalExpanded.has(b.blockId)) return b;
          const { expanded: _masked, ...rest } = b;
          const orig = originalExpanded.get(b.blockId);
          return orig === undefined ? rest : { ...rest, expanded: orig };
        }),
      };
      marks.set(restored, off);
      return { ...out, state: restored };
    },
    applyCompression(input) {
      const out = core.applyCompression(input);
      const off = marks.get(input.state);
      if (off) marks.set(out.state, off);
      return out;
    },
  };
}
