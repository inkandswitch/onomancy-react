import { expect, test } from "@playwright/test";
import { contactCard, openApp, section } from "./helpers";

test.describe("the library renders in a host application", () => {
  test("mounts AccountView with a usable identity", async ({ page }) => {
    await openApp(page);

    const account = section(page, "Account");
    // ProfileEditor and CopyableField, both from the library.
    await expect(
      account.getByRole("textbox", { name: "Name", exact: true })
    ).toBeVisible();
    await expect(account.getByRole("button", { name: "Save" })).toBeVisible();
    const card = await contactCard(page).innerText();
    expect(JSON.parse(card)).toHaveProperty("Add.payload.share_key");
  });

  test("applies its own stylesheet without the host configuring Tailwind", async ({
    page,
  }) => {
    await openApp(page);

    // Every library class is kh- prefixed. If styles.css failed to resolve,
    // the class is still in the DOM but nothing is applied to it.
    const prefixed = page.locator('[class*="kh-"]').first();
    await expect(prefixed).toBeVisible();

    const applied = await prefixed.evaluate((el) => {
      const style = getComputedStyle(el);
      return style.fontSize !== "" && style.display !== "";
    });
    expect(applied).toBe(true);
  });

  test("reports no access editor before there is anything to edit", async ({
    page,
  }) => {
    await openApp(page);
    await expect(
      section(page, "Document access").getByText("No document yet.")
    ).toBeVisible();
  });
});
