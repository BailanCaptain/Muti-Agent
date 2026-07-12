export const DIGEST_TZ = "Asia/Shanghai"

/** now → 该时区的 YYYY-MM-DD 业务日期 */
export function formatBusinessDate(now: Date, timeZone = DIGEST_TZ): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now)
}

export function prevBusinessDate(date: string, days = 1): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - days)
  return d.toISOString().slice(0, 10)
}

function weekdayInTz(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(now)
}

/** GitHub 周榜门：该时区周一才出 */
export function isMondayInTz(now: Date, timeZone = DIGEST_TZ): boolean {
  return weekdayInTz(now, timeZone) === "Mon"
}

/** 该时区每月 1 号判定（通用日历件；原 #27 月榜门 07-06 拆除——月榜改常驻，此函数保留备用） */
export function isFirstOfMonthInTz(now: Date, timeZone = DIGEST_TZ): boolean {
  return formatBusinessDate(now, timeZone).endsWith("-01")
}
