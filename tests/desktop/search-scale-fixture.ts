import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { resolve } from "node:path";
import { Store } from "../../src/service/store";
import { seedRetainedWidgets } from "./widget-generation-fixture";

/**
 * Q-08 non-hp search scale (architecture "Q-08 的测量方案"): 20 projects, two of them on one synthetic shared
 * repository; 1,000 conversations with 20,000 messages in the fixed length distribution of mac-feature-t42 (15 of
 * 256, 4 of 2,048 and 1 of 8,192 characters per conversation); 1,000 retained widget search records, cloned from
 * one widget retained through the real command so every row is a complete retained widget. Deterministic content;
 * `sha256` covers every seeded text.
 */
export function seedSearchScale() {
  mkdirSync(".test-data/disposable", { recursive: true });
  const root = mkdtempSync(resolve(".test-data/disposable/search-scale-"));
  const [template] = seedRetainedWidgets(root, ["规模控件 0000"]);
  const store = new Store(root);
  const hash = createHash("sha256");
  const sizes: Record<string, number> = {};
  try {
    store.db.exec("BEGIN IMMEDIATE");
    const insertConversation = store.db.prepare(
      "INSERT INTO conversations(id,title,updated_at) VALUES(?,?,?)",
    );
    const insertMessage = store.db.prepare(
      "INSERT INTO messages(id,conversation_id,role,content,created_at) VALUES(?,?,'user',?,?)",
    );
    for (let c = 0; c < 1000; c++) {
      const cid = `scale-${c.toString().padStart(4, "0")}`;
      insertConversation.run(cid, `合成对话 ${c}`, "2026-09-07T03:00:00Z");
      for (let n = 0; n < 20; n++) {
        const i = c * 20 + n,
          size = n < 15 ? 256 : n < 19 ? 2048 : 8192;
        sizes[size] = (sizes[size] ?? 0) + 1;
        const seed = `对话${c} 消息${i} 离线文本 SQLite 工作台 恢复配置。`;
        let body = seed.repeat(Math.ceil(size / seed.length)).slice(0, size);
        if (i === 19999)
          body +=
            '权限撤销 罕见结果 needle_last literal%under_score "quoted" CAFÉ';
        hash.update(`${i}\0${body}\n`);
        insertMessage.run(`message-${i}`, cid, body, "2026-09-07T03:00:00Z");
      }
    }
    // Archive one conversation and delete another, so the queries cover both rules.
    store.db
      .prepare("UPDATE conversations SET archived_at=? WHERE id='scale-0001'")
      .run("2026-09-08T00:00:00Z");
    store.db
      .prepare(
        "UPDATE conversations SET deleted_at=?,retain_until=? WHERE id='scale-0002'",
      )
      .run("2026-09-08T00:00:00Z", "2026-10-08T00:00:00Z");
    const insertProject = store.db.prepare(
      "INSERT INTO projects(id,name,goal,folder_json,created_at,updated_at,archived_at) VALUES(?,?,?,?,?,?,?)",
    );
    for (let p = 0; p < 20; p++) {
      const shared = p < 2;
      const folder = {
        path: `/fixture/project-${p}`,
        canonicalPath: `/fixture/project-${p}`,
        identity: `fixture-project-${p}`,
        git: shared
          ? {
              root: "/fixture/shared-repository",
              commonDirectory: "/fixture/shared-repository/.git",
              identity: "fixture-shared-repository",
              remotes: [],
            }
          : null,
      };
      const name = `规模项目 ${p}`,
        goal = `恢复配置与工作台整理 ${p}`;
      hash.update(`project\0${name}\0${goal}\n`);
      insertProject.run(
        `project-${p.toString().padStart(2, "0")}`,
        name,
        goal,
        JSON.stringify(folder),
        "2026-09-07T03:00:00Z",
        `2026-09-07T03:${p.toString().padStart(2, "0")}:00Z`,
        p === 19 ? "2026-09-08T00:00:00Z" : null,
      );
    }
    // Clone the retained template: a draft, task, candidate, preview and retained row per widget.
    const row = (sql: string, ...args: string[]) =>
      store.db.prepare(sql).get(...args) as Record<string, unknown>;
    const saved = row("SELECT * FROM saved_widgets WHERE id=?", template.id);
    const candidate = row(
      "SELECT * FROM generated_candidates WHERE id=?",
      String(saved.candidate_id),
    );
    const task = row(
      "SELECT * FROM widget_generation_tasks WHERE id=?",
      String(candidate.task_id),
    );
    const draft = row(
      "SELECT * FROM widget_drafts WHERE id=?",
      String(candidate.draft_id),
    );
    const preview = row(
      "SELECT * FROM widget_previews WHERE candidate_id=?",
      String(saved.candidate_id),
    );
    const insert = (table: string, values: Record<string, unknown>) => {
      const keys = Object.keys(values);
      store.db
        .prepare(
          `INSERT INTO ${table}(${keys.join(",")}) VALUES(${keys.map(() => "?").join(",")})`,
        )
        .run(...(keys.map((k) => values[k]) as (string | number | null)[]));
    };
    for (let w = 1; w < 1000; w++) {
      const ids = {
        widget: randomUUID(),
        candidate: randomUUID(),
        task: randomUUID(),
        draft: randomUUID(),
      };
      const name = `规模控件 ${w.toString().padStart(4, "0")}`;
      const data = JSON.stringify({
        notes: [`第 ${w} 条笔记 恢复配置 工作台`, `松果 ${w % 50}`],
      });
      hash.update(`widget\0${name}\0${data}\n`);
      insert("widget_drafts", {
        ...draft,
        id: ids.draft,
        widget_id: ids.widget,
        target_ids: JSON.stringify([ids.widget]),
      });
      insert("widget_generation_tasks", {
        ...task,
        id: ids.task,
        draft_id: ids.draft,
        request_id: randomUUID(),
        execution_id: randomUUID(),
        candidate_id: ids.candidate,
      });
      insert("generated_candidates", {
        ...candidate,
        id: ids.candidate,
        task_id: ids.task,
        draft_id: ids.draft,
        widget_id: ids.widget,
        name,
      });
      insert("widget_previews", {
        ...preview,
        candidate_id: ids.candidate,
        widget_id: ids.widget,
        data,
      });
      insert("saved_widgets", {
        ...saved,
        id: ids.widget,
        name,
        candidate_id: ids.candidate,
        position: w + 1,
      });
    }
    store.db.exec("COMMIT; PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    store.close();
  }
  return { root, sizes, sha256: hash.digest("hex") };
}
