import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { NudgeDecision } from "acp-kernel";
import { viableRanges } from "acp-kernel";
import type { AcpRuntime } from "./runtime.js";
import { logInfo, logWarn } from "./log.js";

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

export const IDLE_CHECK_CUSTOM_TYPE = "acp-idle-check";
export const DEFAULT_IDLE_MINUTES = 29;
/** Timer woke this much later than planned (machine slept): the cache is likely cold, skip. */
export const IDLE_LATE_MS = 60_000;
/** Tools the model may call during the check; everything else is blocked. */
const IDLE_ALLOWED_TOOLS = new Set(["compress", "fold", "unfold", "search", "status", "cache"]);

export interface IdleCompactConfig {
  enabled?: boolean;
  /** Minutes of idle time before the check. Default 29. */
  idleMinutes?: number;
}

export interface ResolvedIdleCompact {
  enabled: boolean;
  idleMinutes: number;
}

let warnedMinutes: unknown;

export function resolveIdleCompact(cfg: boolean | IdleCompactConfig | undefined): ResolvedIdleCompact {
  if (cfg === true) return { enabled: true, idleMinutes: DEFAULT_IDLE_MINUTES };
  if (!cfg || typeof cfg !== "object") return { enabled: false, idleMinutes: DEFAULT_IDLE_MINUTES };
  const raw = cfg.idleMinutes;
  let idleMinutes = DEFAULT_IDLE_MINUTES;
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 1) idleMinutes = raw;
  else if (raw !== undefined && raw !== warnedMinutes) {
    warnedMinutes = raw;
    console.warn(`[bcp] acp.json "idleCompact.idleMinutes" must be a number >= 1 — using ${DEFAULT_IDLE_MINUTES}`);
  }
  return { enabled: cfg.enabled === true, idleMinutes };
}

export function idleCheckText(awayMinutes: number): string {
  return `[ACP idle compact] The user has been away for about ${awayMinutes} minutes. ` +
    "This is an automatic maintenance turn, not a user request: decide whether consumed history is worth compressing now, using the ranges listed below. " +
    "Do not continue other work and do not call tools other than compress and fold. If nothing is worth compressing, reply with one short line.";
}

export interface IdleCompactHandle {
  /** Record the last context event's compressible mass (context hook, every event). */
  noteNudge(sid: string, nudge: NudgeDecision | undefined): void;
  /** True once per idle check: the context hook appends the nudge even below its usual thresholds. */
  takeForcedNudge(sid: string): boolean;
  /** Re-plan the pending timer after the config changed (settings panel). */
  rearm(): void;
}

type IdleRun = "none" | "pending" | "active" | "lifted";

interface IdleState {
  sid: string | undefined;
  ctx: ExtensionContext | undefined;
  running: boolean;
  lastTouch: number;
  /** An idle check already ran for the current activity period. */
  checked: boolean;
  run: IdleRun;
  forceNudge: boolean;
  pending: number;
  minBenefit: number;
  viable: number;
  timer: ReturnType<typeof setTimeout> | undefined;
}

function freshState(): IdleState {
  return { sid: undefined, ctx: undefined, running: false, lastTouch: 0, checked: false, run: "none", forceNudge: false, pending: 0, minBenefit: Infinity, viable: 0, timer: undefined };
}

function isRealMessage(message: unknown): boolean {
  const m = message as { role?: string; customType?: string } | undefined;
  if (m?.role === "user") return true;
  return m?.role === "custom" && m.customType !== IDLE_CHECK_CUSTOM_TYPE;
}

