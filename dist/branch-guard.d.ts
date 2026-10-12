import type { CompressionCore, CompressionState, CoreMessage } from "acp-kernel";
export declare function findOffBranchBlocks(state: CompressionState, messages: readonly CoreMessage[], persistedIds: ReadonlySet<string>): string[];
/** Record the off-branch blocks for this state object (in-memory only). */
export declare function markOffBranchBlocks(state: CompressionState, blockIds: readonly string[]): void;
export declare function offBranchBlocksOf(state: CompressionState): ReadonlySet<string> | undefined;
/** Wrap a kernel core so processTurn honours the marks above, and marks carry
 *  over to the states processTurn / applyCompression return. */
export declare function withBranchGuard(core: CompressionCore): CompressionCore;
