import fs from "node:fs";
import path from "node:path";
import { matchSkills, type SkillIntent } from "./matcher";

export type LoadedSkill = {
  name: string;
  content: string;
};

const TASK_SKILLS = ["review.md", "handoff.md"] as const;
const SYSTEM_PROMPT_FILES = ["room-charter.md"] as const;

function readMarkdownFile(dir: string, fileName: string): LoadedSkill | null {
  const filePath = path.join(dir, fileName);

  try {
    return {
      name: fileName.replace(/\.md$/i, ""),
      content: fs.readFileSync(filePath, "utf8")
    };
  } catch {
    return null;
  }
}

export function loadSkillFile(skillsDir: string, fileName: string) {
  return readMarkdownFile(skillsDir, fileName);
}

export function loadSkillsForTask(options: {
  skillsDir?: string;
  message: string;
  intent?: SkillIntent;
}) {
  const skillsDir = options.skillsDir ?? path.resolve(process.cwd(), "multi-agent-skills");
  const loaded = TASK_SKILLS.map((fileName) => readMarkdownFile(skillsDir, fileName)).filter(
    (skill): skill is LoadedSkill => Boolean(skill)
  );

  return matchSkills({
    message: options.message,
    intent: options.intent,
    skills: loaded
  });
}

export function formatSkillsForPrompt(skills: LoadedSkill[]) {
  if (!skills.length) {
    return "";
  }

  return ["以下是本轮任务额外规则：", ...skills.map((skill) => [`[${skill.name}]`, skill.content.trim()].join("\n"))].join(
    "\n\n"
  );
}

export function buildSystemPrompt(agentId: string, systemDir?: string) {
  const resolvedDir = systemDir ?? path.resolve(process.cwd(), "multi-agent-skills", "system");
  const loaded = SYSTEM_PROMPT_FILES.map((fileName) => readMarkdownFile(resolvedDir, fileName)).filter(
    (skill): skill is LoadedSkill => Boolean(skill)
  );

  // system prompt 是“长期规则”，和 review / handoff 这种按需加载的 task skill 不同。
  const agentLine = `当前 agent 标识：${agentId}。你运行在一个多 agent 协作房间里，每次 invocation 都有独立身份。`;
  const body = loaded.map((skill) => skill.content.trim()).join("\n\n");

  return [agentLine, body].filter(Boolean).join("\n\n");
}
