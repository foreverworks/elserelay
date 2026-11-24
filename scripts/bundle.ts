/**
 * Bundles the program into one file, dist/elserelay.mjs, that a machine with Node and nothing else can run:
 * no npm, no node_modules. Dynamic imports in src/cli.ts are bundled into the same file, so the file never
 * loads a second one. `node:` modules stay external, because Node supplies them.
 *
 *   npm run bundle
 */
import { build, type Plugin } from "esbuild";
import { chmod, readFile } from "node:fs/promises";

const out = "dist/elserelay.mjs";
const { version } = JSON.parse(await readFile("package.json", "utf8")) as { version: string };

/**
 * An ES module's imports run before anything else, so a bundled `import "node:sqlite"` would load SQLite for every
 * command, and Node 22 prints an experimental-feature warning when it does. Only the broker and the Antigravity driver
 * open a database: this loads the module at that moment, so a hook or an adapter never touches it.
 */
const lazySqlite: Plugin = {
  name: "lazy-sqlite",
  setup(b) {
    b.onResolve({ filter: /^node:sqlite$/ }, () => ({ path: "node:sqlite", namespace: "lazy-sqlite" }));
    b.onLoad({ filter: /.*/, namespace: "lazy-sqlite" }, () => ({
      contents: [
        "export class DatabaseSync {",
        "  constructor(...args) {",
        '    return new (process.getBuiltinModule("node:sqlite").DatabaseSync)(...args);',
        "  }",
        "}",
      ].join("\n"),
      loader: "js",
    }));
  },
};

await build({
  entryPoints: ["src/cli.ts"],
  outfile: out,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  splitting: false,
  plugins: [lazySqlite],
  // The broker reports the version of package.json; with no file to read, it is written in.
  define: { ELSERELAY_VERSION: JSON.stringify(version) },
  legalComments: "none",
  // Dependencies that are still CommonJS (ws) call require() for Node's own modules; ESM has none until this.
  banner: {
    js: [
      'import { createRequire as __elserelayCreateRequire } from "node:module";',
      "const require = __elserelayCreateRequire(import.meta.url);",
    ].join("\n"),
  },
  logLevel: "info",
});
await chmod(out, 0o755);
