export type RedisReservation = {
  url: string | null
  enabled: boolean
  note: string
}

export function getRedisReservation(redisUrl: string): RedisReservation {
  return {
    url: redisUrl || null,
    enabled: Boolean(redisUrl),
    note: redisUrl
      ? "Redis 已配置，可用于会话缓存、队列状态和运行时分布式锁。"
      : "当前未接入 Redis，仅保留配置位。"
  }
}
