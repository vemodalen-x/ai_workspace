export type NativeProvider = 'codex' | 'claude';
export type SourceState = 'available' | 'missing' | 'unreadable' | 'partial';
export interface NativeConfig {
  path: string;
  scope: 'project' | 'ancestor' | 'global';
  state: SourceState;
  // Instruction text is shown; settings only expose key names, never credential values.
  content?: string;
  keys?: string[];
  truncated?: boolean;
}
export interface NativeSession {
  providerSessionId: string;
  title?: string;
  id: string;
  provider: NativeProvider;
  cwd: string;
  modifiedAt: string;
  bytes: number;
}
export interface NativeHistory {
  projectPath: string;
  configs: NativeConfig[];
  sources: { provider: NativeProvider; path: string; state: SourceState; skipped: number }[];
  sessions: NativeSession[];
}
export interface NativeOutput {
  entries: { role: string; text: string; timestamp?: string }[];
  truncated: boolean;
  skipped: number;
}

export interface HistoryTaskNode {
  id: string;
  parentId: string | null;
  sessionId: string;
  provider: NativeProvider;
  kind: 'session' | 'request' | 'plan';
  title: string;
  description: string;
  state: 'recorded' | 'pending' | 'in_progress' | 'completed';
  timestamp?: string;
  sourceOffset?: number;
}
export interface HistoryTaskTree {
  nodes: HistoryTaskNode[];
  truncated: boolean;
  skipped: number;
  unavailableSessions: number;
}
