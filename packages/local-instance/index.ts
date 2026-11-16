import { createHash, randomBytes } from 'node:crypto';
import { createServer, request, type Server } from 'node:http';
import { link, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface Owner {
  pid: number;
  key?: string;
}

function endpoint(directory: string) {
  const path = process.platform === 'win32' ? directory.toLowerCase() : directory;
  const id = createHash('sha256').update(path).digest('hex').slice(0, 32);
  if (process.platform === 'win32') return '\\\\.\\pipe\\ai-workspace-' + id;
  if (process.platform === 'linux') return '\0ai-workspace-' + id;
  return join(tmpdir(), 'ai-workspace-' + id + '.sock');
}

async function owner(directory: string): Promise<Owner | undefined> {
  try {
    return JSON.parse(await readFile(join(directory, 'server.lock'), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}

function closeServer(server: Server) {
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

// The OS owns the pipe for the lifetime of the server. A crash releases it even
// when the process cannot remove the metadata file or its PID is later reused.
export async function acquireInstance(dataDir: string, stop: () => void) {
  const directory = await realpath(dataDir);
  const lock = join(directory, 'server.lock');
  const key = randomBytes(32).toString('hex');
  let url = '';
  const server = createServer((req, reply) => {
    if (req.headers.authorization !== 'Bearer ' + key) {
      reply.writeHead(403).end();
    } else if (req.method === 'GET' && req.url === '/status') {
      reply.writeHead(200).end(JSON.stringify({ url }));
    } else if (req.method === 'POST' && req.url === '/stop' && url) {
      reply.once('finish', stop);
      reply.writeHead(202).end('{}');
    } else {
      reply.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(endpoint(directory), () => {
      server.off('error', reject);
      resolve();
    });
  });
  try {
    const previous = await owner(directory);
    if (previous && !previous.key) {
      try {
        process.kill(previous.pid, 0);
        throw new Error('Stop the previous version of the workspace before opening this database.');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }
    const pending = lock + '.' + key;
    await writeFile(pending, JSON.stringify({ key, pid: process.pid }), {
      flag: 'wx',
      mode: 0o600,
    });
    try {
      if (previous) await rename(pending, lock);
      else await link(pending, lock);
    } finally {
      await unlink(pending).catch(() => {});
    }
  } catch (error) {
    await closeServer(server);
    throw error;
  }
  return {
    ready(address: string) {
      url = address;
    },
    async close() {
      try {
        await unlink(lock);
      } finally {
        await closeServer(server);
      }
    },
  };
}

export async function contactInstance(dataDir: string, action: 'status' | 'stop') {
  const current = await owner(dataDir);
  if (!current?.key) return undefined;
  const socketPath = endpoint(await realpath(dataDir));
  return new Promise<{ url?: string } | undefined>((resolve, reject) => {
    const req = request(
      {
        socketPath,
        path: '/' + action,
        method: action === 'stop' ? 'POST' : 'GET',
        headers: { authorization: 'Bearer ' + current.key, connection: 'close' },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8').on('data', (chunk: string) => (body += chunk));
        res.on('error', reject);
        res.on('end', () => {
          if (res.statusCode === 403 && action === 'status') {
            // A new owner can bind its socket just before publishing its new key.
            resolve({});
            return;
          }
          if (res.statusCode !== 200 && res.statusCode !== 202) {
            reject(new Error('The workspace is changing state. Please retry.'));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.setTimeout(3000, () => req.destroy(new Error('Workspace status timed out.')));
    req.on('error', (error: NodeJS.ErrnoException) => {
      if (['ENOENT', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE'].includes(error.code ?? ''))
        resolve(undefined);
      else reject(error);
    });
    req.end();
  });
}
