import { transformSync } from "esbuild";

const options = {
  minifyWhitespace: true,
  minifySyntax: true,
  target: "es2018",
} as const;

/**
 * Minifies a module. The template is read raw, with `String.raw`: what you write
 * is the code. `minifyBody` below reads its template the other way, so code moved
 * between the two needs every backslash doubled or halved.
 */
export function minify(strings: TemplateStringsArray, ...values: unknown[]) {
  const code = String.raw(strings, ...values);
  return transformSync(code, options).code;
}

const WRAPPER = "async function __sst_minify__(){";

/**
 * Like `minify`, for statements that run inside a function, such as the code
 * spliced into a CloudFront Function's `handler`: they may `return` and `await`
 * at their top level, which a module may not. They are minified inside a
 * function that is then unwrapped.
 *
 * The template is read the way an ordinary template literal is, so code that
 * used to go through `interpolate` means the same after. Every backslash in the
 * source is doubled for it: `\\.` is `\.` and `\\d+` is `\d+`, where `\d+` would
 * be read as `d+` and a regex would stop matching digits, and `String.raw` would
 * keep both backslashes and change the regex the other way.
 */
export function minifyBody(
  strings: TemplateStringsArray,
  ...values: unknown[]
) {
  // an invalid escape (`\u` or `\x` without hex digits, or an octal one) has no
  // cooked value, and would land in the code as the text "undefined"
  if (strings.some((string) => string === undefined)) {
    throw new Error(
      "minifyBody: a template segment has an invalid escape. Double its backslash.",
    );
  }
  const code = strings.reduce(
    (out, string, i) =>
      out + string + (i < values.length ? String(values[i]) : ""),
    "",
  );
  const minified = transformSync(`${WRAPPER}${code}\n}`, options).code.trim();
  if (!minified.startsWith(WRAPPER) || !minified.endsWith("}")) {
    throw new Error(`minifyBody: unexpected esbuild output:\n${minified}`);
  }
  return minified.slice(WRAPPER.length, -1);
}
