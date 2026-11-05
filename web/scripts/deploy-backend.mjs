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

const run = (cmd) => {
  console.log(`[backend] ${cmd.replace(/--password \S+/, '--password ***')}`);
  execSync(cmd, { cwd: root, stdio: 'inherit', env });
};
const cli = 'npx -y supabase@latest';
const sha = env.VERCEL_GIT_COMMIT_SHA ?? 'unknown';

if (env.SUPABASE_DB_PASSWORD) {
  run(`${cli} link --project-ref ${PROJECT_REF} --password ${env.SUPABASE_DB_PASSWORD}`);
  run(`${cli} db push --password ${env.SUPABASE_DB_PASSWORD}`);
} else {
  console.log('[backend] SUPABASE_DB_PASSWORD is not set; skipping migrations.');
}
// Record which commit the backend runs, so the app can warn if it falls behind.
run(`${cli} secrets set BACKEND_VERSION=${sha} --project-ref ${PROJECT_REF}`);
run(`${cli} functions deploy api --project-ref ${PROJECT_REF} --no-verify-jwt --use-api`);

// Smoke test: the backend must answer, and must refuse a call with no credentials.
const res = await fetch(`https://${PROJECT_REF}.supabase.co/functions/v1/api/fit-screen`, { method: 'POST' });
if (res.status !== 401) {
  console.error(`[backend] smoke test failed: expected 401 without credentials, got ${res.status}`);
  process.exit(1);
}
console.log('[backend] deployed and smoke-tested.');
