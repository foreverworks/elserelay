/** The gateway's own command line, and the audit it prints. */
import { execFile } from "node:child_process";
import { oneLine } from "./util.ts";

export type AuditRow = { readonly raw: string; readonly event: string; readonly state: string; readonly from: string; readonly to: string; readonly id: string; readonly detail: string };

export function parseAudit(output: string): AuditRow[] {
  const rows: AuditRow[] = [];
  for (const raw of output.split("\n")) {
    const m = /^(\S+) (\S+) (\S+) (\S+) -> (\S+) (\S+)(?: \((.*)\))?$/.exec(raw);
    if (m !== null) rows.push({ raw, event: m[2] as string, state: m[3] as string, from: m[4] as string, to: m[5] as string, id: m[6] as string, detail: m[7] ?? "" });
  }
  return rows;
}

export type Cli = {
  /** Runs one command of the gateway's CLI against this run's config and returns what it printed. */
  readonly run: (args: readonly string[]) => Promise<string>;
  readonly audit: () => Promise<AuditRow[]>;
  readonly stateOf: (id: string) => Promise<string | undefined>;
};

export function createCli(cliPath: string, configPath: string): Cli {
  const run = (args: readonly string[]): Promise<string> =>
    new Promise((done, fail) => {
      execFile(process.execPath, [cliPath, ...args, "--config", configPath], { encoding: "utf8" }, (error, stdout, stderr) => {
        if (error !== null) fail(new Error(oneLine(stderr || error.message)));
        else done(`${stdout}${stderr}`);
      });
    });
  const audit = async (): Promise<AuditRow[]> => parseAudit(await run(["audit", "--since", "2020-01-01T00:00:00Z"]));
  const stateOf = async (id: string): Promise<string | undefined> => (await audit()).filter((r) => r.id === id).at(-1)?.state;
  return { run, audit, stateOf };
}

/** The distinct message ids sent from a container to another, by the `container/session` form the audit prints. */
export const idsBetween = (rows: readonly AuditRow[], from: string, to: string): string[] => [
  ...new Set(rows.filter((r) => r.from.startsWith(`${from}/`) && r.to.startsWith(`${to}/`)).map((r) => r.id)),
];

export const finalState = (rows: readonly AuditRow[], id: string): string | undefined => rows.filter((r) => r.id === id).at(-1)?.state;
