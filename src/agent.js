import { angle, angleDiff, cells, clone, distance, key, paths } from './world.js';

const statuses = ['active', 'dormant', 'damaged'];

export class Agent {
  constructor(publicMission) {
    this.mission = clone(publicMission);
    this.position = clone(publicMission.start);
    this.battery = publicMission.resources.battery;
    this.elapsed = 0;
    this.found = false;
    this.stepsSinceScan = 3;
    this.evidence = [];
    this.status = Object.fromEntries(statuses.map(s => [s, 1 / 3]));
    this.belief = new Map(cells(publicMission.map).map(p => [key(p), 1]));
    this.routeHome = new Map();
    for (const charger of publicMission.chargers) {
      for (const [cell, route] of paths(publicMission.map, charger)) {
        const existing = this.routeHome.get(cell);
        // Reverse charger->cell into the actual steps from cell->charger.
        const home = [...route.slice(0, -1).reverse(), charger];
        if (cell === key(charger)) home.length = 0;
        if (!existing || home.length < existing.length) this.routeHome.set(cell, home);
      }
    }
    const reachable = paths(publicMission.map, publicMission.start);
    for (const cell of this.belief.keys()) if (!reachable.has(cell)) this.belief.set(cell, 0);
    this.normalize();
    this.updateSignal(publicMission.initialSignal, true);
  }
  normalize() {
    const total = [...this.belief.values()].reduce((a, b) => a + b, 0);
    if (total <= 0 || !Number.isFinite(total)) throw new Error('Belief has no supported location');
    for (const [k, value] of this.belief) this.belief.set(k, value / total);
  }
  updateSignal(signal, initial = false) {
    const sensor = this.mission.sensor;
    // A stale reading is a weaker prior. EVE is stationary during this mission.
    const ageFactor = initial ? 1 + Math.abs(signal.timestamp) / 20 : 1;
    const bearingSigma = sensor.bearingSigma * ageFactor;
    const rangeSigma = sensor.rangeSigma * ageFactor;
    const range = initial ? 1 / signal.strength - 1 : signal.range;
    // Work in log space and subtract the maximum to avoid underflow.
    const logs = new Map();
    for (const [k, prior] of this.belief) {
      const p = k.split(',').map(Number);
      const radial = (distance(signal.origin, p) - range) / rangeSigma;
      const angular = distance(signal.origin, p) < 0.01 ? 0 : angleDiff(angle(signal.origin, p), signal.bearing) / bearingSigma;
      logs.set(k, prior > 0 ? Math.log(prior) - 0.5 * (radial ** 2 + angular ** 2) : -Infinity);
    }
    const max = Math.max(...logs.values());
    for (const [k, log] of logs) this.belief.set(k, log === -Infinity ? 0 : Math.exp(Math.max(-700, log - max)));
    this.normalize();
    this.evidence.push({ type: initial ? 'initial_signal' : 'scan_signal', ...clone(signal) });
  }
  observe(result) {
    this.position = clone(result.position);
    this.battery = result.battery;
    this.elapsed = result.elapsed;
    const o = result.observation;
    if (o.signal) { this.updateSignal(o.signal); this.stepsSinceScan = 0; }
    else this.stepsSinceScan++;
    for (const clue of o.clues) {
      // A small outlier component prevents a bad clue from erasing alternatives.
      for (const [k, prior] of this.belief) {
        const d = distance(k.split(',').map(Number), clue.hint);
        this.belief.set(k, prior * (0.05 + 0.95 * Math.exp(-0.5 * (d / clue.sigma) ** 2)));
      }
      this.normalize();
      for (const s of statuses) this.status[s] *= s === clue.status ? clue.reliability : (1 - clue.reliability) / 2;
      const total = Object.values(this.status).reduce((a, b) => a + b, 0);
      for (const s of statuses) this.status[s] /= total;
      this.evidence.push({ type: 'clue', ...clone(clue), timestamp: result.elapsed });
    }
    if (o.contact) {
      this.found = true;
      for (const k of this.belief.keys()) this.belief.set(k, k === key(this.position) ? 1 : 0);
      for (const s of statuses) this.status[s] = s === o.contact.status ? 1 : 0;
      this.evidence.push({ type: 'contact', ...clone(o.contact), timestamp: result.elapsed });
    } else {
      this.belief.set(key(this.position), 0);
      this.normalize();
    }
  }
  summary() {
    const ranked = [...this.belief].sort((a, b) => b[1] - a[1]);
    const [cell, confidence] = ranked[0];
    const [status, statusConfidence] = Object.entries(this.status).sort((a, b) => b[1] - a[1])[0];
    return { location: cell.split(',').map(Number), confidence, status: statusConfidence > 0.5 ? status : 'unknown',
      statusConfidence, entropy: -ranked.reduce((sum, [, p]) => sum + (p > 0 ? p * Math.log2(p) : 0), 0) };
  }
  decide() {
    if (this.found) return { type: 'stop', reason: 'EVE confirmed by direct contact.' };
    const r = this.mission.resources;
    const remaining = r.time - this.elapsed;
    const home = this.routeHome.get(key(this.position)) ?? [];
    const atCharger = home.length === 0;
    const routes = paths(this.mission.map, this.position);
    const summary = this.summary();
    const feasible = [...this.belief].filter(([cell, p]) => p > 0 && routes.has(cell) && routes.get(cell).length > 0)
      .map(([cell, p]) => {
        const route = routes.get(cell), back = this.routeHome.get(cell).length;
        return { cell, p, route, cost: (route.length + back) * r.moveCost,
          duration: (route.length + back) * r.moveTime, score: p / (route.length + 1) };
      });
    const options = feasible.filter(c => c.cost <= this.battery + 1e-9 && c.duration <= remaining + 1e-9)
      .sort((a, b) => b.score - a.score);
    const homeEnergy = home.length * r.moveCost, homeTime = home.length * r.moveTime;
    const canScan = this.battery >= homeEnergy + r.scanCost && remaining >= homeTime + r.scanTime;
    if (canScan && this.stepsSinceScan >= 3 && options.length) {
      return { type: 'scan', reason: `Refresh the signal before choosing a route; location confidence ${(summary.confidence * 100).toFixed(1)}%. Return reserve: ${homeEnergy} battery.` };
    }
    if (options.length) {
      const best = options[0];
      return { type: 'move', to: best.route[0], reason: `Investigate [${best.cell}], probability ${(best.p * 100).toFixed(1)}%; ${best.route.length} steps away. Trip plus return costs ${best.cost} battery.` };
    }
    if (!atCharger && home.length && this.battery >= homeEnergy && remaining >= homeTime) {
      return { type: 'move', to: home[0], reason: 'Return to a charger: no further candidate fits the current battery and time reserve.' };
    }
    const afterRecharge = feasible.some(c => c.cost <= r.battery && c.duration + r.rechargeTime <= remaining);
    if (atCharger && this.battery < r.battery && afterRecharge && remaining >= r.rechargeTime) {
      return { type: 'recharge', reason: 'Recharge for another search trip; a candidate is reachable with a full battery.' };
    }
    return { type: 'stop', reason: remaining < r.moveTime ? 'Mission time exhausted.' : 'No remaining search trip fits the battery capacity and time budget.' };
  }
}

