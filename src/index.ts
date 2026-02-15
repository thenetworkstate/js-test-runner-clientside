import {
  AbortedRunError,
  BrowserTestRunnerError,
  TimeoutError,
} from "./errors";
import { generateOutput as generateJavaScriptOutput } from "./output";
import { prepare } from "./prepare";
import type {
  FailedTestRun,
  GenerateOutputFn,
  OutputInterface,
  OutputOptions,
  TestRun,
  TranspileFn,
} from "./types";
import { findCode, readConfig } from "./utils";

export type * from "./types";
export * from "./utils";

import jestExpect from "expect";
import { ModuleMocker } from "jest-mock";
import { workerize } from "./workerize";

export function runTests(
  _slug: string,
  files: Record<string, string>,
  userPaths: string[],
  signal?: AbortSignal,
): Promise<OutputInterface>;
export function runTests(
  _slug: string,
  files: Record<string, string>,
  userPaths: string[],
  signal: AbortSignal,
  transpile: TranspileFn,
): Promise<OutputInterface>;
export function runTests(
  _slug: string,
  files: Record<string, string>,
  userPaths: string[],
  signal: AbortSignal,
  transpile: TranspileFn | undefined,
  generateOutput: GenerateOutputFn<OutputOptions>,
): Promise<OutputInterface>;

export async function runTests(
  _slug: string,
  files: Record<string, string>,
  userPaths: string[],
  signal?: AbortSignal,
  transpile: TranspileFn = (code) => code,
  generateOutput: GenerateOutputFn<OutputOptions> = generateJavaScriptOutput,
): Promise<OutputInterface> {
  return runJestTests({ files, userPaths }, signal, {
    transpile,
    generateOutput,
  }).catch((error: unknown) => {
    let message: string;

    if (error instanceof Error) {
      message = error.message;
    } else if (Object.prototype.hasOwnProperty.call(error, "message")) {
      message = String((error as { message: unknown }).message);
    } else if (Object.prototype.hasOwnProperty.call(error, "toString")) {
      message = (error as { toString(): string }).toString();
    } else {
      throw error;
    }

    return {
      version: 1,
      status: "error",
      message,
      tests: [],
    };
  });
}

async function runJestTests(
  solution: {
    readonly files: Readonly<Record<string, string>>;
    readonly userPaths: readonly string[];
  },
  signal: undefined | AbortSignal,
  callbacks: {
    transpile: TranspileFn;
    generateOutput: GenerateOutputFn<OutputOptions>;
  },
) {
  const { files, userPaths } = solution;
  const { transpile, generateOutput } = callbacks;

  const config = readConfig(files);
  const code = findCode(config, files, userPaths, transpile);

  const runOptions = {
    enableTaskIds: Boolean(
      config.custom && config.custom["flag.tests.task-per-describe"],
    ),
    includesOptionalTests: Boolean(
      config.custom && config.custom["flag.tests.includes-optional"],
    ),
  };

  const { entry, urls } = prepare(code, runOptions);

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

  // Keep references so they can be cleaned up
  const references: {
    timer: undefined | number;
    interval: undefined | number;
  } = {
    timer: undefined,
    interval: undefined,
  };

  function cleanup() {
    console.debug("[suite] cleaning up run", urls);
    Object.values(urls).forEach((objectUrl) => URL.revokeObjectURL(objectUrl));

    clearInterval(references.interval);
    clearTimeout(references.timer);

    // Clear globals
    delete globals["expect"];
    delete globals["jest"];
  }

  // Bail early if dead-on-arrival
  if (signal) {
    if (signal.aborted) {
      throw new AbortedRunError("Run was aborted before it could start");
    }
  }

  const result = await workerize(
    makeWorkerRunner(entry, signal, references),
    makeMainThreadRunner(entry, signal, references),
  ).catch<FailedTestRun>((error: unknown) => {
    console.error("[suite] failed to run the tests \n", error);

    if (error && typeof error === "object" && "message" in error) {
      let message = String(error.message);

      for (const [originalPath, module] of Object.entries(urls)) {
        message = message.replaceAll(module, originalPath);
      }

      return { ...({ message } as FailedTestRun) };
    }

    throw new BrowserTestRunnerError(`Something went wrong: ${error}`);
  });

  cleanup();

  // Wait an animation frame
  await new Promise((resolve) => requestAnimationFrame(resolve));

  // Generate output
  return generateOutput(result, config.custom);
}

