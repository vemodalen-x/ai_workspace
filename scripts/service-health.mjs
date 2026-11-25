import { URL } from 'node:url';
import process from 'node:process';
import console from 'node:console';
const base = `http://127.0.0.1:${process.env.API_PORT ?? 4310}/api`;
try {
  const args = process.argv.slice(2);
  const expectedCommit = args[1];
  if (
    args.length &&
    (args.length !== 2 || args[0] !== '--expect-commit' || !/^[a-f0-9]{40}$/.test(expectedCommit))
  )
    throw new Error('Usage: service-health.mjs [--expect-commit <git-sha>]');
  const signal = globalThis.AbortSignal.timeout(8000);
  const web = await globalThis.fetch(new URL('/', base), { signal });
  const html = await web.text();
  if (!web.ok || !html.includes('id="root"')) throw new Error('Workspace page unavailable');
  const asset = html.match(/src="([^"<>]+\.js)"/)?.[1];
  if (!asset) throw new Error('Workspace JavaScript reference missing');
  const assetUrl = new URL(asset, base);
  if (assetUrl.origin !== new URL(base).origin) throw new Error('Unexpected asset origin');
  const javascript = await globalThis.fetch(assetUrl, { signal });
  if (!javascript.ok || !javascript.headers.get('content-type')?.includes('javascript'))
    throw new Error('Workspace JavaScript unavailable');
  await javascript.body?.cancel();
  const bootstrap = await globalThis.fetch(`${base}/bootstrap`, { signal });
  if (!bootstrap.ok) throw new Error(`Bootstrap HTTP ${bootstrap.status}`);
  const { token, buildCommit } = await bootstrap.json();
  if (typeof token !== 'string' || !token) throw new Error('Missing bootstrap token');
  const response = await globalThis.fetch(`${base}/snapshot`, {
    signal,
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`Snapshot HTTP ${response.status}`);
  const snapshot = await response.json();
  if (!Array.isArray(snapshot.projects) || !snapshot.nodes?.length)
    throw new Error('Invalid workspace snapshot');
  if (expectedCommit) {
    if (buildCommit !== expectedCommit)
      throw new Error('Running Workspace build does not match the expected commit');
    const monitor = await globalThis.fetch(`${base}/monitor/overview`, {
      signal,
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!monitor.ok) throw new Error(`Monitor HTTP ${monitor.status}`);
    const overview = await monitor.json();
    if (
      !Array.isArray(overview.sessions) ||
      !Array.isArray(overview.sources) ||
      !overview.scannedAt
    )
      throw new Error('Invalid Workspace Monitor overview');
    console.log(`Workspace release ${expectedCommit} passed Monitor acceptance`);
  } else console.log('Workspace Web/API and database are healthy');
} catch (error) {
  console.error(`Workspace health check failed: ${error.message}`);
  process.exitCode = 1;
}
