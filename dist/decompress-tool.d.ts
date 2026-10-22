import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AcpRuntime } from "./runtime.js";
import { type ToolPromptOverrides } from "./surface.js";
declare const UnfoldParams: Type.TObject<{
    ref: Type.TString;
    blockId: Type.TOptional<Type.TString>;
    full: Type.TOptional<Type.TBoolean>;
    toFile: Type.TOptional<Type.TString>;
    inline: Type.TOptional<Type.TBoolean>;
}>;
export declare function makeUnfoldTool(runtime: AcpRuntime, overrides?: ToolPromptOverrides): ToolDefinition<typeof UnfoldParams>;
/** Generate a unique auto file path for a block. Uses a timestamp so repeated
 *  unfolds of the same block never overwrite each other. */
/** Lean: filename stem for a message ref. Raw entry refs can carry
 *  characters Windows rejects in filenames (e.g. `4d9e965e#toolu_x|fc_toolu_x`);
 *  keep safe refs readable and give unsafe ones a sanitized prefix plus a
 *  short hash so distinct refs never collide. */
export declare function messageFileStem(ref: string): string;
export {};
