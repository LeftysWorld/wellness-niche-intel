import { useEffect, useState, type ReactNode } from 'react';

export function useLoad<T>(load: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    load()
      .then((d) => live && setData(d))
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { data, error, reload: () => setTick((t) => t + 1) };
}

export function Section({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="card">
      <header className="card-head">
        <h2>{title}</h2>
        <div className="actions">{actions}</div>
      </header>
      {children}
    </section>
  );
}

export function RunButton({ label, action, onDone }: { label: string; action: () => Promise<unknown>; onDone?: (r: unknown) => void }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <span className="run">
      <button
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setMsg(null);
          try {
            const r = await action();
            setMsg('Done');
            onDone?.(r);
          } catch (e) {
            setMsg(e instanceof Error ? e.message : String(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? 'Running…' : label}
      </button>
      {msg && <small className={msg === 'Done' ? 'ok' : 'err'}>{msg}</small>}
    </span>
  );
}

export const Err = ({ error }: { error: string | null }) => (error ? <p className="err">{error}</p> : null);
export const Loading = () => <p className="muted">Loading…</p>;
