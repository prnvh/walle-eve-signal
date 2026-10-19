// WALL-E's search, in reading order: helpers, world, agent, run loop, files.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";

const replayTemplate = await readFile(
  new URL("./replay.html", import.meta.url),
  "utf8",
);

// 1. Small helpers: coordinates, repeatable randomness and shortest paths.
// A Map is a lookup table. We use a string like "3,2" as each square's name.
export function key(position) {
  return position[0] + "," + position[1];
}

function positionFromKey(cell) {
  return cell.split(",").map(Number);
}

function distance(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function angle(a, b) {
  return Math.atan2(b[1] - a[1], b[0] - a[0]);
}

function angleDiff(a, b) {
  return Math.atan2(Math.sin(a - b), Math.cos(a - b));
}

// Copy data so the agent cannot accidentally change the world's settings.
function clone(value) {
  return structuredClone(value);
}

export function random(seed) {
  // This standard seeded generator gives the same numbers for the same seed.
  // The bit operations are only for repeatable randomness, not agent decisions.
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function normal(rng) {
  // Turn two random numbers into a bell-shaped sensor error.
  return (
    Math.sqrt(-2 * Math.log(Math.max(rng(), 1e-12))) *
    Math.cos(2 * Math.PI * rng())
  );
}

export function cells(map) {
  const blocked = new Set(map.obstacles.map(key));
  const result = [];
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++)
      if (!blocked.has(key([x, y]))) result.push([x, y]);
  }
  return result;
}

export function paths(map, start) {
  // Breadth-first search: check nearby squares first, then squares farther away.
  // Each stored path contains the steps to take, without the starting square.
  const valid = new Set(cells(map).map(key));
  const result = new Map([[key(start), []]]);
  const queue = [start];
  for (let i = 0; i < queue.length; i++) {
    const current = queue[i];
    for (const [dx, dy] of [
      [1, 0],
      [0, 1],
      [-1, 0],
      [0, -1],
    ]) {
      const next = [current[0] + dx, current[1] + dy];
      if (valid.has(key(next)) && !result.has(key(next))) {
        result.set(key(next), [...result.get(key(current)), next]);
        queue.push(next);
      }
    }
  }
  return result;
}

// 2. The world: validate settings, hide EVE, and carry out actions.
export function validate(config) {
  const fail = (message) => {
    throw new Error(`Invalid mission: ${message}`);
  };
  if (!config || typeof config !== "object") fail("expected an object");
  const { map, resources, sensor } = config;
  if (
    !map ||
    !Number.isInteger(map.width) ||
    !Number.isInteger(map.height) ||
    map.width < 2 ||
    map.height < 2 ||
    map.width > 60 ||
    map.height > 60
  )
    fail("map dimensions must be integers from 2 to 60");
  if (!Array.isArray(map.obstacles)) fail("map.obstacles must be an array");
  const coordinate = (p) =>
    Array.isArray(p) &&
    p.length === 2 &&
    p.every(Number.isInteger) &&
    p[0] >= 0 &&
    p[1] >= 0 &&
    p[0] < map.width &&
    p[1] < map.height;
  if (!map.obstacles.every(coordinate)) fail("obstacle outside map");
  const free = (p) =>
    coordinate(p) && !map.obstacles.some((b) => key(b) === key(p));
  if (!free(config.start)) fail("start must be a free cell");
  if (
    !Array.isArray(config.chargers) ||
    !config.chargers.length ||
    !config.chargers.every(free)
  )
    fail("chargers must be free cells");
  if (!config.chargers.some((p) => key(p) === key(config.start)))
    fail("start must have a charger");
  if (
    !Number.isInteger(config.seed) ||
    config.seed < 0 ||
    config.seed > 4294967295
  )
    fail("seed must be a uint32");
  for (const field of [
    "battery",
    "time",
    "moveCost",
    "scanCost",
    "moveTime",
    "scanTime",
    "rechargeTime",
  ]) {
    if (
      !resources ||
      !Number.isFinite(resources[field]) ||
      resources[field] <= 0
    )
      fail(`resources.${field} must be positive`);
  }
  for (const field of ["bearingSigma", "rangeSigma"]) {
    if (!sensor || !Number.isFinite(sensor[field]) || sensor[field] <= 0)
      fail(`sensor.${field} must be positive`);
  }
  const reachable = paths(map, config.start);
  if (config.target !== undefined && !free(config.target))
    fail("target must be a free cell");
  if (config.target && !reachable.has(key(config.target)))
    fail("target must be reachable");
  if (!["active", "dormant", "damaged"].includes(config.targetStatus))
    fail("targetStatus must be active, dormant or damaged");
  if (
    config.clues !== undefined &&
    (!Array.isArray(config.clues) || !config.clues.every(free))
  )
    fail("clues must be free cells");
  if (
    config.clueCount !== undefined &&
    (!Number.isInteger(config.clueCount) ||
      config.clueCount < 0 ||
      config.clueCount > 100)
  )
    fail("clueCount must be 0 to 100");
  if (config.initialSignal !== undefined) {
    const sig = config.initialSignal;
    if (
      !sig ||
      !free(sig.origin) ||
      !Number.isFinite(sig.bearing) ||
      !Number.isFinite(sig.strength) ||
      sig.strength <= 0 ||
      sig.strength > 1 ||
      !Number.isFinite(sig.timestamp) ||
      sig.timestamp > 0
    )
      fail(
        "initialSignal needs free origin, finite bearing, strength in (0,1], timestamp <= 0",
      );
  }
  return config;
}

