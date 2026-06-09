export type DeviceId = string;
export type GraphId = string;
export type NodeId = string;
export type OpKind = 'addNode' | 'editNode' | 'deleteNode' | 'addEdge' | 'deleteEdge' | 'supersede' | 'merge' | 'ingestSource' | 'forgetSource';
export interface OpLogEvent {
    id: string;
    ts: number;
    deviceId: DeviceId;
    sessionId: string;
    graphId: GraphId;
    op: OpKind;
    target: {
        kind: 'node' | 'edge' | 'source';
        id: string;
    };
    before?: unknown;
    after?: unknown;
    /**
     * Strictly-monotonic per-device counter (op-log v2). Persisted by the device
     * so it never rewinds across restarts. The reader uses it to detect dropped
     * (gap), replayed, or reordered events. Absent on legacy v1 events, which are
     * read best-effort and grandfathered.
     */
    seq?: number;
}
/**
 * An integrity problem surfaced while reading the op-log. Unlike the old silent
 * skip, these are returned to the caller so the app can alert the user: a
 * dropped/replayed/reordered event or a failed signature on a synced file is a
 * possible tamper, not just "leftover from an old passphrase".
 */
export interface OpLogIntegrityIssue {
    kind: 'signature-invalid' | 'unknown-device' | 'seq-gap' | 'seq-rewind' | 'future-timestamp' | 'malformed';
    deviceId?: DeviceId;
    file: string;
    detail: string;
}
export interface SubgraphBudget {
    maxTokens: number;
    maxNodes: number;
    perGraphMinTokens?: number;
}
//# sourceMappingURL=types.d.ts.map