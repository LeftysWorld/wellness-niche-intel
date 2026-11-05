import { useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './supabase.ts';
import { Rankings } from './pages/Rankings.tsx';
import { PairingPage } from './pages/Pairing.tsx';
import { Review } from './pages/Review.tsx';
import { Niches } from './pages/Niches.tsx';
import { Ledger } from './pages/Ledger.tsx';
import { Runs } from './pages/Runs.tsx';
import { Digest } from './pages/Digest.tsx';

const NAV = [
  ['rankings', 'Rankings'],
  ['review', 'Review queue'],
  ['niches', 'Niches'],
  ['ledger', 'Ledger'],
  ['runs', 'Runs & spend'],
  ['digest', 'Digest'],
] as const;

function useHash() {
  const [hash, setHash] = useState(location.hash.slice(1) || 'rankings');
  useEffect(() => {
    const on = () => setHash(location.hash.slice(1) || 'rankings');
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  return hash;
}

function Login() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <main className="login">
      <h1>Wellness Niche Intel</h1>
      {sent ? (
        <p>Check {email} for a sign-in link.</p>
      ) : (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const { error } = await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin } });
            if (error) setError(error.message);
            else setSent(true);
          }}
        >
          <input type="email" required placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
          <button type="submit">Send sign-in link</button>
          {error && <p className="err">{error}</p>}
        </form>
      )}
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
        <small className="muted">{session.user.email}</small>
        <button className="link" onClick={() => supabase.auth.signOut()}>
          Sign out
        </button>
      </nav>
      <main>
        {page === 'pairing' && id ? <PairingPage id={id} /> : null}
        {page === 'rankings' && <Rankings />}
        {page === 'review' && <Review />}
        {page === 'niches' && <Niches />}
        {page === 'ledger' && <Ledger />}
        {page === 'runs' && <Runs />}
        {page === 'digest' && <Digest />}
      </main>
    </div>
  );
}
