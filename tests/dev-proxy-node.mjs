import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer, request } from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const webRoot = fileURLToPath(new URL("../apps/web/", import.meta.url));
const cookie = "fixture-session=allowed";

function httpRequest(port, path, headers) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () =>
        resolve({
          status: res.statusCode,
          body: Buffer.concat(chunks).toString(),
        }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

function wsRequest(port, headers) {
  return new Promise((resolve, reject) => {
    const req = request({
      host: "127.0.0.1",
      port,
      path: "/api/chat/socket",
      headers: {
        ...headers,
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": randomBytes(16).toString("base64"),
      },
    });
    req.on("upgrade", (res, socket, head) => {
      let received = head;
      const checkFrame = () => {
        if (received.length < 4) return;
        socket.destroy();
        resolve({ status: res.statusCode, frame: received.subarray(0, 4) });
      };
      socket.on("data", (chunk) => {
        received = Buffer.concat([received, chunk]);
        checkFrame();
      });
      socket.on("error", reject);
      checkFrame();
    });
    req.on("response", (res) => {
      res.resume();
      resolve({ status: res.statusCode });
    });
    req.on("error", reject);
    req.end();
  });
}

test(
  "dev proxy keeps HTTP Host/Origin while retaining WebSocket forwarding",
  { timeout: 30000 },
  async () => {
    const seen = [];
    const backend = createServer((req, res) => {
      const { host, origin, cookie: receivedCookie } = req.headers;
      seen.push({
        type: "http",
        host,
        origin,
        cookie: receivedCookie,
        url: req.url,
      });
      const status =
        receivedCookie !== cookie
          ? 401
          : origin && origin !== `http://${host}`
            ? 403
            : 200;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ host, origin: origin ?? null, url: req.url }));
    });
    const sockets = new Set();
    backend.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    backend.on("upgrade", (req, socket) => {
      const { host, origin, cookie: receivedCookie } = req.headers;
      seen.push({
        type: "ws",
        host,
        origin,
        cookie: receivedCookie,
        url: req.url,
      });
      if (receivedCookie !== cookie) {
        socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        return;
      }
      if (
        host !== `127.0.0.1:${backend.address().port}` ||
        (origin && origin !== `http://${host}`)
      ) {
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        return;
      }
      const accept = createHash("sha1")
        .update(
          req.headers["sec-websocket-key"] +
            "258EAFA5-E914-47DA-95CA-C5AB0DC85B11",
        )
        .digest("base64");
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      socket.write(Buffer.from([0x81, 0x02, 0x6f, 0x6b]));
    });
    await new Promise((resolve) => backend.listen(0, "127.0.0.1", resolve));
    const target = `http://127.0.0.1:${backend.address().port}`;
    const child = spawn(
      "node",
      [
        "--input-type=module",
        "-e",
        `
    import { createServer } from 'vite';
    const server = await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: true, hmr: false }, logLevel: 'silent' });
    await server.listen();
    console.log('PROXY_PORT=' + server.httpServer.address().port);
    process.on('SIGTERM', async () => { await server.close(); process.exit(0); });
  `,
      ],
      {
        cwd: webRoot,
        env: { ...process.env, CHAT_BACKEND: target },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stderr = "";
    child.stderr.on("data", (data) => {
      stderr += data;
    });
    try {
      const port = await new Promise((resolve, reject) => {
        let output = "";
        const timer = setTimeout(
          () => reject(new Error(`Vite startup timed out: ${stderr}`)),
          15000,
        );
        child.stdout.on("data", (data) => {
          output += data;
          const match = output.match(/PROXY_PORT=(\d+)/);
          if (match) {
            clearTimeout(timer);
            resolve(Number(match[1]));
          }
        });
        child.once("exit", (code) => {
          clearTimeout(timer);
          reject(new Error(`Vite exited ${code}: ${stderr}`));
        });
      });
      for (const host of [
        "127.0.0.1:5173",
        "localhost:5901",
        "localhost:5902",
      ]) {
        const result = await httpRequest(
          port,
          "/api/chat/media/test/original?fixture=1",
          { host, origin: `http://${host}`, cookie },
        );
        assert.equal(result.status, 200);
        assert.deepEqual(JSON.parse(result.body), {
          host,
          origin: `http://${host}`,
          url: "/api/chat/media/test/original?fixture=1",
        });
      }
      const noOrigin = await httpRequest(port, "/api/fixture", {
        host: "localhost:5901",
        cookie,
      });
      assert.equal(noOrigin.status, 200);
      assert.deepEqual(JSON.parse(noOrigin.body), {
        host: "localhost:5901",
        origin: null,
        url: "/api/fixture",
      });
      assert.equal(
        (
          await httpRequest(port, "/api/fixture", {
            host: "localhost:5901",
            origin: "http://other.invalid",
            cookie,
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await httpRequest(port, "/api/fixture", {
            host: "localhost:5901",
            origin: "http://localhost:5901",
          })
        ).status,
        401,
      );
      assert.deepEqual(
        await wsRequest(port, {
          host: "localhost:5901",
          origin: "http://localhost:5901",
          cookie,
        }),
        { status: 101, frame: Buffer.from([0x81, 0x02, 0x6f, 0x6b]) },
      );
      const ws = seen.find((item) => item.type === "ws");
      assert.deepEqual(ws, {
        type: "ws",
        host: `127.0.0.1:${backend.address().port}`,
        origin: target,
        cookie,
        url: "/api/chat/socket",
      });
      assert.deepEqual(
        await wsRequest(port, {
          host: "localhost:5901",
          origin: "http://localhost:5901",
        }),
        { status: 401 },
      );
    } finally {
      child.kill("SIGTERM");
      if (child.exitCode === null && child.signalCode === null)
        await once(child, "exit");
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => backend.close(resolve));
    }
  },
);
