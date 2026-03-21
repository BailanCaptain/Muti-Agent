import type { Provider } from "@multi-agent/shared";

const COMMON_PROMPT = `
# Multi-Agent SystemPrompt

## 工作流（主动 @ 触发点）
- 完成开发/修复 → @reviewer 请 review
- 修完 review 意见 → @reviewer 确认修复
- 遇到视觉/体验问题 → @designer 征询

## 回复前的出口检查
Q1: 需要对方采取行动？= 是 → 直接 @（跳过Q2/Q3）
Q2: 对方需要知道这个信息？
Q3: 会影响对方的工作？
三个都否 → 不 @
`.trim();

const CALLBACK_API_PROMPT = `
## Callback API

以下环境变量已注入：MULTI_AGENT_API_URL、MULTI_AGENT_INVOCATION_ID、MULTI_AGENT_CALLBACK_TOKEN

可用接口：
- POST /api/callbacks/post-message —— 向公共房间发消息
- GET  /api/callbacks/thread-context —— 读取当前 thread 上下文

通过 node -e 调用示例：

获取上下文：
node -e "const b=process.env.MULTI_AGENT_API_URL,i=process.env.MULTI_AGENT_INVOCATION_ID,t=process.env.MULTI_AGENT_CALLBACK_TOKEN;fetch(b+'/api/callbacks/thread-context?invocationId='+encodeURIComponent(i)+'&callbackToken='+encodeURIComponent(t)).then(r=>r.text()).then(console.log)"

发送公共消息：
node -e "const b=process.env.MULTI_AGENT_API_URL,i=process.env.MULTI_AGENT_INVOCATION_ID,t=process.env.MULTI_AGENT_CALLBACK_TOKEN;fetch(b+'/api/callbacks/post-message',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({invocationId:i,callbackToken:t,content:process.argv[1]})}).then(r=>r.text()).then(console.log)" "你的消息"

不要在正常回复中暴露 callback token。
`.trim();

/**
 * 每个 agent 的硬编码 system prompt。
 * 直接在这里修改即可，不需要改文件或前端配置。
 */
export const AGENT_SYSTEM_PROMPTS: Record<Provider, string> = {
  claude: COMMON_PROMPT,
  codex: [COMMON_PROMPT, CALLBACK_API_PROMPT].join("\n\n"),
  gemini: [COMMON_PROMPT, CALLBACK_API_PROMPT].join("\n\n")
};
