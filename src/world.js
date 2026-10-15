export const key = ([x, y]) => `${x},${y}`;
export const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
export const angle = (a, b) => Math.atan2(b[1] - a[1], b[0] - a[0]);
export const angleDiff = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
export const clone = value => structuredClone(value);

export function random(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let t = state;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

export function normal(rng) {
  return Math.sqrt(-2 * Math.log(Math.max(rng(), 1e-12))) * Math.cos(2 * Math.PI * rng());
}

export function cells(map) {
  const blocked = new Set(map.obstacles.map(key));
  const result = [];
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) if (!blocked.has(key([x, y]))) result.push([x, y]);
  }
  return result;
}

export function paths(map, start) {
  const valid = new Set(cells(map).map(key));
  const result = new Map([[key(start), []]]);
  const queue = [start];
  for (let i = 0; i < queue.length; i++) {
    const current = queue[i];
    for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
      const next = [current[0] + dx, current[1] + dy];
      if (valid.has(key(next)) && !result.has(key(next))) {
        result.set(key(next), [...result.get(key(current)), next]);
        queue.push(next);
      }
    }
  }
  return result;
}

export function validate(config) {
  const fail = message => { throw new Error(`Invalid mission: ${message}`); };
  if (!config || typeof config !== 'object') fail('expected an object');
  const { map, resources: r, sensor: s } = config;
  if (!map || !Number.isInteger(map.width) || !Number.isInteger(map.height) ||
      map.width < 2 || map.height < 2 || map.width > 60 || map.height > 60) fail('map dimensions must be integers from 2 to 60');
  if (!Array.isArray(map.obstacles)) fail('map.obstacles must be an array');
  const coordinate = p => Array.isArray(p) && p.length === 2 && p.every(Number.isInteger) &&
    p[0] >= 0 && p[1] >= 0 && p[0] < map.width && p[1] < map.height;
  if (!map.obstacles.every(coordinate)) fail('obstacle outside map');
  const free = p => coordinate(p) && !map.obstacles.some(b => key(b) === key(p));
  if (!free(config.start)) fail('start must be a free cell');
  if (!Array.isArray(config.chargers) || !config.chargers.length || !config.chargers.every(free)) fail('chargers must be free cells');
  if (!config.chargers.some(p => key(p) === key(config.start))) fail('start must have a charger');
  if (!Number.isInteger(config.seed) || config.seed < 0 || config.seed > 4294967295) fail('seed must be a uint32');
  for (const field of ['battery', 'time', 'moveCost', 'scanCost', 'moveTime', 'scanTime', 'rechargeTime']) {
    if (!r || !Number.isFinite(r[field]) || r[field] <= 0) fail(`resources.${field} must be positive`);
  }
  for (const field of ['bearingSigma', 'rangeSigma']) {
    if (!s || !Number.isFinite(s[field]) || s[field] <= 0) fail(`sensor.${field} must be positive`);
  }
  const reachable = paths(map, config.start);
  if (config.target !== undefined && !free(config.target)) fail('target must be a free cell');
  if (config.target && !reachable.has(key(config.target))) fail('target must be reachable');
  if (!['active', 'dormant', 'damaged'].includes(config.targetStatus)) fail('targetStatus must be active, dormant or damaged');
  if (config.clues !== undefined && (!Array.isArray(config.clues) || !config.clues.every(free))) fail('clues must be free cells');
  if (config.clueCount !== undefined && (!Number.isInteger(config.clueCount) || config.clueCount < 0 || config.clueCount > 100)) fail('clueCount must be 0 to 100');
  if (config.initialSignal !== undefined) {
    const sig = config.initialSignal;
    if (!sig || !free(sig.origin) || !Number.isFinite(sig.bearing) || !Number.isFinite(sig.strength) || sig.strength <= 0 || sig.strength > 1 || !Number.isFinite(sig.timestamp) || sig.timestamp > 0) fail('initialSignal needs free origin, finite bearing, strength in (0,1], timestamp <= 0');
  }
  return config;
}

