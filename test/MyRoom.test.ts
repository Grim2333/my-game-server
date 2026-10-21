import assert from "assert";
import { ColyseusTestServer, boot } from "@colyseus/testing";

import appConfig from "../src/app.config.js";
import { MyState } from "../src/rooms/schema/MyState.js";

describe("testing your Colyseus app", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;

  before(async () => colyseus = await boot(appConfig));
  after(async () => colyseus.shutdown());

  beforeEach(async () => {
    await colyseus.cleanup();
  });

  it("connecting into a room", async () => {
    // `room` is the server-side Room instance reference.
    const room = await colyseus.createRoom<MyState>("my_room", {});

    // `client1` is the client-side `Room` instance reference (same as JavaScript SDK)
    const client1 = await colyseus.connectTo(room);

    // make your assertions
    assert.strictEqual(client1.sessionId, room.clients[0].sessionId);

    // 玩家加入后应自动出现在 players 中，坐标默认为 0
    const player = room.state.players.get(client1.sessionId);
    assert.ok(player, "player should be added on join");
    assert.strictEqual(player.x, 0);
    assert.strictEqual(player.y, 0);
  });

  it("updates player position on move message", async () => {
    const room = await colyseus.createRoom<MyState>("my_room", {});
    const client1 = await colyseus.connectTo(room);

    client1.send("move", { x: 10, y: 20 });
    // 等待消息被服务端处理
    await new Promise((resolve) => setTimeout(resolve, 200));

    const player = room.state.players.get(client1.sessionId);
    assert.strictEqual(player.x, 10);
    assert.strictEqual(player.y, 20);
  });

  it("removes player on leave", async () => {
    const room = await colyseus.createRoom<MyState>("my_room", {});
    const client1 = await colyseus.connectTo(room);

    assert.ok(room.state.players.has(client1.sessionId));

    await client1.leave(true);
    await new Promise((resolve) => setTimeout(resolve, 200));

    assert.ok(!room.state.players.has(client1.sessionId), "player should be removed on leave");
  });
});
