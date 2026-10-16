/** Single source of truth for turn-boundary decisions (#364): per-turn token
 *  estimation, turnKey scoping and compress-outcome scoping all ask the same
 *  question. A turn starts at a genuine user-role message. */
/** Minimal structural shape of a session-log entry for boundary checks. Pi's
 *  SessionEntry and the narrower arrays used by token accounting both satisfy
 *  it without casts. */
export interface TurnBoundaryEntry {
    type?: string;
    id?: string;
    customType?: string;
    content?: unknown;
    message?: {
        role?: string;
    };
}
/** Does this entry start a new turn? */
export declare function isTurnBoundary(entry: TurnBoundaryEntry): boolean;
/** Id of the last turn-boundary entry — the per-turn key for nudge
 *  accounting, retry caps and outcome scoping. Returns undefined when no
 *  boundary exists yet. */
export declare function lastTurnBoundaryId(entries: readonly TurnBoundaryEntry[]): string | undefined;
/** Index of the last turn-boundary entry — the start of the current turn for
 *  compress-outcome scoping; -1 when no boundary has been seen yet. */
export declare function lastTurnBoundaryIndex(entries: readonly TurnBoundaryEntry[]): number;
