import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { Agent, runMission } from '../src/agent.js';
import { Environment, key, paths, validate } from '../src/world.js';
import { replayHtml } from '../src/output.js';

const load = name => readFile(new URL(`../missions/${name}.json`, import.meta.url), 'utf8').then(JSON.parse);
const warehouse = await load('warehouse');
const seeded = await load('seeded');
const short = await load('short-battery');

test('sample mission finds EVE using scans, clues and recharges', () => {
  const run = runMission(new Environment(warehouse));
  assert.equal(run.report.outcome, 'found');
  assert.deepEqual(run.report.inferredLocation, warehouse.target);
  assert.equal(run.report.inferredStatus, warehouse.targetStatus);
  assert.equal(run.report.locationConfidence, 1);
  for (const type of ['scan', 'recharge', 'move']) assert.ok(run.trace.some(f => f.action.type === type), type);
  assert.ok(run.report.evidence.some(e => e.type === 'clue'));
});

test('same seed and config produce exactly the same run', () => {
  assert.deepEqual(runMission(new Environment(seeded)), runMission(new Environment(seeded)));
});

test('public mission reveals neither the target nor hidden clue placement', () => {
  const env = new Environment(warehouse);
  const publicMission = env.publicState();
  for (const field of ['target', 'targetStatus', 'clues', 'clueCount']) assert.equal(publicMission[field], undefined);
  publicMission.map.obstacles.length = 0;
  assert.equal(env.publicState().map.obstacles.length, warehouse.map.obstacles.length);
  const result = env.step({ type: 'scan' });
  assert.ok(!JSON.stringify(result).includes('target'));
  assert.ok(result.observation.clues.every(c => Math.hypot(c.position[0] - warehouse.start[0], c.position[1] - warehouse.start[1]) <= 1.5));
});

test('invalid actions fail atomically without consuming resources', () => {
  const env = new Environment(warehouse), before = env.state();
  for (const action of [{ type: 'teleport' }, { type: 'move', to: [12, 2] }, { type: 'move', to: [1.5, 8] }]) {
    assert.throws(() => env.step(action));
    assert.deepEqual(env.state(), before);
  }
  env.step({ type: 'move', to: [2, 8] });
  const away = env.state();
  assert.throws(() => env.step({ type: 'recharge' }), /No charger/);
  assert.deepEqual(env.state(), away);
});

test('actions cannot overdraw energy or time', () => {
  for (const field of ['battery', 'time']) {
    const c = structuredClone(warehouse); c.resources[field] = 0.5;
    const env = new Environment(c), before = env.state();
    assert.throws(() => env.step({ type: 'scan' }), /Insufficient/);
    assert.deepEqual(env.state(), before);
  }
});

test('budget-limited search ends inconclusive at a charger without inventing contact', () => {
  const run = runMission(new Environment(short));
  assert.equal(run.report.outcome, 'inconclusive');
  assert.ok(!run.report.evidence.some(e => e.type === 'contact'));
  assert.ok(short.chargers.some(c => key(c) === key(run.trace.at(-1).result.position)));
  assert.match(run.report.recommendedNextStep, /unconfirmed/);
});

test('direct contact overrides uncertain status hints', () => {
  const env = new Environment(warehouse), agent = new Agent(env.publicState());
  agent.observe({ position: [12, 2], battery: 1, elapsed: 10,
    observation: { clues: [], contact: { location: [12, 2], status: 'damaged' } } });
  assert.equal(agent.summary().status, 'damaged');
  assert.equal(agent.summary().confidence, 1);
  assert.equal(agent.decide().type, 'stop');
});

test('scans change the belief and empty visited cells stay excluded', () => {
  const env = new Environment(warehouse), agent = new Agent(env.publicState());
  const before = [...agent.belief];
  agent.observe(env.step({ type: 'scan' }));
  assert.notDeepEqual([...agent.belief], before);
  assert.equal(agent.belief.get(key(warehouse.start)), 0);
  agent.observe(env.step({ type: 'scan' }));
  assert.equal(agent.belief.get(key(warehouse.start)), 0);
  assert.ok(Math.abs([...agent.belief.values()].reduce((a, b) => a + b) - 1) < 1e-10);
});

test('disconnected regions get no prior probability even if they have a charger', () => {
  const c = structuredClone(seeded);
  c.map = { width: 4, height: 4, obstacles: [[1, 0], [1, 1], [1, 2], [1, 3]] };
  c.start = [0, 0]; c.chargers = [[0, 0], [3, 3]];
  const agent = new Agent(new Environment(c).publicState());
  assert.equal(agent.belief.get('3,3'), 0);
});

test('mission validation rejects malformed configs', () => {
  const changes = [c => c.map.width = 0, c => c.target = [99, 0], c => c.resources.scanCost = -1,
    c => c.sensor.rangeSigma = 0, c => c.chargers = [], c => c.seed = 0.5,
    c => c.clues = [[-1, 0]], c => c.targetStatus = 'probably fine', c => c.initialSignal.strength = 0,
    c => c.initialSignal.timestamp = 1, c => c.clueCount = -1];
  for (const change of changes) { const c = structuredClone(warehouse); change(c); assert.throws(() => validate(c), /Invalid mission/); }
});

test('30 seeded missions preserve resource and posterior invariants', () => {
  let found = 0;
  for (let seed = 1; seed <= 30; seed++) {
    const c = { ...seeded, seed }, run = runMission(new Environment(c));
    found += run.report.outcome === 'found';
    assert.ok(run.trace.length < 10000);
    for (const frame of run.trace) {
      assert.ok(frame.result.battery >= 0 && frame.result.battery <= c.resources.battery);
      assert.ok(frame.result.elapsed <= c.resources.time);
      const routes = paths(c.map, frame.result.position);
      const stepsHome = Math.min(...c.chargers.map(p => routes.get(key(p))?.length ?? Infinity));
      assert.ok(frame.result.battery + 1e-9 >= stepsHome * c.resources.moveCost, 'battery return reserve');
      assert.ok(c.resources.time - frame.result.elapsed + 1e-9 >= stepsHome * c.resources.moveTime, 'time return reserve');
      const ps = Object.values(frame.probabilities);
      assert.ok(ps.every(p => Number.isFinite(p) && p >= 0));
      assert.ok(Math.abs(ps.reduce((a, b) => a + b, 0) - 1) < 1e-10);
    }
  }
  assert.ok(found >= 24, `expected >=24/30 found, got ${found}`);
});

test('replay safely embeds user-controlled mission names and has a working script', () => {
  const run = runMission(new Environment(seeded));
  run.mission.name = '</script><script>alert(1)</script>';
  const html = replayHtml(run);
  assert.ok(!html.includes('<script>alert(1)</script>'));
  const data = html.match(/<script id="run-data" type="application\/json">([\s\S]*?)<\/script>/)[1];
  assert.equal(JSON.parse(data).mission.name, run.mission.name);
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  assert.doesNotThrow(() => new Function(script));
});

test('CLI reports invalid input with a nonzero exit code', () => {
  const result = spawnSync(process.execPath, ['src/cli.js', 'missions/missing.json'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Mission failed/);
});
