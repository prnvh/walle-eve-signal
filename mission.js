import { loadMission } from "./modules/world.js";
import { runMission } from "./modules/agent.js";
import { saveRun } from "./modules/results.js";
import { startPreview } from "./modules/preview.js";

// This file only reads the command options and starts the right job.
async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log("Run: node mission.js [mission.json] [--out folder]");
    console.log("Preview: node mission.js --preview");
    return;
  }

  if (args.length === 1 && args[0] === "--preview") {
    await startPreview();
    console.log("Open http://127.0.0.1:4173");
    return;
  }

  let file = "mission.json";
  let folder = "runs";
  if (args.length > 0 && !args[0].startsWith("--")) file = args.shift();
  if (args.length > 0) {
    if (args.length !== 2 || args[0] !== "--out" || !args[1]) {
      throw new Error("Expected [mission.json] [--out folder]. See --help.");
    }
    folder = args[1];
  }

  // The whole search is these three calls.
  const world = await loadMission(file);
  const run = runMission(world);
  await saveRun(run, folder);

  console.log(run.report.outcome.toUpperCase() + ": " + run.report.reason);
  console.log(run.report.actions + " actions, " + run.report.resources.timeUsed + " time used.");
  console.log("Results: " + folder);
}

main().catch((error) => {
  console.error("Mission failed: " + error.message);
  process.exitCode = 1;
});
