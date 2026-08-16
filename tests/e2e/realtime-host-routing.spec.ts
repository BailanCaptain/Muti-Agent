import { expect, test } from "@playwright/test"

test("B047: realtime and HTTP recover through the page hostname", async ({ page }) => {
  const bootstrapCompleted = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      new URL(response.url()).pathname === "/api/bootstrap",
  )
  const socketCreated = page.waitForEvent(
    "websocket",
    (socket) => new URL(socket.url()).pathname === "/ws",
  )

  await page.goto("/")

  const bootstrapResponse = await bootstrapCompleted
  const socket = await socketCreated

  const bootstrapUrl = new URL(bootstrapResponse.url())
  expect(bootstrapUrl.hostname).toBe("localhost")
  expect(bootstrapUrl.port).toBe("8999")
  expect(bootstrapResponse.ok()).toBe(true)
  await expect(page.getByTestId("session-card").first()).toBeVisible({ timeout: 30_000 })

  const socketUrl = new URL(socket.url())
  expect(socketUrl.hostname).toBe("localhost")
  expect(socketUrl.port).toBe("8999")
  expect(socketUrl.pathname).toBe("/ws")

  await expect(page.getByText("实时连接成功", { exact: true })).toBeVisible()
  await expect(page.getByText("Connecting to realtime...", { exact: true })).toHaveCount(0)
})
