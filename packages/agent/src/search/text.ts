import type { Entry } from "../harness/session/types.ts";

function isTextBlock(part: unknown): part is { type: "text"; text: string } {
	return (
		typeof part === "object" &&
		part !== null &&
		(part as { type?: unknown }).type === "text" &&
		typeof (part as { text?: unknown }).text === "string"
	);
}

/**
 * Deterministic searchable text for one entry: message entries contribute their text blocks
 * joined with newlines (string content included; image/audio/tool/thinking payloads and
 * non-message entries contribute nothing). Empty results are never indexed.
 */
export function extractSearchableText(entry: Entry): string {
	if (entry.type !== "message") return "";
	// Custom agent messages may carry unknown content shapes; treat them as unsearchable.
	const content: unknown = (entry.message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(isTextBlock)
		.map((part) => part.text)
		.join("\n");
}
