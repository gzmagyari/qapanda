#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { SERVER_NAME, SERVER_VERSION } from "./constants.js";
import { JobManager } from "./services/jobManager.js";
import { JobStore } from "./services/jobStore.js";
import { getJobSchema, listJobsSchema, readOutputSchema, sleepSchema, startCommandSchema, stopJobSchema } from "./schemas.js";
import { loadServerConfig } from "./utils/env.js";
import { UserError, toErrorMessage } from "./utils/errors.js";
import { formatJobList, formatJobSummary, formatOutputBlock } from "./utils/format.js";
import { sleep } from "./utils/fs.js";
const config = loadServerConfig();
const store = new JobStore(config);
const manager = new JobManager(config, store);
await manager.initialize();
const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
});
server.registerTool("get_server_info", {
    title: "Get detached command server info",
    description: "Return the current detached-command MCP server configuration, including the current instance ID used for default job scoping.",
    inputSchema: z.object({}).strict(),
    annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
    },
}, async () => {
    const structured = {
        server_name: SERVER_NAME,
        server_version: SERVER_VERSION,
        current_instance_id: config.currentInstanceId,
        current_instance_provided_by_env: config.currentInstanceProvidedByEnv,
        data_dir: config.dataDir,
        default_tail_lines: config.defaultTailLines,
        default_read_max_bytes: config.defaultReadMaxBytes,
        max_read_bytes: config.maxReadBytes,
    };
    const text = [
        `server_name: ${SERVER_NAME}`,
        `server_version: ${SERVER_VERSION}`,
        `current_instance_id: ${config.currentInstanceId}`,
        `instance_id_source: ${config.currentInstanceProvidedByEnv ? "environment variable" : "auto-generated for this MCP server process"}`,
        `data_dir: ${config.dataDir}`,
        `default_tail_lines: ${config.defaultTailLines}`,
        `default_read_max_bytes: ${config.defaultReadMaxBytes}`,
        `max_read_bytes: ${config.maxReadBytes}`,
    ].join("\n");
    return {
        content: [{ type: "text", text }],
        structuredContent: structured,
    };
});
server.registerTool("start_command", {
    title: "Start a fully detached command",
    description: "Run a command completely detached from Claude Code. The command is supervised by a detached runner that writes stdout, stderr, and combined logs to files that can be inspected later. Returns the job ID and, when available, the spawned PID.",
    inputSchema: startCommandSchema,
    annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
    },
}, async (params) => {
    const result = await manager.startCommand({
        command: params.command,
        cwd: params.cwd,
        env: params.env,
        name: params.name,
        shell: params.shell,
        shellExecutable: params.shell_executable,
        instanceId: params.instance_id,
        startupWaitMs: params.startup_wait_ms,
    });
    const structured = {
        current_instance_id: config.currentInstanceId,
        launch_state: result.launchState,
        job: result.job,
    };
    const text = [
        `current_instance_id: ${config.currentInstanceId}`,
        `launch_state: ${result.launchState}`,
        "",
        formatJobSummary(result.job),
    ].join("\n");
    return {
        content: [{ type: "text", text }],
        structuredContent: structured,
    };
});
server.registerTool("sleep", {
    title: "Wait before polling again",
    description: "Pause for a bounded amount of time, then return. Use this between get_job or read_output polling attempts to avoid hammering the detached-command MCP server.",
    inputSchema: sleepSchema,
    annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
    },
}, async (params) => {
    await sleep(params.duration_ms);
    const structured = {
        current_instance_id: config.currentInstanceId,
        duration_ms: params.duration_ms,
    };
    const text = [
        `current_instance_id: ${config.currentInstanceId}`,
        `duration_ms: ${params.duration_ms}`,
        "",
        `Slept for ${params.duration_ms}ms.`,
    ].join("\n");
    return {
        content: [{ type: "text", text }],
        structuredContent: structured,
    };
});
server.registerTool("list_jobs", {
    title: "List detached command jobs",
    description: "List jobs created through this MCP server. By default the scope is limited to jobs created by the current MCP server instance, which prevents collisions between multiple Claude Code sessions using the same shared data directory.",
    inputSchema: listJobsSchema,
    annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
    },
}, async (params) => {
    const scope = requireExplicitInstanceIdIfNeeded(params.scope, params.instance_id);
    const jobs = await manager.listJobs({
        scope,
        instanceId: params.instance_id,
        statusFilter: params.status_filter,
        limit: params.limit,
    });
    const structured = {
        current_instance_id: config.currentInstanceId,
        scope,
        instance_id: params.instance_id,
        status_filter: params.status_filter,
        count: jobs.length,
        jobs,
    };
    const text = [
        `current_instance_id: ${config.currentInstanceId}`,
        `scope: ${scope}`,
        `status_filter: ${params.status_filter}`,
        `count: ${jobs.length}`,
        "",
        formatJobList(jobs),
    ].join("\n");
    return {
        content: [{ type: "text", text }],
        structuredContent: structured,
    };
});
server.registerTool("get_job", {
    title: "Get detached command job details",
    description: "Return metadata, status, PIDs, and log sizes for a specific detached command job.",
    inputSchema: getJobSchema,
    annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
    },
}, async (params) => {
    const scope = requireExplicitInstanceIdIfNeeded(params.scope, params.instance_id);
    const job = await manager.getJob(params.job_id, scope, params.instance_id);
    const structured = {
        current_instance_id: config.currentInstanceId,
        job,
    };
    const text = [
        `current_instance_id: ${config.currentInstanceId}`,
        "",
        formatJobSummary(job),
    ].join("\n");
    return {
        content: [{ type: "text", text }],
        structuredContent: structured,
    };
});
server.registerTool("read_output", {
    title: "Read detached command output",
    description: "Read log output for a detached command job. Supports tailing, 1-indexed line ranges, reading from byte 0, or incremental reads from a byte offset.",
    inputSchema: readOutputSchema,
    annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
    },
}, async (params) => {
    const scope = requireExplicitInstanceIdIfNeeded(params.scope, params.instance_id);
    const maxBytes = Math.min(params.max_bytes ?? config.defaultReadMaxBytes, config.maxReadBytes);
    const result = await manager.readOutput({
        jobId: params.job_id,
        scope,
        instanceId: params.instance_id,
        stream: params.stream,
        mode: params.mode,
        tailLines: params.tail_lines,
        lineStart: params.line_start,
        lineEnd: params.line_end,
        byteStart: params.byte_start,
        maxBytes,
    });
    const structured = {
        current_instance_id: config.currentInstanceId,
        stream: result.stream,
        mode: result.mode,
        total_bytes: result.totalBytes,
        truncated: result.truncated,
        next_byte_offset: result.nextByteOffset,
        line_start: result.lineStart,
        line_end: result.lineEnd,
        line_count: result.lineCount,
        job: result.job,
        output: result.output,
    };
    const header = [
        `current_instance_id: ${config.currentInstanceId}`,
        `job_id: ${result.job.jobId}`,
        `status: ${result.job.status}`,
        `stream: ${result.stream}`,
        `mode: ${result.mode}`,
        `total_bytes: ${result.totalBytes}`,
        `truncated: ${result.truncated}`,
        result.nextByteOffset !== undefined ? `next_byte_offset: ${result.nextByteOffset}` : undefined,
        result.lineStart !== undefined ? `line_start: ${result.lineStart}` : undefined,
        result.lineEnd !== undefined ? `line_end: ${result.lineEnd}` : undefined,
        result.lineCount !== undefined ? `line_count: ${result.lineCount}` : undefined,
        `max_bytes_applied: ${maxBytes}`,
    ]
        .filter(Boolean)
        .join("\n");
    const text = `${header}\n\n${formatOutputBlock("output", result.output)}`;
    return {
        content: [{ type: "text", text }],
        structuredContent: structured,
    };
});
server.registerTool("stop_job", {
    title: "Stop a detached command job",
    description: "Stop a detached job by killing its tracked process tree. On Ubuntu/Linux this targets the process group. On Windows this uses taskkill /T and escalates to /F when needed.",
    inputSchema: stopJobSchema,
    annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
    },
}, async (params) => {
    const scope = requireExplicitInstanceIdIfNeeded(params.scope, params.instance_id);
    const result = await manager.stopJob({
        jobId: params.job_id,
        scope,
        instanceId: params.instance_id,
        force: params.force,
        waitMs: params.wait_ms,
        requestedBy: config.currentInstanceId,
    });
    const structured = {
        current_instance_id: config.currentInstanceId,
        requested_signal: result.requestedSignal,
        force: result.force,
        stop_issued: result.stopIssued,
        still_running_after_wait: result.stillRunningAfterWait,
        job: result.job,
    };
    const text = [
        `current_instance_id: ${config.currentInstanceId}`,
        `requested_signal: ${result.requestedSignal}`,
        `force: ${result.force}`,
        `stop_issued: ${result.stopIssued}`,
        `still_running_after_wait: ${result.stillRunningAfterWait}`,
        "",
        formatJobSummary(result.job),
    ].join("\n");
    return {
        content: [{ type: "text", text }],
        structuredContent: structured,
    };
});
const transport = new StdioServerTransport();
await server.connect(transport);
function requireExplicitInstanceIdIfNeeded(scope, instanceId) {
    if (scope === "explicit" && (!instanceId || instanceId.trim().length === 0)) {
        throw new UserError("instance_id is required when scope is 'explicit'");
    }
    return scope;
}
process.on("uncaughtException", (error) => {
    console.error(`Fatal server error: ${toErrorMessage(error)}`);
    process.exit(1);
});
process.on("unhandledRejection", (reason) => {
    console.error(`Fatal server rejection: ${toErrorMessage(reason)}`);
    process.exit(1);
});
//# sourceMappingURL=index.js.map
