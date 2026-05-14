# RAG (Retrieval-Augmented Generation) — 入门教程

> 来源：小孙 drop 的一份 RAG paper 摘录
> 锁定 fixture 用于 F027 P4.6 AC-P1-3 端到端测试

## 概念

RAG（Retrieval-Augmented Generation）是把检索（retrieval）嵌入到 LLM 推理过程中的范式。
核心动机：LLM 参数化记忆容量有限 + 时效性差，需要外部知识库补强。

Lewis et al. 2020 提出的原始 RAG 把 top-k 检索结果 concat 到 prompt 里，让 LLM 在生成时
能看到外部文档的相关片段。这跟单纯依赖 LLM 内部参数知识有本质区别——RAG 把知识外化、
让 retrieval 决定上下文，让 LLM 专注生成。

## 检索器选型

主流检索器分两大类：

1. **Dense retriever**（如 DPR / ColBERT）：用 dual-encoder 把 query 和文档都编码成 dense
   向量，向量相似度（cosine / dot product）作召回信号。优点：语义召回；缺点：需要训练。

2. **Sparse retriever**（如 BM25 / TF-IDF）：基于词频统计的稀疏召回。优点：无需训练 +
   关键词精准；缺点：同义词问题。

实践常见做法是 **hybrid**：dense + sparse 双路召回后合并，再用 reranker（如 cross-encoder）
精排 top-N。

## RAG 与 SessionBootstrap 的相似处

RAG 的"工具驱动 recall"思想跟 F018 SessionBootstrap 异曲同工：
- F018：Claude Code 续接时按需召回历史 thread / SOP / 工具状态
- RAG：LLM 推理时按需召回外部文档片段

两者的核心都是 **不靠模型记忆，靠 indexed content + selective retrieval**。

## RAG 与 B022 prompt-injection 的关联

B022 修复后定义"系统注入只能从单一真相源 + fail-closed"，跟 RAG 召回的内容当作 USER MESSAGE
的安全模型一致——召回的文本是数据，不是指令。这跟 F027 章节 7 的 raw drop taint model 同源。

## 实施考虑

- top-k 选 5-20 之间，太多会冲淡 prompt
- chunk size 通常 256-512 tokens，过短丢失上下文，过长召回噪声
- embedding model 选 sentence-transformers / OpenAI ada / Cohere multilingual
- chunk overlap 10-20% 减少 boundary loss

## 方法 vs 概念

RAG 既是 concept（知识增强生成范式）也是 method（具体的 retrieval + generation pipeline 实现）。
本文档作 concept type 注册到 wiki，具体实现细节（chunking strategy / embedding 选型）走
method type 单独章节。
