---
id: F029
title: 调研与核查管道（fact-check + deep-research 双模式）
status: spec
owner: 黄仁勋
created: 2026-06-12
---

# F029 — 调研与核查管道（fact-check + deep-research 双模式）

## Why

小孙愿景（2026-06-11 原话）：

> 我给出需要检索的信息之后，可以信息搜索，要有交叉验证，要给出引用源，判断是否是 fake news。类似 unifuncs U深搜。入口我还是想要。

> 我需要多 agent 验证，这样才能客观。而且我不怕引入依赖，我要的是做好，真正符合我的需求。

> （2026-06-12 追加）如果我也想要深度搜索呢？

参考产品 unifuncs「U深搜」= 深度搜索 + 事实核查一体两面。现有能力的缺口：

- CLI 内置 deep-research skill 是研究综述人设，无真伪裁决格式，且改不了源码
- runtime 现把 codex web search 压缩成 `[web search completed]`，`ToolEvent` 无 URL/query/发布时间等审计字段（`packages/api/src/runtime/codex-runtime.ts:103`、`packages/shared/src/tool-event.ts:3`），检索过程不可复现不可比较
- 纯 skill 形态无稳定状态、无结构化证据存储、无可审计引用——撑不起"真正做好"

## What

在产品 runtime 落一条**调研与核查管道**：统一检索层 + 异质 agent 独立取证 + 结构化证据账本 + fail-closed 裁决，**一个共享底座、两个模式入口**：

| | `/fact-check <声明>` | `/deep-research <课题>` |
|---|---|---|
| 输入 | 待核查的断言 | 开放问题 |
| 拆解 | 原子 claim 拆分（时间/主体限定） | 维度/子课题拆分 |
| 检索策略 | 对抗式（disconfirm first，主动找反例） | 覆盖式（multi-query union，求全） |
| 输出 | 三轴裁决 + 分歧 + 引用 | 综合报告（支持/反对/未定），不判真假 |

中间共享：SearchProvider 检索层、证据账本、多 agent 编排（独立取证→交叉审计→收敛）、信源卫生五问、渐进式报告 + 可点击引用 UI、case ledger。

小孙感知：房间里发 `/fact-check 某声明`（或点按钮）→ 渐进式看到 结论摘要 → 证据链 → 分歧区 → 可点击引用源；`/deep-research 某课题` → 多源综合报告。

## Acceptance Criteria

### Phase 1 — 共享底座 + fact-check 纵向闭环

- [ ] AC1: 房间内 `/fact-check <声明>` 命令 + UI 入口可触发完整管道
- [ ] AC2: 声明原文冻结 + 原子 claim 拆分（带时间/主体限定），逐 claim 核查
- [ ] AC3: 统一 `SearchProvider` 接口：≥2 个外部 provider（中文优先 + 全球）可配置可替换，不写死厂商；与 F027 memory 域 `HybridSearchProvider` 命名/模块隔离
- [ ] AC4: 三家模型原生检索接入为独立异议通道（Claude WebSearch / Codex `--search` / Gemini `google_web_search`，均已实测在位 2026-06-11）
- [ ] AC5: 证据账本结构化落盘：query / URL / 标题 / 发布时间 / 抓取时间 / 内容 hash / provider / 来源类型 / 共同源头谱系；搜索结果只算线索，必须 fetch 原文
- [ ] AC6: 两阶段独立验证：Phase A ≥2 异质模型独立检索、互不可见、dispatch 仅含中性声明（禁带预判/framing）；Phase B 合并证据池、URL+共同源头去重、交叉质询冲突证据
- [ ] AC7: 三正交轴裁决：`evidence_status`(supported/unverified/misleading/contradicted) × `confidence`(high/medium/low) × `fabrication`(not-assessed/suspected/evidenced)，每个核心判断带 Evidence/Reasoning/So-what/Confidence 四格
- [ ] AC8: fail-closed：证据不足强制 `unverified`（"没搜到"≠假）；任一异质验证者不可用 → 只出"单 agent 初步结果"标记，不给正式裁决章
- [ ] AC9: 检索纪律：disconfirm-first 反例检索；absence 判定需正反两路 + 相关概念均 0 命中；中英双语各搜一遍；"≥N 路无新源即停"停止判据
- [ ] AC10: 防注入：fetch 的网页内容按数据隔离处理，不当指令执行；恶意页面指令不得影响裁决
- [ ] AC11: 渐进式报告 UI：结论摘要 → 证据链 → 分歧区（不抹平，保留各方理由）→ 可点击引用（Gemini grounding redirect URL 解析为真实源 URL）
- [ ] AC12: case ledger 全程落盘：从声明到裁决全链路可审计可复现

### Phase 2 — deep-research 模式（复用底座）

- [ ] AC13: 房间内 `/deep-research <课题>` 命令 + UI 入口
- [ ] AC14: 维度拆解器：课题 → 子课题/子问题集
- [ ] AC15: 覆盖式检索：multi-query union（agent 主动 expand 同义/缩写/中英）+ coverage matrix + 停止判据
- [ ] AC16: 综合报告：支持/反对/未定三类证据表 + 置信度总评 + "我们没考虑到的维度"节；无真假裁决
- [ ] AC17: 复用 Phase 1 证据账本/引用/渐进式 UI，零重复实现

## Dependencies

