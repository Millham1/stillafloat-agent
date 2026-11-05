/** A commentary post's own words, one paragraph per line (the newsletter's letter band splits on newlines). */
export function commentaryText(html: string): string {
  return String(html)
    .replace(/<\/(p|h[1-6]|li|blockquote)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&nbsp;/g, " ")
    .split("\n").map((l) => l.trim()).filter(Boolean).join("\n");
}
