import type { ConnectionOptions } from 'node:tls';

const VERIFY_MODES = ['verify-full', 'verify-ca'];

/**
 * TLS settings for any connection, app or admin. Messages name the variable only: its value holds the password.
 * pg lets the connection string override `ssl`, so sslmode leaves the URL once it has been read.
 * Limit: without `DATABASE_CA_PEM`, `require` encrypts but does not check who answers. Supabase hands out its CA only
 * from the dashboard; once it is set, nothing weaker than verify-ca is accepted.
 */
export function connectionConfig(raw: string, name: string, caPem?: string) {
  if (!URL.canParse(raw)) throw new Error(`${name} must be a valid connection string`);
  const url = new URL(raw);
  const mode = url.searchParams.get('sslmode') ?? '';
  let ssl: ConnectionOptions;
  if (caPem) {
    if (!caPem.includes('-----BEGIN CERTIFICATE-----')) throw new Error('DATABASE_CA_PEM must hold a PEM certificate');
    if (!VERIFY_MODES.includes(mode)) throw new Error(`${name} must set sslmode=verify-full or verify-ca once DATABASE_CA_PEM is set`);
    ssl = { ca: caPem, rejectUnauthorized: true };
    if (mode === 'verify-ca') ssl.checkServerIdentity = () => undefined;
  } else {
    if (VERIFY_MODES.includes(mode)) throw new Error(`${name} sets sslmode=${mode}, which needs DATABASE_CA_PEM`);
    if (mode !== 'require') throw new Error(`${name} must set sslmode=require or stricter`);
    ssl = { rejectUnauthorized: false };
  }
  for (const param of ['sslmode', 'uselibpqcompat', 'sslrootcert', 'sslcert', 'sslkey']) url.searchParams.delete(param);
  return { connectionString: url.href, ssl };
}
