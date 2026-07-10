import { DatabaseSync } from "node:sqlite"
import { type APIRequestContext, expect, test } from "@playwright/test"

const apiPort = Number(process.env.E2E_API_PORT ?? 8999)
const apiBase = `http://localhost:${apiPort}`

async function createGroup(request: APIRequestContext) {
  const response = await request.post(`${apiBase}/api/session-groups`)
  expect(response.ok()).toBeTruthy()
  return ((await response.json()) as { groupId: string }).groupId
}

test("F044 desktop switch shows pending immediately and reselecting active group sends no request", async ({
  page,
  request,
}) => {
  const targetGroupId = await createGroup(request)
  const initialGroupId = await createGroup(request)
  await page.goto("/")
  await expect(page.locator(`[data-session-group-id="${initialGroupId}"]`)).toBeVisible({
    timeout: 30_000,
  })

  let releaseSnapshot!: () => void
  const snapshotGate = new Promise<void>((resolve) => {
    releaseSnapshot = resolve
  })
  let snapshotRequests = 0
  await page.route(`**/api/session-groups/${targetGroupId}`, async (route) => {
    snapshotRequests += 1
    await snapshotGate
    await route.continue()
  })

  const targetCard = page.locator(`[data-session-group-id="${targetGroupId}"]`)
  await expect(targetCard).toBeVisible()
  await targetCard.click()
  await expect(targetCard).toHaveAttribute("data-pending", "true")
  await expect(page.getByRole("status", { name: "加载中", exact: true })).toBeVisible()

  releaseSnapshot()
  await expect(targetCard).not.toHaveAttribute("data-pending", "true")
  expect(snapshotRequests).toBe(1)

  await targetCard.click()
  await expect(targetCard).not.toHaveAttribute("data-pending", "true")
  expect(snapshotRequests).toBe(1)
})

test("F044 mobile drawer closes before the delayed snapshot resolves", async ({
  page,
  request,
}) => {
  const targetGroupId = await createGroup(request)
  await createGroup(request)
  await page.setViewportSize({ width: 390, height: 844 })

  let releaseSnapshot!: () => void
  const snapshotGate = new Promise<void>((resolve) => {
    releaseSnapshot = resolve
  })
  await page.route(`**/api/session-groups/${targetGroupId}`, async (route) => {
    await snapshotGate
    await route.continue()
  })

  await page.goto("/")
  const openSidebar = page.getByTestId("mobile-sidebar-open")
  await expect(openSidebar).toBeVisible({ timeout: 30_000 })
  await openSidebar.click()

  const drawer = page.getByTestId("session-sidebar-drawer")
  await expect(drawer).toBeVisible()
  const targetCard = drawer.locator(`[data-session-group-id="${targetGroupId}"]`)
  await expect(targetCard).toBeVisible()
  await targetCard.click()

  await expect(drawer).toHaveCount(0)
  releaseSnapshot()
  await expect(openSidebar).toBeVisible()
})

