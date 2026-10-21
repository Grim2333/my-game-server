import { Room, Client, CloseCode } from "colyseus";
import { MyState, Player } from "./schema/MyState.js";

export class MyRoom extends Room<{ state: MyState }> {
  maxClients = 4;
  state = new MyState();

  messages = {
    /**
     * 处理 "move" 消息：更新该玩家在 state 中的坐标
     * 客户端发送格式：room.send("move", { x: 10, y: 20 })
     */
    move: (client: Client, message: { x: number; y: number }) => {
      const player = this.state.players.get(client.sessionId);
      if (!player) {
        return;
      }
      player.x = message.x;
      player.y = message.y;
    },
  };

  onCreate(options: any) {
    /**
     * Called when a new room is created.
     */
  }

  onJoin(client: Client, options: any) {
    /**
     * 玩家加入：自动在 state 中添加该玩家（坐标默认为 0）
     */
    this.state.players.set(client.sessionId, new Player());
    console.log(client.sessionId, "joined!");
  }

  onLeave(client: Client, code: CloseCode) {
    /**
     * 玩家离开：从 state 中删除该玩家
     */
    this.state.players.delete(client.sessionId);
    console.log(client.sessionId, "left!", code);
  }

  onDispose() {
    /**
     * Called when the room is disposed.
     */
    console.log("room", this.roomId, "disposing...");
  }

}
