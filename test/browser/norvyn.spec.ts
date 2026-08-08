import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

test.describe.configure({ mode: "serial" });
let browserSessionCookie:
  | {
      name: string;
      value: string;
      domain: string;
      path: string;
      expires: number;
      httpOnly: boolean;
      secure: boolean;
      sameSite: "Strict" | "Lax" | "None";
    }
  | undefined;
let openedPages = 0;

async function openNorvyn(page: Page): Promise<void> {
  await page.route("**/*", async (route) => {
    const target = new URL(route.request().url());
    if (target.hostname === "127.0.0.1") await route.continue();
    else await route.abort("blockedbyclient");
  });
  if (browserSessionCookie) {
    await page.context().addCookies([browserSessionCookie]);
    await page.goto("/");
  } else {
    await page.goto("/#access=browser-test-access");
  }
  await expect(page.getByRole("button", { name: "Settings" })).toBeVisible();
  await expect(page.locator(".thread-item").filter({ hasText: "Only-one-cardinality-marker" })).toBeVisible();
  await expect(page).not.toHaveURL(/access=/);
  browserSessionCookie = (await page.context().cookies()).find((cookie) => cookie.name === "norvyn_session");
  if (openedPages++ > 0) {
    await page.locator(".new-chat").click();
    await expect(page.getByRole("button", { name: "Connect Folder" })).toBeVisible();
  }
}

test("production UI has deterministic desktop baselines and no serious accessibility violations", async ({
  page,
}) => {
  await openNorvyn(page);
  await expect(page).toHaveScreenshot("norvyn-1024x768.png", { animations: "disabled" });

  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(
    accessibility.violations.filter((violation) =>
      violation.impact ? ["serious", "critical"].includes(violation.impact) : false,
    ),
  ).toEqual([]);

  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page).toHaveScreenshot("norvyn-1440x900.png", { animations: "disabled" });
});

test("long Chat stays bounded, scrolls end to end, and keeps the composer visible", async ({ page }) => {
  await openNorvyn(page);
  await page
    .locator(".thread-item")
    .filter({
      hasText: "A very long architecture discussion title that must remain operable without clipping actions",
    })
    .click();
  await expect(page.getByText(/Long transcript answer 259/)).toBeVisible();
  await expect(page.getByText(/Showing the latest 200 transcript entries/)).toBeVisible();
  expect(await page.locator(".message").count()).toBeLessThanOrEqual(200);

  const content = page.locator(".transcript");
  await content.evaluate((element) => (element.scrollTop = 0));
  expect(await content.evaluate((element) => element.scrollTop)).toBe(0);
  await content.evaluate((element) => (element.scrollTop = element.scrollHeight));
  expect(await content.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);

  const composer = await page.locator(".composer").boundingBox();
  const viewport = page.viewportSize();
  expect(composer).not.toBeNull();
  expect(composer!.y + composer!.height).toBeLessThanOrEqual(viewport!.height);
});

