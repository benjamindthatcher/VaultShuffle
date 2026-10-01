import { expect, type Locator, type Page } from "@playwright/test";

export async function checkPreviewClose(page: Page, trigger: Locator, screenshot: string) {
  await trigger.click();
  const dialog = page.getByRole("dialog");
  const close = dialog.getByRole("button", { name: "Close game details", exact: true });
  await expect(close).toBeFocused();
  await expect(close).toHaveText("Close");
  await dialog.evaluate(node => Promise.all(node.getAnimations().map(animation => animation.finished)));
  const initial = (await close.boundingBox())!;
  expect(Math.round(initial.height)).toBeGreaterThanOrEqual(44);
  expect(initial.width).toBeGreaterThanOrEqual(44);
  expect(await close.evaluate(node => getComputedStyle(node).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
  await close.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(close).toBeFocused();
  expect(await close.evaluate(node => getComputedStyle(node).outlineStyle)).toBe("solid");
  await page.screenshot({ path: `/private/tmp/${screenshot}.png` });
  await close.hover();
  await expect(close).toHaveCSS("transform", "none");

  // A short viewport forces scrolling even for a compact preview.
  await page.setViewportSize({ width: page.viewportSize()!.width, height: 420 });
  const beforeScroll = (await close.boundingBox())!;
  await dialog.evaluate(node => { node.scrollTop = node.scrollHeight; });
  expect(await dialog.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
  expect((await close.boundingBox())!.y).toBeCloseTo(beforeScroll.y, 0);
  expect(await close.evaluate(node => {
    const rect = node.getBoundingClientRect();
    return node.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
  })).toBe(true);
  await page.screenshot({ path: `/private/tmp/${screenshot}-scrolled.png` });
  if (await page.evaluate(() => navigator.maxTouchPoints > 0)) await close.tap();
  else await close.click();
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(page.locator("body")).not.toHaveCSS("overflow", "hidden");
  await trigger.press("Enter");
  await expect(close).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
}
