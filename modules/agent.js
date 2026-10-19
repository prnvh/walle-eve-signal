import { key, positionFromKey, distance, angle, angleDiff, clone, cells, paths } from "./helpers.js";

// The agent: WALL-E's memory and decisions.

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

// The main loop: decide -> act -> learn -> repeat.
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

