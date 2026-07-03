import { expect, test } from "@playwright/test"

/**
 * F038 种子用例 · 会话生命周期全链路（真浏览器点击 → 真 API → 真 SQLite → UI 更新）
 *
 * 纪律（webapp-testing skill golden rules）：
 * - 语义/testid 选择器，不绑 tooltip 文案（德彪 r1 P2-3）
 * - 后端持久化用 request.get 独立断言，不拿 DOM count 当真相（德彪 r1 P2-2：
 *   listSessionGroups limit=200 + 滚动列表，绝对计数会 flake）
 * - 禁 waitForTimeout；web-first assertion 自带重试
 * - 不发带 @agent 的消息 — 会真 spawn CLI provider（LLM 调用不进 E2E）
 */

// 与 playwright.config.ts 同源的端口约定（config 是唯一真相源，这里只读同一 env）
const apiPort = Number(process.env.E2E_API_PORT ?? 8999)
const apiBase = `http://localhost:${apiPort}`

test("冷启动全链路：bootstrap 空库自动建组 → 侧边栏渲染 → WS 连接成功", async ({ page }) => {
  await page.goto("/")
  await expect(page.getByRole("heading", { name: "会话", exact: true })).toBeVisible()
  // 空库时前端 bootstrap 自动 POST /api/session-groups 建组（thread-store.ts:510）
  await expect(page.getByTestId("session-card").first()).toBeVisible({ timeout: 30_000 })
  // WS 握手成功后 status 栏落「实时连接成功」（app/page.tsx onOpen）
  await expect(page.getByText("实时连接成功")).toBeVisible({ timeout: 15_000 })
})

test("点击「新建」→ POST 返回 groupId → 该会话卡可见 + 后端 bootstrap 可查", async ({
  page,
  request,
}) => {
  await page.goto("/")
  await expect(page.getByTestId("session-card").first()).toBeVisible({ timeout: 30_000 })

  // 用 POST 响应里的 groupId 做精确锚点，替代脆弱的 count+1（德彪 r1 P2-2）
  const [response] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().endsWith("/api/session-groups") && r.request().method() === "POST",
    ),
    page.getByRole("button", { name: "新建" }).click(),
  ])
  expect(response.ok()).toBeTruthy()
  const { groupId } = (await response.json()) as { groupId: string }
  expect(groupId).toBeTruthy()

  // 前端可见：新会话卡以 data-session-group-id 精确定位
  await expect(page.locator(`[data-session-group-id="${groupId}"]`)).toBeVisible()

  // 后端持久化独立断言：不经前端，直接查 API
  const bootstrap = await request.get(`${apiBase}/api/bootstrap`)
  expect(bootstrap.ok()).toBeTruthy()
  const payload = (await bootstrap.json()) as { sessionGroups: Array<{ id: string }> }
  expect(payload.sessionGroups.some((g) => g.id === groupId)).toBeTruthy()
})

test("搜索框 fill：输入不存在的 R-id → 空态提示（fill 交互覆盖）", async ({ page }) => {
  await page.goto("/")
  await expect(page.getByTestId("session-card").first()).toBeVisible({ timeout: 30_000 })

  await page.getByPlaceholder("搜索...").fill("R-999999")
  await expect(page.getByText("未找到房间 R-999999")).toBeVisible()

  // 清空恢复列表（回归确认 fill 不是单向破坏）
  await page.getByPlaceholder("搜索...").fill("")
  await expect(page.getByTestId("session-card").first()).toBeVisible()
})
