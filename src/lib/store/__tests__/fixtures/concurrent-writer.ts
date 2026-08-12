// Fixture used only by the concurrent-writer test. Runs as its own `node`
// process (spawned via tsx) so it holds a genuinely separate OS-level
// connection to the shared db file — the thing the WAL + busy_timeout setup
// in ../../db.ts is actually for (a Next.js dev server process and a
// cron/CLI process both writing to the same file at once).
import type { Gig } from "../../../types.js";
import { getDb, recordScan } from "../../index.js";

const [, , dbPath, sourceId, countArg] = process.argv;
if (!dbPath || !sourceId || !countArg) {
  console.error("usage: concurrent-writer.ts <dbPath> <sourceId> <count>");
  process.exit(2);
}
const count = Number(countArg);

const db = getDb({ path: dbPath });

const gigs: Gig[] = Array.from({ length: count }, (_, i) => ({
  sourceId,
  externalId: `${sourceId}-${i}`,
  title: `${sourceId} gig ${i}`,
  url: `https://example.test/${sourceId}/${i}`,
}));

// One recordScan per gig (not one big batch) so this process makes `count`
// separate write transactions against the file — more writer/writer contention
// to actually exercise busy_timeout than a single fat transaction would.
for (const gig of gigs) {
  recordScan([{ sourceId, gigs: [gig] }], { db });
}

process.stdout.write("ok\n");
process.exit(0);
