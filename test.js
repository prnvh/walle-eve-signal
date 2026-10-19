import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  Agent,
  runMission,
  Environment,
  key,
  paths,
  validate,
  replayHtml,
} from "./mission.js";

const warehouse = JSON.parse(
  await readFile(new URL("./mission.json", import.meta.url), "utf8"),
);
const seeded = {
  name: "An unknown corner",
  seed: 83,
  map: {
    width: 10,
    height: 8,
    obstacles: [
      [3, 1],
      [3, 2],
      [3, 3],
      [3, 4],
      [6, 3],
      [6, 4],
      [6, 5],
    ],
  },
  start: [0, 0],
  chargers: [
    [0, 0],
    [5, 2],
    [8, 6],
  ],
  targetStatus: "active",
  clueCount: 6,
  resources: {
    battery: 26,
    time: 140,
    moveCost: 1,
    scanCost: 2,
    moveTime: 1,
    scanTime: 2,
    rechargeTime: 6,
  },
  sensor: {
    bearingSigma: 0.35,
    rangeSigma: 2,
  },
};
const short = {
  name: "Too far from home",
  seed: 7,
  map: {
    width: 12,
    height: 6,
    obstacles: [],
  },
  start: [0, 2],
  chargers: [[0, 2]],
  target: [11, 2],
  targetStatus: "damaged",
  clues: [[2, 2]],
  resources: {
    battery: 10,
    time: 50,
    moveCost: 1,
    scanCost: 2,
    moveTime: 1,
    scanTime: 2,
    rechargeTime: 5,
  },
  sensor: {
    bearingSigma: 0.2,
    rangeSigma: 1.5,
  },
};

test("sample mission finds EVE using scans, clues and recharges", () => {
  const run = runMission(new Environment(warehouse));
  assert.equal(run.report.outcome, "found");
  assert.deepEqual(run.report.inferredLocation, warehouse.target);
  assert.equal(run.report.inferredStatus, warehouse.targetStatus);
  assert.equal(run.report.locationConfidence, 1);
  for (const type of ["scan", "recharge", "move"])
    assert.ok(
      run.trace.some((f) => f.action.type === type),
      type,
    );
  assert.ok(run.report.evidence.some((e) => e.type === "clue"));
});

test("same seed and config produce exactly the same run", () => {
  assert.deepEqual(
    runMission(new Environment(seeded)),
    runMission(new Environment(seeded)),
  );
});

test("public mission reveals neither the target nor hidden clue placement", () => {
  const env = new Environment(warehouse);
  const publicMission = env.publicState();
  for (const field of ["target", "targetStatus", "clues", "clueCount"])
    assert.equal(publicMission[field], undefined);
  publicMission.map.obstacles.length = 0;
  assert.equal(
    env.publicState().map.obstacles.length,
    warehouse.map.obstacles.length,
  );
  const result = env.step({ type: "scan" });
  assert.ok(!JSON.stringify(result).includes("target"));
  assert.ok(
    result.observation.clues.every(
      (c) =>
        Math.hypot(
          c.position[0] - warehouse.start[0],
          c.position[1] - warehouse.start[1],
        ) <= 1.5,
    ),
  );
});

test("invalid actions fail atomically without consuming resources", () => {
  const env = new Environment(warehouse),
    before = env.state();
  for (const action of [
    { type: "teleport" },
    { type: "move", to: [12, 2] },
    { type: "move", to: [1.5, 8] },
  ]) {
    assert.throws(() => env.step(action));
    assert.deepEqual(env.state(), before);
  }
  env.step({ type: "move", to: [2, 8] });
  const away = env.state();
  assert.throws(() => env.step({ type: "recharge" }), /No charger/);
  assert.deepEqual(env.state(), away);
});

test("actions cannot overdraw energy or time", () => {
  for (const field of ["battery", "time"]) {
    const c = structuredClone(warehouse);
    c.resources[field] = 0.5;
    const env = new Environment(c),
      before = env.state();
    assert.throws(() => env.step({ type: "scan" }), /Insufficient/);
    assert.deepEqual(env.state(), before);
  }
});

test("budget-limited search ends inconclusive at a charger without inventing contact", () => {
  const run = runMission(new Environment(short));
  assert.equal(run.report.outcome, "inconclusive");
  assert.ok(!run.report.evidence.some((e) => e.type === "contact"));
  assert.ok(
    short.chargers.some(
      (c) => key(c) === key(run.trace.at(-1).result.position),
    ),
  );
  assert.match(run.report.recommendedNextStep, /unconfirmed/);
});

test("direct contact overrides uncertain status hints", () => {
  const env = new Environment(warehouse),
    agent = new Agent(env.publicState());
  agent.observe({
    position: [12, 2],
    battery: 1,
    elapsed: 10,
    observation: {
      clues: [],
      contact: { location: [12, 2], status: "damaged" },
    },
  });
  assert.equal(agent.summary().status, "damaged");
  assert.equal(agent.summary().confidence, 1);
  assert.equal(agent.decide().type, "stop");
});

