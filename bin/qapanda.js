#!/usr/bin/env node

const { main } = require('../src/cli');

main(process.argv.slice(2)).catch((error) => {
  const message = error instanceof Error ? (error.stack || error.message) : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
