// Writes every conversation as the JSON of GET /dashboard/conversations, to stdout, with payloads in full. `--redact`
// for a public demo snapshot: the same rule as ?redact=1, applied once to the whole export so pseudonymous ids (c1, t1)
// stay consistent across pages. Read-only transaction.
// Uses ADMIN_DATABASE_URL (postgres role) if set, else DATABASE_URL (bridge_app); either way it reads the bridge schema.
import pg from 'pg';
import { connectionConfig } from '../src/db.ts';
import { type Conversation, listConversations, redactConversations } from '../src/dashboard.ts';

const PAGE = 100;
const redact = process.argv.includes('--redact');
const name = process.env.ADMIN_DATABASE_URL ? 'ADMIN_DATABASE_URL' : 'DATABASE_URL';
const url = process.env[name];
if (!url) throw new Error('ADMIN_DATABASE_URL or DATABASE_URL is required');

const client = new pg.Client(connectionConfig(url, name, process.env.DATABASE_CA_PEM));
await client.connect();
try {
  // One snapshot for every page. SET LOCAL ends with the transaction, so this also works through the pooler.
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await client.query('SET LOCAL search_path = bridge');
  const conversations: Conversation[] = [];
  let before: string | undefined;
  let data_label = '';
  do {
    const page = await listConversations(client, { limit: PAGE, before, redact: false, truncate: false });
    conversations.push(...page.conversations);
    data_label = page.data_label;
    before = page.next_before ?? undefined;
  } while (before);
  await client.query('COMMIT');
  const out = redact ? redactConversations(conversations) : conversations;
  process.stdout.write(`${JSON.stringify({ data_label, conversations: out, next_before: null }, null, 2)}\n`);
} finally {
  await client.end();
}
