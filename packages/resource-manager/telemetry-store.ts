import type { DatabaseSync } from 'node:sqlite';
import { metricsSchema, type TelemetrySample, type RunTelemetry } from '../shared/telemetry.ts';
import type { Metrics } from '../shared/index.ts';
/** Dedicated bounded time-series storage, separate from lifecycle events. */
export class TelemetryStore {
  constructor(private db: DatabaseSync) {
    db.exec(
      `CREATE TABLE IF NOT EXISTS telemetry(node_id TEXT NOT NULL, received_at TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(node_id, received_at));`,
    );
  }
  record(nodeId: string, value: unknown, time = Date.now()): Metrics {
    const metrics = { ...metricsSchema.parse(value), receivedAt: new Date(time).toISOString() };
    const latest = this.db
      .prepare(
        'SELECT received_at FROM telemetry WHERE node_id=? ORDER BY received_at DESC LIMIT 1',
      )
      .get(nodeId);
    if (!latest || time - Date.parse(String(latest.received_at)) >= 10000) {
      this.db
        .prepare('INSERT OR IGNORE INTO telemetry VALUES(?,?,?)')
        .run(
          nodeId,
          metrics.receivedAt,
          JSON.stringify({ ...metrics, gpuProcesses: null, processes: [] }),
        );
      // At most 2,160 samples per node (~6 hours at the 10s minimum cadence).
      this.db
        .prepare(
          'DELETE FROM telemetry WHERE node_id=? AND received_at <= (SELECT received_at FROM telemetry WHERE node_id=? ORDER BY received_at DESC LIMIT 1 OFFSET 2160)',
        )
        .run(nodeId, nodeId);
    }
    return metrics;
  }
  runWindow(nodeId: string, gpuId: string | null, from: string, until: string): RunTelemetry {
    const row = this.db
      .prepare(
        `SELECT count(*) AS count, min(t.received_at) AS first, max(t.received_at) AS last,
      count(json_extract(g.value,'$.utilization')) AS util_count, avg(json_extract(g.value,'$.utilization')) AS util,
      max(json_extract(g.value,'$.usedMb')) AS memory, max(json_extract(g.value,'$.temperatureC')) AS temperature
      FROM telemetry AS t LEFT JOIN json_each(t.body,'$.gpus') AS g ON json_extract(g.value,'$.id')=?
      WHERE t.node_id=? AND t.received_at>=? AND t.received_at<=?`,
      )
      .get(gpuId, nodeId, from, until)!;
    return {
      nodeId,
      gpuId,
      sampleCount: Number(row.count),
      gpuUtilSamples: Number(row.util_count),
      firstSample: row.first as string | null,
      lastSample: row.last as string | null,
      meanGpuUtil: row.util as number | null,
      maxGpuMemoryMiB: row.memory as number | null,
      maxGpuTemperatureC: row.temperature as number | null,
    };
  }
  history(nodeId: string, limit = 120): TelemetrySample[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 2160)
      throw new Error('Invalid telemetry history limit');
    return this.db
      .prepare(
        'SELECT received_at,body FROM telemetry WHERE node_id=? ORDER BY received_at DESC LIMIT ?',
      )
      .all(nodeId, limit)
      .reverse()
      .map((row) => ({
        nodeId,
        receivedAt: String(row.received_at),
        metrics: metricsSchema.parse(JSON.parse(String(row.body))),
      }));
  }
}
