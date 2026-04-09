import { readFileSync, existsSync } from "node:fs"
import path from "node:path"
import { parse as parseYaml } from "yaml"
import type { Provider } from "@multi-agent/shared"

// ── Types ────────────────────────────────────────────────────────────

export type SlashCommand = {
  name: string
  description: string
}

export type SkillMeta = {
  name: string
  description: string
  triggers: string[]
  notFor: string[]
  agents: Provider[]
  requiresMcp: string[]
  next: string[]
  sopStep: number | number[] | null
  slashCommands: SlashCommand[]
}

export type SopStage = {
  suggestedSkill: string | null
  hardRules: string[]
  pitfalls: string[]
}

export type SkillMatch = {
  skill: SkillMeta
  matchedTrigger: string
}

export type LintError = {
  ruleId: string
  skillName: string
  message: string
}

// ── SkillRegistry ────────────────────────────────────────────────────

const VALID_PROVIDERS: Provider[] = ["claude", "codex", "gemini"]

export class SkillRegistry {
  private readonly skills = new Map<string, SkillMeta>()
  private readonly sopNavigation = new Map<string, SopStage>()
  private readonly slashIndex = new Map<string, string>() // "/merge" → "merge-gate"

  loadManifest(manifestPath: string): void {
    const raw = readFileSync(manifestPath, "utf-8")
    const doc = parseYaml(raw) as {
      skills?: Record<string, RawSkillEntry>
      sop_navigation?: Record<string, RawSopEntry>
    }

    if (doc.skills) {
      for (const [name, entry] of Object.entries(doc.skills)) {
        const skill: SkillMeta = {
          name,
          description: entry.description ?? "",
          triggers: entry.triggers ?? [],
          notFor: entry.not_for ?? [],
          agents: (entry.agents ?? VALID_PROVIDERS) as Provider[],
          requiresMcp: entry.requires_mcp ?? [],
          next: entry.next ?? [],
          sopStep: entry.sop_step ?? null,
          slashCommands: (entry.slashCommands ?? []).map((cmd) => ({
            name: cmd.name,
            description: cmd.description ?? "",
          })),
        }
        this.skills.set(name, skill)

        for (const cmd of skill.slashCommands) {
          this.slashIndex.set(cmd.name.toLowerCase(), name)
        }
      }
    }

    if (doc.sop_navigation) {
      for (const [stage, entry] of Object.entries(doc.sop_navigation)) {
        this.sopNavigation.set(stage, {
          suggestedSkill: entry.suggested_skill ?? null,
          hardRules: entry.hard_rules ?? [],
          pitfalls: entry.pitfalls ?? [],
        })
      }
    }
  }

  match(content: string, provider?: Provider): SkillMatch[] {
    const lower = content.toLowerCase()
    const results: SkillMatch[] = []

    for (const skill of this.skills.values()) {
      if (provider && !skill.agents.includes(provider)) {
        continue
      }

      let matchedTrigger: string | null = null
      for (const trigger of skill.triggers) {
        if (lower.includes(trigger.toLowerCase())) {
          matchedTrigger = trigger
          break
        }
      }
      if (!matchedTrigger) continue

      const excluded = skill.notFor.some((nf) => lower.includes(nf.toLowerCase()))
      if (excluded) continue

      results.push({ skill, matchedTrigger })
    }

    return results
  }

  matchSlashCommand(content: string): SkillMeta | null {
    const trimmed = content.trim()
    if (!trimmed.startsWith("/")) return null

    // Extract command: first word starting with /
    const command = trimmed.split(/\s/)[0].toLowerCase()
    const skillName = this.slashIndex.get(command)
    if (!skillName) return null

    return this.skills.get(skillName) ?? null
  }

  getNext(skillName: string): string[] {
    return this.skills.get(skillName)?.next ?? []
  }

  getSopStage(stage: string): SopStage | null {
    return this.sopNavigation.get(stage) ?? null
  }

  getSkill(name: string): SkillMeta | null {
    return this.skills.get(name) ?? null
  }

  allSkills(): SkillMeta[] {
    return [...this.skills.values()]
  }

  allSopStages(): Array<[string, SopStage]> {
    return [...this.sopNavigation.entries()]
  }

  validate(skillsDir: string): LintError[] {
    const errors: LintError[] = []
    const allSlashNames = new Set<string>()

    for (const [name, skill] of this.skills) {
      // has-triggers
      if (!skill.triggers.length) {
        errors.push({ ruleId: "has-triggers", skillName: name, message: "triggers 为空" })
      }

      // has-description
      if (!skill.description.trim()) {
        errors.push({ ruleId: "has-description", skillName: name, message: "description 为空" })
      }

      // has-skill-md
      const skillMdPath = path.join(skillsDir, name, "SKILL.md")
      if (!existsSync(skillMdPath)) {
        errors.push({ ruleId: "has-skill-md", skillName: name, message: `${skillMdPath} 不存在` })
      }

      // next-exists
      for (const nextSkill of skill.next) {
        if (!this.skills.has(nextSkill)) {
          errors.push({ ruleId: "next-exists", skillName: name, message: `next 引用 "${nextSkill}" 不在 manifest 中` })
        }
      }

      // agents-valid
      for (const agent of skill.agents) {
        if (!VALID_PROVIDERS.includes(agent)) {
          errors.push({ ruleId: "agents-valid", skillName: name, message: `无效 agent: "${agent}"` })
        }
      }

      // slash-unique
      for (const cmd of skill.slashCommands) {
        const lower = cmd.name.toLowerCase()
        if (allSlashNames.has(lower)) {
          errors.push({ ruleId: "slash-unique", skillName: name, message: `重复 slash command: "${cmd.name}"` })
        }
        allSlashNames.add(lower)
      }
    }

    return errors
  }
}

// ── Raw YAML shapes ──────────────────────────────────────────────────

type RawSkillEntry = {
  description?: string
  triggers?: string[]
  not_for?: string[]
  agents?: string[]
  requires_mcp?: string[]
  next?: string[]
  sop_step?: number | number[] | null
  slashCommands?: Array<{ name: string; description?: string }>
}

type RawSopEntry = {
  suggested_skill?: string | null
  hard_rules?: string[]
  pitfalls?: string[]
}
