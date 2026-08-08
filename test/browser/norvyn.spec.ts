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
    await expect(page.getByRole("textbox", { name: "Start a Turn" })).toBeEnabled();
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

test("collapsed Workspace action menus stay visible and keep labels on one line", async ({ page }) => {
  await openNorvyn(page);
  const activeFirstToggle = page.locator(".workspace-group-toggle").first();
  await activeFirstToggle.click();
  await expect(activeFirstToggle).toHaveAttribute("aria-expanded", "false");
  await page.getByRole("button", { name: "Archived" }).click();
  await page.getByRole("button", { name: "Active" }).click();
  await expect(page.locator(".workspace-group-toggle").first()).toHaveAttribute("aria-expanded", "true");
  await page.getByRole("button", { name: "Archived" }).click();

  const groups = page.locator(".workspace-group");
  await expect(groups.first()).toBeVisible();
  const toggles = groups.locator(".workspace-group-toggle");
  await expect(toggles.first()).toHaveAttribute("aria-expanded", "true");

  const lastGroup = groups.last();
  const lastToggle = lastGroup.locator(".workspace-group-toggle");
  await lastToggle.scrollIntoViewIfNeeded();
  await lastToggle.click();
  await expect(lastToggle).toHaveAttribute("aria-expanded", "false");

  await lastGroup.locator(".workspace-actions summary").click();
  const menu = lastGroup.locator(".workspace-actions-menu");
  const deleteHistory = menu.getByRole("button", { name: "Delete History" });
  await expect(menu).toBeVisible();
  await expect(deleteHistory).toBeVisible();

  const menuBox = await menu.boundingBox();
  const historyBox = await page.locator(".thread-list").boundingBox();
  expect(menuBox).not.toBeNull();
  expect(historyBox).not.toBeNull();
  expect(menuBox!.y).toBeGreaterThanOrEqual(historyBox!.y);
  expect(menuBox!.y + menuBox!.height).toBeLessThanOrEqual(historyBox!.y + historyBox!.height);
  expect(await deleteHistory.evaluate((button) => getComputedStyle(button).whiteSpace)).toBe("nowrap");

  await page.getByRole("button", { name: "Active" }).click();
  const activeLastGroup = page.locator(".workspace-group").last();
  const activeLastToggle = activeLastGroup.locator(".workspace-group-toggle");
  await activeLastToggle.scrollIntoViewIfNeeded();
  await activeLastToggle.click();
  await activeLastGroup.locator(".workspace-actions summary").click();

  const activeMenu = activeLastGroup.locator(".workspace-actions-menu");
  const archiveChats = activeMenu.getByRole("button", { name: "Archive Chats" });
  const activeDeleteHistory = activeMenu.getByRole("button", { name: "Delete History" });
  await expect(archiveChats).toBeVisible();
  await expect(activeDeleteHistory).toBeVisible();
  const activeMenuBox = await activeMenu.boundingBox();
  const activeHistoryBox = await page.locator(".thread-list").boundingBox();
  expect(activeMenuBox).not.toBeNull();
  expect(activeHistoryBox).not.toBeNull();
  expect(activeMenuBox!.y).toBeGreaterThanOrEqual(activeHistoryBox!.y);
  expect(activeMenuBox!.y + activeMenuBox!.height).toBeLessThanOrEqual(
    activeHistoryBox!.y + activeHistoryBox!.height,
  );
  expect(await archiveChats.evaluate((button) => getComputedStyle(button).whiteSpace)).toBe("nowrap");
  expect(await activeDeleteHistory.evaluate((button) => getComputedStyle(button).whiteSpace)).toBe("nowrap");
});

test("the visible Chat composer accepts pointer focus and typing", async ({ page }) => {
  await openNorvyn(page);
  const composerInput = page.getByRole("textbox", { name: "Start a Turn" });
  const inputBox = await composerInput.boundingBox();
  expect(inputBox).not.toBeNull();

  await page.mouse.click(inputBox!.x + inputBox!.width / 2, inputBox!.y + inputBox!.height / 2);
  await expect(composerInput).toBeFocused();
  await page.keyboard.type("pointer click works");
  await expect(composerInput).toHaveValue("pointer click works");
});

