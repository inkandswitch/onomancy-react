import { expect, test, type Page } from "@playwright/test";
import {
  addMember,
  contactCard,
  copyableValue,
  createDocument,
  openApp,
  openSecondIdentity,
  section,
} from "./helpers";

// Names propagate through a real sync server, so give the round trips room.
test.setTimeout(180_000);

async function saveName(page: Page, name: string): Promise<void> {
  const account = section(page, "Account");
  await account.getByRole("textbox", { name: "Name", exact: true }).fill(name);
  await account.getByRole("button", { name: "Save" }).click();
}

/** The contact search inside the Document access editor. */
function contactSearch(page: Page) {
  return section(page, "Document access").getByRole("searchbox");
}

function contactResult(page: Page, name: string) {
  return section(page, "Document access").getByRole("button", {
    name: new RegExp(name),
  });
}

test.describe("names shared through a directory document", () => {
  // Keyhive delegations sync between profiles (the grant shows up on both
  // sides), but Automerge document CONTENTS do not currently arrive at a
  // second profile — the pre-existing Document section has the same gap
  // ("Loading the document…" forever, access Read). Un-skip when
  // cross-profile document sync works in the underlying stack.
  test.fixme("two identities see each other's names after sharing one directory", async ({
    page,
    browser,
  }) => {
    await openApp(page);

    // The directory document is created on first run; names written before
    // it exists would land only in localStorage.
    const directoryId = copyableValue(page, "Directory id");
    await expect(directoryId).not.toBeEmpty({ timeout: 60_000 });
    await saveName(page, "Alice");

    const other = await openSecondIdentity(browser);
    const theirCard = await contactCard(other.page).innerText();

    // Writing into the directory is delegation like any other document.
    await addMember(page, "Name directory", theirCard, "EDIT");

    const url = (await directoryId.innerText()).trim();
    const otherDirectory = section(other.page, "Name directory");
    await otherDirectory
      .getByRole("textbox", { name: "Load directory id" })
      .fill(url);
    await otherDirectory.getByRole("button", { name: "Load" }).click();

    // Alice's name arriving is the signal that the directory has synced.
    await createDocument(other.page);
    await contactSearch(other.page).fill("Alice");
    await expect(contactResult(other.page, "Alice")).toBeVisible({
      timeout: 60_000,
    });

    // The other identity's name travels back.
    await saveName(other.page, "Bob");
    await createDocument(page);
    await contactSearch(page).fill("Bob");
    await expect(contactResult(page, "Bob")).toBeVisible({
      timeout: 60_000,
    });

    await other.context.close();
  });
});
