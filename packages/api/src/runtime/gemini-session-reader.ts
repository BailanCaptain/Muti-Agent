import type { Dirent } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
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
  sessionId?: string;
  messages?: GeminiSessionMessage[];
}

export interface ReadOptions {
  home?: string;
  projectDir: string;
  /** 读取候选上限，默认 50；防止 chats/ 历史文件堆积时扫爆 I/O。 */
  maxCandidates?: number;
}

interface Candidate {
  path: string;
  mtimeMs: number;
}

async function collectCandidates(chatsDir: string): Promise<Candidate[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(chatsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const out: Candidate[] = [];
  for (const ent of entries) {
    const entryPath = join(chatsDir, ent.name);
    if (ent.isFile() && ent.name.endsWith(".json")) {
      const st = await stat(entryPath).catch(() => null);
      if (st) out.push({ path: entryPath, mtimeMs: st.mtimeMs });
    } else if (ent.isDirectory()) {
      const sub = await readdir(entryPath).catch(() => [] as string[]);
      for (const name of sub) {
        if (!name.endsWith(".json")) continue;
        const p = join(entryPath, name);
        const st = await stat(p).catch(() => null);
        if (st) out.push({ path: p, mtimeMs: st.mtimeMs });
      }
    }
  }
  return out;
}

export async function readGeminiThoughtsFromSession(
  sessionId: string,
  opts: ReadOptions,
): Promise<GeminiThought[]> {
  const home = opts.home ?? homedir();
  const chatsDir = join(home, ".gemini", "tmp", opts.projectDir, "chats");
  const limit = opts.maxCandidates ?? 50;

  const candidates = await collectCandidates(chatsDir);
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const c of candidates.slice(0, limit)) {
    let raw: string;
    try {
      raw = await readFile(c.path, "utf8");
    } catch {
      continue;
    }
    let parsed: GeminiSessionFile;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (parsed.sessionId !== sessionId) continue;

    const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
    const geminiMessages = messages.filter((m) => m.type === "gemini");
    if (geminiMessages.length === 0) return [];

    const last = geminiMessages[geminiMessages.length - 1];
    const thoughts = Array.isArray(last.thoughts) ? last.thoughts : [];
    return thoughts.filter((t) => t && (t.subject || t.description));
  }
  return [];
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
