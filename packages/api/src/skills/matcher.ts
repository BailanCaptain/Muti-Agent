import type { LoadedSkill } from "./loader";

export type SkillIntent = "default" | "review" | "handoff";

function normalizeIntentFromMessage(message: string): SkillIntent {
  const text = message.toLowerCase();

  if (/(review|code review|reviewer|审查|评审|复核|blocking issue|looks good)/i.test(text)) {
    return "review";
  }

  if (/(handoff|hand off|交接|移交|接力|next step|risk|why)/i.test(text)) {
    return "handoff";
  }

  return "default";
}

export function matchSkills(options: {
  message: string;
  skills: LoadedSkill[];
  intent?: SkillIntent;
}) {
  const intent = options.intent && options.intent !== "default" ? options.intent : normalizeIntentFromMessage(options.message);
  const byName = new Map(options.skills.map((skill) => [skill.name, skill]));
  const selected: LoadedSkill[] = [];

  if (intent === "review") {
    const review = byName.get("review");
    if (review) {
      selected.push(review);
    }
  }

  if (intent === "handoff") {
    const handoff = byName.get("handoff");
    if (handoff) {
      selected.push(handoff);
    }
  }

  return selected;
}