- 外部 search API 选型与接入（中文优先 + 全球各一）：**API key 进 `.env` 为小孙人工操作**（Iron Law 3 配置不可变）；选型前按 Design Gate 用 30-50 条中英文基准声明实测召回
- codex CLI `--search` flag、gemini CLI `google_web_search`（2026-06-11 已实测在位）
- F026 A2A 派单/续推机制（worklist 续推现仅靠重读聊天历史 `packages/api/src/orchestrator/worklist-continuation.ts:34`，本 feature 需结构化 assessment 回传，不依赖自由文本解析）
- Related: F027（memory 域 HybridSearchProvider 命名区分；case ledger 持久化可评估复用其 SQLite 基建）

## Design Decisions

| 决策 | 选项 | 结论 | 原因 |
|------|------|------|------|
| 产品形态 | 纯 skill 先行 vs 直接 runtime 纵向闭环 | **runtime 纵向闭环**，skill 只承载方法论 | 德彪 Q3 [DISAGREE] 成立：纯 skill 无状态/无证据存储/无可审计引用，会成废脚手架；小孙要"入口+真正做好"（2026-06-11） |
| 多 agent 验证 | 同 family 多 lens vs 跨 family 异质 | **两阶段独立性**：Phase A 异质模型独立检索互不可见 → Phase B 合并交叉质询；同 family 多 lens 只算查询扩展 | 德彪 Q1 [DISAGREE] 成立：客观性 = 独立取证+异质模型+来源独立+分歧可见，非 agent 数量 |
| 分档 | 轻案降级同 family vs 档位只调深度 | Light=2 异质模型 / Full=3 模型+传播溯源+二轮对抗；**任何档位不降异质性** | 同上；fail-closed 兜底 |
| verdict 模型 | 五档线性（confirmed→fabricated） vs 三正交轴 | **三轴**：evidence_status × confidence × fabrication | 德彪 Q4 [DISAGREE] 成立：真假/置信度/捏造意图不同轴，线性混淆语义（`supported+medium`=较可能真；`contradicted+high` 才判假） |
| 检索引擎 | 三家原生检索替代外部 API vs 仅做补充 | **双外部 provider（中文+全球，SearchProvider 统一接口）为主，三家原生为独立异议通道** | 德彪 Q2 半成立：原生检索事件现不可审计；外部 API 营销能力≠中文覆盖达标，选型须基准实测 |
| feature 边界 | fact-check / deep-research 分立 feature vs 同 feature 双模式 | **同 feature 双模式，Phase 1 底座+核查，Phase 2 调研** | 底座占工作量 70%+，分立会出空心 feature 且底座长成单消费者形状；小孙 2026-06-12 拍板 |
| v1 砍掉 | — | 预测市场、完整传播图、图像/视频鉴伪、意图自动判断、复杂来源评分公式 | 德彪 Q4/Q5：预测市场反映预期非事实；其余另开能力域 |
| 官方沉默信号 | 进 v1 裁决因子 vs 弱信号 | 仅作弱负向信号，且须先证明该机构通常应当公开表态 | 德彪 Q4：防过度裁决 |

### 方法论移植清单（cat-cafe-skills 借鉴，2026-06-12 核定）

| 来源 | 移植物 | 落点 |
|------|--------|------|
| `source-audit`（整套） | Claim Ledger / 五问 checklist / verdict 思想 / provenance 行 / 回声室互引识别 | 裁决层 + 证据账本 |
| `refs/research-prompt-template.md` | 8 槽位 brief（Disconfirm First / Source Mix Quota 四项信源卫生标注 / 支持-反对-未定 Output Schema / Quality Gate"全支持=确认偏误"回收检查） | 检索 agent dispatch prompt + 自动质检规则 |
| `memory-search-best-practices` | 题型→recipe（coverage ≥3 刀 / absence 正反两路）/ "何时停"判据 / magic-word 刹车（"碎片够了"→强制补刀）/ 中英双语 / query expansion 归 agent 不归系统 | 检索纪律（AC9/AC15） |
| `expert-panel` | WHY 链四格 / dispatch 防锚定（禁带 Lead 判断）/ 收敛不抹平分歧 | 验证层编排 + 报告分歧区 |
| `deep-research`（cat-cafe 版） | 三家族训练偏差论（分歧=最有价值信号）/ prompt 落盘可追溯 | 异质验证设计依据 + case ledger |

**不移植**：Chrome 自动化驱动三家网页版 Deep Research（专有依赖重、半人工）、multi_mention/rich block/语音/DOCX 交付链（绑死 cat-cafe runtime）。

## Timeline

| 日期 | 事件 |
|------|------|
| 2026-06-11 | 小孙提出愿景（unifuncs U深搜对标）；黄仁勋初版方案；德彪（真 codex）设计讨论 4 [DISAGREE] 全收敛（两阶段独立性/三轴 verdict/产品优先/双 provider+异议通道）；三家原生检索实测确认 |
| 2026-06-12 | 小孙拍板双模式同 feature；cat-cafe 借鉴清单核定；Kickoff |

## Links

- Discussion: 设计讨论原始记录 `.runtime/reviews/fact-check-design-discussion-to-debiao.md` + `fact-check-design-codex-reply.md`（scratch 不入库，结论已沉淀本文档 Design Decisions）
- Plan: 待 `writing-plans` 产出
- Related: F026 / F027

## Evolution

- **Evolved from**: 无（全新能力域）
- **Blocks**: 无
- **Related**: F026（A2A 派单底座）、F027（memory 检索命名区分 + 持久化基建评估复用）
