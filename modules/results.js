import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const replayTemplate = await readFile(new URL("../replay.html", import.meta.url), "utf8");

// Save the report and replay.
const escapeHtml = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

export function markdownReport(report) {
  return (
    `# ${report.mission}\n\nOutcome: **${report.outcome}**\n\n${report.reason}\n\n` +
    `- Inferred location: [${report.inferredLocation}]\n- Location confidence: ${(100 * report.locationConfidence).toFixed(1)}%\n` +
    `- Status: ${report.inferredStatus} (${(100 * report.statusConfidence).toFixed(1)}%)\n- Actions: ${report.actions}\n` +
    `- Battery remaining: ${report.resources.batteryRemaining}/${report.resources.batteryCapacity}\n` +
    `- Time used: ${report.resources.timeUsed}/${report.resources.timeBudget}\n\n` +
    `## Recommended next step\n\n${report.recommendedNextStep}\n\n` +
    `Confidence is the model's posterior probability, not an independently calibrated success rate. Only direct contact confirms EVE's location and status.\n\n` +
    `## Evidence\n\n` +
    report.evidence
      .map((e) => `- ${e.type} at t=${e.timestamp}: \`${JSON.stringify(e)}\``)
      .join("\n") +
    "\n"
  );
}

export function replayHtml(run) {
  const values = {
    __TITLE__: escapeHtml(run.mission.name),
    __SEED__: run.mission.seed,
    __WIDTH__: run.mission.map.width,
    __HEIGHT__: run.mission.map.height,
    // Prevent text in a mission name from closing the JSON script tag.
    __RUN_DATA__: JSON.stringify(run).replaceAll("<", "\\u003c"),
  };
  return replayTemplate.replace(
    /__TITLE__|__SEED__|__WIDTH__|__HEIGHT__|__RUN_DATA__/g,
    (token) => values[token],
  );
}

export async function saveRun(run, folder) {
  await mkdir(folder, { recursive: true });
  // One JSON file holds the public settings, every action, and the final report.
  await writeFile(
    join(folder, "run.json"),
    JSON.stringify(run, null, 2) + "\n",
  );
  await writeFile(join(folder, "report.md"), markdownReport(run.report));
  await writeFile(join(folder, "replay.html"), replayHtml(run));
}