test("scans change the belief and empty visited cells stay excluded", () => {
  const env = new Environment(warehouse),
    agent = new Agent(env.publicState());
  const before = [...agent.belief];
  agent.observe(env.step({ type: "scan" }));
  assert.notDeepEqual([...agent.belief], before);
  assert.equal(agent.belief.get(key(warehouse.start)), 0);
  agent.observe(env.step({ type: "scan" }));
  assert.equal(agent.belief.get(key(warehouse.start)), 0);
  assert.ok(
    Math.abs([...agent.belief.values()].reduce((a, b) => a + b) - 1) < 1e-10,
  );
});

test("disconnected regions get no prior probability even if they have a charger", () => {
  const c = structuredClone(seeded);
  c.map = {
    width: 4,
    height: 4,
    obstacles: [
      [1, 0],
      [1, 1],
      [1, 2],
      [1, 3],
    ],
  };
  c.start = [0, 0];
  c.chargers = [
    [0, 0],
    [3, 3],
  ];
  const agent = new Agent(new Environment(c).publicState());
  assert.equal(agent.belief.get("3,3"), 0);
});

test("mission validation rejects malformed configs", () => {
  const changes = [
    (c) => (c.map.width = 0),
    (c) => (c.target = [99, 0]),
    (c) => (c.resources.scanCost = -1),
    (c) => (c.sensor.rangeSigma = 0),
    (c) => (c.chargers = []),
    (c) => (c.seed = 0.5),
    (c) => (c.clues = [[-1, 0]]),
    (c) => (c.targetStatus = "probably fine"),
    (c) => (c.initialSignal.strength = 0),
    (c) => (c.initialSignal.timestamp = 1),
    (c) => (c.clueCount = -1),
  ];
  for (const change of changes) {
    const c = structuredClone(warehouse);
    change(c);
    assert.throws(() => validate(c), /Invalid mission/);
  }
});

test("30 seeded missions preserve resource and posterior invariants", () => {
  let found = 0;
  for (let seed = 1; seed <= 30; seed++) {
    const c = { ...seeded, seed },
      run = runMission(new Environment(c));
    found += run.report.outcome === "found";
    assert.ok(run.trace.length < 10000);
    for (const frame of run.trace) {
      assert.ok(
        frame.result.battery >= 0 &&
          frame.result.battery <= c.resources.battery,
      );
      assert.ok(frame.result.elapsed <= c.resources.time);
      const routes = paths(c.map, frame.result.position);
      const stepsHome = Math.min(
        ...c.chargers.map((p) => routes.get(key(p))?.length ?? Infinity),
      );
      assert.ok(
        frame.result.battery + 1e-9 >= stepsHome * c.resources.moveCost,
        "battery return reserve",
      );
      assert.ok(
        c.resources.time - frame.result.elapsed + 1e-9 >=
          stepsHome * c.resources.moveTime,
        "time return reserve",
      );
      const ps = Object.values(frame.probabilities);
      assert.ok(ps.every((p) => Number.isFinite(p) && p >= 0));
      assert.ok(Math.abs(ps.reduce((a, b) => a + b, 0) - 1) < 1e-10);
    }
  }
  assert.ok(found >= 24, `expected >=24/30 found, got ${found}`);
});

test("replay safely embeds user-controlled mission names and has a working script", () => {
  const run = runMission(new Environment(seeded));
  run.mission.name = "</script><script>alert(1)</script>";
  const html = replayHtml(run);
  assert.ok(!html.includes("<script>alert(1)</script>"));
  const data = html.match(
    /<script id="run-data" type="application\/json">([\s\S]*?)<\/script>/,
  )[1];
  assert.equal(JSON.parse(data).mission.name, run.mission.name);
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  assert.doesNotThrow(() => new Function(script));
});

test("CLI reports invalid input with a nonzero exit code", () => {
  const result = spawnSync(process.execPath, ["mission.js", "missing.json"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Mission failed/);
});

test("CLI saves a custom mission with its full trace, report and offline replay", async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'walle-output-test-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const configFile = join(folder, 'custom.json');
  const results = join(folder, 'results');
  await writeFile(configFile, JSON.stringify(short));
  const command = spawnSync(process.execPath, ['mission.js', configFile, '--out', results], {encoding:'utf8'});
  assert.equal(command.status, 0, command.stderr);
  const saved = JSON.parse(await readFile(join(results, 'run.json'), 'utf8'));
  assert.equal(saved.report.outcome, 'inconclusive');
  assert.equal(saved.trace.length, saved.report.actions);
  assert.ok(saved.trace.every(frame => frame.action.reason && frame.result.observation));
  assert.equal(saved.mission.target, undefined);
  assert.match(await readFile(join(results, 'report.md'), 'utf8'), /inconclusive/);
  const html = await readFile(join(results, 'replay.html'), 'utf8');
  const embedded = html.match(/<script id="run-data" type="application\/json">([\s\S]*?)<\/script>/)[1];
  assert.deepEqual(JSON.parse(embedded), saved);
  assert.ok(!html.includes('__RUN_DATA__'));
});
