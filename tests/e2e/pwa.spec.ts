import { expect, test } from "@playwright/test"

/**
 * F040 Phase 3 AC14：PWA 装机面——manifest 可达且关键字段正确、图标真 PNG、
 * apple meta 注入。head 元素不可见，一律 toHaveAttribute（自带 attached 等待），
 * 不用 toBeVisible（F038 golden rules）。
 */

test("PWA：manifest 字段 + 图标 PNG + apple meta + manifest link", async ({ page, request }) => {
  const mf = await request.get("/manifest.webmanifest")
  expect(mf.ok()).toBeTruthy()
  const m = (await mf.json()) as {
    name: string
    display: string
    theme_color: string
    icons: Array<{ src: string; sizes: string; type: string }>
  }
  expect(m.name).toBe("Multi-Agent")
  expect(m.display).toBe("standalone")
  expect(m.theme_color).toBe("#F6EFE7")
  expect(m.icons.length).toBeGreaterThanOrEqual(2)

  // 图标路由真出 PNG（ImageResponse 渲染活体，不是 404/HTML 兜底）
  for (const icon of m.icons) {
    const res = await request.get(icon.src)
    expect(res.ok(), `icon ${icon.src} 应 200`).toBeTruthy()
    expect(res.headers()["content-type"], `icon ${icon.src} 应为 png`).toContain("image/png")
  }

  await page.goto("/")
  // Next 16 渲染新标准名 mobile-web-app-capable（iOS 16.4+ 认；旧 apple- 前缀已废，node_modules/next/dist/lib/metadata/generate/basic.js:263）
  await expect(page.locator('meta[name="mobile-web-app-capable"]')).toHaveAttribute(
    "content",
    "yes",
  )
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
    "href",
    /manifest\.webmanifest/,
  )
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", "#F6EFE7")
})
