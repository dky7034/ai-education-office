import type { Server, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import {
  cursorText,
  parseCursor,
  type ActivityCursor,
} from "./activityEvents.ts";
import { sessionAccount } from "./auth.ts";
import type { Store } from "./store.ts";

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
      cursor: ActivityCursor;
      sent: number;
      pinged: number;
      alive: boolean;
    }
  >();
  type Client = typeof clients extends Map<WebSocket, infer C> ? C : never;
  function ready(
    ws: WebSocket,
    client: Client,
    reset: boolean,
    head: ActivityCursor,
  ) {
    ws.send(
      JSON.stringify({
        type: "ready",
        cursor: cursorText(client.cursor),
        head: head.sequence,
        reset,
      }),
    );
    client.sent = Date.now();
  }
  function deliver(ws: WebSocket, client: Client) {
    if (
      sessionAccount(store, client.req)?.id !== client.account ||
      ws.bufferedAmount > 64 * 1024
    ) {
      ws.terminate();
      return;
    }
    const head = store.activityHead(client.account);
    if (
      head.streamId !== client.cursor.streamId ||
      head.sequence < client.cursor.sequence
    ) {
      client.cursor = head;
      ready(ws, client, true, head);
      return;
    }
    const events = store.activityAfter(
      client.account,
      client.cursor.sequence,
      head.sequence,
    );
    if (head.sequence > client.cursor.sequence) {
      // Missing/deleted history must trigger a full snapshot, never a silent skip.
      if (
        !events.length ||
        events.some(
          (event, i) => event.sequence !== client.cursor.sequence + i + 1,
        )
      ) {
        client.cursor = head;
        ready(ws, client, true, head);
        return;
      }
      const from = client.cursor.sequence,
        to = events.at(-1)!.sequence;
      ws.send(
        JSON.stringify({
          type: "events",
          streamId: head.streamId,
          from,
          to,
          head: head.sequence,
          events,
        }),
      );
      client.cursor = { streamId: head.streamId, sequence: to };
      client.sent = Date.now();
    } else if (Date.now() - client.sent >= 15000) {
      ws.send(
        JSON.stringify({
          type: "heartbeat",
          cursor: cursorText(client.cursor),
        }),
      );
      client.sent = Date.now();
    }
  }
  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const reject = (status: number) =>
      socket.end(
        `HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
      );
    try {
      const url = new URL(req.url ?? "", "http://localhost");
      const expected = `${"encrypted" in req.socket && req.socket.encrypted ? "https" : "http"}://${req.headers.host}`;
      if (
        url.pathname !== "/api/jobs/updates" ||
        req.headers.origin !== expected
      )
        return reject(403);
      const supplied = url.searchParams.get("cursor");
      if (
        [...url.searchParams.keys()].some(
          (key) => !["account", "cursor"].includes(key),
        ) ||
        url.searchParams.getAll("account").length !== 1 ||
        url.searchParams.getAll("cursor").length > 1 ||
        (supplied !== null && !parseCursor(supplied))
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
      const latest = store.activityHead(account.id);
      const previous = supplied ? parseCursor(supplied)! : null;
      const reset =
        !previous ||
        previous.streamId !== latest.streamId ||
        previous.sequence > latest.sequence;
      wss.handleUpgrade(req, socket, head, (ws) => {
        const client: Client = {
          req,
          account: account.id,
          cursor: reset ? latest : previous!,
          sent: Date.now(),
          pinged: Date.now(),
          alive: true,
        };
        clients.set(ws, client);
        ws.on("error", () => ws.terminate());
        ws.on("close", () => clients.delete(ws));
        ws.on("pong", () => {
          client.alive = true;
        });
        ws.on("message", () => ws.close(1008, "Read only"));
        ready(ws, client, reset, latest);
        deliver(ws, client);
      });
    } catch {
      reject(503);
    }
  };
  server.on("upgrade", onUpgrade);
  const timer = setInterval(() => {
    for (const [ws, client] of clients) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      try {
        if (
          sessionAccount(store, client.req)?.id !== client.account ||
          ws.bufferedAmount > 64 * 1024
        ) {
          ws.terminate();
          continue;
        }
        if (Date.now() - client.pinged >= 15000) {
          if (!client.alive) {
            ws.terminate();
            continue;
          }
          client.alive = false;
          client.pinged = Date.now();
          ws.ping();
        }
        deliver(ws, client);
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
