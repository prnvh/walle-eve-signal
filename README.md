# WALL-E and EVE's Signal

WALL-E searches a grid for hidden EVE using noisy signals and clues. He chooses where to move and scan, updates his guesses, and keeps enough battery and time to reach a charger. This uses probability updates and shortest-path search, with no LLM or external dependencies.

## Run

Requires **Node.js 22+**. No installation step is needed.

```sh
npm start
npm run preview
```

Open **http://127.0.0.1:4173**. Stop the preview with Ctrl+C. The page replays a completed search; it does not control WALL-E. After changing a mission, run it again and restart the preview.

`npm start` creates `runs/run.json` (public settings, every action/observation/decision, and final report) and `runs/replay.html` (an offline replay you can open directly). Generated runs are ignored by Git. The preview also works before running anything, using `examples/run.json`.

## Files

```text
mission.js          Starts a mission or the preview
mission.json        Settings to edit
modules/
  world.js          Load settings, hide EVE, perform actions
  agent.js          Update guesses, choose actions, run the search
  helpers.js        Coordinates, sensor noise and shortest paths
  results.js        Save the results and build the replay
  preview.js        Show the replay in a browser
replay.html         Browser layout and controls
examples/run.json   One sample trace and final report
package.json        Node settings and command shortcuts
README.md           This guide
.gitignore          Excludes generated files
```

## How it works

`mission.js` calls three functions:

```js
const world = await loadMission(file);
const run = runMission(world);
await saveRun(run, folder);
```

Inside `runMission()`, WALL-E repeatedly **chooses an action → gets the world's response → updates his guesses**. The world knows EVE's location; the agent only receives public map information and observations. Private fields beginning with `#` keep the hidden answer inside the world.

Each reachable square has a probability of containing EVE. Signals and clues change those probabilities; visiting an empty square rules it out. The agent favors high-probability nearby squares using `probability / (stepsAway + 1)`. Breadth-first search finds routes around walls. Trips must leave enough battery and time to reach a charger. He scans periodically when affordable, returns/recharges when needed, and stops after direct contact or when no more search trips fit.

## Mission settings

Edit `mission.json`. Coordinates are `[x,y]`, starting at the top left.

- `map`: width/height (2–60) and obstacle coordinates. `start` must be a free cell with a charger; `chargers` lists charging locations.
- `target` and `targetStatus`: the world's hidden EVE position and `active`, `dormant`, or `damaged` status. Omit `target` for seeded placement.
- `clues`: hidden clue positions; omit for `clueCount` seeded clues (default 4, maximum 100).
- `seed`: integer 0–4294967295, making placement and sensor errors repeatable.
- `resources`: positive battery capacity, deadline, move/scan energy costs, move/scan time costs, and recharge time.
- `sensor`: positive `bearingSigma` (direction error in radians) and `rangeSigma` (distance error in grid units).
- `initialSignal`: optional origin, bearing, strength in (0,1], and timestamp relative to mission start. Negative timestamps indicate older, less precise readings. Estimated distance is `1 / strength - 1`.

Movement is one square up/down/left/right. Scans reveal noisy direction/distance and clues within distance 1.5. Recharge restores battery at a charger and costs time. EVE stays still; walls affect movement, not radio signals. Clue positions are learned only by scanning. Their coordinate hints are noisy; status hints are truthful in the simulator but treated as 80% reliable by the agent. JSON is supported, not YAML.

To run a different configuration: `node mission.js my-mission.json --out runs`.

## Sample result

`examples/run.json` has three sections: `mission` (public settings), `trace` (full action history and beliefs), and `report` (evidence, inferred location/status, confidence, resources, and recommended next step). The sample finds dormant EVE at `[12,2]` in **46 actions**, using **69/160 time**, with **9/25 battery** left.

Confidence describes the agent's guesses, not a guaranteed success rate. Only direct contact confirms EVE. This is a greedy planner, not an optimal solver or trained model. It assumes known walls/chargers and a static target; a 10,000-action limit bounds execution. Regression checks were run before trimming the deliverable; test scaffolding and CI are not included in this minimal version.
