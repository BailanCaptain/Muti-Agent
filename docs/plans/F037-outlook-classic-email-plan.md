# F037 Outlook Classic Email Compatibility Implementation Plan

**Feature:** F037 — `docs/features/F037-daily-news-digest.md`
**Goal:** 保留已批准的日报内容和现代客户端视觉，同时让 Windows 经典 Outlook 稳定呈现清晰的刊头、卡片层级、字体与间距，并安全重发 2026-07-16 原内容一次。
**Acceptance Criteria:**
- AC1：经典 Outlook 获得 96 DPI、MSO 行高、Windows 中文字体与必要的 VML/Word 兼容；延续当前配色、深色刊头、字号层级、卡片结构与留白，不整体换成另一套降级视觉。
- AC2：手机/Chromium 保留当前暖白编辑部视觉；正文、栏目顺序、标题、条目、链接及 GitHub 数据不变。
- AC3：自动化合同锁定 Outlook 兼容标记、600px 盒模型、无脚本/远程图片和原有注入护栏。
- AC4：2026-07-16 归档只读重渲染，显示条目 ID 与 href 顺序和原邮件一致；不重抓、不调 LLM、不覆盖归档。
- AC5：archive-only SMTP 以新主题最多尝试重发一次，唯一收件人为 `sundengjun1@huawei.com`，并追加 outbound ledger；不调用 `reconcile`，不改 shown/rank/sent 终态。
**Architecture:** Preserve 模式。renderer 继续使用 600px table 与现有颜色/文案；现代客户端保留内联视觉，经典 Outlook 通过 MSO 条件头、显式 `bgcolor`、像素行高、`mso-line-height-rule`、Windows 字体与关键容器 VML 保持同一视觉方向。只有 Word 引擎客观不支持且 VML 对动态内容不安全的细节才做局部平台差异。重发使用不入产品路径的一次性、原子 marker 保护的 archive-only 运维脚本。
**Tech Stack:** TypeScript、node:test、HTML email tables、MSO conditional comments、QQ SMTP。

---

### Task 1: 锁定 Outlook Classic 失败合同

**Files:**
- Modify: `packages/api/src/services/daily-digest/renderer.test.ts`

1. 写失败测试：要求 MSO 96-DPI、table spacing reset、像素行高/`mso-line-height-rule`、Windows 中文字体与关键 table `bgcolor`。
2. 跑 renderer 专项，确认以缺少兼容标记的正确原因失败。
3. 记录 RED 输出到 B035。

### Task 2: 最小兼容实现

**Files:**
- Modify: `packages/api/src/services/daily-digest/renderer.ts`

1. 增加 Outlook Classic 条件头与 96-DPI 归一化。
2. 将关键文字行高换成等值像素并加入 MSO exact 规则。
3. 为刊头、导航、卡片和外框增加 HTML 背景色；字体栈增加 Windows 中文衬线并指定 `mso-fareast-font-family`；关键视觉容器用 MSO/VML 尽量保持现有圆角与强调结构。
4. 移除会撑宽目录的强制 nowrap；关键间距迁到 table/td 或提供 MSO 等价间距。
5. 跑专项测试到 GREEN，再执行 renderer/job 回归。

### Task 3: 原归档一致性与双端视觉验收

**Files:**
- Create (untracked evidence): `.agents/acceptance/B035/<timestamp>/before.html`
- Create (untracked evidence): `.agents/acceptance/B035/<timestamp>/after.html`
- Create (untracked evidence): `.agents/acceptance/B035/<timestamp>/after.eml`

1. 从主仓 2026-07-16 `summary.json/items.jsonl` 只读重渲染。
2. 断言 publication、displayed IDs、href 顺序、正文纯文本与原邮件一致；记录 HTML 大小和兼容标记计数。
3. Chromium 桌面/窄屏截图；真实经典 Outlook 打开 `.eml` 截图。
4. 更新 B035 六件套。

### Task 4: 门禁、独立验收与 review

1. 运行 typecheck、build、test、lint 与 docs 检查。
2. quality-gate 愿景对照。
3. 零上下文 acceptance-guardian 按 B035 复现步骤验收。
4. peer review；P1/P2 按 receiving-review Red→Green 闭环。

### Task 5: 合入与 archive-only 重发

1. 按 merge-gate 合入 `dev` 并清理 worktree。
2. 生成最终 2026-07-16 修正版 HTML；禁止使用旧 HTML SHA-256。
3. 一次性脚本先以 `openSync(..., "wx")` 创建 marker，再通过只允许 `sundengjun1@huawei.com` 的 QQ SMTP 发送；主题前缀 `【重发·电脑版修正版】`。
4. 成功后追加 outbound ledger，并核对 messageId、原收件人数量与 marker；不得自动重试。