test("Enter renders immediately and the composer accepts at most ten attachments", async ({ page }) => {
  await openNorvyn(page);
  await page.locator(".thread-item").filter({ hasText: "Only-one-cardinality-marker" }).click();
  await page.locator(".new-chat").click();
  await expect(page.getByRole("textbox", { name: "Start a Turn" })).toBeEnabled();
  const composer = page.getByRole("textbox", { name: "Start a Turn" });
  await composer.fill("delayed-start");
  await page.keyboard.press("Enter");
  await expect(page.getByText("delayed-start", { exact: true })).toBeVisible({ timeout: 500 });
  await expect(composer).toHaveValue("");

  const attachButton = page.locator(".composer .attach");
  await expect(attachButton).toBeVisible();
  await page.locator('input[type="file"][aria-label="Attach images or files"]').setInputFiles(
    Array.from({ length: 10 }, (_, index) => ({
      name: `image-${index}.png`,
      mimeType: "image/png",
      buffer: Buffer.from("image"),
    })),
  );
  await expect(page.locator(".attachment-chip")).toHaveCount(10);
  await expect(attachButton).toBeDisabled();
  await expect(page.getByText("Started after delay")).toBeVisible();
});

test("approving Provider requests completes without an invalid server event", async ({ page }) => {
  await openNorvyn(page);
  await page.locator(".thread-item").filter({ hasText: "Only-one-cardinality-marker" }).click();
  await page.locator(".new-chat").click();
  await expect(page.getByRole("textbox", { name: "Start a Turn" })).toBeEnabled();
  const composer = page.getByRole("textbox", { name: "Start a Turn" });
  await composer.fill("approvals");
  await page.keyboard.press("Enter");

  const approval = page.locator(".approval");
  await expect(approval.getByText("File change requested")).toBeVisible();
  await approval.getByRole("button", { name: "Approve" }).click();
  await expect(approval.getByText("Command requested")).toBeVisible();
  await approval.getByRole("button", { name: "Approve" }).click();

  await expect(page.getByText("file:accept;command:accept")).toBeVisible();
  await expect(page.locator("body")).not.toContainText("invalid local server event");
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

  const composerInput = page.getByRole("textbox", { name: "Start a Turn" });
  await composerInput.fill("Follow streamed output at the bottom");
  await page.keyboard.press("Enter");
  await expect(page.getByText(/stream-11/).last()).toBeVisible();
  expect(
    await content.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight),
  ).toBeLessThanOrEqual(24);

  await content.evaluate((element) => {
    element.scrollTop = element.scrollHeight * 0.45;
    element.dispatchEvent(new Event("scroll"));
  });
  const anchoredEntry = await content.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return [...element.querySelectorAll<HTMLElement>("[data-transcript-entry]")].find(
      (entry) => entry.getBoundingClientRect().bottom > bounds.top,
    )?.dataset.transcriptEntry;
  });
  await composerInput.fill("Preserve my scroll anchor");
  await page.keyboard.press("Enter");
  await expect(page.getByText("Hello").last()).toBeVisible();
  const restoredEntry = await content.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return [...element.querySelectorAll<HTMLElement>("[data-transcript-entry]")].find(
      (entry) => entry.getBoundingClientRect().bottom > bounds.top,
    )?.dataset.transcriptEntry;
  });
  expect(restoredEntry).toBe(anchoredEntry);

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
  const emptyWorkspaceTrigger = page.locator(".workspace-path");
  await emptyWorkspaceTrigger.click();
  const emptyWorkspaceDialog = page.getByRole("dialog", { name: "Workspace picker" });
  await expect(emptyWorkspaceDialog.locator("[data-menu-option]")).toHaveCount(0);
  expect(await emptyWorkspaceDialog.evaluate((dialog) => dialog.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Escape");
  await search.fill("Only-one-cardinality-marker");
  await expect(page.locator(".thread-row")).toHaveCount(1);
  await emptyWorkspaceTrigger.click();
  await expect(page.locator("[data-menu-option]")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await search.fill("Five-workspace-cardinality-marker");
  await expect(page.locator(".workspace-group")).toHaveCount(5);
  await emptyWorkspaceTrigger.click();
  await expect(page.locator("[data-menu-option]")).toHaveCount(5);
  await page.keyboard.press("Escape");
  await search.fill("Six-workspace-cardinality-marker");
  await expect(page.locator(".workspace-group")).toHaveCount(6);
  await emptyWorkspaceTrigger.click();
  await expect(page.locator("[data-menu-option]")).toHaveCount(5);
  await page.keyboard.press("Escape");
  await search.fill("");
  await expect(page.locator(".workspace-group")).toHaveCount(8);
  expect(await page.locator(".workspace-group").count()).toBeGreaterThanOrEqual(6);

  const workspaceTrigger = page.locator(".workspace-path");
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
  await expect(
    page.getByText("The Provider rejected this request. Check your setup and retry.").first(),
  ).toBeVisible();
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
