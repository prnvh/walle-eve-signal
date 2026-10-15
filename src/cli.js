#!/usr/bin/env node
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { Environment } from './world.js';
import { runMission } from './agent.js';
import { markdownReport, replayHtml } from './output.js';

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: node src/cli.js <mission.json> [--out <directory>]'); return;
  }
  const file = args.shift();
  if (!file) throw new Error('Provide a mission JSON file. See --help.');
  let out = 'runs/latest';
  if (args.length) {
    if (args.length !== 2 || args[0] !== '--out' || !args[1]) throw new Error('Expected --out <directory>');
    out = args[1];
  }
  const config = JSON.parse(await readFile(file, 'utf8'));
  const run = runMission(new Environment(config));
  await mkdir(out, { recursive: true });
  await Promise.all([
    writeFile(join(out, 'mission.public.json'), JSON.stringify(run.mission, null, 2) + '\n'),
    writeFile(join(out, 'trace.jsonl'), run.trace.map(row => JSON.stringify(row)).join('\n') + (run.trace.length ? '\n' : '')),
    writeFile(join(out, 'report.json'), JSON.stringify(run.report, null, 2) + '\n'),
    writeFile(join(out, 'report.md'), markdownReport(run.report)),
    writeFile(join(out, 'replay.html'), replayHtml(run))
  ]);
  console.log(`${run.report.outcome.toUpperCase()}: ${run.report.reason}`);
  console.log(`${run.report.actions} actions · ${run.report.resources.timeUsed} time · ${run.report.resources.batteryRemaining} battery remaining`);
  console.log(`Report and replay: ${resolve(out)}`);
}
main().catch(error => { console.error(`Mission failed: ${error.message}`); process.exitCode = 1; });
