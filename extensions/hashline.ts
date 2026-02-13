/**
 * Hashline — content-hashed line tags for read output and verified edits.
 *
 * When the model reads a file, every line gets a short tag: `<hash>|<content>`
 * where hash is a 2-char base-62 digest of the line content. Empty lines
 * show `  |`. Duplicate hashes are shown — the `offset` parameter in
 * change_file controls which occurrence is targeted.
 */

// No-op extension export — this module is a utility library imported by
// hh-read.ts and edit-file.ts, but pi auto-discovers all .ts files in
// the extensions directory and tries to load them. This prevents a
// "does not export a valid factory function" error.
export default function () {}

const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/**
 * Compute a 2-char base-62 hash of a line's content.
 * Uses FNV-1a 32-bit, then maps to 2 base-62 digits (3844 values).
 */
export function lineHash(text: string): string {
	let h = 0x811c9dc5; // FNV offset basis
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193); // FNV prime
	}
	const n = (h >>> 0) % 3844; // 62 * 62
	return B62[Math.floor(n / 62)] + B62[n % 62];
}

/**
 * Tag an array of lines with `<hash>|` prefixes.
 * Empty lines get `  |`. All non-empty lines get their hash shown.
 */
export function tagLines(lines: string[]): string[] {
	return lines.map((line) => line.length === 0 ? "  |" : `${lineHash(line)}|${line}`);
}

/**
 * Resolve a hash to a 1-indexed line number in the given file lines.
 * Searches from `offset` (1-indexed, default 1). Returns the first match
 * at or after the offset. If no offset is given and multiple matches exist,
 * returns the first match but also sets `ambiguous` on the result.
 */
export function resolveHash(
	fileLines: string[],
	hash: string,
	offset?: number,
): { line: number; ambiguous: boolean } {
	const start = offset != null ? offset - 1 : 0;

	let firstMatch: number | undefined;
	let totalMatches = 0;

	for (let i = start; i < fileLines.length; i++) {
		if (fileLines[i].length > 0 && lineHash(fileLines[i]) === hash) {
			if (firstMatch === undefined) firstMatch = i + 1;
			totalMatches++;
		}
	}

	if (firstMatch === undefined) {
		throw new Error(`Hash "${hash}" not found in file${offset ? ` at or after line ${offset}` : ""}. The file may have changed — re-read before editing.`);
	}

	const ambiguous = offset == null && totalMatches > 1;
	return { line: firstMatch, ambiguous };
}
