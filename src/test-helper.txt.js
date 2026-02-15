const run = {
  taskId: 0,
  testTaskId: 0,
  failed: 0,
  skipped: 0,
  passed: 0,
  messages: [],
  logs: [],
  promises: [],
  current: Promise.resolve(),
  result: null,
  completed: null,
  beforeEachFns: {},
  afterEachFns: {},
};

function log(logMessage) {
  run.logs[run.testTaskId] ||= [];
  run.logs[run.testTaskId].push(logMessage);
}

const removeLogListener = addLogListener(log);

let failFast = true;
let awaiting = 0;

function startTest(taskId, name) {
  awaiting += 1;
  console.debug(`[test (${taskId})]:start ${name}`);

  run.messages[taskId] ||= [];
}

function passTest(taskId, name) {
  awaiting -= 1;
  run.passed += 1;
  console.debug(`[test (${taskId})]:pass ${name}`);

  run.messages[taskId] ||= [];
  run.messages[taskId].push({ test: name, status: "passed" });
}

function failTest(taskId, name, err) {
  awaiting -= 1;
  run.failed += 1;
  console.debug(`[test (${taskId})]:fail ${name}`);

  run.messages[taskId] ||= [];
  run.messages[taskId].push({
    test: name,
    status: "failed",
    details: err.message,
    err: err,
  });

  globalThis.lastErr = err;

  if (err.constructor.name === "JestAssertionError") {
    console.error(`[test] failed assertion of ${name}.\n`, err.message);
  } else if (err instanceof SyntaxError) {
    failFast = true;
    console.error(`[test] syntax is not valid JavaScript \n`, err);
  } else {
    console.error(`[test] failed to run ${name} \n`, err);
  }
}

function skipTest() {
  run.skipped += 1;
}

function runSuite(name) {
  console.debug("[suite] " + name);
  awaiting += 1;
  run.taskId += 1;
}

function finishSuite() {
  awaiting -= 1;
  if (awaiting > 0) {
    return console.debug(`[suite] still running, awaiting ${awaiting}`);
  }

  run.result = run.failed === 0 ? "passed" : "failed";
  run.completed = true;

  removeLogListener();
}

async function beforeEach(fn) {
  run.beforeEachFns[run.taskId] ||= [];
  run.beforeEachFns[run.taskId].push(fn);
}

async function afterEach(fn) {
  run.afterEachFns[run.taskId] ||= [];
  run.afterEachFns[run.taskId].push(fn);
}

async function beforeAll(func) {
  throw new Error("beforeAll is unsupported. Ask a maintainer to remove this.");
}

async function afterAll(func) {
  throw new Error("afterAll is unsupported. Ask a maintainer to remove this.");
}

async function test(name, c) {
  const withTaskId = run.taskId;

  run.current = run.current.then(() => {
    return promise(queueTest(name, c, withTaskId));
  });

  return run.current;
}

test.skip = skipTest;

const xtest = test;
const it = test;
const xit = test;

async function describe(name, c) {
  runSuite(name);

  const taskId = run.taskId;

  try {
    await c();
    await Promise.all(run.promises);
  } catch (err) {
    run.messages[taskId] ||= [];
    run.messages[taskId].push({
      test: name,
      status: "failed",
      details: err.message,
      err: err,
    });
    run.failed += 1;
  }

  await run.current;
  finishSuite();
}

describe.skip = (name, _c) => {
  throw new Error(
    "An entire test section (describe block) is skipped, which is not supported.",
  );
};

const xdescribe = describe;

function promise(p) {
  run.promises.push(p);
  return p;
}

async function queueTest(name, c, taskId) {
  console.debug(`[start] ${name} (task ${taskId})`);
  run.testTaskId = taskId;

  const beforeEachFns = [].concat(
    run.beforeEachFns[0] ?? [],
    run.beforeEachFns[run.testTaskId] ?? [],
  );
  const afterEachFns = [].concat(
    run.afterEachFns[0] ?? [],
    run.afterEachFns[run.testTaskId] ?? [],
  );
  for (const fn of beforeEachFns) {
    await fn();
  }

  if (failFast && run.failed > 0) {
    skipTest();
    return;
  }

  startTest(taskId, name);

  try {
    await c();
    passTest(taskId, name);
  } catch (err) {
    failTest(taskId, name, err);
  }

  for (const fn of afterEachFns) {
    await fn();
  }

  console.debug(`[end] ${name} (task ${taskId})`);
}

if (typeof jest !== "undefined") {
  jest.mock = function mock(_moduleName, mocker) {
    const mocked = mocker();

    Object.entries(mocked).forEach(([key, value]) => {
      globalThis[key] = value;
      console.debug(`[mocked] ${key} from ${_moduleName}`);
    });
  };
}

export { run };
