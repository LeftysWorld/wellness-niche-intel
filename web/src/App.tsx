import { useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { OWNER_EMAIL, supabase } from './supabase.ts';
import { Rankings } from './pages/Rankings.tsx';
import { PairingPage } from './pages/Pairing.tsx';
import { Review } from './pages/Review.tsx';
import { Runs } from './pages/Runs.tsx';

const NAV = [
  ['results', 'Results'],
  ['review', 'To review'],
  ['activity', 'Activity'],
] as const;

function useHash() {
  const [hash, setHash] = useState(location.hash.slice(1) || 'results');
  useEffect(() => {
    const on = () => setHash(location.hash.slice(1) || 'results');
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  return hash;
}

// One owner, one password. The account is created in the Supabase dashboard
// with "Auto Confirm", so no email is ever sent.
function Login() {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <main className="login">
      <h1>Wellness Niche Intel</h1>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          const { error } = await supabase.auth.signInWithPassword({ email: OWNER_EMAIL, password });
          setBusy(false);
          if (error) setError('Wrong password');
        }}
      >
        <input type="password" required autoFocus placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <button type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        {error && <p className="err">{error}</p>}
      </form>
    </main>
  );
}

export function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const hash = useHash();
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);
  if (session === undefined) return null;
  if (!session) return <Login />;

  const [page, id] = hash.split('/');
  return (
    <div className="shell">
      <nav>
        <strong>Niche Intel</strong>
        {NAV.map(([k, label]) => (
          <a key={k} href={`#${k}`} className={page === k ? 'active' : ''}>
            {label}
          </a>
        ))}
        <span className="spacer" />
        <button className="link" onClick={() => supabase.auth.signOut()}>
          Sign out
        </button>
      </nav>
      <main>
        {page === 'pairing' && id && <PairingPage id={id} />}
        {page === 'results' && <Rankings />}
        {page === 'review' && <Review />}
        {page === 'activity' && <Runs />}
      </main>
    </div>
  );
}
