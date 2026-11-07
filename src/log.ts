// A pg error carries `detail`, `where` and `internalQuery`, which can quote stored values. Only code and message get out.
export function logError(where: string, e: unknown) {
  const { code, message } = e as { code?: unknown; message?: unknown };
  console.error(JSON.stringify({ where, code, message: String(message ?? e).slice(0, 500) }));
}
