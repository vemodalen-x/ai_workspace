import { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  Project,
  Task,
  Session,
  Run,
  Workspace,
  ComputeNode,
  Reservation,
  Approval,
  Artifact,
  AgentEvent,
  StoredEvent,
} from '../shared/index.ts';
import { now } from '../shared/index.ts';
import type { Trial, TrialAttempt } from '../shared/trials.ts';

import type { ExternalSession } from '../shared/external-sessions.ts';

export interface Tables {
  externalSessions: ExternalSession;
  trials: Trial;
  attempts: TrialAttempt;
  projects: Project;
  tasks: Task;
  sessions: Session;
  runs: Run;
  workspaces: Workspace;
  nodes: ComputeNode;
  reservations: Reservation;
  approvals: Approval;
  artifacts: Artifact;
}
const tables: (keyof Tables)[] = [
  'externalSessions',
  'trials',
  'attempts',
  'projects',
  'tasks',
  'sessions',
  'runs',
  'workspaces',
  'nodes',
  'reservations',
  'approvals',
  'artifacts',
];
export class Store {
  db: DatabaseSync;
  bus = new EventEmitter();
  private pendingEvents: StoredEvent[] | null = null;
  private deliveryQueue: StoredEvent[] = [];
  private publishing = false;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    for (const table of tables)
      this.db.exec(
        `CREATE TABLE IF NOT EXISTS ${table}(id TEXT PRIMARY KEY, body TEXT NOT NULL CHECK(json_valid(body)))`,
      );
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version(version INTEGER PRIMARY KEY);
      INSERT OR IGNORE INTO schema_version VALUES(1);
      CREATE UNIQUE INDEX IF NOT EXISTS run_request ON runs(json_extract(body,'$.requestKey'));
      CREATE UNIQUE INDEX IF NOT EXISTS run_session_active ON runs(json_extract(body,'$.sessionId')) WHERE json_extract(body,'$.state') IN ('queued','starting','running','orphaned');
      CREATE UNIQUE INDEX IF NOT EXISTS run_task_active ON runs(json_extract(body,'$.taskId')) WHERE json_extract(body,'$.state') IN ('queued','starting','running','orphaned');
      CREATE UNIQUE INDEX IF NOT EXISTS workspace_path ON workspaces(json_extract(body,'$.nodeId'),json_extract(body,'$.path'));
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,run_id TEXT,session_id TEXT,project_id TEXT,type TEXT NOT NULL,data TEXT NOT NULL,event_key TEXT UNIQUE,created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS event_run ON events(run_id,seq);
      CREATE UNIQUE INDEX IF NOT EXISTS trial_request ON attempts(json_extract(body,'$.requestKey'));
      CREATE INDEX IF NOT EXISTS trial_queued ON attempts(json_extract(body,'$.state'));
      CREATE UNIQUE INDEX IF NOT EXISTS trial_active ON attempts(json_extract(body,'$.trialId'))
        WHERE json_extract(body,'$.state') IN ('queued','starting','running','orphaned');
      CREATE TABLE IF NOT EXISTS trial_output(
        attempt_id TEXT PRIMARY KEY REFERENCES attempts(id), log TEXT NOT NULL DEFAULT '',
        truncated INTEGER NOT NULL DEFAULT 0, ignored INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS trial_metrics(
        attempt_id TEXT NOT NULL REFERENCES attempts(id), name TEXT NOT NULL, unit TEXT NOT NULL,
        step INTEGER NOT NULL, value REAL NOT NULL, PRIMARY KEY(attempt_id,name,unit,step));
    `);
  }
  all<K extends keyof Tables>(table: K): Tables[K][] {
    return this.db
      .prepare(`SELECT body FROM ${table}`)
      .all()
      .map((r) => JSON.parse(r.body as string) as Tables[K]);
  }
  get<K extends keyof Tables>(table: K, id: string): Tables[K] {
    const row = this.db.prepare(`SELECT body FROM ${table} WHERE id=?`).get(id);
    if (!row) throw new Error(`${table}: not found`);
    return JSON.parse(row.body as string) as Tables[K];
  }
  put<K extends keyof Tables>(table: K, value: Tables[K]) {
    this.db
      .prepare(
        `INSERT INTO ${table}(id,body) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body`,
      )
      .run(value.id, JSON.stringify(value));
    return value;
  }
  delete<K extends keyof Tables>(table: K, id: string) {
    this.db.prepare(`DELETE FROM ${table} WHERE id=?`).run(id);
  }
  tx<T>(fn: () => T): T {
    if (this.pendingEvents) throw new Error('Nested transactions are not supported');
    this.db.exec('BEGIN IMMEDIATE');
    this.pendingEvents = [];
    let result: T;
    let committed: StoredEvent[];
    try {
      result = fn();
      if (result && typeof (result as { then?: unknown }).then === 'function')
        throw new Error('Transactions must be synchronous');
      this.db.exec('COMMIT');
      committed = this.pendingEvents;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    } finally {
      this.pendingEvents = null;
    }
    this.publish(committed);
    return result;
  }
  private publish(events: StoredEvent[]) {
    this.deliveryQueue.push(...events);
    if (this.publishing) return;
    this.publishing = true;
    try {
      while (this.deliveryQueue.length) {
        const event = this.deliveryQueue.shift()!;
        // Subscriber failures never undo commits; reentrant writes retain sequence order.
        for (const listener of this.bus.rawListeners('event')) {
          try {
            listener.call(this.bus, event);
          } catch {
            /* Recover by durable cursor replay. */
          }
        }
      }
    } finally {
      this.publishing = false;
    }
  }
  event(
    event: AgentEvent,
    context: { runId?: string; sessionId?: string; projectId?: string } = {},
  ) {
    const id = randomUUID(),
      createdAt = now();
    const key = event.key ? `${context.runId ?? 'global'}:${event.key}` : null;
    const row = this.db
      .prepare(
        'INSERT OR IGNORE INTO events(id,run_id,session_id,project_id,type,data,event_key,created_at) VALUES(?,?,?,?,?,?,?,?) RETURNING seq',
      )
      .get(
        id,
        context.runId ?? null,
        context.sessionId ?? null,
        context.projectId ?? null,
        event.type,
        JSON.stringify(event.data),
        key,
        createdAt,
      );
    if (!row) return null;
    const stored: StoredEvent = {
      ...event,
      seq: Number(row.seq),
      id,
      runId: context.runId ?? null,
      sessionId: context.sessionId ?? null,
      projectId: context.projectId ?? null,
      createdAt,
    };
    if (this.pendingEvents) this.pendingEvents.push(stored);
    else this.publish([stored]);
    return stored;
  }
  events(after = 0, limit = 1000): StoredEvent[] {
    return this.db
      .prepare('SELECT * FROM events WHERE seq>? ORDER BY seq LIMIT ?')
      .all(after, limit)
      .map((r) => ({
        seq: Number(r.seq),
        id: r.id as string,
        runId: r.run_id as string | null,
        sessionId: r.session_id as string | null,
        projectId: r.project_id as string | null,
        type: r.type as StoredEvent['type'],
        data: JSON.parse(r.data as string),
        createdAt: r.created_at as string,
      }));
  }
  latestEvents(limit = 100): StoredEvent[] {
    const row = this.db.prepare('SELECT MAX(seq) AS n FROM events').get();
    return this.events(Math.max(0, Number(row?.n ?? 0) - limit), limit);
  }
  close() {
    this.db.close();
  }
}
