/**
 * Hashline — content-hashed line tags for read output and verified edits.
 *
 * When the model reads a file, every line gets a short tag: `<hash>|<content>`
 * where hash is a 2-char base-62 digest of the line content. When editing via
 * change_file, the model references lines by hash alone — we resolve to line
 * numbers internally and reject if the hash is missing.
 *
 * Ambiguous hashes (duplicate lines) can be disambiguated by providing a
 * nearby unique hash as context.
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
 */
export function tagLines(lines: string[]): string[] {
	return lines.map((line) => `${lineHash(line)}|${line}`);
}

/**
 * Resolve a hash to a 1-indexed line number in the given file lines.
 *
 * If the hash matches exactly one line, returns it.
 * If ambiguous and `contextHash` is provided, finds the unique context line
 * and returns the closest match to it.
 * Otherwise throws with a clear error.
 */
export function resolveHash(fileLines: string[], hash: string, contextHash?: string): number {
	const matches: number[] = [];
	for (let i = 0; i < fileLines.length; i++) {
		if (lineHash(fileLines[i]) === hash) {
			matches.push(i + 1); // 1-indexed
		}
	}

	if (matches.length === 0) {
		throw new Error(`Hash "${hash}" not found in file. The file may have changed — re-read before editing.`);
	}

	if (matches.length === 1) {
		return matches[0];
	}

	// Ambiguous — try context disambiguation
	if (!contextHash) {
		throw new Error(
			`Hash "${hash}" is ambiguous — matches lines ${matches.join(", ")}. ` +
			`Provide a nearby unique hash as context to disambiguate.`
		);
	}

	// Resolve context hash (must be unique)
	const ctxMatches: number[] = [];
	for (let i = 0; i < fileLines.length; i++) {
		if (lineHash(fileLines[i]) === contextHash) {
			ctxMatches.push(i + 1);
		}
	}

	if (ctxMatches.length === 0) {
		throw new Error(
			`Context hash "${contextHash}" not found in file. The file may have changed — re-read before editing.`
		);
	}
	if (ctxMatches.length > 1) {
		throw new Error(
			`Context hash "${contextHash}" is also ambiguous (lines ${ctxMatches.join(", ")}). ` +
			`Pick a unique hash near the target line as context.`
		);
	}

	const ctxLine = ctxMatches[0];

	// Find the match closest to the context line
	let best = matches[0];
	let bestDist = Math.abs(matches[0] - ctxLine);
	for (let i = 1; i < matches.length; i++) {
		const dist = Math.abs(matches[i] - ctxLine);
		if (dist < bestDist) {
			best = matches[i];
			bestDist = dist;
		}
	}

	return best;
}
