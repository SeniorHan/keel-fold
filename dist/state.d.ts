import { type CompressionState } from "acp-kernel";
export declare const STATE_SUFFIX = ".acp.json";
export declare function readParentSessionPath(sessionFile: string): Promise<string | undefined>;
export declare class SessionStateStore {
    private cache;
    private writes;
    private tmpSeq;
    load(sessionFile: string | undefined, sessionId: string): Promise<CompressionState>;
    /** Stamp the effective prompt pack for the live session (audit trail:
     *  persisted into the sidecar on the next save). */
    setActivePack(sessionFile: string | undefined, sessionId: string, activePack: string): void;
    getActivePack(sessionFile: string | undefined, sessionId: string): string | undefined;
    save(state: CompressionState, sessionFile: string | undefined, sessionId: string): Promise<void>;
    invalidate(): void;
    private tryLoadParentState;
}