function makeWorkerRunner(
  entry: string,
  signal: AbortSignal | undefined,
  references: {
    timer: undefined | number;
    interval: undefined | number;
  },
) {
  return async function onWorker(
    worker: Worker,
  ): Promise<FailedTestRun | TestRun> {
    const run = new Promise<FailedTestRun | TestRun>((resolve, reject) => {
      worker.addEventListener(
        "message",
        (message) => {
          // Unlikely but in case something posts to the worker
          if (
            !message ||
            !message.data ||
            typeof message.data !== "object" ||
            message.data._type !==
              "vnd.exercism.javascript-browser-test-runner.result"
          ) {
            return;
          }

          console.debug("[main] worker completed run", message);
          resolve(message.data);
        },
        { once: true },
      );

      worker.addEventListener(
        "error",
        (message) => {
          console.error("[main] worker failed to complete run", message);
          reject(
            message.error ||
              new BrowserTestRunnerError("Worked failed without error message"),
          );
        },
        { once: true },
      );

      // Start the tests
      worker.postMessage({
        _type: "vnd.exercism.javascript-browser-test-runner.start",
        entry,
        timeout: 30,
        source: "@exercism/javascript-browser-test-runner",
      });
    });

    const abort = onAbortRun(signal);
    const timeout = new Promise<never>((_, reject) => {
      references.timer = setTimeout(() => {
        reject(
          new TimeoutError("Did not finish the tests within reasonable time"),
        );
      }, 30 * 1000);
    });

    return Promise.race([run, abort, timeout]).finally(() => {
      worker.terminate();
    });
  };
}

type ImportedTest = {
  run: TestRun;
};

function makeMainThreadRunner(
  entry: string,
  signal: AbortSignal | undefined,
  references: {
    timer: undefined | number;
    interval: undefined | number;
  },
) {
  return async function onInline() {
    return import(`${entry}`).then<TestRun>(({ run }: ImportedTest) => {
      if (run.completed) {
        return run;
      }

      const runPromise = onCompletedRun(run, 30, references);
      const abortPromise = onAbortRun(signal);

      return Promise.race([runPromise, abortPromise]);
    });
  };
}

/**
 * Promise that resolves when the run completes or a timeout is reached
 *
 * @param run the live object with the run. This is usually an exported binding
 * @param timeout the number of seconds these tests are allowed to run
 * @param references object to track interval and timeout so they can be cleared
 *
 * @returns promise that resolves on completion or rejects on timeout
 */
function onCompletedRun(
  run: TestRun,
  timeout: number,
  references: {
    timer: undefined | number;
    interval: undefined | number;
  },
) {
  return new Promise<TestRun>((resolve, reject) => {
    references.timer = setTimeout(() => {
      clearInterval(references.interval);

      reject(
        new TimeoutError("Did not finish the tests within reasonable time"),
      );
    }, timeout * 1000);

    references.interval = setInterval(() => {
      if (run.completed) {
        clearTimeout(references.timer);
        clearInterval(references.interval);

        resolve(run);
      }
    }, 100);
  });
}

/**
 * Promise that rejects when the signal receives an abort event
 *
 * @param signal the signal
 * @returns promise that rejects when signal is aborted
 */
function onAbortRun(signal: undefined | AbortSignal) {
  return new Promise<TestRun>((_, reject) => {
    if (!signal) {
      return;
    }

    if (signal.aborted) {
      return reject(
        abortError(signal.reason, "Run was aborted before it could finish"),
      );
    }

    signal.addEventListener(
      "abort",
      (_) =>
        reject(
          abortError(signal.reason, "Run was aborted before it could finish"),
        ),
      {
        once: true,
      },
    );
  });
}

function abortError(reason: unknown, message: string) {
  if (typeof reason === "object" && reason !== null) {
    if (reason.constructor.name === "DOMException") {
      return new AbortedRunError(message);
    }

    if (
      reason.constructor.name.includes("Error") ||
      reason.constructor.name.includes("Exception")
    ) {
      return reason;
    }
  }

  return new AbortedRunError(`${message}: ${reason}`);
}
