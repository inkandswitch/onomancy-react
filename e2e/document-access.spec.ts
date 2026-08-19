import { expect, test } from "@playwright/test";
import { createDocument, memberRows, openApp, section } from "./helpers";

test.describe("AccessEditor on a document", () => {
  test("shows the creator as an admin", async ({ page }) => {
    await openApp(page);
    await createDocument(page);

    const editor = section(page, "Document access");
    await expect(editor.getByText("Current Access")).toBeVisible();
    const rows = memberRows(page, "Document access");
    await expect(rows.filter({ hasText: "Admin" })).toHaveCount(1);
    // The sync server is granted relay on creation, and holds nothing more.
    await expect(rows.filter({ hasText: "Relay" })).toHaveCount(1);
  });

  test("offers every level an admin can delegate", async ({ page }) => {
    await openApp(page);
    await createDocument(page);

    const levels = await section(page, "Document access")
      .getByLabel("Access level")
      .locator("option")
      .allInnerTexts();

    expect(levels).toEqual(["RELAY", "READ", "EDIT", "ADMIN"]);
  });

  test("makes a document public and private again", async ({ page }) => {
    await openApp(page);
    await createDocument(page);

    const editor = section(page, "Document access");
    await expect(editor.getByText("This document is private")).toBeVisible();

    await editor.getByRole("button", { name: "Make Public" }).click();
    await expect(editor.getByText(/This document is public/)).toBeVisible();
    await expect(
      memberRows(page, "Document access").filter({ hasText: "Public" })
    ).toHaveCount(1);

    await editor.getByRole("button", { name: "Make Private" }).click();
    await expect(editor.getByText("This document is private")).toBeVisible();
    await expect(
      memberRows(page, "Document access").filter({ hasText: "Public" })
    ).toHaveCount(0);
  });

  test("lists nothing in the contact book until something is typed", async ({
    page,
  }) => {
    await openApp(page);
    await createDocument(page);

    const editor = section(page, "Document access");
    const search = editor.getByPlaceholder("Search contacts by name");
    await expect(search).toBeVisible();
    await expect(editor.getByText(/Type a name to find/)).toBeVisible();
    await search.fill("nobody-by-this-name");
    await expect(editor.getByText("No matches.")).toBeVisible();
  });
});
