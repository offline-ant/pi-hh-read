/**
 * change_file tool — create, overwrite, insert, replace, or delete lines in a file.
 *
 * Lines are referenced by their 2-char base-62 content hash (from hh_read output).
 * Before editing, hashes are resolved to line numbers and validated against the
 * current file content. If a hash is missing, the edit is rejected.
 *
 * Replace/delete ranges use [inclusive, exclusive) semantics: hash_start is the
 * first line affected, hash_stop is the first line AFTER the range (not included).
 *
 * All content is passed via positional args to avoid shell/sed injection issues.
 */

import type { ExtensionAPI, EditToolDetails, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { renderDiff, highlightCode, getLanguageFromPath } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import * as os from "node:os";
import * as path from "node:path";
import { readFile } from "node:fs/promises";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { lineHash, resolveHash } from "./hashline.js";

interface Params {
	path: string;
	hash_start?: string;
	hash_stop?: string;
	content?: string;
}

const schema = Type.Object({
	path: Type.String({ description: "Path to the file" }),
	hash_start: Type.Optional(
		Type.String({
			description:
				"Hash of the line to insert before, or start of range to replace/delete. " +
				"Use the 2-char hash from the read tool output (e.g. \"a3\"). Omit to create/overwrite the file.",
		}),
	),
	hash_stop: Type.Optional(
		Type.String({
			description:
				"Hash of the first line AFTER the range to replace/delete (exclusive end). " +
				"If omitted with hash_start, inserts before that line.",
		}),
	),
	content: Type.Optional(
		Type.String({ description: "Text to insert, replace with, or use as new file content" }),
	),
});
// Shell script for create/overwrite mode.


// $1 = file path, $2 = content
const CREATE_SCRIPT = `
set -e
mkdir -p "$(dirname "$1")"
printf '%s' "$2" > "$1"
`;

// Shell script for edit mode (insert, replace, delete).
// $1 = file, $2 = mode, $3 = content, $4 = start line, $5 = stop line (inclusive)
const EDIT_SCRIPT = [
	"set -e",
	'FILE="$1"; MODE="$2"; CONTENT="$3"; START="$4"; STOP="$5"',
	'TMP=$(mktemp); TMP2=$(mktemp); trap \'rm -f "$TMP" "$TMP2"\' EXIT',
	'cp "$FILE" "$TMP"',
	"",
	'if [ "$MODE" = "delete" ]; then',
	'  sed -i "${START},${STOP}d" "$FILE"',
	'elif [ "$MODE" = "insert" ]; then',
	'  head -n "$((START - 1))" "$FILE" > "$TMP2"',
	"  printf '%s' \"$CONTENT\" >> \"$TMP2\"",
	'  tail -n "+$START" "$FILE" >> "$TMP2"',
	'  cp "$TMP2" "$FILE"',
	"else",
	'  head -n "$((START - 1))" "$FILE" > "$TMP2"',
	"  printf '%s' \"$CONTENT\" >> \"$TMP2\"",
	'  tail -n "+$((STOP + 1))" "$FILE" >> "$TMP2"',
	'  cp "$TMP2" "$FILE"',
	"fi",
	"",
	'if cmp -s "$TMP" "$FILE"; then echo NO_CHANGES; exit 0; fi',
	'diff -U99999 "$TMP" "$FILE" || true',
].join("\n");

const EXEC_OPTS = { timeout: 10000 };

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "change_file",
		label: "Change File",
		description:
			"Create a new file or edit an existing one. " +
			"Lines are referenced by their 2-char content hash from the read tool output. " +
			"To create/overwrite: provide path and content (omit hash_start). " +
			"To insert: provide path, hash_start, and content (inserts before the hashed line). " +
			"When inserting, provide ONLY the new lines — do not include the existing line you're inserting before (it is preserved automatically). To add new code and rearrange existing code, use replace mode instead. " +
			"To replace: provide path, hash_start, hash_stop, and content. hash_stop is exclusive (first line AFTER the range). " +
			"To delete: provide path, hash_start (and optionally hash_stop), omit content. hash_stop is exclusive. " +
			"Hashes are unique per file — each hash maps to exactly one line (the first occurrence). " +
			"IMPORTANT: All hashes used in a single change_file call MUST come from the SAME read call. " +
			"Do NOT combine hashes from separate reads — hashes are only valid within the read that produced them. " +
			"If you need to change a large range, do one read that covers the entire range first.",
		parameters: schema,
		async execute(_id, params: Params, signal, _onUpdate, ctx) {
			const { path: filePath, hash_start, hash_stop } = params;
			let content = params.content;
			const execOpts = { ...EXEC_OPTS, signal, cwd: ctx.cwd };

			// --- Create / overwrite (no hashes) ---
			if (hash_start == null) {
				const text = content ?? "";
				const res = await pi.exec("bash", ["-c", CREATE_SCRIPT, "--", filePath, text], execOpts);
				if (res.code !== 0) throw new Error(res.stderr.trim() || "write failed");
				const lines = text ? text.split("\n").length : 0;
				return {
					content: [{ type: "text", text: `Created ${filePath} (${lines} lines).` }],
				};
			}

			// --- Resolve hashes to line numbers ---
			const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(ctx.cwd, filePath);
			const fileContent = await readFile(absPath, "utf-8");
			const fileLines = fileContent.split("\n");

			const warnings: string[] = [];

			// Warn if file is .gitignored (likely a build artifact)
			try {
				const gi = await pi.exec("git", ["check-ignore", "-q", absPath], { cwd: ctx.cwd, timeout: 3000 });
				if (gi.code === 0) {
					warnings.push(`Warning: ${filePath} is .gitignored — it's likely a build artifact generated from source.`);
				}
			} catch { /* not in a git repo or git unavailable */ }

			const lineStart = resolveHash(fileLines, hash_start);

			// hash_stop is exclusive: it points to the first line AFTER the range.
			// Convert to inclusive for the shell script.
			let lineStopInclusive: number | undefined;
			if (hash_stop != null) {
				const lineStopExclusive = resolveHash(fileLines, hash_stop);
				if (lineStopExclusive <= lineStart) {
					throw new Error(
						`hash_stop "${hash_stop}" resolves to line ${lineStopExclusive}, which is at or before ` +
						`hash_start "${hash_start}" at line ${lineStart}. hash_stop must be after hash_start.`
					);
				}
				lineStopInclusive = lineStopExclusive - 1;
			}

			// --- Edit (insert / replace / delete) ---
			const mode = !content ? "delete" : lineStopInclusive != null ? "replace" : "insert";
			const stop = String(lineStopInclusive ?? lineStart);
			// Drop duplicate trailing line if it matches the line being inserted before.
			// Models often echo the target line as context at the end of content,
			// possibly followed by a trailing newline. Compare actual text to avoid
			// hash collisions (1-in-3844 false positive).
			if (mode === "insert" && content) {
				const trimmed = content.replace(/\n*$/, "");
				const lastNl = trimmed.lastIndexOf("\n");
				const lastLine = lastNl === -1 ? trimmed : trimmed.slice(lastNl + 1);
				if (lastLine === fileLines[lineStart - 1]) {
					content = lastNl === -1 ? "" : trimmed.slice(0, lastNl);
				}
			}

			// Ensure content ends with a newline so printf '%s' produces complete lines
			const normalizedContent = content && !content.endsWith("\n") ? content + "\n" : (content ?? "");

			const res = await pi.exec(
				"bash",
				["-c", EDIT_SCRIPT, "--", filePath, mode, normalizedContent, String(lineStart), stop],
				execOpts,
			);
			if (res.code !== 0) throw new Error(res.stderr.trim() || "change_file failed");

			const out = res.stdout.trim();
			if (out === "NO_CHANGES") {
				return { content: [{ type: "text", text: `No changes made to ${filePath}.` }] };
			}

			const { diff, firstChangedLine } = formatUnifiedDiff(out);

			// Re-read file to get hashes of newly written lines
			let newRange = "";
			if (content && firstChangedLine != null) {
				const newFileContent = await readFile(absPath, "utf-8");
				const newFileLines = newFileContent.split("\n");
				const newLineCount = content.split("\n").length;
				const firstNew = firstChangedLine;
				const lastNew = firstNew + newLineCount - 1;
				if (firstNew >= 1 && lastNew <= newFileLines.length) {
					const firstHash = lineHash(newFileLines[firstNew - 1]);
					const lastHash = lineHash(newFileLines[lastNew - 1]);
					newRange = firstHash === lastHash
						? ` with ${firstHash}`
						: ` with ${firstHash}..${lastHash}`;
				}
			}

			const msg = buildMessage(mode, filePath, hash_start, hash_stop) + newRange;
			const fullMsg = warnings.length > 0 ? warnings.join("\n") + "\n" + msg : msg;
			return {
				content: [{ type: "text", text: fullMsg }],
				details: { diff, firstChangedLine } as EditToolDetails,
			};
		},

		renderCall(args: Params, theme: any) {
			let display = args.path?.startsWith(os.homedir())
				? `~${args.path.slice(os.homedir().length)}`
				: (args.path || "...");

			const range = args.hash_start
				? args.hash_stop
					? ` ${args.hash_start}..${args.hash_stop}`
					: ` ${args.hash_start}`
				: "";

			const mode = !args.hash_start ? "create"
				: !args.content ? "delete"
				: args.hash_stop ? "replace"
				: "insert";

			let text = theme.fg("toolTitle", theme.bold("change_file "))
				+ theme.fg("accent", display)
				+ range
				+ theme.fg("muted", ` [${mode}]`);

			// Show content preview when content is provided (like the built-in write tool)
			if (args.content) {
				const lang = args.path ? getLanguageFromPath(args.path) : undefined;
				const lines = lang ? highlightCode(args.content, lang) : args.content.split("\n");
				const totalLines = lines.length;
				const maxLines = 10;
				const displayLines = lines.slice(0, maxLines);
				const remaining = lines.length - maxLines;

				text += theme.fg("muted", ` (${totalLines} lines)`);
				text += "\n\n" + displayLines
					.map((line: string) => lang ? line.replace(/\t/g, "   ") : theme.fg("toolOutput", line.replace(/\t/g, "   ")))
					.join("\n");
				if (remaining > 0) {
					text += theme.fg("muted", `\n... (${remaining} more lines)`);
				}
			} else if (args.hash_start) {
				text += theme.fg("muted", " (delete)");
			}

			return new Text(text, 0, 0);
		},

		renderResult(result: AgentToolResult<EditToolDetails>, _opts: ToolRenderResultOptions, theme: any) {
			if (result.isError) {
				return new Text(
					theme.fg("error", result.content?.map((c: any) => c.text).join("\n") || "Error"),
					0,
					0,
				);
			}
			if (!result.details?.diff) {
				return new Text(
					theme.fg("toolOutput", result.content?.map((c: any) => c.text).join("\n") || ""),
					0,
					0,
				);
			}
			const diffText = renderDiff(result.details.diff);
			const summary = diffSummary(result.details.diff);
			const summaryText = summary ? "\n" + theme.fg("muted", summary) : "";
			return new Text(diffText + summaryText, 0, 0);
		},
	});
}

