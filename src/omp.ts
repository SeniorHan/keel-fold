/**
 * Shown (and logged) when the extension detects an unsupported host and stands down.
 *
 * Unsupported = no Pi `buildContextEntries()` API AND no `PI_ACP_FORK_HOST` declaration
 * (see ./host.ts). OMP (oh-my-pi) falls into this by default: its in-process live-entries
 * integration diverges the nudge's example refs from the session's real refs, so compress
 * calls fail with "does not exist in this session" ([#234]).
 */
export const UNSUPPORTED_HOST_MESSAGE = [
  "[billion-context-pi-lean] Unsupported host: no buildContextEntries() API and no PI_ACP_FORK_HOST declaration — ACP has been disabled for this session.",
  "This extension is built for Pi. OMP (oh-my-pi) is not supported.",
  "Pi-compatible fork running sessions in-process? Opt in explicitly:",
  "  PI_ACP_FORK_HOST=1 <your host command>",
].join("\n");

/**
 * Shown (and logged) when a session runs on a host that declared itself a
 * Pi-compatible fork via PI_ACP_FORK_HOST (see ./host.ts). Live-tail refs are
 * content-addressed and stable across context fires (#459), which assumes the
 * host's view of the session grows append-only; a host that rewrites or
 * shrinks in-flight messages can still drift refs, so long sessions on such
 * hosts can still fail compress calls.
 */
export const FORK_HOST_WARNING_MESSAGE = [
  "[billion-context-pi-lean] Running on a declared fork host (PI_ACP_FORK_HOST). Live-tail refs are content-stable (#459); if compress ever fails with \"does not exist in this session\", this host rewrites its in-flight view and is not supported.",
].join("\n");
