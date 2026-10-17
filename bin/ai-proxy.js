#!/usr/bin/env node
import { main } from '../src/cli.js';

const { exitCode, proxy } = await main(process.argv.slice(2));
if (!proxy) {
  process.exitCode = exitCode;
} else {
  let stopping = false;
  const stop = async (signal) => {
    if (stopping) return;
    stopping = true;
    process.stderr.write(`\n${signal} empfangen, beende ai-proxy …\n`);
    const force = setTimeout(() => process.exit(1), 5000);
    force.unref();
    await proxy.close();
    process.exit(0);
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
}
