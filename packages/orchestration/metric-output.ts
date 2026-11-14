import { isExperimentMetric, type ExperimentMetric } from '../shared/experiment-results.ts';

const prefix = 'WORKSPACE_METRIC ';
const maxLine = 2048;

/** Consume validation stdout in bounded lines, independent of subprocess chunk boundaries. */
export class MetricOutput {
  private pending = Buffer.alloc(0);
  private oversized = false;
  private readings = new Map<string, ExperimentMetric>();
  ignored = 0;

  push(chunk: Buffer) {
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(10, start);
      const end = newline < 0 ? chunk.length : newline;
      if (!this.oversized) {
        const remaining = maxLine - this.pending.length;
        this.pending = Buffer.concat([
          this.pending,
          chunk.subarray(start, Math.min(start + remaining, end)),
        ]);
        this.oversized = end - start > remaining;
      }
      if (newline < 0) break;
      this.flush();
      start = end + 1;
    }
  }
  private flush() {
    const line = this.pending.toString('utf8');
    if (line.startsWith(prefix)) {
      try {
        if (this.oversized) throw new Error('size');
        const p: unknown = JSON.parse(line.slice(prefix.length));
        if (!isExperimentMetric(p)) throw new Error('schema');
        const key = p.name + ':' + p.unit;
        const previous = this.readings.get(key);
        if (!previous && this.readings.size >= 32) throw new Error('capacity');
        if (!previous || p.step >= previous.step)
          this.readings.set(key, { name: p.name, value: p.value, step: p.step, unit: p.unit });
      } catch {
        this.ignored++;
      }
    }
    this.pending = Buffer.alloc(0);
    this.oversized = false;
  }
  finish() {
    this.flush();
    return [...this.readings.values()];
  }
}
