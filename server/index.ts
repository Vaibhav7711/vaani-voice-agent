import { createServer } from "node:http";
import next from "next";
import { WebSocketServer } from "ws";
import { closeInfrastructure, ensureInfrastructure } from "../lib/infrastructure";
import { RealtimeAgentRuntime } from "../lib/realtime/runtime";

async function main() {
  const development = process.env.NODE_ENV !== "production";
  const hostname = process.env.HOST ?? "127.0.0.1";
  const port = Number(process.env.PORT ?? 3000);
  const app = next({ dev: development, hostname, port });
  const handle = app.getRequestHandler();

  await app.prepare();
  await ensureInfrastructure();

  const server = createServer((request, response) => handle(request, response));
  const realtime = new WebSocketServer({ server, path: "/api/realtime", maxPayload: 64 * 1024 });

  realtime.on("connection", async (socket) => {
    const runtime = new RealtimeAgentRuntime(socket);
    socket.on("message", (data, binary) => {
      if (binary) runtime.receiveAudio(Buffer.from(data as Buffer));
      else void runtime.receiveText(data.toString());
    });
    socket.on("close", () => runtime.close());
    socket.on("error", () => runtime.close());

    try {
      await runtime.start();
    } catch (error) {
      socket.send(JSON.stringify({
        type: "error",
        code: "provider_connection_failed",
        message: error instanceof Error ? error.message : "Could not connect the inference provider",
        recoverable: false,
      }));
      socket.close(1011, "Inference provider unavailable");
    }
  });

  server.listen(port, hostname, () => {
    console.log(`Vaani runtime ready at http://${hostname}:${port}`);
    console.log(`Realtime voice endpoint ws://${hostname}:${port}/api/realtime`);
  });

  function shutdown() {
    realtime.close();
    server.close(() => {
      void closeInfrastructure().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 5000).unref();
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main().catch((error) => {
  console.error("Vaani runtime failed to start", error);
  process.exit(1);
});
