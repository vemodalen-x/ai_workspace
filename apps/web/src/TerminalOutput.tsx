import { t as tr } from './i18n.ts';
import { useRef, useEffect } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { StoredEvent } from '../../../packages/shared/index.ts';
export default function TerminalOutput({ events }: { events: StoredEvent[] }) {
  const ref = useRef<HTMLDivElement>(null),
    terminal = useRef<Terminal | null>(null);
  const cursor = useRef(0);
  useEffect(() => {
    if (!ref.current) return;
    const t = new Terminal({
      disableStdin: true,
      convertEol: true,
      fontSize: 12,
      fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
      theme: { background: '#101218', foreground: '#c9d2de' },
      scrollback: 10000,
    });
    const fit = new FitAddon();
    t.loadAddon(fit);
    t.open(ref.current);
    fit.fit();
    terminal.current = t;
    cursor.current = 0;
    const obs = new ResizeObserver(() => fit.fit());
    obs.observe(ref.current);
    return () => {
      obs.disconnect();
      t.dispose();
      terminal.current = null;
    };
  }, []);
  useEffect(() => {
    const t = terminal.current;
    if (!t) return;
    for (const e of events) {
      if (e.seq <= cursor.current) continue;
      cursor.current = e.seq;
      if (e.type === 'ToolStarted') t.writeln(`> ${String(e.data.name ?? tr('Tool call'))}`);
      if (e.type === 'ToolCompleted' && e.data.output !== undefined)
        t.writeln(
          typeof e.data.output === 'string' ? e.data.output : JSON.stringify(e.data.output),
        );
      if (e.type === 'Log') t.writeln(String(e.data.text));
    }
  }, [events]);
  return (
    <>
      <p>{tr('AI Agent Workspace · captured tool output (read-only)')}</p>
      <div className="terminal" ref={ref} />
    </>
  );
}
