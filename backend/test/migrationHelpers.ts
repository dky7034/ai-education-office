import type { DatabaseSync } from "node:sqlite";
// Only for temporary fixtures synthesized from today's schema, before testing
// an older upgrade path. Production migrations never drop these records.
export function dropActivitySchema(db: DatabaseSync) {
  const triggers = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='trigger' AND name GLOB 'activity_*'",
    )
    .all() as { name: string }[];
  for (const { name } of triggers) {
    if (!/^activity_[a-z_]+$/.test(name))
      throw new Error("Unexpected fixture trigger");
    db.exec(`DROP TRIGGER "${name}"`);
  }
  db.exec("DROP TABLE activity_events; DROP TABLE activity_streams;");
}