test("F044 real temp SQLite pages all history and preserves the reading anchor", async ({
  page,
  request,
}) => {
  const groupId = await createGroup(request)
  const sqlitePath = process.env.E2E_SQLITE_PATH
  expect(sqlitePath).toContain("multi-agent-e2e-")

  const db = new DatabaseSync(sqlitePath!)
  const thread = db
    .prepare("SELECT id FROM threads WHERE session_group_id = ? ORDER BY provider LIMIT 1")
    .get(groupId) as { id: string } | undefined
  expect(thread?.id).toBeTruthy()

  const insert = db.prepare(
    "INSERT INTO messages (id, thread_id, role, content, message_type, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
  const userMessageIndexes = new Set([0, 25, 50, 75, 100, 125, 150, 175, 200])
  const sealMessageIndexes = new Set([10, 60, 110, 160])
  db.exec("BEGIN")
  try {
    for (let index = 0; index < 205; index += 1) {
      const ordinal = String(index).padStart(3, "0")
      insert.run(
        `f044-e2e-${ordinal}`,
        thread!.id,
        userMessageIndexes.has(index) ? "user" : "assistant",
        `F044 paged message ${ordinal}`,
        sealMessageIndexes.has(index) ? "system_notice" : "final",
        new Date(Date.UTC(2026, 6, 11, 0, 0, index)).toISOString(),
      )
    }
    db.exec("COMMIT")
  } catch (error) {
    db.exec("ROLLBACK")
    throw error
  } finally {
    db.close()
  }

  const initialResponse = await request.get(`${apiBase}/api/session-groups/${groupId}`)
  expect(initialResponse.ok()).toBeTruthy()
  const initial = (await initialResponse.json()) as {
    activeGroup: { timeline: Array<{ id: string }> }
    timelinePage: { hasMore: boolean; nextCursor: string | null; limit: number }
  }
  expect(initial.activeGroup.timeline).toHaveLength(100)
  expect(initial.activeGroup.timeline[0]?.id).toBe("f044-e2e-105")
  expect(initial.activeGroup.timeline.at(-1)?.id).toBe("f044-e2e-204")
  expect(initial.timelinePage).toMatchObject({ hasMore: true, limit: 100 })
  expect(initial.timelinePage.nextCursor).toBeTruthy()

  await page.goto("/")
  await expect(page.locator(`[data-session-group-id="${groupId}"]`)).toBeVisible({
    timeout: 30_000,
  })
  const loadOlder = page.getByTestId("load-older-timeline")
  const scroll = page.getByTestId("timeline-scroll")
  const minimap = page.getByTestId("timeline-minimap")
  const marker175 = minimap.getByRole("button", { name: /F044 paged message 175$/ })
  await expect(loadOlder).toBeVisible()
  await expect(marker175).toHaveAttribute("data-index", "70")
  await marker175.click()
  await expect(scroll.getByText("F044 paged message 175")).toBeVisible()
  await scroll.evaluate((element) => {
    element.scrollTop = 0
    element.dispatchEvent(new Event("scroll"))
  })
  await expect(page.getByText("F044 paged message 105")).toBeVisible()
  const scrollTopBefore = await scroll.evaluate((element) => element.scrollTop)

  const firstPageResponse = page.waitForResponse(
    (response) =>
      response.url().includes(`/api/session-groups/${groupId}/timeline?before=`) &&
      response.request().method() === "GET",
  )
  await loadOlder.click()
  const firstPage = (await (await firstPageResponse).json()) as {
    timeline: Array<{ id: string }>
    timelinePage: { hasMore: boolean; nextCursor: string | null; limit: number }
  }
  expect(firstPage.timeline).toHaveLength(100)
  expect(firstPage.timeline[0]?.id).toBe("f044-e2e-005")
  expect(firstPage.timeline.at(-1)?.id).toBe("f044-e2e-104")
  expect(firstPage.timelinePage.hasMore).toBe(true)
  await expect(page.getByText("F044 paged message 105")).toBeVisible()
  await expect(marker175).toHaveAttribute("data-index", "170")
  const marker025 = minimap.getByRole("button", { name: /F044 paged message 025$/ })
  await expect(marker025).toHaveAttribute("data-index", "20")
  await marker025.click()
  await expect(scroll.getByText("F044 paged message 025")).toBeVisible()
  await marker175.click()
  await expect(scroll.getByText("F044 paged message 175")).toBeVisible()
  await expect
    .poll(() => scroll.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(scrollTopBefore)

  const secondPageResponse = page.waitForResponse(
    (response) =>
      response.url().includes(`/api/session-groups/${groupId}/timeline?before=`) &&
      response.request().method() === "GET",
  )
  await loadOlder.click()
  const secondPage = (await (await secondPageResponse).json()) as {
    timeline: Array<{ id: string }>
    timelinePage: { hasMore: boolean; nextCursor: string | null; limit: number }
  }
  expect(secondPage.timeline).toHaveLength(5)
  expect(secondPage.timeline[0]?.id).toBe("f044-e2e-000")
  expect(secondPage.timeline.at(-1)?.id).toBe("f044-e2e-004")
  expect(secondPage.timelinePage).toMatchObject({ hasMore: false, nextCursor: null, limit: 100 })
  await expect(loadOlder).toHaveCount(0)
  await expect(marker175).toHaveAttribute("data-index", "175")
  const marker000 = minimap.getByRole("button", { name: /F044 paged message 000$/ })
  await expect(marker000).toHaveAttribute("data-index", "0")
  await marker000.click()

  await scroll.evaluate((element) => {
    element.scrollTop = 0
    element.dispatchEvent(new Event("scroll"))
  })
  await expect(scroll.getByText("F044 paged message 000")).toBeVisible()
})
