import { expect, type Page, type Browser } from "@playwright/test";

/**
 * Open the app and wait for keyhive's WASM to finish initialising.
 */
export async function openApp(page: Page): Promise<void> {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "keyhive-react test app" })
  ).toBeVisible();
  await expect(contactCard(page)).not.toBeEmpty({ timeout: 60_000 });
}

/** A fresh browser context, which is a fresh keyhive identity. */
export async function openSecondIdentity(browser: Browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await openApp(page);
  return { context, page };
}

/**
 * The value shown by a `CopyableField`.
 */
export function copyableValue(page: Page, label: string) {
  return page.locator(`label:text-is("${label}") + div`);
}

export function contactCard(page: Page) {
  return copyableValue(page, "Contact Card");
}

/** Whichever access editor sits under the given section heading. */
export function section(page: Page, heading: string) {
  return page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: heading, exact: true }) });
}

export async function createDocument(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Create a document" }).click();
  await expect(copyableValue(page, "Document id")).not.toBeEmpty();
}

export async function createGroup(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Create a group" }).click();
  await expect(
    section(page, "Group access").getByText("Current Access")
  ).toBeVisible();
}

/**
 * Grant `contactCardJson` access to whatever the given section governs.
 *
 * The editor disables its controls while a membership change is in flight, so
 * this waits for the new row rather than for the click.
 */
export async function addMember(
  page: Page,
  heading: string,
  contactCardJson: string,
  level: "RELAY" | "READ" | "EDIT" | "ADMIN"
): Promise<void> {
  const editor = section(page, heading);
  await editor.getByLabel("Contact card").fill(contactCardJson);
  await editor.getByLabel("Access level").selectOption(level);
  await editor.getByRole("button", { name: "Add", exact: true }).click();
}

/** The member rows of the access editor under a section heading. */
export function memberRows(page: Page, heading: string) {
  return section(page, heading).locator("div.kh-bg-muted");
}
