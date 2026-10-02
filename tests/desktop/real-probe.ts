/**
 * Shared scaffolding of the real-Runtime probes (feature-t31 S-06: the J-03 receiving entry
 * and the V-10 acceptance entry): explicit absolute inputs that are never defaulted, a step
 * recorder that keeps a failed expectation with its observation, the delivery import
 * directory check, and the background isolated client with its snapshot, dialog stub,
 * clipboard and per-connection protocol transcripts.
 */
import { expect, type ElectronApplication, type Page } from "@playwright/test";
import { createHash, createPublicKey } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { closeLocal, launchLocal } from "./local-client";
import { goTo, ready } from "./shell";
import type { RuntimeHost } from "../../src/main/runtime-host";
import type { Snapshot } from "../../src/shared/protocol";
declare global {
  var runtimeHost: RuntimeHost;
}

export type Json = Record<string, unknown>;
export interface ProbeStep {
  id: string;
  expected: string;
  observed: Json;
  result: "PASS" | "FAIL";
}
export const sha256 = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");

/** Every named input must be an absolute path; a missing one fails the run with its name. */
export function requireAbsolute(entry: string, inputs: [string, string][]) {
  const missing = inputs
    .filter(([, value]) => !value || !isAbsolute(value))
    .map(([name]) => name);
  if (missing.length)
    throw new Error(
      `${entry} needs absolute paths in ${missing.join(" and ")}`,
    );
}

/** result.json in a new or empty evidence directory, written after every step. */
export function probeRecord(evidenceDir: string, schema: string) {
  if (existsSync(evidenceDir) && readdirSync(evidenceDir).length)
    throw new Error("the evidence directory must be new or empty");
  mkdirSync(join(evidenceDir, "transcripts"), { recursive: true });
  const steps: ProbeStep[] = [];
  const result: Json = {
    schema,
    startedAt: new Date().toISOString(),
    steps,
  };
  const save = () =>
    writeFileSync(
      join(evidenceDir, "result.json"),
      JSON.stringify(result, null, 1) + "\n",
    );
  /**
   * Records a step; a failed expectation is kept with its observation. The run stops there,
   * unless the step is marked to continue: then the failure stays recorded (the outcome is
   * FAIL) and the later steps still gather their evidence.
   */
  const step = async (
    id: string,
    expected: string,
    run: (observed: Json) => Promise<void> | void,
    options: { continueOnFailure?: boolean } = {},
  ) => {
    const observed: Json = {};
    try {
      await run(observed);
      steps.push({ id, expected, observed, result: "PASS" });
      return true;
    } catch (error) {
      observed.error = String((error as Error).message ?? error).slice(0, 4000);
      steps.push({ id, expected, observed, result: "FAIL" });
      if (!options.continueOnFailure) throw error;
      return false;
    } finally {
      save();
    }
  };
  const finish = () => {
    result.finishedAt = new Date().toISOString();
    result.outcome = steps.every((s) => s.result === "PASS") ? "PASS" : "FAIL";
    save();
  };
  return { result, steps, step, finish };
}

export const importFiles = [
  "bundle.tar",
  "publisher.pub",
  "release.json",
  "release.sig",
];
/** The import directory holds exactly the four delivery files; returns their digests and the SPKI digest. */
export function deliveryInputs(bundleDir: string) {
  const names = readdirSync(bundleDir).sort();
  expect(names).toEqual(importFiles);
  const files: Record<string, { bytes: number; sha256: string }> = {};
  for (const name of importFiles) {
    const bytes = readFileSync(join(bundleDir, name));
    files[name] = { bytes: bytes.length, sha256: sha256(bytes) };
  }
  const publisherKeyDigest = sha256(
    createPublicKey(readFileSync(join(bundleDir, "publisher.pub"))).export({
      type: "spki",
      format: "der",
    }) as Buffer,
  );
  return { names, files, publisherKeyDigest };
}

