#!/usr/bin/env node
import { MemvidEncoder } from './encoder.js';
import { getDefaultConfig } from './config.js';

async function main() {
  const encoder = new MemvidEncoder(getDefaultConfig());
  const args = process.argv.slice(2);
  if (!args.length) {
    console.error('Usage: memvid-node "text" [output.mp4] [indexDir]');
    process.exit(1);
  }
  const text = args[0];
  const output = args[1] || 'output.mp4';
  const indexDir = args[2] || 'index';
  encoder.addText(text);
  await encoder.buildVideo(output);
  console.log(`Video written to ${output}`);
  console.log(`Index saved to ${indexDir}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
