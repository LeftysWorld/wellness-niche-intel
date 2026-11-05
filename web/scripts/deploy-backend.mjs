// Runs at the end of every Vercel build. On production builds it deploys the
// Supabase backend from the same commit: database migrations, then the api
// edge function, then a smoke test. It needs two Vercel environment variables
// (Production, marked Sensitive): SUPABASE_ACCESS_TOKEN and SUPABASE_DB_PASSWORD.
// Neither has a VITE_ prefix, so neither is ever bundled into the web app.
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const PROJECT_REF = 'tocukdtdeyarswmngjic';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const env = process.env;

if (env.VERCEL_ENV !== 'production') {
  console.log(`[backend] ${env.VERCEL_ENV ?? 'local'} build: backend not deployed (production builds only).`);
  process.exit(0);
}
if (!env.SUPABASE_ACCESS_TOKEN) {
  console.log('[backend] SUPABASE_ACCESS_TOKEN is not set in Vercel; skipping the backend deploy.');
  process.exit(0);
}

// Secrets never go on a command line: the Supabase CLI reads SUPABASE_ACCESS_TOKEN
// and SUPABASE_DB_PASSWORD from the environment, and a failed command's error
// (which repeats the command) is replaced by a short message with secrets masked.
const secrets = [env.SUPABASE_ACCESS_TOKEN, env.SUPABASE_DB_PASSWORD].filter(Boolean);
const mask = (text) => secrets.reduce((t, s) => t.split(s).join('***'), String(text));
const run = (cmd, { soft = false } = {}) => {
  console.log(`[backend] ${mask(cmd)}`);
  try {
    // "y" answers any confirmation prompt; the build has no terminal.
    execSync(cmd, { cwd: root, stdio: ['pipe', 'inherit', 'inherit'], input: 'y\n', env });
    return true;
  } catch (e) {
    console.error(`[backend] failed (exit ${e.status ?? '?'}): ${mask(cmd)}`);
    if (soft) return false;
    process.exit(1);
  }
};
const cli = 'npx -y supabase@latest';
const sha = env.VERCEL_GIT_COMMIT_SHA ?? 'unknown';

if (env.SUPABASE_DB_PASSWORD) {
  run(`${cli} link --project-ref ${PROJECT_REF}`);
  // Newer CLIs target the linked project with --remote; older ones with --linked.
  if (!run(`${cli} db push --remote`, { soft: true })) run(`${cli} db push --linked`);
} else {
  console.log('[backend] SUPABASE_DB_PASSWORD is not set; skipping migrations.');
}
// Record which commit the backend runs, so the app can warn if it falls behind.
run(`${cli} secrets set BACKEND_VERSION=${sha} --project-ref ${PROJECT_REF} --yes`);
run(`${cli} functions deploy api --project-ref ${PROJECT_REF} --no-verify-jwt --use-api --yes`);

// Smoke test: the backend must answer, and must refuse a call with no credentials.
const res = await fetch(`https://${PROJECT_REF}.supabase.co/functions/v1/api/fit-screen`, { method: 'POST' });
if (res.status !== 401) {
  console.error(`[backend] smoke test failed: expected 401 without credentials, got ${res.status}`);
  process.exit(1);
}
console.log('[backend] deployed and smoke-tested.');
