export function markdownToPlain(text: string): string {
  let out = String(text || "");
  out = out.replace(/```[a-zA-Z0-9_-]*\n/g, "");
  out = out.replace(/```/g, "");
  out = out.replace(/^#{1,6}\s*/gm, "");
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)");
  out = out.replace(/\*\*/g, "");
  out = out.replace(/__/g, "");
  out = out.replace(/`/g, "");
  out = out.replace(/^[ \t]*[-*][ \t]+/gm, "- ");
  out = out.replace(/\n{3,}/g, "\n\n");
  return `${out.trim()}\n`;
}

