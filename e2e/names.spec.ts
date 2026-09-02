import { expect, test, type Page } from "@playwright/test";
import { copyableValue, createDocument, openApp, section } from "./helpers";

function names(page: Page) {
  return section(page, "Names");
}

async function resolve(page: Page, name: string): Promise<void> {
  await names(page)
    .getByRole("textbox", { name: "Name to resolve" })
    .fill(name);
  await names(page).getByRole("button", { name: "Resolve" }).click();
}

/**
 * Document writes persist on a storage debounce, so a reload immediately
 * after a change can lose it — a race no interactive user hits. Give the
 * flush room before reloading.
 */
async function settleThenReload(page: Page): Promise<void> {
  await page.waitForTimeout(2_000);
  await page.reload();
  await openApp(page);
  await expect(copyableValue(page, "Directory id")).not.toBeEmpty({
    timeout: 60_000,
  });
}

test.describe("binding and resolving names", () => {
  test("a bound path resolves and opens the document, across reloads", async ({
    page,
  }) => {
    await openApp(page);
    await expect(copyableValue(page, "Directory id")).not.toBeEmpty({
      timeout: 60_000,
    });

    await createDocument(page);
    const docUrl = (
      await copyableValue(page, "Document id").innerText()
    ).trim();

    await names(page)
      .getByRole("textbox", { name: "Name path" })
      .fill("pics/vacation");
    await names(page)
      .getByRole("textbox", { name: "Named document id" })
      .fill(docUrl);
    await names(page).getByRole("button", { name: "Bind" }).click();
    await expect(names(page).getByText("Bound ~/pics/vacation.")).toBeVisible();

    // Names are live document data: they survive a reload with no session
    // state, which is the point of writing them into the directory.
    await settleThenReload(page);

    await resolve(page, "~/pics/vacation");
    await expect(names(page).getByText(`Resolved to ${docUrl}`)).toBeVisible();

    await names(page).getByRole("button", { name: "Open" }).click();
    await expect(copyableValue(page, "Document id")).toHaveText(docUrl);

    // The bare spelling resolves identically: the root is implied.
    await resolve(page, "pics/vacation");
    await expect(names(page).getByText(`Resolved to ${docUrl}`)).toBeVisible();
  });

  test("an unbound path is a partial walk, not an error", async ({ page }) => {
    await openApp(page);
    await expect(copyableValue(page, "Directory id")).not.toBeEmpty({
      timeout: 60_000,
    });

    await resolve(page, "~/nowhere");
    await expect(
      names(page).getByText(/consumed 0 of 1 segment.*no edge matched/)
    ).toBeVisible();
  });

  test("a doc anchor addresses the same namestore as ~", async ({ page }) => {
    await openApp(page);
    const directoryId = copyableValue(page, "Directory id");
    await expect(directoryId).not.toBeEmpty({ timeout: 60_000 });
    const directoryUrl = (await directoryId.innerText()).trim();

    await createDocument(page);
    const docUrl = (
      await copyableValue(page, "Document id").innerText()
    ).trim();

    // Bind through the doc-anchor spelling of our own directory…
    await names(page)
      .getByRole("textbox", { name: "Name path" })
      .fill(`${directoryUrl}/direct`);
    await names(page)
      .getByRole("textbox", { name: "Named document id" })
      .fill(docUrl);
    await names(page).getByRole("button", { name: "Bind" }).click();
    await expect(
      names(page).getByText(`Bound ${directoryUrl}/direct.`)
    ).toBeVisible();

    // …and read it back through both spellings: same edge, same walk.
    await resolve(page, "~/direct");
    await expect(names(page).getByText(`Resolved to ${docUrl}`)).toBeVisible();

    await resolve(page, `${directoryUrl}/direct`);
    await expect(names(page).getByText(`Resolved to ${docUrl}`)).toBeVisible();
  });

  test("greedy matching prefers the longest key", async ({ page }) => {
    await openApp(page);
    await expect(copyableValue(page, "Directory id")).not.toBeEmpty({
      timeout: 60_000,
    });

    // Two edges, one a prefix of the other, bound to different documents.
    await createDocument(page);
    const shortDoc = (
      await copyableValue(page, "Document id").innerText()
    ).trim();
    await names(page).getByRole("textbox", { name: "Name path" }).fill("pics");
    await names(page)
      .getByRole("textbox", { name: "Named document id" })
      .fill(shortDoc);
    await names(page).getByRole("button", { name: "Bind" }).click();
    await expect(names(page).getByText("Bound ~/pics.")).toBeVisible();

    // A second document under the longer key.
    await settleThenReload(page);
    await createDocument(page);
    const longDoc = (
      await copyableValue(page, "Document id").innerText()
    ).trim();
    await names(page)
      .getByRole("textbox", { name: "Name path" })
      .fill("pics/vacation");
    await names(page)
      .getByRole("textbox", { name: "Named document id" })
      .fill(longDoc);
    await names(page).getByRole("button", { name: "Bind" }).click();
    await expect(names(page).getByText("Bound ~/pics/vacation.")).toBeVisible();

    await resolve(page, "~/pics/vacation");
    await expect(names(page).getByText(`Resolved to ${longDoc}`)).toBeVisible();

    await resolve(page, "~/pics");
    await expect(
      names(page).getByText(`Resolved to ${shortDoc}`)
    ).toBeVisible();
  });
});
