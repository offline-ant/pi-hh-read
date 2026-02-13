/**
 * Hashline — content-hashed line tags for read output and verified edits.
 *
 * When the model reads a file, every line gets a short tag: `<hash>|<content>`
 * where hash is a 2-char base-62 digest of the line content. Only the first
 * occurrence of each hash is shown — subsequent duplicates display `  |` and
 * cannot be referenced in edits. This eliminates ambiguity by construction.
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
 * Only the first occurrence of each hash is shown; duplicates get `  |`.
 *
 * @param lines - The lines to tag
 * @param seenHashes - Optional pre-populated set of hashes already seen
 *   (e.g. from earlier lines in the file before a range). Mutated in place.
 */
export function tagLines(lines: string[], seenHashes?: Set<string>): string[] {
	const seen = seenHashes ?? new Set<string>();
	return lines.map((line) => {
		const h = lineHash(line);
		if (seen.has(h)) return `  |${line}`;
		seen.add(h);
		return `${h}|${line}`;
	});
}

/**
 * Build a set of hashes seen in lines[0..count-1].
 * Used to pre-seed dedup for ranged reads.
 */
export function buildSeenHashes(lines: string[], count: number): Set<string> {
	const seen = new Set<string>();
	for (let i = 0; i < count && i < lines.length; i++) {
		seen.add(lineHash(lines[i]));
	}
	return seen;
}

/**
 * Resolve a hash to a 1-indexed line number in the given file lines.
 * Always returns the first occurrence. Since read only shows hashes for
 * first occurrences, each visible hash is unambiguous.
 */
export function resolveHash(fileLines: string[], hash: string): number {
	for (let i = 0; i < fileLines.length; i++) {
		if (lineHash(fileLines[i]) === hash) {
			return i + 1; // 1-indexed
		}
	}
	throw new Error(`Hash "${hash}" not found in file. The file may have changed — re-read before editing.`);
}
