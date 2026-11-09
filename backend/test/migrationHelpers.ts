import type { DatabaseSync } from "node:sqlite";
// Only for temporary fixtures synthesized from today's schema, before testing
// an older upgrade path. Production migrations never drop these records.
export function dropMonitoringSchema(db: DatabaseSync) {
  if (db.prepare("PRAGMA table_info(column_selections)").all().some((row) => row.name === "monitoring_json")) db.exec("ALTER TABLE column_selections DROP COLUMN monitoring_json;");
}
export function dropNoticeSchema(db: DatabaseSync) {
  dropMonitoringSchema(db);
  if (db.prepare("PRAGMA table_info(jobs)").all().some((row) => row.name === "notice_json")) db.exec("ALTER TABLE jobs DROP COLUMN notice_json;");
}
export function dropAiReviewSchema(db: DatabaseSync) {
  dropNoticeSchema(db);
  db.exec("DROP TRIGGER IF EXISTS activity_ai_review; DROP TRIGGER IF EXISTS ai_review_update; DROP TRIGGER IF EXISTS ai_review_delete; DROP TRIGGER IF EXISTS ai_review_owner; DROP TABLE IF EXISTS ai_run_reviews;");
}
export function dropAiSchema(db: DatabaseSync) {
  dropAiReviewSchema(db);
  db.exec("DROP TRIGGER IF EXISTS activity_ai_run; DROP TRIGGER IF EXISTS ai_identity; DROP TRIGGER IF EXISTS ai_terminal; DROP TRIGGER IF EXISTS ai_event_update; DROP TRIGGER IF EXISTS ai_event_delete; DROP TABLE IF EXISTS ai_run_events; DROP TABLE IF EXISTS ai_runs; DROP TABLE IF EXISTS ai_queue_lease;");
}
export function dropActivitySchema(db: DatabaseSync) {
  dropAiSchema(db);
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
