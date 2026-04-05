export type Intent = "ideate" | "execute"

export function parseIntent(mentionCount: number): Intent {
  return mentionCount >= 2 ? "ideate" : "execute"
}
