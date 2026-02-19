import {
  SubmissionError,
  UnsupportedError
} from "./errors";
import { esm, esmHtml, esmJson, importNameWithoutExtension, SolutionCode } from "./utils";

/**
 * Test helper that will actually run the tests in-line and export a live object
 * that can output the run data.
 */
import TEST_HELPER from "./test-helper.txt.js";

export type PrepareOptions = { enableTaskIds: boolean };
export type PreparedCode = {
  readonly entry: string;
  readonly urls: Readonly<Record<string, string>>;
};

/**
 * Prepare the solution for running (jest) tests
 *
 * @param code solution files
 * @param options options
 *
 * @returns entry point and blob urls
 */
export function prepare(
  code: SolutionCode,
  options: PrepareOptions = { enableTaskIds: false },
): PreparedCode {
  const globalLogger = esm`${LOGGER}`;
  const urls: Record<string, string> = { "logger.js": globalLogger };

  // Conditionally enable mocking
  const hasMocks = Object.values(code.test).some((testContent) =>
    testContent.includes("jest.mock("),
  );

  if (hasMocks) {
    // const mocker = esm`${MOCKER}`;
    // urls['mocker.js'] = mocker;

    const mockedModules: string[] = [];
    const matcher = /jest\.mock\(["'](?:\.\/)(.*)["'],/g;

    Object.values(code.test).forEach((testContent) => {
      const matches = Array.from(testContent.matchAll(matcher));
      matches.forEach((match) => {
        if (match[1]) {
          mockedModules.push(match[1]);
        }
      });
    });

    // Remove mocked modules from source list
    for (const sharedPath in code.shared) {
      if (mockedModules.includes(importNameWithoutExtension(sharedPath))) {
        delete code.shared[sharedPath];
        console.debug(`[mock] ${sharedPath} will be mocked`);
      }
    }

    // Remove mocked imports
    for (const collection of Object.values(code)) {
      for (const [path, content] of Object.entries(collection)) {
        {
          // Remove import
          const lines = content.split("\n");

          for (const mockedModule of mockedModules) {
            const importIndex = lines.findIndex(
              (line) =>
                line.startsWith("import ") &&
                line.includes(`./${mockedModule}`),
            );

            if (importIndex === -1) {
              continue;
            }

            lines.splice(importIndex, 1, `// ${lines[importIndex]}`);
            collection[path] = lines.join("\n");
            console.debug(
              `[mock] disabled ${mockedModule} import in ${path} as it will be mocked`,
            );
          }
        }
      }
    }
  }

  const {
    code: { test, user, shared },
    dependencyOrder,
  } = makeDependencyGraph(code);

  let entry: string = "";

  // Enable logger for user code
  for (const filePath in user) {
    const userCode = `
import { log } from '${globalLogger}'

${user[filePath]}
  `;

    if (userCode.includes("module.exports = ")) {
      throw new SubmissionError(
        "You must use ESM export syntax. Remove all references to module.exports and exports.<...> from the code (including comments) to continue.",
      );
    }

    user[filePath] = userCode;
  }

  // Run tests for test code
  for (const filePath in test) {
    if (
      !test[filePath].includes("describe(") &&
      Object.keys(test).length === 1
    ) {
      test[filePath] = "finishSuite()";
    }

    // Delete globals import
    const lines = test[filePath]
      .trim()
      .replace(
        /import\s+.*?\s+from\s+['"]@jest\/globals['"];?/s,
        (importText) => `/* ${importText} */`,
      )
      .split("\n");
  
    // Add test helper below main `import { ... } from './solution`
    let injectIndex = lines.findIndex((l) => l.indexOf("from ") !== -1) + 1;
    if (injectIndex === -1) {
      lines.unshift(...TEST_HELPER);
    } else {
      lines.splice(injectIndex, 0, TEST_HELPER);
    }

    // Add log listener
    const logImport = `import { addListener as addLogListener } from '${globalLogger}'`;
    if (injectIndex === -1) {
      lines.unshift(logImport);
    } else {
      lines.splice(injectIndex, 0, logImport);
    }

    test[filePath] = lines.join("\n");
  }

  for (const filePath of dependencyOrder) {
    const code = user[filePath] ?? test[filePath] ?? shared[filePath];
    const importedCode = filePath.endsWith('.html') || filePath.endsWith('.htm') ? esmHtml`${code}` : filePath.endsWith('.json') ? esmJson`${code}` : esm`${code}`;

    urls[filePath] = importedCode;
    if (filePath in test) {
      entry = importedCode;
    }

    replaceImports({ from: filePath, to: importedCode }, user, test, shared);
  }

  if (Object.keys(test).length > 1) {
    entry = makeCombinedTest(test);
    urls["combined.spec.js"] = entry;
  }

  if (entry === "") {
    throw new SubmissionError(
      `Expected entrypoint to be a test (one of: ${Object.keys(test)}), actual: (none)`,
    );
  }

  return { entry, urls };
}

function makeDependencyGraph(code: {
  test: Record<string, string>;
  user: Record<string, string>;
  shared: Record<string, string>;
}): {
  code: {
    test: Record<string, string>;
    user: Record<string, string>;
    shared: Record<string, string>;
  };
  dependencyOrder: string[];
} {
  const matchers: Record<string, RegExp> = {};
  const references: Record<string, string[]> = {};
  const referenced_bys: Record<string, string[]> = {};

  // Build matchers
  for (const mapping of [code.test, code.user, code.shared]) {
    for (const filePath in mapping) {
      const matcher = makeImportReplaceMatcher(filePath);
      matchers[filePath] = matcher;
      references[filePath] = [];
      referenced_bys[filePath] = [];
    }
  }

  // Build references
  for (const mapping of [code.test, code.user, code.shared]) {
    for (const filePath in mapping) {
      const content = mapping[filePath];

      for (const [referencePath, matcher] of Object.entries(matchers)) {
        if (matcher.test(content)) {
          // Break on cyclic references
          if (filePath === referencePath) {
            throw new SubmissionError(
              `Self-references are not allowed ${filePath} -> ${referencePath}`,
            );
          }

          references[filePath].push(referencePath);
          referenced_bys[referencePath].push(filePath);
        }
      }
    }
  }

  const dependencyOrder: string[] = [];
  while (Object.keys(references).length !== 0) {
    // What is safe to add are those things that don't refer to anything else
    // that has not yet been processed.
    const safeToAdd = Object.entries(references)
      .filter(([, fileRefs]) => fileRefs.length === 0)
      .map(([filePath]) => filePath);

    // Break on cyclic references
    if (safeToAdd.length === 0) {
      throw new SubmissionError(
        `Cyclic references are not allowed: ${JSON.stringify(references)}`,
      );
    }

    for (const filePath of safeToAdd) {
      dependencyOrder.push(filePath);
      delete references[filePath];

      // Now remove it from the other lists
      Object.values(references).forEach((otherReferences) => {
        const i = otherReferences.indexOf(filePath);
        if (i === -1) {
          // next
          return;
        }

        otherReferences.splice(i, 1);
      });
    }
  }

  console.debug(`[prepare] built dependency tree`, dependencyOrder);

  return { code, dependencyOrder };
}

function makeImportReplaceMatcher(path: string) {
  const importName = importNameWithoutExtension(path);

  // TODO: check if html and json need to be turned into fetch
  return new RegExp(
    `["']\\./${importName}(?:\\.(?:ts|js|mjs|cjs|mts|cts|tsx|jsx|html|json))?["'];`,
  );
}

function replaceImports(
  { from, to }: { from: string; to: string },
  ...collections: Record<string, string>[]
) {
  const matcher = makeImportReplaceMatcher(from);

  for (const collection of collections) {
    for (const key in collection) {
      collection[key] = collection[key].replace(matcher, `"${to}";`);
    }
  }
}

function makeCombinedTest(test: Record<string, string>) {
  if (Object.keys(test).length > 1) {
    throw new UnsupportedError(
      "Combining test files into a single test file is currently unsupported",
    );
  }

  return esm`${Object.values(test)[0]}`;
}

/**
 * Code that will act as a global logger that is capable of pushing the logged
 * messages to the test run
 */
const LOGGER = `
const listeners = []
const originalConsoleLog = console.log.bind(console)

export function log(...args) {
  args.forEach((arg) => {
    const message = JSON.stringify(arg, null, 2)
    listeners.forEach((listener) => listener(message))
  })

  originalConsoleLog(...args)
}

console.log = log

export function addListener(listener) {
  listeners.push(listener);
  return () => {
    const index = listeners.indexOf(listener);
    if (index !== -1) {
      listeners.splice(index, 1);
    }
  }
}
`;

/**
 * Code that exports a live binding so that things can be mocked in multiple
 * modules.
 */
const MOCKER = `
const mocks = {}

export function register(name, value) {
  mocks[name] = value
}
`;
