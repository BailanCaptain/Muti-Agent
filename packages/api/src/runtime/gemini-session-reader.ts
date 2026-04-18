import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface GeminiThought {
  subject?: string;
  description?: string;
  timestamp?: string;
}

interface GeminiSessionMessage {
  type?: string;
  content?: string;
  thoughts?: GeminiThought[];
}

interface GeminiSessionFile {
  messages?: GeminiSessionMessage[];
}

export interface ReadOptions {
  home?: string;
  projectDir: string;
}

export async function readGeminiThoughtsFromSession(
  sessionId: string,
  opts: ReadOptions,
): Promise<GeminiThought[]> {
  const home = opts.home ?? homedir();
  const path = join(
    home,
    ".gemini",
    "tmp",
    opts.projectDir,
    "chats",
    `session-${sessionId}.json`,
  );

  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return [];
  }

  let parsed: GeminiSessionFile;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
  const geminiMessages = messages.filter((m) => m.type === "gemini");
  if (geminiMessages.length === 0) return [];

  const last = geminiMessages[geminiMessages.length - 1];
  const thoughts = Array.isArray(last.thoughts) ? last.thoughts : [];
  return thoughts.filter((t) => t && (t.subject || t.description));
}

export function formatGeminiThoughts(thoughts: GeminiThought[]): string {
  const rendered: string[] = [];
  let index = 0;
  for (const t of thoughts) {
    const subject = t.subject?.trim();
    const description = t.description?.trim();
    if (subject && description) {
      index += 1;
      rendered.push(`### ${index}. ${subject}\n\n${description}`);
    } else if (subject) {
      index += 1;
      rendered.push(`### ${index}. ${subject}`);
    } else if (description) {
      rendered.push(description);
    }
  }
  return rendered.join("\n\n");
}
