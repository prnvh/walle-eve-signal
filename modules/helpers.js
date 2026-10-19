// Shared helpers: coordinates, repeatable randomness and shortest paths.
// A Map is a lookup table. We use a string like "3,2" as each square's name.
export function key(position) {
  return position[0] + "," + position[1];
}

export function positionFromKey(cell) {
  return cell.split(",").map(Number);
}

export function distance(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

export function angle(a, b) {
  return Math.atan2(b[1] - a[1], b[0] - a[0]);
}

export function angleDiff(a, b) {
  return Math.atan2(Math.sin(a - b), Math.cos(a - b));
}

// Copy data so the agent cannot accidentally change the world's settings.
export function clone(value) {
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

