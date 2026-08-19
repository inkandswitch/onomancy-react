import { expect, test } from "@playwright/test";
import {
  addMember,
  contactCard,
  createDocument,
  createGroup,
  memberRows,
  openApp,
  openSecondIdentity,
  section,
} from "./helpers";

// A second browser context is a second IndexedDB and a second keyhive
// identity. Granting and revoking are local operations.
test.describe("granting access to another identity", () => {
  test("adds a reader to a document and takes them off again", async ({
    page,
    browser,
  }) => {
    await openApp(page);
    await createDocument(page);

    const other = await openSecondIdentity(browser);
    const theirCard = await contactCard(other.page).innerText();

    const before = await memberRows(page, "Document access").count();
    await addMember(page, "Document access", theirCard, "READ");

    const rows = memberRows(page, "Document access");
    await expect(rows).toHaveCount(before + 1);
    await expect(rows.filter({ hasText: "READ" })).toHaveCount(1);

    // Only an admin sees a remove control.
    await rows.filter({ hasText: "READ" }).getByRole("button").last().click();
    await expect(rows).toHaveCount(before);

    await other.context.close();
  });

  test("refuses a contact card that is not one", async ({ page }) => {
    await openApp(page);
    await createDocument(page);

    await addMember(page, "Document access", "{}", "READ");
    await expect(
      section(page, "Document access").getByRole("alert")
    ).toContainText(/Could not share|not a valid contact card/i);
  });
});

test.describe("granting access through a group", () => {
  test("a group member reaches a document the group was given", async ({
    page,
    browser,
  }) => {
    await openApp(page);
    await createDocument(page);
    await createGroup(page);

    const other = await openSecondIdentity(browser);
    const theirCard = await contactCard(other.page).innerText();

    // Into the group, then the group into the document.
    await addMember(page, "Group access", theirCard, "READ");
    await expect(
      memberRows(page, "Group access").filter({ hasText: "READ" })
    ).toHaveCount(1);

    await page
      .getByRole("button", {
        name: "Delegate this group edit access to the document",
      })
      .click();

    // The document's own delegations gain the group, not its members. That is
    // the distinction AccessEditor exists to show.
    await expect(
      memberRows(page, "Document access").filter({ hasText: "(group)" })
    ).toHaveCount(1);

    await other.context.close();
  });
});
