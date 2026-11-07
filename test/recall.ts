// Recall seam for the pgvector trigger in PRD section 4: recall@5 below 80% on 50 real questions.
// Usage: node --env-file=.env.local test/recall.ts <fixture.json>
// A fixture is [{ "question": "...", "expected_keys": ["..."], "namespace": "optional" }], written from real memory
// by a person. The repo ships none on purpose: below 50 questions this reports `unmeasured`, never a number.
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { z } from 'zod';
import { memorySearch } from '../src/memory.ts';

const Fixture = z.array(z.strictObject({
  question: z.string().min(1),
  expected_keys: z.array(z.string().min(1)).min(1),
  namespace: z.string().optional(),
}));
type Question = z.infer<typeof Fixture>[number];
type Search = (q: Question, k: number) => Promise<{ key: string }[]>;

const REQUIRED = 50;
const TRIGGER = 0.8;

export async function recallAtK(search: Search, fixture: Question[], opts: { k?: number; min_questions?: number } = {}) {
  const k = opts.k ?? 5;
  const required = opts.min_questions ?? REQUIRED;
  if (fixture.length < required) return { status: 'unmeasured' as const, questions: fixture.length, required };
  const misses: string[] = [];
  for (const q of fixture) {
    const top = (await search(q, k)).slice(0, k).map((f) => f.key);
    if (!q.expected_keys.some((key) => top.includes(key))) misses.push(q.question);
  }
  const hits = fixture.length - misses.length;
  const recall = hits / fixture.length;
  return { status: 'measured' as const, questions: fixture.length, k, hits, recall, pgvector_trigger: recall < TRIGGER, misses };
}

if (import.meta.main) {
  const [path] = process.argv.slice(2);
  const { DATABASE_URL: url, RECALL_AGENT: agent = 'grok' } = process.env;
  if (!path || !url) throw new Error('usage: DATABASE_URL=... node test/recall.ts <fixture.json>');
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  try {
    const fixture = Fixture.parse(JSON.parse(readFileSync(path, 'utf8')));
    console.log(JSON.stringify(await recallAtK(
      (q, limit) => memorySearch(pool, agent, { query: q.question, limit, ...(q.namespace ? { namespace: q.namespace } : {}) }),
      fixture), null, 2));
  } finally {
    await pool.end();
  }
}
