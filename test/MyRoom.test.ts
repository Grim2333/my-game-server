import assert from "assert";
import { ColyseusTestServer, boot } from "@colyseus/testing";

import appConfig from "../src/app.config.js";
import { MyState, Card } from "../src/rooms/schema/MyState.js";

/** 等待状态同步 / 消息处理 */
const wait = (ms = 200) => new Promise((resolve) => setTimeout(resolve, ms));

/** 测试辅助：直接替换某名玩家的手牌（确定性发牌），并同步"本夜开始存活数"快照 */
function setHand(
  room: any,
  sessionId: string,
  cards: { id: string; name: string; type: string; skill?: string }[]
) {
  const player = room.state.players.get(sessionId);
  player.hand.clear();
  for (const c of cards) {
    const card = new Card();
    card.id = c.id;
    card.name = c.name;
    card.type = c.type;
    card.skill = c.skill ?? "";
    player.hand.push(card);
  }
  player.handCount = player.hand.length;
  // 重新记录"本夜开始存活数"，使白天"是否死过牌"判定与手牌一致
  const snap = (room as any).nightStartCount;
  room.state.players.forEach((p: any, id: string) => {
    snap[id] = p.handCount + p.play.length;
    p.lostThisNight = false;
  });
}

/** 测试辅助：取 pendingAction 快照 */
function pending(room: any) {
  return {
    type: room.state.pendingAction.type,
    actor: room.state.pendingAction.actor,
    zone: room.state.pendingAction.zone,
  };
}

/**
 * 测试辅助：墓地相关。
 * ★ 墓地现在是【每个玩家各自私有】的（PlayerState.graveyard），
 *   不再有公共的 state.graveyard，所以统一用这两个辅助函数取"双方墓地合计"。
 */
function graveyardOf(room: any, sessionId: string): any[] {
  const p = room.state.players.get(sessionId);
  return p ? Array.from(p.graveyard) : [];
}
/** 双方墓地的牌总数 */
function graveCount(room: any): number {
  let n = 0;
  room.state.players.forEach((p: any) => (n += p.graveyard.length));
  return n;
}
/**
 * 测试辅助：双方墓地中所有牌的 id。
 * ★ 墓地拆成"每人一个"后没有全局死亡顺序了，所以统一排序返回，
 *   断言只关心"哪些牌在墓地里"，与顺序无关。
 */
function graveIds(room: any): string[] {
  const ids: string[] = [];
  room.state.players.forEach((p: any) => p.graveyard.forEach((c: any) => ids.push(c.id)));
  return ids.sort();
}

/** 测试辅助：某玩家手牌里指定 id 的位置（-1 表示不在手上） */
function handIdx(room: any, sessionId: string, cardId: string): number {
  return room.state.players.get(sessionId).hand.findIndex((c: any) => c.id === cardId);
}

/** 测试辅助：某玩家行动区的牌数 */
function playCount(room: any, sessionId: string): number {
  return room.state.players.get(sessionId).play.length;
}

/** 测试辅助：当前所有丘比特链接里的牌 id（拍平、排序，与对内顺序无关） */
function linkIds(room: any): string[] {
  const links: { a: string; b: string }[] = room.cardLinks || [];
  return links.flatMap((l) => [l.a, l.b]).sort();
}

/** 测试辅助：某玩家是否与指定牌建立过链接（按对检查） */
function hasLink(room: any, x: string, y: string): boolean {
  const links: { a: string; b: string }[] = room.cardLinks || [];
  return links.some((l) => (l.a === x && l.b === y) || (l.a === y && l.b === x));
}

// 文件级根钩子：整个测试文件只 boot / shutdown 一次服务器（避免多个 describe 各自
// boot 导致端口/匹配服务冲突）。两个 describe 共享同一个 colyseus 实例。
let colyseus: ColyseusTestServer<typeof appConfig>;
before(async () => (colyseus = await boot(appConfig)));
after(async () => colyseus.shutdown());

