import type { NextDispatch, SkillRegistry } from "./registry.js"

export type SopAdvancement = {
  nextStage: string
  nextDispatch: NextDispatch | null
}

export class SopTracker {
  private readonly stages = new Map<string, string>()

  getStage(sessionGroupId: string): string | null {
    return this.stages.get(sessionGroupId) ?? null
  }

  setStage(sessionGroupId: string, stage: string): void {
    this.stages.set(sessionGroupId, stage)
  }

  /**
   * Advance to the next SOP stage based on the completed skill's `next` chain.
   * Returns the advancement (next stage + optional forced dispatch), or null
   * if no advancement occurred.
   */
  advance(
    sessionGroupId: string,
    completedSkill: string,
    registry: SkillRegistry,
  ): SopAdvancement | null {
    const nextSkills = registry.getNext(completedSkill)
    if (!nextSkills.length) return null

    const nextStage = nextSkills[0]
    this.stages.set(sessionGroupId, nextStage)
    return {
      nextStage,
      nextDispatch: registry.getNextDispatch(completedSkill),
    }
  }

  clear(sessionGroupId: string): void {
    this.stages.delete(sessionGroupId)
  }
}
