import { spawn } from "node:child_process";
import { UserError } from "./errors.js";
export function normalizeEnv(input) {
    if (process.platform !== "win32") {
        const result = {};
        for (const [key, value] of Object.entries(input)) {
            if (typeof value === "string") {
                result[key] = value;
            }
        }
        return result;
    }
    const folded = new Map();
    for (const [key, value] of Object.entries(input)) {
        if (typeof value !== "string") {
            continue;
        }
        folded.set(key.toLowerCase(), { key, value });
    }
    const result = {};
    for (const entry of folded.values()) {
        result[entry.key] = entry.value;
    }
    return result;
}
export function mergeEnv(extra) {
    const merged = { ...normalizeEnv(process.env), ...(extra ?? {}) };
    return normalizeEnv(merged);
}
export function buildShellLaunchSpec(command, shell, shellExecutable) {
    const platform = process.platform;
    const resolvedShell = shell === "auto" ? defaultShellForPlatform(platform) : shell;
    switch (resolvedShell) {
        case "bash": {
            const executable = shellExecutable ?? (platform === "win32" ? "bash.exe" : "bash");
            return { shellKind: "bash", executable, args: ["-lc", command] };
        }
        case "sh": {
            if (platform === "win32") {
                throw new UserError("The 'sh' shell is not available by default on Windows. Use cmd, powershell, pwsh, or provide shell_executable.");
            }
            return { shellKind: "sh", executable: shellExecutable ?? "sh", args: ["-lc", command] };
        }
        case "powershell": {
            const executable = shellExecutable ?? (platform === "win32" ? "powershell.exe" : "pwsh");
            return {
                shellKind: "powershell",
                executable,
                args: platform === "win32"
                    ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command]
                    : ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
            };
        }
        case "pwsh": {
            const executable = shellExecutable ?? (platform === "win32" ? "pwsh.exe" : "pwsh");
            return {
                shellKind: "pwsh",
                executable,
                args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
            };
        }
        case "cmd": {
            if (platform !== "win32") {
                throw new UserError("The 'cmd' shell is only available on Windows.");
            }
            return { shellKind: "cmd", executable: shellExecutable ?? "cmd.exe", args: ["/d", "/s", "/c", command] };
        }
        default: {
            const exhaustiveCheck = resolvedShell;
            throw new UserError(`Unsupported shell: ${exhaustiveCheck}`);
        }
    }
}
function defaultShellForPlatform(platform) {
    if (platform === "win32") {
        return "powershell";
    }
    return "bash";
}
export async function isProcessAlive(pid) {
    if (!pid || !Number.isInteger(pid) || pid <= 0) {
        return false;
    }
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        const code = error.code;
        if (code === "EPERM") {
            return true;
        }
        return false;
    }
}
export async function waitForProcessExit(pid, timeoutMs) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        if (!(await isProcessAlive(pid))) {
            return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return !(await isProcessAlive(pid));
}
export async function killProcessTree(pid, force, waitMs) {
    if (process.platform === "win32") {
        return killProcessTreeWindows(pid, force, waitMs);
    }
    return killProcessTreePosix(pid, force, waitMs);
}
async function killProcessTreePosix(pid, force, waitMs) {
    const initialSignal = force ? "SIGKILL" : "SIGTERM";
    process.kill(-pid, initialSignal);
    const exited = await waitForProcessExit(pid, force ? 250 : waitMs);
    if (!exited && !force) {
        process.kill(-pid, "SIGKILL");
        const afterKill = await waitForProcessExit(pid, 2000);
        return { requestedSignal: "SIGTERM->SIGKILL", stillRunning: !afterKill };
    }
    return { requestedSignal: initialSignal, stillRunning: !exited };
}
async function killProcessTreeWindows(pid, force, waitMs) {
    const baseArgs = ["/PID", String(pid), "/T"];
    const gracefulArgs = [...baseArgs];
    const forceArgs = [...baseArgs, "/F"];
    const firstArgs = force ? forceArgs : gracefulArgs;
    await runWindowsTaskkill(firstArgs);
    const exited = await waitForProcessExit(pid, force ? 250 : waitMs);
    if (!exited && !force) {
        await runWindowsTaskkill(forceArgs);
        const afterForce = await waitForProcessExit(pid, 3000);
        return { requestedSignal: "taskkill /T -> taskkill /T /F", stillRunning: !afterForce };
    }
    return { requestedSignal: force ? "taskkill /T /F" : "taskkill /T", stillRunning: !exited };
}
async function runWindowsTaskkill(args) {
    await new Promise((resolve, reject) => {
        const child = spawn("taskkill", args, {
            stdio: "ignore",
            windowsHide: true,
        });
        child.once("error", reject);
        child.once("exit", (code) => {
            if (code === 0 || code === 128 || code === 255) {
                resolve();
                return;
            }
            reject(new Error(`taskkill exited with code ${code}`));
        });
    });
}
//# sourceMappingURL=platform.js.map