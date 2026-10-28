// Fault-injecting loopback proxy. It forwards every request to one upstream (an emulator) unless a rule
// matches: `http500` answers 500 without forwarding; `hold-response` forwards, lets the upstream complete
// the write, then never answers, so the client sees a timeout after the effect happened; `http403` refuses
// without forwarding. Fault rules are TEST-ONLY and labelled as simulated faults in evidence; `http403` also
// backs the worker's Slack method filter (../slack/worker-proxy.ts).
import { createServer, request, type IncomingMessage, type ServerResponse } from "node:http";

export interface FaultRule {
  name: string;
  action: "http500" | "hold-response" | "http403";
  match: (req: { method: string; url: string; headers: IncomingMessage["headers"]; body: string }) => boolean;
  times?: number; // apply to the first N matches only
}

export async function startFaultProxy(port: number, upstream: string) {
  const target = new URL(upstream);
  const rules: FaultRule[] = [];
  const hits: Record<string, number> = {};
  const seen: { method: string; url: string; fault: string | null }[] = [];
  const held: ServerResponse[] = [];

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const info = { method: req.method ?? "GET", url: req.url ?? "/", headers: req.headers, body: body.toString("utf8") };
      const rule = rules.find((r) => (r.times === undefined || (hits[r.name] ?? 0) < r.times) && r.match(info));
      if (rule) hits[rule.name] = (hits[rule.name] ?? 0) + 1;
      seen.push({ method: info.method, url: info.url, fault: rule?.name ?? null });
      if (rule?.action === "http500") {
        res.writeHead(500, { "content-type": "application/xml" }).end("<Error><Code>InternalError</Code><Message>injected fault</Message></Error>");
        return;
      }
      if (rule?.action === "http403") return void res.writeHead(403, { "content-type": "application/json" }).end(`{"ok":false,"error":"forbidden_by_proxy"}`);
      const up = request(
        { host: target.hostname, port: target.port, method: info.method, path: info.url, headers: { ...req.headers, host: target.host } },
        (upRes) => {
          const out: Buffer[] = [];
          upRes.on("data", (c) => out.push(c));
          upRes.on("end", () => {
            if (rule?.action === "hold-response") return void held.push(res); // effect happened; reply never arrives
            res.writeHead(upRes.statusCode ?? 502, upRes.headers).end(Buffer.concat(out));
          });
        },
      );
      up.on("error", () => res.writeHead(502).end());
      up.end(body);
    });
  });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${port}`,
    rules, hits, seen,
    clear: () => rules.splice(0),
    close: () => new Promise<void>((r) => {
      for (const res of held) res.destroy();
      server.closeAllConnections();
      server.close(() => r());
    }),
  };
}
export type FaultProxy = Awaited<ReturnType<typeof startFaultProxy>>;
