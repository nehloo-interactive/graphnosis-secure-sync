// Shared types for graphnosis-secure-sync.
// Subset of the types originally defined in @graphnosis-app/core/src/types.ts
// — only the identifiers and shapes consumed by crypto / oplog / federation
// / policy live here. App-specific types (SourceRecord, etc.) stay in the
// App.

export type DeviceId = string;
export type GraphId = string;
export type NodeId = string;

export type OpKind =
  | 'addNode'
  | 'editNode'
  | 'deleteNode'
  | 'addEdge'
  | 'deleteEdge'
  | 'supersede'
  | 'merge'
  | 'ingestSource'
  | 'forgetSource';

export interface OpLogEvent {
  id: string;
  ts: number;
  deviceId: DeviceId;
  sessionId: string;
  graphId: GraphId;
  op: OpKind;
  target: { kind: 'node' | 'edge' | 'source'; id: string };
  before?: unknown;
  after?: unknown;
}

export interface SubgraphBudget {
  maxTokens: number;
  maxNodes: number;
  perGraphMinTokens?: number;
}
