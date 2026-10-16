/**
 * Shown (and logged) when the extension detects an unsupported host and stands down.
 *
 * Unsupported = no Pi `buildContextEntries()` API AND no `PI_ACP_FORK_HOST` declaration
 * (see ./host.ts). OMP (oh-my-pi) falls into this by default: its in-process live-entries
 * integration diverges the nudge's example refs from the session's real refs, so compress
 * calls fail with "does not exist in this session" ([#234]).
 */
export declare const UNSUPPORTED_HOST_MESSAGE: string;
/**
 * Shown (and logged) when a session runs on a host that declared itself a
 * Pi-compatible fork via PI_ACP_FORK_HOST (see ./host.ts). Live-tail refs are
 * content-addressed and stable across context fires (#459), which assumes the
 * host's view of the session grows append-only; a host that rewrites or
 * shrinks in-flight messages can still drift refs, so long sessions on such
 * hosts can still fail compress calls.
 */
export declare const FORK_HOST_WARNING_MESSAGE: string;
