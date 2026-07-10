import { DatabaseSync } from "node:sqlite"
import { expect, test } from "@playwright/test"

/**
 * F040 Phase 2.5 · 渠道管理页（AC-M4）——真点击 → 真 API → 真 SQLite。
 *
 * 纪律（F038 golden rules）：testid/语义选择器；后端持久化 request.get 独立断言；
 * 禁 waitForTimeout；禁 @agent 消息。放行流的审计行由 spec 直写 harness temp
 * SQLite 种入（生产写入方=网关拒绝路径，E2E 无飞书连接；E2E_SQLITE_PATH 由
 * playwright.config 暴露）。
 */

const apiPort = Number(process.env.E2E_API_PORT ?? 8999)
const apiBase = `http://localhost:${apiPort}`

async function openChannelTab(page: import("@playwright/test").Page) {
  await page.goto("/")
  await expect(page.getByTestId("session-card").first()).toBeVisible({ timeout: 30_000 })
  await page.getByRole("button", { name: "打开设置" }).click()
  await page.getByRole("button", { name: "渠道" }).click()
  await expect(page.getByTestId("channel-admin-tab")).toBeVisible()
}

test("成员：表单添加 → API 独立断言 → 改名 → 确认删除", async ({ page, request }) => {
  await openChannelTab(page)

  await page.getByTestId("add-member-openid").fill("ou_e2e_li")
  await page.getByTestId("add-member-name").fill("小李")
  await page.getByTestId("add-member-submit").click()
  await expect(page.getByTestId("member-row-ou_e2e_li")).toBeVisible()

  // 后端独立断言（不拿 DOM 当真相）
  const ov1 = await request.get(`${apiBase}/api/channel-admin/overview`)
  expect(ov1.ok()).toBeTruthy()
  const data1 = (await ov1.json()) as {
    members: Array<{ openId: string; displayName: string; role: string }>
  }
  const li = data1.members.find((m) => m.openId === "ou_e2e_li")
  expect(li).toBeTruthy()
  expect(li?.displayName).toBe("小李")
  expect(li?.role).toBe("participant")

  // 改名（inline 编辑）
  await page.getByTestId("member-edit-ou_e2e_li").click()
  await page.getByTestId("member-name-input-ou_e2e_li").fill("李哥")
  await page.getByTestId("member-save-ou_e2e_li").click()
  await expect(page.getByTestId("member-row-ou_e2e_li")).toContainText("李哥")

  // P2.6 AC-N3：禁用开关 → API 断言 enabled 翻转落库（热生效语义后端已单测）
  await page.getByTestId("member-toggle-ou_e2e_li").click({ force: true })
  await expect(page.getByTestId("member-row-ou_e2e_li")).toContainText("已禁用")
  const ovDisabled = await request.get(`${apiBase}/api/channel-admin/overview`)
  const dataDisabled = (await ovDisabled.json()) as {
    members: Array<{ openId: string; enabled: boolean }>
  }
  expect(dataDisabled.members.find((m) => m.openId === "ou_e2e_li")?.enabled).toBe(false)
  // 恢复（删除守卫按可用 owner 数，禁用态也可删——这里恢复只为验证双向）
  await page.getByTestId("member-toggle-ou_e2e_li").click({ force: true })
  await expect(page.getByTestId("member-row-ou_e2e_li")).not.toContainText("已禁用")

  // 删除走确认对话框
  await page.getByTestId("member-delete-ou_e2e_li").click()
  await page.getByRole("button", { name: "确定" }).click()
  await expect(page.getByTestId("member-row-ou_e2e_li")).toHaveCount(0)
  const ov2 = await request.get(`${apiBase}/api/channel-admin/overview`)
  const data2 = (await ov2.json()) as { members: Array<{ openId: string }> }
  expect(data2.members.some((m) => m.openId === "ou_e2e_li")).toBeFalsy()
})

