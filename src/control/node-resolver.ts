// Shared execution target contract for next and feat/multi-node.

export interface ExecutionTargetBinding {
  readonly nodeId: string;
  readonly backendId: string;
  readonly logicalWorkspaceKey?: string;
}

export interface ThreeLayerGeneration {
  readonly nodeTrustEpoch: number;      // 节点注册/重连信任代际
  readonly assignmentEpoch: number;     // Assignment 或受管 Session 生命周期代际
  readonly toolTokenVersion: number;    // 工具令牌版本
}

export interface NodeLiveSnapshot {
  readonly nodeId: string;
  readonly displayName?: string;
  readonly isPrimary: boolean;
  readonly connectionStatus: 'online' | 'offline' | 'reconnecting';
  readonly lastSeenAt?: string;
  readonly backends: ReadonlyArray<{
    readonly backendId: string;
    readonly kind: string;
    readonly available: boolean;
    readonly capabilities: {
      readonly turnInterrupt: boolean;
      readonly twoStageReceipt: boolean;
      readonly sessionResume: boolean;
      readonly gitReviewDiff: boolean;
    };
  }>;
}

export type NodeResolutionErrorCode =
  | 'TARGET_NOT_FOUND'
  | 'NODE_OFFLINE'
  | 'BACKEND_UNAVAILABLE'
  | 'OWNERSHIP_MISMATCH'
  | 'STALE_GENERATION'
  | 'PERMISSION_REVOKED'
  | 'MANUALLY_STOPPED';

export type NodeResolutionResult<T> =
  | { readonly ok: true; readonly handle: T; readonly generation: ThreeLayerGeneration }
  | { readonly ok: false; readonly code: NodeResolutionErrorCode; readonly reason: string; readonly nodeId?: string };

export interface NodeResolver<THandle = unknown> {
  resolveForSession(
    controlSessionId: string,
    op: 'ensure' | 'message' | 'interrupt' | 'stop' | 'resume' | 'reconcile'
  ): Promise<NodeResolutionResult<THandle>>;
  resolveForAssignment(
    ticketId: string,
    assignmentId: string,
    op: 'dispatch' | 'message' | 'stop' | 'verify_callback'
  ): Promise<NodeResolutionResult<THandle>>;
  getLiveNodeSnapshots(): ReadonlyArray<NodeLiveSnapshot>;
}
