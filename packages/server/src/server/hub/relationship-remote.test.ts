    },
    outcomes.events,
  ) as HubSocketConnection & WebSocket;

  expect(await outcomes.next()).toEqual({
    type: "failed",
    message: "Opening handshake has timed out",
  });
  expect(await outcomes.afterCleanup()).toEqual([
    { type: "failed", message: "Opening handshake has timed out" },
  ]);
  expect(socket.readyState).toBe(WebSocket.CLOSED);
});

test("heartbeat terminates a half-open Hub relationship and reports one retryable failure", async () => {
  const server = createServer();
  const webSockets = new WebSocketServer({ noServer: true, autoPong: false });
  server.on("upgrade", (request, socket, head) => {
    webSockets.handleUpgrade(request, socket, head, () => undefined);
  });
  openServers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address() as AddressInfo;
  const outcomes = new SocketOutcomes();
  const remote = new DirectHubRelationshipRemote({
    requestTimeoutMs: 200,
    socketHeartbeatIntervalMs: 20,
    socketHeartbeatTimeoutMs: 20,
  });
  const socket = remote.openSocket(
    {
      daemonId: "daemon-1",
      webSocketUrl: `ws://127.0.0.1:${address.port}/daemon`,
      credential: "credential",
    },
    outcomes.events,
  ) as HubSocketConnection & WebSocket;
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));

  expect(await outcomes.next()).toEqual({ type: "connected" });
  expect(await outcomes.next()).toEqual({
    type: "failed",
    message: "Hub WebSocket heartbeat timed out",
  });
  await withDeadline(closed, "Heartbeat-terminated Hub socket did not close");
  expect(await outcomes.afterCleanup()).toEqual([
    { type: "connected" },
    { type: "failed", message: "Hub WebSocket heartbeat timed out" },
  ]);
  expect(socket.readyState).toBe(WebSocket.CLOSED);
  webSockets.close();
});

test("heartbeat keeps a healthy Hub relationship open across multiple intervals", async () => {
  const server = createServer();
  const webSockets = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    webSockets.handleUpgrade(request, socket, head, () => undefined);
  });
  openServers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address() as AddressInfo;
  const outcomes = new SocketOutcomes();
  const remote = new DirectHubRelationshipRemote({
    requestTimeoutMs: 200,
    socketHeartbeatIntervalMs: 20,
    socketHeartbeatTimeoutMs: 40,
  });
  const socket = remote.openSocket(
    {
      daemonId: "daemon-1",
      webSocketUrl: `ws://127.0.0.1:${address.port}/daemon`,
      credential: "credential",
    },
    outcomes.events,
  ) as HubSocketConnection & WebSocket;

  expect(await outcomes.next()).toEqual({ type: "connected" });
  await new Promise((resolve) => setTimeout(resolve, 120));
  expect(socket.readyState).toBe(WebSocket.OPEN);
  expect(await outcomes.afterCleanup()).toEqual([{ type: "connected" }]);
  socket.close();
  webSockets.close();
});