/** The background isolated client on one data root; relaunches re-resolve the page. */
export class ProbeClient {
  app: ElectronApplication | undefined;
  page!: Page;
  constructor(
    private readonly data: string,
    private readonly transcripts: string,
    /** Variables added to the inherited environment (the J-04 entry's Codex protocol log). */
    private readonly env: Record<string, string> = {},
  ) {}
  async launch() {
    this.app = await launchLocal({
      args: [
        resolve("."),
        `--data-root=${this.data}`,
        `--runtime-transcripts=${this.transcripts}`,
      ],
      cwd: resolve("."),
      ...(Object.keys(this.env).length
        ? { env: { ...(process.env as Record<string, string>), ...this.env } }
        : {}),
    });
    this.page = await this.app.firstWindow();
    await ready(this.page);
  }
  async close() {
    if (!this.app) return;
    const app = this.app;
    this.app = undefined;
    await closeLocal(app);
  }
  async snapshot() {
    return (await this.page.evaluate(async () => {
      const reply = await window.desktop.command({ type: "snapshot" });
      if (!reply.ok) throw new Error(reply.message);
      return reply.snapshot;
    })) as Snapshot;
  }
  async openExtensions() {
    await goTo(this.page, "设置");
    await this.page
      .getByRole("navigation", { name: "设置分类" })
      .getByRole("button", { name: "扩展管理", exact: true })
      .click();
    return this.page.getByRole("region", { name: "扩展管理" });
  }
  /** Opens a project from the list and returns its 仓库治理接入 section. */
  async openProject(name: string) {
    await goTo(this.page, "项目");
    const back = this.page.getByRole("button", { name: "返回项目列表" });
    if (await back.count()) await back.click();
    await this.page.locator(".project-open").filter({ hasText: name }).click();
    await this.page.getByRole("button", { name: "在右栏查看" }).click();
    return this.page.getByRole("region", {
      name: "仓库治理接入",
      exact: true,
    });
  }
  /** The next system directory dialog answers with this path. */
  pickDirectory(path: string) {
    return this.app!.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: [path],
      })) as typeof dialog.showOpenDialog;
    }, path);
  }
  /** Creates a project on a folder through the folder picker and the creation entry. */
  async createProject(folder: string, name: string, goal: string) {
    await this.pickDirectory(folder);
    return this.page.evaluate(
      async ({ name, goal }) => {
        const chosen = await window.desktop.pickProjectFolder();
        if (!chosen.ok) throw Error(chosen.message);
        const r = await window.desktop.createProject({
          token: chosen.token,
          name,
          goal,
        });
        if (!r.ok || !r.projectId) throw Error(JSON.stringify(r));
        return r.projectId;
      },
      { name, goal },
    );
  }
  clipboard() {
    return this.app!.evaluate(({ clipboard }) => clipboard.readText());
  }
  /** Frames of one incarnation's transcript, in order. */
  frames(incarnationId: string) {
    const file = readdirSync(this.transcripts).find((name) =>
      name.endsWith("-" + incarnationId.slice(12, 20) + ".jsonl"),
    );
    if (!file) throw new Error("no transcript for " + incarnationId);
    return readFileSync(join(this.transcripts, file), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { direction: string; value: Json });
  }
  /** Every request of a method with its answer, in order. */
  exchanges(incarnationId: string, method: string, from = "host-to-runtime") {
    const all = this.frames(incarnationId);
    return all
      .filter((f) => f.direction === from && f.value.method === method)
      .map((request) => ({
        request: request.value,
        reply:
          all.find(
            (f) =>
              f.direction !== from &&
              f.value.id === request.value.id &&
              !("method" in f.value),
          )?.value ?? null,
      }));
  }
  /** The first request of a method and its answer. */
  requestAndReply(incarnationId: string, method: string) {
    const first = this.exchanges(incarnationId, method)[0];
    if (!first) throw new Error(method + " was not sent");
    return first;
  }
}
