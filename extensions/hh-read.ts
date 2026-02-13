/**
 * hh_read — hashline-tagged read tool.
 *
 * Overrides the built-in `read` tool. For text files, every line is prefixed
 * with `<hash>|` where hash is a 2-char base-62 digest of the line content.
 * This gives the model stable, verifiable anchors for edits.
 *
 * Images pass through unchanged.
 */

import type { ExtensionAPI, ReadToolDetails } from "@mariozechner/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { constants } from "node:fs";
import { access as fsAccess, readFile as fsReadFile } from "node:fs/promises";
import * as path from "node:path";
import { tagLines } from "./hashline.js";

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg", ".bmp", ".ico"]);

const readSchema = Type.Object({
	path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
	offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
	change_file: Type.Optional(Type.Boolean({ description: "If true, tag lines with content hashes for use with change_file. Default: false" })),
});

function resolvePath(filePath: string, cwd: string): string {
	if (path.isAbsolute(filePath)) return filePath;
	return path.resolve(cwd, filePath);
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "read",
		label: "Read",
		description:
			`Read the contents of a file. Set change_file: true to tag lines with 2-char content hashes: \`<hash>|<content>\`. ` +
			`Use these hashes in change_file to reference lines for verified edits. ` +
			`Supports images (jpg, png, gif, webp). ` +
			`Output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB. Use offset/limit for large files.`,

		parameters: readSchema,

		async execute(_id, params, signal, _onUpdate, ctx) {
			const { path: filePath, offset, limit, change_file: withHashes } = params;
			const absolutePath = resolvePath(filePath, ctx.cwd);

			await fsAccess(absolutePath, constants.R_OK);

			if (signal?.aborted) throw new Error("Operation aborted");

			// Image files: read as binary, return as image content
			const ext = path.extname(absolutePath).toLowerCase();
			if (IMAGE_EXTS.has(ext)) {
				const buffer = await fsReadFile(absolutePath);
				const base64 = buffer.toString("base64");
				const mimeMap: Record<string, string> = {
					".jpg": "image/jpeg", ".jpeg": "image/jpeg",
					".png": "image/png", ".gif": "image/gif",
					".webp": "image/webp", ".svg": "image/svg+xml",
					".bmp": "image/bmp", ".ico": "image/x-icon",
				};
				const mimeType = mimeMap[ext] || "application/octet-stream";
				return {
					content: [
						{ type: "text" as const, text: `Read image file [${mimeType}]` },
						{ type: "image" as const, data: base64, mimeType },
					],
					details: undefined,
				};
			}

			// --- Text file ---
			const buffer = await fsReadFile(absolutePath);
			const textContent = buffer.toString("utf-8");
			const allLines = textContent.split("\n");
			const totalFileLines = allLines.length;

			const startLine = offset ? Math.max(0, offset - 1) : 0;
			const startLineDisplay = startLine + 1;

			if (startLine >= allLines.length) {
				throw new Error(`Offset ${offset} is beyond end of file (${allLines.length} lines total)`);
			}

			let selectedLines: string[];
			let userLimitedLines: number | undefined;
			if (limit !== undefined) {
				const endLine = Math.min(startLine + limit, allLines.length);
				selectedLines = allLines.slice(startLine, endLine);
				userLimitedLines = endLine - startLine;
			} else {
				selectedLines = allLines.slice(startLine);
			}

			// Tag lines with hashline prefixes only when change_file is true
			const output = withHashes ? tagLines(selectedLines) : selectedLines;
			const selectedContent = output.join("\n");

			// Apply truncation
			const truncation = truncateHead(selectedContent);

			let outputText: string;
			let details: ReadToolDetails | undefined;

			if (truncation.firstLineExceedsLimit) {
				const firstLineSize = formatSize(Buffer.byteLength(allLines[startLine], "utf-8"));
				outputText = `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLineDisplay}p' ${filePath} | head -c ${DEFAULT_MAX_BYTES}]`;
				details = { truncation };
			} else if (truncation.truncated) {
				const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
				const nextOffset = endLineDisplay + 1;
				outputText = truncation.content;
				if (truncation.truncatedBy === "lines") {
					outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.]`;
				} else {
					outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
				}
				details = { truncation };
			} else if (userLimitedLines !== undefined && startLine + userLimitedLines < allLines.length) {
				const remaining = allLines.length - (startLine + userLimitedLines);
				const nextOffset = startLine + userLimitedLines + 1;
				outputText = truncation.content;
				outputText += `\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
			} else {
				outputText = truncation.content;
			}

			return {
				content: [{ type: "text" as const, text: outputText }],
				details,
			};
		},

		// No custom renderCall/renderResult — uses the built-in read renderer
	});
}
