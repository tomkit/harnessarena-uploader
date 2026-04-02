import { basename } from "node:path";

export function basenameOnly(path: string | null | undefined): string | null {
  if (path == null) return null;
  const name = basename(path.replace(/[/\\]+$/, ""));
  return name || null;
}

/**
 * Decode a Claude Code project directory name to the project basename.
 * e.g. "-Users-tomkit-Projects-angry-bird-clone" → "angry-bird-clone"
 */
export function decodeClaudeProjectDir(encodedName: string): string | null {
  const result = decodeClaudeProjectDirFull(encodedName);
  return result?.slug ?? null;
}

export function decodeClaudeProjectDirFull(encodedName: string): { slug: string; realPath: string } | null {
  const knownParents = [
    "-Projects-", "-Downloads-", "-Documents-", "-Desktop-",
    "-repos-", "-src-", "-code-", "-workspace-", "-work-",
  ];
  for (const parent of knownParents) {
    const idx = encodedName.lastIndexOf(parent);
    if (idx >= 0) {
      const slug = encodedName.slice(idx + parent.length);
      // Prefix up to and including the parent dir, decode slashes
      const prefix = encodedName.slice(0, idx + parent.length - 1); // exclude trailing -
      const realPrefix = prefix.replace(/^-/, "/").replace(/-/g, "/");
      return { slug, realPath: realPrefix + "/" + slug };
    }
  }
  const parts = encodedName.replace(/^-+/, "").split("-");
  const slug = parts.at(-1) || null;
  if (!slug) return null;
  return { slug, realPath: encodedName.replace(/^-/, "/").replace(/-/g, "/") };
}