function buildMessage(
	mode: string, filePath: string,
	hashStart: string, hashStop: string | undefined,
): string {
	if (mode === "delete") {
		return hashStop != null && hashStop !== hashStart
			? `Deleted ${hashStart}..${hashStop} from ${filePath}.`
			: `Deleted ${hashStart} from ${filePath}.`;
	}
	if (mode === "replace") {
		return `Replaced ${hashStart}..${hashStop} in ${filePath}.`;
	}
	return `Inserted before ${hashStart} in ${filePath}.`;
}

/** Count +/- lines in the formatted diff to produce a compact summary. */
function diffSummary(diff: string): string {
	let added = 0, removed = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+")) added++;
		else if (line.startsWith("-")) removed++;
	}
	const parts: string[] = [];
	if (added > 0) parts.push(`${added} added`);
	if (removed > 0) parts.push(`${removed} removed`);
	return parts.length > 0 ? parts.join(", ") : "";
}

// --- Diff formatting: converts `diff -u` output into pi's edit-tool format ---

const CONTEXT = 4;

interface DiffResult {
	diff: string;
	firstChangedLine?: number;
}

function formatUnifiedDiff(udiff: string): DiffResult {
	const entries: { type: "r" | "a" | "c"; line: number; text: string }[] = [];
	let ol = 0, nl = 0, inHunk = false;

	for (const raw of udiff.split("\n")) {
		if (raw.startsWith("@@")) {
			const m = raw.match(/@@ -(\d+).* \+(\d+)/);
			if (m) { ol = +m[1]; nl = +m[2]; inHunk = true; }
			continue;
		}
		if (raw.startsWith("---") || raw.startsWith("+++") || !inHunk) continue;

		const ch = raw[0], txt = raw.slice(1);
		if (ch === "-")      entries.push({ type: "r", line: ol++, text: txt });
		else if (ch === "+") entries.push({ type: "a", line: nl++, text: txt });
		else                 { entries.push({ type: "c", line: ol, text: txt }); ol++; nl++; }
	}

	if (entries.length === 0) return { diff: "" };

	let mx = 0;
	for (const e of entries) if (e.line > mx) mx = e.line;
	const w = Math.max(3, String(mx).length);
	const pad = (n: number) => String(n).padStart(w);

	const near = new Set<number>();
	for (let i = 0; i < entries.length; i++) {
		if (entries[i].type !== "c") {
			for (let j = Math.max(0, i - CONTEXT); j <= Math.min(entries.length - 1, i + CONTEXT); j++) near.add(j);
		}
	}

	const out: string[] = [];
	let last = -1, firstChanged: number | undefined;

	for (let i = 0; i < entries.length; i++) {
		if (entries[i].type === "c" && !near.has(i)) continue;
		if (last >= 0 && i - last > 1) out.push(` ${" ".repeat(w)} ...`);

		const e = entries[i];
		if (e.type === "r") {
			if (firstChanged === undefined) firstChanged = e.line;
			out.push(`-${pad(e.line)} ${e.text}`);
		} else if (e.type === "a") {
			if (firstChanged === undefined) firstChanged = e.line;
			out.push(`+${pad(e.line)} ${e.text}`);
		} else {
			out.push(` ${pad(e.line)} ${e.text}`);
		}
		last = i;
	}

	return { diff: out.join("\n"), firstChangedLine: firstChanged };
}
