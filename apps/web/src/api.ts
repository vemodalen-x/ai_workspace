import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Snapshot, StoredEvent } from '../../../packages/shared/index.ts';
let token = '';
export async function authenticate() {
  const r = await fetch('/api/bootstrap');
  if (!r.ok) throw new Error('Cannot connect to the local server');
  token = (await r.json()).token;
}
export async function api<T = unknown>(path: string, method = 'GET', body?: unknown): Promise<T> {
  if (!token) await authenticate();
  const response = await fetch(`/api${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status === 401) {
    await authenticate();
    throw new Error('Server restarted. Retry the action.');
  }
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(data?.error ?? `Request failed: ${response.status}`);
  return data as T;
}
export function useWorkspace() {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ['snapshot'],
    queryFn: () => api<Snapshot>('/snapshot'),
    refetchInterval: 4000,
    retry: 2,
  });
  const [events, setEvents] = useState<StoredEvent[]>([]),
    [connected, setConnected] = useState(false);
  const cursor = useRef(0);
  useEffect(() => {
    let disposed = false,
      socket: WebSocket | undefined,
      timer: ReturnType<typeof setTimeout> | undefined,
      refresh: ReturnType<typeof setTimeout> | undefined,
      retries = 0;
    const connect = async () => {
      try {
        await authenticate();
        if (disposed) return;
        socket = new WebSocket(
          `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/events/ws?after=${cursor.current}`,
          ['workspace', `auth.${token}`],
        );
        socket.onopen = () => {
          setConnected(true);
          retries = 0;
          void client.invalidateQueries({ queryKey: ['snapshot'] });
        };
        socket.onmessage = (e) => {
          const event = JSON.parse(e.data) as StoredEvent;
          if (event.seq <= cursor.current) return;
          cursor.current = event.seq;
          setEvents((old) => [...old, event].slice(-5000));
          if (!refresh)
            refresh = setTimeout(() => {
              void client.invalidateQueries({ queryKey: ['snapshot'] });
              refresh = undefined;
            }, 200);
        };
        socket.onclose = () => {
          setConnected(false);
          if (!disposed)
            timer = setTimeout(() => void connect(), Math.min(1000 * 2 ** retries++, 15000));
        };
        socket.onerror = () => socket?.close();
      } catch {
        if (!disposed) timer = setTimeout(() => void connect(), 3000);
      }
    };
    void connect();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      if (refresh) clearTimeout(refresh);
      socket?.close();
    };
  }, [client]);
  return {
    ...query,
    events,
    connected,
    refresh: () => client.invalidateQueries({ queryKey: ['snapshot'] }),
  };
}
