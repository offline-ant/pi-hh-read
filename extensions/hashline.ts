/**
 * Hashline — content-hashed line tags for read output and verified edits.
 *
 * When the model reads a file, every line gets a short tag: `<hash>|<content>`
 * where hash is a 2-char base-62 digest of the line content. Empty lines
 * show `  |`. Only the first occurrence of each hash is shown — subsequent
 * duplicate lines show `  |` so that every visible hash uniquely identifies
 * a line.
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
 * Tag lines with `<hash>|` prefixes, deduplicating from the start of the file.
 *
 * Scans `allLines` from the beginning to track which hashes have been claimed.
 * Only the first occurrence of each hash gets the `<hash>|` prefix; subsequent
 * duplicates (and empty lines) get `  |`.
 *
 * When `displayStart` / `displayEnd` are given, only that slice is returned
 * (but deduplication still considers all lines from index 0). This supports
 * offset-based reads where only a portion of the file is shown.
 */
export function tagLines(
	allLines: string[],
	displayStart: number = 0,
	displayEnd: number = allLines.length,
): string[] {
	const seen = new Set<string>();
	const result: string[] = [];

	for (let i = 0; i < allLines.length; i++) {
		const line = allLines[i];
		let tag = "  ";
		if (line.length > 0) {
			const h = lineHash(line);
			if (!seen.has(h)) {
				seen.add(h);
				if (i >= displayStart && i < displayEnd) {
					tag = h;
				}
			}
		}

		if (i >= displayStart && i < displayEnd) {
			result.push(`${tag}|${line}`);
		}
		if (i >= displayEnd) break;
	}

	return result;
}

/**
 * Resolve a hash to a 1-indexed line number in the given file lines.
 * Always searches from the beginning. Since tagLines deduplicates, each
 * visible hash maps to exactly one line (the first occurrence).
 */
export function resolveHash(
	fileLines: string[],
	hash: string,
): number {
	for (let i = 0; i < fileLines.length; i++) {
		if (fileLines[i].length > 0 && lineHash(fileLines[i]) === hash) {
			return i + 1;
		}
	}

	throw new Error(`Hash "${hash}" not found in file. The file may have changed — re-read before editing.`);
}
