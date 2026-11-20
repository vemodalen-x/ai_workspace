export interface ExecutionSummary {
  taskId: string;
  generatedAt: string;
  method: 'evidence-extract';
  runs: {
    id: string;
    sessionId: string;
    provider: string;
    model?: string;
    state: string;
    createdAt: string;
    endedAt?: string;
    error?: string;
    conclusion: string;
    commands: string[];
    files: string[];
    evidenceCount: number;
    truncated: boolean;
  }[];
  histories: {
    sessionId: string;
    provider: string;
    status: 'loaded' | 'unavailable' | 'skipped';
    source?: string;
    conclusion?: string;
    commands?: string[];
    files?: string[];
    detail: string;
  }[];
}
