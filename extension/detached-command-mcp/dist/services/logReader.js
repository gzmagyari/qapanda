import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import readline from "node:readline";
import { LOG_TAIL_CHUNK_BYTES } from "../constants.js";
function trimToMaxBytesFromEnd(text, maxBytes) {
    const raw = Buffer.from(text, "utf8");
    if (raw.byteLength <= maxBytes) {
        return { text, truncated: false };
    }
    const trimmed = raw.subarray(raw.byteLength - maxBytes).toString("utf8");
    return { text: trimmed, truncated: true };
}
function trimToMaxBytesFromStart(text, maxBytes) {
    const raw = Buffer.from(text, "utf8");
    if (raw.byteLength <= maxBytes) {
        return { text, truncated: false };
    }
    const trimmed = raw.subarray(0, maxBytes).toString("utf8");
    return { text: trimmed, truncated: true };
}
export async function readByteChunk(filePath, byteStart, maxBytes) {
    const stats = await fs.stat(filePath).catch(() => undefined);
    const totalBytes = stats?.size ?? 0;
    const safeStart = Math.max(0, Math.min(byteStart, totalBytes));
    const endExclusive = Math.max(safeStart, Math.min(safeStart + maxBytes, totalBytes));
    const length = Math.max(0, endExclusive - safeStart);
    if (length === 0) {
        return {
            text: "",
            byteStart: safeStart,
            byteEnd: safeStart,
            nextByteOffset: safeStart,
            totalBytes,
            truncated: false,
        };
    }
    const handle = await fs.open(filePath, "r");
    try {
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, safeStart);
        return {
            text: buffer.toString("utf8"),
            byteStart: safeStart,
            byteEnd: safeStart + length,
            nextByteOffset: safeStart + length,
            totalBytes,
            truncated: safeStart + length < totalBytes,
        };
    }
    finally {
        await handle.close();
    }
}
export async function readFull(filePath, maxBytes) {
    return readByteChunk(filePath, 0, maxBytes);
}
export async function readTailLines(filePath, lineCount, maxBytes) {
    const stats = await fs.stat(filePath).catch(() => undefined);
    if (!stats || stats.size === 0 || lineCount <= 0) {
        return { text: "", lineCount: 0, truncated: false };
    }
    const handle = await fs.open(filePath, "r");
    try {
        let position = stats.size;
        let bufferText = "";
        let newlineCount = 0;
        while (position > 0 && newlineCount <= lineCount) {
            const chunkSize = Math.min(LOG_TAIL_CHUNK_BYTES, position);
            position -= chunkSize;
            const buffer = Buffer.alloc(chunkSize);
            await handle.read(buffer, 0, chunkSize, position);
            const chunkText = buffer.toString("utf8");
            bufferText = chunkText + bufferText;
            newlineCount = (bufferText.match(/\n/g) ?? []).length;
        }
        const normalized = bufferText.endsWith("\n") ? bufferText.slice(0, -1) : bufferText;
        const lines = normalized.length === 0 ? [] : normalized.split(/\r?\n/);
        const selected = lines.slice(Math.max(0, lines.length - lineCount));
        const combined = selected.join("\n");
        const trimmed = trimToMaxBytesFromEnd(combined, maxBytes);
        return {
            text: trimmed.text,
            lineCount: selected.length,
            truncated: trimmed.truncated || lines.length > selected.length,
        };
    }
    finally {
        await handle.close();
    }
}
export async function readLineRange(filePath, startLine, endLine, maxBytes) {
    if (startLine <= 0) {
        throw new Error("line_start must be 1 or greater");
    }
    let currentLine = 0;
    let firstIncludedLine = 0;
    let lastIncludedLine = 0;
    let truncated = false;
    const chunks = [];
    let bytesSoFar = 0;
    const stream = createReadStream(filePath, { encoding: "utf8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    try {
        for await (const line of rl) {
            currentLine += 1;
            if (currentLine < startLine) {
                continue;
            }
            if (endLine !== undefined && currentLine > endLine) {
                break;
            }
            const lineWithNewline = `${line}\n`;
            const lineBytes = Buffer.byteLength(lineWithNewline, "utf8");
            if (bytesSoFar + lineBytes > maxBytes) {
                truncated = true;
                break;
            }
            if (firstIncludedLine === 0) {
                firstIncludedLine = currentLine;
            }
            lastIncludedLine = currentLine;
            chunks.push(lineWithNewline);
            bytesSoFar += lineBytes;
        }
    }
    finally {
        rl.close();
        stream.destroy();
    }
    const text = chunks.join("").replace(/\n$/, "");
    const trimmed = trimToMaxBytesFromStart(text, maxBytes);
    return {
        text: trimmed.text,
        startLine: firstIncludedLine || startLine,
        endLine: lastIncludedLine || startLine,
        lineCount: lastIncludedLine >= firstIncludedLine && firstIncludedLine > 0 ? lastIncludedLine - firstIncludedLine + 1 : 0,
        truncated: truncated || trimmed.truncated,
    };
}
//# sourceMappingURL=logReader.js.map