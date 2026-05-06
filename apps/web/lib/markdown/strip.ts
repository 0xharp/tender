/**
 * Strip markdown formatting characters from text for snippet/preview
 * surfaces (RFP cards, decrypted-bid row previews, etc.). Renders as
 * a single flowing paragraph — no headings, no bullets, no bold/em
 * markers. Use this where the full text would be wrapped in
 * `line-clamp-N` or otherwise truncated; full markdown rendering only
 * makes sense on detail/expand views.
 *
 * Goals:
 *   - Idempotent: stripping plain text returns the same plain text.
 *   - Visible-text-preserving: "## Foo" → "Foo", "**bold**" → "bold",
 *     "[link](https://x)" → "link".
 *   - Safe for unknown input: never throws, never reflows aggressively.
 *   - No HTML — markdown source can't reach react-markdown's html
 *     pipeline (we don't enable rehype-raw), so even pathological
 *     input here is plain text.
 *
 * Not goals:
 *   - Perfect markdown parser. We use cheap regex passes; weird nested
 *     constructs may leak a stray punctuation mark. That's acceptable
 *     for previews — the full-render view is one click away.
 */

export function stripMarkdown(source: string): string {
  if (!source) return '';
  let out = source;

  // Fenced code blocks → keep just the body, drop the backticks.
  out = out.replace(/```[a-zA-Z0-9]*\n?([\s\S]*?)```/g, '$1');

  // Inline code: `foo` → foo
  out = out.replace(/`([^`]+)`/g, '$1');

  // Links: [text](url) → text. Image alts handled the same way.
  out = out.replace(/!?\[([^\]]+)\]\([^)]+\)/g, '$1');

  // Reference-style links: [text][ref] → text. Matching footnote
  // definitions get dropped on the blank-line collapse below.
  out = out.replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1');

  // ATX headings: leading "## " (any depth) → strip.
  out = out.replace(/^#{1,6}\s+/gm, '');

  // Setext underlines (=== or ---) → drop the underline line entirely.
  out = out.replace(/^[=-]{3,}\s*$/gm, '');

  // Blockquote markers: leading "> " → strip.
  out = out.replace(/^>\s?/gm, '');

  // List markers: leading "- ", "* ", "+ ", or "1. " → strip.
  out = out.replace(/^\s*([-*+]|\d+\.)\s+/gm, '');

  // Bold/italic markers — handle the longer (** or __) variants first
  // so the single-char pass below doesn't eat half of them.
  out = out.replace(/\*\*([^*]+)\*\*/g, '$1');
  out = out.replace(/__([^_]+)__/g, '$1');
  out = out.replace(/\*([^*]+)\*/g, '$1');
  out = out.replace(/_([^_]+)_/g, '$1');

  // Strikethrough (gfm): ~~text~~ → text
  out = out.replace(/~~([^~]+)~~/g, '$1');

  // Horizontal rule lines → drop.
  out = out.replace(/^[-*_]{3,}\s*$/gm, '');

  // Collapse runs of blank lines/whitespace to single space — snippet
  // surfaces want flowing prose, not preserved structure.
  out = out.replace(/\s+/g, ' ').trim();

  return out;
}
