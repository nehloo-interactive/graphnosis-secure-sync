import type { DeviceId, OpLogEvent, GraphId, OpLogIntegrityIssue } from '../types.js';
export interface OpLogWriterOptions {
    dir: string;
    deviceId: DeviceId;
    key: Uint8Array;
    salt: Uint8Array;
    /**
     * Ed25519 secret key for signing v2 chunks. When present the writer emits the
     * signed+sequenced v2 format. When absent it emits legacy v1 (unsigned) — used
     * only by tests and back-compat paths.
     */
    signSecretKey?: Uint8Array;
    /**
     * Starting sequence number (the device's persisted high-water + 1). The writer
     * assigns consecutive seqs from here and never rewinds. The app computes a safe
     * value as max(persisted counter, highest seq already in this device's file + 1).
     */
    initialSeq?: number;
    /** Persist the next-unused seq after each flush so it survives restarts. */
    persistSeq?: (nextSeq: number) => void | Promise<void>;
}
export declare class OpLogWriter {
    private readonly opts;
    private sessionId;
    private buffer;
    private flushing;
    private seq;
    constructor(opts: OpLogWriterOptions);
    private filePath;
    emit(partial: Omit<OpLogEvent, 'id' | 'ts' | 'deviceId' | 'sessionId' | 'seq'>): OpLogEvent;
    flush(): Promise<void>;
}
/** The v2 file magic (written once at the start of a v2 op-log file). Exported
 *  so the app's compaction path can produce valid v2 files. */
export declare const OPLOG_V2_MAGIC: Uint8Array<ArrayBuffer>;
/** Encode a batch of events as one signed v2 chunk (no file magic). Used by the
 *  app's op-log compaction to rewrite its own file in v2 format. The chunk's
 *  startSeq is the first event's seq; pruned events simply leave seq gaps, which
 *  the reader reports as benign. */
export declare function encodeSignedChunk(deviceId: DeviceId, batch: OpLogEvent[], key: Uint8Array, salt: Uint8Array, signSecretKey: Uint8Array): Promise<Uint8Array>;
export interface ReadOpLogOptions {
    /**
     * Look up a device's pinned Ed25519 public key (from the app's TOFU registry).
     * Required to verify v2 chunks. If omitted, v2 chunks are parsed WITHOUT
     * signature verification (back-compat / tests only). Returning undefined for a
     * known v2 file marks it unknown-device and the chunk is not trusted.
     */
    getDevicePubKey?: (deviceId: DeviceId) => Uint8Array | undefined;
    /** Called for every integrity problem so the app can alert the user. */
    onIntegrityIssue?: (issue: OpLogIntegrityIssue) => void;
    /** Events with ts beyond now+skew are dropped (clock-skew / poisoning). */
    maxClockSkewMs?: number;
    /** Injectable clock for tests. Defaults to Date.now(). */
    now?: number;
}
/** Tail-read boundary for incremental op-log reconcile (op-log v2 / Batch 6). */
export interface ReadEventsSinceOptions extends ReadOpLogOptions {
    /** Inclusive high-water ts from the last successful reconcile checkpoint. */
    sinceTs: number;
    /** When set, events at exactly `sinceTs` with seq ≤ this value are skipped. */
    sinceSeq?: number;
}
export declare function readAllEvents(dir: string, passphraseOrKey: string | Uint8Array, opts?: ReadOpLogOptions): Promise<OpLogEvent[]>;
/** Read op-log events strictly after a reconcile checkpoint (tail replay). */
export declare function readEventsSince(dir: string, passphraseOrKey: string | Uint8Array, since: ReadEventsSinceOptions): Promise<OpLogEvent[]>;
export declare function reduce(events: OpLogEvent[]): Map<GraphId, MaterializedGraphState>;
export interface MaterializedGraphState {
    nodes: Map<string, {
        data: unknown;
        ts: number;
        deviceId: DeviceId;
        seq?: number;
        deleted?: boolean;
    }>;
    edges: Map<string, {
        data: unknown;
        ts: number;
        deviceId: DeviceId;
        seq?: number;
        deleted?: boolean;
    }>;
    sources: Map<string, {
        data: unknown;
        ts: number;
        deviceId: DeviceId;
        seq?: number;
        deleted?: boolean;
    }>;
}
//# sourceMappingURL=index.d.ts.map