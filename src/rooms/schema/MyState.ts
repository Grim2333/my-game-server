import { schema, t, type SchemaType } from "@colyseus/schema";

/**
 * 玩家：位置坐标，默认为 0
 */
export const Player = schema({
  x: t.float64().default(0),
  y: t.float64().default(0),
});
export type Player = SchemaType<typeof Player>;

/**
 * 房间状态：players 字典，key 为玩家的 sessionId
 */
export const MyState = schema({
  players: t.map(Player),
});
export type MyState = SchemaType<typeof MyState>;
