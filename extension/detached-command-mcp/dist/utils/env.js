import { DEFAULT_DATA_DIR, DEFAULT_MAX_COMMAND_LENGTH, DEFAULT_MAX_LIST_RESULTS, DEFAULT_MAX_READ_BYTES, DEFAULT_READ_MAX_BYTES, DEFAULT_STARTUP_WAIT_MS, DEFAULT_STOP_WAIT_MS, DEFAULT_TAIL_LINES, ENV_DATA_DIR, ENV_DEFAULT_READ_MAX_BYTES, ENV_DEFAULT_STOP_WAIT_MS, ENV_DEFAULT_TAIL_LINES, ENV_INSTANCE_ID, ENV_MAX_COMMAND_LENGTH, ENV_MAX_LIST_RESULTS, ENV_MAX_READ_BYTES, ENV_STARTUP_WAIT_MS, } from "../constants.js";
import { randomUUID } from "node:crypto";
import path from "node:path";
function readPositiveInt(envName, fallback) {
    const raw = process.env[envName];
    if (!raw) {
        return fallback;
    }
    const value = Number.parseInt(raw, 10);
    if (!Number.isFinite(value) || value <= 0) {
        return fallback;
    }
    return value;
}
export function loadServerConfig() {
    const dataDir = path.resolve(process.env[ENV_DATA_DIR] ?? DEFAULT_DATA_DIR);
    const envInstanceId = process.env[ENV_INSTANCE_ID]?.trim();
    const currentInstanceId = envInstanceId && envInstanceId.length > 0 ? envInstanceId : `instance-${randomUUID()}`;
    const defaultReadMaxBytes = readPositiveInt(ENV_DEFAULT_READ_MAX_BYTES, DEFAULT_READ_MAX_BYTES);
    const maxReadBytes = Math.max(readPositiveInt(ENV_MAX_READ_BYTES, DEFAULT_MAX_READ_BYTES), defaultReadMaxBytes);
    return {
        dataDir,
        currentInstanceId,
        currentInstanceProvidedByEnv: Boolean(envInstanceId),
        startupWaitMs: readPositiveInt(ENV_STARTUP_WAIT_MS, DEFAULT_STARTUP_WAIT_MS),
        defaultTailLines: readPositiveInt(ENV_DEFAULT_TAIL_LINES, DEFAULT_TAIL_LINES),
        defaultReadMaxBytes,
        maxReadBytes,
        maxListResults: readPositiveInt(ENV_MAX_LIST_RESULTS, DEFAULT_MAX_LIST_RESULTS),
        defaultStopWaitMs: readPositiveInt(ENV_DEFAULT_STOP_WAIT_MS, DEFAULT_STOP_WAIT_MS),
        maxCommandLength: readPositiveInt(ENV_MAX_COMMAND_LENGTH, DEFAULT_MAX_COMMAND_LENGTH),
    };
}
//# sourceMappingURL=env.js.map