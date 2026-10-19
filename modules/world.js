import { readFile } from "node:fs/promises";
import { key, positionFromKey, distance, angle, clone, random, normal, paths } from "./helpers.js";

// The world: validate settings, hide EVE, and carry out actions.
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
// Fields starting with # are private: the agent cannot read EVE's hiding place.
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

// The entry point calls this to load settings and create the hidden world.
export async function loadMission(file) {
  const settings = JSON.parse(await readFile(file, "utf8"));
  return new Environment(settings);
}
