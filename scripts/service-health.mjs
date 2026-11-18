import { URL } from 'node:url';
import process from 'node:process';
import console from 'node:console';
const base = `http://127.0.0.1:${process.env.API_PORT ?? 4310}/api`;
try {
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
  const { token } = await bootstrap.json();
  if (typeof token !== 'string' || !token) throw new Error('Missing bootstrap token');
  const response = await globalThis.fetch(`${base}/snapshot`, {
    signal,
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`Snapshot HTTP ${response.status}`);
  const snapshot = await response.json();
  if (!Array.isArray(snapshot.projects) || !snapshot.nodes?.length)
    throw new Error('Invalid workspace snapshot');
  console.log('Workspace Web/API and database are healthy');
} catch (error) {
  console.error(`Workspace health check failed: ${error.message}`);
  process.exitCode = 1;
}
