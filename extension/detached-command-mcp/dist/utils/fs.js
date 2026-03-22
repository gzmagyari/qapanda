import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
export async function ensureDir(dirPath) {
    await fs.mkdir(dirPath, { recursive: true });
}
export async function pathExists(targetPath) {
    try {
        await fs.access(targetPath);
        return true;
    }
    catch {
        return false;
    }
}
export async function readJsonFile(filePath) {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
}
export async function writeJsonAtomic(filePath, value, indent = 2) {
    await ensureDir(path.dirname(filePath));
    const tempPath = `${filePath}.${randomUUID()}.tmp`;
    const payload = `${JSON.stringify(value, null, indent)}\n`;
    await fs.writeFile(tempPath, payload, "utf8");
    await fs.rename(tempPath, filePath);
}
export async function safeStatSize(filePath) {
    try {
        const stats = await fs.stat(filePath);
        return stats.size;
    }
    catch {
        return 0;
    }
}
export async function listSubdirectories(dirPath) {
    try {
        const entries = await fs.readdir(dirPath, { withFileTypes: true });
        return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    }
    catch {
        return [];
    }
}
export async function sleep(ms) {
    await new Promise((resolve) => setTimeout(resolve, ms));
}
//# sourceMappingURL=fs.js.map