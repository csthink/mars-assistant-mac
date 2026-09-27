import {
  addProvider,
  ensureProviderModel,
  fetchProviderModels,
  openProvider,
} from "./provider-ui";
import { test, expect } from "@playwright/test";
import { resolve } from "node:path";
import { presets, type Provider, providers } from "../../src/shared/protocol";
import { launchReal, shutdownReal, type RealClient } from "./real-client";

/**
 * Adds one real provider connection to an existing data root. The API key is
 * read from the environment variable named by CSTHINK_REAL_ADD_KEY_ENV and typed
 * straight into the client's password field; it is never logged, asserted on or
 * written anywhere by this script. Model list, model choice and connection test
 * follow, so the connection is ready for the matrix driver.
 */
const root = process.env.CSTHINK_REAL_DATA_ROOT;
const authorized = process.env.CSTHINK_REAL_CALLS_AUTHORIZED === "1";
const evidenceDir = process.env.CSTHINK_REAL_EVIDENCE_DIR;
const provider = process.env.CSTHINK_REAL_ADD_PROVIDER as Provider | undefined;
const keyEnv = process.env.CSTHINK_REAL_ADD_KEY_ENV;
const baseUrl = process.env.CSTHINK_REAL_ADD_BASE_URL;
const name =
  process.env.CSTHINK_REAL_ADD_NAME ??
  (provider ? presets[provider].label : "");
test.skip(
  !root ||
    !authorized ||
    !evidenceDir ||
    !provider ||
    !providers.includes(provider) ||
    !keyEnv ||
    !process.env[keyEnv],
  "Needs CSTHINK_REAL_DATA_ROOT, CSTHINK_REAL_CALLS_AUTHORIZED=1, CSTHINK_REAL_EVIDENCE_DIR, CSTHINK_REAL_ADD_PROVIDER and a key in the variable named by CSTHINK_REAL_ADD_KEY_ENV",
);
test.setTimeout(300_000);
// Password entry must never be captured in Playwright traces.
test.use({ trace: "off" });

let client: RealClient;
test.beforeAll(async () => {
  client = await launchReal(root!);
});
test.afterAll(async () => {
  await shutdownReal(client, false);
});

test("real provider setup: save the connection with a user-provided key, fetch models, pick one and test", async () => {
  const page = client.page;
  const configured = await page.evaluate(async (name) => {
    const r = await window.desktop.command({ type: "snapshot" });
    if (!r.ok) throw new Error(r.message);
    return r.snapshot.connections.some((c) => c.name === name);
  }, name);
  if (!configured)
    await addProvider(page, {
      name,
      provider: provider!,
      url: baseUrl ?? presets[provider!].baseUrl,
      secret: process.env[keyEnv!]!,
    });
  const result = await fetchProviderModels(page, name);
  const models = result.state === "fetched" ? result.models : [];
  expect(models.length).toBeGreaterThan(0);
  const preferred =
    process.env.CSTHINK_REAL_ADD_MODEL ??
    models.find((m) => /flash/i.test(m)) ??
    models.find((m) => /^glm/i.test(m)) ??
    models[0];
  console.log(`chosen model for ${name}: ${preferred} (of ${models.length})`);
  await ensureProviderModel(page, name, preferred);
  const existing = (await openProvider(page, name)).getByRole("group", {
    name: `模型 ${preferred}`,
    exact: true,
  });
  await existing.getByRole("button", { name: "测试模型" }).click();
  await expect(existing.getByText(/文本调用：(成功|失败)/)).toBeVisible({
    timeout: 90_000,
  });
  await page.screenshot({
    path: resolve(evidenceDir!, `setup-${name}.png`),
  });
  await expect(existing.getByText(/文本调用：成功/)).toBeVisible();
});
