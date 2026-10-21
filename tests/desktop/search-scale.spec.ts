import { writeFileSync } from "node:fs";
import { cpus, loadavg } from "node:os";
import { test, expect, type ElectronApplication } from "@playwright/test";
import { resolve } from "node:path";
import { launchLocal, closeLocal } from "./local-client";
import { seedSearchScale } from "./search-scale-fixture";

/*
 * Q-03 / Q-08 non-hp search scale (mac-feature-t11 S-04): 20 projects (two on one shared repository), 1,000
 * conversations with 20,000 messages and 1,000 retained widget search records. Five independent launches; in each,
 * the first keyword search after launch is the cold sample (new read worker and SQLite connection; the operating
 * system file cache is not cleared, so this is not a system cold-cache sample), 26 further searches are warm, and
 * searches issued while the index rebuilds and after it are the rebuild samples. Every sample keeps the time from
 * the input event to the rendered results frame (including debounce and IPC), the main-process search time and
 * the remainder. All samples are written; the budget of 500 ms applies to the 95th percentile of each state.
 */
const queries = [
  "恢",
  "权限",
  "权限撤销",
  "罕见结果",
  "needle_last",
  "不存在词语",
  "literal%under_score",
  '"quoted"',
  "CAFÉ",
  "工作台",
  "规模项目",
  "规模控件 09",
  "松果 7",
];
const launches = 5;
type Sample = {
  launch: number;
  state: "cold" | "warm" | "rebuild-during" | "rebuild-after";
  query: string;
  milliseconds: number;
  ipcMilliseconds: number;
  outsideIpcMilliseconds: number;
  counts: Record<string, number>;
  /** Renderer main-thread long tasks (over 50 ms) overlapping the sample, in milliseconds of overlap. */
  longTaskMilliseconds: number;
  /** Snapshot deliveries to the window while the sample ran, and their total size in bytes. */
  snapshots: number;
  snapshotBytes: number;
};

async function measureIpc(app: ElectronApplication) {
  await app.evaluate(({ ipcMain }) => {
    const internal = ipcMain as unknown as {
      _invokeHandlers: Map<
        string,
        (event: unknown, request: { query: string }) => Promise<unknown>
      >;
    };
    const original = internal._invokeHandlers.get("business:search")!;
    const measured = globalThis as typeof globalThis & {
      searchIpcTimings?: {
        query: string;
        milliseconds: number;
        counts?: unknown;
      }[];
    };
    measured.searchIpcTimings = [];
    ipcMain.removeHandler("business:search");
    ipcMain.handle("business:search", async (event, request) => {
      const started = performance.now();
      const reply = (await original(event, request)) as { counts?: unknown };
      measured.searchIpcTimings!.push({
        query: request.query,
        milliseconds: performance.now() - started,
        counts: reply?.counts,
      });
      return reply;
    });
  });
}

