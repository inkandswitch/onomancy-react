import { expect, test, type Page } from "@playwright/test";
import { openApp, section } from "./helpers";

// The test app's onomancy stub resolves `self.test` to the local identity,
// `other.test` to a different one, and rejects everything else. See
// apps/component-test-app/src/onomancyStub.ts.

async function claimDnsName(page: Page, name: string): Promise<void> {
  const account = section(page, "Account");
  await account.getByRole("textbox", { name: "DNS name" }).fill(name);
  await account.getByRole("button", { name: "Save" }).click();
}

function badge(page: Page, text: string) {
  return section(page, "Account").locator("span", { hasText: text }).first();
}

test.describe("DNS names verified through onomancy", () => {
  test("a claim of a domain bound to this identity verifies", async ({
    page,
  }) => {
    await openApp(page);

    await claimDnsName(page, "@self.test");
    const claimed = badge(page, "@self.test");
    await expect(claimed).toBeVisible();
    await expect(claimed).toHaveAttribute("title", /DNSSEC-verified/);
  });

  test("a claim of someone else's domain is marked a mismatch", async ({
    page,
  }) => {
    await openApp(page);

    await claimDnsName(page, "other.test");
    const claimed = badge(page, "@other.test");
    await expect(claimed).toBeVisible();
    await expect(claimed).toHaveAttribute(
      "title",
      /designates a different identity/
    );
  });

  test("an unresolvable domain is marked unreachable, not failed", async ({
    page,
  }) => {
    await openApp(page);

    await claimDnsName(page, "nowhere.test");
    const claimed = badge(page, "@nowhere.test");
    await expect(claimed).toBeVisible();
    await expect(claimed).toHaveAttribute("title", /could not be resolved/);
  });

  test("a dotless name is rejected before it is stored", async ({ page }) => {
    await openApp(page);

    await claimDnsName(page, "nodots");
    // The wording is onomancy's, not ours: claims are parsed by the grammar
    // from the spec rather than by a hand-rolled check that could drift
    // from it. Asserted loosely for that reason — what matters is that the
    // claim is refused and nothing is stored.
    await expect(section(page, "Account").getByRole("alert")).toContainText(
      /dotless/i
    );
    await expect(badge(page, "@nodots")).not.toBeVisible();
  });

  test("clearing the field withdraws the claim", async ({ page }) => {
    await openApp(page);

    await claimDnsName(page, "self.test");
    await expect(badge(page, "@self.test")).toBeVisible();

    await claimDnsName(page, "");
    await expect(badge(page, "@self.test")).not.toBeVisible();
  });
});
