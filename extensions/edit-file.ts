/**
 * change_file tool — create, overwrite, insert, replace, or delete lines in a file.
 *
 * Lines are referenced by their 2-char base-62 content hash (from hh_read output).
 * Before editing, hashes are resolved to line numbers and validated against the
 * current file content. If a hash is missing or ambiguous, the edit is rejected.
 *
 * All content is passed via positional args to avoid shell/sed injection issues.
 */

import type { ExtensionAPI, EditToolDetails, ToolRenderResultOptions } from "@mariozechner/pi-coding-agent";
import { renderDiff } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import * as os from "node:os";
import * as path from "node:path";
import { readFile } from "node:fs/promises";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { lineHash, resolveHash } from "./hashline.js";

interface Params {
	path: string;
	hash_start?: string;
	hash_stop?: string;
	context?: string;
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
				"Hash of the last line in the range to replace/delete (inclusive). " +
				"If omitted with hash_start, inserts before that line.",
		}),
	),
	context: Type.Optional(
		Type.String({
			description:
				"A nearby unique hash to disambiguate when hash_start or hash_stop match multiple lines " +
				"(i.e. duplicate/identical lines). The closest match to this anchor is chosen.",
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
// $1 = file, $2 = mode, $3 = content, $4 = start line, $5 = stop line
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
			"To replace: provide path, hash_start, hash_stop, and content. " +
			"To delete: provide path, hash_start (and optionally hash_stop), omit content. " +
			"If a hash matches multiple lines (duplicates), provide context with a nearby unique hash to disambiguate.",
		parameters: schema,

		async execute(_id, params: Params, signal, _onUpdate, ctx) {
			const { path: filePath, hash_start, hash_stop, context: ctxHash, content } = params;
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

			const lineStart = resolveHash(fileLines, hash_start, ctxHash);
			const lineStop = hash_stop != null ? resolveHash(fileLines, hash_stop, ctxHash) : undefined;

			if (lineStop != null && lineStop < lineStart) {
				throw new Error(
					`hash_stop "${hash_stop}" resolves to line ${lineStop}, which is before ` +
					`hash_start "${hash_start}" at line ${lineStart}.`
				);
			}

			// --- Edit (insert / replace / delete) ---
			const mode = !content ? "delete" : lineStop != null ? "replace" : "insert";
			const stop = String(lineStop ?? lineStart);
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
			return {
				content: [{ type: "text", text: msg }],
				details: { diff, firstChangedLine } as EditToolDetails,
			};
		},

		renderCall(args: Params, theme: any) {
			const display = args.path?.startsWith(os.homedir())
				? `~${args.path.slice(os.homedir().length)}`
				: (args.path || "...");
			const range = args.hash_start
				? args.hash_stop
					? ` ${args.hash_start}..${args.hash_stop}`
					: ` ${args.hash_start}`
				: "";
			return new Text(
				theme.fg("toolTitle", theme.bold("change_file ")) + theme.fg("accent", display + range),
				0,
				0,
			);
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
			return new Text(renderDiff(result.details.diff), 0, 0);
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
