import { SubmissionError } from "./errors";
import type { OutputOptions, TranspileFn } from "./types";

type Writeable<T> = { -readonly [P in keyof T]: T[P] };

export function readConfig<Custom extends OutputOptions = OutputOptions>(
  solutionFiles: Record<string, string>,
): ExerciseConfig<Custom> {
  const configJson = solutionFiles[".meta/config.json"];
  if (!configJson) {
    throw new SubmissionError(
      `Expected '.meta/config.json' to exist. Actual: ${Object.keys(solutionFiles)}`,
    );
  }

  const { files, ...parsed } = JSON.parse(configJson) as Omit<
    ExerciseConfig<Custom>,
    "files"
  > & {
    files: { [P in keyof ExerciseConfig<Custom>["files"]]: readonly string[] };
  };
  const config = {
    ...parsed,
    files: {} as Writeable<ExerciseConfig<OutputOptions>["files"]>,
  };

  (Object.keys(files) as Array<keyof typeof files>).forEach((key) => {
    config.files[key] = files[key]!.map(globToMatcher);
  });

  // Old exercise support
  if (!("custom" in config)) {
    (config as any).custom = {};
  }

  return config;
}

function globToMatcher(glob: string): RegExp {
  // TODO escape entire glob? Unlikely to have regex characters in file names
  // because of Windows restrictions, but probably need to do it anyway...
  return new RegExp(
    glob
      .replaceAll(".", "\\.")
      .replaceAll(/(?<!\*)\*(?!\*)/g, "[^/]*")
      .replaceAll("**", ".*?")
      .concat("$"),
  );
}

export type SolutionCode = {
  test: Record<string, string>;
  user: Record<string, string>;
  shared: Record<string, string>;
};

export function findCode(
  config: ExerciseConfig<OutputOptions>,
  files: Readonly<Record<string, string>>,
  userPaths: readonly string[],
  transpile: TranspileFn,
): SolutionCode {
  // Get all user provided code
  const userCodes = findUserCode(config, files, userPaths);
  for (const path in userCodes) {
    userCodes[path] = transpile(userCodes[path], "code");
  }

  // Get all test code (strip user submitted)
  const testCodes = findTestCode(config, files, userPaths);
  for (const path in testCodes) {
    testCodes[path] = transpile(testCodes[path], "test");
  }

  // Get all the library code (strip user submitted)
  const libraryCode = findLibCode(config, files, userPaths);
  for (const path in libraryCode) {
    libraryCode[path] = transpile(
      libraryCode[path],
      path.includes(".spec.") || path.includes(".test.") ? "test" : "code",
    );
  }

  return { test: testCodes, shared: libraryCode, user: userCodes };
}

export function findUserCode(
  config: ExerciseConfig<OutputOptions>,
  files: Readonly<Record<string, string>>,
  userPaths: readonly string[],
): Record<string, string> {
  userPaths = userPaths.filter((path) =>
    config.files.solution.some((pattern) => pattern.test(path)),
  );

  if (userPaths.length === 0) {
    throw new SubmissionError(
      `Expected at least one solution file to be submitted (${config.files.solution}). Actual: ${Object.keys(files)}`,
    );
  }

  return userPaths.reduce<Record<string, string>>((result, path) => {
    if (Object.prototype.hasOwnProperty.call(files, path)) {
      result[path] = files[path];
    }
    return result;
  }, {});
}

export function findLibCode(
  config: ExerciseConfig<OutputOptions>,
  files: Readonly<Record<string, string>>,
  userPaths: readonly string[],
): Record<string, string> {
  if (!config.files.extra && !config.files.editor) {
    return {};
  }

  let libPaths = Object.keys(files).filter((path) =>
    (config.files.extra || []).some((pattern) => pattern.test(path)),
  );

  let editorPaths = Object.keys(files).filter((path) =>
    (config.files.editor || []).some((pattern) => pattern.test(path)),
  );

  if (userPaths && editorPaths.some((path) => userPaths.includes(path))) {
    throw new SubmissionError(
      `Expected the provided non-solution files to not have changed. The user provided files (${userPaths.join(", ")}) overlaps with the configured read-only files (${editorPaths.join(", ")}).`,
    );
  }

  return libPaths
    .concat(editorPaths)
    .reduce<Record<string, string>>((result, path) => {
      if (Object.prototype.hasOwnProperty.call(files, path)) {
        result[path] = files[path];
      }
      return result;
    }, {});
}

export function findTestCode(
  config: ExerciseConfig<OutputOptions>,
  files: Readonly<Record<string, string>>,
  userPaths: readonly string[],
): Record<string, string> {
  let testPaths = Object.keys(files).filter((path) =>
    config.files.test.some((pattern) => pattern.test(path)),
  );

  if (userPaths && testPaths.some((path) => userPaths.includes(path))) {
    throw new SubmissionError(
      `Expected the provided non-solution files to not have changed. The user provided files (${userPaths.join(", ")}) overlaps with the configured test files (${testPaths.join(", ")}).`,
    );
  }

  if (testPaths.length === 0) {
    throw new SubmissionError(
      `Expected at least one test file to be included (${config.files.test}). Actual: ${Object.keys(files)}`,
    );
  }

  return testPaths.reduce<Record<string, string>>((result, path) => {
    if (Object.prototype.hasOwnProperty.call(files, path)) {
      result[path] = files[path];
    }
    return result;
  }, {});
}

export type ExerciseConfig<Custom extends OutputOptions = OutputOptions> =
  Readonly<{
    authors: readonly string[];
    contributors: readonly string[];
    files: Readonly<{
      solution: readonly RegExp[];
      test: readonly RegExp[];
      exemplar: readonly RegExp[];
      editor?: readonly RegExp[];
      extra?: readonly RegExp[];
    }>;
    blurb: string;
    custom?: Custom;
  }>;

export type CustomJavaScriptConfig = {
  "version.tests.compatibility": "jest-27" | "jest-29";
  "flag.tests.task-per-describe": boolean;
  "flag.tests.may-run-long": boolean;
  "flag.tests.includes-optional": boolean;
};

export function importNameWithoutExtension(path: string, sep = "/"): string {
  const userPathParts = path.split(sep);
  const fileName = userPathParts.pop() || "";
  const fileNameParts = fileName.split(".");
  fileNameParts.pop();

  const importName = [...userPathParts, fileNameParts.join(".")].join(sep);

  return importName;
}

/**
 * Turns code into an ES Module (blob) so it can be references on the web
 * without requiring to exist on disk / url.
 *
 * Do not forget to clean up the blob after it's no longer necessary.
 *
 * @param code
 * @returns blob://<....>
 */
const makeEsModulizer = (type = 'text/javascript') => ({ raw }: TemplateStringsArray, ...vals: string[]) =>
  URL.createObjectURL(
    new Blob([String.raw({ raw } as any, ...vals)], {
      type,
    }),
  );

export const esm = makeEsModulizer();
export const esmHtml = makeEsModulizer('text/html');
export const esmJson = makeEsModulizer('application/json');