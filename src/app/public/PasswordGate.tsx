import { useState } from 'react';

interface Props {
  title: string;
  onSubmit: (password: string) => Promise<boolean>;
}

export function PasswordGate({ title, onSubmit }: Props) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);

  return (
    <div className="center-screen">
      <div className="brand-mark">Content by Carmack</div>
      <form
        className="gate-card"
        onSubmit={(e) => {
          e.preventDefault();
          if (!password || busy) return;
          setBusy(true);
          setError(false);
          void onSubmit(password).then((ok) => {
            setBusy(false);
            if (!ok) setError(true);
          });
        }}
      >
        <h1>{title || 'Private gallery'}</h1>
        <input
          className="input"
          type="password"
          placeholder="Gallery password"
          value={password}
          autoFocus
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && <div className="error-text">That password isn’t right — try again.</div>}
        <button className="btn btn-primary" type="submit" disabled={busy || !password}>
          {busy ? 'Checking…' : 'View gallery'}
        </button>
      </form>
    </div>
  );
}

export function NotFound() {
  return (
    <div className="center-screen">
      <div className="brand-mark">Content by Carmack</div>
      <p className="muted">This gallery doesn’t exist or is no longer available.</p>
    </div>
  );
}

export function Loading() {
  return <div className="center-screen muted">Loading…</div>;
}
