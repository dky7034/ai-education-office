import type { Server, IncomingMessage } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { sessionAccount } from "./auth.ts";
import type { Store } from "./store.ts";

// Notifications invalidate read models. Reconnection always starts with a new
// snapshot, so correctness does not depend on a process-local event history.
export function attachJobUpdates(
  server: Server,
  store: Store,
  intervalMs = 1000,
) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  const clients = new Map<
    WebSocket,
    {
      req: IncomingMessage;
      account: string;
      revision: string;
      sent: number;
      alive: boolean;
    }
  >();
  // Keep a named listener so shutdown removes it before closing SQLite.
  const onUpgrade = (
    req: IncomingMessage,
    socket: import("node:stream").Duplex,
    head: Buffer,
  ) => {
    const reject = (status: number) => {
      socket.end(
        `HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
      );
    };
    try {
      const url = new URL(req.url ?? "", "http://localhost");
      const origin = req.headers.origin;
      const expected = `${"encrypted" in req.socket && req.socket.encrypted ? "https" : "http"}://${req.headers.host}`;
      if (
        url.pathname !== "/api/jobs/updates" ||
        !origin ||
        origin !== expected
      )
        return reject(403);
      if (
        [...url.searchParams.keys()].some((key) => key !== "account") ||
        url.searchParams.getAll("account").length !== 1
      )
        return reject(400);
      const account = sessionAccount(store, req);
      if (!account || url.searchParams.get("account") !== account.id)
        return reject(401);
      if (
        wss.clients.size >= 256 ||
        [...clients.values()].filter((c) => c.account === account.id).length >=
          8
      )
        return reject(429);
      wss.handleUpgrade(req, socket, head, (ws) => {
        const revision = store.activityRevision(account.id);
        const client = {
          req,
          account: account.id,
          revision,
          sent: Date.now(),
          alive: true,
        };
        clients.set(ws, client);
        ws.on("error", () => ws.terminate());
        ws.on("close", () => clients.delete(ws));
        ws.on("pong", () => {
          client.alive = true;
        });
        // This endpoint cannot accept commands or replay mutations.
        ws.on("message", () => ws.close(1008, "Read only"));
        ws.send(JSON.stringify({ type: "snapshot", revision }));
      });
    } catch {
      reject(503);
    }
  };
  server.on("upgrade", onUpgrade);
  const timer = setInterval(() => {
    const revisions = new Map<string, string>();
    for (const [ws, client] of clients) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      try {
        if (sessionAccount(store, client.req)?.id !== client.account) {
          ws.close(4001, "Session ended");
          // Do not retain unauthenticated closing sockets indefinitely.
          ws.terminate();
          continue;
        }
        if (ws.bufferedAmount > 64 * 1024) {
          ws.terminate();
          continue;
        }
        let revision = revisions.get(client.account);
        if (!revision) {
          revision = store.activityRevision(client.account);
          revisions.set(client.account, revision);
        }
        const heartbeat = Date.now() - client.sent >= 15000;
        if (heartbeat && !client.alive) {
          ws.terminate();
          continue;
        }
        if (revision !== client.revision || heartbeat) {
          ws.send(JSON.stringify({ type: "snapshot", revision }));
          client.revision = revision;
          client.sent = Date.now();
          if (heartbeat) {
            client.alive = false;
            ws.ping();
          }
        }
      } catch {
        ws.terminate();
      }
    }
  }, intervalMs);
  timer.unref();
  return {
    close() {
      clearInterval(timer);
      server.off("upgrade", onUpgrade);
      for (const ws of clients.keys()) ws.terminate();
      clients.clear();
      wss.close();
    },
  };
}
