import jestExpect from "expect";
import { ModuleMocker } from "jest-mock";

// Set some globals
const globals = globalThis as Record<string, any>;
globals["expect"] = jestExpect;

const _moduleMocker = new ModuleMocker(globalThis);
const fn = _moduleMocker.fn.bind(_moduleMocker);
const spyOn = _moduleMocker.spyOn.bind(_moduleMocker);
const mocked = _moduleMocker.mocked.bind(_moduleMocker);
const replaceProperty = _moduleMocker.replaceProperty.bind(_moduleMocker);
const clearAllMocks = _moduleMocker.clearAllMocks.bind(_moduleMocker);
const resetAllMocks = _moduleMocker.resetAllMocks.bind(_moduleMocker);
const restoreAllMocks = _moduleMocker.restoreAllMocks.bind(_moduleMocker);

globals["jest"] = {
  fn,
  spyOn,
  mocked,
  replaceProperty,
  clearAllMocks,
  resetAllMocks,
  restoreAllMocks,
};

onmessage = function (event) {
  // Unlikely but in case something posts to the worker
  if (
    !event ||
    !event.data ||
    typeof event.data !== "object" ||
    event.data._type !== "vnd.exercism.javascript-browser-test-runner.start"
  ) {
    return;
  }

  const { entry, timeout, source } = event.data;
  if (source !== "@exercism/javascript-browser-test-runner") {
    // ignore
    return;
  }

  console.debug(`[test-worker] running ${entry} for a maximum of ${timeout}s`);

  import(entry).then(
    ({ run }) => {
      if (run.completed) {
        console.debug("[test-worker] completed right away");
        postMessage({
          _type: "vnd.exercism.javascript-browser-test-runner.result",
          ...JSON.parse(JSON.stringify(run)),
        });
        return;
      }

      const references = {
        timer: undefined as undefined | number,
        interval: undefined as undefined | number,
      };

      references.timer = setTimeout(() => {
        clearInterval(references.interval);

        throw new Error("Did not finish the tests within reasonable time");
      }, timeout * 1000);

      references.interval = setInterval(() => {
        if (run.completed) {
          clearTimeout(references.timer);
          clearInterval(references.interval);

          console.debug("[test-worker] completed all tests");
          postMessage({
            _type: "vnd.exercism.javascript-browser-test-runner.result",
            ...JSON.parse(JSON.stringify(run)),
          });
        }
      }, 16);
    },
    (error) => {
      console.error(`[test-worker] ${error}`);
      debugger;
      throw new Error(
        "Could not start test runner because import of entry failed.",
      );
    },
  );
};