test("History, Workspace, menus, divider, confirmations, and composer remain keyboard-operable", async ({
  page,
}) => {
  await openNorvyn(page);
  const search = page.getByRole("textbox", { name: "Search Chats" });
  await search.fill("no-such-chat-cardinality-zero");
  await expect(page.getByText("No Chats found.")).toBeVisible();
  await search.fill("Only-one-cardinality-marker");
  await expect(page.locator(".thread-row")).toHaveCount(1);
  await search.fill("");
  await expect(page.locator(".workspace-group")).toHaveCount(8);

  const workspaceTrigger = page.getByRole("button", { name: "Connect Folder" });
  await workspaceTrigger.click();
  await expect(page.locator("[data-menu-option]")).toHaveCount(5);
  await expect(page.locator("[data-menu-option]").first()).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.locator("[data-menu-option]").nth(1)).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(workspaceTrigger).toBeFocused();

  await workspaceTrigger.click();
  const browse = page.getByRole("button", { name: /Browse folders/ });
  await browse.click();
  await expect(browse).toBeEnabled();
  await browse.click();
  await expect(page.locator(".workspace-picker")).toBeHidden();

  await page.getByRole("button", { name: "Hide History" }).click();
  await page.reload();
  await expect(page.getByRole("button", { name: "Show History" })).toBeVisible();
  await page.getByRole("button", { name: "Show History" }).click();
  const divider = page.getByRole("separator", { name: "Resize History" });
  const dividerBox = await divider.boundingBox();
  expect(dividerBox).not.toBeNull();
  await page.mouse.move(dividerBox!.x + 1, dividerBox!.y + 20);
  await page.mouse.down();
  await page.mouse.move(dividerBox!.x + 24, dividerBox!.y + 20);
  await page.mouse.up();
  await divider.focus();
  const before = Number(await divider.getAttribute("aria-valuenow"));
  await page.keyboard.press("ArrowRight");
  await expect(divider).toHaveAttribute("aria-valuenow", String(before + 16));
  await page.keyboard.press("Home");
  await expect(divider).toHaveAttribute("aria-valuenow", "220");

  const model = page.getByRole("button", { name: "Model" });
  await model.focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("listbox", { name: "Model options" })).toBeVisible();
  await page.keyboard.press("End");
  await expect(page.getByRole("option").last()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(model).toBeFocused();

  const workspaceActions = page.locator(".workspace-actions summary").first();
  await workspaceActions.click();
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "Archive Chats" }).first().click();
  await expect(page.locator(".workspace-group")).toHaveCount(8);
  await page.getByRole("button", { name: "Delete History" }).first().click();
  await expect(page.getByRole("dialog", { name: "Delete Workspace History?" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Delete Workspace History?" })).toBeHidden();

  const textarea = page.getByRole("textbox", { name: "Start a Turn" });
  await textarea.fill("first line");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("second line");
  await expect(textarea).toHaveValue("first line\nsecond line");
  const initialHeight = await textarea.evaluate((element) => element.getBoundingClientRect().height);
  expect(initialHeight).toBeGreaterThan(20);
  await page.keyboard.press("Enter");
  await expect(textarea).toHaveValue("");
});

test("errors stay human, zoom stays usable, and reduced motion removes animation", async ({ page }) => {
  await openNorvyn(page);
  await page.locator(".thread-item").filter({ hasText: "Only-one-cardinality-marker" }).click();
  const textarea = page.getByRole("textbox", { name: "Start a Turn" });
  await expect(textarea).toBeEnabled();
  await textarea.fill("request-json-error");
  await page.keyboard.press("Enter");
  await expect(page.getByText("Provider rejected this request.").first()).toBeVisible();
  await expect(page.locator("body")).not.toContainText('{"status"');
  await expect(page.locator("body")).not.toContainText("browser-test-access");

  await page.emulateMedia({ reducedMotion: "reduce" });
  const duration = await page
    .locator(".dropdown-trigger")
    .first()
    .evaluate((element) => Number.parseFloat(getComputedStyle(element).transitionDuration) || 0);
  expect(duration).toBeLessThanOrEqual(0.01);

  await page.setViewportSize({ width: 512, height: 384 });
  const showHistory = page.getByRole("button", { name: "Show History" });
  await expect(showHistory).toBeVisible();
  await showHistory.click();
  await expect(page.getByRole("navigation", { name: "Past Chats" })).toBeVisible();
  await page.getByRole("button", { name: "Hide History" }).click();
  await expect(page.getByRole("button", { name: "Settings" })).toBeVisible();
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("dialog", { name: "settings" })).toBeVisible();
  await page.getByRole("button", { name: "Close" }).click();
  await page.locator(".workspace-path").click();
  await expect(page.getByRole("dialog", { name: "Workspace picker" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("textbox", { name: "Start a Turn" })).toBeVisible();
  const send = page.getByRole("button", { name: "Send Turn" });
  await expect(send).toBeAttached();
});