test("群：表单添加 → 绑定房间下拉 → 开关停用 → API 断言 enabled/绑定翻转", async ({
  page,
  request,
}) => {
  await openChannelTab(page)

  await page.getByTestId("add-group-chatid").fill("oc_e2e_group1")
  await page.getByTestId("add-group-name").fill("E2E 测试群")
  await page.getByTestId("add-group-submit").click()
  await expect(page.getByTestId("group-row-oc_e2e_group1")).toBeVisible()

  // 绑定房间：冷启动 bootstrap 自动建的组必然 ≥1 个选项
  const select = page.getByTestId("group-room-select-oc_e2e_group1")
  const firstRoom = await select.locator("option:not([disabled])").first().getAttribute("value")
  expect(firstRoom).toBeTruthy()
  await select.selectOption(firstRoom as string)

  const ov1 = await request.get(`${apiBase}/api/channel-admin/overview`)
  const data1 = (await ov1.json()) as {
    groups: Array<{ chatId: string; enabled: boolean; sessionGroupId: string | null }>
  }
  const g1 = data1.groups.find((g) => g.chatId === "oc_e2e_group1")
  expect(g1?.enabled).toBe(true)
  expect(g1?.sessionGroupId).toBe(firstRoom)

  // P2.6 AC-N5：默认应答人下拉 → binding default_provider 落库（/agent 同一原语）
  await page.getByTestId("group-responder-select-oc_e2e_group1").selectOption("codex")
  const ovR = await request.get(`${apiBase}/api/channel-admin/overview`)
  const dataR = (await ovR.json()) as {
    groups: Array<{ chatId: string; effectiveDefaultProvider: string }>
  }
  expect(
    dataR.groups.find((g) => g.chatId === "oc_e2e_group1")?.effectiveDefaultProvider,
  ).toBe("codex")
  // 命令手册节在渠道 tab 可见（AC-N5 第二半）
  await expect(page.getByTestId("command-manual")).toBeVisible()

  // 开关停用（热生效语义后端已单测；这里断言 UI→API 翻转落库）
  await page.getByTestId("group-toggle-oc_e2e_group1").click({ force: true })
  await expect(page.getByTestId("group-row-oc_e2e_group1")).toContainText("已停用")
  const ov2 = await request.get(`${apiBase}/api/channel-admin/overview`)
  const data2 = (await ov2.json()) as { groups: Array<{ chatId: string; enabled: boolean }> }
  expect(data2.groups.find((g) => g.chatId === "oc_e2e_group1")?.enabled).toBe(false)
})

test("放行流：种子审计行 → 起名点放行 → member 落库 + 该申请消签", async ({
  page,
  request,
}) => {
  // 种子：直写 harness temp SQLite（生产唯一写入方=网关拒绝路径）。
  // 德彪 P2.5-r1 #3：id/openId 每次尝试唯一——CI retry 复用同一 temp DB，
  // 固定主键会在种子阶段撞 PK 把真失败掩盖成种子失败。
  const uniq = Date.now().toString(36)
  const auditId = `e2e-audit-${uniq}`
  const openId = `ou_e2e_stranger_${uniq}`
  const sqlitePath = process.env.E2E_SQLITE_PATH
  expect(sqlitePath, "playwright.config 应暴露 E2E_SQLITE_PATH").toBeTruthy()
  const db = new DatabaseSync(sqlitePath as string)
  try {
    db.prepare(
      `INSERT INTO channel_inbound_audit (id, channel, chat_id, chat_kind, open_id, reason, count, first_at, last_at, status)
       VALUES (?, 'feishu', 'oc_e2e_group1', 'group', ?, 'member-not-allowed', 3, '2026-07-04T00:00:00.000Z', '2026-07-04T00:00:01.000Z', 'pending')`,
    ).run(auditId, openId)
  } finally {
    db.close()
  }

  await openChannelTab(page)
  const row = page.getByTestId(`audit-row-${openId}-member-not-allowed`)
  await expect(row).toBeVisible()
  await expect(row).toContainText("被拒 3 次")

  // 没起名不能放行（fail-closed：归因署名必填）
  await expect(page.getByTestId(`audit-allow-${openId}`)).toBeDisabled()
  await page.getByTestId(`audit-name-${openId}`).fill("新同事")
  await page.getByTestId(`audit-allow-${openId}`).click()

  // 放行后：待放行行消失 + 成员区出现
  await expect(row).toHaveCount(0)
  await expect(page.getByTestId(`member-row-${openId}`)).toBeVisible()

  // 后端独立断言：member 落库 + 审计翻 allowed
  const ov = await request.get(`${apiBase}/api/channel-admin/overview`)
  const data = (await ov.json()) as {
    members: Array<{ openId: string; displayName: string }>
    pendingAudits: Array<{ openId: string }>
  }
  expect(data.members.find((m) => m.openId === openId)?.displayName).toBe("新同事")
  expect(data.pendingAudits.some((a) => a.openId === openId)).toBeFalsy()
  const audits = await request.get(`${apiBase}/api/channel-admin/audits?status=allowed`)
  const auditData = (await audits.json()) as { audits: Array<{ id: string }> }
  expect(auditData.audits.some((a) => a.id === auditId)).toBeTruthy()
})