describe("顺序制回合：P1黑夜→P2黑夜→天亮结算→P1白天→P2白天", () => {
  beforeEach(async () => {
    await colyseus.cleanup();

  });

  /** 通用开局：返回房间 + 双客户端。回合时限很长，避免测试期间自动推进 */
  async function setup(opts: any = {}) {
    const room = await colyseus.createRoom<MyState>("my_room", {
      turnDuration: 60000,
      ...opts,
    });
    const client1 = await colyseus.connectTo(room);
    const client2 = await colyseus.connectTo(room);
    await wait();
    return {
      room,
      first: client1.sessionId,
      second: client2.sessionId,
      firstClient: client1,
      secondClient: client2,
    };
  }

  it("initGame: 进入第 1 夜，双方各 6 张，轮到 P1（先手）", async () => {
    const { room, first } = await setup();
    // 牌库构成：15 狼人 + 20 平民 + 特殊牌（含大野狼×2、锈剑骑士、种狼、毒狼等）= 60 张，发 12 张后剩 48
    assert.strictEqual(room.state.deck.length, 48);
    assert.strictEqual(graveCount(room), 0);
    let totalPlay = 0;
    room.state.players.forEach((p: any) => (totalPlay += p.playCount));
    assert.strictEqual(totalPlay, 0, "开局行动区为空");
    assert.strictEqual(room.state.phase, "night");
    assert.strictEqual(room.state.round, 1);
    assert.strictEqual(room.state.turnSeq, 0);
    assert.strictEqual(room.state.turnOwner, first, "第 1 夜轮到 P1（先手）");
    assert.strictEqual(room.state.turnActed, false);
    assert.ok(room.state.deadline > 0, "回合应有倒计时");
    assert.strictEqual(pending(room).type, "");
    assert.strictEqual(room.state.winner, "");

    const all: any[] = [...room.state.deck];
    room.state.players.forEach((p: any) => all.push(...p.hand));
    const count = (skill: string) => all.filter((c: any) => c.skill === skill).length;
    assert.strictEqual(all.length, 60);
    // ★ 特殊牌（除平民 / 狼人以外的身份牌）整局唯一（大野狼例外，共 2 张）
    assert.strictEqual(count("hunter"), 1, "猎人 只有 1 张");
    assert.strictEqual(count("wolfKing"), 1, "狼王 只有 1 张");
    assert.strictEqual(count("witch"), 1, "女巫 只有 1 张");
    assert.strictEqual(count("elder"), 1, "长老 只有 1 张");
    assert.strictEqual(count("thief"), 1, "盗贼 只有 1 张");
    assert.strictEqual(count("greatWolf"), 2, "大野狼 有 2 张");
    assert.strictEqual(count("rustKnight"), 1, "锈剑骑士 只有 1 张");
    assert.strictEqual(count("breedWolf"), 1, "种狼 只有 1 张");
    assert.strictEqual(count("poisonWolf"), 1, "毒狼 只有 1 张");
    assert.strictEqual(count("whiteWolfKing"), 1, "白狼王 只有 1 张");
    assert.strictEqual(count("seer"), 1, "预言家 只有 1 张");
    assert.strictEqual(count("hiddenWolf"), 1, "隐狼 只有 1 张");
    assert.strictEqual(count("witchApprentice"), 1, "女巫学徒 只有 1 张");
    assert.strictEqual(count("knight"), 1, "骑士 只有 1 张");
    assert.strictEqual(count("fool"), 1, "白痴 只有 1 张");
    assert.strictEqual(count("cupid"), 1, "丘比特 只有 1 张");
    assert.strictEqual(count("angel"), 1, "天使 只有 1 张");
    assert.strictEqual(count("necromancer"), 1, "通灵师 只有 1 张");
    assert.strictEqual(count("miracleMerchant"), 1, "奇迹商人 只有 1 张");
    assert.strictEqual(count("guard"), 1, "守卫 只有 1 张");
    assert.strictEqual(count("wildChild"), 1, "野孩子 只有 1 张");
    assert.strictEqual(count("bomber"), 1, "炸弹人 只有 1 张");
    assert.strictEqual(count("wolfBeauty"), 1, "狼美人 只有 1 张");
    assert.strictEqual(count("oldRogue"), 1, "老流氓 只有 1 张");
    const byIdPrefix = (p: string) => all.filter((c: any) => String(c.id).startsWith(p)).length;
    assert.strictEqual(byIdPrefix("thief-"), 1, "盗贼 1 张");
    assert.strictEqual(byIdPrefix("wolf-"), 15, "狼人 15 张");
    assert.strictEqual(byIdPrefix("villager-"), 20, "平民 20 张");
    const skillCount = (v: string) => all.filter((c: any) => c.skill === v).length;
    assert.strictEqual(skillCount(""), 35, "无技能的基础牌 35 张（狼人 + 平民）");
    assert.ok(
      all.filter((c: any) => c.skill === "seer").every((c: any) => c.type === "god"),
      "预言家是神职身份"
    );
  });

  it("开局配额：每方 6 张手牌里必有 1~2 张狼阵营 + 1~2 张神职阵营", async () => {
    for (let i = 0; i < 6; i++) {
      const { room, first, second } = await setup();
      for (const sid of [first, second]) {
        const hand = Array.from(room.state.players.get(sid)!.hand) as any[];
        assert.strictEqual(hand.length, 6, "每人 6 张");
        const wolves = hand.filter((c) => c.type === "wolf").length;
        const gods = hand.filter((c) => c.type === "god").length;
        assert.ok(wolves >= 1 && wolves <= 2, `狼阵营应为 1~2 张，实际 ${wolves}`);
        assert.ok(gods >= 1 && gods <= 2, `神职阵营应为 1~2 张，实际 ${gods}`);
        assert.ok(
          hand.every((c) => c.type === "wolf" || c.type === "god" || c.type === "villager"),
          "手牌类型只有三种阵营"
        );
      }
    }
  });

  it("手牌私有化仍然生效（view filtering）", async () => {
    const room = await colyseus.createRoom<MyState>("my_room", {});
    const client1 = await colyseus.connectTo(room);
    const client2 = await colyseus.connectTo(room);
    await wait();

    const myHand = client1.state.players.get(client1.sessionId)!.hand;
    const oppHand = client1.state.players.get(client2.sessionId)!.hand;
    assert.strictEqual(myHand.length, 6);
    assert.ok(oppHand === undefined || oppHand.length === 0, "看不到对方手牌内容");
    assert.strictEqual(client1.state.players.get(client2.sessionId)!.handCount, 6);
  });

  it("行动区私有：对方只能看到数量，看不到具体是什么牌", async () => {
    const { room, first, firstClient, secondClient } = await setup();
    // 直接往 P1 的行动区放两张牌（模拟已打出的牌）
    const p = room.state.players.get(first);
    for (const id of ["pa1", "pa2"]) {
      const c = new Card();
      c.id = id; c.name = "平民"; c.type = "villager"; c.owner = first;
      p.play.push(c);
    }
    p.playCount = p.play.length;
    await wait(300);

    const myPlay = firstClient.state.players.get(first)!.play;
    assert.strictEqual(myPlay.length, 2, "自己能看到自己行动区的 2 张牌");
    const oppPlay = secondClient.state.players.get(first)!.play;
    assert.ok(oppPlay === undefined || oppPlay.length === 0, "对方绝不能看到行动区内容");
    assert.strictEqual(
      secondClient.state.players.get(first)!.playCount, 2,
      "但行动区数量是公开的"
    );
  });

  it("一回合顺序：P1黑夜→P2黑夜→天亮→P1白天（严格一人一轮）", async () => {
    const { room, first, second, firstClient, secondClient } = await setup();
    setHand(room, first, [
      { id: "w1", name: "狼人", type: "wolf" },
      { id: "v9", name: "平民", type: "villager" },
    ]);
    setHand(room, second, [
      { id: "w2", name: "狼人", type: "wolf" },
      { id: "v1", name: "平民", type: "villager" },
      { id: "v2", name: "平民", type: "villager" },
    ]);

    // P1 黑夜：出狼刀中 P2 的 v1（index 1）
    firstClient.send("playCard", { id: "w1" });
    await wait();
    assert.deepStrictEqual(pending(room), { type: "wolfKnife", actor: first, zone: "opponentHand" });
    firstClient.send("chooseTarget", { index: 1 });
    await wait();
    // 出牌结算完仍留在 P1 回合；只有主动结束才交给 P2
    assert.strictEqual(room.state.turnOwner, first, "出牌结算完仍是 P1 的回合");
    firstClient.send("ready");
    await wait();
    assert.strictEqual(room.state.turnOwner, second, "P1 主动结束后轮到 P2 黑夜");
    assert.strictEqual(room.state.turnSeq, 1);
    assert.strictEqual(room.state.phase, "night", "仍是黑夜（P2 还没动）");

    // P2 黑夜：出狼刀中 P1 的 v9（P1 手牌 [w1, v9]，v9 是 index 1）
    secondClient.send("playCard", { id: "w2" });
    await wait();
    assert.deepStrictEqual(pending(room), { type: "wolfKnife", actor: second, zone: "opponentHand" });
    secondClient.send("chooseTarget", { index: 1 });
    await wait();
    secondClient.send("ready"); // P2 主动结束 → 天亮
    await wait();

    // 天亮统一结算 → 进入 P1 的白天
    assert.strictEqual(playCount(room, first) + playCount(room, second), 0, "两张狼都已回到各自手牌");
    assert.strictEqual(room.state.phase, "day", "天亮了");
    assert.strictEqual(room.state.turnOwner, first, "天亮后轮到 P1 白天");
    assert.strictEqual(room.state.turnSeq, 2);
    assert.deepStrictEqual(graveIds(room), ["v1", "v9"], "天亮后两张被刀的牌一起进墓地");
  });

  it("核心规则：黑夜狼刀只做标记，牌留在手牌、不进墓地（P2 行动前）", async () => {
    const { room, first, second, firstClient, secondClient } = await setup();
    setHand(room, first, [{ id: "w1", name: "狼人", type: "wolf" }]);
    setHand(room, second, [
      { id: "v1", name: "平民", type: "villager" },
      { id: "v2", name: "平民", type: "villager" },
    ]);

    firstClient.send("playCard", { id: "w1" });
    await wait();
    firstClient.send("chooseTarget", { index: 0 }); // 锁定 v1
    await wait();

    // P1 主动结束黑夜 → 轮到 P2
    firstClient.send("ready");
    await wait();

    // 标记阶段：手牌数不变、墓地为空
    assert.strictEqual(room.state.turnOwner, second, "P1 已结束，轮到 P2");
    assert.strictEqual(room.state.phase, "night", "仍在黑夜");
    assert.strictEqual(room.state.players.get(second)!.handCount, 2, "手牌数不变（牌还在手里）");
    assert.strictEqual(graveCount(room), 0, "黑夜不进墓地");
    assert.strictEqual(playCount(room, first), 0, "狼刀结算完毕，狼已回到手牌");
    assert.strictEqual(room.state.players.get(first)!.handCount, 1, "手牌恢复");

    // P2 结束回合 → 天亮，统一结算
    secondClient.send("ready");
    await wait();
    assert.strictEqual(room.state.phase, "day", "进入白天");
    assert.deepStrictEqual(graveIds(room), ["v1"], "天亮后 v1 才进墓地");
    assert.strictEqual(room.state.players.get(second)!.handCount, 1);
  });

  it("HUNTER: 猎人夜里被标记 → 天亮结算时才触发开枪", async () => {
    const { room, first, second, firstClient, secondClient } = await setup();
    const skill1: any[] = [];
    const skill2: any[] = [];
    firstClient.onMessage("deathSkill", (m) => skill1.push(m));
    secondClient.onMessage("deathSkill", (m) => skill2.push(m));
    setHand(room, first, [
      { id: "w1", name: "狼人", type: "wolf" },
      { id: "w2", name: "狼人", type: "wolf" },
      { id: "v9", name: "平民", type: "villager" },
    ]);
    setHand(room, second, [
      { id: "h1", name: "猎人", type: "god", skill: "hunter" },
      { id: "v1", name: "平民", type: "villager" },
    ]);

    firstClient.send("playCard", { id: "w1" });
    await wait();
    firstClient.send("chooseTarget", { index: 0 }); // 锁定猎人
    await wait();
    assert.strictEqual(graveCount(room), 0, "猎人还活着（只是被标记）");

    firstClient.send("ready"); // P1 主动结束黑夜
    await wait();
    secondClient.send("ready"); // P2 结束黑夜 → 天亮
    await wait();
    assert.strictEqual(room.state.phase, "day");
    assert.deepStrictEqual(graveIds(room), ["h1"], "天亮后猎人进墓地");
    assert.deepStrictEqual(pending(room), { type: "hunter", actor: second, zone: "opponentHand" });
    // ★ 双方都收到「猎人死亡触发技能」的播报
    assert.strictEqual(skill1.length, 1, "P1 收到猎人技能播报");
    assert.strictEqual(skill2.length, 1, "P2 收到猎人技能播报");
    assert.ok(String(skill1[0].text).indexOf("猎人") >= 0, "播报写明是猎人");

    // 猎人开枪打 P1 的 w2（P1 手牌 [w1, w2, v9]，w2 是 index 1）
    secondClient.send("chooseTarget", { index: 1 });
    await wait();
    assert.deepStrictEqual(graveIds(room), ["h1", "w2"]);
    assert.strictEqual(pending(room).type, "");
    assert.ok(room.state.deadline > 0, "结算完成后白天回合开始计时");
    assert.strictEqual(room.state.players.get(first)!.handCount, 2); // 3 - 1(被带走)
    assert.strictEqual(room.state.players.get(second)!.handCount, 1); // 2 - 1(猎人死亡)
    assert.strictEqual(room.state.winner, "");
  });

  it("CASCADE: 猎人开枪打死狼王 → 狼王再带人（天亮结算中的级联）", async () => {
    const { room, first, second, firstClient, secondClient } = await setup();
    const skill1: any[] = [];
    firstClient.onMessage("deathSkill", (m) => skill1.push(m));
    setHand(room, first, [
      { id: "w1", name: "狼人", type: "wolf" },
      { id: "wk1", name: "狼王", type: "wolf", skill: "wolfKing" },
      { id: "w3", name: "狼人", type: "wolf" },
    ]);
    setHand(room, second, [
      { id: "h1", name: "猎人", type: "god", skill: "hunter" },
      { id: "v1", name: "平民", type: "villager" },
    ]);

    firstClient.send("playCard", { id: "w1" });
    await wait();
    firstClient.send("chooseTarget", { index: 0 }); // 标记猎人
    await wait();
    firstClient.send("ready"); // P1 主动结束黑夜
    await wait();
    secondClient.send("ready"); // 天亮
    await wait();
    assert.deepStrictEqual(pending(room), { type: "hunter", actor: second, zone: "opponentHand" });

    secondClient.send("chooseTarget", { index: 1 }); // 开枪打狼王（P1 手牌 [w1,wk1,w3]，wk1 index1）
    await wait();
    assert.deepStrictEqual(graveIds(room), ["h1", "wk1"]);
    assert.deepStrictEqual(pending(room), { type: "wolfKing", actor: first, zone: "opponentHand" });
    assert.ok(
      skill1.some((m) => String(m.text).indexOf("狼王") >= 0),
      "P1 收到「狼王死亡触发技能」播报"
    );

    firstClient.send("chooseTarget", { index: 0 }); // 狼王带人（P2 手牌只剩 [v1]，index0）
    await wait();
    assert.deepStrictEqual(graveIds(room), ["h1", "v1", "wk1"], "三级级联全部结算");
    assert.strictEqual(pending(room).type, "");
    assert.strictEqual(room.state.players.get(second)!.handCount, 0);
    assert.strictEqual(room.state.winner, first, "P2 存活牌耗尽，P1 获胜");
  });

  it("WITCH revive: 解药从自己墓地复活一张牌回到手牌", async () => {
    const { room, first, second, firstClient, secondClient } = await setup();
    setHand(room, first, [{ id: "v9", name: "平民", type: "villager" }]);
    setHand(room, second, [
      { id: "wc1", name: "女巫", type: "god", skill: "witch" },
      { id: "v1", name: "平民", type: "villager" },
    ]);
    // 预先在 P2 自己的墓地放一张死牌（模拟天亮结算后的墓地）
    const dead = new Card();
    dead.id = "dead1";
    dead.name = "平民";
    dead.type = "villager";
    dead.owner = second;
    room.state.players.get(second).graveyard.push(dead);

    // P1 黑夜直接结束 → 轮到 P2 黑夜
    firstClient.send("ready");
    await wait();

    secondClient.send("useSkill", { cardId: "wc1", mode: "revive" });
    await wait();
    assert.deepStrictEqual(pending(room), {
      type: "witchRevive",
      actor: second,
      zone: "graveyard",
    });

    secondClient.send("chooseTarget", { index: 0 }); // 复活墓地里的 dead1
    await wait();
    assert.strictEqual(pending(room).type, "", "结算完清空 pending");
    assert.strictEqual(graveyardOf(room, second).length, 0, "墓地里的牌被取走");
    assert.strictEqual(room.state.players.get(second)!.handCount, 3, "dead1 回到手牌");
    assert.ok(
      graveIds(room).indexOf("dead1") === -1,
      "dead1 已不在墓地"
    );
    // 女巫用药后仍停留在本回合（可继续用其它牌 / 主动结束回合）
    assert.strictEqual(room.state.turnOwner, second, "解药结算完仍停在 P2 回合");
  });

  it("女巫复活墓地的狼人 → 同一夜共用刀未用时，该狼可出刀", async () => {
    const { room, first, second, firstClient, secondClient } = await setup();
    setHand(room, first, [
      { id: "wc", name: "女巫", type: "god", skill: "witch" },
      { id: "v1", name: "平民", type: "villager" },
    ]);
    setHand(room, second, [
      { id: "w2", name: "狼人", type: "wolf" },
      { id: "v2", name: "平民", type: "villager" },
    ]);
    // 预先在 P1 墓地放一张"已行动过"的死狼（模拟它之前某夜出动过刀）
    const deadWolf = new Card();
    deadWolf.id = "dw";
    deadWolf.name = "狼人";
    deadWolf.type = "wolf";
    deadWolf.skill = "wolf";
    deadWolf.owner = first;
    deadWolf.acted = true; // ★ 关键：死亡态标记带到墓地
    room.state.players.get(first).graveyard.push(deadWolf);

    // P1 黑夜：先女巫解药复活 dw（P1 是先手，轮到 P1 时直接发动女巫）
    firstClient.send("useSkill", { cardId: "wc", mode: "revive" });
    await wait();
    assert.strictEqual(pending(room).type, "witchRevive", "女巫待选墓地");
    assert.strictEqual(room.state.wolfKnifeUsed, false, "本夜共用刀尚未用过");
    firstClient.send("chooseTarget", { index: 0 });
    await wait();
    const revived = room.state.players.get(first)!.hand.find((c: any) => c.id === "dw");
    assert.ok(revived, "dw 回到 P1 手牌");
    assert.strictEqual(revived.acted, false, "复活清掉了 acted，本夜可行动");

    // ★ 同一夜 P1 还能出这匹复活的狼去刀人
    firstClient.send("playCard", { id: "dw" });
    await wait();
    assert.strictEqual(pending(room).type, "wolfKnife", "复活的狼可发动共用刀");
    firstClient.send("chooseTarget", { index: 0 }); // 刀 P2 的 w2
    await wait();
    assert.strictEqual(room.state.wolfKnifeUsed, true, "共用刀被这匹复活的狼占用");
    assert.ok(
      room.state.players.get(first)!.hand.some((c: any) => c.id === "dw"),
      "出刀后狼牌回到手牌"
    );
  });

  it("WITCH revive: 墓地为空时解药被拒绝", async () => {
    const { room, first, second, firstClient, secondClient } = await setup();
    setHand(room, first, [{ id: "v9", name: "平民", type: "villager" }]);
    setHand(room, second, [
      { id: "wc1", name: "女巫", type: "god", skill: "witch" },
      { id: "v1", name: "平民", type: "villager" },
    ]);

    firstClient.send("ready");
    await wait();

    let rejected: string | null = null;
    secondClient.onMessage("playRejected", (m: any) => (rejected = m.reason));
    secondClient.send("useSkill", { cardId: "wc1", mode: "revive" });
    await wait();
    assert.ok(rejected && /墓地没有牌/.test(rejected), `空墓地应拒绝解药，实际：${rejected}`);
    assert.strictEqual(pending(room).type, "", "被拒绝后不进入待结算");
  });

  it("GRAVEYARD 私有：每个玩家只能看到自己的墓地", async () => {
    const { room, first, second, firstClient, secondClient } = await setup();
    setHand(room, first, [{ id: "w1", name: "狼人", type: "wolf" }]);
    setHand(room, second, [
      { id: "v1", name: "平民", type: "villager" },
      { id: "v2", name: "平民", type: "villager" },
    ]);
    // P1 出狼刀死 P2 的 v1 → 天亮后进【P2 自己的墓地】
    firstClient.send("playCard", { id: "w1" });
    await wait();
    firstClient.send("chooseTarget", { index: 0 });
    await wait();
    firstClient.send("ready");
    await wait();
    secondClient.send("ready");
    await wait();
    assert.strictEqual(room.state.phase, "day");

    assert.ok(
      graveIds(room).indexOf("v1") !== -1,
      "v1 应进入墓地"
    );
    assert.strictEqual(graveyardOf(room, second).length, 1, "死牌进的是 P2 的墓地");
    assert.strictEqual(graveyardOf(room, first).length, 0, "P1 墓地仍为空（死的是 P2 的牌）");
    // 私有性：各自客户端收到的墓地列表只含自己的牌
    const firstGrave = Array.from(firstClient.state?.players?.get(second)?.graveyard ?? []);
    assert.strictEqual(firstGrave.length, 0, "P1 客户端看不到 P2 的墓地");
    const secondGrave = Array.from(secondClient.state?.players?.get(second)?.graveyard ?? []);
    assert.strictEqual(secondGrave.length, 1, "P2 客户端能看到自己的墓地");
  });

  it("WITCH poison: 毒药标记对方一张牌，天亮才生效", async () => {
    const { room, first, second, firstClient, secondClient } = await setup();
    setHand(room, first, [
      { id: "wc1", name: "女巫", type: "god", skill: "witch" },
      { id: "v9", name: "平民", type: "villager" },
    ]);
    setHand(room, second, [
      { id: "v1", name: "平民", type: "villager" },
      { id: "v2", name: "平民", type: "villager" },
    ]);

    firstClient.send("useSkill", { cardId: "wc1", mode: "poison" });
    await wait();
    assert.deepStrictEqual(pending(room), { type: "witchPoison", actor: first, zone: "opponentHand" });
    firstClient.send("chooseTarget", { index: 1 }); // 毒 v2
    await wait();
    assert.strictEqual(room.state.players.get(second)!.handCount, 2, "标记阶段手牌数不变");
    assert.strictEqual(graveCount(room), 0);

    firstClient.send("ready"); // P1 主动结束黑夜
    await wait();
    secondClient.send("ready"); // 天亮
    await wait();
    assert.strictEqual(room.state.phase, "day");
    assert.deepStrictEqual(graveIds(room), ["v2"], "天亮后 v2 进墓地");
    assert.strictEqual(room.state.players.get(first)!.handCount, 2, "女巫牌不消耗");
  });

  it("女巫毒杀：被毒的手牌卡背显示「杀毒」标记（天亮结算后清除）", async () => {
    const { room, first, second, firstClient, secondClient } = await setup();
    setHand(room, first, [
      { id: "wc1", name: "女巫", type: "god", skill: "witch" },
      { id: "v9", name: "平民", type: "villager" },
    ]);
    setHand(room, second, [
      { id: "v1", name: "平民", type: "villager" },
      { id: "v2", name: "平民", type: "villager" },
      { id: "v3", name: "平民", type: "villager" },
    ]);

    // 黑夜：P1 女巫下毒毒 P2 的 v2（#2）
    firstClient.send("useSkill", { cardId: "wc1", mode: "poison" });
    await wait();
    firstClient.send("chooseTarget", { index: 1 });
    await wait();

    // 标记阶段：手牌仍在，但被毒的牌所在槽位被打上「杀毒」标记
    const p2 = room.state.players.get(second)!;
    assert.strictEqual(p2.handCount, 3, "标记阶段手牌数不变");
    assert.ok(
      Array.from(p2.poisonedSlots).includes(1),
      "被毒的 v2（#2）所在槽位被打上杀毒标记"
    );
    assert.deepStrictEqual(
      Array.from(p2.poisonedPlaySlots),
      [],
      "行动区无标记"
    );

    // 天亮结算：v2 进墓地，标记随之清除
    firstClient.send("ready");
    await wait();
    secondClient.send("ready");
    await wait();
    assert.strictEqual(room.state.phase, "day");
    assert.ok(
      graveyardOf(room, second).some((c: any) => c.id === "v2"),
      "天亮后 v2 进墓地"
    );
    assert.deepStrictEqual(
      Array.from(room.state.players.get(second)!.poisonedSlots),
      [],
      "天亮后杀毒标记已清除"
    );
  });

  it("女巫学徒毒杀：被毒的手牌卡背同样显示「杀毒」标记（与女巫同理，天亮后清除）", async () => {
    const { room, first, second, firstClient, secondClient } = await setup();
    setHand(room, first, [
      { id: "a1", name: "女巫学徒", type: "god", skill: "witchApprentice" },
      { id: "v9", name: "平民", type: "villager" },
    ]);
    // ★ 强制学徒这次不失手：rollApprenticeRisk 中 blessCharges>0 时直接返回 false（毒药稳落中）
    room.state.players.get(first)!.hand.find((c: any) => c.id === "a1").blessCharges = 1;
    setHand(room, second, [
      { id: "v1", name: "平民", type: "villager" },
      { id: "v2", name: "平民", type: "villager" },
      { id: "v3", name: "平民", type: "villager" },
    ]);

    // 黑夜：P1 女巫学徒下毒毒 P2 的 v2（#2）
    firstClient.send("useSkill", { cardId: "a1", mode: "poison" });
    await wait();
    firstClient.send("chooseTarget", { index: 1 });
    await wait();

    const p2 = room.state.players.get(second)!;
    assert.strictEqual(p2.handCount, 3, "标记阶段手牌数不变");
    assert.ok(
      Array.from(p2.poisonedSlots).includes(1),
      "被毒的 v2（#2）所在槽位被打上杀毒标记（与女巫一致）"
    );
    assert.deepStrictEqual(
      Array.from(p2.poisonedPlaySlots),
      [],
      "行动区无标记"
    );

    // 天亮结算：v2 进墓地，标记随之清除
    firstClient.send("ready");
    await wait();
    secondClient.send("ready");
    await wait();
    assert.strictEqual(room.state.phase, "day");
    assert.ok(
      graveyardOf(room, second).some((c: any) => c.id === "v2"),
      "天亮后 v2 进墓地"
    );
    assert.deepStrictEqual(
      Array.from(room.state.players.get(second)!.poisonedSlots),
      [],
      "天亮后杀毒标记已清除"
    );
  });

  it("女巫每种药剂终身限用一次：同一瓶第二晚再用被拒绝", async () => {
    const { room, first, second, firstClient, secondClient } = await setup();
    setHand(room, first, [
      { id: "wc1", name: "女巫", type: "god", skill: "witch" },
      { id: "v9", name: "平民", type: "villager" },
    ]);
    setHand(room, second, [
      { id: "v1", name: "平民", type: "villager" },
      { id: "v2", name: "平民", type: "villager" },
      { id: "v3", name: "平民", type: "villager" },
    ]);
    let rejected: string | null = null;
    firstClient.onMessage("playRejected", (m: any) => (rejected = m.reason));

    // 第 1 夜：毒死 v1
    firstClient.send("useSkill", { cardId: "wc1", mode: "poison" });
    await wait();
    firstClient.send("chooseTarget", { index: 0 });
    await wait();
    assert.strictEqual(pending(room).type, "", "毒药结算完毕");
    rejected = null;
    firstClient.send("useSkill", { cardId: "wc1", mode: "poison" });
    await wait();
    assert.ok(
      rejected && /毒药已经用过/.test(rejected),
      `同回合重复用毒应被拒，实际：${rejected}`
    );

    // 走完第 1 轮 → 第 2 夜（acted 已重置，但药剂不会再回来）
    firstClient.send("ready");
    await wait();
    secondClient.send("ready");
    await wait();
    firstClient.send("ready");
    await wait();
    secondClient.send("ready");
    await wait();
    assert.strictEqual(room.state.round, 2, "进入第 2 轮");
    assert.strictEqual(room.state.turnOwner, first);

    rejected = null;
    firstClient.send("useSkill", { cardId: "wc1", mode: "poison" });
    await wait();
    assert.ok(
      rejected && /毒药已经用过/.test(rejected),
      `跨夜再用毒仍应被拒，实际：${rejected}`
    );
    assert.strictEqual(pending(room).type, "", "被拒绝后不进入待结算");

    // 但【另一瓶】解药还没用过 → 仍可用（墓地此时为空，只验证不是"已用完"文案）
    rejected = null;
    firstClient.send("useSkill", { cardId: "wc1", mode: "revive" });
    await wait();
    assert.ok(
      rejected && /墓地没有牌/.test(rejected),
      `解药是另一瓶，应报"墓地为空"而非"已用完"，实际：${rejected}`
    );
  });

  it("女巫解药用过一次后不能再用", async () => {
    const { room, first, second, firstClient, secondClient } = await setup();
    setHand(room, first, [{ id: "v9", name: "平民", type: "villager" }]);
    setHand(room, second, [
      { id: "wc1", name: "女巫", type: "god", skill: "witch" },
      { id: "v1", name: "平民", type: "villager" },
    ]);
    // P2 墓地里放两张死牌
    const mk = (id: string) => {
      const c = new Card();
      c.id = id;
      c.name = "平民";
      c.type = "villager";
      c.owner = second;
      return c;
    };
    room.state.players.get(second).graveyard.push(mk("d1"), mk("d2"));

    firstClient.send("ready");
    await wait();

    let rejected: string | null = null;
    secondClient.onMessage("playRejected", (m: any) => (rejected = m.reason));

    secondClient.send("useSkill", { cardId: "wc1", mode: "revive" });
    await wait();
    secondClient.send("chooseTarget", { index: 0 }); // 复活 d1
    await wait();
    assert.strictEqual(graveyardOf(room, second).length, 1, "复活一张，墓地还剩一张");

    rejected = null;
    secondClient.send("useSkill", { cardId: "wc1", mode: "revive" });
    await wait();
    assert.ok(
      rejected && /解药已经用过/.test(rejected),
      `解药二次使用应被拒，实际：${rejected}`
    );
    assert.strictEqual(graveyardOf(room, second).length, 1, "拒绝后墓地不变");
  });

  it("两张不同的女巫牌各自独立拥有解药 + 毒药", async () => {
    const { room, first, second, firstClient } = await setup();
    setHand(room, first, [
      { id: "wc1", name: "女巫", type: "god", skill: "witch" },
      { id: "wc2", name: "女巫", type: "god", skill: "witch" },
      { id: "v9", name: "平民", type: "villager" },
    ]);
    setHand(room, second, [
      { id: "v1", name: "平民", type: "villager" },
      { id: "v2", name: "平民", type: "villager" },
    ]);

    // wc1 用毒（消耗它自己的那瓶）
    firstClient.send("useSkill", { cardId: "wc1", mode: "poison" });
    await wait();
    firstClient.send("chooseTarget", { index: 0 });
    await wait();

    const hand = room.state.players.get(first)!.hand;
    const wc1 = hand.find((c: any) => c.id === "wc1");
    const wc2 = hand.find((c: any) => c.id === "wc2");
    assert.strictEqual(wc1.witchPoisonUsed, true, "wc1 的毒药已用掉");
    assert.strictEqual(wc2.witchPoisonUsed, false, "wc2 的另一瓶毒药不受影响");

    // wc2 仍能用毒
    firstClient.send("useSkill", { cardId: "wc2", mode: "poison" });
    await wait();
    assert.strictEqual(pending(room).type, "witchPoison", "第二张女巫牌仍可用毒");
  });

  it("女巫选目标时「跳过」→ 药剂退还，可再次使用", async () => {
    const { room, first, second, firstClient, secondClient } = await setup();
    setHand(room, first, [
      { id: "wc1", name: "女巫", type: "god", skill: "witch" },
      { id: "v9", name: "平民", type: "villager" },
    ]);
    setHand(room, second, [
      { id: "v1", name: "平民", type: "villager" },
      { id: "v2", name: "平民", type: "villager" },
    ]);
    let rejected: string | null = null;
    firstClient.onMessage("playRejected", (m: any) => (rejected = m.reason));

    // 第一次：选了毒药但最后跳过 → 不应消耗
    firstClient.send("useSkill", { cardId: "wc1", mode: "poison" });
    await wait();
    assert.strictEqual(pending(room).type, "witchPoison");
    firstClient.send("chooseTarget", { index: -1 }); // 跳过
    await wait();
    assert.strictEqual(pending(room).type, "", "跳过后清空 pending");

    const witch = room.state.players.get(first)!.hand.find((c: any) => c.id === "wc1");
    assert.strictEqual(witch.witchPoisonUsed, false, "跳过后毒药应退还");

    // 换回合前清掉 acted（跳过未消耗行动？acted 仍为 true，这里模拟下一夜）
    firstClient.send("ready");
    await wait();
    secondClient.send("ready");
    await wait();
    firstClient.send("ready");
    await wait();
    secondClient.send("ready");
    await wait();
    assert.strictEqual(room.state.round, 2, "进入第 2 轮");

    // 第 2 夜：毒药还能用（因为之前跳过了）
    rejected = null;
    firstClient.send("useSkill", { cardId: "wc1", mode: "poison" });
    await wait();
    assert.strictEqual(
      pending(room).type,
      "witchPoison",
      `跳过后毒药仍可用，实际拒绝原因：${rejected}`
    );
  });

  it("出牌结算完毕【不会自动结束回合】，仍留在自己回合", async () => {
    const { room, first, second, firstClient, secondClient } = await setup();
    setHand(room, first, [
      { id: "w1", name: "狼人", type: "wolf" },
      { id: "wt", name: "女巫", type: "god", skill: "witch" },
    ]);
    setHand(room, second, [
      { id: "v1", name: "平民", type: "villager" },
      { id: "v2", name: "平民", type: "villager" },
      { id: "v3", name: "平民", type: "villager" },
    ]);

    // P1 出狼刀 v1 → 结算完仍在 P1 回合（不会自动交给 P2）
    firstClient.send("playCard", { id: "w1" });
    await wait();
    firstClient.send("chooseTarget", { index: 0 });
    await wait();

    assert.strictEqual(room.state.turnOwner, first, "出牌结算完仍是我的回合");
    assert.strictEqual(room.state.phase, "night");
    assert.strictEqual(playCount(room, first), 0, "狼已回收");
    assert.strictEqual(room.state.players.get(first)!.handCount, 2);

    // 同一个回合里，还能接着用女巫下毒
    firstClient.send("useSkill", { cardId: "wt", mode: "poison" });
    await wait();
    assert.strictEqual(
      room.state.pendingAction.type,
      "witchPoison",
      "同一回合内出完狼还能用女巫技能"
    );
    firstClient.send("chooseTarget", { index: 1 }); // v1 已被狼刀标记，毒未被标记的 v2
    await wait();
    assert.strictEqual(room.state.turnOwner, first, "用药后依然是我的回合");

    // 只有主动结束回合，才轮到对方
    firstClient.send("ready");
    await wait();
    assert.strictEqual(room.state.turnOwner, second, "主动结束后才轮到 P2");
  });

  it("同一回合内同一张牌只能行动一次（行动过的牌变灰、不可再用）", async () => {
    const { room, first, second, firstClient } = await setup();
    let rejected: string | null = null;
    firstClient.onMessage("playRejected", (m) => (rejected = m.reason));

    setHand(room, first, [
      { id: "w1", name: "狼人", type: "wolf" },
      { id: "wt", name: "女巫", type: "god", skill: "witch" },
    ]);
    setHand(room, second, [
      { id: "v1", name: "平民", type: "villager" },
      { id: "v2", name: "平民", type: "villager" },
    ]);

    // 先用女巫
    firstClient.send("useSkill", { cardId: "wt", mode: "poison" });
    await wait();
    firstClient.send("chooseTarget", { index: 0 });
    await wait();

    // 同一张女巫再用一次 → 拒绝
    // ★ 新规则下提示更具体：先报"这瓶毒药已经用过了"（药剂终身一瓶）
    rejected = null;
    firstClient.send("useSkill", { cardId: "wt", mode: "poison" });
    await wait();
    assert.ok(
      rejected && /毒药已经用过|已经行动过/.test(rejected),
      `重复用同一张牌应被拒，实际：${rejected}`
    );

    // 但同一回合内仍可出另一张狼人牌
    firstClient.send("playCard", { id: "w1" });
    await wait();
    assert.strictEqual(room.state.pendingAction.type, "wolfKnife", "同回合内仍能出其它手牌");
    firstClient.send("chooseTarget", { index: 1 }); // v1 已被毒（标记），刀未被标记的 v2
    await wait();

    // 狼用过了，再出同一张狼 → 拒绝
    rejected = null;
    firstClient.send("playCard", { id: "w1" });
    await wait();
    assert.ok(rejected && /已经行动过/.test(rejected), `重复出同一张狼应被拒，实际：${rejected}`);

    assert.strictEqual(room.state.turnOwner, first, "全程仍在 P1 回合");
  });

  it("狼人/狼王共享一把狼刀：一个狼杀害后，本夜其它狼牌锁定，但女巫不受影响", async () => {
    const { room, first, second, firstClient, secondClient } = await setup();
    let rejected: string | null = null;
    firstClient.onMessage("playRejected", (m) => (rejected = m.reason));

    setHand(room, first, [
      { id: "w1", name: "狼人", type: "wolf" },
      { id: "wk1", name: "狼王", type: "wolf", skill: "wolfKing" },
      { id: "wt", name: "女巫", type: "god", skill: "witch" },
    ]);
    setHand(room, second, [
      { id: "v1", name: "平民", type: "villager" },
      { id: "v2", name: "平民", type: "villager" },
      { id: "v3", name: "平民", type: "villager" },
    ]);

    // P1 出狼刀 v1（index 0）
    firstClient.send("playCard", { id: "w1" });
    await wait();
    firstClient.send("chooseTarget", { index: 0 });
    await wait();
    assert.strictEqual(room.state.wolfKnifeUsed, true, "狼刀已用");
    assert.strictEqual(room.state.turnOwner, first, "仍是我方回合");

    // 再出狼王 → 应被拒绝（与狼人共享同一把刀）
    rejected = null;
    firstClient.send("playCard", { id: "wk1" });
    await wait();
    assert.ok(rejected && /共享一把刀/.test(rejected), `本夜其它狼牌应被锁定，实际：${rejected}`);
    assert.strictEqual(room.state.pendingAction.type, "", "狼王出牌被拒，不进入待结算");

    // 但女巫仍可用药（共享刀只限制狼，不限制神牌）
    firstClient.send("useSkill", { cardId: "wt", mode: "poison" });
    await wait();
    assert.strictEqual(
      room.state.pendingAction.type,
      "witchPoison",
      "狼刀用过后女巫仍能用药（共享刀不限制神）"
    );
    firstClient.send("chooseTarget", { index: 1 }); // v1 已被狼刀标记，毒未被标记的 v2
    await wait();
    assert.strictEqual(room.state.turnOwner, first, "用药后仍在 P1 回合");

    // 走完第 1 轮 → 第 2 夜：本夜狼刀应重置，同一张狼王可再次出刀
    firstClient.send("ready");
    await wait();
    secondClient.send("ready");
    await wait();
    firstClient.send("ready");
    await wait();
    secondClient.send("ready");
    await wait();
    assert.strictEqual(room.state.round, 2, "进入第 2 轮");
    assert.strictEqual(room.state.turnOwner, first, "第 2 夜轮到 P1");
    assert.strictEqual(room.state.wolfKnifeUsed, false, "新夜狼刀重置");
    firstClient.send("playCard", { id: "wk1" });
    await wait();
    assert.strictEqual(
      room.state.pendingAction.type,
      "wolfKnife",
      "新夜狼王可再次出刀（flag 已重置）"
    );
  });

  it("新回合开始 → 上一回合行动过的牌恢复可用（acted 标记被重置）", async () => {
    const { room, first, second, firstClient, secondClient } = await setup();
    setHand(room, first, [{ id: "w1", name: "狼人", type: "wolf" }]);
    setHand(room, second, [
      { id: "v1", name: "平民", type: "villager" },
      { id: "v2", name: "平民", type: "villager" },
      { id: "v3", name: "平民", type: "villager" },
    ]);

    // 第 1 夜 P1 出狼
    firstClient.send("playCard", { id: "w1" });
    await wait();
    firstClient.send("chooseTarget", { index: 0 }); // 刀 v1
    await wait();
    assert.strictEqual(room.state.players.get(first)!.hand[0].acted, true, "本回合已行动");

    // 走完第 1 轮：P1夜结束 → P2夜 → P1昼 → P2昼 → 第 2 夜 P1
    firstClient.send("ready");
    await wait();
    secondClient.send("ready");
    await wait();
    firstClient.send("ready");
    await wait();
    secondClient.send("ready");
    await wait();

    assert.strictEqual(room.state.round, 2, "进入第 2 轮");
    assert.strictEqual(room.state.turnOwner, first, "第 2 夜轮到 P1");

    // 天亮时 v1 已结算进墓地；P2 还剩 v2, v3
    assert.deepStrictEqual(graveIds(room), ["v1"]);
    const hand1 = room.state.players.get(first)!.hand;
    // ★ 补牌机制：P1 上一夜只剩 1 张（≤2），白天结束时从牌库补摸了 1 张
    assert.strictEqual(hand1.length, 2, "白天结束补牌：P1 由 1 张补到 2 张");
    const w1 = hand1.find((c: any) => c.id === "w1");
    assert.ok(w1 && w1.acted === false, "新回合开始，这张牌的 acted 标记已重置");

    // 同一张狼可以再次打出
    firstClient.send("playCard", { id: "w1" });
    await wait();
    assert.strictEqual(room.state.pendingAction.type, "wolfKnife", "新回合可再次使用同一张牌");
  });

  it("被狼刀锁定的牌【仍可行动】：P2 的狼在 P1 夜被锁定，P2 夜照常出刀，天亮才双双结算死亡", async () => {
    const { room, first, second, firstClient, secondClient } = await setup();
    setHand(room, first, [
      { id: "w1", name: "狼人", type: "wolf" },
      { id: "v2", name: "平民", type: "villager" },
    ]);
    setHand(room, second, [
      { id: "w2", name: "狼人", type: "wolf" },
      { id: "v3", name: "平民", type: "villager" },
    ]);

    // P1 黑夜：出狼，锁定 P2 的 w2
    firstClient.send("playCard", { id: "w1" });
    await wait();
    firstClient.send("chooseTarget", { index: 0 }); // 锁定 w2
    await wait();

    // 天黑阶段只是"标记"，不结算死亡
    assert.strictEqual(graveCount(room), 0, "黑夜标记阶段不结算死亡");
    assert.strictEqual(room.state.players.get(second)!.handCount, 2, "w2 仍在 P2 手牌");

    // P1 主动结束黑夜 → 轮到 P2 黑夜
    firstClient.send("ready");
    await wait();
    assert.strictEqual(room.state.turnOwner, second, "轮到 P2 黑夜");

    // w2 虽已被锁定，但【依然可以行动】
    secondClient.send("playCard", { id: "w2" });
    await wait();
    assert.strictEqual(playCount(room, second), 1, "被锁定的 w2 仍可打出（进入行动区）");

    // w2 刀向 P1 的 w1（此时 P1 手牌已恢复为 [w1, v2]）
    secondClient.send("chooseTarget", { index: 0 });
    await wait();
    secondClient.send("ready"); // P2 主动结束黑夜 → 天亮统一结算
    await wait();

    // 天亮统一结算：w2（虽在 P2 夜行动过）与其刀死的 w1 双双进墓地
    const g = graveIds(room);
    assert.ok(g.includes("w2"), "被锁定的 w2 天亮时死亡进墓地（尽管它行动过）");
    assert.ok(g.includes("w1"), "w2 造成的击杀同在天亮结算");
    assert.strictEqual(playCount(room, second), 0, "行动区的 w2 已结算回收");
    assert.strictEqual(room.state.players.get(second)!.handCount, 1, "P2 只剩 v3");
    assert.strictEqual(room.state.players.get(first)!.handCount, 1, "P1 只剩 v2");
  });

  it("其他死亡的牌同理：被锁定的女巫仍可在自己夜晚用药", async () => {
    const { room, first, second, firstClient, secondClient } = await setup();
    setHand(room, first, [
      { id: "w1", name: "狼人", type: "wolf" },
      { id: "v2", name: "平民", type: "villager" },
    ]);
    setHand(room, second, [
      { id: "wt", name: "女巫", type: "god", skill: "witch" },
      { id: "v3", name: "平民", type: "villager" },
    ]);

    // P1 黑夜：出狼锁定 P2 的女巫 wt
    firstClient.send("playCard", { id: "w1" });
    await wait();
    firstClient.send("chooseTarget", { index: 0 }); // 锁定 wt
    await wait();

    // P1 主动结束黑夜 → 轮到 P2 黑夜
    firstClient.send("ready");
    await wait();
    assert.strictEqual(room.state.turnOwner, second, "轮到 P2 黑夜");
    assert.strictEqual(graveCount(room), 0, "标记阶段不结算死亡");

    // 被锁定的女巫【依然可以行动】：用毒药标记 P1 的 v2
    secondClient.send("useSkill", { cardId: "wt", mode: "poison" });
    await wait();
    assert.strictEqual(
      room.state.pendingAction.type,
      "witchPoison",
      "被锁定的女巫仍能用药（不再被拒绝）"
    );
    secondClient.send("chooseTarget", { index: 1 }); // P1 手牌 [w1, v2] → 锁 v2
    await wait();
    secondClient.send("ready"); // P2 主动结束黑夜 → 天亮统一结算
    await wait();

    // 天亮：被锁定的女巫 wt 与被它毒的 v2 双双结算死亡
    const g = graveIds(room);
    assert.ok(g.includes("wt"), "被锁定的女巫天亮时死亡进墓地");
    assert.ok(g.includes("v2"), "女巫造成的毒杀同在天亮结算");
  });

  it("当前行动方结束回合 → 严格按照顺序轮到下家", async () => {
    const { room, first, second, firstClient, secondClient } = await setup();
    assert.strictEqual(room.state.turnOwner, first);

    firstClient.send("ready"); // P1 黑夜跳过
    await wait();
    assert.strictEqual(room.state.turnOwner, second, "轮到 P2 黑夜");
    assert.strictEqual(room.state.phase, "night");

    secondClient.send("ready"); // P2 黑夜跳过 → 天亮
    await wait();
    assert.strictEqual(room.state.phase, "day", "双方跳过黑夜 → 天亮");
    assert.strictEqual(room.state.turnOwner, first, "天亮后轮到 P1 白天");
    assert.strictEqual(room.state.turnSeq, 2);
  });

  it("回合超时 → 自动结束当前行动方回合（交给下家）", async () => {
    const { room, first, second } = await setup({ turnDuration: 600 });
    assert.strictEqual(room.state.turnOwner, first, "开局轮到 P1");

    // 生产环境由房间时钟循环调用 clock.tick() 触发定时器；
    // 测试环境直接调用超时回调，验证会自动把回合交给下家
    (room as any).onTimerExpired();
    await wait(50);

    assert.strictEqual(room.state.phase, "night", "超时只推进一个回合，仍在黑夜");
    assert.strictEqual(room.state.turnOwner, second, "超时后轮到下家");
    assert.strictEqual(room.state.turnSeq, 1, "进入 P2 黑夜");
  });

  it("白天不能出牌（只能流放或跳过）", async () => {
    const { room, first, firstClient, secondClient } = await setup();
    // 先进入 P1 的白天
    firstClient.send("ready");
    secondClient.send("ready");
    await wait();
    assert.strictEqual(room.state.phase, "day");
    assert.strictEqual(room.state.turnOwner, first);

    setHand(room, first, [
      { id: "w1", name: "狼人", type: "wolf" },
      { id: "v1", name: "平民", type: "villager" },
    ]);
    firstClient.send("playCard", { id: "w1" });
    await wait();
    assert.strictEqual(playCount(room, first), 0, "白天不能出牌");
    assert.strictEqual(room.state.players.get(first)!.handCount, 2, "手牌不变");
  });

  it("胜负判定：天亮结算后存活牌耗尽 → 对方获胜", async () => {
    const { room, first, second, firstClient, secondClient } = await setup();
    setHand(room, first, [{ id: "w1", name: "狼人", type: "wolf" }]);
    setHand(room, second, [{ id: "v1", name: "平民", type: "villager" }]);

    firstClient.send("playCard", { id: "w1" });
    await wait();
    firstClient.send("chooseTarget", { index: 0 });
    await wait();
    assert.strictEqual(room.state.winner, "", "黑夜标记阶段还没有胜负");

    firstClient.send("ready"); // P1 主动结束黑夜
    await wait();
    secondClient.send("ready"); // P2 跳过 → 天亮结算
    await wait();
    assert.deepStrictEqual(graveIds(room), ["v1"]);
    assert.strictEqual(room.state.players.get(second)!.handCount, 0);
    assert.strictEqual(room.state.winner, first, "P2 存活牌耗尽，P1 获胜");
    assert.strictEqual(room.state.deadline, 0, "游戏结束后停止计时");
  });

  it("技能结算完毕 → 打出的牌立刻回到手牌，跨夜可再次使用", async () => {
    const { room, first, second, firstClient, secondClient } = await setup();
    setHand(room, first, [{ id: "w1", name: "狼人", type: "wolf" }]);
    setHand(room, second, [
      { id: "v1", name: "平民", type: "villager" },
      { id: "v2", name: "平民", type: "villager" },
    ]);
    // ★ 本用例要验证"存活牌耗尽即判负"，先清空牌库，避免【手牌≤2自动补牌】机制救活 P2
    room.state.deck.clear();

    // 第 1 夜：P1 狼刀 v1 → P1 主动结束 → P2 跳过 → 天亮
    firstClient.send("playCard", { id: "w1" });
    await wait();
    assert.strictEqual(playCount(room, first), 1, "技能待选期间，狼在行动区");
    assert.strictEqual(room.state.players.get(first)!.handCount, 0);
    firstClient.send("chooseTarget", { index: 0 });
    await wait();
    assert.strictEqual(playCount(room, first), 0, "狼刀结算完，狼回到手牌");
    assert.strictEqual(room.state.players.get(first)!.handCount, 1);
    assert.strictEqual(graveCount(room), 0, "黑夜仍不进墓地");

    firstClient.send("ready"); // P1 主动结束黑夜
    await wait();
    secondClient.send("ready"); // P2 跳过黑夜 → 天亮
    await wait();
    assert.strictEqual(room.state.phase, "day");
    assert.deepStrictEqual(graveIds(room), ["v1"]);
    assert.strictEqual(room.state.players.get(second)!.handCount, 1);

    // P1 白天跳过 → P2 白天跳过 → 第 2 夜
    firstClient.send("ready");
    await wait();
    assert.strictEqual(room.state.turnOwner, second);
    secondClient.send("ready");
    await wait();
    assert.strictEqual(room.state.phase, "night");
    assert.strictEqual(room.state.round, 2, "进入第 2 夜");
    assert.strictEqual(room.state.turnOwner, first, "第 2 夜又轮到 P1");

    // 同一张狼再次打出
    firstClient.send("playCard", { id: "w1" });
    await wait();
    assert.deepStrictEqual(pending(room), { type: "wolfKnife", actor: first, zone: "opponentHand" });
    firstClient.send("chooseTarget", { index: 0 }); // 刀 v2
    await wait();
    assert.strictEqual(playCount(room, first), 0, "第二次出牌同样回收");

    firstClient.send("ready"); // P1 主动结束第 2 夜
    await wait();
    secondClient.send("ready"); // P2 跳过 → 天亮
    await wait();
    assert.deepStrictEqual(graveIds(room), ["v1", "v2"]);
    assert.strictEqual(room.state.winner, first, "P2 存活牌耗尽，P1 获胜");
  });

  it("白天流放（可）：本夜死过牌 + 手牌≥3平民 → 可流放对方手牌", async () => {
    const { room, first, second, firstClient, secondClient } = await setup();
    // P1 带 5 平民 + 1 狼；P2 带 1 狼
    setHand(room, first, [
      { id: "v1", name: "平民", type: "villager" },
      { id: "v2", name: "平民", type: "villager" },
      { id: "v3", name: "平民", type: "villager" },
      { id: "v4", name: "平民", type: "villager" },
      { id: "v5", name: "平民", type: "villager" },
      { id: "w1", name: "狼人", type: "wolf" },
    ]);
    setHand(room, second, [{ id: "w2", name: "狼人", type: "wolf" }]);

    // P1 黑夜跳过；P2 黑夜出狼刀中 P1 的 v1（index 0）
    firstClient.send("ready");
    await wait();
    assert.strictEqual(room.state.turnOwner, second);
    secondClient.send("playCard", { id: "w2" });
    await wait();
    secondClient.send("chooseTarget", { index: 0 });
    await wait();
    secondClient.send("ready"); // P2 主动结束黑夜 → 天亮
    await wait();

    // 天亮：v1 进墓地，P1 死过牌；P1 白天手牌剩 4 平民 → 满足流放条件
    assert.strictEqual(room.state.phase, "day");
    assert.strictEqual(room.state.turnOwner, first);
    assert.strictEqual(room.state.players.get(first)!.lostThisNight, true);

    firstClient.send("exile");
    await wait();
    assert.deepStrictEqual(pending(room), { type: "exile", actor: first, zone: "opponentHand" });
    firstClient.send("chooseTarget", { index: 0 }); // 流放 P2 唯一的 w2
    await wait();

    assert.deepStrictEqual(graveIds(room), ["v1", "w2"]);
    assert.strictEqual(room.state.players.get(second)!.handCount, 0);
    assert.strictEqual(room.state.winner, first, "流放导致 P2 存活牌耗尽，P1 获胜");
  });

  it("白天流放（不可）：未死过牌 → 被拒绝", async () => {
    const { room, first, second, firstClient, secondClient } = await setup();
    setHand(room, first, [
      { id: "v1", name: "平民", type: "villager" },
      { id: "v2", name: "平民", type: "villager" },
      { id: "v3", name: "平民", type: "villager" },
      { id: "v4", name: "平民", type: "villager" },
      { id: "v5", name: "平民", type: "villager" },
      { id: "v6", name: "平民", type: "villager" },
    ]);
    setHand(room, second, [{ id: "w2", name: "狼人", type: "wolf" }]);

    firstClient.send("ready"); // P1 黑夜跳过
    secondClient.send("ready"); // P2 黑夜跳过 → 天亮（无人死亡）
    await wait();
    assert.strictEqual(room.state.phase, "day");
    assert.strictEqual(room.state.turnOwner, first);
    assert.strictEqual(room.state.players.get(first)!.lostThisNight, false, "P1 本夜没死过牌");

    firstClient.send("exile");
    await wait();
    assert.strictEqual(room.state.pendingAction.type, "", "未死过牌，流放被拒绝");
    assert.strictEqual(room.state.turnOwner, first, "回合未受影响");
  });

  it("白天流放（不可）：死过牌但平民不足 3 → 被拒绝", async () => {
    const { room, first, second, firstClient, secondClient } = await setup();
    setHand(room, first, [
      { id: "w1", name: "狼人", type: "wolf" },
      { id: "w2", name: "狼人", type: "wolf" },
      { id: "h1", name: "猎人", type: "god", skill: "hunter" },
    ]);
    setHand(room, second, [{ id: "w3", name: "狼人", type: "wolf" }]);

    firstClient.send("ready"); // P1 黑夜跳过
    await wait();
    secondClient.send("playCard", { id: "w3" }); // P2 出狼刀中 P1 的 w1（index 0）
    await wait();
    secondClient.send("chooseTarget", { index: 0 });
    await wait();
    secondClient.send("ready"); // P2 主动结束黑夜 → 天亮
    await wait();

    assert.strictEqual(room.state.phase, "day");
    assert.strictEqual(room.state.turnOwner, first);
    assert.strictEqual(room.state.players.get(first)!.lostThisNight, true, "P1 死过牌");
    // P1 手牌剩 [w2, h1]，0 个平民 < 3 → 不满足
    assert.strictEqual(room.state.players.get(first)!.handCount, 2);

    firstClient.send("exile");
    await wait();
    assert.strictEqual(room.state.pendingAction.type, "", "平民不足，流放被拒绝");
  });

  it("流放资格只看【本夜】自家死过牌：白天被流放掉牌不给对方送资格", async () => {
    const { room, first, second, firstClient, secondClient } = await setup();
    setHand(room, first, [
      { id: "v1", name: "平民", type: "villager" },
      { id: "v2", name: "平民", type: "villager" },
      { id: "v3", name: "平民", type: "villager" },
      { id: "v4", name: "平民", type: "villager" },
    ]);
    setHand(room, second, [
      { id: "w1", name: "狼人", type: "wolf" },
      { id: "v5", name: "平民", type: "villager" },
      { id: "v6", name: "平民", type: "villager" },
      { id: "v7", name: "平民", type: "villager" },
      { id: "v8", name: "平民", type: "villager" },
    ]);

    // 第 1 夜：P1 跳过 → P2 刀掉 P1 的 v1 → 天亮
    firstClient.send("ready");
    await wait();
    secondClient.send("playCard", { id: "w1" });
    await wait();
    secondClient.send("chooseTarget", { index: 0 });
    await wait();
    secondClient.send("ready");
    await wait();

    assert.strictEqual(room.state.players.get(first)!.lostThisNight, true, "P1 本夜死了牌");
    assert.strictEqual(room.state.players.get(second)!.lostThisNight, false, "P2 本夜没死牌");

    // P1 白天流放 P2 的一张平民（v5）
    firstClient.send("exile");
    await wait();
    assert.strictEqual(pending(room).type, "exile", "P1 满足流放条件（本夜死过牌 + 3 票）");
    firstClient.send("chooseTarget", { index: 1 });
    await wait();

    // 这一张是【白天】死的，P2 依旧没有流放资格（票权 3 仍然够，唯一卡的是"本夜没死过牌"）
    assert.strictEqual(room.state.players.get(second)!.lostThisNight, false, "白天的死亡不算本夜死亡");
    assert.strictEqual(room.state.turnOwner, second, "轮到 P2 白天");
    assert.strictEqual(room.state.players.get(second)!.handCount, 4);

    secondClient.send("exile");
    await wait();
    assert.strictEqual(pending(room).type, "", "P2 本夜没死过牌 → 不能流放");
  });

  it("yourTurn：轮到某人时，只有该玩家收到醒目提示", async () => {
    const { room, first, second, firstClient, secondClient } = await setup();
    setHand(room, first, [{ id: "w1", name: "狼人", type: "wolf" }]);
    setHand(room, second, [{ id: "v1", name: "平民", type: "villager" }, { id: "v2", name: "平民", type: "villager" }]);

    const myTurns: any[] = [];
    const oppTurns: any[] = [];
    firstClient.onMessage("yourTurn", (m: any) => myTurns.push(m));
    secondClient.onMessage("yourTurn", (m: any) => oppTurns.push(m));

    // 开局时 P1 已是先手，firstClient 已收到 1 条
    const baseFirst = myTurns.length;

    // P1 出狼 → 结算完仍在自己回合 → 主动结束 → 应只有 P2 收到 yourTurn
    firstClient.send("playCard", { id: "w1" });
    await wait();
    firstClient.send("chooseTarget", { index: 0 });
    await wait();
    assert.strictEqual(room.state.turnOwner, first, "出牌结算完仍是 P1 回合");
    assert.strictEqual(oppTurns.length, 0, "P1 还没结束回合，P2 不应收到 yourTurn");
    firstClient.send("ready");
    await wait();
    assert.strictEqual(oppTurns.length, 1, "P2 收到 exactly 一条 yourTurn");
    assert.strictEqual(oppTurns[0].phase, "night");
    assert.strictEqual(oppTurns[0].round, 1);
    assert.ok(oppTurns[0].deadline > 0);
    assert.strictEqual(myTurns.length, baseFirst, "行动方自己不会重复收到");

    // P2 结束回合 → 天亮 → P1 的白天回合，firstClient 再收到一条
    secondClient.send("ready");
    await wait();
    assert.strictEqual(room.state.phase, "day");
    assert.strictEqual(myTurns.length, baseFirst + 1, "P1 的白天回合也收到 yourTurn");
    assert.strictEqual(oppTurns.length, 1, "P2 没有重复收到（上回合已行动过）");
  });

  it("对局中有人离开 → 剩余玩家直接获胜", async () => {
    const { room, first, secondClient } = await setup();
    await secondClient.leave(true);
    await wait(300);

    assert.strictEqual(room.state.players.size, 1);
    assert.strictEqual(room.state.winner, first, "对手离开，P1 获胜");
    assert.strictEqual(room.state.deadline, 0);
  });

  // ==========================================================================
  //  新增卡牌：长老（2 票）/ 盗贼（强制换牌）/ 大野狼（额外狼刀）
  // ==========================================================================

  it("长老：2 票权 —— 2 平民 + 1 长老即可满足白天流放的 ≥3 票", async () => {
    const { room, first, second, firstClient, secondClient } = await setup();
    setHand(room, first, [
      { id: "v1", name: "平民", type: "villager" },
      { id: "v2", name: "平民", type: "villager" },
      { id: "e1", name: "长老", type: "villager", skill: "elder" },
    ]);
    setHand(room, second, [
      { id: "v3", name: "平民", type: "villager" },
      { id: "v4", name: "平民", type: "villager" },
      { id: "v5", name: "平民", type: "villager" },
    ]);
    // P1夜跳过 → P2夜跳过 → 天亮 → P1昼
    firstClient.send("ready");
    await wait();
    secondClient.send("ready");
    await wait();
    assert.strictEqual(room.state.phase, "day");
    assert.strictEqual(room.state.turnOwner, first);

    // 手动置位"本夜死过牌"（等价于本夜真的损失了一张牌）
    room.state.players.get(first).lostThisNight = true;
    firstClient.send("exile");
    await wait();
    assert.strictEqual(
      room.state.pendingAction.type,
      "exile",
      "2 平民(1+1) + 长老(2) = 4 票 ≥3 → 应可流放"
    );
    firstClient.send("chooseTarget", { index: -1 });
    await wait();
    assert.strictEqual(room.state.pendingAction.type, "", "放弃流放后清空 pending");
  });

  it("长老：只有 2 张普通平民（2 票）不够，不能流放", async () => {
    const { room, first, second, firstClient, secondClient } = await setup();
    setHand(room, first, [
      { id: "v1", name: "平民", type: "villager" },
      { id: "v2", name: "平民", type: "villager" },
    ]);
    setHand(room, second, [
      { id: "v3", name: "平民", type: "villager" },
      { id: "v4", name: "平民", type: "villager" },
    ]);
    firstClient.send("ready");
    await wait();
    secondClient.send("ready");
    await wait();
    assert.strictEqual(room.state.phase, "day");

    room.state.players.get(first).lostThisNight = true;
    let rejected: string | null = null;
    firstClient.onMessage("playRejected", (m: any) => (rejected = m.reason));
    firstClient.send("exile");
    await wait();
    assert.ok(
      rejected && /票权≥3/.test(rejected),
      `2 票不应满足 3 票阈值，实际：${rejected}`
    );
    assert.strictEqual(room.state.pendingAction.type, "", "不应进入流放选目标");
  });

  it("票权放开：狼人 / 神职 各算 1 票（除长老外所有身份各 1 票）→ 狼+神+平民 即满足流放", async () => {
    const { room, first, second, firstClient, secondClient } = await setup();
    setHand(room, first, [
      { id: "w1", name: "狼人", type: "wolf" },
      { id: "g1", name: "预言家", type: "god", skill: "seer" },
      { id: "v1", name: "平民", type: "villager" },
    ]);
    setHand(room, second, [
      { id: "v3", name: "平民", type: "villager" },
      { id: "v4", name: "平民", type: "villager" },
    ]);
    firstClient.send("ready");
    await wait();
    secondClient.send("ready");
    await wait();
    assert.strictEqual(room.state.phase, "day");

    room.state.players.get(first).lostThisNight = true;
    firstClient.send("exile");
    await wait();
    assert.strictEqual(
      room.state.pendingAction.type,
      "exile",
      "狼(1) + 神(1) + 平民(1) = 3 票 ≥3 → 应可流放（票权已放开）"
    );
    firstClient.send("chooseTarget", { index: -1 });
    await wait();
    assert.strictEqual(room.state.pendingAction.type, "", "放弃流放后清空 pending");
  });

  it("特殊牌唯一：全局仅 1 张盗贼，开局不再保底、也不会自动换牌", async () => {
    const { room, first, second, firstClient, secondClient } = await setup();

    const isThief = (id: string) => String(id).startsWith("thief-");
    const all: any[] = [...room.state.deck];
    room.state.players.forEach((p: any) => all.push(...p.hand));
    assert.strictEqual(all.filter((c: any) => isThief(c.id)).length, 1, "整副牌只有 1 张盗贼");

    assert.strictEqual(room.state.players.get(first)!.hand.length, 6);
    assert.strictEqual(room.state.players.get(second)!.hand.length, 6);

    // 客户端视角：两边都能完整看到自己的手牌
    await wait(200);
    const firstView = Array.from(firstClient.state.players.get(first)!.hand as any[]);
    const secondView = Array.from(secondClient.state.players.get(second)!.hand as any[]);
    assert.strictEqual(firstView.length, 6, "P1 客户端能完整看到自己 6 张手牌");
    assert.strictEqual(secondView.length, 6, "P2 客户端能完整看到自己 6 张手牌");
    firstView.forEach((c: any) =>
      assert.ok(c && c.id && c.name, "每条手牌数据都应是完整的卡对象")
    );

    // ★ 盗贼是纯手动技能：谁都没点，走完一整夜也应该原封不动留在手上。
    firstClient.send("ready"); // 结束 P1 夜 → 进入 P2 夜
    await wait();
    secondClient.send("ready"); // 结束 P2 夜 → 天亮
    await wait();

    const fresh = all.filter((c: any) => isThief(c.id) && c.thiefUsed === false && c.skill === "thief");
    assert.ok(fresh.length <= 1, "盗贼未被自动发动");
    assert.strictEqual(room.state.players.get(first)!.hand.length, 6, "手牌数量不变");
    assert.strictEqual(room.state.players.get(second)!.hand.length, 6, "手牌数量不变");
  });

  it("盗贼：没有兜底 —— 整夜不点牌就永远不会自动交换，技能一直留着", async () => {
    const { room, first, second, firstClient, secondClient } = await setup();
    setHand(room, first, [
      { id: "th1", name: "盗贼", type: "villager", skill: "thief" },
      { id: "v1", name: "平民", type: "villager" },
      { id: "w1", name: "狼人", type: "wolf" },
    ]);
    setHand(room, second, [
      { id: "v2", name: "平民", type: "villager" },
      { id: "v3", name: "平民", type: "villager" },
      { id: "v4", name: "平民", type: "villager" },
    ]);

    // 走完整个第 1 轮（P1夜 → P2夜 → P1昼 → P2昼），全程没点过盗贼
    firstClient.send("ready");
    await wait();
    secondClient.send("ready");
    await wait();
    firstClient.send("ready");
    await wait();
    secondClient.send("ready");
    await wait();
    assert.strictEqual(room.state.round, 2, "进入第 2 轮");

    const firstIds = room.state.players.get(first)!.hand.map((c: any) => c.id);
    const secondIds = room.state.players.get(second)!.hand.map((c: any) => c.id);
    assert.ok(firstIds.indexOf("th1") >= 0, "★ 没点过 → 盗贼必须还在 P1 手上");
    assert.ok(secondIds.indexOf("th1") === -1, "对手不该凭空拿到盗贼");
    assert.strictEqual(firstIds.length, 3, "手牌没被动过");
    assert.strictEqual(secondIds.length, 3, "手牌没被动过");

    const thief = room.state.players
      .get(first)!
      .hand.find((c: any) => c.id === "th1");
    assert.strictEqual(thief.thiefUsed, false, "技能还没用掉");
    assert.strictEqual(thief.skill, "thief", "技能标识仍在");

    // 第 2 夜 P1 回合：随时可以手动发动（打出 → 选目标），技能没被"过期"掉
    assert.strictEqual(room.state.turnOwner, first, "现在是 P1 的夜晚回合");
    firstClient.send("playCard", { id: "th1" });
    await wait();
    assert.strictEqual(pending(room).type, "thiefSwap", "隔了一轮依旧能手动发动");
    firstClient.send("chooseTarget", { index: 0 });
    await wait();
    const ids2 = room.state.players.get(first)!.hand.map((c: any) => c.id);
    const ids2o = room.state.players.get(second)!.hand.map((c: any) => c.id);
    assert.ok(ids2.indexOf("v2") >= 0, "手动发动：换到了对手那张牌");
    assert.ok(ids2o.indexOf("th1") >= 0, "手动发动：盗贼交给对手");
  });

  it("盗贼：打出到行动区 → 选择对手一张手牌交换（选中的归我，盗贼归对方且变白板）", async () => {
    const { room, first, second, firstClient } = await setup();
    setHand(room, first, [
      { id: "th1", name: "盗贼", type: "villager", skill: "thief" },
      { id: "v1", name: "平民", type: "villager" },
    ]);
    setHand(room, second, [
      { id: "v2", name: "平民", type: "villager" },
      { id: "v3", name: "平民", type: "villager" },
    ]);

    // 1) 夜里点盗贼 → 进【自己的行动区】，并进入"选择交换目标"
    firstClient.send("playCard", { id: "th1" });
    await wait();
    assert.strictEqual(pending(room).type, "thiefSwap", "打出盗贼后应进入『选择交换目标』");
    assert.strictEqual(pending(room).zone, "opponentHand", "从对方手牌里选");
    assert.strictEqual(playCount(room, first), 1, "盗贼应躺在自己的行动区");
    assert.ok(
      room.state.players.get(first)!.play.some((c: any) => c.id === "th1"),
      "行动区里那张就是盗贼"
    );
    assert.strictEqual(room.state.players.get(first)!.hand.length, 1, "盗贼已离开手牌");

    // 2) 选对手的第 1 张（v2）→ 交换生效
    firstClient.send("chooseTarget", { index: 0 });
    await wait();

    const firstIds = room.state.players.get(first)!.hand.map((c: any) => c.id);
    const secondIds = room.state.players.get(second)!.hand.map((c: any) => c.id);
    assert.ok(firstIds.indexOf("v2") >= 0, "选中的对手手牌应加入我方手牌");
    assert.ok(secondIds.indexOf("th1") >= 0, "盗贼应交给对手");
    assert.ok(firstIds.indexOf("th1") === -1, "我方不再持有盗贼");
    assert.strictEqual(firstIds.length, 2, "双方手牌数量不变");
    assert.strictEqual(secondIds.length, 2, "双方手牌数量不变");
    assert.strictEqual(playCount(room, first), 0, "行动区应被清空");
    assert.strictEqual(pending(room).type, "", "结算完成");

    const traded = room.state.players
      .get(second)!
      .hand.find((c: any) => c.id === "th1");
    assert.strictEqual(traded.thiefUsed, true, "交换过的盗贼标记为已用");
    assert.strictEqual(traded.skill, "", "★ 技能直接抹除 → 白板平民");
    assert.strictEqual(traded.type, "villager", "身份仍是平民");

    // 3) 交换完不停顿：仍停在本方回合，还能继续行动
    assert.strictEqual(room.state.turnOwner, first, "仍停在本方回合");
    assert.strictEqual(room.state.turnActed, false, "不算结束回合");
  });

  it("盗贼：可以换走对手的盗贼，换来的那张自己还能再发动", async () => {
    const { room, first, second, firstClient } = await setup();
    setHand(room, first, [
      { id: "th1", name: "盗贼", type: "villager", skill: "thief" },
    ]);
    setHand(room, second, [
      { id: "th2", name: "盗贼", type: "villager", skill: "thief" },
      { id: "v2", name: "平民", type: "villager" },
    ]);

    firstClient.send("playCard", { id: "th1" });
    await wait();
    // 直接选对手那张盗贼（index 0）—— 允许交换
    firstClient.send("chooseTarget", { index: 0 });
    await wait();

    const mine = room.state.players.get(first)!.hand;
    const theirs = room.state.players.get(second)!.hand;
    assert.ok(mine.some((c: any) => c.id === "th2"), "对手的盗贼被我换到手上了");
    assert.ok(theirs.some((c: any) => c.id === "th1"), "我的盗贼交给对手");
    const traded = theirs.find((c: any) => c.id === "th1");
    assert.strictEqual(traded.skill, "", "交出去的是白板平民");

    const got = mine.find((c: any) => c.id === "th2");
    assert.strictEqual(got.thiefUsed, false, "换来的盗贼技能还在");
    assert.strictEqual(got.skill, "thief", "换来的盗贼仍可使用");
  });

  it("盗贼：换走已被狼刀锁定的牌 → 死亡跟着牌走（天亮死在我方墓地）", async () => {
    const { room, first, second, firstClient, secondClient } = await setup();
    setHand(room, first, [
      { id: "w1", name: "狼人", type: "wolf" },
      { id: "th1", name: "盗贼", type: "villager", skill: "thief" },
    ]);
    setHand(room, second, [
      { id: "v1", name: "平民", type: "villager" },
      { id: "v2", name: "平民", type: "villager" },
    ]);

    // 1) 狼刀锁定对方的 v1（天亮才死）
    firstClient.send("playCard", { id: "w1" });
    await wait();
    firstClient.send("chooseTarget", { index: 0 });
    await wait();

    // 2) 同一回合再出盗贼，把那张已被锁定的 v1 换到自己手上
    firstClient.send("playCard", { id: "th1" });
    await wait();
    assert.strictEqual(pending(room).type, "thiefSwap");
    firstClient.send("chooseTarget", { index: 0 });
    await wait();
    assert.ok(
      room.state.players.get(first)!.hand.some((c: any) => c.id === "v1"),
      "被锁定的 v1 已到我手上"
    );

    // 3) 天亮：死亡标记应跟着牌走 → v1 进【我方】墓地，而不是留在对方手上被"复制"
    firstClient.send("ready");
    await wait();
    secondClient.send("ready");
    await wait();

    const myGrave = graveyardOf(room, first).map((c: any) => c.id);
    const oppGrave = graveyardOf(room, second).map((c: any) => c.id);
    assert.ok(myGrave.indexOf("v1") >= 0, "v1 死在我方墓地（死亡跟着牌走）");
    assert.strictEqual(oppGrave.indexOf("v1"), -1, "对方墓地不该有 v1");
    assert.ok(
      !room.state.players.get(second)!.hand.some((c: any) => c.id === "v1"),
      "对方手上也不该还留着 v1"
    );
  });

  it("盗贼：自己已被狼刀锁定 → 先完成交换，再死到对手手上（对手墓地）", async () => {
    const { room, first, second, firstClient, secondClient } = await setup();
    setHand(room, first, [
      { id: "w1", name: "狼人", type: "wolf" },
      { id: "v1", name: "平民", type: "villager" },
    ]);
    setHand(room, second, [
      { id: "th1", name: "盗贼", type: "villager", skill: "thief" },
      { id: "v2", name: "平民", type: "villager" },
    ]);

    // 1) P1 夜里刀 P2 的盗贼（天亮才结算）
    firstClient.send("playCard", { id: "w1" });
    await wait();
    firstClient.send("chooseTarget", { index: 0 });
    await wait();

    // 2) 轮到 P2：用这张已被锁定的盗贼换走 P1 的狼人
    firstClient.send("ready");
    await wait();
    secondClient.send("playCard", { id: "th1" });
    await wait();
    assert.strictEqual(pending(room).type, "thiefSwap");
    secondClient.send("chooseTarget", { index: 0 }); // 换走 P1 的 w1
    await wait();

    // ★ 交换先发生：盗贼到了 P1 手上（技能已抹除），狼人到了 P2 手上
    assert.ok(
      room.state.players.get(first)!.hand.some((c: any) => c.id === "th1"),
      "盗贼已换到 P1 手上"
    );
    assert.ok(
      room.state.players.get(second)!.hand.some((c: any) => c.id === "w1"),
      "P2 换走了 P1 的狼人"
    );

    // 3) 天亮：盗贼死在【P1】手上 → 进 P1 的墓地
    secondClient.send("ready");
    await wait();
    assert.strictEqual(room.state.phase, "day");

    const p1Grave = graveyardOf(room, first).map((c: any) => c.id);
    const p2Grave = graveyardOf(room, second).map((c: any) => c.id);
    assert.ok(p1Grave.indexOf("th1") >= 0, "盗贼死在 P1 的墓地（死亡跟着牌走）");
    assert.ok(
      !room.state.players.get(first)!.hand.some((c: any) => c.id === "th1"),
      "P1 手上不再有这张盗贼"
    );
    assert.strictEqual(p2Grave.indexOf("th1"), -1, "P2 墓地不该有盗贼");
    assert.ok(
      room.state.players.get(second)!.hand.some((c: any) => c.id === "w1"),
      "换走的狼人不受影响，仍在 P2 手上"
    );
  });

  it("大野狼：共用刀已被用掉时，它只剩额外刀（一夜只能再杀 1 个）", async () => {
    const { room, first, second, firstClient, secondClient } = await setup();
    setHand(room, first, [
      { id: "w1", name: "狼人", type: "wolf" },
      { id: "gw1", name: "大野狼", type: "wolf", skill: "greatWolf" },
      { id: "v9", name: "平民", type: "villager" },
    ]);
    setHand(room, second, [
      { id: "v1", name: "平民", type: "villager" },
      { id: "v2", name: "平民", type: "villager" },
      { id: "v3", name: "平民", type: "villager" },
    ]);
    let rejected: string | null = null;
    firstClient.onMessage("playRejected", (m: any) => (rejected = m.reason));

    // 先用普通狼刀杀 v1
    firstClient.send("playCard", { id: "w1" });
    await wait();
    firstClient.send("chooseTarget", { index: 0 });
    await wait();
    assert.strictEqual(room.state.wolfKnifeUsed, true, "共用刀已消耗");

    // 再用大野狼：不受共用刀限制
    rejected = null;
    firstClient.send("playCard", { id: "gw1" });
    await wait();
    assert.strictEqual(
      room.state.pendingAction.type,
      "wolfKnife",
      `大野狼应有独立的一把刀，实际被拒原因：${rejected}`
    );
    firstClient.send("chooseTarget", { index: 1 }); // 再杀 v2（index 0 的 v1 已被锁定，不能重复选）
    await wait();
    assert.strictEqual(room.state.turnOwner, first, "杀完仍停在 P1 回合");
    assert.strictEqual(room.state.wolfKnifeUsed, true, "共用刀状态不变");

    // 额外刀只有一把：大野狼这一夜不能再动
    rejected = null;
    firstClient.send("playCard", { id: "gw1" });
    await wait();
    assert.strictEqual(pending(room).type, "", "大野狼的额外刀本夜已用完，不能再出刀");
    assert.ok(rejected, `应给出拒绝原因，实际：${rejected}`);

    // 天亮：两张被刀的牌一起结算
    firstClient.send("ready");
    await wait();
    secondClient.send("ready");
    await wait();
    assert.strictEqual(room.state.phase, "day");
    assert.ok(graveIds(room).indexOf("v1") >= 0, "v1 天亮死亡");
    assert.ok(graveIds(room).indexOf("v2") >= 0, "v2 天亮死亡（大野狼额外一刀）");
    assert.strictEqual(graveIds(room).length, 2, "只死了两张（大野狼没能再补第三刀）");
  });

  it("大野狼：第一刀算共用刀 → 同回合还能用额外刀再杀一个", async () => {
    const { room, first, second, firstClient, secondClient } = await setup();
    setHand(room, first, [
      { id: "gw1", name: "大野狼", type: "wolf", skill: "greatWolf" },
      { id: "w1", name: "狼人", type: "wolf" },
      { id: "v9", name: "平民", type: "villager" },
    ]);
    setHand(room, second, [
      { id: "v1", name: "平民", type: "villager" },
      { id: "v2", name: "平民", type: "villager" },
      { id: "v3", name: "平民", type: "villager" },
    ]);
    let rejected: string | null = null;
    firstClient.onMessage("playRejected", (m: any) => (rejected = m.reason));

    // 先出大野狼：这一刀【占用共用刀】
    firstClient.send("playCard", { id: "gw1" });
    await wait();
    firstClient.send("chooseTarget", { index: 0 }); // 杀 v1
    await wait();
    assert.strictEqual(room.state.wolfKnifeUsed, true, "大野狼第一刀占用了共用刀");
    const gw = room.state.players.get(first)!.hand.find((c: any) => c.id === "gw1")!;
    assert.strictEqual(gw.acted, false, "第一刀结算完，大野狼还能再动（额外刀）");

    // 共用刀已被大野狼占用 → 普通狼人不能出刀
    rejected = null;
    firstClient.send("playCard", { id: "w1" });
    await wait();
    assert.strictEqual(pending(room).type, "", "普通狼人被共用刀挡住");
    assert.ok(rejected, `应给出拒绝原因，实际：${rejected}`);

    // 大野狼的第二刀（额外刀）：同回合可以直接再点
    firstClient.send("playCard", { id: "gw1" });
    await wait();
    assert.strictEqual(pending(room).type, "wolfKnife", "额外刀可用");
    firstClient.send("chooseTarget", { index: 1 }); // 再杀 v2
    await wait();
    const gw2 = room.state.players.get(first)!.hand.find((c: any) => c.id === "gw1")!;
    assert.strictEqual(gw2.acted, true, "额外刀用掉后不能再动");

    firstClient.send("ready");
    await wait();
    secondClient.send("ready");
    await wait();
    assert.strictEqual(room.state.phase, "day");
    assert.deepStrictEqual(graveIds(room).sort(), ["v1", "v2"], "大野狼一夜两刀带走两张");
  });

  it("锈剑骑士：被狼刀杀 → 反噬拖走对面威胁最高的狼（不触发其技能）", async () => {
    const { room, first, second, firstClient, secondClient } = await setup();
    setHand(room, first, [
      { id: "w1", name: "狼人", type: "wolf" },
      { id: "wk", name: "狼王", type: "wolf", skill: "wolfKing" },
      { id: "wp", name: "狼人", type: "wolf" },
      { id: "v8", name: "平民", type: "villager" },
    ]);
    setHand(room, second, [
      { id: "rk", name: "锈剑骑士", type: "god", skill: "rustKnight" },
      { id: "v3", name: "平民", type: "villager" },
    ]);

    // P1（狼方）出刀杀 P2 的锈剑骑士（位于 P2 手牌 index 0）
    firstClient.send("playCard", { id: "w1" });
    await wait();
    firstClient.send("chooseTarget", { index: 0 });
    await wait();

    // 天亮结算
    firstClient.send("ready");
    await wait();
    secondClient.send("ready");
    await wait();

    // 锈剑骑士确实被狼刀杀死
    const p2Grave = graveyardOf(room, second).map((c: any) => c.id);
    assert.ok(p2Grave.includes("rk"), "锈剑骑士进了 P2 墓地");
    // 反噬拖走的是威胁最高的狼王（而非普通狼人 wp / 出刀的 w1）
    const p1Grave = graveyardOf(room, first).map((c: any) => c.id).sort();
    assert.ok(p1Grave.includes("wk"), "狼王被反噬拖走");
    assert.deepStrictEqual(p1Grave, ["wk"], "只拖走狼王，普通狼人幸免");
    // ★ 不触发狼王技能：P2 没有因此额外失去手牌
    assert.strictEqual(p2Grave.length, 1, "狼王带人技能被压制，P2 无额外伤亡");
  });

  it("种狼：用共用刀杀敌后，从己方墓地选一张变狼入伙", async () => {
    const { room, first, second, firstClient, secondClient } = await setup();
    setHand(room, first, [
      { id: "bw", name: "种狼", type: "wolf", skill: "breedWolf" },
      { id: "v9", name: "平民", type: "villager" },
    ]);
    setHand(room, second, [
      { id: "v1", name: "平民", type: "villager" },
      { id: "v2", name: "平民", type: "villager" },
    ]);
    // P1 墓地放一张牌（种狼将把它变为狼人）
    const mk = (id: string, name: string, type: string, skill = "") => {
      const c = new Card();
      c.id = id; c.name = name; c.type = type; c.skill = skill; c.owner = first;
      return c;
    };
    room.state.players.get(first).graveyard.push(mk("old1", "长老", "villager", "elder"));

    // P1 出种狼杀 P2 的 v1
    firstClient.send("playCard", { id: "bw" });
    await wait();
    firstClient.send("chooseTarget", { index: 0 });
    await wait();

    // 天亮结算：种狼击杀触发，P1 需从墓地选牌
    firstClient.send("ready");
    await wait();
    secondClient.send("ready");
    await wait();

    assert.strictEqual(pending(room).type, "breedWolf", "种狼击杀后等待从墓地选牌");
    assert.strictEqual(pending(room).zone, "graveyard");
    assert.strictEqual(pending(room).actor, first, "选牌者是种狼使用者");

    // 选墓地第 0 张（old1）→ 变为狼人加入手牌
    firstClient.send("chooseTarget", { index: 0 });
    await wait();
    const newWolf = room.state.players.get(first).hand.find((c: any) => c.id === "old1");
    assert.ok(newWolf, "墓地的 old1 回到 P1 手牌");
    assert.strictEqual(newWolf.type, "wolf", "old1 变成狼人");
    assert.strictEqual(newWolf.skill, "", "白板狼人无技能");
    assert.strictEqual(newWolf.name, "狼人");
    assert.strictEqual(graveyardOf(room, first).length, 0, "墓地已空");
    assert.ok(handIdx(room, second, "v1") < 0, "v1 已被种狼杀死");
  });

  it("毒狼：死亡带走对手一张手牌（算作毒杀）", async () => {
    const { room, first, second, firstClient, secondClient } = await setup();
    setHand(room, first, [
      { id: "pw", name: "毒狼", type: "wolf", skill: "poisonWolf" },
      { id: "v9", name: "平民", type: "villager" },
    ]);
    setHand(room, second, [
      { id: "w2", name: "狼人", type: "wolf" },
      { id: "v1", name: "平民", type: "villager" },
      { id: "v2", name: "平民", type: "villager" },
    ]);

    // P1 先过（夜晚先手）
    firstClient.send("ready");
    await wait();
    // P2（狼）出刀杀 P1 的毒狼（P1 手牌 index 0）
    secondClient.send("playCard", { id: "w2" });
    await wait();
    secondClient.send("chooseTarget", { index: 0 });
    await wait();
    assert.strictEqual(room.state.wolfKnifeUsed, true);

    // 天亮结算：毒狼死亡触发带走
    secondClient.send("ready");
    await wait();

    // 毒狼已死，且触发死亡带走 → P1（毒狼使用者）需选一张对手手牌毒杀
    assert.ok(
      graveyardOf(room, first).map((c: any) => c.id).includes("pw"),
      "毒狼进了 P1 墓地"
    );
    assert.strictEqual(pending(room).type, "poisonWolf", "毒狼死亡触发毒杀选牌");
    assert.strictEqual(pending(room).actor, first, "选牌者是毒狼使用者（P1）");

    // P1 选 P2 的 v1 毒杀（w2 出刀后回到手牌 index 0，故 v1 在 index 1）
    firstClient.send("chooseTarget", { index: 1 });
    await wait();
    assert.ok(handIdx(room, second, "v1") < 0, "v1 被毒狼毒杀带走");
    assert.ok(
      graveyardOf(room, second).map((c: any) => c.id).includes("v1"),
      "v1 进入 P2 墓地（毒杀）"
    );
  });

  it("白狼王：白天自爆带走对方一张手牌，自己同时进墓地，且不触发死亡技能", async () => {
    const { room, first, second, firstClient, secondClient } = await setup();
    setHand(room, first, [
      { id: "ww1", name: "白狼王", type: "wolf", skill: "whiteWolfKing" },
      { id: "v9", name: "平民", type: "villager" },
    ]);
    setHand(room, second, [
      { id: "h1", name: "猎人", type: "god", skill: "hunter" },
      { id: "v2", name: "平民", type: "villager" },
      { id: "v3", name: "平民", type: "villager" },
    ]);

    // 走完黑夜 → 天亮 → P1 白天
    firstClient.send("ready");
    await wait();
    secondClient.send("ready");
    await wait();
    assert.strictEqual(room.state.phase, "day", "进入白天");
    assert.strictEqual(room.state.turnOwner, first, "白天先手是 P1");

    firstClient.send("playCard", { id: "ww1" });
    await wait();
    assert.strictEqual(pending(room).type, "whiteWolfBlast", "白天可自爆");

    firstClient.send("chooseTarget", { index: 0 }); // 带走猎人
    await wait();

    assert.strictEqual(pending(room).type, "", "自爆是沉默死亡：猎人不开枪，无任何连锁");
    assert.ok(graveIds(room).indexOf("h1") >= 0, "猎人被带走，进入墓地");
    assert.ok(graveIds(room).indexOf("ww1") >= 0, "白狼王自爆后死亡");
    assert.ok(
      room.state.players.get(first)!.graveyard.some((c: any) => c.id === "ww1"),
      "白狼王进自己的墓地"
    );
    assert.ok(
      room.state.players.get(second)!.graveyard.some((c: any) => c.id === "h1"),
      "猎人进对方的墓地"
    );
    assert.strictEqual(
      room.state.players.get(second)!.hand.length,
      2,
      "对方少了一张手牌（其余不变）"
    );
    assert.strictEqual(room.state.turnOwner, second, "自爆结束本回合 → 轮到 P2 白天");
  });

  it("白狼王：夜里被狼刀杀死 → 天亮只是普通死亡，不带对方手牌", async () => {
    const { room, first, second, firstClient, secondClient } = await setup();
    const skill1: any[] = [];
    const skill2: any[] = [];
    firstClient.onMessage("deathSkill", (m) => skill1.push(m));
    secondClient.onMessage("deathSkill", (m) => skill2.push(m));
    setHand(room, first, [
      { id: "w1", name: "狼人", type: "wolf" },
      { id: "v9", name: "平民", type: "villager" },
    ]);
    setHand(room, second, [
      { id: "ww", name: "白狼王", type: "wolf", skill: "whiteWolfKing" },
      { id: "v1", name: "平民", type: "villager" },
      { id: "v2", name: "平民", type: "villager" },
    ]);

    firstClient.send("playCard", { id: "w1" });
    await wait();
    firstClient.send("chooseTarget", { index: 0 }); // 锁定白狼王
    await wait();

    firstClient.send("ready");
    await wait();
    secondClient.send("ready"); // 天亮结算
    await wait();

    assert.strictEqual(room.state.phase, "day");
    assert.deepStrictEqual(graveIds(room), ["ww"], "白狼王天亮进墓地");
    assert.strictEqual(pending(room).type, "", "白狼王没有死亡技，不产生任何待选目标");
    assert.strictEqual(skill1.length, 0, "P1 没收到死亡技能播报");
    assert.strictEqual(skill2.length, 0, "P2 没收到死亡技能播报");
    assert.strictEqual(
      room.state.players.get(second)!.hand.length,
      2,
      "白狼王持有方的手牌没有被额外带走"
    );
    assert.strictEqual(
      room.state.players.get(first)!.hand.length,
      2,
      "对方手牌也没变化"
    );
  });

  it("预言家：夜里查验对方手牌身份，查验后回到手牌原位且不结束回合", async () => {
    const { room, first, second, firstClient } = await setup();
    setHand(room, first, [
      { id: "v0", name: "平民", type: "villager" },
      { id: "s1", name: "预言家", type: "god", skill: "seer" },
      { id: "v9", name: "平民", type: "villager" },
    ]);
    setHand(room, second, [
      { id: "w1", name: "狼人", type: "wolf" },
      { id: "v2", name: "平民", type: "villager" },
    ]);
    let result: any = null;
    firstClient.onMessage("seerResult", (m: any) => (result = m));

    firstClient.send("playCard", { id: "s1" });
    await wait();
    assert.strictEqual(pending(room).type, "seerCheck");
    assert.strictEqual(playCount(room, first), 1, "预言家先进入行动区");

    firstClient.send("chooseTarget", { index: 0 });
    await wait();

    assert.ok(result, "应收到查验结果");
    assert.strictEqual(result.index, 0);
    assert.strictEqual(result.name, "狼人", "查验出真实身份");
    assert.strictEqual(result.type, "wolf");

    assert.deepStrictEqual(
      room.state.players.get(first)!.hand.map((c: any) => c.id),
      ["v0", "s1", "v9"],
      "预言家回到手牌原来的位置"
    );
    assert.strictEqual(playCount(room, first), 0, "行动区已清空");
    assert.strictEqual(room.state.turnOwner, first, "查验后仍停在本方回合");
    assert.strictEqual(room.state.turnActed, false, "查验不算结束回合");
    assert.strictEqual(room.state.players.get(second)!.hand.length, 2, "对方手牌不受影响");

    // ★ 查验即永久明牌（像天使）：被查的牌身份对双方公开
    const w1 = room.state.players.get(second)!.hand.find((c: any) => c.id === "w1")!;
    assert.strictEqual(w1.revealed, true, "被查验的牌进入永久明牌状态");
    const open = room.state.players.get(second)!.openCards;
    assert.strictEqual(open.length, 1, "明牌镜像只有这一张");
    assert.strictEqual(open[0].name, "狼人");
    assert.strictEqual(open[0].type, "wolf");
    assert.strictEqual(open[0].slot, 0, "明牌位置 = 手牌位置");
    // 预言家客户端也能看到对方明牌
    const oppView = Array.from(firstClient.state.players.get(second)!.openCards as any as any[]);
    assert.strictEqual(oppView.length, 1, "查验方看得到对方明牌镜像");
    assert.strictEqual(oppView[0].name, "狼人");
  });

  it("预言家查验隐狼 → 显示为平民", async () => {
    const { room, first, second, firstClient } = await setup();
    setHand(room, first, [{ id: "s1", name: "预言家", type: "god", skill: "seer" }]);
    setHand(room, second, [{ id: "hw1", name: "隐狼", type: "wolf", skill: "hiddenWolf" }]);
    let result: any = null;
    firstClient.onMessage("seerResult", (m: any) => (result = m));

    firstClient.send("playCard", { id: "s1" });
    await wait();
    firstClient.send("chooseTarget", { index: 0 });
    await wait();

    assert.ok(result, "应收到查验结果");
    assert.strictEqual(result.name, "平民", "隐狼被查验为平民");
    assert.strictEqual(result.type, "villager");

    // ★ 明牌也显示伪装身份：隐狼不穿帮
    const open = room.state.players.get(second)!.openCards;
    assert.strictEqual(open.length, 1, "被查验的牌进入永久明牌");
    assert.strictEqual(open[0].name, "平民", "明牌显示伪装身份");
    assert.strictEqual(open[0].type, "villager", "明牌类型也是伪装的");
    // 拥有者自己的手牌里这张牌仍然是隐狼
    const hw = room.state.players.get(second)!.hand.find((c: any) => c.id === "hw1")!;
    assert.strictEqual(hw.skill, "hiddenWolf", "真实身份没有被改");
  });

  it("隐狼：与普通狼人无异 —— 夜里共用同一把狼刀", async () => {
    const { room, first, second, firstClient, secondClient } = await setup();
    setHand(room, first, [
      { id: "hw1", name: "隐狼", type: "wolf", skill: "hiddenWolf" },
      { id: "w1", name: "狼人", type: "wolf" },
    ]);
    setHand(room, second, [
      { id: "v1", name: "平民", type: "villager" },
      { id: "v2", name: "平民", type: "villager" },
    ]);
    let rejected: string | null = null;
    firstClient.onMessage("playRejected", (m: any) => (rejected = m.reason));

    firstClient.send("playCard", { id: "hw1" });
    await wait();
    assert.strictEqual(pending(room).type, "wolfKnife", "隐狼可以正常出刀");
    firstClient.send("chooseTarget", { index: 0 });
    await wait();
    assert.strictEqual(room.state.wolfKnifeUsed, true, "隐狼消耗共用刀");

    // 同一夜普通狼人不能再出刀
    rejected = null;
    firstClient.send("playCard", { id: "w1" });
    await wait();
    assert.ok(rejected && /本夜狼刀已用过/.test(rejected), `应被拒绝，实际：${rejected}`);

    firstClient.send("ready");
    await wait();
    secondClient.send("ready");
    await wait();
    assert.strictEqual(room.state.phase, "day");
    assert.ok(graveIds(room).indexOf("v1") >= 0, "被隐狼刀的牌天亮死亡");
  });

  it("女巫学徒：技能与女巫一致（毒杀生效），50% 命中时把自己毒死", async () => {
    const { room, first, second, firstClient, secondClient } = await setup();
    setHand(room, first, [
      { id: "a1", name: "女巫学徒", type: "god", skill: "witchApprentice" },
      { id: "v9", name: "平民", type: "villager" },
    ]);
    setHand(room, second, [
      { id: "v1", name: "平民", type: "villager" },
      { id: "v2", name: "平民", type: "villager" },
    ]);

    const origRandom = Math.random;
    try {
      Math.random = () => 0.1; // ★ < 0.5 → 触发失手
      firstClient.send("useSkill", { cardId: "a1", mode: "poison" });
      await wait();
      assert.strictEqual(pending(room).type, "witchPoison");
      firstClient.send("chooseTarget", { index: 0 });
      await wait();
    } finally {
      Math.random = origRandom;
    }

    // 天亮统一结算：失手时【毒药作废】，只有学徒自己倒下
    firstClient.send("ready");
    await wait();
    secondClient.send("ready");
    await wait();
    assert.strictEqual(room.state.phase, "day");
    assert.ok(graveIds(room).indexOf("v1") === -1, "失手 → 毒药作废，v1 没死");
    assert.ok(
      room.state.players.get(second)!.hand.some((c: any) => c.id === "v1"),
      "v1 仍在对方手牌"
    );
    assert.ok(
      room.state.players.get(first)!.graveyard.some((c: any) => c.id === "a1"),
      "失手：女巫学徒把自己毒死，进入自己的墓地"
    );
    // ★ 这瓶药同样作废：标记为已用，之后不能再拿来毒人
    const a1After = room.state.players.get(first)!.graveyard.find((c: any) => c.id === "a1");
    assert.strictEqual(a1After!.witchPoisonUsed, true, "失手：那瓶毒药作废（已用掉）");
  });

  it("女巫学徒：解药失手 → 复活作废（墓地的牌留在墓地），学徒自己死", async () => {
    const { room, first, second, firstClient, secondClient } = await setup();
    setHand(room, first, [
      { id: "a1", name: "女巫学徒", type: "god", skill: "witchApprentice" },
      { id: "v9", name: "平民", type: "villager" },
    ]);
    setHand(room, second, [{ id: "v1", name: "平民", type: "villager" }]);
    const dead = new Card();
    dead.id = "dead1";
    dead.name = "猎人";
    dead.type = "god";
    dead.skill = "hunter";
    room.state.players.get(first)!.graveyard.push(dead);

    const origRandom = Math.random;
    try {
      Math.random = () => 0.1; // ★ < 0.5 → 触发失手
      firstClient.send("useSkill", { cardId: "a1", mode: "revive" });
      await wait();
      assert.strictEqual(pending(room).type, "witchRevive");
      firstClient.send("chooseTarget", { index: 0 });
      await wait();
    } finally {
      Math.random = origRandom;
    }

    assert.ok(
      room.state.players.get(first)!.graveyard.some((c: any) => c.id === "dead1"),
      "失手 → 解药作废，墓地的牌没有被复活"
    );
    assert.ok(
      !room.state.players.get(first)!.hand.some((c: any) => c.id === "dead1"),
      "那张牌没有回到手牌"
    );

    firstClient.send("ready");
    await wait();
    secondClient.send("ready");
    await wait();
    assert.strictEqual(room.state.phase, "day");
    assert.ok(
      room.state.players.get(first)!.graveyard.some((c: any) => c.id === "a1"),
      "学徒把自己毒死"
    );
    const a1Dead = room.state.players.get(first)!.graveyard.find((c: any) => c.id === "a1");
    assert.strictEqual(a1Dead!.witchReviveUsed, true, "失手：那瓶解药同样作废（已用掉）");
  });

  it("女巫学徒：另外 50% 平安无事（技能生效且自己不死）", async () => {
    const { room, first, second, firstClient, secondClient } = await setup();
    setHand(room, first, [
      { id: "a1", name: "女巫学徒", type: "god", skill: "witchApprentice" },
      { id: "v9", name: "平民", type: "villager" },
    ]);
    setHand(room, second, [
      { id: "v1", name: "平民", type: "villager" },
      { id: "v2", name: "平民", type: "villager" },
    ]);

    const origRandom = Math.random;
    try {
      Math.random = () => 0.9; // ★ ≥ 0.5 → 不失手
      firstClient.send("useSkill", { cardId: "a1", mode: "poison" });
      await wait();
      firstClient.send("chooseTarget", { index: 0 });
      await wait();
    } finally {
      Math.random = origRandom;
    }

    firstClient.send("ready");
    await wait();
    secondClient.send("ready");
    await wait();
    assert.strictEqual(room.state.phase, "day");
    assert.ok(graveIds(room).indexOf("v1") >= 0, "毒杀生效");
    assert.ok(
      !room.state.players.get(first)!.graveyard.some((c: any) => c.id === "a1"),
      "未失手：女巫学徒活着"
    );
    assert.ok(
      room.state.players.get(first)!.hand.some((c: any) => c.id === "a1"),
      "女巫学徒仍在手牌中"
    );
  });

  it("骑士：白天决斗狼人 → 狼死、骑士存活并回到手牌原位（回合继续）", async () => {
    const { room, first, second, firstClient, secondClient } = await setup();
    setHand(room, first, [
      { id: "v0", name: "平民", type: "villager" },
      { id: "k1", name: "骑士", type: "god", skill: "knight" },
    ]);
    setHand(room, second, [
      { id: "w1", name: "狼人", type: "wolf" },
      { id: "v2", name: "平民", type: "villager" },
      { id: "v3", name: "平民", type: "villager" },
    ]);

    firstClient.send("ready");
    await wait();
    secondClient.send("ready");
    await wait();
    assert.strictEqual(room.state.phase, "day");
    assert.strictEqual(room.state.turnOwner, first, "白天先手是 P1");

    firstClient.send("playCard", { id: "k1" });
    await wait();
    assert.strictEqual(pending(room).type, "knightDuel");
    firstClient.send("chooseTarget", { index: 0 });
    await wait();

    assert.ok(graveIds(room).indexOf("w1") >= 0, "狼人死亡");
    assert.ok(graveIds(room).indexOf("k1") === -1, "骑士存活");
    assert.deepStrictEqual(
      room.state.players.get(first)!.hand.map((c: any) => c.id),
      ["v0", "k1"],
      "骑士回到手牌原位"
    );
    assert.strictEqual(room.state.turnOwner, first, "骑士存活 → 本回合继续");
    assert.strictEqual(room.state.turnActed, false, "回合未结束（还能再决斗/行动）");
  });

  it("骑士：决斗胜利后可在【同一回合】立刻再次决斗（直到撞上非狼人为止）", async () => {
    const { room, first, second, firstClient, secondClient } = await setup();
    setHand(room, first, [
      { id: "k1", name: "骑士", type: "god", skill: "knight" },
      { id: "v9", name: "平民", type: "villager" },
    ]);
    setHand(room, second, [
      { id: "w1", name: "狼人", type: "wolf" },
      { id: "v2", name: "平民", type: "villager" },
    ]);

    firstClient.send("ready");
    await wait();
    secondClient.send("ready");
    await wait();
    assert.strictEqual(room.state.phase, "day");

    // 第一次决斗：撞上狼人 → 狼死，骑士回手牌且【没有消耗本回合行动】
    firstClient.send("playCard", { id: "k1" });
    await wait();
    firstClient.send("chooseTarget", { index: 0 });
    await wait();
    assert.ok(graveIds(room).indexOf("w1") >= 0, "狼人死亡");
    const knight = room.state.players.get(first)!.hand.find((c: any) => c.id === "k1");
    assert.ok(knight, "骑士回到手牌");
    assert.strictEqual(knight.acted, false, "胜利不消耗行动 → 本回合可再决斗");
    assert.strictEqual(room.state.turnOwner, first, "仍在本方回合");

    // 第二次决斗（同一回合）：撞上平民 → 骑士自己死
    let rejected: string | null = null;
    firstClient.onMessage("playRejected", (m: any) => (rejected = m.reason));
    firstClient.send("playCard", { id: "k1" });
    await wait();
    assert.strictEqual(
      pending(room).type,
      "knightDuel",
      `同一回合应能再次决斗，实际被拒：${rejected}`
    );
    firstClient.send("chooseTarget", { index: 0 }); // 现在 index 0 是平民 v2
    await wait();

    assert.ok(
      room.state.players.get(first)!.graveyard.some((c: any) => c.id === "k1"),
      "骑士第二次决斗失败，进入自己的墓地"
    );
    assert.ok(graveIds(room).indexOf("v2") === -1, "平民 v2 没死");
    assert.strictEqual(room.state.turnOwner, second, "骑士倒下 → 轮到 P2");
  });

  it("骑士：白天决斗非狼人 → 骑士自己死亡，目标回到对方手牌原位", async () => {
    const { room, first, second, firstClient, secondClient } = await setup();
    setHand(room, first, [
      { id: "k1", name: "骑士", type: "god", skill: "knight" },
      { id: "v9", name: "平民", type: "villager" },
    ]);
    setHand(room, second, [
      { id: "v1", name: "平民", type: "villager" },
      { id: "v2", name: "平民", type: "villager" },
    ]);

    firstClient.send("ready");
    await wait();
    secondClient.send("ready");
    await wait();
    assert.strictEqual(room.state.phase, "day");

    firstClient.send("playCard", { id: "k1" });
    await wait();
    firstClient.send("chooseTarget", { index: 0 });
    await wait();

    assert.ok(
      room.state.players.get(first)!.graveyard.some((c: any) => c.id === "k1"),
      "骑士进入自己的墓地"
    );
    assert.ok(graveIds(room).indexOf("v1") === -1, "被决斗的平民没死");
    assert.deepStrictEqual(
      room.state.players.get(second)!.hand.map((c: any) => c.id),
      ["v1", "v2"],
      "被决斗的牌回到对方手牌原位"
    );
    assert.strictEqual(room.state.turnOwner, second, "骑士倒下 → 本回合结束，轮到 P2");
  });

  it("骑士决斗隐狼 → 按狼人判定（隐狼死，骑士活）", async () => {
    const { room, first, second, firstClient, secondClient } = await setup();
    setHand(room, first, [{ id: "k1", name: "骑士", type: "god", skill: "knight" }]);
    setHand(room, second, [
      { id: "hw1", name: "隐狼", type: "wolf", skill: "hiddenWolf" },
      { id: "v2", name: "平民", type: "villager" },
    ]);

    firstClient.send("ready");
    await wait();
    secondClient.send("ready");
    await wait();
    assert.strictEqual(room.state.phase, "day");

    firstClient.send("playCard", { id: "k1" });
    await wait();
    firstClient.send("chooseTarget", { index: 0 });
    await wait();

    assert.ok(graveIds(room).indexOf("hw1") >= 0, "隐狼在决斗中按狼人判定 → 死亡");
    assert.ok(graveIds(room).indexOf("k1") === -1, "骑士存活");
  });

  it("骑士决斗处死白狼王 → 不触发任何亡语（自爆是主动技能）", async () => {
    const { room, first, second, firstClient, secondClient } = await setup();
    setHand(room, first, [
      { id: "k1", name: "骑士", type: "god", skill: "knight" },
      { id: "h9", name: "猎人", type: "god", skill: "hunter" },
    ]);
    setHand(room, second, [
      { id: "ww", name: "白狼王", type: "wolf", skill: "whiteWolfKing" },
      { id: "v2", name: "平民", type: "villager" },
    ]);

    firstClient.send("ready");
    await wait();
    secondClient.send("ready");
    await wait();
    assert.strictEqual(room.state.phase, "day");

    firstClient.send("playCard", { id: "k1" });
    await wait();
    assert.strictEqual(pending(room).type, "knightDuel");
    firstClient.send("chooseTarget", { index: 0 });
    await wait();

    assert.ok(graveIds(room).indexOf("ww") >= 0, "白狼王被决斗处死");
    assert.strictEqual(pending(room).type, "", "白狼王没有死亡触发技，不等人选目标");
    assert.ok(graveIds(room).indexOf("h9") === -1, "猎人没有被带走");
    assert.ok(graveIds(room).indexOf("v2") === -1, "普通平民也没有被带走");
  });

  it("骑士决斗处死狼王 → 触发狼王亡语，带走对方一张手牌", async () => {
    const { room, first, second, firstClient, secondClient } = await setup();
    setHand(room, first, [
      { id: "k1", name: "骑士", type: "god", skill: "knight" },
      { id: "v0", name: "平民", type: "villager" },
    ]);
    setHand(room, second, [
      { id: "wk", name: "狼王", type: "wolf", skill: "wolfKing" },
      { id: "v2", name: "平民", type: "villager" },
    ]);

    firstClient.send("ready");
    await wait();
    secondClient.send("ready");
    await wait();
    firstClient.send("playCard", { id: "k1" });
    await wait();
    firstClient.send("chooseTarget", { index: 0 });
    await wait();

    assert.ok(graveIds(room).indexOf("wk") >= 0, "狼王被决斗处死");
    assert.strictEqual(pending(room).type, "wolfKing", "狼王亡语触发");
    assert.strictEqual(pending(room).actor, second, "由狼王持有者选择");

    secondClient.send("chooseTarget", { index: 1 });
    await wait();
    assert.ok(graveIds(room).indexOf("v0") >= 0, "狼王带走骑士方一张牌");
  });

  it("丘比特：夜里连接两张牌 → 一死死俩，触发后链接消失", async () => {
    const { room, first, second, firstClient, secondClient } = await setup();
    setHand(room, first, [
      { id: "cu", name: "丘比特", type: "god", skill: "cupid" },
      { id: "a1", name: "平民", type: "villager" },
      { id: "w1", name: "狼人", type: "wolf" },
    ]);
    setHand(room, second, [
      { id: "b1", name: "平民", type: "villager" },
      { id: "b2", name: "平民", type: "villager" },
      { id: "b3", name: "平民", type: "villager" },
    ]);

    // 夜里出丘比特 → 先选自己一张，再选对方一张
    firstClient.send("playCard", { id: "cu" });
    await wait();
    assert.strictEqual(pending(room).type, "cupidLink1");
    assert.strictEqual(pending(room).zone, "anyHand", "两边手牌都能选");
    firstClient.send("chooseTarget", { index: 0, side: "self" }); // 自己的 a1（手牌剩 [a1, w1]）
    await wait();
    assert.strictEqual(pending(room).type, "cupidLink2");
    firstClient.send("chooseTarget", { index: 0, side: "opp" }); // 对方的 b1
    await wait();

    assert.strictEqual(pending(room).type, "", "连接完成");
    assert.ok(hasLink(room, "a1", "b1"), "链接己方 a1 与对方 b1");
    assert.ok(
      room.state.players.get(first)!.hand.some((c: any) => c.id === "cu"),
      "丘比特回到手牌"
    );
    assert.strictEqual(room.state.turnOwner, first, "连接不结束回合");

    // 同夜出狼刀杀掉被链接的 b1 → 天亮时 b1 与 a1 一起死
    firstClient.send("playCard", { id: "w1" });
    await wait();
    firstClient.send("chooseTarget", { index: 0 });
    await wait();
    firstClient.send("ready");
    await wait();
    secondClient.send("ready");
    await wait();
    assert.strictEqual(room.state.phase, "day");

    const graves = graveIds(room);
    assert.ok(graves.indexOf("b1") >= 0, "被刀的 b1 死亡");
    assert.ok(graves.indexOf("a1") >= 0, "链接的 a1 随之死亡（一死死俩）");
    assert.deepStrictEqual(linkIds(room), [], "链接消失");
  });

  it("丘比特：连接一次后就失去技能（整局只能用一次）", async () => {
    const { room, first, second, firstClient, secondClient } = await setup();
    setHand(room, first, [
      { id: "cu", name: "丘比特", type: "god", skill: "cupid" },
      { id: "a1", name: "平民", type: "villager" },
      { id: "a2", name: "平民", type: "villager" },
    ]);
    setHand(room, second, [
      { id: "b1", name: "平民", type: "villager" },
      { id: "b2", name: "平民", type: "villager" },
      { id: "b3", name: "平民", type: "villager" },
    ]);

    // 第 1 夜：连接 a1 与 b1
    firstClient.send("playCard", { id: "cu" });
    await wait();
    firstClient.send("chooseTarget", { index: 0, side: "self" });
    await wait();
    firstClient.send("chooseTarget", { index: 0, side: "opp" });
    await wait();
    assert.strictEqual(pending(room).type, "", "连接完成");
    const cu = room.state.players.get(first)!.hand.find((c: any) => c.id === "cu")!;
    assert.strictEqual(cu.usedOnce, true, "连接后丘比特标记为已用");

    // 走完本夜 + 白天 → 第 2 夜
    firstClient.send("ready");
    await wait();
    secondClient.send("ready");
    await wait();
    assert.strictEqual(room.state.phase, "day");
    firstClient.send("ready");
    await wait();
    secondClient.send("ready");
    await wait();
    assert.strictEqual(room.state.round, 2, "进入第 2 轮");
    assert.strictEqual(room.state.phase, "night");

    // 第 2 夜再想连 → 被拒绝，且不会进入选目标
    secondClient.send("ready"); // P2 夜跳过
    await wait();
    const cu2 = room.state.players.get(first)!.hand.find((c: any) => c.id === "cu");
    assert.ok(cu2, "丘比特还在手上");
    firstClient.send("playCard", { id: "cu" });
    await wait();
    assert.strictEqual(pending(room).type, "", "第二次连接被拒绝（技能已失去）");
    assert.ok(
      room.state.players.get(first)!.hand.some((c: any) => c.id === "cu"),
      "丘比特留在手牌"
    );
  });

  it("丘比特：可以连接己方两张手牌 → 其中一张死了，另一张跟着死", async () => {
    const { room, first, second, firstClient, secondClient } = await setup();
    setHand(room, first, [
      { id: "cu", name: "丘比特", type: "god", skill: "cupid" },
      { id: "a1", name: "平民", type: "villager" },
      { id: "a2", name: "平民", type: "villager" },
    ]);
    setHand(room, second, [
      { id: "w2", name: "狼人", type: "wolf" },
      { id: "b1", name: "平民", type: "villager" },
    ]);

    // 两张都选己方（出牌后手牌是 [a1, a2]）
    firstClient.send("playCard", { id: "cu" });
    await wait();
    firstClient.send("chooseTarget", { index: 0, side: "self" });
    await wait();
    firstClient.send("chooseTarget", { index: 1, side: "self" });
    await wait();

    assert.strictEqual(pending(room).type, "", "连接完成");
    assert.ok(hasLink(room, "a1", "a2"), "链接己方两张 a1 与 a2");

    // P2 夜：狼刀杀掉 P1 手牌里的 a1（此时 P1 手牌是 [cu, a1, a2]）
    firstClient.send("ready");
    await wait();
    secondClient.send("playCard", { id: "w2" });
    await wait();
    secondClient.send("chooseTarget", { index: 1, side: "opp" });
    await wait();
    firstClient.send("ready");
    await wait();
    secondClient.send("ready");
    await wait();
    assert.strictEqual(room.state.phase, "day");

    const graves = graveIds(room);
    assert.ok(graves.indexOf("a1") >= 0, "被刀的 a1 死亡");
    assert.ok(graves.indexOf("a2") >= 0, "链接的 a2 随之死亡（连的是自己人也一样）");
    assert.deepStrictEqual(linkIds(room), [], "链接消失");
  });

  it("丘比特：两张都选对方手牌也可以；同一张牌不能连两次", async () => {
    const { room, first, second, firstClient } = await setup();
    setHand(room, first, [
      { id: "cu", name: "丘比特", type: "god", skill: "cupid" },
      { id: "a1", name: "平民", type: "villager" },
    ]);
    setHand(room, second, [
      { id: "b1", name: "平民", type: "villager" },
      { id: "b2", name: "平民", type: "villager" },
    ]);

    firstClient.send("playCard", { id: "cu" });
    await wait();
    firstClient.send("chooseTarget", { index: 0, side: "opp" });
    await wait();
    // 重复选同一张 → 拒绝，仍停在第二段
    firstClient.send("chooseTarget", { index: 0, side: "opp" });
    await wait();
    assert.strictEqual(pending(room).type, "cupidLink2", "同一张牌不能连两次");

    firstClient.send("chooseTarget", { index: 1, side: "opp" });
    await wait();
    assert.strictEqual(pending(room).type, "", "连接完成");
    assert.ok(hasLink(room, "b1", "b2"), "两张都连对方手牌也可以");
  });

  it("丘比特：被连接的牌带「丘」标记，只有连接方看得到", async () => {
    const { room, first, second, firstClient, secondClient } = await setup();
    setHand(room, first, [
      { id: "cu", name: "丘比特", type: "god", skill: "cupid" },
      { id: "a1", name: "平民", type: "villager" },
      { id: "a2", name: "平民", type: "villager" },
    ]);
    setHand(room, second, [
      { id: "w2", name: "狼人", type: "wolf" },
      { id: "b1", name: "平民", type: "villager" },
      { id: "b2", name: "平民", type: "villager" },
    ]);

    firstClient.send("playCard", { id: "cu" });
    await wait();
    firstClient.send("chooseTarget", { index: 0, side: "self" }); // a1
    await wait();
    firstClient.send("chooseTarget", { index: 1, side: "opp" }); // b1
    await wait(400); // 等定时同步把槽位刷对（丘比特回手后 a1 在 1 号位）

    // 服务端：双方的 linkedSlots 都记了被连接牌的槽位
    assert.deepStrictEqual(
      Array.from(room.state.players.get(first)!.linkedSlots as any),
      [1],
      "P1 手牌里 a1 的槽位"
    );
    assert.deepStrictEqual(
      Array.from(room.state.players.get(second)!.linkedSlots as any),
      [1],
      "P2 手牌里 b1 的槽位"
    );

    // 连接方（P1）客户端：自己 + 对方的标记都收得到
    const myView = firstClient.state.players.get(first)!;
    const oppView = firstClient.state.players.get(second)!;
    assert.deepStrictEqual(
      Array.from((myView as any).linkedSlots || []),
      [1],
      "连接方看得到自己手牌的「丘」"
    );
    assert.deepStrictEqual(
      Array.from((oppView as any).linkedSlots || []),
      [1],
      "连接方看得到对方手牌的「丘」"
    );

    // 被连接方（P2）客户端：linkedSlots 视图未授权 → 什么都收不到
    const p2SelfView = secondClient.state.players.get(second)!;
    const p2OppView = secondClient.state.players.get(first)!;
    assert.strictEqual(
      ((p2SelfView as any).linkedSlots || []).length,
      0,
      "被连接方看不到自己手牌的「丘」"
    );
    assert.strictEqual(
      ((p2OppView as any).linkedSlots || []).length,
      0,
      "被连接方看不到对方手牌的「丘」"
    );

    // 公开 state 里也没有链接信息（对手无法从 state 读出哪张牌被连接）
    assert.strictEqual((room.state as any).linkedA, undefined, "链接不再进公开 state");

    // P2 的夜：狼刀杀掉被连接的 a1 → 一死死俩 → 标记随之消失
    firstClient.send("ready");
    await wait();
    secondClient.send("playCard", { id: "w2" });
    await wait();
    secondClient.send("chooseTarget", { index: 1 }); // P1 手牌 [cu, a1, a2] 里的 a1
    await wait();
    firstClient.send("ready");
    await wait();
    secondClient.send("ready");
    await wait();

    const graves = graveIds(room);
    assert.ok(graves.indexOf("a1") >= 0, "被刀的 a1 死亡");
    assert.ok(graves.indexOf("b1") >= 0, "链接的 b1 随之死亡");
    assert.deepStrictEqual(linkIds(room), [], "链接消失");
    await wait(400);
    assert.deepStrictEqual(
      Array.from(room.state.players.get(first)!.linkedSlots as any),
      [],
      "P1 的「丘」标记清空"
    );
    assert.deepStrictEqual(
      Array.from(room.state.players.get(second)!.linkedSlots as any),
      [],
      "P2 的「丘」标记清空"
    );
  });

  it("被强化的丘比特：本夜可连两对，各对各的连锁", async () => {
    const { room, first, second, firstClient, secondClient } = await setup();
    setHand(room, first, [
      { id: "cu", name: "丘比特", type: "god", skill: "cupid" },
      { id: "w1", name: "狼人", type: "wolf" },
      { id: "a1", name: "平民", type: "villager" },
      { id: "a2", name: "平民", type: "villager" },
    ]);
    setHand(room, second, [
      { id: "b1", name: "平民", type: "villager" },
      { id: "b2", name: "平民", type: "villager" },
      { id: "b3", name: "平民", type: "villager" },
    ]);
    // 直接给丘比特挂上强化（模拟奇迹商人）
    const cu = room.state.players.get(first)!.hand.find((c: any) => c.id === "cu")!;
    cu.blessCharges = 1;

    // 第一对：a1 ↔ b1（强化的那次，不消耗整局一次）
    firstClient.send("playCard", { id: "cu" });
    await wait();
    firstClient.send("chooseTarget", { index: 1, side: "self" }); // a1（手牌 [w1,a1,a2]）
    await wait();
    firstClient.send("chooseTarget", { index: 0, side: "opp" }); // b1
    await wait();
    assert.ok(hasLink(room, "a1", "b1"), "第一对建立");
    assert.strictEqual(cu.usedOnce, false, "强化连接不消耗整局一次");

    // 第二对：a2 ↔ b2（本夜还能再连）
    firstClient.send("playCard", { id: "cu" });
    await wait();
    firstClient.send("chooseTarget", { index: 2, side: "self" }); // a2（手牌 [w1,a1,a2]）
    await wait();
    firstClient.send("chooseTarget", { index: 1, side: "opp" }); // b2
    await wait();
    assert.ok(hasLink(room, "a2", "b2"), "第二对建立");
    assert.strictEqual(cu.usedOnce, true, "第二次连接消耗整局一次");
    assert.deepStrictEqual(linkIds(room), ["a1", "a2", "b1", "b2"], "两对链接并存");

    // 第三次连接被拒（整局一次已用完；本回合也已行动过）
    const rejected: any[] = [];
    firstClient.onMessage("playRejected", (m: any) => rejected.push(m));
    firstClient.send("playCard", { id: "cu" });
    await wait();
    assert.ok(rejected.length > 0, `第三次连接被拒，实际：${JSON.stringify(rejected)}`);

    // 狼刀杀 b1 → 只触发第一对（a1 跟死），第二对 a2/b2 完好
    firstClient.send("playCard", { id: "w1" });
    await wait();
    firstClient.send("chooseTarget", { index: 0 }); // b1
    await wait();
    firstClient.send("ready");
    await wait();
    secondClient.send("ready");
    await wait();

    const graves = graveIds(room);
    assert.ok(graves.indexOf("b1") >= 0, "被刀的 b1 死亡");
    assert.ok(graves.indexOf("a1") >= 0, "第一对的 a1 随之死亡");
    assert.ok(graves.indexOf("a2") < 0, "第二对的 a2 不受影响");
    assert.ok(graves.indexOf("b2") < 0, "第二对的 b2 不受影响");
    assert.deepStrictEqual(linkIds(room), ["a2", "b2"], "只剩第二对链接");
  });

  it("奇迹商人强化丘比特（已连过）：技能重置，可再连一对且旧链接依旧生效", async () => {
    const { room, first, second, firstClient, secondClient } = await setup();
    setHand(room, first, [
      { id: "cu", name: "丘比特", type: "god", skill: "cupid" },
      { id: "me1", name: "奇迹商人", type: "villager", skill: "miracleMerchant" },
      { id: "a1", name: "平民", type: "villager" },
      { id: "a2", name: "平民", type: "villager" },
      { id: "a3", name: "平民", type: "villager" },
      { id: "w1", name: "狼人", type: "wolf" },
    ]);
    setHand(room, second, [
      { id: "b1", name: "平民", type: "villager" },
      { id: "b2", name: "平民", type: "villager" },
      { id: "b3", name: "平民", type: "villager" },
    ]);

    // —— 第一步：丘比特先连一对 a1↔b1（整局一次已用）——
    firstClient.send("playCard", { id: "cu" });
    await wait();
    assert.strictEqual(pending(room).type, "cupidLink1");
    firstClient.send("chooseTarget", { index: handIdx(room, first, "a1"), side: "self" });
    await wait();
    assert.strictEqual(pending(room).type, "cupidLink2");
    firstClient.send("chooseTarget", { index: 0, side: "opp" }); // b1
    await wait();
    assert.ok(hasLink(room, "a1", "b1"), "第一对建立");
    const cu0 = room.state.players.get(first)!.hand.find((c: any) => c.id === "cu")!;
    assert.strictEqual(cu0.usedOnce, true, "连接后整局一次已用");
    assert.strictEqual(cu0.blessCharges, 0, "尚未被强化");

    // —— 第二步：出奇迹商人，强化「已经连过」的丘比特 → 技能重置 ——
    firstClient.send("playCard", { id: "me1" });
    await wait();
    assert.strictEqual(pending(room).type, "merchantBless");
    firstClient.send("chooseTarget", { index: handIdx(room, first, "cu") });
    await wait();
    const cu = room.state.players.get(first)!.hand.find((c: any) => c.id === "cu")!;
    assert.strictEqual(cu.blessCharges, 1, "丘比特得到一次重置连接");
    assert.strictEqual(cu.usedOnce, true, "重置不改变 usedOnce，只是再给一次机会");
    assert.ok(hasLink(room, "a1", "b1"), "强化前已有的链接不受影响");

    // —— 第三步：被重置的丘比特再连一对 a2↔b2，旧链接依旧生效 ——
    firstClient.send("playCard", { id: "cu" });
    await wait();
    assert.strictEqual(pending(room).type, "cupidLink1", "重置后可再次连接");
    firstClient.send("chooseTarget", { index: handIdx(room, first, "a2"), side: "self" });
    await wait();
    assert.strictEqual(pending(room).type, "cupidLink2");
    firstClient.send("chooseTarget", { index: 1, side: "opp" }); // b2
    await wait();
    assert.ok(hasLink(room, "a2", "b2"), "第二对（重置后）建立");
    assert.ok(hasLink(room, "a1", "b1"), "旧链接依旧生效");
    assert.deepStrictEqual(linkIds(room), ["a1", "a2", "b1", "b2"], "两对并存");
    const cu2 = room.state.players.get(first)!.hand.find((c: any) => c.id === "cu")!;
    assert.strictEqual(cu2.usedOnce, true, "重置连接后再次锁定");
    assert.strictEqual(cu2.blessCharges, 0, "重置层数已消耗");

    // —— 第四步：第三次连接被拒 ——
    const rejected: any[] = [];
    firstClient.onMessage("playRejected", (m: any) => rejected.push(m));
    firstClient.send("playCard", { id: "cu" });
    await wait();
    assert.ok(rejected.length > 0, `第三次连接被拒，实际：${JSON.stringify(rejected)}`);

    // —— 第五步：狼刀杀 b1 → 只触发旧链接的 a1，第二对 a2/b2 完好 ——
    firstClient.send("playCard", { id: "w1" });
    await wait();
    firstClient.send("chooseTarget", { index: 0 }); // b1
    await wait();
    firstClient.send("ready");
    await wait();
    secondClient.send("ready");
    await wait();
    const graves = graveIds(room);
    assert.ok(graves.indexOf("b1") >= 0, "被刀的 b1 死亡");
    assert.ok(graves.indexOf("a1") >= 0, "旧链接的 a1 随之死亡");
    assert.ok(graves.indexOf("a2") < 0, "第二对的 a2 不受影响");
    assert.ok(graves.indexOf("b2") < 0, "第二对的 b2 不受影响");
    assert.deepStrictEqual(linkIds(room), ["a2", "b2"], "只剩第二对链接");
  });

  it("连续两个整轮无人杀对方手牌 → 第三个整轮开始双方各摸一张（且不会连续发牌）", async () => {
    const { room, first, second, firstClient, secondClient } = await setup();
    const deck0 = room.state.deck.length;
    const h1_0 = room.state.players.get(first)!.hand.length;
    const h2_0 = room.state.players.get(second)!.hand.length;

    // 一个整轮 = P1夜→P2夜→P1昼→P2昼，全程只"结束行动"，不杀任何人
    const passRound = async () => {
      firstClient.send("ready"); await wait();
      secondClient.send("ready"); await wait();
      firstClient.send("ready"); await wait();
      secondClient.send("ready"); await wait();
    };

    await passRound(); // 第 1 整轮（平静）
    assert.strictEqual(room.state.round, 2, "第 1 整轮后进入第 2 轮");
    await passRound(); // 第 2 整轮（平静）→ 进入第 3 轮时发牌

    assert.strictEqual(room.state.round, 3, "第二个整轮结束 → 第三个整轮开始");
    assert.strictEqual(
      room.state.players.get(first)!.hand.length,
      h1_0 + 1,
      "P1 多摸一张"
    );
    assert.strictEqual(
      room.state.players.get(second)!.hand.length,
      h2_0 + 1,
      "P2 多摸一张"
    );
    assert.strictEqual(room.state.deck.length, deck0 - 2, "牌库减少 2 张");

    // 发牌后连续计数已清零：再平静一个整轮，第 4 轮开始不应再发牌
    await passRound(); // 第 3 整轮（平静）→ 第 4 轮开始
    assert.strictEqual(room.state.round, 4, "进入第 4 轮");
    assert.strictEqual(
      room.state.players.get(first)!.hand.length,
      h1_0 + 1,
      "第 4 轮开始不再额外发牌（连续计数已重置）"
    );
    assert.strictEqual(room.state.deck.length, deck0 - 2, "牌库仍只少了 2 张");
  });

  it("手牌上限 8：drawCard 摸到 8 张后封顶，且上限时不再消耗牌库", async () => {
    const { room, first, firstClient } = await setup();
    const results: any[] = [];
    firstClient.onMessage("drawCardResult", (m) => results.push(m));

    const p1 = room.state.players.get(first)!;
    const h0 = p1.hand.length; // 开局 6 张
    const deck0 = room.state.deck.length;

    // 一次请求 10 张：只能摸到 8 - 6 = 2 张
    firstClient.send("drawCard", { count: 10 });
    await wait();
    assert.strictEqual(p1.hand.length, 8, "手牌封顶 8 张");
    assert.strictEqual(room.state.deck.length, deck0 - 2, "牌库只减少实际摸到的 2 张");
    assert.strictEqual(results.length, 1, "收到一次 drawCardResult");
    assert.strictEqual(results[0].before, h0);
    assert.strictEqual(results[0].after, 8);
    assert.strictEqual(results[0].gained, 2, "实得 2 张");
    assert.strictEqual(results[0].limit, 8);

    // 满手牌再摸：gained = 0，手牌不变，牌库不被消耗
    const deck1 = room.state.deck.length;
    firstClient.send("drawCard", { count: 5 });
    await wait();
    assert.strictEqual(p1.hand.length, 8, "满手牌后不再增加");
    assert.strictEqual(room.state.deck.length, deck1, "满手牌时牌库不消耗");
    assert.strictEqual(results[1].gained, 0, "实得 0 张");
  });

  it("手牌上限 8：恰好 7 张时仍可摸到第 8 张（未达上限不误拦）", async () => {
    const { room, first, firstClient } = await setup();
    setHand(room, first, [
      { id: "h1", name: "平民", type: "villager" },
      { id: "h2", name: "平民", type: "villager" },
      { id: "h3", name: "平民", type: "villager" },
      { id: "h4", name: "平民", type: "villager" },
      { id: "h5", name: "平民", type: "villager" },
      { id: "h6", name: "平民", type: "villager" },
      { id: "h7", name: "平民", type: "villager" },
    ]);
    const p1 = room.state.players.get(first)!;
    const deck0 = room.state.deck.length;

    firstClient.send("drawCard", { count: 3 });
    await wait();
    assert.strictEqual(p1.hand.length, 8, "7 → 8，摸到 1 张后封顶");
    assert.strictEqual(room.state.deck.length, deck0 - 1, "牌库只消耗 1 张");
  });

  it("若一个整轮里有人杀了对方手牌，则平静计数清零、不会发牌", async () => {
    const { room, first, second, firstClient, secondClient } = await setup();
    setHand(room, first, [
      { id: "w1", name: "狼人", type: "wolf" },
      { id: "v1", name: "平民", type: "villager" },
      { id: "v2", name: "平民", type: "villager" },
      { id: "v3", name: "平民", type: "villager" },
      { id: "v4", name: "平民", type: "villager" },
      { id: "v5", name: "平民", type: "villager" },
    ]);
    setHand(room, second, [
      { id: "b1", name: "平民", type: "villager" },
      { id: "b2", name: "平民", type: "villager" },
      { id: "b3", name: "平民", type: "villager" },
      { id: "b4", name: "平民", type: "villager" },
      { id: "b5", name: "平民", type: "villager" },
      { id: "w2", name: "狼人", type: "wolf" },
    ]);
    const deck0 = room.state.deck.length;

    // 第 1 整轮：平静（双方只结束行动）→ 平静计数 = 1
    firstClient.send("ready"); await wait();
    secondClient.send("ready"); await wait();
    firstClient.send("ready"); await wait();
    secondClient.send("ready"); await wait();
    assert.strictEqual(room.state.round, 2, "第 1 整轮后进入第 2 轮");

    // 第 2 整轮：P1（黑夜）出狼刀杀 P2 的 b1 → 这一整轮不再平静，计数清零
    firstClient.send("playCard", { id: "w1" }); await wait();
    firstClient.send("chooseTarget", { index: handIdx(room, second, "b1") }); await wait();
    firstClient.send("ready"); await wait(); // 结束 P1 黑夜
    secondClient.send("ready"); await wait(); // 结束 P2 黑夜（天亮结算 b1 死亡）
    firstClient.send("ready"); await wait(); // P1 白天
    secondClient.send("ready"); await wait(); // P2 白天 → 进入第 3 轮

    assert.strictEqual(room.state.round, 3, "第 2 整轮（含击杀）结束 → 第 3 轮开始");
    assert.strictEqual(room.state.deck.length, deck0, "有击杀→不发牌，牌库不变");
    assert.strictEqual(
      room.state.players.get(second)!.hand.length,
      5,
      "P2 仅因被刀少一张，未额外发牌"
    );
  });

  it("天使：死亡即重生并摸一张手牌，重生后变白板平民（之后不再重生）", async () => {
    const { room, first, second, firstClient, secondClient } = await setup();
    setHand(room, first, [
      { id: "w1", name: "狼人", type: "wolf" },
      { id: "v9", name: "平民", type: "villager" },
    ]);
    setHand(room, second, [
      { id: "an", name: "天使", type: "villager", skill: "angel" },
      { id: "v2", name: "平民", type: "villager" },
    ]);

    // 第 1 夜：狼刀杀天使（对方手牌 index 0）
    firstClient.send("playCard", { id: "w1" });
    await wait();
    firstClient.send("chooseTarget", { index: 0 });
    await wait();
    const deckBefore = room.state.deck.length;
    firstClient.send("ready");
    await wait();
    secondClient.send("ready");
    await wait();
    assert.strictEqual(room.state.phase, "day");

    assert.ok(graveIds(room).indexOf("an") === -1, "天使没有进墓地");
    const hand2 = room.state.players.get(second)!.hand.map((c: any) => c.id);
    assert.ok(hand2.indexOf("an") >= 0, "天使仍在手牌（重生）");
    assert.strictEqual(hand2.length, 3, "重生并摸了一张（2 + 1）");
    assert.strictEqual(room.state.deck.length, deckBefore - 1, "从牌库摸了一张");
    const angel = room.state.players.get(second)!.hand.find((c: any) => c.id === "an");
    assert.strictEqual(angel.skill, "", "重生后变白板平民");
    assert.strictEqual(angel.revealed, true, "重生后永久明牌");

    // ★ 明牌镜像（公开字段）：对手能看到那张牌的身份与所在位置
    const open = room.state.players.get(second)!.openCards;
    assert.strictEqual(open.length, 1, "只有这一张明牌");
    assert.strictEqual(open[0].id, "an", "明牌是天使");
    assert.strictEqual(open[0].name, "天使");
    assert.strictEqual(open[0].slot, hand2.indexOf("an"), "明牌记录了它在手牌里的位置");
    const oppViewOpen = Array.from(firstClient.state.players.get(second)!.openCards as any[]);
    assert.strictEqual(oppViewOpen.length, 1, "对手客户端也能看到这张明牌");
    assert.strictEqual(oppViewOpen[0].name, "天使", "对手看到的是「天使」");

    // ★ 重生的天使先在行动区亮明身份（副本），所以对手此刻看得到它的身份
    assert.strictEqual(
      room.state.players.get(second)!.revealedName, "天使",
      "重生前先到行动区展示身份"
    );

    // 走完白天 → 第 2 夜：再杀一次天使 → 这次真死
    firstClient.send("ready");
    await wait();
    secondClient.send("ready");
    await wait();
    assert.strictEqual(room.state.round, 2, "进入第 2 轮");
    assert.strictEqual(room.state.phase, "night", "第 2 夜");

    const anIdx = room.state.players.get(second)!.hand.findIndex((c: any) => c.id === "an");
    firstClient.send("playCard", { id: "w1" });
    await wait();
    firstClient.send("chooseTarget", { index: anIdx });
    await wait();
    firstClient.send("ready");
    await wait();
    secondClient.send("ready");
    await wait();
    assert.ok(graveIds(room).indexOf("an") >= 0, "白板平民不再重生，正常死亡");
  });

  it("天使重生：牌没进墓地也算【本夜死过牌】→ 白天照样满足流放前提", async () => {
    const { room, first, second, firstClient, secondClient } = await setup();
    setHand(room, first, [
      { id: "w1", name: "狼人", type: "wolf" },
      { id: "v9", name: "平民", type: "villager" },
    ]);
    setHand(room, second, [
      { id: "an", name: "天使", type: "villager", skill: "angel" },
      { id: "v2", name: "平民", type: "villager" },
      { id: "v3", name: "平民", type: "villager" },
    ]);

    // 第 1 夜：狼刀打 P2 的天使（index 0）→ 天亮她重生
    firstClient.send("playCard", { id: "w1" });
    await wait();
    firstClient.send("chooseTarget", { index: 0 });
    await wait();
    firstClient.send("ready");
    await wait();
    secondClient.send("ready");
    await wait();

    assert.strictEqual(room.state.phase, "day");
    assert.strictEqual(graveCount(room), 0, "★ 本夜没有任何一张牌进墓地");
    assert.ok(
      room.state.players.get(second)!.hand.some((c: any) => c.id === "an"),
      "天使重生回到手牌"
    );
    assert.strictEqual(
      room.state.players.get(second)!.lostThisNight,
      true,
      "★ 天使死过一次，就构成本夜死过牌"
    );

    // P1 白天跳过 → P2 白天：流放资格应当成立
    firstClient.send("ready");
    await wait();
    assert.strictEqual(room.state.turnOwner, second, "轮到 P2 白天");
    secondClient.send("exile");
    await wait();
    assert.strictEqual(pending(room).type, "exile", "★ 满足前提，可以发起流放");
  });

  it("天使：重生后永久明牌，手牌顺序变化时对手看到的位置跟着更新", async () => {
    const { room, first, second, firstClient, secondClient } = await setup();
    setHand(room, first, [{ id: "w1", name: "狼人", type: "wolf" }]);
    setHand(room, second, [
      { id: "v0", name: "平民", type: "villager" },
      { id: "an", name: "天使", type: "villager", skill: "angel" },
    ]);

    // 第 1 夜刀掉天使 → 重生并摸一张（手牌变成 [v0, an, 摸到的牌]）
    firstClient.send("playCard", { id: "w1" });
    await wait();
    firstClient.send("chooseTarget", { index: 1 });
    await wait();
    firstClient.send("ready");
    await wait();
    secondClient.send("ready");
    await wait();

    const p2 = room.state.players.get(second)!;
    const slot1 = p2.hand.findIndex((c: any) => c.id === "an");
    assert.strictEqual(p2.openCards[0].slot, slot1, "明牌位置与手牌实际位置一致");

    // 走完白天 → 第 2 夜再刀掉 v0 → 天使在手牌里前移一位
    firstClient.send("ready");
    await wait();
    secondClient.send("ready");
    await wait();
    assert.strictEqual(room.state.round, 2, "进入第 2 轮");

    const v0Idx = p2.hand.findIndex((c: any) => c.id === "v0");
    firstClient.send("playCard", { id: "w1" });
    await wait();
    firstClient.send("chooseTarget", { index: v0Idx });
    await wait();
    firstClient.send("ready");
    await wait();
    secondClient.send("ready");
    await wait();

    const slot2 = p2.hand.findIndex((c: any) => c.id === "an");
    assert.notStrictEqual(slot2, slot1, "天使在手牌里的位置变了");
    assert.strictEqual(p2.openCards.length, 1, "仍然只有天使一张明牌");
    assert.strictEqual(p2.openCards[0].slot, slot2, "对手看到的明牌位置已更新");
  });

  it("通灵师：自己进墓地，换回墓地一张牌且技能重置", async () => {
    const { room, first, firstClient } = await setup();
    setHand(room, first, [
      { id: "ne", name: "通灵师", type: "god", skill: "necromancer" },
      { id: "v1", name: "平民", type: "villager" },
      { id: "v2", name: "平民", type: "villager" },
    ]);
    // 直接造一张"两瓶药都用光"的女巫放进自己的墓地
    const deadWitch = new Card();
    deadWitch.id = "wc";
    deadWitch.name = "女巫";
    deadWitch.type = "god";
    deadWitch.skill = "witch";
    deadWitch.witchReviveUsed = true;
    deadWitch.witchPoisonUsed = true;
    deadWitch.acted = true;
    room.state.players.get(first)!.graveyard.push(deadWitch);

    firstClient.send("playCard", { id: "ne" });
    await wait();
    assert.strictEqual(pending(room).type, "necromancer");
    assert.strictEqual(pending(room).zone, "graveyard");
    firstClient.send("chooseTarget", { index: 0 });
    await wait();

    const hand = room.state.players.get(first)!.hand;
    const witch = hand.find((c: any) => c.id === "wc");
    assert.ok(witch, "墓地的女巫回到手牌");
    assert.strictEqual(witch.witchReviveUsed, false, "解药重置");
    assert.strictEqual(witch.witchPoisonUsed, false, "毒药重置");
    assert.strictEqual(witch.acted, false, "行动标记重置");
    assert.ok(
      room.state.players.get(first)!.graveyard.some((c: any) => c.id === "ne"),
      "通灵师进入自己的墓地"
    );
    assert.strictEqual(room.state.turnOwner, first, "通灵不结束回合");
    assert.strictEqual(room.state.turnActed, false, "还能继续行动");
  });

  it("通灵师：主动换牌进墓地【算死亡】→ 构成流放资格", async () => {
    const { room, first, second, firstClient, secondClient } = await setup();
    setHand(room, first, [
      { id: "ne", name: "通灵师", type: "god", skill: "necromancer" },
      { id: "v1", name: "平民", type: "villager" },
      { id: "v2", name: "平民", type: "villager" },
      { id: "v3", name: "平民", type: "villager" },
    ]);
    setHand(room, second, [{ id: "w1", name: "狼人", type: "wolf" }]);
    // 墓地塞一张牌供交换
    const dead = new Card();
    dead.id = "d1"; dead.name = "死者"; dead.type = "villager"; dead.skill = "";
    room.state.players.get(first)!.graveyard.push(dead);

    firstClient.send("playCard", { id: "ne" });
    await wait();
    firstClient.send("chooseTarget", { index: 0 });
    await wait();
    const p1 = room.state.players.get(first)!;
    assert.ok(p1.hand.some((c: any) => c.id === "d1"), "墓地牌回到手牌");
    assert.ok(p1.graveyard.some((c: any) => c.id === "ne"), "通灵师在墓地");

    // 推进到天亮：即使己方没有任何牌被杀，通灵师进墓地也构成"本夜死过牌"
    firstClient.send("ready");
    await wait();
    secondClient.send("ready");
    await wait();
    assert.strictEqual(room.state.phase, "day");
    assert.strictEqual(p1.lostThisNight, true, "通灵师进墓地算死亡 → 流放资格成立");

    // 白天 P1 可发起流放（手牌 4 张全是平民，票权 4 ≥ 3）
    const rejected: any[] = [];
    firstClient.onMessage("playRejected", (m: any) => rejected.push(m));
    firstClient.send("exile");
    await wait();
    assert.deepStrictEqual(rejected, [], "流放未被拒绝");
    assert.strictEqual(pending(room).type, "exile", "进入流放选目标");
  });

  it("白天打出的牌【公开身份】：对方看得到；夜里打出的仍然私密", async () => {
    const { room, first, second, firstClient, secondClient } = await setup();
    setHand(room, first, [
      { id: "wolf1", name: "狼人", type: "wolf" },
      { id: "k1", name: "骑士", type: "god", skill: "knight" },
      { id: "v9", name: "平民", type: "villager" },
    ]);
    setHand(room, second, [
      { id: "w1", name: "狼人", type: "wolf" },
      { id: "v2", name: "平民", type: "villager" },
      { id: "v3", name: "平民", type: "villager" },
    ]);

    // 【夜里】打出狼人：对方只看到数量变化，看不到身份
    firstClient.send("playCard", { id: "wolf1" });
    await wait();
    assert.strictEqual(
      secondClient.state.players.get(first)!.revealedName,
      "",
      "夜里打出的牌不公开"
    );
    firstClient.send("chooseTarget", { index: 1 }); // 刀掉 v2
    await wait();

    firstClient.send("ready");
    await wait();
    secondClient.send("ready");
    await wait();
    assert.strictEqual(room.state.phase, "day");

    // 【白天】打出骑士：对方能看到这张牌的身份
    firstClient.send("playCard", { id: "k1" });
    await wait();
    const seenByOpp = secondClient.state.players.get(first)!;
    assert.strictEqual(seenByOpp.revealedName, "骑士", "对方能看到白天打出的牌");
    assert.strictEqual(seenByOpp.revealedType, "god");

    // 结算完毕（骑士存活回手牌）→ 公开信息清空
    firstClient.send("chooseTarget", { index: 0 }); // 决斗 w1（狼）→ 骑士活
    await wait();
    assert.ok(graveIds(room).indexOf("w1") >= 0, "狼被决斗带走");
    assert.strictEqual(
      secondClient.state.players.get(first)!.revealedName,
      "",
      "结算完毕后不再公开"
    );
  });

  it("白痴：白天被流放时翻牌免疫放逐，之后永久免疫（其它死法照常）", async () => {
    const { room, first, second, firstClient, secondClient } = await setup();
    setHand(room, first, [
      { id: "v1", name: "平民", type: "villager" },
      { id: "v2", name: "平民", type: "villager" },
      { id: "v3", name: "平民", type: "villager" },
      { id: "v4", name: "平民", type: "villager" },
      { id: "d1", name: "平民", type: "villager" },
    ]);
    setHand(room, second, [
      { id: "f1", name: "白痴", type: "villager", skill: "fool" },
      { id: "w1", name: "狼人", type: "wolf" },
      { id: "w2", name: "狼人", type: "wolf" },
    ]);
    const reveals: any[] = [];
    firstClient.onMessage("foolRevealed", (m: any) => reveals.push(m));

    // 第 1 夜：P1 跳过 → P2 出狼刀杀掉 P1 的 d1 → 天亮 P1「本夜死过牌」= 可流放
    firstClient.send("ready");
    await wait();
    secondClient.send("playCard", { id: "w1" });
    await wait();
    secondClient.send("chooseTarget", { index: 4 });
    await wait();
    secondClient.send("ready");
    await wait();
    assert.strictEqual(room.state.phase, "day");
    assert.strictEqual(room.state.turnOwner, first);

    // 第一次流放白痴
    firstClient.send("exile");
    await wait();
    assert.strictEqual(pending(room).type, "exile", "P1 满足流放条件（本夜死过牌 + 4 票）");
    firstClient.send("chooseTarget", { index: 0 });
    await wait();

    assert.ok(graveIds(room).indexOf("f1") === -1, "白痴没有被流放进墓地");
    assert.ok(
      room.state.players.get(second)!.hand.some((c: any) => c.id === "f1"),
      "白痴留在对方手牌"
    );
    const fool = room.state.players.get(second)!.hand.find((c: any) => c.id === "f1");
    assert.strictEqual(fool.foolRevealed, true, "白痴已翻牌");
    assert.strictEqual(reveals.length, 1, "广播了一次翻牌");
    assert.strictEqual(reveals[0].firstTime, true);
    assert.strictEqual(room.state.turnOwner, second, "流放（被免疫）仍消耗本回合");

    // 走到第 2 轮白天：P2 再杀 P1 一张，让 P1 重新获得流放资格
    secondClient.send("ready"); // P2 白天结束 → 入夜
    await wait();
    firstClient.send("ready"); // P1 夜
    await wait();
    secondClient.send("playCard", { id: "w2" });
    await wait();
    secondClient.send("chooseTarget", { index: 0 });
    await wait();
    secondClient.send("ready");
    await wait();
    assert.strictEqual(room.state.round, 2, "进入第 2 轮");
    assert.strictEqual(room.state.turnOwner, first, "又轮到 P1 白天");

    firstClient.send("exile");
    await wait();
    assert.strictEqual(pending(room).type, "exile", "P1 再次满足流放条件（3 票）");
    firstClient.send("chooseTarget", { index: 0 });
    await wait();

    assert.ok(graveIds(room).indexOf("f1") === -1, "翻牌后永久免疫放逐");
    assert.ok(
      room.state.players.get(second)!.hand.some((c: any) => c.id === "f1"),
      "白痴仍在对方手牌"
    );
    assert.strictEqual(reveals.length, 2, "第二次流放也触发免疫");
    assert.strictEqual(reveals[1].firstTime, false, "第二次是已翻牌状态");
  });

  it("守卫：守完仍是神职，下一夜还能再守（不是守一次就变白板平民）", async () => {
    const { room, first, second, firstClient, secondClient } = await setup();
    setHand(room, first, [
      { id: "gu", name: "守卫", type: "god", skill: "guard" },
      { id: "v1", name: "平民", type: "villager" },
      { id: "v2", name: "平民", type: "villager" },
    ]);
    setHand(room, second, [
      { id: "a1", name: "平民", type: "villager" },
      { id: "a2", name: "平民", type: "villager" },
    ]);

    // 第 1 夜：守卫守 v1
    firstClient.send("playCard", { id: "gu" });
    await wait();
    firstClient.send("chooseTarget", { index: 0 });
    await wait();

    const g1 = room.state.players.get(first)!.hand.find((c: any) => c.id === "gu");
    assert.ok(g1, "守卫回到手牌");
    assert.strictEqual(g1!.type, "god", "★ 守完之后仍然是神职，不会变成平民");
    assert.strictEqual(g1!.skill, "guard", "★ 守卫技能还在");
    assert.strictEqual(g1!.name, "守卫", "卡面名称仍是守卫");

    // 走完这一夜 → 白天 → 下一夜
    firstClient.send("ready");
    await wait();
    secondClient.send("ready");
    await wait();
    assert.strictEqual(room.state.phase, "day");
    // 白天两回合各自跳过
    firstClient.send("ready");
    await wait();
    secondClient.send("ready");
    await wait();
    assert.strictEqual(room.state.phase, "night", "进入第 2 夜");

    // 第 2 夜：守卫应该还能再守（换一张，避免"连续两晚守同一张"）
    const who = room.state.turnOwner;
    const whoClient = who === first ? firstClient : secondClient;
    if (who !== first) {
      firstClient.send("ready");
      await wait();
    }
    whoClient.send("playCard", { id: "gu" });
    await wait();
    assert.strictEqual(pending(room).type, "guardPick", "★ 第 2 夜守卫仍能发动");
  });

  it("守卫：守护己方一张手牌 → 本夜的狼刀被挡下", async () => {
    const { room, first, second, firstClient, secondClient } = await setup();
    setHand(room, first, [
      { id: "w1", name: "狼人", type: "wolf" },
      { id: "v1", name: "平民", type: "villager" },
    ]);
    setHand(room, second, [
      { id: "gu", name: "守卫", type: "god", skill: "guard" },
      { id: "v2", name: "平民", type: "villager" },
    ]);

    // 第 1 夜 P1：狼刀标记 P2 的 v2（index 1）
    firstClient.send("playCard", { id: "w1" });
    await wait();
    firstClient.send("chooseTarget", { index: 1 });
    await wait();
    firstClient.send("ready");
    await wait();

    // 第 1 夜 P2：守卫守护 v2（出牌后手牌是 [v2]，选 index 0）
    secondClient.send("playCard", { id: "gu" });
    await wait();
    secondClient.send("chooseTarget", { index: 0 });
    await wait();
    secondClient.send("ready");
    await wait();

    assert.strictEqual(room.state.phase, "day");
    assert.ok(
      graveIds(room).indexOf("v2") === -1,
      "被守护的 v2 没有死（守卫挡下狼刀）"
    );
    assert.ok(
      room.state.players.get(second)!.hand.some((c: any) => c.id === "v2"),
      "v2 仍在手牌里"
    );
  });

  it("守卫：先守护、后中刀（守护发生在狼刀之前）→ 狼刀被挡下", async () => {
    const { room, first, second, firstClient, secondClient } = await setup();
    setHand(room, first, [
      { id: "gu", name: "守卫", type: "god", skill: "guard" },
      { id: "v1", name: "平民", type: "villager" },
    ]);
    setHand(room, second, [
      { id: "w1", name: "狼人", type: "wolf" },
      { id: "v2", name: "平民", type: "villager" },
    ]);

    // 第 1 夜 P1：守卫守护 v1（出牌后手牌 [v1]，index 0）
    firstClient.send("playCard", { id: "gu" });
    await wait();
    firstClient.send("chooseTarget", { index: 0 });
    await wait();
    firstClient.send("ready");
    await wait();

    // 第 1 夜 P2：狼刀 P1 的 v1（守卫回手牌后手牌是 [gu, v1]，v1 是 index 1）
    secondClient.send("playCard", { id: "w1" });
    await wait();
    secondClient.send("chooseTarget", { index: 1 });
    await wait();
    secondClient.send("ready");
    await wait();

    assert.strictEqual(room.state.phase, "day");
    assert.ok(graveIds(room).indexOf("v1") === -1, "被守护的 v1 没有死");
    assert.ok(
      room.state.players.get(first)!.hand.some((c: any) => c.id === "v1"),
      "v1 仍在手牌里"
    );
    assert.ok(
      room.state.players.get(first)!.hand.some((c: any) => c.id === "gu"),
      "守卫自己也没有死"
    );
  });

  it("守卫（多手牌）：狼刀被守护的那张 → 挡下", async () => {
    const { room, first, second, firstClient, secondClient } = await setup();
    setHand(room, first, [
      { id: "w1", name: "狼人", type: "wolf" },
      { id: "a1", name: "平民", type: "villager" },
      { id: "a2", name: "平民", type: "villager" },
    ]);
    setHand(room, second, [
      { id: "b1", name: "平民", type: "villager" },
      { id: "b2", name: "平民", type: "villager" },
      { id: "gu", name: "守卫", type: "god", skill: "guard" },
      { id: "b3", name: "平民", type: "villager" },
    ]);

    // P1 夜：狼刀 P2 的 b2（手牌 [b1,b2,gu,b3] → index 1）
    firstClient.send("playCard", { id: "w1" });
    await wait();
    firstClient.send("chooseTarget", { index: 1 });
    await wait();
    firstClient.send("ready");
    await wait();

    // P2 夜：守卫守护 b2（出牌后手牌 [b1,b2,b3] → index 1）
    secondClient.send("playCard", { id: "gu" });
    await wait();
    secondClient.send("chooseTarget", { index: 1 });
    await wait();
    secondClient.send("ready");
    await wait();

    assert.strictEqual(room.state.phase, "day");
    const p2 = room.state.players.get(second)!;
    assert.ok(p2.hand.some((c: any) => c.id === "b2"), "被守护的 b2 存活");
    assert.ok(p2.hand.some((c: any) => c.id === "gu"), "守卫自己存活");
    assert.deepStrictEqual(graveIds(room), [], "没有任何牌死亡");
  });

  it("守卫：只守护选定的那一张，狼刀打守卫本人照样会死", async () => {
    const { room, first, second, firstClient, secondClient } = await setup();
    setHand(room, first, [
      { id: "gu", name: "守卫", type: "god", skill: "guard" },
      { id: "v1", name: "平民", type: "villager" },
      { id: "v2", name: "平民", type: "villager" },
      { id: "v3", name: "平民", type: "villager" },
    ]);
    setHand(room, second, [
      { id: "w1", name: "狼人", type: "wolf" },
      { id: "v4", name: "平民", type: "villager" },
    ]);

    // 第 1 夜 P1：守卫守护 v2（出牌后手牌 [v1,v2,v3] → v2 是 index 1）
    firstClient.send("playCard", { id: "gu" });
    await wait();
    firstClient.send("chooseTarget", { index: 1 });
    await wait();
    firstClient.send("ready");
    await wait();

    // 第 1 夜 P2：狼刀直接打在守卫身上（守卫已回手牌，index 0）
    const guIdx = room.state.players.get(first)!.hand.findIndex((c: any) => c.id === "gu");
    assert.strictEqual(guIdx, 0, "守卫回到手牌第 1 张");
    secondClient.send("playCard", { id: "w1" });
    await wait();
    secondClient.send("chooseTarget", { index: guIdx });
    await wait();
    secondClient.send("ready");
    await wait();

    assert.strictEqual(room.state.phase, "day");
    assert.ok(graveIds(room).indexOf("gu") >= 0, "狼刀打在守卫身上 → 守卫照常死");
    assert.ok(
      room.state.players.get(first)!.hand.some((c: any) => c.id === "v2"),
      "被守护的 v2 没死"
    );
    assert.deepStrictEqual(graveIds(room), ["gu"], "只有守卫进了墓地");
  });

  it("守卫：选目标超时被自动跳过（守护没生效），狼刀打守卫会死", async () => {
    const { room, first, second, firstClient, secondClient } = await setup({ turnDuration: 1200 });
    setHand(room, first, [
      { id: "gu", name: "守卫", type: "god", skill: "guard" },
      { id: "v1", name: "平民", type: "villager" },
    ]);
    setHand(room, second, [
      { id: "w1", name: "狼人", type: "wolf" },
      { id: "v2", name: "平民", type: "villager" },
    ]);

    // P1 打出守卫但【不选目标】，等倒计时把它自动跳过
    firstClient.send("playCard", { id: "gu" });
    await wait();
    assert.strictEqual(pending(room).type, "guardPick");
    await wait(1500);
    assert.strictEqual(pending(room).type, "", "超时兜底：选择被自动跳过");
    assert.ok(
      room.state.players.get(first)!.hand.some((c: any) => c.id === "gu"),
      "守卫回到手牌"
    );

    firstClient.send("ready");
    await wait();

    // P2 夜：狼刀直接打在守卫身上
    const guIdx = room.state.players.get(first)!.hand.findIndex((c: any) => c.id === "gu");
    secondClient.send("playCard", { id: "w1" });
    await wait();
    secondClient.send("chooseTarget", { index: guIdx });
    await wait();
    secondClient.send("ready");
    await wait();

    assert.strictEqual(room.state.phase, "day");
    assert.ok(
      graveIds(room).indexOf("gu") >= 0,
      "守护没生效（没选定任何牌），守卫不免疫狼刀"
    );
  });

  it("守卫：守护生效的那一夜，狼刀打在守卫自己身上照样会死", async () => {
    const { room, first, second, firstClient, secondClient } = await setup();
    setHand(room, first, [
      { id: "w1", name: "狼人", type: "wolf" },
      { id: "v1", name: "平民", type: "villager" },
    ]);
    setHand(room, second, [
      { id: "gu", name: "守卫", type: "god", skill: "guard" },
      { id: "v2", name: "平民", type: "villager" },
    ]);

    // 第 1 夜 P1：狼刀直接打在 P2 的守卫身上（index 0）
    firstClient.send("playCard", { id: "w1" });
    await wait();
    firstClient.send("chooseTarget", { index: 0 });
    await wait();
    firstClient.send("ready");
    await wait();

    // 第 1 夜 P2：守卫守护 v2（出牌后手牌 [v2]，index 0）
    secondClient.send("playCard", { id: "gu" });
    await wait();
    secondClient.send("chooseTarget", { index: 0 });
    await wait();
    secondClient.send("ready");
    await wait();

    assert.strictEqual(room.state.phase, "day");
    assert.ok(
      graveIds(room).indexOf("gu") >= 0,
      "守卫守的是 v2，狼刀打守卫本人 → 守卫死"
    );
    assert.ok(
      room.state.players.get(second)!.hand.some((c: any) => c.id === "v2"),
      "被守护的 v2 没死"
    );
    assert.deepStrictEqual(graveIds(room), ["gu"], "只有守卫进了墓地");
  });

  it("守卫：不能连续两晚守护同一张牌", async () => {
    const { room, first, second, firstClient, secondClient } = await setup();
    setHand(room, first, [
      { id: "w1", name: "狼人", type: "wolf" },
      { id: "v1", name: "平民", type: "villager" },
    ]);
    setHand(room, second, [
      { id: "gu", name: "守卫", type: "god", skill: "guard" },
      { id: "v2", name: "平民", type: "villager" },
      { id: "v3", name: "平民", type: "villager" },
    ]);

    // 第 1 夜 P2：守护 v2
    firstClient.send("ready");
    await wait();
    secondClient.send("playCard", { id: "gu" });
    await wait();
    secondClient.send("chooseTarget", { index: 0 }); // 手牌 [v2, v3] → v2
    await wait();
    secondClient.send("ready");
    await wait();

    // 走完白天 → 第 2 夜（只需 2 次 ready：P1 昼 → P2 昼 → 入夜）
    firstClient.send("ready");
    await wait();
    secondClient.send("ready");
    await wait();
    assert.strictEqual(room.state.round, 2, "进入第 2 轮");

    // 第 2 夜 P2：再守同一张 v2 → 应被拒绝
    firstClient.send("ready"); // P1 夜跳过
    await wait();
    secondClient.send("playCard", { id: "gu" });
    await wait();
    assert.strictEqual(pending(room).type, "guardPick");
    secondClient.send("chooseTarget", { index: 0 }); // v2
    await wait();
    assert.strictEqual(pending(room).type, "guardPick", "连续两晚守同一张：被拒绝");

    // 换一张就正常
    secondClient.send("chooseTarget", { index: 1 }); // v3
    await wait();
    assert.strictEqual(pending(room).type, "", "换成另一张 → 守护生效");
  });

  it("奇迹商人：强化猎人 → 开枪带走 2 张（不是 3 张、也不会一直杀）", async () => {
    const { room, first, second, firstClient, secondClient } = await setup();
    setHand(room, first, [
      { id: "w1", name: "狼人", type: "wolf" },
      { id: "v1", name: "平民", type: "villager" },
      { id: "v2", name: "平民", type: "villager" },
    ]);
    setHand(room, second, [
      { id: "me1", name: "奇迹商人", type: "villager", skill: "miracleMerchant" },
      { id: "hu", name: "猎人", type: "god", skill: "hunter" },
    ]);

    // 第 1 夜 P2：出奇迹商人 → 强化猎人（出牌后手牌 [hu]，选 index 0）
    firstClient.send("ready");
    await wait();
    secondClient.send("playCard", { id: "me1" });
    await wait();
    assert.strictEqual(pending(room).type, "merchantBless");
    secondClient.send("chooseTarget", { index: 0 });
    await wait();
    const hunter = room.state.players.get(second)!.hand.find((c: any) => c.id === "hu");
    assert.strictEqual(hunter.blessCharges, 1, "猎人只多带 1 人（合计 2 张）");
    const merchant = room.state.players.get(second)!.hand.find((c: any) => c.id === "me1");
    assert.strictEqual(merchant.usedOnce, true, "奇迹商人整局只能用一次");

    secondClient.send("ready");
    await wait();
    firstClient.send("ready");
    await wait();
    secondClient.send("ready");
    await wait();
    assert.strictEqual(room.state.round, 2, "进入第 2 轮");

    // 第 2 夜 P1：狼刀杀猎人（P2 手牌 index 1）
    const huIdx = room.state.players.get(second)!.hand.findIndex((c: any) => c.id === "hu");
    firstClient.send("playCard", { id: "w1" });
    await wait();
    firstClient.send("chooseTarget", { index: huIdx });
    await wait();
    firstClient.send("ready");
    await wait();
    secondClient.send("ready");
    await wait();

    // 猎人死亡 → 一枪带走两张：选第一张后还要补选一张，补完就结束
    assert.strictEqual(pending(room).type, "hunter", "猎人亡语触发");
    secondClient.send("chooseTarget", { index: handIdx(room, first, "v1") });
    await wait();
    assert.strictEqual(pending(room).type, "hunter", "强化生效：这一枪还要带走第二张");
    secondClient.send("chooseTarget", { index: handIdx(room, first, "v2") });
    await wait();
    assert.strictEqual(pending(room).type, "", "两张已带走，不会继续杀");

    const graves = graveIds(room);
    assert.ok(graves.indexOf("v1") >= 0, "第一张带走 v1");
    assert.ok(graves.indexOf("v2") >= 0, "第二张带走 v2");
    assert.ok(graves.indexOf("w1") < 0, "只带走 2 张，w1 仍在世");
    assert.ok(graves.indexOf("hu") >= 0, "猎人自己进了墓地");
  });

  it("奇迹商人：强化女巫 → 当场二选一，多一瓶毒药 / 多一瓶解药", async () => {
    const { room, first, second, firstClient, secondClient } = await setup();
    setHand(room, first, [
      { id: "v1", name: "平民", type: "villager" },
      { id: "v2", name: "平民", type: "villager" },
    ]);
    setHand(room, second, [
      { id: "me1", name: "奇迹商人", type: "villager", skill: "miracleMerchant" },
      { id: "wt", name: "女巫", type: "god", skill: "witch" },
    ]);
    // 先用掉两瓶药
    const witch = room.state.players.get(second)!.hand.find((c: any) => c.id === "wt");
    witch.witchReviveUsed = true;
    witch.witchPoisonUsed = true;

    firstClient.send("ready");
    await wait();
    secondClient.send("playCard", { id: "me1" });
    await wait();
    secondClient.send("chooseTarget", { index: 0 });
    await wait();
    assert.strictEqual(pending(room).type, "witchBless", "强化女巫要当场二选一");
    assert.strictEqual(witch.witchReviveUsed, true, "选之前不自动补药");
    assert.strictEqual(witch.witchPoisonUsed, true, "选之前不自动补药");

    // 玩家选【多一瓶毒药】
    secondClient.send("blessPotion", { mode: "poison" });
    await wait();
    assert.strictEqual(pending(room).type, "", "选完即结算结束");
    assert.strictEqual(witch.blessCharges, 1, "得到一瓶强化药");
    assert.strictEqual(witch.blessPotion, "poison", "强化的是毒药");
    assert.strictEqual(witch.witchReviveUsed, true, "解药没有补");
    assert.strictEqual(witch.witchPoisonUsed, true, "毒药标记仍是已用（靠强化层顶）");
    const merchant = room.state.players.get(second)!.hand.find((c: any) => c.id === "me1");
    assert.strictEqual(merchant.usedOnce, true, "奇迹商人整局一次");

    // 用强化补的那瓶毒药：毒对方一张手牌
    secondClient.send("useSkill", { cardId: "wt", mode: "poison" });
    await wait();
    assert.strictEqual(pending(room).type, "witchPoison", "用强化补的这瓶毒药生效");
    secondClient.send("chooseTarget", { index: 0 });
    await wait();
    assert.strictEqual(witch.blessCharges, 0, "强化药已消耗");

    // 再用解药 → 没有强化也没有药，应被拒绝
    let rejected: string | null = null;
    secondClient.onMessage("playRejected", (m: any) => (rejected = m.reason));
    secondClient.send("useSkill", { cardId: "wt", mode: "revive" });
    await wait();
    assert.ok(rejected && /解药已经用过/.test(rejected), `应拒绝，实际：${rejected}`);
  });

  it("奇迹商人：强化女巫选「多一瓶解药」→ 解药可再用一次", async () => {
    const { room, first, second, firstClient, secondClient } = await setup();
    setHand(room, first, [
      { id: "v1", name: "平民", type: "villager" },
      { id: "v2", name: "平民", type: "villager" },
    ]);
    setHand(room, second, [
      { id: "me1", name: "奇迹商人", type: "villager", skill: "miracleMerchant" },
      { id: "wt", name: "女巫", type: "god", skill: "witch" },
    ]);
    const witch = room.state.players.get(second)!.hand.find((c: any) => c.id === "wt");
    witch.witchReviveUsed = true; // 解药已经用过

    // 墓地放两张死牌，供复活
    ["d1", "d2"].forEach((id) => {
      const dead = new Card();
      dead.id = id;
      dead.name = "平民";
      dead.type = "villager";
      dead.owner = second;
      room.state.players.get(second)!.graveyard.push(dead);
    });

    firstClient.send("ready");
    await wait();
    secondClient.send("playCard", { id: "me1" });
    await wait();
    secondClient.send("chooseTarget", { index: 0 });
    await wait();
    secondClient.send("blessPotion", { mode: "revive" });
    await wait();
    assert.strictEqual(witch.blessPotion, "revive", "强化的是解药");

    // 用强化补的那瓶解药复活一张
    secondClient.send("useSkill", { cardId: "wt", mode: "revive" });
    await wait();
    assert.strictEqual(pending(room).type, "witchRevive", "强化解药可用");
    secondClient.send("chooseTarget", { index: 0 });
    await wait();
    assert.strictEqual(witch.blessCharges, 0, "强化解药已消耗");

    // 毒药没被强化 → 用毒药应被拒绝
    let rejected: string | null = null;
    secondClient.onMessage("playRejected", (m: any) => (rejected = m.reason));
    secondClient.send("useSkill", { cardId: "wt", mode: "revive" });
    await wait();
    assert.ok(rejected && /解药已经用过/.test(rejected), `再用解药应被拒绝，实际：${rejected}`);
  });

  it("奇迹商人：强化通灵师 → 一次通灵换回墓地两张", async () => {
    const { room, first, second, firstClient, secondClient } = await setup();
    setHand(room, first, [{ id: "v1", name: "平民", type: "villager" }]);
    setHand(room, second, [
      { id: "me1", name: "奇迹商人", type: "villager", skill: "miracleMerchant" },
      { id: "ne", name: "通灵师", type: "god", skill: "necromancer" },
    ]);
    // 给 P2 的墓地塞两张牌
    const g = room.state.players.get(second)!.graveyard;
    ["d1", "d2"].forEach((id) => {
      const c = new Card();
      c.id = id;
      c.name = "平民";
      c.type = "villager";
      c.owner = second;
      g.push(c);
    });
    assert.strictEqual(g.length, 2, "墓地 2 张");

    firstClient.send("ready");
    await wait();
    secondClient.send("playCard", { id: "me1" });
    await wait();
    secondClient.send("chooseTarget", { index: 0 }); // 强化通灵师
    await wait();
    const ne = room.state.players.get(second)!.hand.find((c: any) => c.id === "ne");
    assert.strictEqual(ne.blessCharges, 1, "通灵师得到强化");

    // 通灵：选第 1 张
    secondClient.send("playCard", { id: "ne" });
    await wait();
    assert.strictEqual(pending(room).type, "necromancer");
    secondClient.send("chooseTarget", { index: 0 });
    await wait();
    assert.strictEqual(pending(room).type, "necromancer", "强化后还要再选一张");
    assert.strictEqual(room.state.players.get(second)!.graveyard.length, 1, "墓地已取走一张");

    // 选第 2 张 → 结束，通灵师自己进墓地
    secondClient.send("chooseTarget", { index: 0 });
    await wait();
    assert.strictEqual(pending(room).type, "", "第二张选完结算结束");
    assert.deepStrictEqual(
      room.state.players.get(second)!.graveyard.map((c: any) => c.id),
      ["ne"],
      "墓地两张都换回来了，只剩通灵师自己"
    );
    assert.strictEqual(
      room.state.players.get(second)!.hand.filter((c: any) => c.id === "d1" || c.id === "d2").length,
      2,
      "两张牌都回到手牌"
    );
    assert.ok(graveIds(room).indexOf("ne") >= 0, "通灵师自己进墓地");
  });

  it("野孩子：榜样死亡 → 野孩子变成狼人", async () => {
    const { room, first, second, firstClient, secondClient } = await setup();
    const turned1: any[] = [];
    const turned2: any[] = [];
    firstClient.onMessage("wildChildTurned", (m) => turned1.push(m));
    secondClient.onMessage("wildChildTurned", (m) => turned2.push(m));
    setHand(room, first, [
      { id: "w1", name: "狼人", type: "wolf" },
      { id: "v1", name: "平民", type: "villager" },
    ]);
    setHand(room, second, [
      { id: "wc", name: "野孩子", type: "villager", skill: "wildChild" },
      { id: "v2", name: "平民", type: "villager" },
    ]);

    // 第 1 夜 P2：出野孩子 → 指定榜样（己方 v2，出牌后手牌 [v2]，index 0）
    firstClient.send("ready");
    await wait();
    secondClient.send("playCard", { id: "wc" });
    await wait();
    assert.strictEqual(pending(room).type, "wildChildIdol");
    secondClient.send("chooseTarget", { index: 0, side: "self" });
    await wait();
    const wc0 = room.state.players.get(second)!.hand.find((c: any) => c.id === "wc");
    assert.strictEqual(wc0.usedOnce, true, "榜样整局只能指定一次");
    assert.strictEqual(wc0.type, "villager", "此时还是平民");

    secondClient.send("ready");
    await wait();
    firstClient.send("ready");
    await wait();
    secondClient.send("ready");
    await wait();
    assert.strictEqual(room.state.round, 2, "进入第 2 轮");

    // 第 2 夜 P1：刀掉榜样 v2
    const v2Idx = room.state.players.get(second)!.hand.findIndex((c: any) => c.id === "v2");
    firstClient.send("playCard", { id: "w1" });
    await wait();
    firstClient.send("chooseTarget", { index: v2Idx });
    await wait();
    firstClient.send("ready");
    await wait();
    secondClient.send("ready");
    await wait();

    const wc1 = room.state.players.get(second)!.hand.find((c: any) => c.id === "wc");
    assert.ok(graveIds(room).indexOf("v2") >= 0, "榜样 v2 死亡");
    assert.ok(wc1, "野孩子还活着");
    assert.strictEqual(wc1.type, "wolf", "榜样死后野孩子变成狼人");
    assert.strictEqual(wc1.name, "野孩子", "卡面名称仍是野孩子");
    assert.strictEqual(wc1.turnedWolf, true, "打上变狼标记（右下角标狼）");
    assert.strictEqual(turned1.length, 1, "P1 收到变狼播报");
    assert.strictEqual(turned2.length, 1, "P2 收到变狼播报");
  });

  it("野孩子：选择榜样后，榜样卡背显示「榜」字（仅野孩子使用者可见，榜样死亡后清除）", async () => {
    const { room, first, second, firstClient, secondClient } = await setup();
    // 野孩子在 P2；榜样 v2 在 P2 手牌 [wc, v2, v3] 中（出牌后离手，v2 落到 index 0），由 P2 指定为榜样。
    // 回手后 v2 回到 index 1，故榜字标记应落在槽位 1。
    // 第 2 夜由 P1 的狼刀刀掉 P2 的 v2（狼刀只能指向对方手牌）。
    setHand(room, first, [
      { id: "w1", name: "狼人", type: "wolf" },
      { id: "v1", name: "平民", type: "villager" },
    ]);
    setHand(room, second, [
      { id: "wc", name: "野孩子", type: "villager", skill: "wildChild" },
      { id: "v2", name: "平民", type: "villager" },
      { id: "v3", name: "平民", type: "villager" },
    ]);

    // 第 1 夜 P1 跳过 → P2 出野孩子，指定自己手牌的 v2（index 1）为榜样
    firstClient.send("ready");
    await wait();
    secondClient.send("playCard", { id: "wc" });
    await wait();
    assert.strictEqual(pending(room).type, "wildChildIdol");
    // 出牌后 wc 离手，P2 手牌剩 [v2, v3]，故 v2 在 index 0
    secondClient.send("chooseTarget", { index: 0, side: "self" });
    await wait();
    await wait();

    const p2 = room.state.players.get(second)!;
    // 服务端权威数据：被指定的 P2 手牌 v2（index 1）所在槽位被打上「榜」标记
    assert.ok(
      Array.from(p2.idolSlots).includes(1),
      "被指定的榜样 v2（#2）所在槽位被打上榜字标记"
    );
    assert.deepStrictEqual(Array.from(p2.idolPlaySlots), [], "行动区无标记");
    assert.deepStrictEqual(
      Array.from(room.state.players.get(first)!.idolSlots),
      [],
      "对方（P1）一方手牌无榜字标记"
    );

    // ★ 视图可见性：只有野孩子使用者（P2）收得到 idolSlots，对方（P1）看不到
    //   注意：未授权的客户端连该字段都收不到（值为 undefined），这正是视图控制生效的证明
    const safeSlots = (clientState: any, sid: string): number[] => {
      const p = clientState.players.get(sid);
      return p && p.idolSlots ? Array.from(p.idolSlots) : [];
    };
    const p2SlotsSeenBySelf = safeSlots(secondClient.state, second);
    assert.ok(p2SlotsSeenBySelf.includes(1), "野孩子使用者（P2）能看到榜字标记");
    assert.deepStrictEqual(
      safeSlots(firstClient.state, second),
      [],
      "对方（P1）看不到 P2 手牌上的榜字标记"
    );

    // 推进到第 2 轮
    secondClient.send("ready");
    await wait();
    firstClient.send("ready");
    await wait();
    secondClient.send("ready");
    await wait();
    assert.strictEqual(room.state.round, 2, "进入第 2 轮");

    // 第 2 夜 P1 的狼刀刀掉 P2 的榜样 v2（index 1）
    const v2Idx = p2.hand.findIndex((c: any) => c.id === "v2");
    firstClient.send("playCard", { id: "w1" });
    await wait();
    firstClient.send("chooseTarget", { index: v2Idx });
    await wait();
    firstClient.send("ready");
    await wait();
    secondClient.send("ready");
    await wait();

    // 榜样死亡 → 野孩子变狼，榜字标记随之清除
    assert.ok(graveIds(room).indexOf("v2") >= 0, "榜样 v2 死亡");
    assert.deepStrictEqual(
      Array.from(room.state.players.get(second)!.idolSlots),
      [],
      "榜样死亡后榜字标记已清除"
    );
  });

  it("野孩子变狼后：夜里能独自出刀杀人（手上没有别的狼牌）", async () => {
    const { room, first, second, firstClient, secondClient } = await setup();
    setHand(room, first, [
      { id: "w1", name: "狼人", type: "wolf" },
      { id: "a1", name: "平民", type: "villager" },
      { id: "a2", name: "平民", type: "villager" },
    ]);
    setHand(room, second, [
      { id: "wc", name: "野孩子", type: "villager", skill: "wildChild" },
      { id: "v2", name: "平民", type: "villager" },
      { id: "v3", name: "平民", type: "villager" },
    ]);

    // 第 1 夜：P1 跳过 → P2 出野孩子指定榜样（己方 v2）
    firstClient.send("ready");
    await wait();
    secondClient.send("playCard", { id: "wc" });
    await wait();
    assert.strictEqual(pending(room).type, "wildChildIdol");
    secondClient.send("chooseTarget", { index: 0, side: "self" }); // 出牌后手牌 [v2, v3]
    await wait();

    // 进第 2 轮：P1 刀掉榜样 v2 → 野孩子变狼
    secondClient.send("ready");
    await wait();
    firstClient.send("ready");
    await wait();
    secondClient.send("ready");
    await wait();
    // 第 2 夜 P1：刀掉榜样 v2
    firstClient.send("playCard", { id: "w1" });
    await wait();
    const v2Idx = room.state.players.get(second)!.hand.findIndex((c: any) => c.id === "v2");
    firstClient.send("chooseTarget", { index: v2Idx });
    await wait();
    firstClient.send("ready");
    await wait();
    secondClient.send("ready");
    await wait();

    assert.strictEqual(room.state.phase, "day", "天亮结算");
    const wc = room.state.players.get(second)!.hand.find((c: any) => c.id === "wc");
    assert.ok(wc && wc.turnedWolf === true, "野孩子已经变狼");

    // 白天双方跳过 → 进入第 3 夜
    firstClient.send("ready");
    await wait();
    secondClient.send("ready");
    await wait();
    assert.strictEqual(room.state.round, 3, "进入第 3 轮");
    firstClient.send("ready"); // P1 第 3 夜跳过
    await wait();

    // ★ 第 3 夜 P2：手上只有变狼的野孩子（其余是平民），没有任何别的狼牌 —— 它仍能出刀
    const reject: any[] = [];
    secondClient.onMessage("playRejected", (m: any) => reject.push(m));
    secondClient.send("playCard", { id: "wc" });
    await wait();
    assert.deepStrictEqual(reject, [], "出牌没有被拒绝");
    assert.strictEqual(pending(room).type, "wolfKnife", "变狼的野孩子走的是狼刀");
    assert.strictEqual(room.state.wolfKnifeUsed, true, "占用狼人共用刀");

    const oppHand = room.state.players.get(first)!.hand;
    const tIdx = oppHand.findIndex((c: any) => c.id === "a1");
    secondClient.send("chooseTarget", { index: tIdx });
    await wait();
    secondClient.send("ready");
    await wait();
    firstClient.send("ready");
    await wait();
    assert.strictEqual(room.state.phase, "day");
    assert.ok(graveIds(room).indexOf("a1") >= 0, "被变狼野孩子刀掉的牌进入墓地");
    assert.ok(graveIds(room).indexOf("wc") === -1, "野孩子自己活着");
  });

  it("炸弹人：被放逐时引爆 → 随机炸死放逐方三张手牌（且被炸死的牌不触发技能）", async () => {
    const { room, first, second, firstClient, secondClient } = await setup();
    setHand(room, first, [
      { id: "v1", name: "平民", type: "villager" },
      { id: "v2", name: "平民", type: "villager" },
      { id: "v3", name: "平民", type: "villager" },
      { id: "v4", name: "平民", type: "villager" },
      { id: "v5", name: "平民", type: "villager" },
    ]);
    setHand(room, second, [
      { id: "bo1", name: "炸弹人", type: "villager", skill: "bomber" },
      { id: "w1", name: "狼人", type: "wolf" },
    ]);

    // 第 1 夜：P1 跳过 → P2 出狼刀杀 P1 的 v5 → 天亮 P1「本夜死过牌」= 可流放
    firstClient.send("ready");
    await wait();
    secondClient.send("playCard", { id: "w1" });
    await wait();
    secondClient.send("chooseTarget", { index: 4 });
    await wait();
    secondClient.send("ready");
    await wait();
    assert.strictEqual(room.state.phase, "day");
    assert.strictEqual(room.state.turnOwner, first);
    assert.strictEqual(room.state.players.get(first)!.handCount, 4, "v5 已死");

    // 白天：P1 流放对方的炸弹人
    firstClient.send("exile");
    await wait();
    assert.strictEqual(pending(room).type, "exile");
    firstClient.send("chooseTarget", { index: 0 });
    await wait();

    const p1 = room.state.players.get(first)!;
    const p2 = room.state.players.get(second)!;
    assert.ok(graveyardOf(room, second).some((c: any) => c.id === "bo1"), "炸弹人自己进墓地");
    assert.strictEqual(p1.handCount, 1, "被炸掉 3 张，只剩 1 张");
    assert.strictEqual(graveyardOf(room, first).length, 4, "v5 + 被炸的 3 张");
    assert.strictEqual(pending(room).type, "", "被炸死的牌不触发任何技能");
    assert.ok(p2.handCount >= 1, "放逐方（P2）手牌不受影响");
  });

  it("炸弹人：被狼刀杀死不引爆（只有流放才会引爆）", async () => {
    const { room, first, second, firstClient, secondClient } = await setup();
    setHand(room, first, [
      { id: "bo1", name: "炸弹人", type: "villager", skill: "bomber" },
      { id: "v1", name: "平民", type: "villager" },
      { id: "v2", name: "平民", type: "villager" },
      { id: "v3", name: "平民", type: "villager" },
    ]);
    setHand(room, second, [
      { id: "w1", name: "狼人", type: "wolf" },
    ]);

    // 第 1 夜：P1 跳过 → P2 出狼刀杀 P1 的炸弹人（#1）
    firstClient.send("ready");
    await wait();
    secondClient.send("playCard", { id: "w1" });
    await wait();
    secondClient.send("chooseTarget", { index: 0 });
    await wait();
    secondClient.send("ready");
    await wait();

    // 天亮：炸弹人进墓地，但"被杀死"不会引爆
    assert.strictEqual(room.state.phase, "day", "已进入白天");
    assert.ok(
      graveyardOf(room, first).some((c: any) => c.id === "bo1"),
      "炸弹人进了 P1 自己的墓地"
    );
    assert.strictEqual(
      room.state.players.get(second)!.handCount,
      1,
      "放逐方（P2）手牌不受影响（狼人仍在）"
    );
    assert.strictEqual(
      room.state.players.get(first)!.handCount,
      3,
      "P1 其余 3 张平民不受影响"
    );
    assert.strictEqual(pending(room).type, "", "被杀死不会触发任何技能结算");
  });

  it("狼美人：魅惑对方 → 狼美人死亡时被魅惑的牌随之倒下（不触发死亡技能）", async () => {
    const { room, first, second, firstClient, secondClient } = await setup();
    setHand(room, first, [
      { id: "w1", name: "狼人", type: "wolf" },
      { id: "hu", name: "猎人", type: "god", skill: "hunter" },
      { id: "v1", name: "平民", type: "villager" },
    ]);
    setHand(room, second, [
      { id: "bt", name: "狼美人", type: "wolf", skill: "wolfBeauty" },
      { id: "v2", name: "平民", type: "villager" },
      { id: "v3", name: "平民", type: "villager" },
    ]);

    // 第 1 夜 P1 跳过 → P2 出狼美人魅惑 P1 的猎人（#2）
    firstClient.send("ready");
    await wait();
    secondClient.send("playCard", { id: "bt" });
    await wait();
    assert.strictEqual(pending(room).type, "wolfBeautyChoice", "先在杀人 / 魅惑之间二选一");
    secondClient.send("beautyAction", { mode: "charm" });
    await wait();
    assert.strictEqual(pending(room).type, "wolfBeautyCharm");
    secondClient.send("chooseTarget", { index: 1 });
    await wait();
    const bt0 = room.state.players.get(second)!.hand.find((c: any) => c.id === "bt");
    assert.strictEqual(bt0.charmedId, "hu", "记下了被魅惑的牌");
    assert.strictEqual(room.state.wolfKnifeUsed, false, "魅惑不消耗共用狼刀");

    secondClient.send("ready");
    await wait();
    firstClient.send("ready");
    await wait();
    secondClient.send("ready");
    await wait();
    assert.strictEqual(room.state.round, 2, "进入第 2 轮");

    // 第 2 夜 P1 出狼刀杀掉狼美人
    firstClient.send("playCard", { id: "w1" });
    await wait();
    const btIdx = room.state.players.get(second)!.hand.findIndex((c: any) => c.id === "bt");
    firstClient.send("chooseTarget", { index: btIdx });
    await wait();
    firstClient.send("ready");
    await wait();
    secondClient.send("ready");
    await wait();

    assert.ok(graveIds(room).indexOf("bt") >= 0, "狼美人死亡");
    assert.ok(graveIds(room).indexOf("hu") >= 0, "被魅惑的猎人随之倒下");
    assert.strictEqual(pending(room).type, "", "被魅惑带走的猎人不能开枪");
    assert.ok(
      room.state.players.get(first)!.hand.some((c: any) => c.id === "v1"),
      "P1 其余手牌不受影响"
    );
  });

  it("狼美人：魅惑后给被魅惑的牌打上爱心（仅魅惑者可见的槽位数据）", async () => {
    const { room, first, second, firstClient, secondClient } = await setup();
    setHand(room, first, [
      { id: "w1", name: "狼人", type: "wolf" },
      { id: "hu", name: "猎人", type: "god", skill: "hunter" },
      { id: "v1", name: "平民", type: "villager" },
    ]);
    setHand(room, second, [
      { id: "bt", name: "狼美人", type: "wolf", skill: "wolfBeauty" },
      { id: "v2", name: "平民", type: "villager" },
    ]);

    firstClient.send("ready");
    await wait();
    secondClient.send("playCard", { id: "bt" });
    await wait();
    secondClient.send("beautyAction", { mode: "charm" });
    await wait();
    secondClient.send("chooseTarget", { index: 1 }); // 魅惑 P1 的猎人（#2）
    await wait();

    const firstP = room.state.players.get(first)!;
    assert.deepStrictEqual(Array.from(firstP.charmedSlots), [1], "被魅惑的牌（猎人）槽位被标记");
    assert.strictEqual(firstP.charmedPlaySlots.length, 0, "行动区暂无被魅惑的牌");

    secondClient.send("ready");
    await wait();
    firstClient.send("ready");
    await wait();
    secondClient.send("ready");
    await wait();

    // 第 2 夜 P1 出狼刀杀掉狼美人 → 魅惑解除，爱心槽位清空
    firstClient.send("playCard", { id: "w1" });
    await wait();
    const btIdx = room.state.players.get(second)!.hand.findIndex((c: any) => c.id === "bt");
    firstClient.send("chooseTarget", { index: btIdx });
    await wait();
    firstClient.send("ready");
    await wait();
    secondClient.send("ready");
    await wait();

    assert.deepStrictEqual(Array.from(firstP.charmedSlots), [], "狼美人死亡 → 爱心标记消失");
  });

  it("狼美人：本夜狼刀已用过 → 仍可发动，只是「杀人」不可用", async () => {
    const { room, first, second, firstClient, secondClient } = await setup();
    setHand(room, first, [
      { id: "w1", name: "狼人", type: "wolf" },
      { id: "bt", name: "狼美人", type: "wolf", skill: "wolfBeauty" },
    ]);
    setHand(room, second, [
      { id: "a1", name: "平民", type: "villager" },
      { id: "a2", name: "平民", type: "villager" },
    ]);

    // 第 1 夜 P1：先用普通狼人出刀
    firstClient.send("playCard", { id: "w1" });
    await wait();
    firstClient.send("chooseTarget", { index: 0 });
    await wait();
    assert.strictEqual(room.state.wolfKnifeUsed, true, "本夜共用狼刀已用过");
    assert.strictEqual(pending(room).type, "", "狼刀结算完");

    // ★ 同一回合再出狼美人：应该还能发动（弹二选一）
    firstClient.send("playCard", { id: "bt" });
    await wait();
    assert.strictEqual(pending(room).type, "wolfBeautyChoice", "狼刀用过后狼美人仍可发动");

    // 选「杀人」→ 被拒（共用刀已用）
    firstClient.send("beautyAction", { mode: "kill" });
    await wait();
    assert.strictEqual(pending(room).type, "wolfBeautyChoice", "杀人被拒，仍停在二选一");

    // 选「魅惑」→ 正常
    firstClient.send("beautyAction", { mode: "charm" });
    await wait();
    assert.strictEqual(pending(room).type, "wolfBeautyCharm");
    firstClient.send("chooseTarget", { index: 1 });
    await wait();
    const bt = room.state.players.get(first)!.hand.find((c: any) => c.id === "bt");
    assert.ok(bt, "狼美人回到手牌");
    assert.strictEqual(bt!.charmedId, "a2", "魅惑生效（不消耗共用狼刀）");
  });

  it("狼美人：先魅惑 → 同一夜还能再出刀杀人", async () => {
    const { room, first, second, firstClient, secondClient } = await setup();
    setHand(room, first, [
      { id: "bt", name: "狼美人", type: "wolf", skill: "wolfBeauty" },
      { id: "v0", name: "平民", type: "villager" },
    ]);
    setHand(room, second, [
      { id: "a1", name: "平民", type: "villager" },
      { id: "a2", name: "平民", type: "villager" },
    ]);

    // 第 1 夜 P1：先魅惑对方 #2
    firstClient.send("playCard", { id: "bt" });
    await wait();
    assert.strictEqual(pending(room).type, "wolfBeautyChoice");
    firstClient.send("beautyAction", { mode: "charm" });
    await wait();
    assert.strictEqual(pending(room).type, "wolfBeautyCharm");
    firstClient.send("chooseTarget", { index: 1 });
    await wait();

    const bt = room.state.players.get(first)!.hand.find((c: any) => c.id === "bt");
    assert.ok(bt, "狼美人回到手牌");
    assert.strictEqual(bt!.charmedId, "a2", "魅惑生效");
    assert.strictEqual(bt!.acted, false, "★ 魅惑不消耗行动：同回合还能再出一次");
    assert.strictEqual(room.state.wolfKnifeUsed, false, "魅惑不占用共用狼刀");

    // ★ 同一回合再点狼美人 → 这次选「杀人」，走共用狼刀
    firstClient.send("playCard", { id: "bt" });
    await wait();
    assert.strictEqual(pending(room).type, "wolfBeautyChoice", "魅惑后仍可发动");
    firstClient.send("beautyAction", { mode: "kill" });
    await wait();
    assert.strictEqual(pending(room).type, "wolfKnife", "进入狼刀选目标");
    assert.strictEqual(room.state.wolfKnifeUsed, true, "这一刀占用共用狼刀");
    firstClient.send("chooseTarget", { index: 0 });
    await wait();

    // 杀完这一夜就到头了（刀已用 + 已魅惑）
    const bt2 = room.state.players.get(first)!.hand.find((c: any) => c.id === "bt");
    assert.strictEqual(bt2!.acted, true, "出刀后本夜不能再行动");

    firstClient.send("ready");
    await wait();
    secondClient.send("ready");
    await wait();
    assert.strictEqual(room.state.phase, "day");
    assert.ok(graveIds(room).indexOf("a1") >= 0, "被刀的 a1 天亮进墓地");
    assert.ok(graveIds(room).indexOf("a2") < 0, "被魅惑的 a2 还活着（狼美人没死）");
  });

  it("狼美人：先魅惑 → 再用别的狼出刀 → 这张牌本回合彻底锁死", async () => {
    const { room, first, second, firstClient, secondClient } = await setup();
    let rejected = "";
    firstClient.onMessage("playRejected", (m: any) => (rejected = m.reason));
    setHand(room, first, [
      { id: "bt", name: "狼美人", type: "wolf", skill: "wolfBeauty" },
      { id: "w1", name: "狼人", type: "wolf" },
      { id: "v0", name: "平民", type: "villager" },
    ]);
    setHand(room, second, [
      { id: "a1", name: "平民", type: "villager" },
      { id: "a2", name: "平民", type: "villager" },
      { id: "a3", name: "平民", type: "villager" },
    ]);

    // 第 1 夜 P1：先用狼美人【魅惑】对方 #2
    firstClient.send("playCard", { id: "bt" });
    await wait();
    assert.strictEqual(pending(room).type, "wolfBeautyChoice");
    firstClient.send("beautyAction", { mode: "charm" });
    await wait();
    firstClient.send("chooseTarget", { index: 1 });
    await wait();
    let bt = room.state.players.get(first)!.hand.find((c: any) => c.id === "bt");
    assert.strictEqual(bt!.charmedId, "a2", "魅惑生效");
    assert.strictEqual(bt!.charmUsedTonight, true, "已记下本夜魅惑过");
    assert.strictEqual(bt!.acted, false, "刀还在 → 她还能出刀");
    assert.strictEqual(room.state.wolfKnifeUsed, false, "魅惑不占用共用狼刀");

    // ★ 改用【另一张狼人】出刀：共用刀被它用掉
    firstClient.send("playCard", { id: "w1" });
    await wait();
    assert.strictEqual(pending(room).type, "wolfKnife");
    firstClient.send("chooseTarget", { index: 0 });
    await wait();
    assert.strictEqual(room.state.wolfKnifeUsed, true, "共用刀已消耗");

    // ★ 魅惑用过 + 刀也被用掉 → 狼美人这回合没有任何技能，卡面锁死
    bt = room.state.players.get(first)!.hand.find((c: any) => c.id === "bt");
    assert.strictEqual(bt!.acted, true, "狼美人本回合技能已用完");

    rejected = "";
    firstClient.send("playCard", { id: "bt" });
    await wait();
    assert.strictEqual(pending(room).type, "", "再点狼美人被拒，不进入二选一");
    assert.match(rejected, /技能已用完/, "给出被拒原因");

    // 天亮结算：a1 被刀，a2 只是被魅惑（狼美人还活着）
    firstClient.send("ready");
    await wait();
    secondClient.send("ready");
    await wait();
    assert.strictEqual(room.state.phase, "day");
    assert.ok(graveIds(room).indexOf("a1") >= 0, "被刀的 a1 天亮进墓地");
    assert.ok(graveIds(room).indexOf("a2") < 0, "被魅惑的 a2 还活着");

    // ★ 新的一夜：魅惑标记与锁死状态都重置
    firstClient.send("ready"); // P1 白天回合
    await wait();
    secondClient.send("ready"); // P2 白天回合 → 进入第 2 夜（P1 先手）
    await wait();
    assert.strictEqual(room.state.phase, "night", "第 2 夜");
    bt = room.state.players.get(first)!.hand.find((c: any) => c.id === "bt");
    assert.ok(bt, "狼美人仍在手牌");
    assert.strictEqual(bt!.charmUsedTonight, false, "新的一夜魅惑标记重置");
    assert.strictEqual(bt!.acted, false, "新的一夜她又可以行动了");
  });

  it("狼美人：选「杀人」→ 走共用狼刀；取消则收回手牌", async () => {
    const { room, first, second, firstClient, secondClient } = await setup();
    setHand(room, first, [
      { id: "v1", name: "平民", type: "villager" },
      { id: "v2", name: "平民", type: "villager" },
    ]);
    setHand(room, second, [
      { id: "bt", name: "狼美人", type: "wolf", skill: "wolfBeauty" },
      { id: "v3", name: "平民", type: "villager" },
    ]);

    firstClient.send("ready");
    await wait();

    // 先试取消：狼美人回到手牌，本回合没消耗行动
    secondClient.send("playCard", { id: "bt" });
    await wait();
    assert.strictEqual(pending(room).type, "wolfBeautyChoice");
    secondClient.send("beautyAction", { mode: "cancel" });
    await wait();
    const btBack = room.state.players.get(second)!.hand.find((c: any) => c.id === "bt");
    assert.ok(btBack, "取消后狼美人回到手牌");
    assert.strictEqual(btBack!.acted, false, "取消不消耗本回合行动");
    assert.strictEqual(room.state.pendingAction.type, "");

    // 再出一次，这次选杀人
    secondClient.send("playCard", { id: "bt" });
    await wait();
    secondClient.send("beautyAction", { mode: "kill" });
    await wait();
    assert.strictEqual(pending(room).type, "wolfKnife", "选杀人后进入狼刀选目标");
    assert.strictEqual(room.state.wolfKnifeUsed, true, "她的刀就是那把共用狼刀");
    secondClient.send("chooseTarget", { index: 0 });
    await wait();
    secondClient.send("ready");
    await wait();

    assert.strictEqual(room.state.phase, "day", "天亮");
    assert.ok(graveIds(room).indexOf("v1") >= 0, "被刀的目标天亮进墓地");
  });

  it("老流氓：不受魅惑", async () => {
    const { room, first, second, firstClient, secondClient } = await setup();
    setHand(room, first, [
      { id: "w1", name: "狼人", type: "wolf" },
      { id: "rg", name: "老流氓", type: "villager", skill: "oldRogue" },
      { id: "v1", name: "平民", type: "villager" },
    ]);
    setHand(room, second, [
      { id: "bt", name: "狼美人", type: "wolf", skill: "wolfBeauty" },
      { id: "v2", name: "平民", type: "villager" },
    ]);

    // 第 1 夜：P1 跳过 → P2 狼美人魅惑 P1 的老流氓（#2）
    firstClient.send("ready");
    await wait();
    secondClient.send("playCard", { id: "bt" });
    await wait();
    secondClient.send("beautyAction", { mode: "charm" });
    await wait();
    secondClient.send("chooseTarget", { index: 1 });
    await wait();
    secondClient.send("ready");
    await wait();

    // 第 2 夜：P1 刀掉狼美人
    firstClient.send("ready");
    await wait();
    secondClient.send("ready");
    await wait();
    assert.strictEqual(room.state.round, 2);
    firstClient.send("playCard", { id: "w1" });
    await wait();
    const btIdx = room.state.players.get(second)!.hand.findIndex((c: any) => c.id === "bt");
    firstClient.send("chooseTarget", { index: btIdx });
    await wait();
    firstClient.send("ready");
    await wait();
    secondClient.send("ready");
    await wait();

    assert.ok(graveIds(room).indexOf("bt") >= 0, "狼美人死亡");
    assert.ok(
      room.state.players.get(first)!.hand.some((c: any) => c.id === "rg"),
      "老流氓不受魅惑，仍活着"
    );
  });

  it("老流氓：第一次被杀只负伤（算存活），下回合结束才真正死亡", async () => {
    const { room, first, second, firstClient, secondClient } = await setup();
    setHand(room, first, [
      { id: "w1", name: "狼人", type: "wolf" },
      { id: "v1", name: "平民", type: "villager" },
      { id: "v2", name: "平民", type: "villager" },
    ]);
    setHand(room, second, [
      { id: "rg", name: "老流氓", type: "villager", skill: "oldRogue" },
      { id: "v3", name: "平民", type: "villager" },
      { id: "v4", name: "平民", type: "villager" },
    ]);

    // 第 1 夜：P1 刀老流氓 → 天亮只负伤
    firstClient.send("playCard", { id: "w1" });
    await wait();
    firstClient.send("chooseTarget", { index: 0 });
    await wait();
    firstClient.send("ready");
    await wait();
    secondClient.send("ready");
    await wait();

    const rg0 = room.state.players.get(second)!.hand.find((c: any) => c.id === "rg");
    assert.ok(rg0, "老流氓没死，仍在手牌里");
    assert.strictEqual(rg0.injured, true, "进入负伤状态");
    assert.strictEqual(room.state.phase, "day");
    assert.strictEqual(room.state.turnOwner, first, "P1 白天");

    // 下一个回合（P1 白天）结束 → 负伤到期，老流氓真正死亡
    firstClient.send("ready");
    await wait();
    assert.ok(graveIds(room).indexOf("rg") >= 0, "下回合结束时老流氓真正死亡");
    assert.ok(
      !room.state.players.get(second)!.hand.some((c: any) => c.id === "rg"),
      "已离开手牌"
    );
  });

  // ============================================================
  //  取消出牌：技能还没发动时，点行动区的牌可以撤回
  // ============================================================
  it("取消出牌：守卫打出后点行动区的牌 → 回手牌、本回合还能再发动", async () => {
    const { room, first, firstClient } = await setup();
    setHand(room, first, [
      { id: "gu", name: "守卫", type: "god", skill: "guard" },
      { id: "v1", name: "平民", type: "villager" },
    ]);

    firstClient.send("playCard", { id: "gu" });
    await wait();
    assert.strictEqual(room.state.players.get(first)!.play.length, 1, "守卫在行动区");
    assert.strictEqual(pending(room).type, "guardPick");

    firstClient.send("cancelPlay", { id: "gu" });
    await wait();
    assert.strictEqual(pending(room).type, "", "取消后不再等选目标");
    assert.strictEqual(room.state.players.get(first)!.play.length, 0, "行动区已清空");
    const gu = room.state.players.get(first)!.hand.find((c: any) => c.id === "gu");
    assert.ok(gu, "守卫回到手牌");
    assert.strictEqual(gu!.acted, false, "★ 取消不消耗本回合行动");

    // 还能重新发动
    firstClient.send("playCard", { id: "gu" });
    await wait();
    assert.strictEqual(pending(room).type, "guardPick", "取消后可以再来一次");
  });

  it("取消出牌：狼刀待选时取消 → 共用狼刀还回去，本回合还能再出刀", async () => {
    const { room, first, second, firstClient } = await setup();
    setHand(room, first, [{ id: "w1", name: "狼人", type: "wolf" }]);
    setHand(room, second, [
      { id: "a1", name: "平民", type: "villager" },
      { id: "a2", name: "平民", type: "villager" },
    ]);

    firstClient.send("playCard", { id: "w1" });
    await wait();
    assert.strictEqual(room.state.wolfKnifeUsed, true, "出刀即占用共用狼刀");
    assert.strictEqual(pending(room).type, "wolfKnife");

    firstClient.send("cancelPlay", { id: "w1" });
    await wait();
    assert.strictEqual(room.state.wolfKnifeUsed, false, "★ 取消 → 共用狼刀还回去");
    const w1 = room.state.players.get(first)!.hand.find((c: any) => c.id === "w1");
    assert.ok(w1, "狼人回到手牌");
    assert.strictEqual(w1!.acted, false);

    firstClient.send("playCard", { id: "w1" });
    await wait();
    assert.strictEqual(pending(room).type, "wolfKnife", "共用刀可以再用一次");
  });

  it("取消出牌：大野狼的「额外刀」取消后还回去，共用刀状态不受影响", async () => {
    const { room, first, second, firstClient } = await setup();
    setHand(room, first, [
      { id: "w1", name: "狼人", type: "wolf" },
      { id: "gw", name: "大野狼", type: "wolf", skill: "greatWolf" },
    ]);
    setHand(room, second, [
      { id: "a1", name: "平民", type: "villager" },
      { id: "a2", name: "平民", type: "villager" },
      { id: "a3", name: "平民", type: "villager" },
    ]);

    // 先用普通狼人把【共用刀】用掉
    firstClient.send("playCard", { id: "w1" });
    await wait();
    firstClient.send("chooseTarget", { index: 0 });
    await wait();
    assert.strictEqual(room.state.wolfKnifeUsed, true);

    // 大野狼再上 → 用的是它自己的额外刀
    firstClient.send("playCard", { id: "gw" });
    await wait();
    assert.strictEqual(pending(room).type, "wolfKnife", "大野狼的额外刀待选中");

    // 取消：额外刀要还回去，但共用刀（w1 用掉的）不能跟着还原
    firstClient.send("cancelPlay", { id: "gw" });
    await wait();
    assert.strictEqual(room.state.wolfKnifeUsed, true, "共用刀仍是已用状态（不是它用掉的）");
    const gw = room.state.players.get(first)!.hand.find((c: any) => c.id === "gw");
    assert.strictEqual(gw!.acted, false);

    firstClient.send("playCard", { id: "gw" });
    await wait();
    assert.strictEqual(pending(room).type, "wolfKnife", "★ 额外刀还回来了，可以再打");
  });
});

