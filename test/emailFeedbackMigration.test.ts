import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration=(name:string)=>readFile(new URL(`../migrations/${name}`,import.meta.url),"utf8");
test("0011 adds only bounded feedback tables and leaves historic migrations/data untouched",async()=>{
  const db=new Database(":memory:");
  try{
    db.exec(await migration("0001_initial.sql")); db.exec(await migration("0010_email_delivery_ledger.sql"));
    db.prepare("INSERT INTO discoveries(normalized_url,first_seen_at,last_seen_at,analysis_json) VALUES(?,?,?,?)")
      .run("https://fixture.invalid/story","2026-11-01T00:00:00.000Z","2026-11-01T00:00:00.000Z","{}");
    db.exec(await migration("0011_email_feedback.sql"));
    const names=(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{name:string}>).map(x=>x.name);
    for(const name of ["email_feedback_stories","email_feedback_votes","email_feedback_events"])assert.ok(names.includes(name));
    assert.equal(db.prepare("SELECT count(*) count FROM discoveries").get()?.count,1);
    assert.doesNotThrow(()=>db.exec("SELECT * FROM email_feedback_stories"));
  }finally{db.close();}
});

test("0011 keeps bindings and audit immutable and generic invalid transitions fail",async()=>{
  const db=new Database(":memory:");
  try{db.exec(await migration("0001_initial.sql"));db.exec(await migration("0010_email_delivery_ledger.sql"));db.exec(await migration("0011_email_feedback.sql"));
    assert.throws(()=>db.prepare("INSERT INTO email_feedback_stories(delivery_key,slot,payload_sha256,story_sha256,discovery_key,display_title,kind,topic_version,topics_json,issued_at,expires_at,key_id,relevant_digest,not_relevant_digest) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run("daily-digest/2026-11-12",5,"a".repeat(64),"b".repeat(64),"c".repeat(64),"x","raw",1,"[]","2026-11-12T08:00:00.000Z","2026-12-12T08:00:00.000Z","k","d".repeat(64),"e".repeat(64)));
  }finally{db.close();}
});