// A class groups data with the functions that use it. "this" means this world.
// Fields starting with # are private: the agent cannot read EVE'sensor hiding place.
// The agent is given only publicState() and step results.
export class Environment {
  #config;
  #target;
  #clues;
  #rng;
  #seen = new Set();
  constructor(input) {
    this.#config = clone(validate(input));
    const settings = this.#config;
    this.#rng = random(settings.seed);
    const reachable = [...paths(settings.map, settings.start).keys()].map(
      positionFromKey,
    );
    const candidates = reachable.filter((p) => key(p) !== key(settings.start));
    this.#target = clone(
      settings.target ??
        candidates[Math.floor(this.#rng() * candidates.length)] ??
        settings.start,
    );
    this.#clues = clone(
      settings.clues ??
        Array.from(
          { length: settings.clueCount ?? 4 },
          () => reachable[Math.floor(this.#rng() * reachable.length)],
        ),
    );
    this.position = clone(settings.start);
    this.battery = settings.resources.battery;
    this.elapsed = 0;
    this.found = false;
    this.initialSignal = clone(
      settings.initialSignal ?? {
        origin: settings.start,
        bearing:
          angle(settings.start, this.#target) +
          normal(this.#rng) * settings.sensor.bearingSigma,
        strength:
          1 /
          (1 +
            Math.max(
              0,
              distance(settings.start, this.#target) +
                normal(this.#rng) * settings.sensor.rangeSigma,
            )),
        timestamp: 0,
      },
    );
  }
  publicState() {
    const settings = this.#config;
    return clone({
      name: settings.name ?? "Untitled mission",
      seed: settings.seed,
      map: settings.map,
      start: settings.start,
      chargers: settings.chargers,
      resources: settings.resources,
      sensor: settings.sensor,
      initialSignal: this.initialSignal,
    });
  }
  state() {
    return {
      position: clone(this.position),
      battery: this.battery,
      elapsed: this.elapsed,
      found: this.found,
    };
  }
  step(action) {
    const settings = this.#config,
      resources = settings.resources;
    let energy, duration;
    if (action.type === "move") {
      if (
        !Array.isArray(action.to) ||
        !paths(settings.map, this.position).has(key(action.to)) ||
        Math.abs(action.to[0] - this.position[0]) +
          Math.abs(action.to[1] - this.position[1]) !==
          1
      )
        throw new Error("Move must go to an adjacent free cell");
      energy = resources.moveCost;
      duration = resources.moveTime;
    } else if (action.type === "scan") {
      energy = resources.scanCost;
      duration = resources.scanTime;
    } else if (action.type === "recharge") {
      if (!settings.chargers.some((p) => key(p) === key(this.position)))
        throw new Error("No charger at this cell");
      energy = 0;
      duration = resources.rechargeTime;
    } else throw new Error(`Unknown action: ${action.type}`);
    if (this.found) throw new Error("Mission already complete");
    if (
      this.battery + 1e-9 < energy ||
      this.elapsed + duration > resources.time + 1e-9
    )
      throw new Error("Insufficient resources");
    this.battery = Math.max(0, this.battery - energy);
    this.elapsed += duration;
    const observation = { clues: [] };
    if (action.type === "move") this.position = clone(action.to);
    if (action.type === "recharge") this.battery = resources.battery;
    if (action.type === "scan") {
      observation.signal = {
        origin: clone(this.position),
        bearing:
          angle(this.position, this.#target) +
          normal(this.#rng) * settings.sensor.bearingSigma,
        range:
          distance(this.position, this.#target) +
          normal(this.#rng) * settings.sensor.rangeSigma,
        timestamp: this.elapsed,
      };
      this.#clues.forEach((p, i) => {
        if (distance(p, this.position) <= 1.5 && !this.#seen.has(i)) {
          this.#seen.add(i);
          observation.clues.push({
            id: `clue-${i + 1}`,
            position: clone(p),
            hint: [
              this.#target[0] + normal(this.#rng) * 1.5,
              this.#target[1] + normal(this.#rng) * 1.5,
            ],
            sigma: 1.5,
            status: settings.targetStatus,
            reliability: 0.8,
          });
        }
      });
    }
    // Contact is automatic on arrival; absence rules out this cell.
    observation.contact =
      key(this.position) === key(this.#target)
        ? { location: clone(this.position), status: settings.targetStatus }
        : null;
    this.found = Boolean(observation.contact);
    return { ...this.state(), observation };
  }
}

// 3. The agent: WALL-E's memory and decisions.

const statuses = ["active", "dormant", "damaged"];

export class Agent {
  constructor(publicMission) {
    this.mission = clone(publicMission);
    this.position = clone(publicMission.start);
    this.battery = publicMission.resources.battery;
    this.elapsed = 0;
    this.found = false;
    this.stepsSinceScan = 3;
    this.evidence = [];
    // Save only the distance to a charger, rather than reversed copies of paths.
    this.stepsToCharger = new Map();
    for (const charger of publicMission.chargers) {
      for (const [cell, route] of paths(publicMission.map, charger)) {
        const oldDistance = this.stepsToCharger.get(cell);
        if (oldDistance === undefined || route.length < oldDistance) {
          this.stepsToCharger.set(cell, route.length);
        }
      }
    }
    this.status = { active: 1 / 3, dormant: 1 / 3, damaged: 1 / 3 };
    this.belief = new Map();
    const reachable = paths(publicMission.map, publicMission.start);
    for (const position of cells(publicMission.map)) {
      const cell = key(position);
      this.belief.set(cell, reachable.has(cell) ? 1 : 0);
    }
    this.normalize();
    this.updateSignal(publicMission.initialSignal, true);
  }
  normalize() {
    // Rescale guesses so they add up to 1 (100%).
    let total = 0;
    for (const probability of this.belief.values()) total += probability;
    if (total <= 0 || !Number.isFinite(total))
      throw new Error("Belief has no supported location");
    for (const [k, value] of this.belief) this.belief.set(k, value / total);
  }
  updateSignal(signal, initial = false) {
    const sensor = this.mission.sensor;
    // A stale reading is a weaker prior. EVE is stationary during this mission.
    const ageFactor = initial ? 1 + Math.abs(signal.timestamp) / 20 : 1;
    const bearingSigma = sensor.bearingSigma * ageFactor;
    const rangeSigma = sensor.rangeSigma * ageFactor;
    let measuredDistance = signal.range;
    if (initial) measuredDistance = 1 / signal.strength - 1;
    // A smaller mismatch means a square agrees better with the reading.
    // Logs keep tiny probabilities from being rounded down to zero.
    const logs = new Map();
    for (const [cell, oldProbability] of this.belief) {
      if (oldProbability === 0) {
        logs.set(cell, -Infinity); // Already checked or unreachable.
        continue;
      }
      const position = positionFromKey(cell);
      const expectedDistance = distance(signal.origin, position);
      const distanceError = (expectedDistance - measuredDistance) / rangeSigma;
      let directionError = 0;
      if (expectedDistance >= 0.01) {
        directionError =
          angleDiff(angle(signal.origin, position), signal.bearing) /
          bearingSigma;
      }
      const mismatch = distanceError ** 2 + directionError ** 2;
      logs.set(cell, Math.log(oldProbability) - 0.5 * mismatch);
    }
    const biggest = Math.max(...logs.values());
    for (const [cell, logProbability] of logs) {
      let probability = 0;
      if (logProbability !== -Infinity) {
        probability = Math.exp(Math.max(-700, logProbability - biggest));
      }
      this.belief.set(cell, probability);
    }
    this.normalize();
    this.evidence.push({
      type: initial ? "initial_signal" : "scan_signal",
      ...clone(signal),
    });
  }
  observe(result) {
    this.position = clone(result.position);
    this.battery = result.battery;
    this.elapsed = result.elapsed;
    const observation = result.observation;
    if (observation.signal) {
      this.updateSignal(observation.signal);
      this.stepsSinceScan = 0;
    } else {
      this.stepsSinceScan++;
    }
    for (const clue of observation.clues) {
      // A small outlier component prevents a bad clue from erasing alternatives.
      for (const [cell, oldProbability] of this.belief) {
        const error = distance(positionFromKey(cell), clue.hint) / clue.sigma;
        const agreement = 0.05 + 0.95 * Math.exp(-0.5 * error ** 2);
        this.belief.set(cell, oldProbability * agreement);
      }
      this.normalize();
      let total = 0;
      for (const status of statuses) {
        if (status === clue.status) this.status[status] *= clue.reliability;
        else this.status[status] *= (1 - clue.reliability) / 2;
        total += this.status[status];
      }
      for (const status of statuses) this.status[status] /= total;
      this.evidence.push({
        type: "clue",
        ...clone(clue),
        timestamp: result.elapsed,
      });
    }
    if (observation.contact) {
      this.found = true;
      for (const cell of this.belief.keys()) {
        this.belief.set(cell, cell === key(this.position) ? 1 : 0);
      }
      for (const status of statuses) {
        this.status[status] = status === observation.contact.status ? 1 : 0;
      }
      this.evidence.push({
        type: "contact",
        ...clone(observation.contact),
        timestamp: result.elapsed,
      });
    } else {
      this.belief.set(key(this.position), 0);
      this.normalize();
    }
  }
  summary() {
    let bestCell;
    let confidence = -1;
    let entropy = 0;
    for (const [cell, probability] of this.belief) {
      if (probability > confidence) {
        bestCell = cell;
        confidence = probability;
      }
      // Entropy measures how spread out the guesses are.
      if (probability > 0) entropy -= probability * Math.log2(probability);
    }
    let bestStatus = "active";
    for (const status of statuses) {
      if (this.status[status] > this.status[bestStatus]) bestStatus = status;
    }
    const statusConfidence = this.status[bestStatus];
    return {
      location: positionFromKey(bestCell),
      confidence,
      status: statusConfidence > 0.5 ? bestStatus : "unknown",
      statusConfidence,
      entropy,
    };
  }
  nearestChargerRoute(position) {
    const routes = paths(this.mission.map, position);
    let shortest;
    for (const charger of this.mission.chargers) {
      const route = routes.get(key(charger));
      if (route && (!shortest || route.length < shortest.length))
        shortest = route;
    }
    return shortest;
  }
  decide() {
    if (this.found)
      return { type: "stop", reason: "EVE confirmed by direct contact." };
    const resources = this.mission.resources;
    const remaining = resources.time - this.elapsed;
    const home = this.nearestChargerRoute(this.position);
    const atCharger = home.length === 0;
    const routes = paths(this.mission.map, this.position);
    const summary = this.summary();
    let best;
    let anotherTripAfterRecharge = false;
    for (const [cell, probability] of this.belief) {
      const route = routes.get(cell);
      if (probability === 0 || !route || route.length === 0) continue;
      const stepsHome = this.stepsToCharger.get(cell);
      const totalSteps = route.length + stepsHome;
      const cost = totalSteps * resources.moveCost;
      const duration = totalSteps * resources.moveTime;
      // Prefer likely squares that are close. Never forget the trip home.
      const score = probability / (route.length + 1);
      if (
        cost <= resources.battery &&
        duration + resources.rechargeTime <= remaining
      ) {
        anotherTripAfterRecharge = true;
      }
      if (cost <= this.battery + 1e-9 && duration <= remaining + 1e-9) {
        if (!best || score > best.score) {
          best = { cell, p: probability, route, cost, score };
        }
      }
    }
    const homeEnergy = home.length * resources.moveCost,
      homeTime = home.length * resources.moveTime;
    const canScan =
      this.battery >= homeEnergy + resources.scanCost &&
      remaining >= homeTime + resources.scanTime;
    // 1. Scan periodically when we can still get home afterwards.
    if (canScan && this.stepsSinceScan >= 3 && best) {
      return {
        type: "scan",
        reason: `Refresh the signal before choosing a route; location confidence ${(summary.confidence * 100).toFixed(1)}%. Return reserve: ${homeEnergy} battery.`,
      };
    }
    // 2. Take one step toward the best affordable square.
    if (best) {
      return {
        type: "move",
        to: best.route[0],
        reason: `Investigate [${best.cell}], probability ${(best.p * 100).toFixed(1)}%; ${best.route.length} steps away. Trip plus return costs ${best.cost} battery.`,
      };
    }
    // 3. No search trip fits: go back to a charger.
    if (
      !atCharger &&
      home.length &&
      this.battery >= homeEnergy &&
      remaining >= homeTime
    ) {
      return {
        type: "move",
        to: home[0],
        reason:
          "Return to a charger: no further candidate fits the current battery and time reserve.",
      };
    }
    // 4. Recharge only if that makes another search trip possible.
    if (
      atCharger &&
      this.battery < resources.battery &&
      anotherTripAfterRecharge &&
      remaining >= resources.rechargeTime
    ) {
      return {
        type: "recharge",
        reason:
          "Recharge for another search trip; a candidate is reachable with a full battery.",
      };
    }
    return {
      type: "stop",
      reason:
        remaining < resources.moveTime
          ? "Mission time exhausted."
          : "No remaining search trip fits the battery capacity and time budget.",
    };
  }
}

// 4. The main loop: decide -> act -> learn -> repeat.
export function runMission(environment, maxActions = 10000) {
  const mission = environment.publicState();
  const agent = new Agent(mission);
  const trace = [];
  let terminal;
  for (let i = 0; i < maxActions; i++) {
    const decision = agent.decide();
    if (decision.type === "stop") {
      terminal = decision.reason;
      break;
    }
    const before = environment.state();
    const result = environment.step(decision);
    agent.observe(result);
    trace.push({
      step: i + 1,
      before,
      action: decision,
      result,
      belief: agent.summary(),
      probabilities: Object.fromEntries(agent.belief),
    });
  }
  terminal ??= "Action safety limit reached.";
  const summary = agent.summary();
  const report = {
    mission: mission.name,
    seed: mission.seed,
    outcome: agent.found ? "found" : "inconclusive",
    reason: terminal,
    inferredLocation: summary.location,
    locationConfidence: summary.confidence,
    inferredStatus: summary.status,
    statusConfidence: summary.statusConfidence,
    evidence: agent.evidence,
    resources: {
      batteryRemaining: agent.battery,
      batteryCapacity: mission.resources.battery,
      timeUsed: agent.elapsed,
      timeBudget: mission.resources.time,
    },
    actions: trace.length,
    recommendedNextStep: agent.found
      ? `Approach EVE and assess ${summary.status === "damaged" ? "repairs" : "safe retrieval"}.`
      : `Continue the search near [${summary.location}]; provide more time, battery capacity, or a closer charger. Location remains unconfirmed.`,
  };
  return { mission, trace, report };
}

// 5. Save the report and replay.
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

// 6. Terminal commands. Importing this file in tests does not start a mission.
async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Run: node mission.js [mission.json] [--out folder]");
    console.log("Preview: node mission.js --preview");
    return;
  }
  if (args.length === 1 && args[0] === "--preview") {
    // Prefer the latest run; fall back to the checked-in example on a fresh clone.
    let html;
    try {
      html = await readFile("runs/replay.html", "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      html = await readFile(
        new URL("./examples/replay.html", import.meta.url),
        "utf8",
      );
    }
    const server = http.createServer((request, response) => {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(html);
    });
    server.on("error", (error) => {
      console.error("Preview failed: " + error.message);
      process.exitCode = 1;
    });
    server.listen(4173, "127.0.0.1", () =>
      console.log("Open http://127.0.0.1:4173"),
    );
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
  const config = JSON.parse(await readFile(file, "utf8"));
  const world = new Environment(config);
  const run = runMission(world);
  await saveRun(run, folder);
  console.log(run.report.outcome.toUpperCase() + ": " + run.report.reason);
  console.log(
    run.report.actions +
      " actions, " +
      run.report.resources.timeUsed +
      " time used.",
  );
  console.log("Results: " + resolve(folder));
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error("Mission failed: " + error.message);
    process.exitCode = 1;
  });
}
