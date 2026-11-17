import { createServer, request, type IncomingMessage, type Server } from "node:http";
import { connect } from "node:net";
import { hostAllowed, sameOrigin } from "./host.ts";

/**
 * Frigate's UI behind the Percezione login, on its own port.
 * - Frigate is published only on 127.0.0.1 (unauthenticated port): this proxy is the way in from the LAN.
 * - The session cookie is per host, not per port, so whoever is logged into Percezione is let through; everyone
 *   else is sent to the Percezione login.
 * - A dedicated port instead of a sub-path, because Frigate's UI expects to live at the root.
 */
export interface FrigateProxyDeps {
  frigateUrl: string;
  authed(req: IncomingMessage): boolean;
  /** Percezione's port, for the redirect to the login */
  uiPort: number;
  /** names of your own domain besides the local ones (src/host.ts) */
  hosts?: string[];
}

export function startFrigateProxy(d: FrigateProxyDeps, port: number, host: string): Promise<Server> {
  const target = new URL(d.frigateUrl);
  const targetPort = Number(target.port || 80);

  const server = createServer((req, res) => {
    const unsafe = !["GET", "HEAD", "OPTIONS"].includes(req.method ?? "GET");
    if (!hostAllowed(req.headers.host, d.hosts) || (unsafe && !sameOrigin(req.headers.origin, req.headers.host))) {
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Unknown host name: open Percezione by its address, or add the name to PERCEZIONE_HOSTS");
      return;
    }
    if (!d.authed(req)) {
      const hostname = (req.headers.host ?? "localhost").replace(/:\d+$/, "");
      res.writeHead(302, { Location: `http://${hostname}:${d.uiPort}/` });
      res.end();
      return;
    }
    const upstream = request(
      { hostname: target.hostname, port: targetPort, method: req.method, path: req.url, headers: { ...req.headers, host: target.host } },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on("error", (err) => {
      if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(`Frigate unreachable: ${err.message}`);
    });
    req.pipe(upstream);
  });

  // WebSocket (live view, events): the raw upgrade request is replayed to Frigate and the sockets are joined
  server.on("upgrade", (req, socket, head) => {
    if (!hostAllowed(req.headers.host, d.hosts) || !sameOrigin(req.headers.origin, req.headers.host) || !d.authed(req)) {
      socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
      return;
    }
    const up = connect(targetPort, target.hostname, () => {
      const headers = Object.entries({ ...req.headers, host: target.host })
        .flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => `${k}: ${x}`) : v === undefined ? [] : [`${k}: ${v}`]))
        .join("\r\n");
      up.write(`${req.method} ${req.url} HTTP/1.1\r\n${headers}\r\n\r\n`);
      if (head.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    const close = () => {
      up.destroy();
      socket.destroy();
    };
    up.on("error", close);
    socket.on("error", close);
  });

  return new Promise((done) => server.listen(port, host, () => done(server)));
}
