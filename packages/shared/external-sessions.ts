export interface ExternalSession {
  id: string;
  projectId: string;
  provider: 'claude';
  providerSessionId: string;
  sourceCwd: string;
  attachedAt: string;
}

export interface ExternalSessionOutput {
  session: ExternalSession;
  entries: { role: string; text: string; timestamp?: string }[];
  bytes: number;
  modifiedAt: string;
  truncated: boolean;
  skipped: number;
}
