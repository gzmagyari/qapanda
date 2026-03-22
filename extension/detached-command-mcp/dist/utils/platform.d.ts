import type { ShellKind } from "../types.js";
export interface ShellLaunchSpec {
    shellKind: Exclude<ShellKind, "auto">;
    executable: string;
    args: string[];
}
export declare function normalizeEnv(input: NodeJS.ProcessEnv | Record<string, string | undefined>): Record<string, string>;
export declare function mergeEnv(extra?: Record<string, string>): Record<string, string>;
export declare function buildShellLaunchSpec(command: string, shell: ShellKind, shellExecutable?: string): ShellLaunchSpec;
export declare function isProcessAlive(pid: number | undefined): Promise<boolean>;
export declare function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean>;
export declare function killProcessTree(pid: number, force: boolean, waitMs: number): Promise<{
    requestedSignal: string;
    stillRunning: boolean;
}>;
