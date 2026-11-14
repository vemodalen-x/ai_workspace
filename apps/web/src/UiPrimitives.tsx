import React, { useEffect, useRef, type ReactNode } from 'react';
import { Layers, X, Check, Shield, GitBranch, Activity } from 'lucide-react';
import type { StoredEvent } from '../../../packages/shared/index.ts';
const fmt = (date: string) =>
  new Date(date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const short = (id?: string) => id?.slice(0, 8) ?? '—';
export function Empty({
  icon = <Layers />,
  title,
  children,
}: {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon">{icon}</div>
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}
export function MetricBar({
  label,
  value,
  detail,
}: {
  label: string;
  value: number | null;
  detail: string;
}) {
  return (
    <div className="metric-bar">
      <div>
        <span>{label}</span>
        <b>{value === null ? 'Unavailable' : `${value.toFixed(1)}%`}</b>
      </div>
      <div className="meter">
        <i style={{ width: `${Math.min(value ?? 0, 100)}%` }} />
      </div>
      <small>{detail}</small>
    </div>
  );
}
export function Field({
  label,
  name,
  value,
  ...props
}: { label: string; name: string; value?: string } & Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  'value'
>) {
  return (
    <label>
      {label}
      <input name={name} defaultValue={value} {...props} />
    </label>
  );
}
export function ModalFrame({
  title,
  children,
  close,
}: {
  title: string;
  children: ReactNode;
  close: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
    return () => ref.current?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="modal"
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      onClick={(e) => {
        if (e.target === ref.current) close();
      }}
    >
      <div className="modal-inner">
        <div className="modal-heading">
          <h2>{title}</h2>
          <button aria-label="Close dialog" onClick={close}>
            <X size={19} />
          </button>
        </div>
        {children}
      </div>
    </dialog>
  );
}
export function Timeline({ events, full = false }: { events: StoredEvent[]; full?: boolean }) {
  return (
    <div className={`timeline ${full ? 'full-timeline' : ''}`}>
      {events.map((e) => (
        <div className="timeline-row" key={e.id}>
          <div
            className={`event-icon ${e.type.includes('Failed') || e.type.includes('Orphaned') ? 'error' : e.type.includes('Completed') ? 'success' : ''}`}
          >
            {e.type.includes('Completed') ? (
              <Check size={14} />
            ) : e.type.includes('Approval') ? (
              <Shield size={14} />
            ) : e.type.includes('Git') ? (
              <GitBranch size={14} />
            ) : (
              <Activity size={14} />
            )}
          </div>
          <div>
            <b>{e.type.replace(/([A-Z])/g, ' $1').trim()}</b>
            <p>
              {String(
                e.data.task ??
                  e.data.name ??
                  e.data.text ??
                  e.data.error ??
                  e.data.state ??
                  e.data.action ??
                  e.data.provider ??
                  'Workspace state updated',
              ).slice(0, 180)}
            </p>
            {full && (
              <small>
                Event #{e.seq} · {e.runId ? `Run ${short(e.runId)}` : 'Workspace'}
              </small>
            )}
          </div>
          <time>{fmt(e.createdAt)}</time>
        </div>
      ))}
      {!events.length && (
        <Empty title="A clean start">Your project and execution events will appear here.</Empty>
      )}
    </div>
  );
}
