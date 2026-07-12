/**
 * F037 digest 环境配置（域内独有）。
 * 邮件发送通用零件（EmailSender/QqSmtp/Mock/Allowlist/parseRecipients/外发账本）
 * 已提升至共享模块 `lib/email-sender.ts`（F041 W7 抽零件，D11 禁 copy-first）——
 * 本文件只剩 digest 自己的 env 面（MULTI_AGENT_DIGEST_*）。
 */

export interface DigestEnvConfig {
  smtpUser?: string
  smtpPass?: string
  to?: string
  githubPat?: string
  /** AC13：自建 RSSHub 实例 base URL（如 http://192.168.x.x:1200 —— 注意 Iron Law §4，须走白名单显式放行） */
  rsshubBase?: string
  /**
   * 出站代理（大陆网络下 HF/mistral/raw.githubusercontent 等直连不通，2026-07-03 smoke 实测）。
   * 优先 MULTI_AGENT_DIGEST_PROXY，回退标准 HTTPS_PROXY/HTTP_PROXY（curl 同款语义）。
   * 均为用户环境配置（Iron Law §3 人工），代码只读。
   */
  proxy?: string
}

export function resolveDigestEnv(env: NodeJS.ProcessEnv = process.env): DigestEnvConfig {
  return {
    smtpUser: env.MULTI_AGENT_DIGEST_SMTP_USER,
    smtpPass: env.MULTI_AGENT_DIGEST_SMTP_PASS,
    to: env.MULTI_AGENT_DIGEST_TO,
    githubPat: env.MULTI_AGENT_DIGEST_GITHUB_PAT,
    rsshubBase: env.MULTI_AGENT_DIGEST_RSSHUB_BASE,
    proxy: env.MULTI_AGENT_DIGEST_PROXY ?? env.HTTPS_PROXY ?? env.HTTP_PROXY,
  }
}
