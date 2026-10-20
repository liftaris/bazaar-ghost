/** Per-request D1 accounting for the Server-Timing header: round trips, wall time and D1's own SQL time. */
export class Timing {
  queries = 0;
  wall = 0;
  sql = 0;
  private readonly started = performance.now();

  /** An Env whose read-path D1 statements (prepare/bind/first/all/run/raw) are counted; the original binding is untouched. */
  wrap(env: Env): Env {
    const track = async <T>(run: () => Promise<T>): Promise<T> => {
      const begin = performance.now();
      this.queries++;
      try {
        const result = await run();
        const meta = (result as { meta?: { duration?: number } } | null)?.meta;
        if (typeof meta?.duration === "number") this.sql += meta.duration;
        return result;
      } finally {
        this.wall += performance.now() - begin;
      }
    };
    const bound = (inner: D1PreparedStatement): D1PreparedStatement =>
      ({
        bind: (...values: unknown[]) => bound(inner.bind(...values)),
        first: (column?: string) => track(() => (column === undefined ? inner.first() : inner.first(column))),
        all: () => track(() => inner.all()),
        run: () => track(() => inner.run()),
        raw: (options?: { columnNames?: boolean }) => track(() => inner.raw(options as { columnNames: true })),
      }) as unknown as D1PreparedStatement;
    const db = {
      prepare: (sql: string) => bound(env.DB.prepare(sql)),
    } as unknown as D1Database;
    return { ...env, DB: db };
  }

  header(): string {
    const total = performance.now() - this.started;
    const ms = (value: number) => value.toFixed(1);
    return `d1;dur=${ms(this.wall)};desc="${this.queries} queries",sql;dur=${ms(this.sql)},total;dur=${ms(total)}`;
  }
}
