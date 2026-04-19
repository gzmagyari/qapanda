#!/usr/bin/env node

const { main, forceTerminateCloudRunProcess } = require('../src/cli');
const isCloudRunCommand = process.argv[2] === 'cloud-run';

main(process.argv.slice(2)).catch((error) => {
  const message = error instanceof Error ? (error.stack || error.message) : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = (error && error.exitCode) || 1;
}).finally(() => {
  if (isCloudRunCommand) {
    forceTerminateCloudRunProcess(process.exitCode || 0);
  }
});
