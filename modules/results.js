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
  await writeFile(join(folder, "replay.html"), replayHtml(run));
}

