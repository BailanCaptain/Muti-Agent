---
name: quality-gate
description: >
  开发完成后的自检门禁：愿景对照 + spec 合规 + 验证命令输出。
  Use when: 开发完了准备提 review、声称完成了、准备交付。
  Not for: 收到 review 反馈（用 receiving-review）、merge（用 merge-gate）。
  Output: Spec 合规报告（含愿景覆盖度）。
---

# Quality Gate

开发完成到提 review 之间的自检关卡：对照 spec 验收 + 用真实命令输出证明你的声明。

## 核心知识

**两条铁律合一**：

1. **Spec alignment**：AC 可能写偏，先回读原始需求，再逐项验收
2. **Evidence before claims**：没有运行命令、没看到输出，就不能说"通过了"

> 铁律：`NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE`
>
> 自问："我是这次真的运行了命令并看到输出，还是我只是相信它能工作？"

**为什么 AC 可能不够**：AC 是人写的，可能遗漏 UX 要求或场景覆盖。所以 Step 0 先回读原始需求。

## 流程

```
BEFORE 声称完成 / 提 review:

Step 0: VISION CHECK（愿景核对）
  ① 找原始需求文档（feature doc / Discussion 记录）
  ② 读核心痛点："小孙说的是..."
  ③ 问自己：小孙用这个功能，体验是什么样的？
  ④ AC 是否完整覆盖了原始需求？
     → 如有遗漏，先补 AC 再继续

Step 0.5: DELIVERY COMPLETENESS CHECK
  ① 这次交付的是完整 feat 还是 feat 的一部分？
     → 完整 feat：继续
     → 部分：有小孙明确同意分批交付的记录吗？没有就继续做完
  ② 本次产出后续需要"重写"还是"扩展"？
     → 扩展：通过
     → 重写：说明绕路了（Spike 除外），回去重做

Step 1: FIND — 找 spec/plan 文档
  - feature doc (docs/features/Fxxx.md)
  - implementation plan (docs/plans/)
  - 同时找 Discussion 记录（小孙原话所在）

Step 2: CREATE — 建检查清单
  - 列出每一个 AC / 功能点 / 边界条件
  - 列出 Discussion 里的 UX 描述和场景

Step 3: VERIFY — 逐项检查
  - 代码在哪？有测试覆盖？边界处理了？
  - 🔴 交付物必须核实 commit/PR 状态（git log --grep + gh pr list）
    spec checkbox 是记录工具，不是真相源
  - 🔴 新增行为规则 → shared-rules 更新了吗？

Step 4: RUN — 运行验证命令（必须这次真实运行）
  pnpm typecheck    # 含 shared / api 子包类型检查
  pnpm build        # 根 build 一条串起 shared + next + api
  pnpm test         # node:test runner，tsx 跑 packages/**/*.test.ts
  pnpm lint         # biome

  🔴 条件触发 — 本次 diff 涉及依赖声明改动（package.json / lockfile）:
     ① 必须跑 `pnpm install` 把声明物化到 node_modules
     ② 必须用**项目当前的启动脚本**把服务完整起一遍，
        确认 API + Web 同时 ready
        （脚本名会随项目演进而改，当前为 `start-project`；
          以仓库根目录能启动全量服务的脚本为准）
     原因：缺依赖只在 runtime import 时崩，typecheck / build / 单测都
          覆盖不到启动链；Web 用自己的解析路径可能掩盖 API 崩溃，
          必须看到"两端都 ready"。
     依据：LL-017（同一反模式已两次复发）。

Step 5: READ — 完整读输出，看 exit code，数失败数

Step 6: REPORT — 输出合规报告
```

## 合规报告模板

```markdown
## Quality Gate Report

**Spec**: docs/features/Fxxx-name.md
**原始需求**: {Discussion / feature doc 路径}
**检查时间**: YYYY-MM-DD HH:MM

### 愿景覆盖（Step 0）
| # | 小孙原始需求 | AC 覆盖？ | 实现？ |
|---|-------------|-----------|--------|
| 1 | "我要 XXX"   | AC#3      | ✅     |

### 功能验收
| # | 要求 | 状态 | 代码位置 | 测试覆盖 |
|---|------|------|----------|----------|
| 1 | XXX  | ✅   | file.ts:L10 | test.ts |

### 验证命令输出（必须是这次真实运行）
pnpm test → N/N pass ✅
pnpm build → exit 0 ✅
```

## Quick Reference

| Claim | 需要 | 不够用 |
|-------|------|--------|
| 测试通过 | 这次运行输出：0 failures | "上次跑过"、"应该通过" |
| 构建成功 | build 命令：exit 0 | lint 通过不代表编译通过 |
| Bug 修了 | 原症状测试：通过 | 代码改了，以为修了 |
| 需求满足 | spec + Discussion 逐项打勾 | 测试通过就完事 |
| Feature 完成/未完成 | git log + PR 状态 + spec 逐项 | 只看 spec checkbox |
| 依赖改动 | pnpm install + 项目启动脚本端到端跑通（API+Web 都 ready） | 仅 typecheck/build/test |

## Common Mistakes

| 错误 | 正确做法 |
|------|----------|
| 只检查 AC，没回读 Discussion | Step 0 先读原始需求 |
| "上次跑测试是通过的" | 这次重新跑，看输出 |
| "应该没问题" / "probably works" | Run the command. Read the output. |
| 测试通过就声称完成 | 还要对照 spec 逐项检查 |
| 部分实现就提 review | P1/P2 遗漏必须当轮补完 |
| 交付半成品让小孙"先看看" | 交付完整 feat，步骤是内部节奏 |
| 改了 package.json 只跑 typecheck/build/test 就声称通过 | 还要 pnpm install + 启动脚本完整起一遍 |

**Red flags — 立刻 STOP**：
- 用 "should"、"probably"、"seems to"
- 表达满足感（"好了！"、"完成！"）时还没运行命令
- 信任 subagent 的 "success" 报告而没独立验证

## 和其他 skill 的区别

| Skill | 关注点 | 时机 |
|-------|--------|------|
| **quality-gate（本 skill）** | spec 对照 + 证据验证 | 提 review 之前 |
| `acceptance-guardian` | 零上下文独立验收 | quality-gate 之后 |
| `merge-gate` | reviewer 是否放行 | 合入 dev 之前 |
| `receiving-review` | 处理 reviewer 反馈 | 收到 review 之后 |

## 下一步

Quality Gate 通过后 → **直接进入 `acceptance-guardian`**（零上下文 agent 做 feature / bug 独立验收）。

Gate 未通过时：
- **P1 遗漏** → 补完再过 gate
- **P2 遗漏** → 必须当轮补完再提 review
- **测试 / build 失败** → 修到绿灯再提
