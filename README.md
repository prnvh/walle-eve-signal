# WALL-E and EVE's Signal

A hide-and-seek simulation. EVE is hidden on a grid. WALL-E searches by himself, follows imperfect readings, finds clues, and keeps enough battery and time to reach a charger.

This is classical AI: rules, probability updates, and shortest-path search. No LLM, model training, dependencies, or API keys.

## Run

Requires **Node.js 22+**. There is nothing to install inside the project.

```sh
git clone https://github.com/prnvh/walle-eve-signal.git
cd walle-eve-signal
npm start
npm run preview
```

Open **http://127.0.0.1:4173**. Stop the preview with Ctrl+C. You can also open `runs/replay.html` directly without a server.

`npm start` performs a complete search and saves the results. The page **replays that completed search**. Play, the slider, step buttons and arrow keys let you inspect it; they do not control WALL-E. After editing a mission, run it again and restart the preview.

```sh
npm test                                  # Automatic checks
npm run demo                              # Refresh the checked-in example
node mission.js my-mission.json --out runs # Run your own mission
```

## The whole repo

```text
mission.js                 Entry point: reads options and starts a job
modules/
  world.js                 loadMission(): create the hidden world
  agent.js                 runMission(): run WALL-E's search
  results.js               saveRun(): write data, report and replay
  preview.js               startPreview(): serve the replay locally
  helpers.js               Shared coordinates, sensor math and paths
mission.json               The sample mission settings
replay.html                Page layout and replay controls
test.js                    Checks, including extra test missions
package.json               The npm command shortcuts
README.md                  This guide
.gitignore                 Keeps local generated runs out of Git
.github/workflows/test.yml  Tests on GitHub (Node 22 and 24)
examples/
  run.json                 Public settings + full trace + final report
  report.md                The report in readable text
  replay.html              Ready-to-open replay with results included
```

There are **16 tracked files**. `mission.js` is a short entry point; the five modules each have one clear job. Related functions stay together rather than creating a separate file for every small helper. The three example files are generated deliverables, not extra code to maintain. Local results go into the ignored `runs/` folder in the same format.

## How it works

Read `mission.json` first, then `mission.js`. Its main work is just:

```js
const world = await loadMission(file);
const run = runMission(world);
await saveRun(run, folder);
```

`loadMission()` reads JSON and builds the world. `runMission()` performs the search. `saveRun()` writes the results. The fourth main function, `startPreview()`, is called instead when you use `npm run preview`.

```text
Read settings -> create world and WALL-E
                         |
Choose action -> world performs it -> update guesses
       ^                                  |
       +------------- repeat -------------+
                         |
          Found EVE or cannot continue -> save results
```

The modules contain the details:

| Module | Job |
| --- | --- |
| `helpers.js` | Name squares, generate repeatable sensor errors, find shortest paths |
| `world.js` | Validate settings, hide EVE and clues, perform actions and charge costs |
| `agent.js` | Hold WALL-E's guesses, choose actions, and repeat the decide/act/learn loop |
| `results.js` | Write the data, report and replay |
| `preview.js` | Start a local server showing the saved replay |

The world and agent are separate objects in separate modules. The world knows where EVE is. The agent gets only public map information and observations. Fields beginning with `#` are private to the world, so the agent cannot read the hidden answer. A `class` groups data and functions; `this` means the particular world or agent being used.

The main agent methods are:

- **`updateSignal()`**: make squares more or less likely based on a reading.
- **`observe()`**: learn from readings, clues and contact. Rule out empty visited squares.
- **`decide()`**: scan or move while resources allow it, then return, recharge or stop.
- **`summary()`**: give the best location/status guess and confidence.

Each reachable square starts equally likely. A reading suggesting EVE is five squares to the right raises the chances of squares in that direction. `normalize()` makes all probabilities add up to 1 (100%). Log/exp calculations preserve very small probabilities instead of rounding them away.

The agent ranks candidates using `probability / (stepsAway + 1)`. It checks that both the outward trip **and a return to a charger** fit battery and time. Paths use breadth-first search: check the nearest squares first, then work outward. Scans refresh the signal after three actions when a candidate and the return reserve allow it.

## Change the mission

Edit `mission.json`. Coordinates are `[x,y]`, starting at the top left. X increases rightward; Y increases downward.

| Setting | Meaning |
| --- | --- |
| `map` | Width/height (2–60) and blocked squares in `obstacles` |
| `start`, `chargers` | Starting square and chargers; start must have a charger |
| `target`, `targetStatus` | Hidden EVE position and status: `active`, `dormant`, or `damaged` |
| `clues` | Hidden clue positions; scanning within distance 1.5 reveals them once |
| `seed` | Integer 0–4294967295; same settings and seed give the same run |
| `resources` | Battery capacity, deadline, move/scan energy costs, move/scan time costs, recharge time |
| `sensor` | `bearingSigma`: direction error in radians; `rangeSigma`: distance error in grid units |
| `initialSignal` | Origin, bearing in radians, strength in (0,1], timestamp relative to mission start |

All resource costs and sensor error settings must be positive. Omit `target` for a seeded reachable hiding place. Omit `clues` for `clueCount` generated clues (default 4, range 0–100). Omit `initialSignal` for a generated reading. Older readings have negative timestamps and are treated as less precise. Strength maps to distance as `1 / strength - 1`. JSON is supported; YAML is not.

Movement is one square up/down/left/right. Scans give noisy bearing/range readings and nearby clues. Recharging restores battery at a charger and consumes time. Direct contact confirms EVE after any action. Invalid/unaffordable actions fail without changing the world. Walls affect movement, not signals. Clue coordinate hints are noisy; status hints are truthful in the simulator but the agent conservatively treats them as 80% reliable.

## Results and checks

The example finds dormant EVE at `[12,2]` after **46 actions**, using **69/160 time**, with **9/25 battery** left. `examples/run.json` contains `mission` (public settings), `trace` (every action, observation, decision reason and probability map), and `report` (evidence, inferred location/status, confidence, resources and recommended next step).

`npm test` checks successful searches, recharging, hidden information, repeatability, invalid inputs/actions, status updates, disconnected maps, safe inconclusive searches, replay escaping, saved outputs, and the preview server. A 30-seed regression checks probability totals and battery/time reserves after every action. GitHub tests Node 22 and 24.

Confidence describes the agent's model, not a guaranteed success rate. Only contact confirms EVE. This is a greedy planner, not an optimal solver. The world is static with known walls and chargers; moving targets, decoys, learned models, multiple robots and physics are not implemented. A 10,000-action safety limit bounds execution. Full probability maps make large traces grow quickly.