// ============================================================
//  前端消息契约 + 一轮完整回合顺序（冒烟）
//  验证前端 index.html 依赖的消息形状与回合顺序：
//  gameStart / turnStart / yourTurn / playRejected / actionRequired / cardReturned / gameOver
//  说明：client1 在 client2 加入前已挂监听，可稳定捕获"首轮广播"；
//  后续回合的 turnStart/yourTurn 两端都能可靠收到（见上文 yourTurn 测试）。
// ============================================================
describe("前端消息契约 + 一轮完整回合顺序（冒烟）", () => {
  beforeEach(async () => {
    await colyseus.cleanup();
  });

  /** 带消息收集器的开局：两个客户端在加入后（但初始广播前）挂监听 */
  async function setupWithMsgs() {
    const room = await colyseus.createRoom<MyState>("my_room", { turnDuration: 60000 });
    const msgs1: any[] = [];
    const msgs2: any[] = [];
    const firstClient = await colyseus.connectTo(room);
    firstClient.onMessage("gameStart", (m) => msgs1.push(["gameStart", m]));
    firstClient.onMessage("turnStart", (m) => msgs1.push(["turnStart", m]));
    firstClient.onMessage("yourTurn", (m) => msgs1.push(["yourTurn", m]));
    firstClient.onMessage("playRejected", (m) => msgs1.push(["playRejected", m]));
    const secondClient = await colyseus.connectTo(room);
    secondClient.onMessage("gameStart", (m) => msgs2.push(["gameStart", m]));
    secondClient.onMessage("turnStart", (m) => msgs2.push(["turnStart", m]));
    secondClient.onMessage("yourTurn", (m) => msgs2.push(["yourTurn", m]));
    secondClient.onMessage("playRejected", (m) => msgs2.push(["playRejected", m]));
    await wait();
    return {
      room,
      firstClient,
      secondClient,
      msgs1,
      msgs2,
      first: firstClient.sessionId,
      second: secondClient.sessionId,
    };
  }

  it("消息契约：gameStart / 首回合 turnStart / yourTurn 字段正确", async () => {
    const { msgs1, first } = await setupWithMsgs();
    // client1 在 client2 加入前已挂监听，可稳定捕获首轮广播
    assert.ok(msgs1.some((x) => x[0] === "gameStart"), "P1 应收到 gameStart");
    const ts0 = msgs1.find((x) => x[0] === "turnStart")[1];
    assert.strictEqual(ts0.owner, first, "首回合 turnStart.owner 应为先手 P1");
    assert.strictEqual(ts0.seq, 0);
    assert.strictEqual(ts0.phase, "night");
    assert.strictEqual(typeof ts0.duration, "number");
    assert.ok("firstPlayer" in ts0, "turnStart 应携带 firstPlayer");
    assert.ok("round" in ts0, "turnStart 应携带 round");
    const yt0 = msgs1.find((x) => x[0] === "yourTurn")[1];
    assert.strictEqual(yt0.phase, "night");
    assert.ok("deadline" in yt0, "yourTurn 应携带 deadline");
  });

  it("消息契约：后续 turnStart 广播到双方 + yourTurn 仅发给行动方", async () => {
    const { room, firstClient, msgs1, msgs2, second } = await setupWithMsgs();
    // P1 跳过黑夜 → 触发 seq=1 的 turnStart（两端此时都已挂监听，可靠收到）
    firstClient.send("ready");
    await wait();
    assert.strictEqual(room.state.turnOwner, second);

    const tsC1 = msgs1.find((x) => x[0] === "turnStart" && x[1].seq === 1);
    const tsC2 = msgs2.find((x) => x[0] === "turnStart" && x[1].seq === 1);
    assert.ok(tsC1, "P1 应收到 seq=1 的 turnStart");
    assert.ok(tsC2, "P2 应收到 seq=1 的 turnStart（广播到双方）");
    for (const ts of [tsC1[1], tsC2[1]]) {
      assert.strictEqual(ts.owner, second, "seq=1 归属应为 P2");
      assert.strictEqual(ts.phase, "night");
      assert.ok("duration" in ts && "firstPlayer" in ts && "round" in ts);
    }
    const ytC2 = msgs2.filter((x) => x[0] === "yourTurn").length;
    const ytC1 = msgs1.filter((x) => x[0] === "yourTurn").length;
    assert.ok(ytC2 >= 1, "seq=1 的 yourTurn 应发给 P2");
    assert.strictEqual(ytC1, 1, "P1 不应收到 seq=1 的 yourTurn（仅首轮的 1 次）");
  });

  it("一轮完整顺序：P1夜→P2夜→天亮→P1昼→P2昼（room.state 校验）", async () => {
    const { room, firstClient, secondClient, first, second } = await setupWithMsgs();

    assert.strictEqual(room.state.turnOwner, first, "开局轮到 P1 夜");
    assert.strictEqual(room.state.phase, "night");

    firstClient.send("ready");
    await wait();
    assert.strictEqual(room.state.turnOwner, second, "P1 跳过后轮到 P2 夜");
    assert.strictEqual(room.state.phase, "night");

    secondClient.send("ready");
    await wait();
    assert.strictEqual(room.state.turnOwner, first, "天亮后轮到 P1 白天");
    assert.strictEqual(room.state.phase, "day");

    firstClient.send("ready");
    await wait();
    assert.strictEqual(room.state.turnOwner, second, "P1 跳过后轮到 P2 白天");
    assert.strictEqual(room.state.phase, "day");

    secondClient.send("ready");
    await wait();
    assert.strictEqual(room.state.round, 2, "应进入第 2 轮");
    assert.strictEqual(room.state.turnOwner, first, "第 2 轮回到 P1 夜");
    assert.strictEqual(room.state.phase, "night");
  });

  it("补牌机制：白天结束时手牌 ≤2 的一方摸 1 张，>2 的一方不摸", async () => {
    const { room, firstClient, secondClient, first, second } = await setupWithMsgs();

    // first 手牌 2 张（≤ 阈值），second 手牌 4 张（> 阈值）
    setHand(room, first, [
      { id: "v1", name: "平民", type: "villager" },
      { id: "v2", name: "平民", type: "villager" },
    ]);
    setHand(room, second, [
      { id: "v3", name: "平民", type: "villager" },
      { id: "v4", name: "平民", type: "villager" },
      { id: "v5", name: "平民", type: "villager" },
      { id: "v6", name: "平民", type: "villager" },
    ]);
    const deckBefore = room.state.deck.length;
    assert.ok(deckBefore > 0, "牌库应有余牌");

    // P1夜 → P2夜 → 天亮 → P1昼 → P2昼 → 白天结束（白天结束时结算补牌）
    firstClient.send("ready");
    await wait();
    secondClient.send("ready");
    await wait();
    firstClient.send("ready");
    await wait();

    // 还在白天，尚未补牌
    assert.strictEqual(room.state.players.get(first).handCount, 2, "白天结束前不补牌");

    secondClient.send("ready"); // P2 白天结束 → 进入下一夜
    await wait();

    assert.strictEqual(room.state.round, 2, "应进入第 2 轮");
    assert.strictEqual(room.state.players.get(first).handCount, 3, "first 手牌 ≤2 → 补 1 张");
    assert.strictEqual(room.state.players.get(first).hand.length, 3, "新牌应真正进入手牌");
    assert.strictEqual(room.state.players.get(second).handCount, 4, "second 手牌 >2 → 不补牌");
    assert.strictEqual(room.state.deck.length, deckBefore - 1, "牌库应减少 1 张");
  });

  it("补牌机制：牌库为空时不补牌也不报错", async () => {
    const { room, firstClient, secondClient, first, second } = await setupWithMsgs();

    setHand(room, first, [
      { id: "v1", name: "平民", type: "villager" },
      { id: "v2", name: "平民", type: "villager" },
    ]);
    setHand(room, second, [
      { id: "v3", name: "平民", type: "villager" },
      { id: "v4", name: "平民", type: "villager" },
    ]);

    room.state.deck.clear(); // 牌库抽干
    assert.strictEqual(room.state.deck.length, 0);

    firstClient.send("ready");
    await wait();
    secondClient.send("ready");
    await wait();
    firstClient.send("ready");
    await wait();
    secondClient.send("ready");
    await wait();

    assert.strictEqual(room.state.round, 2, "仍能正常进入第 2 轮");
    assert.strictEqual(room.state.players.get(first).handCount, 2, "牌库空 → 不补牌");
    assert.strictEqual(room.state.players.get(second).handCount, 2, "牌库空 → 不补牌");
    assert.strictEqual(room.state.winner, "", "不应因补牌失败判负");
  });

  it("越权拒绝：非当前行动方跳过会被 playRejected", async () => {
    const { room, secondClient, first } = await setupWithMsgs();
    let rejected: string | null = null;
    secondClient.onMessage("playRejected", (m) => (rejected = m.reason));
    secondClient.send("ready");
    await wait();
    assert.ok(rejected && /还没轮到/.test(rejected), `非行动方应被拒，实际：${rejected}`);
    assert.strictEqual(room.state.turnOwner, first, "越权不应改变回合归属");
  });

  it("白天流放消息契约：满足条件发起 exile → 狼王连锁由狼王主人选目标", async () => {
    const { room, firstClient, secondClient, first, second } = await setupWithMsgs();

    setHand(room, first, [
      { id: "w1", name: "狼人", type: "wolf" },
      { id: "v1", name: "平民", type: "villager" },
      { id: "v2", name: "平民", type: "villager" },
      { id: "v3", name: "平民", type: "villager" },
      { id: "v4", name: "平民", type: "villager" },
      { id: "v5", name: "平民", type: "villager" },
    ]);
    setHand(room, second, [
      { id: "wk1", name: "狼王", type: "wolf", skill: "wolfKing" },
      { id: "v6", name: "平民", type: "villager" },
      { id: "v7", name: "平民", type: "villager" },
    ]);
    // 模拟 first 本夜真死 1 张：让 nightStartCount[first] 比当前手牌多 1
    (room as any).nightStartCount[first] = 7;

    firstClient.send("ready");
    await wait();
    secondClient.send("ready");
    await wait();
    assert.strictEqual(room.state.phase, "day");
    assert.strictEqual(room.state.turnOwner, first);
    assert.strictEqual(room.state.players.get(first).lostThisNight, true, "first 应判定为本夜死过牌");

    firstClient.send("exile");
    await wait();
    assert.strictEqual(room.state.pendingAction.type, "exile", "应进入流放选目标");
    assert.strictEqual(room.state.pendingAction.actor, first);

    const graveBefore = graveCount(room);

    firstClient.send("chooseTarget", { index: 0 });
    await wait();

    assert.strictEqual(room.state.pendingAction.type, "wolfKing", "狼王被流放应触发带人结算");
    assert.strictEqual(room.state.pendingAction.actor, second, "带人目标由狼王主人(second)选择");

    secondClient.send("chooseTarget", { index: 0 });
    await wait();

    assert.strictEqual(room.state.pendingAction.type, "", "结算后应清空 pending");
    assert.strictEqual(room.state.pendingAction.actor, "");
    assert.ok(graveCount(room) >= graveBefore + 2, "流放 + 带人应使墓地至少 +2");
  });

  it("狼刀杀害：被刀的手牌卡背显示「杀」字标记（天亮结算后清除）", async () => {
    const { room, first, second, firstClient, secondClient } = await setupWithMsgs();
    // 确定性发牌：P1 是狼，P2 有三张牌
    setHand(room, first, [{ id: "w1", name: "狼人", type: "wolf" }]);
    setHand(room, second, [
      { id: "v1", name: "平民", type: "villager" },
      { id: "v2", name: "平民", type: "villager" },
      { id: "v3", name: "平民", type: "villager" },
    ]);

    // P1 黑夜：出狼刀刀中 P2 的 v2（index 1）
    firstClient.send("playCard", { id: "w1" });
    await wait();
    assert.strictEqual(pending(room).type, "wolfKnife", "进入狼刀选目标");
    firstClient.send("chooseTarget", { index: 1 });
    await wait();

    const oppP = room.state.players.get(second);
    assert.ok(
      oppP.killedSlots.includes(1),
      "被刀的 v2（槽位 #1）写入 killedSlots（卡背显示「杀」字）"
    );
    assert.ok(oppP.hand.find((c: any) => c.id === "v2"), "被刀牌仍留在对方手牌（天亮才结算）");
    assert.strictEqual(oppP.hand.length, 3, "手牌数未变");

    // 推进天亮：P1 结束黑夜 → P2 结束黑夜 → 统一结算
    firstClient.send("ready");
    await wait();
    secondClient.send("ready");
    await wait();
    await wait(); // 等 100ms 定时器把 killedSlots 同步清空

    assert.strictEqual(room.state.phase, "day", "天亮");
    assert.ok(graveIds(room).includes("v2"), "v2 天亮后进入墓地");
    assert.strictEqual(
      room.state.players.get(second).killedSlots.length,
      0,
      "天亮结算后「杀」字标记自动清除"
    );
  });

});