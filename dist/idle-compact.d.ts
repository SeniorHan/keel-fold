import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { NudgeDecision } from "acp-kernel";
import type { AcpRuntime } from "./runtime.js";
/**
 * Idle compaction check (Lean). After the session has been idle for
 * `idleMinutes` (default 29, just inside a 30-minute prompt cache), start one
 * turn that shows the main model the regular compress nudge and lets it decide
 * whether to compress. If the cache is still warm, that turn reads the long
 * prefix from cache, and the request the user sends on return carries the
 * shorter context instead of rewriting the long one uncached.
 *
 * Timing follows pi-keepwarm: the anchor is the start of the last provider
 * request of a run. Any run counts (user input, sub-agent wake, throttle kick)
 * except the idle check itself, so one idle period gets at most one check.
 */
export declare const IDLE_CHECK_CUSTOM_TYPE = "acp-idle-check";
export declare const DEFAULT_IDLE_MINUTES = 29;
/** Timer woke this much later than planned (machine slept): the cache is likely cold, skip. */
export declare const IDLE_LATE_MS = 60000;
export interface IdleCompactConfig {
    enabled?: boolean;
    /** Minutes of idle time before the check. Default 29. */
    idleMinutes?: number;
}
export interface ResolvedIdleCompact {
    enabled: boolean;
    idleMinutes: number;
}
export declare function resolveIdleCompact(cfg: boolean | IdleCompactConfig | undefined): ResolvedIdleCompact;
export declare function idleCheckText(awayMinutes: number): string;
export interface IdleCompactHandle {
    /** Record the last context event's compressible mass (context hook, every event). */
    noteNudge(sid: string, nudge: NudgeDecision | undefined): void;
    /** True once per idle check: the context hook appends the nudge even below its usual thresholds. */
    takeForcedNudge(sid: string): boolean;
    /** Re-plan the pending timer after the config changed (settings panel). */
    rearm(): void;
}
export declare function wireIdleCompact(pi: ExtensionAPI, runtime: AcpRuntime): IdleCompactHandle;
