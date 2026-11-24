import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { runHealth } from "../src/health.js";
import { ALLOW_ALL } from "./broker-fixtures.js";
import { adapterUrl, startHarness } from "./http-rig.js";
import type { Harness } from "./http-rig.js";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

describe("GET /healthz", () => {
  it("answers 200 ok to anyone, with no token and nothing else in the answer", async () => {
    h = await startHarness({ policy: ALLOW_ALL });
    const response = await fetch(adapterUrl(h, "/healthz"));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok\n");
    // Only what Node itself adds: no server name, no version, no count.
    for (const name of response.headers.keys()) expect(["connection", "content-length", "content-type", "date", "keep-alive", "transfer-encoding"]).toContain(name);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    // A token does not change the answer, and a query string does not leak anything either.
    expect(await (await fetch(adapterUrl(h, "/healthz?verbose=1"), { headers: { authorization: "Bearer nonsense" } })).text()).toBe("ok\n");
  });

  it("only answers a read", async () => {
    h = await startHarness({ policy: ALLOW_ALL });
    expect((await fetch(adapterUrl(h, "/healthz"), { method: "POST", body: "{}" })).status).toBe(405);
    expect((await fetch(adapterUrl(h, "/healthz"), { method: "HEAD" })).status).toBe(200);
  });

  it("answers 503 when the poll loop has not completed a run for 30 s, and 200 again after the next run", async () => {
    const clock = { t: 5_000_000 };
    const loops: (() => void)[] = [];
    h = await startHarness({
      policy: ALLOW_ALL,
      effects: {
        now: () => clock.t,
        every: (_ms, fn) => {
          loops.push(fn);
          return () => undefined;
        },
      },
    });
    expect((await fetch(adapterUrl(h, "/healthz"))).status).toBe(200);
    clock.t += 30_000;
    expect((await fetch(adapterUrl(h, "/healthz"))).status).toBe(200);
    clock.t += 1;
    const stale = await fetch(adapterUrl(h, "/healthz"));
    expect(stale.status).toBe(503);
    expect(await stale.text()).toBe("not ok\n");
    expect((await fetch(adapterUrl(h, "/healthz"), { method: "HEAD" })).status).toBe(503);
    // The first loop the broker started is the poll.
    loops[0]?.();
    expect((await fetch(adapterUrl(h, "/healthz"))).status).toBe(200);
  });

  it("leaves the token-guarded routes as they were", async () => {
    h = await startHarness({ policy: ALLOW_ALL });
    expect((await fetch(adapterUrl(h, "/adapter/stream"))).status).toBe(401);
  });
});

describe("agent-gateway health", () => {
  const io = () => {
    const err: string[] = [];
    return { err, effects: (status: number | Error) => ({ fetch: () => (status instanceof Error ? Promise.reject(status) : Promise.resolve({ status })), err: (l: string) => err.push(l) }) };
  };

  it("exits 0 on a 200 and 1 on anything else or no answer", async () => {
    const rig = io();
    expect(await runHealth(["http://x/healthz"], {}, rig.effects(200))).toBe(0);
    expect(await runHealth(["http://x/healthz"], {}, rig.effects(503))).toBe(1);
    expect(await runHealth(["http://x/healthz"], {}, rig.effects(new Error("refused")))).toBe(1);
    expect(rig.err).toEqual(["unhealthy: answered 503", "unhealthy: no answer"]);
  });

  it("takes the address from the environment, and refuses to guess one", async () => {
    const rig = io();
    let asked = "";
    const effects = { fetch: (url: string) => ((asked = url), Promise.resolve({ status: 200 })), err: () => undefined };
    expect(await runHealth([], { AGENT_GATEWAY_HEALTH_URL: "http://env/healthz" }, effects)).toBe(0);
    expect(asked).toBe("http://env/healthz");
    expect(await runHealth([], {}, rig.effects(200))).toBe(2);
    expect(await runHealth(["a", "b"], {}, rig.effects(200))).toBe(2);
  });

  it("works against a running broker through the program's own entry", async () => {
    h = await startHarness({ policy: ALLOW_ALL });
    const err: string[] = [];
    const io2 = { out: () => undefined, err: (l: string) => err.push(l), now: () => Date.now() };
    expect(await runCli(["health", adapterUrl(h, "/healthz")], {}, io2)).toBe(0);
    await h.close();
    h = undefined;
    expect(await runCli(["health", "http://127.0.0.1:1/healthz"], {}, io2)).toBe(1);
  });
});
