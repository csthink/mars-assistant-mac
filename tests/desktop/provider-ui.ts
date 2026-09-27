import { goTo } from "./shell";
import { expect, type Page } from "@playwright/test";
import { presets, type Provider } from "../../src/shared/protocol";
export async function providersPage(page: Page) {
  await goTo(page, "设置");
  await page
    .getByRole("navigation", { name: "设置分类" })
    .getByRole("button", { name: "模型", exact: true })
    .click();
  const back = page.getByRole("button", { name: "‹ 全部提供方", exact: true });
  if (await back.count()) await back.click();
}
export async function openProvider(page: Page, name: string) {
  await providersPage(page);
  await page
    .getByRole("button", { name: `打开提供方 ${name}`, exact: true })
    .click();
  return page.getByRole("article", { name: `提供方 ${name}`, exact: true });
}
export async function addProvider(
  page: Page,
  {
    name,
    url,
    provider = "custom",
    model = "",
    secret = "",
    makeDefault = false,
  }: {
    name: string;
    url: string;
    provider?: Provider;
    model?: string;
    secret?: string;
    makeDefault?: boolean;
  },
) {
  await providersPage(page);
  if (provider === "custom")
    await page
      .getByRole("button", { name: "添加自定义提供方", exact: true })
      .click();
  else
    await page
      .locator(".provider-row")
      .filter({ hasText: presets[provider].label })
      .click();
  const form = page.getByRole("form", { name: "新建提供方" });
  await form.getByLabel("名称", { exact: true }).fill(name);
  await form.getByLabel("Endpoint", { exact: true }).fill(url);
  await form.getByRole("button", { name: "保存提供方", exact: true }).click();
  const item = page.getByRole("article", {
    name: `提供方 ${name}`,
    exact: true,
  });
  await expect(item).toBeVisible();
  await expect(item.getByText(url, { exact: true })).toBeVisible();
  if (secret) {
    await item.getByLabel("API key", { exact: true }).fill(secret);
    // Compare without putting credential values in assertion failure messages.
    expect(
      (await item.getByLabel("API key", { exact: true }).inputValue()) ===
        secret,
      "密钥输入应逐字保留，尚未点击保存",
    ).toBe(true);
    await item.getByRole("button", { name: "保存密钥", exact: true }).click();
    await expect(item.getByLabel("API key", { exact: true })).toHaveValue("");
  }
  if (model) {
    await item.getByLabel("模型 ID", { exact: true }).fill(model);
    await item.getByRole("button", { name: "添加模型", exact: true }).click();
    await expect(
      item.getByRole("group", { name: `模型 ${model}`, exact: true }),
    ).toBeVisible();
  }
  if (makeDefault) {
    await item
      .getByRole("group", { name: `模型 ${model}`, exact: true })
      .getByRole("button", { name: "设为默认", exact: true })
      .click();
    await expect(item.getByText("默认", { exact: true })).toBeVisible();
  }
  return item;
}

export async function fetchProviderModels(page: Page, name: string) {
  const item = await openProvider(page, name);
  const latest = () =>
    page.evaluate(async (name) => {
      const r = await window.desktop.command({ type: "snapshot" });
      if (!r.ok) throw new Error(r.message);
      return r.snapshot.connections.find((c) => c.name === name)!.lastModelList;
    }, name);
  const before = (await latest())?.executionId;
  await item
    .getByRole("button", { name: "从厂商列表添加", exact: true })
    .click();
  const picker = item.getByRole("group", { name: "厂商模型列表", exact: true });
  await expect
    .poll(
      async () => {
        const next = await latest();
        return (
          next &&
          next.executionId !== before &&
          ["completed", "failed", "stopped", "interrupted"].includes(next.state)
        );
      },
      { timeout: 120_000 },
    )
    .toBe(true);
  const result = await page.evaluate(async (name) => {
    const r = await window.desktop.command({ type: "snapshot" });
    if (!r.ok) throw new Error(r.message);
    return r.snapshot.connections.find((c) => c.name === name)!.modelList;
  }, name);
  await picker.getByRole("button", { name: "关闭列表", exact: true }).click();
  return result;
}
export async function ensureProviderModel(
  page: Page,
  name: string,
  model: string,
) {
  const item = await openProvider(page, name);
  const row = item.getByRole("group", { name: `模型 ${model}`, exact: true });
  if (!(await row.count())) {
    await item.getByLabel("模型 ID", { exact: true }).fill(model);
    await item.getByRole("button", { name: "添加模型", exact: true }).click();
    await expect(row).toBeVisible();
  }
  return row;
}
