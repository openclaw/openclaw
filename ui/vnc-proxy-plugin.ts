import * as net from "net";
import type { PluginOption } from "vite";
import { WebSocketServer, type RawData } from "ws";

// Use environment variables or hardcoded defaults from the external script
const VNC_HOST = process.env.OPENCLAW_VNC_HOST || "localhost";
const VNC_PORT = parseInt(process.env.OPENCLAW_VNC_PORT || "5900", 10);
const WS_PATH = "/vnc";

export function vncProxyPlugin(): PluginOption {
  return {
    name: "openclaw-vnc-proxy",
    configureServer(server) {
      // Create a WebSocket server that shares the Vite HTTP server
      const wss = new WebSocketServer({
        noServer: true,
        path: WS_PATH,
        perMessageDeflate: false,
      });

      console.log(`🚀 [Proxy] VNC WebSocket proxy injected at ${WS_PATH}`);
      console.log(`   Forwarding to: ${VNC_HOST}:${VNC_PORT}`);

      wss.on("connection", (ws, req) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        const target = url.searchParams.get("target");

        let host = VNC_HOST;
        let port = VNC_PORT;

        if (target) {
          if (target.includes(":")) {
            const parts = target.split(":");
            host = parts[0];
            const p = parseInt(parts[1], 10);
            if (!isNaN(p)) {
              port = p;
            }
          } else {
            host = target;
          }
        }

        console.log(`[VNC Proxy] Client connected to ${WS_PATH}, forwarding to ${host}:${port}`);

        const tcpSocket = net.connect(port, host);

        tcpSocket.on("data", (data) => {
          if (ws.readyState === ws.OPEN) {
            ws.send(data);
          }
        });

        ws.on("message", (data: RawData) => {
          if (!tcpSocket.writable) {
            return;
          }

          if (Buffer.isBuffer(data)) {
            tcpSocket.write(data);
          } else if (Array.isArray(data)) {
            tcpSocket.write(Buffer.concat(data));
          } else {
            tcpSocket.write(Buffer.from(data));
          }
        });

        ws.on("close", () => tcpSocket.end());
        tcpSocket.on("close", () => ws.close());

        tcpSocket.on("error", (e) => {
          console.error("[VNC Proxy] TCP Error:", e.message);
          ws.close();
        });
        ws.on("error", (e) => {
          console.error("[VNC Proxy] WebSocket Error:", e.message);
          tcpSocket.end();
        });
      });

      // Hook into Vite's HTTP server upgrade event
      server.httpServer?.on("upgrade", (req, socket, head) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (url.pathname === WS_PATH) {
          wss.handleUpgrade(req, socket, head, (ws) => {
            wss.emit("connection", ws, req);
          });
        }
      });
    },
  };
}
