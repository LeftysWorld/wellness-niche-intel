// Two ways in: the scheduler (x-cron-secret header, checked against the secret
// kept in Supabase Vault) or a signed-in owner whose email is listed in
// app_users. Everything else is rejected.
import { db } from './db.ts';
import { HttpError } from './http.ts';

export async function authorize(req: Request): Promise<{ caller: string }> {
  const given = req.headers.get('x-cron-secret');
  if (given) {
    const { data: ok } = await db().rpc('check_cron_secret', { given });
    if (ok === true) return { caller: 'cron' };
    throw new HttpError(401, 'Bad scheduler secret');
  }

  const token = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (!token) throw new HttpError(401, 'Missing credentials');
  const { data, error } = await db().auth.getUser(token);
  const email = data?.user?.email;
  if (error || !email) throw new HttpError(401, 'Invalid session');
  const { data: member } = await db().from('app_users').select('email').eq('email', email.toLowerCase()).maybeSingle();
  if (!member) throw new HttpError(403, 'Not an app user');
  return { caller: `user:${email}` };
}