export function runMission(environment, maxActions = 10000) {
  const mission = environment.publicState();
  const agent = new Agent(mission);
  const trace = [];
  let terminal;
  for (let i = 0; i < maxActions; i++) {
    const decision = agent.decide();
    if (decision.type === 'stop') { terminal = decision.reason; break; }
    const before = environment.state();
    const result = environment.step(decision);
    agent.observe(result);
    trace.push({ step: i + 1, before, action: decision, result, belief: agent.summary(),
      probabilities: Object.fromEntries(agent.belief) });
  }
  terminal ??= 'Action safety limit reached.';
  const summary = agent.summary();
  const report = { mission: mission.name, seed: mission.seed, outcome: agent.found ? 'found' : 'inconclusive',
    reason: terminal, inferredLocation: summary.location, locationConfidence: summary.confidence,
    inferredStatus: summary.status, statusConfidence: summary.statusConfidence, evidence: agent.evidence,
    resources: { batteryRemaining: agent.battery, batteryCapacity: mission.resources.battery,
      timeUsed: agent.elapsed, timeBudget: mission.resources.time }, actions: trace.length,
    recommendedNextStep: agent.found ? `Approach EVE and assess ${summary.status === 'damaged' ? 'repairs' : 'safe retrieval'}.`
      : `Continue the search near [${summary.location}]; provide more time, battery capacity, or a closer charger. Location remains unconfirmed.` };
  return { mission, trace, report };
}