test("search scale: 20 projects, 1000 conversations with 20000 messages and 1000 retained widgets answer cold, warm and rebuild searches within budget", async ({}, info) => {
  test.setTimeout(600_000);
  const seeded = seedSearchScale();
  const samples: Sample[] = [];
  const rebuilds: { launch: number; milliseconds: number; ok: boolean }[] = [];
  for (let launch = 0; launch < launches; launch++) {
    const app = await launchLocal({
      args: [resolve("."), `--data-root=${seeded.root}`],
      cwd: resolve("."),
    });
    try {
      const page = await app.firstWindow();
      await expect(
        page
          .locator("#main-sidebar")
          .getByRole("button", { name: "新建聊天", exact: true }),
      ).toBeEnabled();
      await measureIpc(app);
      // Diagnostics of where the time outside the search handler goes: renderer long tasks, and snapshot
      // deliveries to the window (main-process clock and renderer clock share the epoch via timeOrigin).
      await page.evaluate(() => {
        const w = window as unknown as { longTasks: [number, number][] };
        w.longTasks = [];
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries())
            w.longTasks.push([
              performance.timeOrigin + entry.startTime,
              entry.duration,
            ]);
        }).observe({ type: "longtask", buffered: true });
      });
      await app.evaluate(({ BrowserWindow }) => {
        const g = globalThis as unknown as {
          snapshotDeliveries: [number, number][];
        };
        g.snapshotDeliveries = [];
        for (const window of BrowserWindow.getAllWindows()) {
          const contents = window.webContents;
          const send = contents.send.bind(contents);
          contents.send = (channel: string, ...args: unknown[]) => {
            if (channel === "business:snapshot")
              g.snapshotDeliveries.push([
                performance.timeOrigin + performance.now(),
                JSON.stringify(args[0]).length,
              ]);
            send(channel, ...args);
          };
        }
      });
      await page.keyboard.press("Meta+k");
      const dialog = page.getByRole("dialog", { name: "全局搜索" }),
        input = dialog.getByRole("combobox");
      const search = async (state: Sample["state"], query: string) => {
        // Every warm and rebuild sample starts from the cleared input, so each query is a new input event.
        // The cold sample is typed right after the panel opens, while its first worker may still be starting.
        if (state !== "cold") {
          await input.fill("");
          await expect(dialog.getByRole("listbox")).toHaveAttribute(
            "aria-busy",
            "false",
          );
        }
        // The production input event starts the clock; the result must pass a rendered frame.
        await input.evaluate((el) => {
          const w = window as unknown as {
            searchMeasurement?: {
              started: number;
              epoch: number;
              elapsed?: number;
            };
          };
          el.addEventListener(
            "input",
            () => {
              w.searchMeasurement = {
                started: performance.now(),
                epoch: performance.timeOrigin + performance.now(),
              };
              const poll = () => {
                const results = document.getElementById("search-results");
                if (results?.getAttribute("aria-busy") === "false")
                  requestAnimationFrame(() => {
                    if (w.searchMeasurement)
                      w.searchMeasurement.elapsed =
                        performance.now() - w.searchMeasurement.started;
                  });
                else requestAnimationFrame(poll);
              };
              requestAnimationFrame(poll);
            },
            { once: true, capture: true },
          );
        });
        await input.fill(query);
        await expect
          .poll(() =>
            page.evaluate(
              () =>
                (
                  window as unknown as {
                    searchMeasurement?: { elapsed?: number };
                  }
                ).searchMeasurement?.elapsed,
            ),
          )
          .toBeGreaterThan(0);
        if (query === "不存在词语")
          await expect(
            dialog.getByText("没有找到匹配内容", { exact: true }),
          ).toBeVisible();
        else await expect(dialog.getByRole("option").first()).toBeVisible();
        const { milliseconds, epoch, longTaskMilliseconds } =
          await page.evaluate(() => {
            const w = window as unknown as {
              searchMeasurement: { elapsed: number; epoch: number };
              longTasks: [number, number][];
            };
            const { elapsed, epoch } = w.searchMeasurement;
            const overlap = w.longTasks
              .map(
                ([start, duration]) =>
                  Math.min(start + duration, epoch + elapsed) -
                  Math.max(start, epoch),
              )
              .filter((value) => value > 0)
              .reduce((a, b) => a + b, 0);
            return {
              milliseconds: elapsed,
              epoch,
              longTaskMilliseconds: overlap,
            };
          });
        const deliveries = await app.evaluate(
          (_, [from, to]) =>
            (
              globalThis as unknown as {
                snapshotDeliveries: [number, number][];
              }
            ).snapshotDeliveries.filter(([at]) => at >= from && at <= to),
          [epoch - 1000, epoch + milliseconds] as [number, number],
        );
        const ipc = await app.evaluate(() => {
          const measured = globalThis as typeof globalThis & {
            searchIpcTimings?: {
              query: string;
              milliseconds: number;
              counts?: Record<string, number>;
            }[];
          };
          return measured.searchIpcTimings?.at(-1);
        });
        expect(ipc?.query).toBe(query);
        samples.push({
          launch,
          state,
          query,
          milliseconds,
          ipcMilliseconds: ipc!.milliseconds,
          outsideIpcMilliseconds: milliseconds - ipc!.milliseconds,
          counts: ipc!.counts ?? {},
          longTaskMilliseconds,
          snapshots: deliveries.length,
          snapshotBytes: deliveries.reduce((sum, [, bytes]) => sum + bytes, 0),
        });
      };
      await search("cold", queries[launch % queries.length]);
      for (let i = 1; i <= 26; i++)
        await search("warm", queries[(launch + i) % queries.length]);
      // Rebuild while searching: readers keep the previous committed index until the rebuild commits.
      const started = Date.now();
      const rebuild = page.evaluate(() =>
        window.desktop.command({ type: "rebuildSearchIndex" }),
      );
      let done = false;
      void rebuild.then(() => (done = true));
      for (let i = 0; !done && i < 13; i++)
        await search("rebuild-during", queries[(launch + i) % queries.length]);
      const reply = await rebuild;
      rebuilds.push({
        launch,
        milliseconds: Date.now() - started,
        ok: reply.ok,
      });
      expect(reply.ok).toBe(true);
      for (let i = 0; i < 13; i++)
        await search("rebuild-after", queries[(launch + i) % queries.length]);
      if (launch === 0)
        await page.screenshot({ path: info.outputPath("search-scale.png") });
    } finally {
      await closeLocal(app);
    }
  }
  const percentile = (state: Sample["state"]) => {
    const values = samples
      .filter((s) => s.state === state)
      .map((s) => s.milliseconds)
      .sort((a, b) => a - b);
    return values.length ? values[Math.ceil(values.length * 0.95) - 1] : null;
  };
  // Every count of one query is the same across launches and states: the rebuild changes no result.
  for (const query of queries) {
    const counts = samples
      .filter((s) => s.query === query)
      .map((s) => JSON.stringify(s.counts));
    expect(new Set(counts).size, query).toBe(1);
  }
  const result = {
    schema_version: 1,
    scale: {
      projects: 20,
      shared_repository_projects: 2,
      conversations: 1000,
      messages: 20000,
      retained_widget_records: 1000,
      mounted_widgets: 0,
    },
    distribution: seeded.sizes,
    source_sha256: seeded.sha256,
    clock:
      "input event to results rendered frame, includes debounce and IPC; ipcMilliseconds is the main-process search handler",
    cold: "first keyword search after an independent launch: new read worker and SQLite connection; the operating system file cache is not cleared",
    launches,
    environment: { cpus: cpus().length, loadavg_after: loadavg() },
    rebuilds,
    samples,
    p95: {
      cold: percentile("cold"),
      warm: percentile("warm"),
      rebuild_during: percentile("rebuild-during"),
      rebuild_after: percentile("rebuild-after"),
    },
    budget_ms: 500,
  };
  writeFileSync(
    info.outputPath("search-scale.json"),
    JSON.stringify(result, null, 2),
  );
  for (const value of Object.values(result.p95))
    if (value !== null) expect(value).toBeLessThanOrEqual(500);
});
