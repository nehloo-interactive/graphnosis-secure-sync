import type { DeviceId, OpLogEvent, GraphId } from '../types.js';
export interface OpLogWriterOptions {
    dir: string;
    deviceId: DeviceId;
    key: Uint8Array;
    salt: Uint8Array;
}
export declare class OpLogWriter {
    private readonly opts;
    private sessionId;
    private buffer;
    private flushing;
    constructor(opts: OpLogWriterOptions);
    private filePath;
    emit(partial: Omit<OpLogEvent, 'id' | 'ts' | 'deviceId' | 'sessionId'>): OpLogEvent;
    flush(): Promise<void>;
}
export declare function readAllEvents(dir: string, passphraseOrKey: string | Uint8Array): Promise<OpLogEvent[]>;
export declare function reduce(events: OpLogEvent[]): Map<GraphId, MaterializedGraphState>;
export interface MaterializedGraphState {
    nodes: Map<string, {
        data: unknown;
        ts: number;
        deviceId: DeviceId;
    }>;
    edges: Map<string, {
        data: unknown;
        ts: number;
        deviceId: DeviceId;
    }>;
    sources: Map<string, {
        data: unknown;
        ts: number;
        deviceId: DeviceId;
    }>;
}
//# sourceMappingURL=index.d.ts.map