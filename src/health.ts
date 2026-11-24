/**
 * `agent-gateway health [url]`: asks the broker's liveness path and exits 0 when
 * it answers 200, 1 otherwise. It is for a container's healthcheck, where curl
 * is not installed. The address is the argument, or AGENT_GATEWAY_HEALTH_URL.
 */
export type HealthEffects = {
  readonly fetch: (url: string, init: { readonly signal: AbortSignal }) => Promise<{ readonly status: number }>;
  readonly err: (line: string) => void;
};

export const HEALTH_TIMEOUT_MS = 3000;

/** Returns the exit code. */
export async function runHealth(args: readonly string[], env: Readonly<Record<string, string | undefined>>, effects: HealthEffects): Promise<number> {
  const url = args[0] ?? env["AGENT_GATEWAY_HEALTH_URL"];
  if (args.length > 1 || url === undefined || url === "") {
    effects.err("usage: agent-gateway health <url>   (or set AGENT_GATEWAY_HEALTH_URL)");
    return 2;
  }
  try {
    const response = await effects.fetch(url, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    if (response.status === 200) return 0;
    effects.err(`unhealthy: answered ${response.status}`);
    return 1;
  } catch {
    effects.err("unhealthy: no answer");
    return 1;
  }
}