export function wireIdleCompact(pi: ExtensionAPI, runtime: AcpRuntime): IdleCompactHandle {
  let s = freshState();

  const config = () => resolveIdleCompact(runtime.adapter.idleCompact);
  const clearTimer = () => {
    if (s.timer) clearTimeout(s.timer);
    s.timer = undefined;
  };
  const invalidate = () => {
    clearTimer();
    s.lastTouch = 0;
  };

  const skip = (reason: string, extra: Record<string, unknown> = {}) => {
    logInfo("idle-compact", { sid: s.sid ?? null, event: "skip", reason, ...extra });
  };

  const schedule = () => {
    clearTimer();
    if (s.running || s.checked || s.lastTouch === 0) return;
    const cfg = config();
    if (!cfg.enabled) return;
    const at = s.lastTouch + cfg.idleMinutes * 60_000;
    s.timer = setTimeout(() => fire(at), Math.max(0, at - Date.now()));
    (s.timer as { unref?: () => void }).unref?.();
  };

  const fire = (plannedAt: number) => {
    s.timer = undefined;
    const ctx = s.ctx;
    if (!ctx || s.running || s.checked || !config().enabled) return;
    if (runtime.refused) return;
    if (ctx.mode !== "tui" && ctx.mode !== "rpc") return;
    if (!ctx.isIdle()) return;
    let sid: string;
    try {
      sid = ctx.sessionManager.getSessionId();
    } catch {
      return; // stale context after a session replacement
    }
    if (sid !== s.sid) return;
    const idleMs = Date.now() - s.lastTouch;
    const lateMs = Date.now() - plannedAt;
    if (lateMs > IDLE_LATE_MS) return skip("timer-late", { idleMs, lateMs });
    if (runtime.throttleFor(sid).state.candidate) return skip("throttle-retry-pending");
    if (s.viable === 0 || s.pending < s.minBenefit) {
      return skip("below-benefit", { pending: s.pending, minBenefit: s.minBenefit, viable: s.viable });
    }
    s.checked = true;
    s.run = "pending";
    s.forceNudge = true;
    const awayMinutes = Math.round(idleMs / 60_000);
    try {
      pi.sendMessage({ customType: IDLE_CHECK_CUSTOM_TYPE, content: idleCheckText(awayMinutes), display: true }, { triggerTurn: true });
    } catch (e) {
      s.run = "none";
      s.forceNudge = false;
      logWarn("idle-compact", { sid, event: "send-failed", error: e instanceof Error ? e.message : String(e) });
      return;
    }
    logInfo("idle-compact", { sid, event: "check-sent", idleMs, pending: s.pending, minBenefit: s.minBenefit });
  };

  /** Real activity inside the idle check (user typed, a sub-agent woke the session): it becomes a normal run. */
  const lift = () => {
    if (s.run !== "active" && s.run !== "pending") return;
    s.run = "lifted";
    s.checked = false;
    logInfo("idle-compact", { sid: s.sid ?? null, event: "lifted" });
  };

  /** Track the live context; a different session id starts from scratch. */
  const bind = (ctx: ExtensionContext) => {
    const sid = ctx.sessionManager.getSessionId();
    if (sid !== s.sid) {
      clearTimer();
      s = freshState();
      s.sid = sid;
    }
    s.ctx = ctx;
  };

  pi.on("session_start", (_event, ctx) => {
    clearTimer();
    s = freshState();
    bind(ctx);
  });
  pi.on("session_shutdown", () => {
    clearTimer();
    s = freshState();
  });
  // Both change the cached prefix while the user is present; the next run re-arms.
  pi.on("model_select", () => invalidate());
  pi.on("session_tree", () => invalidate());

  pi.on("agent_start", (_event, ctx) => {
    bind(ctx);
    s.running = true;
    clearTimer();
    if (s.run === "pending") s.run = "active";
    else if (s.run === "none") s.checked = false;
  });
  pi.on("before_provider_request", (_event, ctx) => {
    // Idle-time requests (keepwarm, Pi's idle warmer) are not activity.
    if (!s.running) return undefined;
    bind(ctx);
    s.lastTouch = Date.now();
    return undefined;
  });
  // Extension input (sub-agent wakes, throttle kicks) is caught by message_end below.
  pi.on("input", (event) => {
    if (event.source !== "extension") lift();
  });
  pi.on("message_end", (event) => {
    if (isRealMessage(event.message)) lift();
  });
  pi.on("tool_call", (event) => {
    if (s.run !== "active" || IDLE_ALLOWED_TOOLS.has(event.toolName)) return undefined;
    return { block: true, reason: "Fold idle compact: only compress and fold may run while the user is away. Reply with one short line instead." };
  });
  pi.on("agent_settled", (_event, ctx) => {
    bind(ctx);
    s.running = false;
    const wasIdleCheck = s.run === "active";
    s.run = "none";
    s.forceNudge = false;
    if (wasIdleCheck) logInfo("idle-compact", { sid: s.sid ?? null, event: "check-done" });
    schedule();
  });

  return {
    noteNudge(sid, nudge) {
      if (sid !== s.sid) return;
      s.pending = nudge?.breakdown?.maxPending ?? 0;
      s.minBenefit = nudge?.breakdown?.minPressureBenefit ?? Infinity;
      s.viable = nudge ? viableRanges(nudge.compressibleRanges).length : 0;
    },
    takeForcedNudge(sid) {
      if (sid !== s.sid || !s.forceNudge || s.run === "lifted") return false;
      s.forceNudge = false;
      return true;
    },
    rearm() {
      if (!s.running) schedule();
    },
  };
}
