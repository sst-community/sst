import fs from "fs";
import path from "path";
import ts from "typescript";
import { FileContext, type Finding, type Namespace } from "./engine";
import { rules } from "./rules";

export type { Finding, Namespace };

export interface CodemodInput {
  /** The app's folder, where `sst.config.ts` is. */
  root: string;
  /** Where the 5.0 components are: `"v5"` until the swap, `""` after. */
  namespace: Namespace;
  /** The config, by default `sst.config.ts` in `root`. */
  config?: string;
  /** Reads a file, for tests: by default the disk. */
  read?: (file: string) => string | undefined;
}

export interface CodemodResult {
  /** Each file it changed, with its text before and after. */
  files: { file: string; before: string; after: string }[];
  /** What it changed. */
  changes: Finding[];
  /** What it couldn't do, with what to write. */
  notes: Finding[];
}

/**
 * Rewrite an app's config for SST 5.0: `sst.config.ts` and the files it
 * imports, but not packages. It reads them with TypeScript's parser and
 * follows each variable to what it holds by its symbol; it doesn't need SST's
 * types. Nothing is written: the CLI writes `files`.
 */
export function codemod(input: CodemodInput): CodemodResult {
  const root = path.resolve(input.root);
  const config = path.resolve(root, input.config ?? "sst.config.ts");
  const read =
    input.read ??
    ((file: string) =>
      fs.existsSync(file) ? fs.readFileSync(file, "utf8") : undefined);
  // The app's own files, and nothing in a package or in `.sst`
  const own = (file: string) => {
    const relative = path.relative(root, file);
    return (
      !relative.startsWith("..") &&
      !path.isAbsolute(relative) &&
      !/(^|[\\/])(node_modules|\.sst)[\\/]/.test(relative)
    );
  };
  const options: ts.CompilerOptions = {
    allowJs: true,
    noEmit: true,
    noLib: true,
    types: [],
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.Preserve,
  };
  const host = ts.createCompilerHost(options, true);
  host.fileExists = (file) => own(file) && read(file) !== undefined;
  host.readFile = (file) => (own(file) ? read(file) : undefined);
  host.getSourceFile = (file, language) => {
    const text = own(file) ? read(file) : undefined;
    return text === undefined
      ? undefined
      : ts.createSourceFile(file, text, language, true);
  };
  host.directoryExists = () => true;
  host.getCurrentDirectory = () => root;
  const program = ts.createProgram([config], options, host);
  const checker = program.getTypeChecker();

  const result: CodemodResult = { files: [], changes: [], notes: [] };
  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile || !own(sf.fileName)) continue;
    const file = path.relative(root, sf.fileName);
    const ctx = new FileContext(sf, checker, input.namespace, file);
    const visit = (node: ts.Node) => {
      for (const rule of rules) {
        try {
          rule.visit(ctx, node);
        } catch (error) {
          ctx.note(
            node,
            rule.name,
            `The codemod's "${rule.name}" rule failed here: ${
              (error as Error).message
            }`,
          );
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    ctx.finish();
    let after: string | undefined;
    try {
      after = ctx.output();
    } catch (error) {
      ctx.notes.push({
        file,
        line: 1,
        rule: "edits",
        message: (error as Error).message,
      });
      ctx.changes.length = 0;
    }
    if (after !== undefined)
      result.files.push({ file, before: sf.text, after });
    result.changes.push(...ctx.changes);
    result.notes.push(...ctx.notes);
  }
  return result;
}
