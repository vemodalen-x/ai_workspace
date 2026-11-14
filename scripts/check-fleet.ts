/** Explicit read-only hardware acceptance. Never imports an Agent or launches a Run. */
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { collectMetrics } from '../packages/resource-manager/index.ts';
import { remoteRequest, sshNodeInput } from '../packages/orchestration/remote.ts';
import { metricsSchema } from '../packages/shared/telemetry.ts';
const schema = z
  .array(sshNodeInput.extend({ minGpus: z.number().int().min(0).max(256).default(0) }))
  .max(63);
async function main() {
  const [configPath, ...extra] = process.argv.slice(2);
  if (extra.length) throw new Error('Usage: npm run check:fleet -- [fleet.local.json]');
  const nodes = configPath ? schema.parse(JSON.parse(await readFile(configPath, 'utf8'))) : [];
  function report(name: string, value: unknown, min: number) {
    const m = metricsSchema.parse(value);
    console.log(
      JSON.stringify({
        node: name,
        at: m.at,
        cores: m.cores,
        ramGiB: Math.round(m.ramTotalMb / 1024),
        gpuStatus: m.gpus === null ? 'Unavailable' : 'observed',
        gpus: m.gpus,
      }),
    );
    if ((m.gpus?.length ?? 0) < min) throw new Error(`${name}: fewer than ${min} GPUs observed`);
  }
  report('local', await collectMetrics(), 0);
  for (let i = 0; i < nodes.length; i += 2) {
    const results = await Promise.allSettled(
      nodes.slice(i, i + 2).map(async (n) => {
        let value: unknown;
        await remoteRequest(
          { ...n, id: n.sshAlias, kind: 'ssh', status: 'unknown' },
          { op: 'metrics' },
          AbortSignal.timeout(20000),
          (line) => {
            if (line.kind === 'metrics') value = line.metrics;
          },
        );
        report(n.name, value, n.minGpus);
      }),
    );
    results.forEach((r, j) => {
      if (r.status === 'rejected') {
        console.error(
          `${nodes[i + j].name}: ${r.reason instanceof Error ? r.reason.message : 'Probe failed'}`,
        );
        process.exitCode = 1;
      }
    });
  }
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