// All hidden state lives here. The agent is given only publicState() and step results.
export class Environment {
  #config; #target; #clues; #rng; #seen = new Set();
  constructor(input) {
    this.#config = clone(validate(input));
    const c = this.#config;
    this.#rng = random(c.seed);
    const reachable = [...paths(c.map, c.start).keys()].map(k => k.split(',').map(Number));
    const candidates = reachable.filter(p => key(p) !== key(c.start));
    this.#target = clone(c.target ?? candidates[Math.floor(this.#rng() * candidates.length)] ?? c.start);
    this.#clues = clone(c.clues ?? Array.from({ length: c.clueCount ?? 4 }, () => reachable[Math.floor(this.#rng() * reachable.length)]));
    this.position = clone(c.start);
    this.battery = c.resources.battery;
    this.elapsed = 0;
    this.found = false;
    this.initialSignal = clone(c.initialSignal ?? {
      origin: c.start, bearing: angle(c.start, this.#target) + normal(this.#rng) * c.sensor.bearingSigma,
      strength: 1 / (1 + Math.max(0, distance(c.start, this.#target) + normal(this.#rng) * c.sensor.rangeSigma)), timestamp: 0
    });
  }
  publicState() {
    const c = this.#config;
    return clone({ name: c.name ?? 'Untitled mission', seed: c.seed, map: c.map, start: c.start,
      chargers: c.chargers, resources: c.resources, sensor: c.sensor, initialSignal: this.initialSignal });
  }
  state() { return { position: clone(this.position), battery: this.battery, elapsed: this.elapsed, found: this.found }; }
  step(action) {
    const c = this.#config, r = c.resources;
    let energy, duration;
    if (action.type === 'move') {
      if (!Array.isArray(action.to) || !paths(c.map, this.position).has(key(action.to)) ||
          Math.abs(action.to[0] - this.position[0]) + Math.abs(action.to[1] - this.position[1]) !== 1) throw new Error('Move must go to an adjacent free cell');
      energy = r.moveCost; duration = r.moveTime;
    } else if (action.type === 'scan') { energy = r.scanCost; duration = r.scanTime;
    } else if (action.type === 'recharge') {
      if (!c.chargers.some(p => key(p) === key(this.position))) throw new Error('No charger at this cell');
      energy = 0; duration = r.rechargeTime;
    } else throw new Error(`Unknown action: ${action.type}`);
    if (this.found) throw new Error('Mission already complete');
    if (this.battery + 1e-9 < energy || this.elapsed + duration > r.time + 1e-9) throw new Error('Insufficient resources');
    this.battery = Math.max(0, this.battery - energy);
    this.elapsed += duration;
    const observation = { clues: [] };
    if (action.type === 'move') this.position = clone(action.to);
    if (action.type === 'recharge') this.battery = r.battery;
    if (action.type === 'scan') {
      observation.signal = {
        origin: clone(this.position),
        bearing: angle(this.position, this.#target) + normal(this.#rng) * c.sensor.bearingSigma,
        range: distance(this.position, this.#target) + normal(this.#rng) * c.sensor.rangeSigma,
        timestamp: this.elapsed
      };
      this.#clues.forEach((p, i) => {
        if (distance(p, this.position) <= 1.5 && !this.#seen.has(i)) {
          this.#seen.add(i);
          observation.clues.push({ id: `clue-${i + 1}`, position: clone(p),
            hint: [this.#target[0] + normal(this.#rng) * 1.5, this.#target[1] + normal(this.#rng) * 1.5],
            sigma: 1.5, status: c.targetStatus, reliability: 0.8 });
        }
      });
    }
    // Contact is automatic on arrival; absence rules out this cell.
    observation.contact = key(this.position) === key(this.#target)
      ? { location: clone(this.position), status: c.targetStatus } : null;
    this.found = Boolean(observation.contact);
    return { ...this.state(), observation };
  }
}
