import { Room, Client, CloseCode } from "colyseus";
import { StateView } from "@colyseus/schema";
import {
  MyState,
  PlayerState,
  Card,
  OpenCard,
  type Phase,
  type CardType,
  type PendingActionType,
  type PendingZone,
} from "./schema/MyState.js";
import { HAND_VIEW_TAG, LINK_VIEW_TAG, BEAUTY_VIEW_TAG, KILL_VIEW_TAG, POISON_VIEW_TAG, IDOL_VIEW_TAG } from "./schema/MyState.js";

/**
 * 死亡事件：一张牌进入「死亡结算队列」的载体。
 * 所有导致牌进墓地的行为都不直接结算，而是先构造成 DeathEvent 入队。
 */
type DeathEvent = {
  card: Card;       // 死亡的牌
  victimId: string; // 这张牌的持有者（用于技能归属、墓地展示、女巫判定）
  cause: string;    // 死因（日志用）：wolfKnife / hunter / wolfKing / witchPoison / exile / whiteWolfBlast
  silent?: boolean; // ★ 沉默死亡：不触发任何死亡技能（白狼王自爆专用）
  killerId?: string;       // 动手的牌 id（狼刀/毒药标记时记录，用于种狼击杀联动）
  killerOwnerId?: string;  // 动手的牌的主人的 sessionId
  killerSkill?: string;    // 动手的牌的 skill（如 breedWolf）
};

/** 默认每回合时限（毫秒）：当前行动方思考 / 选择目标的时间 */
const DEFAULT_TURN_DURATION = 30_000;

/**
 * 一回合的序列（严格顺序，一人一轮）：
 *   0 = P1 黑夜（先手）  1 = P2 黑夜
 *   2 = P1 白天         3 = P2 白天
 * 走完一轮（seq 3 → 0）后 round++，重新进入黑夜。
 */
const SEQ_LEN = 4;

export class MyRoom extends Room<{ state: MyState }> {
  maxClients = 2;
  state = new MyState();

  /** 每人开局发牌数量 */
  HAND_SIZE = 6;

  /**
   * ★ 每人手牌上限：达到 8 张后，不能再获得任何新牌。
   * 覆盖：初始发牌 / 从牌库摸牌 / 白天补牌 / 平静回合发牌 / 天使重生摸牌 /
   *      墓地复活（女巫解药 / 通灵师）/ 种狼培育。
   * 不覆盖：牌归位（打出的牌回手牌）、撤销选择放回原位、盗贼等量交换 ——
   *      这些不是"获得新牌"，手牌数不会净增长，加了反而会把原有的牌弄丢。
   */
  HAND_LIMIT = 8;

  /**
   * ★ 手牌补充机制
   * 每轮【白天结束时】（即将入夜），手牌数 ≤ DRAW_HAND_THRESHOLD 的玩家，
   * 各自从公共牌库补摸 DRAW_COUNT 张。双方独立判定，互不影响。
   */
  DRAW_HAND_THRESHOLD = 2;
  DRAW_COUNT = 1;

  /**
   * 白天投票流放所需的【票权】阈值。
   * 票权规则（替代旧的"≥3 张平民"）：
   * - 除长老外所有身份 = 1 票（平民 / 盗贼 / 狼人 / 神职 等）
   * - 长老 = 2 票
   */
  EXILE_VOTE_THRESHOLD = 3;

  /**
   * 死亡结算队列（服务端私有，不同步客户端）。
   *
   * 两个阶段：
   *   ①【黑夜·标记】狼刀/毒药 → markDeath() 入队，牌**仍留在手牌**，不进墓地、不结算
   *   ②【天亮·结算】进入白天前 flushDeaths() → 真正移出手牌 → 进墓地 → 触发技能链
   *
   * 技能链（猎人开枪 / 狼王带人）在结算中触发，需要玩家选目标时设置 pendingAction
   * 并【暂停队列】，选完继续——while 循环天然支持 A 死带 B、B 死带 C 级联。
   */
  private deathQueue: DeathEvent[] = [];

  /**
   * ★ 平静回合追踪：连续两个整轮（P1夜→P2夜→P1昼→P2昼）都没有任何"对方手牌被杀"，
   * 则在第三个整轮开始时双方各摸一张手牌（防止僵局）。
   * - killedHandCardThisRound：本整轮内是否发生过"手牌被杀"（在结算里真正移除手牌时置真）。
   * - peacefulStreak：连续平静（无人杀对方手牌）的整轮数；达到 2 即触发发牌并清零。
   */
  private killedHandCardThisRound = false;
  private peacefulStreak = 0;

  /** 每回合时限（毫秒），可通过 createRoom options.turnDuration 覆盖（测试用） */
  private turnDuration = DEFAULT_TURN_DURATION;

  /** 本回合倒计时器（兼作"选择目标"的超时兜底） */
  private timer: any = null;

  /** 是否正在结算死亡队列（结算中触发的技能为"立即生效"模式） */
  private resolving = false;

  /** P1（先手黑夜）/ P2（后手黑夜）的 sessionId，开局确定 */
  private firstPlayerId = "";
  private secondPlayerId = "";

  /** 本夜开始时各玩家的存活牌数（用于白天判定"本夜是否死过牌"） */
  private nightStartCount: Record<string, number> = {};

  /**
   * 本白天是否已经结算过"本夜死过牌"。
   * ★ 只在【天亮那一刻】算一次并冻结：白天流放杀掉的牌不算"本夜死的"，
   *   否则先出手非法流放的一方反倒能让对方也获得流放资格。
   */
  private dayLossComputed = false;
  /**
   * ★ 本夜真正【死过牌】的玩家（按 sessionId）。
   * 只要本夜有任何一张自己的牌走完死亡结算就记上 —— 包括【天使】：天使死亡触发重生、
   * 牌回到手里不进墓地，但"死过一次"这件事照样成立，照样构成流放的前提条件。
   * 每夜入夜时清空。
   */
  private diedThisNight = new Set<string>();

  /** 结算暂停后，接下来应该进入的回合序号（天亮：2 = P1 白天） */
  private pendingNextSeq = -1;

  /** 是否已开局 */
  private gameStarted = false;

  /**
   * 当前 pendingAction 对应的那张"已打出、待回收"的牌。
   * 规则：行动区是【临时离场执行任务】的区域——技能结算完毕，这张牌立刻回到手牌。
   * 只有出牌触发的 pending（如狼刀）才有值；死亡触发的技能（猎人/狼王/流放）为 ""。
   */
  private pendingCardId = "";

  /** 该牌打出前在手牌中的下标，用于回收时插回原位（避免手牌顺序被打乱） */
  private pendingCardIndex = -1;

  /** 使用女巫技能时记录那张女巫牌 id：玩家若在选目标阶段「跳过」，可把已消耗的药剂退还 */
  private pendingWitchCardId = "";
  /** 本次用药是否动用了奇迹商人的强化（跳过时退还的是强化层数，而不是药水瓶标记） */
  private pendingWitchBlessed = false;
  /** 奇迹商人强化女巫时，等待玩家二选一的女巫牌 id */
  private pendingWitchBlessId = "";

  /** 丘比特连接第一步选中的己方牌 id（第二步选完才生效） */
  private pendingLinkSelfId = "";
  /** 丘比特第一步选中的牌属于谁（"self" 己方 / "opp" 对方） */
  private pendingLinkFirstSide = "";
  /**
   * ★ 丘比特【生命链接】对（服务端私有，不再进公开 state）：
   * 任意一对中的一张死亡，另一张随之死亡（一死死俩），随后该对链接消失。
   * 被强化的丘比特可以建立多对链接。
   */
  private cardLinks: { a: string; b: string }[] = [];
  /** 发动过丘比特技能的玩家（唯一能看到「丘」标记的人） */
  private cupidLinkOwner = "";
  /** 正在行动区"亮明身份"展示中的天使牌 id（展示期间不该被回合切换清掉公开信息） */
  private angelShowcase = new Set<string>();
  /** 本夜被守卫的牌（按持有者分组）：这些牌免疫一次狼刀 */
  private guarded = new Map<string, string[]>();
  /** 本夜已经用过"额外那一刀"的大野狼牌 id（每夜重置） */
  private greatWolfExtraUsed = new Set<string>();
  /** 本次狼刀是否是大野狼用【共用刀】打的第一刀（结算完要放开它的第二刀） */
  private pendingGreatWolfShared = false;
  /** 本次待选的狼刀是否吃掉了【共用狼刀】（取消出牌时要还回去） */
  private pendingKnifeSharedConsumed = false;
  /** 本次待选的狼刀是否动用了大野狼的【额外刀】（取消出牌时要还回去） */
  private pendingKnifeExtraCardId = "";
  /**
   * 这些待结算状态下「技能还没真正发动」→ 允许点行动区的牌取消：
   * 牌还在行动区、没产生任何效果、也没从手牌区扣掉任何东西。
   */
  private readonly CANCELABLE_PENDING = new Set<string>([
    "thiefSwap",
    "seerCheck",
    "guardPick",
    "merchantBless",
    "wildChildIdol",
    "necromancer",
    "cupidLink1",
    "cupidLink2",
    "wolfKnife",
    "wolfBeautyChoice",
    "wolfBeautyCharm",
    "whiteWolfBlast",
    "knightDuel",
  ]);
  /** 上一夜被守卫的牌（按持有者分组）：守卫不能连续两晚守同一张 */
  private lastGuarded = new Map<string, string[]>();
  /** 野孩子牌 id 与它的榜样牌 id（榜样死亡 → 野孩子变狼） */
  private wildChildId = "";
  private idolId = "";
  /** 被强化的猎人正在连杀：还有余量时继续弹选择 */
  private pendingHunterExtra: Card | null = null;

  /**
   * 白天打出的那张牌的 id（服务端私有）。
   * 白天进行动区的牌是【公开】的（对方看得到身份），这张牌回手 / 死亡 / 换回合时清空。
   */
  private revealedCardId = "";

  // ==============================================================
  //  消息
  // ==============================================================
  messages = {
    /**
     * 出牌：本回合行动——打出一张狼人牌 → 进入行动区 → 狼刀标记对方一张牌。
     * 仅黑夜可出牌（且只能出狼人）；白天不能出牌，只能流放或跳过。
     * 出牌后立即结束本回合（轮到下家）。
     */
    playCard: (client: Client, message: { id: string }) => {
      if (!this.canAct(client)) return;

      const player = this.state.players.get(client.sessionId);
      if (!player) return;

      const index = player.hand.findIndex((card) => card.id === message.id);
      if (index === -1) {
        client.send("playRejected", { reason: "手牌中不存在这张牌" });
        return;
      }
      const card = player.hand[index];

      // ★ 已被狼刀/毒药锁定的牌【依然可以行动】：
      // 死亡标记只是"天亮才生效"，在此之前它仍是一张合法手牌，
      // 可以在自己主人的回合照常打出（它死之前还能做最后一件事）。
      // 但它不能再被选为目标：见 chooseTarget 里的 isMarked 校验，避免同一张牌被重复锁定。
      if (this.isMarked(card.id)) {
        console.log(`[playCard] ${card.name} 已被锁定（天亮才死亡），本回合仍可行动`);
      }

      // ★ 狼美人：本夜技能都发动过了（魅惑过 + 共用狼刀也被用掉）→ 这张牌锁死
      if (card.skill === "wolfBeauty" && !this.beautyHasAction(card)) {
        client.send("playRejected", { reason: "本夜狼美人的技能已用完" });
        return;
      }

      // ★ 一张牌每个回合只能行动一次（行动过的前端显示为灰色）
      if (card.acted) {
        client.send("playRejected", { reason: "这张牌本回合已经行动过了" });
        return;
      }

      // ★ 盗贼：夜里把它【打出到行动区】，再选对手一张手牌交换。
      //   选完：对手那张归你，盗贼归对手（技能抹除 → 白板平民）。
      if (card.skill === "thief" && !card.thiefUsed) {
        if (this.state.phase !== "night") {
          client.send("playRejected", { reason: "盗贼只能在夜里发动" });
          return;
        }
        const oppIdSwap = this.getOtherSessionId(client.sessionId);
        const oppSwap = oppIdSwap ? this.state.players.get(oppIdSwap) : undefined;
        if (!oppSwap || oppSwap.hand.length === 0) {
          client.send("playRejected", { reason: "对手没有手牌可以交换" });
          return;
        }

        // 出牌：手牌移除 → 进入自己的行动区（等待选择目标，还没有结束结算）
        this.pendingCardId = card.id;
        this.pendingCardIndex = index;
        player.hand.splice(index, 1);
        player.handCount = player.hand.length;
        card.owner = client.sessionId;
        card.acted = true;
        player.play.push(card);
        player.playCount = player.play.length;
        console.log(`[playCard] ${client.sessionId} 打出 ${card.name} → 行动区，等待选择交换目标`);

        this.setPendingAction(
          "thiefSwap",
          client.sessionId,
          "opponentHand",
          "🔀 选择对方一张手牌"
        );
        this.notifyActor(client.sessionId);
        return;
      }

      // ★ 白狼王【白天自爆】：带走对方一张手牌，同时自己死亡（双方都不触发死亡技能）
      if (card.skill === "whiteWolfKing" && this.state.phase === "day") {
        const oppId = this.getOtherSessionId(client.sessionId);
        const opp = oppId ? this.state.players.get(oppId) : undefined;
        if (!oppId || !opp || opp.hand.length === 0) {
          client.send("playRejected", { reason: "对方没有手牌可以带走" });
          return;
        }
        this.pendingCardId = card.id;
        this.pendingCardIndex = index;
        player.hand.splice(index, 1);
        player.handCount = player.hand.length;
        card.owner = client.sessionId;
        card.acted = true;
        player.play.push(card);
        player.playCount = player.play.length;
        this.revealPlayCard(player, card);
        this.setPendingAction(
          "whiteWolfBlast",
          client.sessionId,
          "opponentHand",
          "💥 选择对方一张手牌"
        );
        this.notifyActor(client.sessionId);
        return;
      }

      // ★ 骑士【白天决斗】：对方是狼人 → 狼死、骑士活；否则骑士自己死
      if (card.skill === "knight") {
        if (this.state.phase !== "day") {
          client.send("playRejected", { reason: "骑士只能在白天决斗" });
          return;
        }
        const oppId = this.getOtherSessionId(client.sessionId);
        const opp = oppId ? this.state.players.get(oppId) : undefined;
        if (!oppId || !opp || opp.hand.length === 0) {
          client.send("playRejected", { reason: "对方没有手牌可以决斗" });
          return;
        }
        this.pendingCardId = card.id;
        this.pendingCardIndex = index;
        player.hand.splice(index, 1);
        player.handCount = player.hand.length;
        card.owner = client.sessionId;
        card.acted = true;
        player.play.push(card);
        player.playCount = player.play.length;
        this.revealPlayCard(player, card);
        this.setPendingAction("knightDuel", client.sessionId, "opponentHand", "⚔️ 选择对方一张手牌");
        this.notifyActor(client.sessionId);
        return;
      }

      // ★ 丘比特【夜里连接】：先选自己一张手牌，再选对方一张手牌 → 一死死俩
      if (card.skill === "cupid") {
        if (this.state.phase !== "night") {
          client.send("playRejected", { reason: "丘比特只能在夜里连接" });
          return;
        }
        // ★ 丘比特整局只能连一次（被奇迹商人强化时，那一晚可再连一次）
        if (card.usedOnce && card.blessCharges <= 0) {
          client.send("playRejected", { reason: "丘比特的连接整局只能用一次" });
          return;
        }
        const oppId = this.getOtherSessionId(client.sessionId);
        const opp = oppId ? this.state.players.get(oppId) : undefined;
        // 己方 / 对方的手牌都能连：只要两边加起来还有 2 张可选即可
        const available = player.hand.length - 1 + (opp ? opp.hand.length : 0);
        if (available < 2) {
          client.send("playRejected", { reason: "没有足够的手牌可以连接" });
          return;
        }
        this.pendingCardId = card.id;
        this.pendingCardIndex = index;
        player.hand.splice(index, 1);
        player.handCount = player.hand.length;
        card.owner = client.sessionId;
        card.acted = true;
        player.play.push(card);
        player.playCount = player.play.length;
        this.setPendingAction("cupidLink1", client.sessionId, "anyHand", "💘 选择第一张手牌");
        this.notifyActor(client.sessionId);
        return;
      }

      // ★ 通灵师【夜里通灵】：把自己送进墓地，换回自己墓地的一张牌（技能重置）
      if (card.skill === "necromancer") {
        if (this.state.phase !== "night") {
          client.send("playRejected", { reason: "通灵师只能在夜里通灵" });
          return;
        }
        const self = this.state.players.get(client.sessionId)!;
        if (self.graveyard.length === 0) {
          client.send("playRejected", { reason: "你的墓地没有牌可以通灵" });
          return;
        }
        this.pendingCardId = card.id;
        this.pendingCardIndex = index;
        player.hand.splice(index, 1);
        player.handCount = player.hand.length;
        card.owner = client.sessionId;
        card.acted = true;
        player.play.push(card);
        player.playCount = player.play.length;
        this.setPendingAction("necromancer", client.sessionId, "graveyard", "🕯️ 选择自己墓地一张牌");
        this.notifyActor(client.sessionId);
        return;
      }

      // ★ 守卫【夜里守护】：选己方一张手牌，本夜免疫一次狼刀（不能连续两晚守同一张）
      if (card.skill === "guard") {
        if (this.state.phase !== "night") {
          client.send("playRejected", { reason: "守卫只能在夜里守护" });
          return;
        }
        if (player.hand.length < 2) {
          client.send("playRejected", { reason: "没有其它手牌可以守护" });
          return;
        }
        this.pendingCardId = card.id;
        this.pendingCardIndex = index;
        player.hand.splice(index, 1);
        player.handCount = player.hand.length;
        card.owner = client.sessionId;
        card.acted = true;
        player.play.push(card);
        player.playCount = player.play.length;
        this.setPendingAction("guardPick", client.sessionId, "hand", "🛡️ 选择自己一张手牌");
        this.notifyActor(client.sessionId);
        return;
      }

      // ★ 奇迹商人【夜里强化】：整局一次，给己方一名神职一次强化
      if (card.skill === "miracleMerchant") {
        if (this.state.phase !== "night") {
          client.send("playRejected", { reason: "奇迹商人只能在夜里交易" });
          return;
        }
        if (card.usedOnce) {
          client.send("playRejected", { reason: "奇迹商人整局只能交易一次" });
          return;
        }
        if (!player.hand.some((c, i) => i !== index && c.type === "god")) {
          client.send("playRejected", { reason: "手上没有神职可以强化" });
          return;
        }
        this.pendingCardId = card.id;
        this.pendingCardIndex = index;
        player.hand.splice(index, 1);
        player.handCount = player.hand.length;
        card.owner = client.sessionId;
        card.acted = true;
        player.play.push(card);
        player.playCount = player.play.length;
        this.setPendingAction("merchantBless", client.sessionId, "hand", "✨ 选择自己一张神职牌");
        this.notifyActor(client.sessionId);
        return;
      }

      // ★ 野孩子【夜里指定榜样】：榜样死后，野孩子变狼人
      //   ★ 已经变狼的野孩子不再是"选榜样"这张牌：它此刻就是狼，
      //     直接走下面的狼刀分支（独自杀人，哪怕手上没有任何别的狼牌）
      if (card.skill === "wildChild" && !card.turnedWolf) {
        if (this.state.phase !== "night") {
          client.send("playRejected", { reason: "野孩子只能在夜里指定榜样" });
          return;
        }
        if (card.usedOnce) {
          client.send("playRejected", { reason: "榜样已经指定过了" });
          return;
        }
        this.pendingCardId = card.id;
        this.pendingCardIndex = index;
        player.hand.splice(index, 1);
        player.handCount = player.hand.length;
        card.owner = client.sessionId;
        card.acted = true;
        player.play.push(card);
        player.playCount = player.play.length;
        this.setPendingAction("wildChildIdol", client.sessionId, "anyHand", "🎯 选择一张牌作为榜样");
        this.notifyActor(client.sessionId);
        return;
      }

      // ★ 预言家【夜里查验】：看对方一张手牌的身份，看完立刻回手牌原位
      if (card.skill === "seer") {
        if (this.state.phase !== "night") {
          client.send("playRejected", { reason: "预言家只能在夜里查验" });
          return;
        }
        const oppId = this.getOtherSessionId(client.sessionId);
        const opp = oppId ? this.state.players.get(oppId) : undefined;
        if (!oppId || !opp || opp.hand.length === 0) {
          client.send("playRejected", { reason: "对方没有手牌可以查验" });
          return;
        }
        this.pendingCardId = card.id;
        this.pendingCardIndex = index;
        player.hand.splice(index, 1);
        player.handCount = player.hand.length;
        card.owner = client.sessionId;
        card.acted = true;
        player.play.push(card);
        player.playCount = player.play.length;
        this.setPendingAction("seerCheck", client.sessionId, "opponentHand", "🔍 选择对方一张手牌");
        this.notifyActor(client.sessionId);
        return;
      }

      // ★ 狼美人【双技能】：进行动区后先二选一 —— 狼刀（杀人）或 魅惑一张手牌
      if (card.skill === "wolfBeauty") {
        if (this.state.phase !== "night") {
          client.send("playRejected", { reason: "狼美人只能在夜里行动" });
          return;
        }
        // 一夜只有一次行动：魅惑已用过、共用刀也已用掉 → 这张牌本回合彻底不可用
        this.pendingCardId = card.id;
        this.pendingCardIndex = index;
        player.hand.splice(index, 1);
        player.handCount = player.hand.length;
        card.owner = client.sessionId;
        card.acted = true;
        player.play.push(card);
        player.playCount = player.play.length;
        this.setPendingAction("wolfBeautyChoice", client.sessionId, "", "🐺 狼美人");
        this.notifyActor(client.sessionId);
        return;
      }

      // 仅黑夜可出牌，且只能出狼人
      if (this.state.phase !== "night") {
        client.send("playRejected", { reason: "白天不能出牌，只能流放或跳过" });
        return;
      }
      // ★ 变狼的野孩子也是真正的狼：夜里照样可以独自出刀（用的是狼人共用刀）
      if (!this.isWolfSide(card)) {
        client.send("playRejected", { reason: "黑夜只能打出狼人牌" });
        return;
      }

      // ★ 狼刀共享：本夜狼人 / 狼王【共用一把刀】。
      // 一旦任意一张狼牌发动过刀杀，本夜其它狼牌都不可再行动。
      // ★ 大野狼：一晚两刀。第一刀默认算【共用刀】（会占用共用刀）；
      //   共用刀已被别人用过时，它这一刀动用自己的额外刀（每夜一次）。
      const isGreatWolf = card.skill === "greatWolf";
      this.pendingGreatWolfShared = false;
      this.pendingKnifeSharedConsumed = false;
      this.pendingKnifeExtraCardId = "";
      if (isGreatWolf && this.state.wolfKnifeUsed) {
        if (this.greatWolfExtraUsed.has(card.id)) {
          client.send("playRejected", { reason: "大野狼的额外刀本夜已用过" });
          return;
        }
        this.greatWolfExtraUsed.add(card.id); // 动用额外刀
        this.pendingKnifeExtraCardId = card.id;
      } else if (this.state.wolfKnifeUsed) {
        client.send("playRejected", { reason: "本夜狼刀已用过（狼人与狼王共享一把刀）" });
        return;
      } else {
        // 共用刀还空着：谁先动都消耗它（大野狼的第一刀同样算共用刀）
        this.state.wolfKnifeUsed = true;
        this.pendingKnifeSharedConsumed = true;
        if (isGreatWolf) this.pendingGreatWolfShared = true;
      }

      // 出牌：手牌移除 → 进入【自己的行动区】（私有，对方看不到具体牌；不算失去生命）
      // ★ 行动区是"临时离场"，不是永久存放——本次行动结算完，牌会回到手牌
      this.pendingCardId = card.id;
      this.pendingCardIndex = index;
      player.hand.splice(index, 1);
      player.handCount = player.hand.length;
      card.owner = client.sessionId;
      card.acted = true; // ★ 本回合已行动（前端显示为灰色）
      player.play.push(card);
      player.playCount = player.play.length;
      console.log(
        `[playCard] ${client.sessionId} 打出 ${card.name}` +
          `(${card.type}${card.skill ? "/" + card.skill : ""}) → 自己的行动区`
      );

      // 狼刀：由出狼方选择对方一张牌【标记为死亡】，天亮才真正死亡
      const victimId = this.getOtherSessionId(client.sessionId);
      const victim = victimId ? this.state.players.get(victimId) : undefined;
      const killable = victimId ? this.countKillable(victimId) : 0;

      if (victim && killable > 0) {
        this.setPendingAction(
          "wolfKnife",
          client.sessionId,
          "opponentHand",
          "🐺 狼刀！选择对方一张手牌"
        );
        this.notifyActor(client.sessionId);
        console.log(`[wolfKnife] ${client.sessionId} 出狼，等待选择对方手牌`);
        return; // 等待选择；选完回收狼牌，但【不会自动结束回合】
      }
      console.log(`[wolfKnife] ${client.sessionId} 出狼，但对方无牌可刀，刀无效`);

      // 无目标可刀 → 牌照样回收；★ 回合继续，玩家还能用其它手牌行动或主动结束回合
      this.returnCardToHand(client.sessionId, card.id, index);
      this.resumeTurn();
    },

    /**
     * 女巫技能：夜间主动使用，分两步——先选模式（解药/毒药），再选目标
     * 客户端发送格式：room.send("useSkill", { cardId: "witch-1", mode: "revive" | "poison" })
     *   revive = 解药（从自己墓地复活一张牌回手牌）；poison = 毒药（标记对方一张牌）
     * 注意：女巫牌不消耗，仍留在手牌中；使用技能即消耗本回合行动。
     */
    useSkill: (client: Client, message: { cardId: string; mode: "revive" | "poison" }) => {
      if (!this.canAct(client)) return;

      if (this.state.phase !== "night") {
        client.send("playRejected", { reason: "女巫只能在夜间用药" });
        return;
      }

      const player = this.state.players.get(client.sessionId);
      if (!player) return;

      const card = player.hand.find((c) => c.id === message.cardId);
      // ★ 女巫学徒与女巫技能完全相同（同样一瓶解药 + 一瓶毒药）
      if (!card || (card.skill !== "witch" && card.skill !== "witchApprentice")) {
        client.send("playRejected", { reason: "只有女巫 / 女巫学徒可以使用技能" });
        return;
      }
      // 同理：被锁定的女巫在天亮前也仍能用药（死亡只是"尚未结算"）
      if (this.isMarked(card.id)) {
        console.log(`[useSkill] ${card.name} 已被锁定（天亮才死亡），本回合仍可行动`);
      }

      // ★ 每瓶药终身限用一次（优先于"本回合行动过"提示，因为原因更明确）
      //   被奇迹商人强化过的女巫多一瓶"任意药"：哪瓶用完就用它补哪瓶
      const reviveByBless =
        card.witchReviveUsed && card.blessCharges > 0 && card.blessPotion === "revive";
      const poisonByBless =
        card.witchPoisonUsed && card.blessCharges > 0 && card.blessPotion === "poison";
      if (message.mode === "revive" && card.witchReviveUsed && !reviveByBless) {
        client.send("playRejected", { reason: "这张女巫牌的解药已经用过了" });
        return;
      }
      if (message.mode === "poison" && card.witchPoisonUsed && !poisonByBless) {
        client.send("playRejected", { reason: "这张女巫牌的毒药已经用过了" });
        return;
      }

      // ★ 一张牌每个回合只能行动一次
      if (card.acted) {
        client.send("playRejected", { reason: "这张牌本回合已经行动过了" });
        return;
      }

      if (message.mode === "revive") {
        // 解药：从【自己的墓地】复活一张牌回到手牌
        if (player.graveyard.length === 0) {
          client.send("playRejected", { reason: "你的墓地没有牌可以复活" });
          return;
        }
        card.acted = true; // 用药即消耗这张牌本回合的行动
        // 原本的解药已用完 → 动用强化补这一瓶；否则照常消耗解药
        if (reviveByBless) card.blessCharges--;
        else card.witchReviveUsed = true;
        this.pendingWitchBlessed = reviveByBless;
        this.pendingWitchCardId = card.id; // 若后续"跳过"，可把这瓶药还回去
        this.setPendingAction(
          "witchRevive",
          client.sessionId,
          "graveyard",
          "💊 选择自己墓地一张牌"
        );
        this.notifyActor(client.sessionId);
      } else {
        // 毒药：标记对方一张牌（天亮才死）
        const oppId = this.getOtherSessionId(client.sessionId);
        const killable = oppId ? this.countKillable(oppId) : 0;
        if (!oppId || killable === 0) {
          client.send("playRejected", { reason: "对方没有可被毒杀的牌" });
          return;
        }
        card.acted = true; // 用药即消耗这张牌本回合的行动
        if (poisonByBless) card.blessCharges--;
        else card.witchPoisonUsed = true;
        this.pendingWitchBlessed = poisonByBless;
        this.pendingWitchCardId = card.id;
        this.setPendingAction(
          "witchPoison",
          client.sessionId,
          "opponentHand",
          "☠️ 选择对方一张手牌"
        );
        this.notifyActor(client.sessionId);
      }

      console.log(`[useSkill] ${client.sessionId} 使用女巫技能（${message.mode}），等待选择目标`);
    },

    /**
     * 奇迹商人强化女巫：当场二选一，决定多补哪一瓶。
     * 客户端发送格式：room.send("blessPotion", { mode: "revive" | "poison" })
     */
    blessPotion: (client: Client, message: { mode: "revive" | "poison" }) => {
      const pa = this.state.pendingAction;
      if (pa.type !== "witchBless" || pa.actor !== client.sessionId) return;
      const player = this.state.players.get(client.sessionId);
      if (!player) return;
      const witchId = this.pendingWitchBlessId;
      this.pendingWitchBlessId = "";
      const target = player.hand.find((c) => c.id === witchId);
      if (!target) {
        this.clearPendingAction();
        this.resumeTurn();
        return;
      }
      const mode = message.mode === "poison" ? "poison" : "revive";
      target.blessPotion = mode;
      target.blessCharges = 1;
      console.log(`[merchant] ${client.sessionId} 女巫强化：多一瓶${mode === "revive" ? "解药" : "毒药"}`);
      this.finishBless(client, mode === "revive" ? "多一瓶解药" : "多一瓶毒药", target.name);
    },

    /**
     * 狼美人双技能：杀人（共用狼刀）或 魅惑一张手牌。
     * 客户端发送格式：room.send("beautyAction", { mode: "kill" | "charm" | "cancel" })
     */
    beautyAction: (client: Client, message: { mode: "kill" | "charm" | "cancel" }) => {
      const pa = this.state.pendingAction;
      if (pa.type !== "wolfBeautyChoice" || pa.actor !== client.sessionId) return;
      const oppId = this.getOtherSessionId(client.sessionId);
      const opp = oppId ? this.state.players.get(oppId) : undefined;
      const player = this.state.players.get(client.sessionId);
      if (!player) return;

      // 取消：狼美人收回手牌，本回合没消耗行动
      if (message.mode === "cancel") {
        this.clearPendingAction();
        const { id: playedId, index: playedIndex } = this.takePendingCard();
        if (playedId) {
          this.returnCardToHand(client.sessionId, playedId, playedIndex);
          const back = player.hand.find((c) => c.id === playedId);
          if (back) back.acted = false;
        }
        this.resumeTurn();
        return;
      }

      if (message.mode === "kill") {
        if (this.state.wolfKnifeUsed) {
          client.send("playRejected", { reason: "本夜狼刀已用过（狼人共用一把刀）" });
          return;
        }
        if (!oppId || !opp || this.countKillable(oppId) <= 0) {
          client.send("playRejected", { reason: "对方没有可杀的牌" });
          return;
        }
        this.state.wolfKnifeUsed = true; // 她的刀同样是那把共用刀
        this.pendingKnifeSharedConsumed = true; // 取消时要把这把刀还回去
        this.pendingKnifeExtraCardId = "";
        this.setPendingAction("wolfKnife", client.sessionId, "opponentHand", "🐺 狼刀！选择对方一张手牌");
        this.notifyActor(client.sessionId);
        return;
      }

      // 魅惑：选对方一张手牌（她死亡时随之倒下），不消耗共用狼刀
      const beautyCard = this.pendingCardId
        ? player.play.find((c) => c.id === this.pendingCardId)
        : undefined;
      if (beautyCard && beautyCard.charmUsedTonight) {
        client.send("playRejected", { reason: "本夜已经魅惑过了" });
        return;
      }
      if (!oppId || !opp || opp.hand.length === 0) {
        client.send("playRejected", { reason: "对方没有手牌可以魅惑" });
        return;
      }
      this.setPendingAction(
        "wolfBeautyCharm",
        client.sessionId,
        "opponentHand",
        "💋 选择对方一张手牌魅惑"
      );
      this.notifyActor(client.sessionId);
    },

    /**
     * ★ 取消本次技能发动：点击【行动区】里自己刚打出的那张牌。
     * 只有在"还没选目标、技能还没产生任何效果"时才能取消 —— 牌原样回手牌、本回合还能再用。
     * 客户端发送格式：room.send("cancelPlay", { id: "card-id" })
     */
    cancelPlay: (client: Client, message: { id: string }) => {
      const pa = this.state.pendingAction;
      if (pa.type === "" || pa.actor !== client.sessionId) return;
      const player = this.state.players.get(client.sessionId);
      if (!player) return;

      const card = player.play.find((c) => c.id === message.id);
      if (!card || card.id !== this.pendingCardId) {
        client.send("playRejected", { reason: "这张牌已经结算完，无法取消" });
        return;
      }
      if (!this.CANCELABLE_PENDING.has(pa.type)) {
        client.send("playRejected", { reason: "这个技能已经生效，无法取消" });
        return;
      }

      // 先把狼刀的消耗还回去（共用刀 / 大野狼额外刀），再算牌的可行动状态
      const sharedConsumed = this.pendingKnifeSharedConsumed;
      const extraCardId = this.pendingKnifeExtraCardId;
      this.pendingKnifeSharedConsumed = false;
      this.pendingKnifeExtraCardId = "";
      this.pendingGreatWolfShared = false;
      if (sharedConsumed) this.state.wolfKnifeUsed = false;
      if (extraCardId) this.greatWolfExtraUsed.delete(extraCardId);

      this.clearPendingAction();
      // 丘比特：第一步选中的那张牌一并作废，重新从"选第一张"开始
      this.pendingLinkSelfId = "";
      this.pendingLinkFirstSide = "";

      const { id: playedId, index: playedIndex } = this.takePendingCard();
      if (playedId) this.returnCardToHand(client.sessionId, playedId, playedIndex);
      const back = playedId ? player.hand.find((c) => c.id === playedId) : undefined;
      if (back) back.acted = false;
      this.refreshBeautyActed(); // 刀还回去了 → 狼美人可能又能出刀
      console.log(`[cancel] ${client.sessionId} 取消了「${card.name}」的技能发动`);
      this.resumeTurn();
    },

    /**
     * 白天·流放：满足"本夜死过牌 + 手牌≥3平民"时，选择对方一张手牌直接送进墓地。
     * 客户端发送格式：room.send("exile")
     */
    exile: (client: Client) => {
      if (!this.canAct(client)) return;
      if (this.state.phase !== "day") {
        client.send("playRejected", { reason: "流放只能在白天进行" });
        return;
      }
      if (!this.isExileEligible(client.sessionId)) {
        client.send("playRejected", { reason: `不满足条件：需本夜死过牌且手牌票权≥${this.EXILE_VOTE_THRESHOLD}（长老 2 票）` });
        return;
      }
      this.setPendingAction(
        "exile",
        client.sessionId,
        "opponentHand",
        "⚖️ 选择对方一张手牌"
      );
      this.notifyActor(client.sessionId);
      console.log(`[exile] ${client.sessionId} 满足条件，等待选择流放目标`);
    },

    /**
     * 选择目标：响应 pendingAction。
     * 客户端发送格式：room.send("chooseTarget", { index: 0 })
     * - index: 目标在对应区域数组中的下标（对方手牌看不到内容，只能按位置选）
     * - index: -1 表示跳过该技能
     * - side:  zone === "anyHand" 时指明选的是哪一边（"self" 己方 / "opp" 对方）
     */
    chooseTarget: (client: Client, message: { index: number; side?: string }) => {
      const pa = this.state.pendingAction;
      if (pa.type === "") return;
      if (pa.actor !== client.sessionId) {
        console.log("[chooseTarget] 拒绝：现在不是你的行动");
        return;
      }

      const index = typeof message.index === "number" ? message.index : -1;
      const side = message.side === "opp" ? "opp" : "self";

      // 跳过技能（如狼可以不刀人、猎人可以不开枪、流放可以放弃）
      if (index === -1) {
        console.log(`[chooseTarget] ${client.sessionId} 跳过技能（${pa.type}）`);
        // ★ 女巫：既然最后选择放弃，这瓶药就没真正用掉 → 退还（下次还能用）
        this.refundWitchPotion(client.sessionId, pa.type);
        this.pendingLinkSelfId = "";
        this.pendingLinkFirstSide = "";
        this.pendingHunterExtra = null;
        this.pendingGreatWolfShared = false;
        const { id: playedId, index: playedIndex } = this.takePendingCard();
        this.clearPendingAction();
        // 技能作废 → 打出的牌照样回收（它没完成任务，但也不该被扣在外面）
        if (playedId) this.returnCardToHand(client.sessionId, playedId, playedIndex);
        this.afterSelection(client.sessionId);
        return;
      }

      switch (pa.type) {
        // 奇迹商人：给己方一名神职一次强化（整局一次）
        case "merchantBless": {
          const player = this.state.players.get(client.sessionId)!;
          if (index < 0 || index >= player.hand.length) {
            client.send("playRejected", { reason: "选择的目标不存在" });
            return;
          }
          const target = player.hand[index];
          if (target.type !== "god") {
            client.send("playRejected", { reason: "只能强化神职牌" });
            return;
          }
          // ★ 强化女巫：当场让玩家二选一（多一瓶解药 / 多一瓶毒药），选完才结算
          if (target.skill === "witch") {
            this.pendingWitchBlessId = target.id;
            this.setPendingAction(
              "witchBless",
              client.sessionId,
              "",
              "✨ 多补一瓶：解药 还是 毒药？"
            );
            this.notifyActor(client.sessionId);
            return;
          }
          this.finishBless(client, this.applyBless(target), target.name);
          break;
        }

        // 守卫：守护己方一张手牌，本夜免疫一次狼刀
        case "guardPick": {
          const player = this.state.players.get(client.sessionId)!;
          if (index < 0 || index >= player.hand.length) {
            client.send("playRejected", { reason: "选择的目标不存在" });
            return;
          }
          const target = player.hand[index];
          const last = this.lastGuarded.get(client.sessionId) || [];
          if (last.indexOf(target.id) >= 0) {
            client.send("playRejected", { reason: "不能连续两晚守护同一张牌" });
            return;
          }
          const cur = this.guarded.get(client.sessionId) || [];
          if (cur.indexOf(target.id) >= 0) {
            client.send("playRejected", { reason: "这张牌本夜已经被守护了" });
            return;
          }
          this.guarded.set(client.sessionId, [...cur, target.id]);

          this.clearPendingAction();
          const { id: playedId, index: playedIndex } = this.takePendingCard();
          if (playedId) {
            this.returnCardToHand(client.sessionId, playedId, playedIndex);
            const back = player.hand.find((c) => c.id === playedId);
            // ★ 被强化的守卫：本夜还能再守一张
            if (back && back.blessCharges > 0) {
              back.blessCharges--;
              back.acted = false;
              this.hint(client.sessionId, "🛡️ 强化生效：本夜你还可以再守一张");
            }
          }
          this.hint(client.sessionId, `🛡️ 守卫：本夜守护了「${target.name}」`);
          this.resumeTurn();
          break;
        }

        // 野孩子：指定榜样（任意一方的手牌），榜样死后野孩子变狼
        case "wildChildIdol": {
          const idol = this.pickFromAnyHand(client.sessionId, side, index);
          if (!idol) {
            client.send("playRejected", { reason: "选择的目标不存在" });
            return;
          }
          this.clearPendingAction();
          const { id: playedId, index: playedIndex } = this.takePendingCard();
          const player = this.state.players.get(client.sessionId)!;
          if (playedId) {
            this.returnCardToHand(client.sessionId, playedId, playedIndex);
            const back = player.hand.find((c) => c.id === playedId);
            if (back) back.usedOnce = true; // ★ 榜样整局只能指定一次
          }
          this.wildChildId = playedId;
          this.idolId = idol.id;
          // ★ 榜样卡背要打上「榜」字，但只有【野孩子使用者】看得到：
          //   给野孩子客户端授权【双方】的 IDOL_VIEW_TAG（榜样可能在本方也可能在对方手上）。
          const idolOwnerId = side === "self" ? client.sessionId : this.getOtherSessionId(client.sessionId);
          const idolOwner = idolOwnerId ? this.state.players.get(idolOwnerId) : undefined;
          if (idolOwner) client.view.add(idolOwner, IDOL_VIEW_TAG);
          const otherId = this.getOtherSessionId(client.sessionId);
          const otherPlayer = otherId ? this.state.players.get(otherId) : undefined;
          if (otherPlayer && otherPlayer !== idolOwner) client.view.add(otherPlayer, IDOL_VIEW_TAG);
          this.hint(
            client.sessionId,
            `🎯 你把${side === "self" ? "自己的一张牌" : "对方的一张牌"}定为了榜样`
          );
          this.resumeTurn();
          break;
        }

        // 丘比特第一步：己方 / 对方手牌都能选（牌还在行动区，接着选第二张）
        case "cupidLink1": {
          const picked = this.pickFromAnyHand(client.sessionId, side, index);
          if (!picked) {
            client.send("playRejected", { reason: "选择的目标不存在" });
            return;
          }
          this.pendingLinkSelfId = picked.id;
          this.pendingLinkFirstSide = side;
          this.setPendingAction("cupidLink2", client.sessionId, "anyHand", "💘 选择第二张手牌");
          break;
        }

        // 丘比特第二步：再选一张（同样两边都能选，但不能重复选同一张）→ 建立生命链接
        case "cupidLink2": {
          const second = this.pickFromAnyHand(client.sessionId, side, index);
          if (!second) {
            client.send("playRejected", { reason: "选择的目标不存在" });
            return;
          }
          if (second.id === this.pendingLinkSelfId) {
            client.send("playRejected", { reason: "不能连接同一张牌" });
            return;
          }
          const firstSide = this.pendingLinkFirstSide;
          const first = this.pickFromAnyHand(client.sessionId, firstSide, -1, this.pendingLinkSelfId);
          if (!first) {
            client.send("playRejected", { reason: "你选的那张牌已经不在手上了" });
            return;
          }
          // ★ 建立生命链接（服务端私有）：强化的丘比特可以连出多对
          this.cardLinks.push({ a: first.id, b: second.id });
          // ★ 只有发动方能看到「丘」标记：给它的客户端授权 LINK_VIEW_TAG（双方的手牌镜像都授权）
          if (!this.cupidLinkOwner) {
            this.cupidLinkOwner = client.sessionId;
            const ownerClient = this.clients.find((c) => c.sessionId === client.sessionId);
            if (ownerClient) {
              this.state.players.forEach((p) => ownerClient.view.add(p, LINK_VIEW_TAG));
            }
          }
          this.syncLinkedSlots();
          this.pendingLinkSelfId = "";
          this.pendingLinkFirstSide = "";
          this.clearPendingAction();
          const { id: playedId, index: playedIndex } = this.takePendingCard();
          if (playedId) this.returnCardToHand(client.sessionId, playedId, playedIndex);
          // ★ 被强化的丘比特：消耗一次强化层数；若强化前连过（技能重置情形），
          // 这一对就是"重置后"的连接，旧的链接依旧生效，连完即锁定。
          const cupidCard = this.state.players
            .get(client.sessionId)!
            .hand.find((c) => c.id === playedId);
          if (cupidCard) {
            if (cupidCard.blessCharges > 0) {
              cupidCard.blessCharges--;
              cupidCard.acted = false;
              if (!cupidCard.usedOnce) {
                this.hint(client.sessionId, "💘 强化生效：本夜你还能再连一次");
              } else {
                this.hint(client.sessionId, "💘 技能重置完成：本次连接已建立，旧链接依旧生效");
              }
            } else {
              cupidCard.usedOnce = true; // ★ 连接整局只有一次
            }
          }
          console.log(`[cupid] ${client.sessionId} 连接 ${first.id}（${firstSide}）与 ${second.id}（${side}）`);
          const mine = (s: string) => s === "self";
          this.hint(
            client.sessionId,
            `💘 丘比特：连接了${mine(firstSide) ? "「" + first.name + "」" : "对方一张手牌"}` +
              `与${mine(side) ? "「" + second.name + "」" : "对方一张手牌"}（一死死俩）`
          );
          const oppId = this.getOtherSessionId(client.sessionId);
          if (oppId && (!mine(firstSide) || !mine(side))) {
            this.hint(oppId, `💘 对方丘比特连接了你的一张手牌（一死死俩）`);
          }
          this.resumeTurn();
          break;
        }

        // 通灵师：墓地的牌回手牌（技能重置），通灵师自己进墓地
        case "necromancer": {
          const player = this.state.players.get(client.sessionId)!;
          if (index < 0 || index >= player.graveyard.length) {
            client.send("playRejected", { reason: "选择的墓地牌不存在" });
            return;
          }
          // ★ 手牌上限：满 8 张时不能获得新牌（牌留在墓地，不丢牌）
          if (this.canGainCard(client.sessionId)) {
            const [revived] = player.graveyard.splice(index, 1);
            revived.owner = client.sessionId;
            // ★ 技能重置：用过的药 / 已行动的标记全部清空（白板牌无法复原技能本身）
            revived.acted = false;
            revived.thiefUsed = false;
            revived.witchReviveUsed = false;
            revived.witchPoisonUsed = false;
            revived.foolRevealed = false;
            player.hand.push(revived);
            player.handCount = player.hand.length;
            console.log(`[necro] ${client.sessionId} 通灵：${revived.name} 回到手牌（技能已重置）`);
            this.hint(client.sessionId, `🕯️ 通灵：「${revived.name}」回到你的手牌，技能已重置`);
          } else {
            console.log(`[handLimit] ${client.sessionId} 手牌已满，通灵未获得新牌（牌留墓地）`);
            this.hint(client.sessionId, `🕯️ 手牌已达上限 ${this.HAND_LIMIT} 张`);
          }

          // ★ 被强化的通灵师：这一次可以换回【两张】——自己先不倒下，接着再选一张
          const blessedSelf = player.play.find((c) => c.id === this.pendingCardId);
          if (blessedSelf && blessedSelf.blessCharges > 0 && player.graveyard.length > 0) {
            blessedSelf.blessCharges--;
            this.setPendingAction(
              "necromancer",
              client.sessionId,
              "graveyard",
              "🕯️ 再选择一张墓地牌"
            );
            this.notifyActor(client.sessionId);
            break;
          }

          // 通灵结束：通灵师自己进墓地
          this.clearPendingAction();
          const { id: playedId } = this.takePendingCard();
          let selfCard: Card | undefined;
          const pi = player.play.findIndex((c) => c.id === playedId);
          if (pi >= 0) {
            [selfCard] = player.play.splice(pi, 1);
            player.playCount = player.play.length;
            this.clearRevealed(player);
          }
          if (selfCard) this.pushDeath(selfCard, client.sessionId, "necromancer");
          if (this.state.pendingAction.type === "") this.resumeTurn();
          break;
        }

        // 种狼：从己方墓地挑一张牌，变为普通狼人加入手牌
        case "breedWolf": {
          const player = this.state.players.get(client.sessionId)!;
          if (index < 0 || index >= player.graveyard.length) {
            client.send("playRejected", { reason: "选择的墓地牌不存在" });
            return;
          }
          // ★ 手牌上限：满 8 张时不能获得新牌（牌留在墓地，不丢牌）
          if (this.canGainCard(client.sessionId)) {
            const [chosen] = player.graveyard.splice(index, 1);
            const oldName = chosen.name;
            // ★ 变为普通狼人：保留原实体 id，改 type/skill/name 为白板狼人
            chosen.type = "wolf";
            chosen.skill = "";
            chosen.name = "狼人";
            chosen.acted = false;
            chosen.blessCharges = 0;
            chosen.revealed = false;
            chosen.injured = false;
            chosen.injuredUntil = 0;
            chosen.owner = client.sessionId;
            player.hand.push(chosen);
            player.handCount = player.hand.length;
            this.hint(client.sessionId, `🐺 种狼将墓地中的「${oldName}」培育为狼人，加入你的手牌`);
          } else {
            console.log(`[handLimit] ${client.sessionId} 手牌已满，种狼未获得新牌（牌留墓地）`);
            this.hint(client.sessionId, `🐺 手牌已达上限 ${this.HAND_LIMIT} 张`);
          }
          this.clearPendingAction();
          if (this.state.pendingAction.type === "") this.afterSelection(client.sessionId);
          break;
        }

        // 狼刀 / 女巫毒药：【黑夜标记模式】牌留在手牌，仅入队，天亮统一结算
        case "wolfKnife":
        case "witchPoison": {
          const oppId = this.getOtherSessionId(client.sessionId);
          const opp = oppId ? this.state.players.get(oppId) : undefined;
          if (!opp || index < 0 || index >= opp.hand.length) {
            client.send("playRejected", { reason: "选择的目标不存在" });
            return;
          }
          const card = opp.hand[index];
          if (this.isMarked(card.id)) {
            client.send("playRejected", { reason: "这张牌已被锁定" });
            return;
          }
          const witchCardId = this.pendingWitchCardId;
          // ★ 先存下来：clearPendingAction() 会把 pa.type 清空，之后再读就变成 ""
          const cause = pa.type;
          // ★ 记录动手的牌（用于种狼击杀联动）：此刻它在本方行动区
          const actingCard = this.state.players
            .get(client.sessionId)!
            .play.find((c) => c.id === this.pendingCardId);
          const killer =
            actingCard && cause === "wolfKnife"
              ? { id: actingCard.id, ownerId: client.sessionId, skill: actingCard.skill }
              : undefined;
          // ★ 女巫学徒：先判失手 —— 失手则【整瓶药作废】，目标不受影响
          const backfired = this.rollApprenticeRisk(client.sessionId, witchCardId);
          this.clearPendingAction();
          if (!backfired) this.markDeath(card, oppId!, cause, killer);
          // ★ 被狼刀标记的牌（天亮才生效）要在对方卡背显示「杀」字，
          //   但只有出刀方（狼人使用者）看得到：给凶手客户端授权 victim 的 KILL_VIEW_TAG。
          if (!backfired && cause === "wolfKnife" && opp) {
            client.view.add(opp, KILL_VIEW_TAG);
          }
          // ★ 被女巫毒药标记的牌（天亮才生效）要在对方卡背显示「杀毒」二字，
          //   但只有下毒的女巫那一方看得到：给女巫客户端授权 victim 的 POISON_VIEW_TAG。
          if (!backfired && cause === "witchPoison" && opp) {
            client.view.add(opp, POISON_VIEW_TAG);
          }
          // ★ 技能已发动完毕 → 打出的牌立刻回到手牌（下一夜还能再用）
          const { id: playedId, index: playedIndex } = this.takePendingCard();
          if (playedId) this.returnCardToHand(client.sessionId, playedId, playedIndex);
          // ★ 狼美人出刀用的是【共用刀】，魅惑是她自己的技能 → 杀完人同一夜还能再魅惑一次
          //   （反过来：她本夜已经魅惑过、共用刀又被别人用掉时，这张牌就锁死不能再动）
          this.refreshBeautyActed();
          // ★ 大野狼第一刀走的是共用刀 → 结算完放开它的【额外刀】（同回合可再杀一个）
          if (this.pendingGreatWolfShared && playedId) {
            const gw = this.state.players
              .get(client.sessionId)!
              .hand.find((c) => c.id === playedId);
            if (gw && !this.greatWolfExtraUsed.has(gw.id)) gw.acted = false;
          }
          this.pendingGreatWolfShared = false;
          // ★ 刀已落地：取消用的回滚信息作废（之后点别的牌不该把刀还回去）
          this.pendingKnifeSharedConsumed = false;
          this.pendingKnifeExtraCardId = "";
          // ★ 不会自动结束回合：玩家仍可用其它可行动手牌继续行动，或主动点「结束回合」
          this.resumeTurn();
          break;
        }

        // 狼美人魅惑：只记下最后被魅惑的那张牌（她死亡时随之倒下）
        case "wolfBeautyCharm": {
          const player = this.state.players.get(client.sessionId)!;
          const oppId = this.getOtherSessionId(client.sessionId);
          const opp = oppId ? this.state.players.get(oppId) : undefined;
          if (!opp || index < 0 || index >= opp.hand.length) {
            client.send("playRejected", { reason: "选择的目标不存在" });
            return;
          }
          const target = opp.hand[index];
          this.clearPendingAction();
          const { id: playedId, index: playedIndex } = this.takePendingCard();
          if (playedId) {
            this.returnCardToHand(client.sessionId, playedId, playedIndex);
            const beauty = player.hand.find((c) => c.id === playedId);
            if (beauty) {
              beauty.charmedId = target.id;
              beauty.charmUsedTonight = true;
              // ★ 魅惑是她自己的技能、不消耗共用狼刀：
              //   若本夜共用刀还没人用掉，她还能再出一次牌去杀人；
              //   若刀已经被别人用掉，她这回合就彻底没技能可用了。
              beauty.acted = !this.beautyHasAction(beauty);
            }
          }
          console.log(`[charm] ${client.sessionId} 的狼美人魅惑了 ${oppId} 的 ${target.name}`);
          this.hint(client.sessionId, `💋 狼美人魅惑了对方 #${index + 1}`);
          // ★ 老流氓不受魅惑：当场告诉对方"无效"
          if (target.skill === "oldRogue") {
            this.hint(oppId!, "💋 老流氓不受魅惑");
          } else {
            this.hint(oppId!, `💋 你的「${target.name}」被魅惑了`);
          }
          // ★ 只有魅惑者能看到对方那张牌背面的爱心：给魅惑者客户端授权
          //   BEAUTY_VIEW_TAG（只看对方的 PlayerState，被魅惑者自己看不到）。
          if (opp) {
            const ownerClient = this.clients.find((c) => c.sessionId === client.sessionId);
            if (ownerClient) ownerClient.view.add(opp, BEAUTY_VIEW_TAG);
          }
          this.syncCharmedSlots();
          this.resumeTurn();
          break;
        }

        // 猎人开枪 / 狼王带人：【结算中立即生效】直接从手牌移除并推入死亡队列
        case "hunter":
        case "wolfKing": {
          const oppId = this.getOtherSessionId(client.sessionId);
          const opp = oppId ? this.state.players.get(oppId) : undefined;
          if (!opp || index < 0 || index >= opp.hand.length) {
            client.send("playRejected", { reason: "选择的目标不存在" });
            return;
          }
          const [card] = opp.hand.splice(index, 1);
          opp.handCount = opp.hand.length;
          console.log(`[${pa.type}] ${client.sessionId} 选中对方的 ${card.name}`);
          this.clearPendingAction();
          this.pushDeath(card, oppId!, pa.type);
          // ★ 被强化的猎人：这一枪带走 2 张 → 再补选一张（余量为 0 后停手，不会一直杀）
          const extra = this.pendingHunterExtra;
          if (extra && extra.blessCharges > 0) {
            extra.blessCharges--;
            const opp2Id = this.getOtherSessionId(client.sessionId);
            const opp2 = opp2Id ? this.state.players.get(opp2Id) : undefined;
            if (opp2 && opp2.hand.length > 0) {
              this.setPendingAction("hunter", client.sessionId, "opponentHand", "🔫 再选择一张");
              this.hint(client.sessionId, "🔫 强化生效：这一枪带走两张");
              break;
            }
          }
          this.pendingHunterExtra = null;
          // 技能链可能级联暂停；若已无待选，恢复流程
          if (this.state.pendingAction.type === "") this.afterSelection(client.sessionId);
          break;
        }

        // 毒狼死亡带走：与狼王同机制，但带走的牌算作【毒杀】（显示杀毒标记）
        case "poisonWolf": {
          const oppId = this.getOtherSessionId(client.sessionId);
          const opp = oppId ? this.state.players.get(oppId) : undefined;
          if (!opp || index < 0 || index >= opp.hand.length) {
            client.send("playRejected", { reason: "选择的目标不存在" });
            return;
          }
          const [card] = opp.hand.splice(index, 1);
          opp.handCount = opp.hand.length;
          console.log(`[poisonWolf] ${client.sessionId} 毒杀对方的 ${card.name}`);
          this.clearPendingAction();
          this.pushDeath(card, oppId!, "witchPoison");
          // ★ 被杀者主人能看到「杀毒」标记（与女巫毒药同视图）
          client.view.add(opp, POISON_VIEW_TAG);
          if (this.state.pendingAction.type === "") this.afterSelection(client.sessionId);
          break;
        }

        // 预言家查验：把那张牌的身份告诉玩家，预言家随后回手牌原位
        case "seerCheck": {
          const oppId = this.getOtherSessionId(client.sessionId);
          const opp = oppId ? this.state.players.get(oppId) : undefined;
          if (!opp || index < 0 || index >= opp.hand.length) {
            client.send("playRejected", { reason: "选择的目标不存在" });
            return;
          }
          const target = opp.hand[index];
          // ★ 隐狼被查验时显示为平民；★ 已变狼的野孩子此刻就是狼 → 查验出狼
          const shownName = target.skill === "hiddenWolf" ? "平民" : target.name;
          const shownType =
            target.skill === "hiddenWolf"
              ? "villager"
              : this.isWolfSide(target)
                ? "wolf"
                : target.type;

          // ★ 查验即【永久明牌】（像天使那样）：双方都能看到这张牌的身份与位置，
          //   隐狼明牌显示伪装身份「平民」，不穿帮
          target.revealed = true;
          target.revealedAsName = shownName;
          target.revealedAsType = shownType;

          this.clearPendingAction();
          const { id: playedId, index: playedIndex } = this.takePendingCard();
          if (playedId) this.returnCardToHand(client.sessionId, playedId, playedIndex);

          this.clients
            .find((c) => c.sessionId === client.sessionId)
            ?.send("seerResult", { index, name: shownName, type: shownType });
          this.hint(client.sessionId, `🔍 查验：对方 #${index + 1} 是「${shownName}」`);
          this.hint(oppId, `🔍 对方查验了你的第 ${index + 1} 张牌，身份已亮明`);
          this.syncOpenCards();
          console.log(`[seer] ${client.sessionId} 查验对方 #${index + 1} → ${shownName}（永久明牌）`);

          // ★ 被强化的预言家：本夜还能再查一张
          const seer = this.state.players
            .get(client.sessionId)!
            .hand.find((c) => c.id === playedId);
          if (seer && seer.blessCharges > 0) {
            seer.blessCharges--;
            seer.acted = false;
            this.hint(client.sessionId, "🔍 强化生效：本夜你还能再查验一张");
          }

          this.resumeTurn();
          break;
        }

        // 白狼王自爆：带走对方一张手牌，自己同时死亡（都不触发死亡技能）
        case "whiteWolfBlast": {
          const oppId = this.getOtherSessionId(client.sessionId);
          const opp = oppId ? this.state.players.get(oppId) : undefined;
          if (!opp || index < 0 || index >= opp.hand.length) {
            client.send("playRejected", { reason: "选择的目标不存在" });
            return;
          }
          const [victimCard] = opp.hand.splice(index, 1);
          opp.handCount = opp.hand.length;

          this.clearPendingAction();
          const { id: playedId } = this.takePendingCard();
          // 自爆是回合行动：选完目标本回合即结束（无论是否触发连锁）
          this.state.turnActed = true;

          // 自爆者本人：从行动区取出，随之进自己的墓地
          const selfPlayer = this.state.players.get(client.sessionId)!;
          let selfCard: Card | undefined;
          const pi = selfPlayer.play.findIndex((c) => c.id === playedId);
          if (pi >= 0) {
            [selfCard] = selfPlayer.play.splice(pi, 1);
            selfPlayer.playCount = selfPlayer.play.length;
            this.clearRevealed(selfPlayer);
          }

          this.pushDeath(victimCard, oppId!, "whiteWolfBlast", true);
          if (selfCard) this.pushDeath(selfCard, client.sessionId, "whiteWolfBlast", true);
          console.log(`[whiteWolf] ${client.sessionId} 自爆，带走对方 ${victimCard.name}`);
          this.hint(client.sessionId, `💥 自爆：带走「${victimCard.name}」，白狼王进入你的墓地`);
          this.hint(oppId!, `💥 对方白狼王自爆，带走了你的「${victimCard.name}」`);

          if (this.state.pendingAction.type === "") this.advanceTurn();
          break;
        }

        // 女巫解药：从自己的墓地复活一张牌回手牌
        case "witchRevive": {
          const player = this.state.players.get(client.sessionId)!;
          if (index < 0 || index >= player.graveyard.length) {
            client.send("playRejected", { reason: "选择的墓地牌不存在" });
            return;
          }
          const witchCardId = this.pendingWitchCardId;
          // ★ 女巫学徒：先判失手 —— 失手则【整瓶药作废】，墓地的牌不会被复活
          const backfired = this.rollApprenticeRisk(client.sessionId, witchCardId);
          this.clearPendingAction();
          if (!backfired) {
            // ★ 手牌上限：满 8 张时不能获得新牌（牌留在墓地，不丢牌）
            if (this.canGainCard(client.sessionId)) {
              const [card] = player.graveyard.splice(index, 1);
              card.owner = client.sessionId;
              // ★ 复活 = 重新入场：清掉"已行动 / 已用技能"等死亡态标记，
              //   否则墓地带来的 acted=true 会让它本夜被前端判成"已行动"而无法出刀。
              //   （与通灵师 reset 一致：清技能消耗标记，但保留 usedOnce 这种整局一次的限制）
              card.acted = false;
              card.thiefUsed = false;
              card.witchReviveUsed = false;
              card.witchPoisonUsed = false;
              card.foolRevealed = false;
              player.hand.push(card);
              player.handCount = player.hand.length;
              console.log(`[witchRevive] ${client.sessionId} 复活了墓地的 ${card.name} → 回到手牌`);
            } else {
              console.log(`[handLimit] ${client.sessionId} 手牌已满，女巫解药未复活新牌（牌留墓地）`);
              this.hint(client.sessionId, `🧪 手牌已达上限 ${this.HAND_LIMIT} 张`);
            }
          }
          // 打出的女巫牌回收（技能已发动完毕）
          const { id: playedId, index: playedIndex } = this.takePendingCard();
          if (playedId) this.returnCardToHand(client.sessionId, playedId, playedIndex);
          // ★ 不会自动结束回合：玩家可继续行动，或主动点「结束回合」
          this.resumeTurn();
          break;
        }

        // 盗贼交换：对手那张归我，我的盗贼归对手（技能抹除 → 白板平民）
        case "thiefSwap": {
          const swapSelf = this.state.players.get(client.sessionId)!;
          const oppId = this.getOtherSessionId(client.sessionId);
          const opp = oppId ? this.state.players.get(oppId) : undefined;
          if (!opp || index < 0 || index >= opp.hand.length) {
            client.send("playRejected", { reason: "选择的目标不存在" });
            return;
          }
          const toSteal = opp.hand[index];

          this.clearPendingAction();
          const { id: playedId, index: handSlot } = this.takePendingCard();

          // 1) 对手那张 → 我的手牌（插回盗贼原来的位置）
          const stolen = this.cloneCard(toSteal, client.sessionId);
          stolen.acted = false; // 刚到手的牌，本回合还没行动过
          // ★ 换走的是张【已被刀/毒锁定】的牌时，死亡跟着牌走：天亮它死在我手上
          this.reassignDeath(stolen.id, stolen, client.sessionId);
          opp.hand.splice(index, 1);
          opp.handCount = opp.hand.length;
          if (handSlot >= 0 && handSlot <= swapSelf.hand.length) {
            swapSelf.hand.splice(handSlot, 0, stolen);
          } else {
            swapSelf.hand.push(stolen);
          }
          swapSelf.handCount = swapSelf.hand.length;

          // 2) 行动区里的盗贼 → 对手手牌（技能抹除，成为白板平民）
          const pi = swapSelf.play.findIndex((c) => c.id === playedId);
          if (pi >= 0) {
            const [thiefCard] = swapSelf.play.splice(pi, 1);
            swapSelf.playCount = swapSelf.play.length;
            const outgoing = this.cloneCard(thiefCard, oppId!);
            outgoing.thiefUsed = true;
            outgoing.skill = ""; // ★ 技能直接抹除
            outgoing.acted = false;
            opp.hand.push(outgoing);
            opp.handCount = opp.hand.length;
            // ★ 盗贼这张牌自己若已被刀/毒锁定：死亡跟着牌走 —— 它换到对手手上，
            //   天亮就死在对手手里（先换牌，后死亡）
            this.reassignDeath(outgoing.id, outgoing, oppId!);
            console.log(
              `[thiefSwap] ${client.sessionId} 用盗贼换来了对手的 ${stolen.name}，盗贼交给 ${oppId}`
            );
            this.clients
              .find((c) => c.sessionId === oppId)
              ?.send("cardReturned", { cardId: outgoing.id, name: outgoing.name });
            this.hint(oppId!, `🔀 对手换走了你的「${stolen.name}」，给你「${outgoing.name}」`);
          }

          this.clients
            .find((c) => c.sessionId === client.sessionId)
            ?.send("cardReturned", { cardId: stolen.id, name: stolen.name });
          this.hint(client.sessionId, `🔀 交换完成：你拿到「${stolen.name}」`);

          // ★ 不会自动结束回合：还能继续用其它手牌行动，或主动点「结束回合」
          this.resumeTurn();
          break;
        }

        // 骑士决斗：对方是狼人 → 狼死、骑士活；否则骑士自己死（隐狼按狼人判定）
        case "knightDuel": {
          const oppId = this.getOtherSessionId(client.sessionId);
          const opp = oppId ? this.state.players.get(oppId) : undefined;
          if (!opp || index < 0 || index >= opp.hand.length) {
            client.send("playRejected", { reason: "选择的目标不存在" });
            return;
          }
          const [target] = opp.hand.splice(index, 1);
          opp.handCount = opp.hand.length;

          this.clearPendingAction();
          const { id: playedId, index: playedIndex } = this.takePendingCard();

          // ★ 隐狼的 type 也是 wolf，所以这里自然按狼人判定
          // ★ 已变狼的野孩子同样是狼 → 骑士决斗杀掉它，骑士存活
          const isWolf = this.isWolfSide(target);

          if (isWolf) {
            this.pushDeath(target, oppId!, "knightDuel");
            // 骑士活下来 → 回手牌原位；★ 胜利不消耗本回合行动，可【同一回合内立刻再次决斗】
            if (playedId) {
              this.returnCardToHand(client.sessionId, playedId, playedIndex);
              const back = this.state.players
                .get(client.sessionId)!
                .hand.find((c) => c.id === playedId);
              if (back) back.acted = false;
            }
            this.clients
              .find((c) => c.sessionId === client.sessionId)
              ?.send("duelResult", { index, name: target.name, type: target.type, survived: true });
            this.hint(client.sessionId, `⚔️ 决斗胜利：「${target.name}」倒下，你活了下来`);
            this.hint(oppId!, `⚔️ 对方骑士决斗，你的「${target.name}」倒下`);
            console.log(`[knight] ${client.sessionId} 决斗 ${target.name} → 狼死，骑士存活`);
            if (this.state.pendingAction.type === "") this.resumeTurn();
          } else {
            // 骑士自己死：从行动区取出 → 进自己的墓地
            const selfPlayer = this.state.players.get(client.sessionId)!;
            let selfCard: Card | undefined;
            const pi = selfPlayer.play.findIndex((c) => c.id === playedId);
            if (pi >= 0) {
              [selfCard] = selfPlayer.play.splice(pi, 1);
              selfPlayer.playCount = selfPlayer.play.length;
              this.clearRevealed(selfPlayer);
            }
            // 对方那张牌不是狼 → 回到对方手牌原位
            opp.hand.splice(index, 0, target);
            opp.handCount = opp.hand.length;

            // ★ 被强化的骑士：这一次决斗失败也不会死
            if (selfCard && selfCard.blessCharges > 0) {
              selfCard.blessCharges--;
              this.returnCardToHand(client.sessionId, selfCard.id, playedIndex);
              const back = this.state.players
                .get(client.sessionId)!
                .hand.find((c) => c.id === playedId);
              if (back) back.acted = false;
              this.hint(client.sessionId, "⚔️ 强化生效：这一场决斗你没有倒下");
              this.hint(oppId!, "⚔️ 对方骑士被强化，决斗失败却没有倒下");
              if (this.state.pendingAction.type === "") this.resumeTurn();
              break;
            }

            this.state.turnActed = true;
            if (selfCard) this.pushDeath(selfCard, client.sessionId, "knightDuel");
            this.clients
              .find((c) => c.sessionId === client.sessionId)
              ?.send("duelResult", { index, name: target.name, type: target.type, survived: false });
            this.hint(client.sessionId, `⚔️ 决斗失败：「${target.name}」不是狼人，你倒下了`);
            this.hint(oppId!, `⚔️ 对方骑士决斗失败，骑士倒下`);
            console.log(`[knight] ${client.sessionId} 决斗 ${target.name} → 非狼，骑士死亡`);
            if (this.state.pendingAction.type === "") this.advanceTurn();
          }
          break;
        }

        // 流放：【白天立即生效】直接把对方一张手牌送进墓地（可能触发猎人/狼王连锁）
        case "exile": {
          const oppId = this.getOtherSessionId(client.sessionId);
          const opp = oppId ? this.state.players.get(oppId) : undefined;
          if (!opp || index < 0 || index >= opp.hand.length) {
            client.send("playRejected", { reason: "选择的目标不存在" });
            return;
          }
          const [card] = opp.hand.splice(index, 1);
          opp.handCount = opp.hand.length;

          // ★ 白痴：被流放时翻牌免疫（翻过之后永久免疫，但其它死法照常）
          if (card.skill === "fool") {
            const firstTime = !card.foolRevealed;
            card.foolRevealed = true;
            opp.hand.splice(index, 0, card); // 放回原位
            opp.handCount = opp.hand.length;
            this.clearPendingAction();
            this.state.turnActed = true;
            this.broadcast("foolRevealed", { owner: oppId!, index, firstTime });
            this.hint(oppId!, firstTime ? "🃏 你的白痴翻牌，免疫放逐" : "🃏 你的白痴已翻牌，免疫放逐");
            this.hint(
              client.sessionId,
              firstTime ? "🃏 对方翻出白痴，放逐无效" : "🃏 对方白痴已翻牌，放逐无效"
            );
            console.log(`[exile] ${client.sessionId} 的流放被白痴免疫`);
            this.advanceTurn();
            break;
          }

          console.log(`[exile] ${client.sessionId} 流放了对方的 ${card.name}`);
          this.clearPendingAction();
          // 流放是回合动作，本回合已结束（无论是否触发连锁）
          this.state.turnActed = true;

          // ★ 炸弹人：被放逐时引爆 —— 随机炸死放逐方 3 张手牌（不足则全炸，且不触发死亡技能）
          if (card.skill === "bomber") {
            const bomberId = client.sessionId;
            const bomberHand = this.state.players.get(bomberId)!.hand;
            const pickable = bomberHand.filter(
              (c) => !this.isMarked(c.id) && !this.deathQueue.some((e) => e.card.id === c.id)
            );
            const victims = this.pickRandom(pickable, 3);
            this.deathQueue.push({ card, victimId: oppId!, cause: "exile", silent: false });
            victims.forEach((v) =>
              this.deathQueue.push({
                card: v,
                victimId: bomberId,
                cause: "bomberBlast",
                silent: true,
              })
            );
            console.log(`[bomber] 炸弹人引爆，炸死 ${bomberId} 的 ${victims.length} 张手牌`);
            this.hint(bomberId, `💣 炸弹人引爆！你的 ${victims.length} 张手牌被炸`);
            this.hint(oppId!, `💣 你的炸弹人引爆，炸掉对方 ${victims.length} 张手牌`);
            this.resolveQueue();
          } else {
            this.pushDeath(card, oppId!, "exile");
          }
          // 若触发猎人/狼王连锁，等待选择；否则直接推进
          if (this.state.pendingAction.type === "") this.advanceTurn();
          break;
        }
      }
    },

    /**
     * 结束回合 / 跳过本回合：当前行动方主动交给下家。
     * 客户端发送格式：room.send("ready")
     */
    ready: (client: Client) => {
      if (this.state.winner !== "" || !this.gameStarted) return;
      if (this.state.pendingAction.type !== "") {
        client.send("playRejected", { reason: "请先完成当前结算" });
        return;
      }
      if (client.sessionId !== this.state.turnOwner) {
        client.send("playRejected", { reason: "还没轮到你" });
        return;
      }
      this.endTurn(client.sessionId);
      console.log(`[ready] ${client.sessionId} 跳过本回合行动`);
    },

    /**
     * ★【临时·测试用】手动摸牌：用于验证「手牌上限 8 张」是否生效。
     * 客户端发送：room.send("drawCard") 或 room.send("drawCard", { count: 10 })
     * 服务端回传 "drawCardResult"：{ before, after, gained, limit, deckBefore, deckAfter }
     * 不受回合 / 阶段限制，随时可触发。验证完成后可整段删除本 handler。
     */
    drawCard: (client: Client, message?: { count?: number }) => {
      const player = this.state.players.get(client.sessionId);
      if (!player) return;
      const n = Math.max(1, Math.min(50, Math.floor(Number(message?.count) || 1)));
      const before = player.hand.length;
      const deckBefore = this.state.deck.length;
      let gained = 0;
      for (let i = 0; i < n; i++) {
        if (this.drawCard(client.sessionId)) gained++;
      }
      const result = {
        before,
        after: player.hand.length,
        gained,
        limit: this.HAND_LIMIT,
        deckBefore,
        deckAfter: this.state.deck.length,
      };
      client.send("drawCardResult", result);
      console.log(
        `[test:drawCard] ${client.sessionId} 请求 ${n} 张 → 实得 ${gained} 张，` +
          `手牌 ${before} → ${result.after}/${this.HAND_LIMIT}，` +
          `牌库 ${deckBefore} → ${result.deckAfter}`
      );
    },
  };

  /**
   * ★ Godot / 非 Schema 客户端的 JSON 状态推送。
   * Colyseus 的 Schema patch 是二进制格式，Godot 端没有 SDK 无法解码，
   * 所以每次状态真正变化时（broadcastPatch 返回 hasChanges=true），
   * 额外向每个客户端推一份它自己视角的简化 JSON（"jsonState" 消息）。
   * 双人卡牌状态变化是离散的（出牌/选目标），频率很低，无性能压力。
   */
  broadcastPatch(): boolean {
    const hasChanges = super.broadcastPatch();
    if (hasChanges && this.state) {
      this.pushJsonState();
    }
    return hasChanges;
  }

  /**
   * 向每个客户端发送其视角的简化 JSON 状态。
   * 视角规则与 Schema view 一致：自己的手牌/行动区/墓地全量，
   * 对方只给数量（牌面不可见）。
   */
  private pushJsonState() {
    const s = this.state;
    if (!s) return;
    const lite = (c: Card) => ({
      id: c.id,
      name: c.name,
      type: c.type,
      acted: c.acted,
    });
    for (const client of this.clients) {
      const me = s.players.get(client.sessionId);
      if (!me) continue;
      const oppId = this.getOtherSessionId(client.sessionId);
      const opp = oppId ? s.players.get(oppId) : undefined;
      client.send(
        "jsonState",
        JSON.stringify({
          sid: client.sessionId,
          phase: s.phase,
          round: s.round,
          turnOwner: s.turnOwner,
          turnActed: s.turnActed,
          winner: s.winner,
          deadline: s.deadline,
          myHand: me.hand.map(lite),
          myPlay: me.play.map(lite),
          myGraveyard: me.graveyard.map(lite),
          oppHandCount: opp ? opp.hand.length : 0,
          oppPlayCount: opp ? opp.play.length : 0,
          oppGraveyardCount: opp ? opp.graveyard.length : 0,
          pendingType: s.pendingAction.type,
          pendingActor: s.pendingAction.actor,
          pendingZone: s.pendingAction.zone,
        })
      );
    }
  }

  onCreate(options: any) {
    console.log("room created:", this.roomId);
    // 测试可通过 options.turnDuration 缩短回合时限
    if (options && typeof options.turnDuration === "number") {
      this.turnDuration = options.turnDuration;
    }
    // 明牌镜像 / 丘比特标记：手牌顺序会随换牌/摸牌/死亡变动，定时同步位置
    this.clock.setInterval(() => {
      this.syncOpenCards();
      this.syncLinkedSlots();
      this.syncCharmedSlots();
      this.syncKilledSlots();
      this.syncPoisonedSlots();
      this.syncIdolSlots();
    }, 100);
  }

  onJoin(client: Client, options: any) {
    // 自愈：清理"连接已断开但仍占着座位"的僵尸玩家
    // （浏览器刷新/断网时偶发，会导致后来的玩家永远等不到第 2 人）
    this.cleanupStalePlayers();

    const player = new PlayerState();
    this.state.players.set(client.sessionId, player);

    /**
     * 手牌私有化：为该客户端创建独立 view，
     * 只授权它看到自己的 PlayerState（handCount 是公开字段，不受影响）。
     */
    client.view = new StateView();
    client.view.add(player, HAND_VIEW_TAG);

    console.log(
      `[onJoin] ${client.sessionId} joined! 房间人数: ${this.state.players.size}/2` +
        `｜gameStarted=${this.gameStarted}`
    );

    // 两人就位，自动开局
    if (this.state.players.size === 2) {
      try {
        this.initGame();
      } catch (err: any) {
        console.error("[onJoin] initGame 失败：", err?.message || err);
      }
    }

    // ★ 立即推一次 JSON 状态（消息会 enqueue，客户端 JOIN_ROOM 握手后送达）
    this.pushJsonState();
  }

  onLeave(client: Client, code: CloseCode) {
    client.view?.dispose();
    this.clearPendingAction();
    this.pendingCardId = "";
    this.pendingCardIndex = -1;
    this.deathQueue = [];
    this.clearTimer();
    this.state.players.delete(client.sessionId);

    this.state.turnOwner = "";
    this.state.turnActed = false;
    this.state.deadline = 0;
    this.pendingNextSeq = -1;

    if (this.gameStarted && this.state.winner === "" && this.state.players.size > 0) {
      const winner = this.state.players.keys().next().value!;
      this.state.winner = winner;
      console.log(`[gameOver] 对手离开，${winner} 获胜！`);
      this.broadcast("gameOver", { winner, loser: client.sessionId, reason: "对手离开" });
    }
    console.log(client.sessionId, "left!", code);
  }

  onDispose() {
    this.clearTimer();
    console.log("room", this.roomId, "disposing...");
  }

  // ==============================================================
  //  开局 & 回合推进（顺序制）
  // ==============================================================

  /** 序列号 → 宏观昼夜 */
  private turnKind(seq: number): Phase {
    return seq < 2 ? "night" : "day";
  }

  /** 序列号 → 归属玩家 sessionId（偶数为 P1，奇数为 P2） */
  private turnOwnerId(seq: number): string {
    return seq % 2 === 0 ? this.firstPlayerId : this.secondPlayerId;
  }

  /**
   * 初始化游戏：重置状态 → 构建牌库 → 洗牌 → 发牌 → 进入第一个黑夜（P1 先手）
   * 牌库构成：15 狼人 + 20 平民 + 特殊身份牌（含大野狼×2、锈剑骑士、种狼、毒狼等）= 60 张
   */
  initGame() {
    // 0. 重置（支持中途有人离开后重新开局）
    this.deathQueue = [];
    this.pendingCardId = "";
    this.pendingCardIndex = -1;
    this.clearPendingAction();
    this.state.deck.clear();
    this.state.winner = "";
    this.state.round = 0;
    this.state.turnOwner = "";
    this.state.turnSeq = 0;
    this.state.turnActed = false;
    this.state.wolfKnifeUsed = false;
    this.greatWolfExtraUsed.clear();
    this.resetBeautyCharmFlags();
    this.state.firstPlayer = "";
    this.cardLinks = [];
    this.cupidLinkOwner = "";
    this.pendingLinkSelfId = "";
    this.pendingLinkFirstSide = "";
    this.angelShowcase.clear();
    this.guarded.clear();
    this.lastGuarded.clear();
    this.wildChildId = "";
    this.idolId = "";
    this.pendingHunterExtra = null;
    this.killedHandCardThisRound = false;
    this.peacefulStreak = 0;
    this.state.deadline = 0;
    this.state.players.forEach((player) => {
      player.hand.clear();
      player.handCount = 0;
      player.play.clear();
      player.playCount = 0;
      player.graveyard.clear();
      player.lostThisNight = false;
      player.revealedName = "";
      player.revealedType = "";
      player.openCards.clear();
    });

    // 1. 确定 P1 / P2（先加入者 = 先手黑夜）
    const sessionIds = Array.from(this.state.players.keys());
    this.firstPlayerId = sessionIds[0];
    this.secondPlayerId = sessionIds[1];
    this.state.firstPlayer = this.firstPlayerId;

    // 2. 构建牌库：特殊牌（除平民 / 狼人以外的身份牌）几乎唯一，缺口由狼人 / 平民补足
    //    15 狼人 + 20 平民 + 特殊身份牌（含大野狼×2、锈剑骑士、种狼、毒狼等）= 60 张
    const deck: Card[] = [];
    for (let i = 1; i <= 15; i++) {
      deck.push(this.createCard(`wolf-${i}`, "狼人", "wolf", ""));
    }
    for (let i = 1; i <= 20; i++) {
      deck.push(this.createCard(`villager-${i}`, "平民", "villager", ""));
    }
    // ★ 特殊牌：每种身份整局只有 1 张（大野狼例外，共 2 张）
    deck.push(this.createCard("hunter-1", "猎人", "god", "hunter"));
    deck.push(this.createCard("wolfking-1", "狼王", "wolf", "wolfKing"));
    deck.push(this.createCard("witch-1", "女巫", "god", "witch"));
    deck.push(this.createCard("elder-1", "长老", "villager", "elder"));
    deck.push(this.createCard("thief-1", "盗贼", "villager", "thief"));
    deck.push(this.createCard("greatwolf-1", "大野狼", "wolf", "greatWolf"));
    deck.push(this.createCard("greatwolf-2", "大野狼", "wolf", "greatWolf"));
    deck.push(this.createCard("whitewolf-1", "白狼王", "wolf", "whiteWolfKing"));
    deck.push(this.createCard("seer-1", "预言家", "god", "seer"));
    deck.push(this.createCard("hidden-1", "隐狼", "wolf", "hiddenWolf"));
    deck.push(this.createCard("apprentice-1", "女巫学徒", "god", "witchApprentice"));
    deck.push(this.createCard("knight-1", "骑士", "god", "knight"));
    deck.push(this.createCard("fool-1", "白痴", "villager", "fool"));
    deck.push(this.createCard("cupid-1", "丘比特", "god", "cupid"));
    deck.push(this.createCard("angel-1", "天使", "villager", "angel"));
    deck.push(this.createCard("necro-1", "通灵师", "god", "necromancer"));
    deck.push(this.createCard("merchant-1", "奇迹商人", "villager", "miracleMerchant"));
    deck.push(this.createCard("guard-1", "守卫", "god", "guard"));
    deck.push(this.createCard("wild-1", "野孩子", "villager", "wildChild"));
    deck.push(this.createCard("bomber-1", "炸弹人", "villager", "bomber"));
    deck.push(this.createCard("beauty-1", "狼美人", "wolf", "wolfBeauty"));
    deck.push(this.createCard("rogue-1", "老流氓", "villager", "oldRogue"));
    // ★ 新增特殊牌
    deck.push(this.createCard("rustknight-1", "锈剑骑士", "god", "rustKnight")); // 神职：被狼刀杀 → 反噬拖走对面最凶的狼（不触发其技能）
    deck.push(this.createCard("breedwolf-1", "种狼", "wolf", "breedWolf")); // 狼人：共用刀杀敌后，从己方墓地选一张变狼入伙
    deck.push(this.createCard("poisonwolf-1", "毒狼", "wolf", "poisonWolf")); // 狼人：死亡带走对手一张手牌（算毒杀）

    // 3. 洗牌（Fisher-Yates）
    this.shuffle(deck);

    // 3.5 发牌：★ 开局配额 —— 每人 6 张里【必定】有 1~2 张狼阵营 + 1~2 张神职阵营，
    //     其余位置只从平民阵营（type=villager）里补，保证不会把狼 / 神职塞超配额。
    //     （特殊牌唯一之后不再做盗贼保底：盗贼就是牌库里那一张，纯随机）
    const hands: Card[][] = sessionIds.map((): Card[] => []);
    const drawWhere = (pred: (c: Card) => boolean): Card | undefined => {
      const i = deck.findIndex(pred);
      if (i < 0) return undefined;
      return deck.splice(i, 1)[0];
    };

    hands.forEach((hand, i) => {
      const wolfQuota = 1 + Math.floor(Math.random() * 2); // 1~2 张狼
      const godQuota = 1 + Math.floor(Math.random() * 2); // 1~2 张神职
      for (let k = 0; k < wolfQuota; k++) {
        const c = drawWhere((x) => x.type === "wolf");
        if (c) hand.push(c);
      }
      for (let k = 0; k < godQuota; k++) {
        const c = drawWhere((x) => x.type === "god");
        if (c) hand.push(c);
      }
      // 其余位置：平民阵营（不含狼 / 神职）——牌库不足时才退回任意牌
      // ★ 手牌上限：初始发牌也受 HAND_LIMIT 约束
      while (hand.length < this.HAND_SIZE && hand.length < this.HAND_LIMIT && deck.length > 0) {
        const c = drawWhere((x) => x.type === "villager") ?? deck.shift()!;
        hand.push(c);
      }
      this.shuffle(hand);
      const player = this.state.players.get(sessionIds[i])!;
      for (const card of hand) {
        if (player.hand.length >= this.HAND_LIMIT) {
          deck.push(card); // ★ 满 8 张：发不下的牌退回公共牌库，避免丢牌
          continue;
        }
        player.hand.push(card);
      }
      player.handCount = player.hand.length;
    });

    // 5. 剩余牌放回公共牌库
    for (const card of deck) {
      this.state.deck.push(card);
    }

    this.gameStarted = true;
    this.state.round = 1;

    // 6. 记录本夜开始时的存活数（白天判定"死过牌"用）
    this.snapshotNightStart();

    console.log(`[initGame] 开局！牌库剩余 ${this.state.deck.length} 张，进入第 1 夜（P1 先手）`);
    this.broadcast("gameStart", { deckSize: this.state.deck.length });

    this.startTurn(0);
  }

  /** 启动某一个回合：设置归属、重置行动状态、发通知、开倒计时 */
  private startTurn(seq: number) {
    if (this.state.winner !== "" || !this.gameStarted) return;
    this.clearTimer();

    this.state.turnSeq = seq;
    this.state.phase = this.turnKind(seq);
    this.state.turnOwner = this.turnOwnerId(seq);
    this.state.turnActed = false;
    // 新回合：取消出牌用的狼刀回滚信息作废
    this.pendingKnifeSharedConsumed = false;
    this.pendingKnifeExtraCardId = "";
    this.pendingGreatWolfShared = false;
    // 新黑夜回合开始：重置"本夜狼刀"——狼人/狼王本夜还能共用一次刀
    if (this.state.phase === "night") {
      this.state.wolfKnifeUsed = false;
      this.greatWolfExtraUsed.clear(); // 大野狼的额外刀每夜重新有一把
      this.resetBeautyCharmFlags(); // 狼美人每夜重新获得【一次行动】
      this.dayLossComputed = false; // 新的一夜：白天的一次性判定重置
    }
    this.state.deadline = Date.now() + this.turnDuration;

    // 新回合开始：清空"本回合已行动"标记（上一回合行动过的牌这回合又能用了）
    this.resetCardActions();
    // 兜底：白天打出的公开牌信息不跨回合残留
    // ★ 例外：天使重生时那张"亮明身份"的展示牌正在行动区停留，别被回合切换抹掉
    if (!this.angelShowcase.has(this.revealedCardId)) {
      this.state.players.forEach((player) => {
        player.revealedName = "";
        player.revealedType = "";
      });
      this.revealedCardId = "";
    }

    // 进入白天：根据本夜实际死亡情况，更新双方 lostThisNight
    // ★ 每个白天只算一次（天亮那一刻）：白天流放导致的死亡不计入"本夜死过牌"
    if (this.state.phase === "day" && !this.dayLossComputed) {
      this.recomputeLostThisNight();
      this.dayLossComputed = true;
    }

    // ★ 盗贼：玩家可在夜里点牌【主动发动】；若本夜结束时还没发动，
    //   会在 endTurn 里强制补发动一次（"拿到盗贼的第一夜必定换牌"）。

    const who = this.state.turnOwner === this.firstPlayerId ? "P1（先手）" : "P2（后手）";
    const period = this.state.phase === "night" ? "🌙 黑夜" : "☀️ 白天";
    console.log(
      `[turn] 第 ${this.state.round} 轮 ${period} · 轮到 ${who}（seq=${seq}）`
    );
    this.broadcast("turnStart", {
      seq,
      phase: this.state.phase,
      owner: this.state.turnOwner,
      round: this.state.round,
      duration: this.turnDuration,
      firstPlayer: this.firstPlayerId,
    });

    // 给当前行动方单独发 yourTurn（弹窗 + 标题栏闪烁）
    this.clients
      .find((c) => c.sessionId === this.state.turnOwner)
      ?.send("yourTurn", {
        phase: this.state.phase,
        round: this.state.round,
        deadline: this.state.deadline,
      });

    this.startTimer();
  }

  /**
   * 推进到下一个回合。
   * 在"黑夜 → 白天"边界（seq 1 → 2）统一结算本夜所有死亡标记。
   * 若结算触发技能需要玩家选目标，则【暂停】——等选完再进入白天回合。
   */
  private advanceTurn() {
    if (this.state.winner !== "" || !this.gameStarted) return;
    if (this.state.pendingAction.type !== "") return; // 等待结算

    const cur = this.state.turnSeq;
    const absCur = this.absTurnIndex(); // ★ 本回合（即将结束）的绝对序号：负伤到期判定用
    let next = cur + 1;
    if (next >= SEQ_LEN) {
      next = 0;
      this.state.round++;
      // ★ 平静回合结算：刚结束的这一整轮若"无人杀对方手牌"则连续平静 +1，否则清零。
      //   连续两个整轮都平静 → 第三个整轮开始时双方各摸一张手牌（防僵局），随后清零。
      if (this.killedHandCardThisRound) {
        this.peacefulStreak = 0;
      } else {
        this.peacefulStreak++;
      }
      if (this.peacefulStreak >= 2) {
        const before = this.state.deck.length;
        this.drawCard(this.firstPlayerId);
        this.drawCard(this.secondPlayerId);
        const msg = "🤝 连续两个整轮无人杀对方手牌，双方各摸一张手牌";
        this.hint(this.firstPlayerId, msg);
        this.hint(this.secondPlayerId, msg);
        console.log(
          `[peaceful] 连续 ${this.peacefulStreak} 整轮平静 → 双方各摸一张` +
            `（牌库 ${before} → ${this.state.deck.length}）`
        );
        this.peacefulStreak = 0;
      }
      this.killedHandCardThisRound = false; // 为新的整轮重置
      // ★ 白天结束：手牌不足的一方从牌库补牌（先补牌，再记录本夜基准）
      this.replenishHands();
      this.rotateGuards(); // ★ 入夜：守卫记录轮转（本夜的变成"上一夜的"）
      this.snapshotNightStart(); // 新一夜开始，重新记录存活数
      console.log(`[turn] 第 ${this.state.round} 轮开始（入夜）`);
    }
    this.state.turnActed = false;

    // ★ 天亮边界：刚结束黑夜（seq 0/1）进入白天（seq 2）→ 统一结算夜间死亡
    if (this.turnKind(cur) === "night" && this.turnKind(next) === "day") {
      this.state.phase = "day"; // 先进入白天（展示用），再结算
      this.flushDeaths();
      if (this.state.winner !== "") return;
      if (this.state.pendingAction.type !== "") {
        // 结算触发技能，暂停；恢复后进入白天回合
        this.pendingNextSeq = next;
        console.log(
          `[turn] 天亮结算暂停：等待 ${this.state.pendingAction.actor} 完成` +
            ` ${this.state.pendingAction.type} 选择`
        );
        return;
      }
    }

    // ★ 老流氓：负伤到期（下回合结束）→ 这一刻才真正死亡
    this.resolveInjured(absCur);
    if (this.state.winner !== "") return;
    if (this.state.pendingAction.type !== "") {
      this.pendingNextSeq = next;
      console.log(
        `[turn] 负伤结算暂停：等待 ${this.state.pendingAction.actor} 完成` +
          ` ${this.state.pendingAction.type} 选择`
      );
      return;
    }

    this.startTurn(next);
  }

  /** 当前行动方结束本回合（行动完成或主动跳过） */
  private endTurn(sessionId: string) {
    if (this.state.winner !== "" || !this.gameStarted) return;
    if (sessionId !== this.state.turnOwner) return;
    if (this.state.turnActed) return;

    this.state.turnActed = true;
    this.clearTimer();

    // ★ 盗贼没有兜底：只有玩家【自己把它打出到行动区并指定目标】才会交换手牌。
    //   不点就一直留在手上，之后任何夜晚都能再用。

    // 若本回合行动触发了技能结算（如流放导致猎人死亡），等待选择后再推进
    if (this.state.pendingAction.type !== "") return;

    this.advanceTurn();
  }

  /**
   * ★【回合继续】一次行动结算完毕后，【停留在当前玩家的回合】，
   * 玩家可以继续用其它还能行动的手牌（狼人出刀 / 女巫用药）行动，
   * 直到他自己点「结束行动」才轮到对方（或超时兜底）。
   *
   * 每张牌本回合只能行动一次（card.acted），所以不会无限刷。
   */
  private resumeTurn() {
    if (this.state.winner !== "" || !this.gameStarted) return;
    if (this.state.pendingAction.type !== "") return; // 还有结算未完成
    if (this.state.turnOwner === "") return;

    // 若回合已被标记结束（如流放），交给正常的推进逻辑
    if (this.state.turnActed) {
      this.advanceTurn();
      return;
    }

    // 刷新本回合倒计时，让玩家有充足时间安排下一个行动
    this.state.deadline = Date.now() + this.turnDuration;
    this.startTimer();

    const owner = this.state.turnOwner;
    this.clients
      .find((c) => c.sessionId === owner)
      ?.send("actionResolved", {
        phase: this.state.phase,
        round: this.state.round,
        deadline: this.state.deadline,
      });
    console.log(`[resumeTurn] ${owner} 的行动已结算，本回合继续（可再用其它可行动的手牌）`);
  }

  /** 清空双方所有牌的"本回合已行动"标记（每个回合开始时调用） */
  private resetCardActions() {
    this.state.players.forEach((player) => {
      player.hand.forEach((card) => {
        card.acted = false;
      });
      player.play.forEach((card) => {
        card.acted = false;
      });
    });
  }

  /** 新的一夜：清掉所有狼美人的"本夜已魅惑"标记 */
  private resetBeautyCharmFlags() {
    this.state.players.forEach((player) => {
      player.hand.forEach((card) => {
        card.charmUsedTonight = false;
      });
      player.play.forEach((card) => {
        card.charmUsedTonight = false;
      });
    });
  }

  /**
   * 狼美人一夜只有【一次行动】：魅惑 或 杀人（共用狼刀）二选一，之后这张牌就锁死。
   * 她还有活可用 ⇔ 本夜没魅惑过（可以魅惑）或 共用狼刀还在（可以杀）。
   */
  private beautyHasAction(card: Card): boolean {
    if (card.skill !== "wolfBeauty") return false;
    return !card.charmUsedTonight || !this.state.wolfKnifeUsed;
  }

  /** 按最新局面同步所有狼美人手牌的 acted（技能都用完 → 置灰不可点） */
  private refreshBeautyActed() {
    this.state.players.forEach((player) => {
      player.hand.forEach((card) => {
        if (card.skill === "wolfBeauty") card.acted = !this.beautyHasAction(card);
      });
    });
  }

  /**
   * 选择目标结算完成后，恢复流程：
   * - 若当前行动方已结束本回合（如流放），则直接推进到下一回合；
   * - 若是在"天亮结算"中被暂停（本就不在某个进行中的回合），则进入之前记录的白天回合。
   */
  private afterSelection(_actor: string) {
    if (this.state.winner !== "" || !this.gameStarted) return;
    if (this.state.pendingAction.type !== "") return; // 级联又暂停了

    // 天亮结算中被暂停过 → 进入之前记录的白天回合
    if (this.pendingNextSeq >= 0) {
      const seq = this.pendingNextSeq;
      this.pendingNextSeq = -1;
      this.startTurn(seq);
      return;
    }

    // 还在自己的回合里（跳过技能 / 技能刚结算完）→ 回合继续，不交给对方
    this.resumeTurn();
  }

  /** 记录本夜开始时各玩家存活牌数 */
  private snapshotNightStart() {
    this.nightStartCount = {};
    this.diedThisNight.clear(); // 新的一夜：谁死过牌重新算
    this.state.players.forEach((player, id) => {
      this.nightStartCount[id] = player.handCount + player.play.length;
    });
  }

  /**
   * ★ 手牌补充：白天结束时（每轮白天 → 入夜的边界）调用。
   * 任一方手牌 ≤ DRAW_HAND_THRESHOLD 张时，从公共牌库补摸 DRAW_COUNT 张。
   * - 双方各自判定：自己手牌不够就补，不看对方手牌数。
   * - 牌库抽干为止：牌库空了自然不再补（此时牌局通常也已接近尾声）。
   */
  private replenishHands() {
    if (this.state.deck.length === 0) {
      console.log("[replenish] 牌库已空，无法补牌");
      return;
    }

    this.state.players.forEach((player, id) => {
      for (let i = 0; i < this.DRAW_COUNT; i++) {
        if (player.hand.length > this.DRAW_HAND_THRESHOLD) break;
        if (!this.canGainCard(id)) break; // ★ 手牌上限：满 8 张不再补牌
        const card = this.state.deck.shift();
        if (!card) break; // 牌库抽空
        player.hand.push(card);
        player.handCount = player.hand.length;
        console.log(
          `[replenish] ${id} 手牌不足（≤${this.DRAW_HAND_THRESHOLD}）→ 摸到 ${card.name}，` +
            `手牌 ${player.handCount} 张，牌库剩 ${this.state.deck.length} 张`
        );
      }
    });
  }

  /** 复制一张牌（跨玩家私有视图搬家专用）：字段全拷，换一个新实例 */
  private cloneCard(src: Card, owner: string): Card {
    const card = new Card();
    card.id = src.id;
    card.name = src.name;
    card.type = src.type;
    card.skill = src.skill;
    card.owner = owner;
    card.acted = src.acted;
    card.witchReviveUsed = src.witchReviveUsed;
    card.witchPoisonUsed = src.witchPoisonUsed;
    card.thiefUsed = src.thiefUsed;
    card.foolRevealed = src.foolRevealed;
    card.revealed = src.revealed;
    card.revealedAsName = src.revealedAsName;
    card.revealedAsType = src.revealedAsType;
    card.blessCharges = src.blessCharges;
    card.blessPotion = src.blessPotion;
    card.usedOnce = src.usedOnce;
    card.turnedWolf = src.turnedWolf;
    card.charmedId = src.charmedId;
    card.charmUsedTonight = src.charmUsedTonight;
    card.injured = src.injured;
    card.injuredUntil = src.injuredUntil;
    return card;
  }

  /** 给单个玩家发一条系统提示（写入折叠的事件日志，不占画面） */
  private hint(sessionId: string, text: string) {
    this.clients.find((c) => c.sessionId === sessionId)?.send("hint", { text });
  }

  /** 某张牌的【票权】：除长老外所有身份各 1 票，长老 2 票 */
  private voteWeight(card: Card): number {
    return card.skill === "elder" ? 2 : 1;
  }

  /** 某玩家手牌的总票权（白天流放资格判定） */
  private totalVotes(sessionId: string): number {
    const player = this.state.players.get(sessionId);
    if (!player) return 0;
    let votes = 0;
    player.hand.forEach((card) => {
      votes += this.voteWeight(card);
    });
    return votes;
  }

  /** 根据本夜实际死亡，更新双方"是否死过牌" */
  private recomputeLostThisNight() {
    this.state.players.forEach((player, id) => {
      const start = this.nightStartCount[id] ?? player.handCount + player.play.length;
      // ★ 数量变少（有牌进了墓地）或者"本夜真的死过一次"（天使重生后数量没变）都算
      player.lostThisNight = this.diedThisNight.has(id) || player.handCount + player.play.length < start;
    });
  }

  /**
   * 白天流放是否满足条件：本夜死过牌 且 手牌【票权】≥ EXILE_VOTE_THRESHOLD。
   * 票权：除长老外所有身份 = 1 票，长老 = 2 票。
   */
  private isExileEligible(sessionId: string): boolean {
    const player = this.state.players.get(sessionId);
    if (!player) return false;
    if (!player.lostThisNight) return false;
    return this.totalVotes(sessionId) >= this.EXILE_VOTE_THRESHOLD;
  }

  /**
   * 阶段结束：统一结算所有死亡标记（天亮时调用）
   */
  private flushDeaths() {
    if (this.deathQueue.length === 0) {
      this.checkGameOver();
      return;
    }
    console.log(`[flushDeaths] 开始结算 ${this.deathQueue.length} 个死亡标记`);
    this.resolving = true;
    this.resolveQueue();
    this.resolving = false;
  }

  // ==============================================================
  //  死亡结算引擎（标记 → 天亮统一结算）
  // ==============================================================

  /**
   * 【黑夜·标记】把一张牌标记为死亡，仅入队。
   * 牌**仍留在手牌里**（对方看不出变化），天亮时才真正移除并进墓地。
   *
   * ★ 关键规则：被标记的牌【依然可以行动】——它只是"已被判死刑、天亮才执行"，
   * 因此在它自己主人的回合里照常可以打出 / 发动技能；真正死亡发生在天亮结算。
   */
  private markDeath(
    card: Card,
    victimId: string,
    cause: string,
    killer?: { id: string; ownerId: string; skill: string }
  ) {
    card.owner = victimId;
    this.deathQueue.push({
      card,
      victimId,
      cause,
      killerId: killer?.id,
      killerOwnerId: killer?.ownerId,
      killerSkill: killer?.skill,
    });
    console.log(
      `[nightMark] ${card.name} 被标记（${cause}），天亮生效｜队列长度 ${this.deathQueue.length}`
    );
  }

  /**
   * 【结算中·立即生效】入队并立即推进结算（用于猎人开枪 / 狼王带人 / 流放的连锁）。
   */
  private pushDeath(card: Card, victimId: string, cause: string, silent = false) {
    card.owner = victimId;
    this.deathQueue.push({ card, victimId, cause, silent });
    this.resolveQueue();
  }

  /**
   * 一张被锁定（狼刀/毒药）的牌被【盗贼换走】时调用：死亡跟着牌走。
   * 不改的话，天亮结算会在原主人手牌里找不到这张牌，导致牌被"复制"一份。
   */
  /**
   * ★ 奇迹商人的强化：按神职各不相同。
   * 猎人开枪可带走 2 张（多带 1 人），女巫当场把两瓶药补满，
   * 其余神职给 1 层（多发动一次 / 免一次代价）。
   * @returns 给玩家看的强化说明
   */
  private applyBless(target: Card): string {
    if (target.skill === "hunter") {
      target.blessCharges = 1; // 不是"多开两枪"，而是这一枪带走 2 张
      return "开枪可带走 2 张手牌";
    }
    target.blessCharges = 1;
    // ★ 被强化的牌本回合可再次行动：清掉"本回合已行动"标记，
    // 否则会被 playCard 的 acted 互斥拦截（丘比特重置后再连、预言家本夜多查等都依赖它）。
    target.acted = false;
    switch (target.skill) {
      case "seer": return "本夜可多查验一张";
      case "knight": return "下一场决斗失败也不会死";
      case "necromancer": return "下次通灵可换回两张";
      case "guard": return "本夜可多守一张";
      case "cupid": {
        // ★ 丘比特：之前没连过 → 直接额外加一次链接能力；之前连过 → 视为技能重置
        // （之前的链接依旧生效，不会被清除）。两种情况都只多给一次连接机会。
        const hadLinked = target.usedOnce;
        return hadLinked
          ? "技能重置：可再连一对，旧链接依旧生效"
          : "本夜可额外连一对";
      }
      case "witchApprentice": return "下一次用药必定不失手";
      default: return "本局可多发动一次技能";
    }
  }

  /** 强化结算：奇迹商人牌回手牌并标记整局一次，然后继续本回合 */
  private finishBless(client: Client, note: string, targetName: string) {
    const player = this.state.players.get(client.sessionId)!;
    this.clearPendingAction();
    const { id: playedId, index: playedIndex } = this.takePendingCard();
    if (playedId) {
      this.returnCardToHand(client.sessionId, playedId, playedIndex);
      const back = player.hand.find((c) => c.id === playedId);
      if (back) {
        back.usedOnce = true; // ★ 整局一次
        back.acted = true;
      }
    }
    this.hint(client.sessionId, `✨ 奇迹商人：「${targetName}」得到强化（${note}）`);
    this.resumeTurn();
  }

  /** 该牌本夜是否被守卫：是则消耗掉这层守护并返回 true（狼刀被挡下） */
  private consumeGuard(ownerId: string, cardId: string): boolean {
    const ids = this.guarded.get(ownerId);
    if (!ids) return false;
    const i = ids.indexOf(cardId);
    if (i === -1) return false;
    ids.splice(i, 1);
    if (ids.length === 0) this.guarded.delete(ownerId);
    return true;
  }

  /** 入夜时轮转守卫记录：本夜的变成"上一夜的"，本夜重新计 */
  private rotateGuards() {
    this.lastGuarded = new Map<string, string[]>();
    this.guarded.forEach((ids, sid) => {
      if (ids.length > 0) this.lastGuarded.set(sid, [...ids]);
    });
    this.guarded.clear();
  }

  /** 榜样死亡 → 野孩子变狼人（之后与普通狼人无异：共用狼刀、被查验为狼） */
  private checkIdolDeath(deadCardId: string) {
    if (!this.idolId || deadCardId !== this.idolId) return;
    this.idolId = "";
    const wildId = this.wildChildId;
    this.wildChildId = "";
    if (!wildId) return;

    const ownerId = this.findCardOwner(wildId);
    if (!ownerId) return;
    const owner = this.state.players.get(ownerId)!;
    const wild =
      owner.hand.find((c) => c.id === wildId) ?? owner.play.find((c) => c.id === wildId);
    if (!wild || wild.type === "wolf") return;

    wild.type = "wolf";
    wild.turnedWolf = true; // ★ 卡面仍显示「野孩子」，右下角标「狼」
    wild.acted = false;
    console.log(`[wildChild] 榜样 ${deadCardId} 死亡 → ${ownerId} 的野孩子变狼`);
    this.hint(ownerId, "🐺 你的榜样倒下了，野孩子变成狼人");
    const oppId = this.getOtherSessionId(ownerId);
    if (oppId) this.hint(oppId, "🐺 对方的野孩子变成狼人了");
    // ★ 双方都会收到这条公开播报（弹窗提示，4 秒后自动消失）
    this.broadcast("wildChildTurned", { text: "🐺 野孩子变成了狼人" });
  }

  /**
   * 从"任意一方手牌"里取一张（丘比特用）：side 指明己方 / 对方。
   * cardId 有值时按 id 精确查找（用于回查第一步选的牌是否还在）。
   */
  private pickFromAnyHand(
    sessionId: string,
    side: string,
    index: number,
    cardId?: string
  ): Card | undefined {
    const hand =
      side === "opp"
        ? this.state.players.get(this.getOtherSessionId(sessionId) ?? "")?.hand
        : this.state.players.get(sessionId)?.hand;
    if (!hand) return undefined;
    if (cardId) return hand.find((c) => c.id === cardId);
    if (index < 0 || index >= hand.length) return undefined;
    return hand[index];
  }

  private reassignDeath(cardId: string, newCard: Card, newVictimId: string) {
    const event = this.deathQueue.find((e) => e.card.id === cardId);
    if (!event) return;
    event.card = newCard;
    event.victimId = newVictimId;
    console.log(`[thiefSwap] ${cardId} 的死亡标记转给 ${newVictimId}`);
  }

  /**
   * ★ 天使重生：任何死法都能复活一次，并摸一张手牌；重生后变白板平民。
   * （在死亡结算的开始拦截：牌不进墓地，也不触发任何死亡技能。）
   */
  private reviveAngel(card: Card, victimId: string) {
    const player = this.state.players.get(victimId);
    if (player) {
      const inHand = player.hand.some((c) => c.id === card.id);
      if (!inHand) {
        const pi = player.play.findIndex((c) => c.id === card.id);
        if (pi >= 0) player.hand.push(player.play.splice(pi, 1)[0]);
        else player.hand.push(card);
        player.playCount = player.play.length;
      }
      player.handCount = player.hand.length;
      card.owner = victimId;

      /**
       * ★ 先到行动区亮明身份再重生。
       * 用一张【副本】放进行动区（真正的那张始终留在手牌原位），
       * 否则对手按位置点选时会因为手牌少一张而错位。
       */
      const shown = this.cloneCard(card, victimId);
      shown.acted = true;
      player.play.push(shown);
      player.playCount = player.play.length;
      this.revealPlayCard(player, shown);
      this.angelShowcase.add(shown.id);
      this.clock.setTimeout(() => {
        const p = this.state.players.get(victimId);
        this.angelShowcase.delete(shown.id);
        if (!p) return;
        const si = p.play.findIndex((c) => c.id === shown.id);
        if (si >= 0) {
          p.play.splice(si, 1);
          p.playCount = p.play.length;
        }
        if (this.revealedCardId === shown.id) this.clearRevealed(p);
      }, 1200);
    }
    card.skill = ""; // 重生后就是白板平民
    card.acted = false;
    card.revealed = true; // ★ 此后这张牌对对手永久明牌
    const drawn = this.drawCard(victimId);
    this.syncOpenCards();
    console.log(
      `[angel] ${victimId} 的天使重生` +
        (drawn
          ? `，摸到 ${drawn.name}`
          : this.state.deck.length === 0
            ? "（牌库已空）"
            : `（手牌已达上限 ${this.HAND_LIMIT} 张）`)
    );
    this.hint(
      victimId,
      `👼 天使重生：你没有倒下${drawn ? `，并摸到「${drawn.name}」` : ""}`
    );
    const oppId = this.getOtherSessionId(victimId);
    if (oppId) this.hint(oppId, `👼 对方的天使亮明身份后重生了`);
  }

  /**
   * ★ 同步"永久明牌"的公开镜像：手牌是私有视图，对手看不到内容，
   * 只能靠 PlayerState.openCards 让他知道第几张是明牌、是什么牌。
   * 定时器每 100ms 跑一次；内容没变化时不写 state（不产生多余补丁）。
   */
  /**
   * ★ 同步丘比特「丘」标记：把每个玩家手牌里【被连接】的牌的槽位写进
   * PlayerState.linkedSlots（LINK_VIEW_TAG 视图控制——只有发动方收得到）。
   * 手牌顺序变动时槽位跟着更新；链接消失（一死死俩）后标记清空。
   */
  private syncLinkedSlots() {
    const linkedIds = new Set<string>();
    for (const { a, b } of this.cardLinks) {
      linkedIds.add(a);
      linkedIds.add(b);
    }
    for (const sessionId of this.state.players.keys()) {
      const p = this.state.players.get(sessionId)!;
      const slots: number[] = [];
      Array.from(p.hand).forEach((c, i) => {
        if (linkedIds.has(c.id)) slots.push(i);
      });
      const same =
        slots.length === p.linkedSlots.length &&
        slots.every((s, i) => p.linkedSlots[i] === s);
      if (same) continue;
      p.linkedSlots.clear();
      slots.forEach((s) => p.linkedSlots.push(s));
    }
  }

  /**
   * ★ 同步狼美人魅惑「爱心」标记：把每个玩家【手牌 / 行动区】里【被魅惑】的牌的槽位
   * 写进 PlayerState.charmedSlots / charmedPlaySlots。
   * （BEAUTY_VIEW_TAG 视图控制——只有魅惑发起方收得到，被魅惑者看不到）。
   * 手牌 / 行动区顺序变动时槽位跟着更新；魅惑随狼美人死亡解除后标记清空。
   */
  private syncCharmedSlots() {
    const charmedIds = new Set<string>();
    for (const sessionId of this.state.players.keys()) {
      const p = this.state.players.get(sessionId)!;
      Array.from(p.hand).concat(Array.from(p.play)).forEach((c) => {
        if (c.skill === "wolfBeauty" && c.charmedId) charmedIds.add(c.charmedId);
      });
    }
    for (const sessionId of this.state.players.keys()) {
      const p = this.state.players.get(sessionId)!;
      const handSlots: number[] = [];
      const playSlots: number[] = [];
      Array.from(p.hand).forEach((c, i) => {
        if (charmedIds.has(c.id)) handSlots.push(i);
      });
      Array.from(p.play).forEach((c, i) => {
        if (charmedIds.has(c.id)) playSlots.push(i);
      });
      const same =
        handSlots.length === p.charmedSlots.length &&
        handSlots.every((s, i) => p.charmedSlots[i] === s) &&
        playSlots.length === p.charmedPlaySlots.length &&
        playSlots.every((s, i) => p.charmedPlaySlots[i] === s);
      if (same) continue;
      p.charmedSlots.clear();
      handSlots.forEach((s) => p.charmedSlots.push(s));
      p.charmedPlaySlots.clear();
      playSlots.forEach((s) => p.charmedPlaySlots.push(s));
    }
  }

  /**
   * ★ 同步狼刀「杀」标记：把每个玩家【手牌 / 行动区】里【被狼刀标记（天亮才生效）】的牌的
   * 槽位写进 PlayerState.killedSlots / killedPlaySlots。
   * （KILL_VIEW_TAG 视图控制——只有出刀方收得到，被刀者看不到）。
   * 手牌 / 行动区顺序变动时槽位跟着更新；天亮结算（deathQueue 清空、牌进墓地）后标记自动清空。
   */
  private syncKilledSlots() {
    const killedIds = new Set<string>();
    for (const e of this.deathQueue) {
      if (e.cause === "wolfKnife") killedIds.add(e.card.id);
    }
    for (const sessionId of this.state.players.keys()) {
      const p = this.state.players.get(sessionId)!;
      const handSlots: number[] = [];
      const playSlots: number[] = [];
      Array.from(p.hand).forEach((c, i) => {
        if (killedIds.has(c.id)) handSlots.push(i);
      });
      Array.from(p.play).forEach((c, i) => {
        if (killedIds.has(c.id)) playSlots.push(i);
      });
      const same =
        handSlots.length === p.killedSlots.length &&
        handSlots.every((s, i) => p.killedSlots[i] === s) &&
        playSlots.length === p.killedPlaySlots.length &&
        playSlots.every((s, i) => p.killedPlaySlots[i] === s);
      if (same) continue;
      p.killedSlots.clear();
      handSlots.forEach((s) => p.killedSlots.push(s));
      p.killedPlaySlots.clear();
      playSlots.forEach((s) => p.killedPlaySlots.push(s));
    }
  }

  /**
   * ★ 同步女巫毒药「杀毒」标记：把每个玩家【手牌 / 行动区】里【被女巫毒药标记（天亮才生效）】的牌的
   * 槽位写进 PlayerState.poisonedSlots / poisonedPlaySlots。
   * （POISON_VIEW_TAG 视图控制——只有下毒的女巫收得到，被毒者看不到）。
   * 手牌 / 行动区顺序变动时槽位跟着更新；天亮结算（deathQueue 清空、牌进墓地）后标记自动清空。
   */
  private syncPoisonedSlots() {
    const poisonIds = new Set<string>();
    for (const e of this.deathQueue) {
      if (e.cause === "witchPoison") poisonIds.add(e.card.id);
    }
    for (const sessionId of this.state.players.keys()) {
      const p = this.state.players.get(sessionId)!;
      const handSlots: number[] = [];
      const playSlots: number[] = [];
      Array.from(p.hand).forEach((c, i) => {
        if (poisonIds.has(c.id)) handSlots.push(i);
      });
      Array.from(p.play).forEach((c, i) => {
        if (poisonIds.has(c.id)) playSlots.push(i);
      });
      const same =
        handSlots.length === p.poisonedSlots.length &&
        handSlots.every((s, i) => p.poisonedSlots[i] === s) &&
        playSlots.length === p.poisonedPlaySlots.length &&
        playSlots.every((s, i) => p.poisonedPlaySlots[i] === s);
      if (same) continue;
      p.poisonedSlots.clear();
      handSlots.forEach((s) => p.poisonedSlots.push(s));
      p.poisonedPlaySlots.clear();
      playSlots.forEach((s) => p.poisonedPlaySlots.push(s));
    }
  }

  /**
   * ★ 同步野孩子「榜」标记：把被指定为榜样的牌所在玩家的手牌 / 行动区槽位，
   * 写进该玩家 PlayerState.idolSlots / idolPlaySlots。
   * （IDOL_VIEW_TAG 视图控制——只有野孩子使用者收得到，榜样自己与其它视角看不到）。
   * 手牌 / 行动区顺序变动时槽位跟着更新；榜样死亡后 idolId 清空，标记自动消失。
   */
  private syncIdolSlots() {
    const idolId = this.idolId;
    for (const sessionId of this.state.players.keys()) {
      const p = this.state.players.get(sessionId)!;
      const handSlots: number[] = [];
      const playSlots: number[] = [];
      if (idolId) {
        Array.from(p.hand).forEach((c, i) => {
          if (c.id === idolId) handSlots.push(i);
        });
        Array.from(p.play).forEach((c, i) => {
          if (c.id === idolId) playSlots.push(i);
        });
      }
      const same =
        handSlots.length === p.idolSlots.length &&
        handSlots.every((s, i) => p.idolSlots[i] === s) &&
        playSlots.length === p.idolPlaySlots.length &&
        playSlots.every((s, i) => p.idolPlaySlots[i] === s);
      if (same) continue;
      p.idolSlots.clear();
      handSlots.forEach((s) => p.idolSlots.push(s));
      p.idolPlaySlots.clear();
      playSlots.forEach((s) => p.idolPlaySlots.push(s));
    }
  }

  private syncOpenCards() {
    let dirty = false;
    for (const sessionId of this.state.players.keys()) {
      const p = this.state.players.get(sessionId)!;
      const revealed = Array.from(p.hand)
        .map((c, slot) => ({ c, slot }))
        .filter((x) => x.c.revealed);
      if (revealed.length === 0 && p.openCards.length === 0) continue;

      // ★ 明牌显示身份：预言家查验过的牌可能带伪装身份（隐狼 → 平民）
      const shown = (x: { c: Card; slot: number }) => ({
        name: x.c.revealedAsName || x.c.name,
        type: x.c.revealedAsType || x.c.type,
      });
      const same =
        revealed.length === p.openCards.length &&
        revealed.every(
          (x, i) =>
            p.openCards[i].id === x.c.id &&
            p.openCards[i].name === shown(x).name &&
            p.openCards[i].type === shown(x).type &&
            p.openCards[i].slot === x.slot
        );
      if (same) continue;

      p.openCards.clear();
      revealed.forEach((x) => {
        const oc = new OpenCard();
        oc.id = x.c.id;
        oc.name = shown(x).name;
        oc.type = shown(x).type;
        oc.slot = x.slot;
        p.openCards.push(oc);
      });
      dirty = true;
    }
    return dirty;
  }

  /**
   * ★ 手牌上限守卫：手牌数 < HAND_LIMIT 才允许再获得新牌。
   * 统一供 drawCard / replenishHands / initGame / 各技能「获得牌」分支调用。
   */
  private canGainCard(sessionId: string): boolean {
    const player = this.state.players.get(sessionId);
    return !!player && player.hand.length < this.HAND_LIMIT;
  }

  /**
   * 从公共牌库摸一张牌给指定玩家。
   * 牌库空 / 手牌已达上限 → 返回 null（★ 上限时不消耗牌库的牌）。
   */
  private drawCard(sessionId: string): Card | null {
    if (!this.canGainCard(sessionId)) {
      const p = this.state.players.get(sessionId);
      console.log(
        `[handLimit] ${sessionId} 手牌已满 ${p ? p.hand.length : "?"}/${this.HAND_LIMIT}，本次摸牌取消（牌库不消耗）`
      );
      return null;
    }
    const card = this.state.deck.shift();
    if (!card) return null;
    const player = this.state.players.get(sessionId);
    if (!player) return null;
    card.owner = sessionId;
    card.acted = false;
    player.hand.push(card);
    player.handCount = player.hand.length;
    this.clients.find((c) => c.sessionId === sessionId)?.send("cardReturned", { cardId: card.id });
    return card;
  }

  /** 找到某张牌当前在哪位玩家手上（手牌或行动区） */
  private findCardOwner(cardId: string): string {
    for (const sessionId of this.state.players.keys()) {
      const p = this.state.players.get(sessionId)!;
      if (p.hand.some((c) => c.id === cardId) || p.play.some((c) => c.id === cardId)) {
        return sessionId;
      }
    }
    return "";
  }

  /**
   * ★ 丘比特链接：链接中的一张真死了 → 另一张跟着死（该对链接随后消失）。
   * 直接入队末尾（不递归调用 resolveQueue），由当前循环继续处理。
   * 支持多对链接（被强化的丘比特）：逐对检查，只消耗包含死者的那一对。
   */
  private enqueueLinkedDeath(deadCardId: string) {
    for (let i = this.cardLinks.length - 1; i >= 0; i--) {
      const { a, b } = this.cardLinks[i];
      if (deadCardId !== a && deadCardId !== b) continue;

      const otherId = deadCardId === a ? b : a;
      this.cardLinks.splice(i, 1);
      if (this.deathQueue.some((e) => e.card.id === otherId)) continue; // 已在队列里，不重复

      const ownerId = this.findCardOwner(otherId);
      if (!ownerId) continue;
      const owner = this.state.players.get(ownerId)!;
      const card =
        owner.hand.find((c) => c.id === otherId) ?? owner.play.find((c) => c.id === otherId);
      if (!card) continue;

      console.log(`[cupid] ${deadCardId} 死亡 → 链接的 ${otherId} 随之死亡`);
      this.hint(ownerId, `💘 生命链接：你的「${card.name}」随之倒下`);
      // ★ 因情链而死的牌【不触发死亡技能】：猎人开不了枪、狼王带不了人
      this.deathQueue.push({ card, victimId: ownerId, cause: "cupidLink", silent: true });
    }
    this.syncLinkedSlots(); // 链接消失 → 「丘」标记跟着消失
    this.syncCharmedSlots(); // 魅惑随狼美人死亡接触 → 爱心标记跟着消失
  }

  /** 当前回合的绝对序号（跨轮递增，用于"下回合"这类计时） */
  private absTurnIndex(): number {
    return (this.state.round - 1) * SEQ_LEN + this.state.turnSeq;
  }

  /** 从数组里随机取 n 个（不足 n 个则全取） */
  private pickRandom<T>(list: T[], n: number): T[] {
    const copy = [...list];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy.slice(0, n);
  }

  /**
   * ★ 狼美人死亡 → 被她魅惑的那张牌随之死亡。
   * 这条链不触发任何死亡技能（猎人开不了枪、狼王带不了人）；老流氓不受魅惑。
   */
  private enqueueCharmedDeath(beauty: Card) {
    const charmedId = beauty.charmedId;
    if (!charmedId) return;
    beauty.charmedId = "";
    const ownerId = this.findCardOwner(charmedId);
    if (!ownerId) return;
    const owner = this.state.players.get(ownerId)!;
    const target =
      owner.hand.find((c) => c.id === charmedId) ?? owner.play.find((c) => c.id === charmedId);
    if (!target) return;
    if (target.skill === "oldRogue") {
      this.hint(ownerId, "💋 老流氓不受魅惑");
      return;
    }
    if (this.deathQueue.some((e) => e.card.id === charmedId)) return;
    console.log(`[charm] 狼美人死亡 → 被魅惑的 ${target.name} 随之倒下`);
    this.hint(ownerId, `💋 你的「${target.name}」随狼美人一起倒下`);
    this.deathQueue.push({ card: target, victimId: ownerId, cause: "charm", silent: true });
  }

  /**
   * ★ 老流氓的负伤到期结算：在每个回合结束时调用，
   * 到期的负伤牌才真正死亡（此前它一直算存活，可以正常行动）。
   */
  private resolveInjured(absCur: number) {
    for (const sessionId of this.state.players.keys()) {
      const player = this.state.players.get(sessionId)!;
      const doomed = player.hand.filter(
        (c) => c.skill === "oldRogue" && c.injured && c.injuredUntil === absCur
      );
      for (const card of doomed) {
        card.injured = false;
        card.injuredUntil = 0;
        console.log(`[oldRogue] ${card.name} 负伤到期 → 真正死亡`);
        this.hint(sessionId, `🩹 你的「${card.name}」伤重不治`);
        this.pushDeath(card, sessionId, "injury");
      }
    }
  }

  /**
   * 解析死亡结算队列。
   * ★ 暂停/恢复机制：技能需要玩家选目标时设置 pendingAction 后 return【暂停】。
   */
  private resolveQueue() {
    if (this.state.pendingAction.type !== "") return;
    if (this.state.winner !== "") {
      this.deathQueue = [];
      return;
    }

    while (this.deathQueue.length > 0) {
      const event = this.deathQueue.shift()!;
      const { card, victimId, cause, silent, killerId, killerOwnerId, killerSkill } = event;

      // ★ 天使：任何死法都能重生一次（摸一张手牌），重生后变白板平民
      if (card.skill === "angel") {
        // ★ 重生不算"没死过"：她确实死了一次（牌没进墓地而已），本夜照样构成流放的前提
        this.diedThisNight.add(victimId);
        this.reviveAngel(card, victimId);
        continue;
      }

      // ★ 老流氓：第一次被杀不死，进入【负伤】状态（仍算存活），下回合结束才真正死亡
      //   （cause === "injury" 是负伤到期的那一次，不再重复负伤）
      if (card.skill === "oldRogue" && !card.injured && cause !== "injury") {
        card.injured = true;
        card.injuredUntil = this.absTurnIndex() + 1;
        console.log(`[oldRogue] ${card.name} 负伤（第 ${card.injuredUntil} 回合结束时才真死）`);
        this.hint(victimId, `🩹 你的「${card.name}」负伤，暂不算死亡`);
        const killerId = this.getOtherSessionId(victimId);
        if (killerId) this.hint(killerId, `🩹 对方的老流氓只是负伤，还没死`);
        continue;
      }

      // ★ 守卫：本夜被守护的牌免疫一次狼刀（不免疫毒药 / 流放 / 决斗等其它死法）
      //   放在结算阶段判定，这样即使狼刀标记早于守护，天亮时依然挡得下来。
      if (cause === "wolfKnife" && this.consumeGuard(victimId, card.id)) {
        this.hint(victimId, "🛡️ 你的守卫挡下了这一刀");
        const killerId = this.getOtherSessionId(victimId);
        if (killerId) this.hint(killerId, "🛡️ 对方的守卫挡下了你的狼刀");
        console.log(`[guard] ${victimId} 的守卫挡下了对 ${card.name} 的狼刀`);
        continue;
      }

      // 真正移除（标记阶段它一直留在手牌里）
      // ★ 到这一步才算"真的死过牌"：守卫挡下的不算、老流氓负伤的不算
      this.diedThisNight.add(victimId);
      // ★ 被锁定的牌在其主人回合仍可打出 → 会短暂进入行动区；
      //   正常流程结束时会回到手牌，这里兜底也查行动区，避免漏算导致它"假活"。
      const player = this.state.players.get(victimId);
      if (player) {
        const i = player.hand.findIndex((c) => c.id === card.id);
        if (i !== -1) {
          player.hand.splice(i, 1);
          player.handCount = player.hand.length;
          // ★ 真正有一张"手牌"被杀（不是行动区 / 墓地）：本整轮不再平静
          this.killedHandCardThisRound = true;
        } else {
          const j = player.play.findIndex((c) => c.id === card.id);
          if (j !== -1) {
            player.play.splice(j, 1);
            player.playCount = player.play.length;
          }
        }
      }

      // 进入墓地（★ 每个玩家各有自己的墓地，只有本人可见）
      card.owner = victimId;
      const victim = this.state.players.get(victimId);
      if (victim) victim.graveyard.push(card);
      console.log(
        `[resolveDeath] ${card.name} 进入 ${victimId} 的墓地｜死因：${cause}` +
          `｜队列剩余 ${this.deathQueue.length}`
      );

      // ★ 丘比特链接：链接中的一张真死了 → 另一张跟着死（随后链接消失）
      this.enqueueLinkedDeath(card.id);

      // ★ 狼美人：只要她死亡，最后被魅惑的那张牌随之倒下
      this.enqueueCharmedDeath(card);

      // ★ 野孩子：榜样死了 → 野孩子变狼
      this.checkIdolDeath(card.id);

      // ★ 锈剑骑士：被狼刀杀死时，临死反噬——拖走对面威胁系数最高的狼人，且不触发其技能
      if (card.skill === "rustKnight" && cause === "wolfKnife" && this.state.winner === "") {
        const oppId = this.getOtherSessionId(victimId);
        const opp = oppId ? this.state.players.get(oppId) : undefined;
        if (opp) {
          let best: Card | null = null;
          let bestScore = -1;
          const consider = (c: Card) => {
            if (this.isWolfSide(c)) {
              const s = this.wolfThreatScore(c.skill);
              if (s > bestScore) { bestScore = s; best = c; }
            }
          };
          opp.hand.forEach(consider);
          opp.play.forEach(consider);
          if (best) {
            // ★ silent：被拖走的狼【不触发自身死亡技能】（狼王带人 / 白狼王等都不发动）
            this.pushDeath(best, oppId!, "rustKnight", true);
            this.broadcast("deathSkill", { text: "⚔️ 锈剑骑士临死反噬，拖走了对方最凶的狼！" });
            console.log(`[rustKnight] 反噬拖走 ${best.name}（silent）`);
          }
        }
      }

      // ★ 种狼：用共用刀杀人对面后，从己方墓地挑一张变狼入伙（手动选择）
      if (
        cause === "wolfKnife" &&
        killerSkill === "breedWolf" &&
        killerOwnerId &&
        this.state.winner === "" &&
        this.state.pendingAction.type === ""
      ) {
        const owner = this.state.players.get(killerOwnerId);
        if (owner && owner.graveyard.length > 0) {
          this.setPendingAction(
            "breedWolf",
            killerOwnerId,
            "graveyard",
            "🐺 选择墓地一张牌，将其变为狼人加入手牌"
          );
          this.broadcast("deathSkill", { text: "🐺 种狼得手，可从墓地复活一张牌为狼人" });
          this.notifyActor(killerOwnerId);
          return; // ★ 暂停，等待选择
        }
      }

      // 死亡触发技：猎人开枪 / 狼王带人 → 需要玩家选目标 → 暂停队列
      // ★ silent（白狼王自爆）：直接跳过技能触发，不产生任何连锁
      // ★ 白狼王没有任何死亡技能：它的自爆是【白天主动】发动的，
      //   夜里被刀、白天被决斗/流放处死都只是普通死亡，不带人
      if (
        !silent &&
        (card.skill === "hunter" || card.skill === "wolfKing" || card.skill === "poisonWolf") &&
        this.state.winner === ""
      ) {
        const oppId = this.getOtherSessionId(victimId);
        const opp = oppId ? this.state.players.get(oppId) : undefined;

        if (oppId && opp && opp.hand.length > 0) {
          const type: PendingActionType =
            card.skill === "hunter" ? "hunter" : card.skill === "poisonWolf" ? "poisonWolf" : "wolfKing";
          const description =
            card.skill === "hunter"
              ? "🔫 选择对方一张手牌"
              : card.skill === "poisonWolf"
                ? "☠️ 选择对方一张手牌（毒杀）"
                : "👑 选择对方一张手牌";
          this.setPendingAction(type, victimId, "opponentHand", description);
          // ★ 双方都要知道：这是谁死了、触发了什么技能
          this.broadcast("deathSkill", {
            text:
              card.skill === "hunter"
                ? "🔫 猎人死亡 → 开枪"
                : card.skill === "poisonWolf"
                  ? "☠️ 毒狼死亡 → 毒杀带人"
                  : "👑 狼王死亡 → 带人",
          });
          // ★ 被强化的猎人：记住这张牌，选完第一个目标后继续带人
          this.pendingHunterExtra =
            card.skill === "hunter" && card.blessCharges > 0 ? card : null;
          this.notifyActor(victimId);
          console.log(
            `[skill] ${card.name} 技能触发，等待 ${victimId} 选择目标，` +
              `队列暂停（剩余 ${this.deathQueue.length} 个事件）`
          );
          return; // ★ 暂停
        }
        console.log(`[skill] ${card.name} 技能触发，但对方无手牌，技能作废`);
      }

      if (this.checkGameOver()) {
        this.deathQueue = [];
        return;
      }
    }

    this.checkGameOver();
  }

  /**
   * 胜负判定：某一方"存活牌数"为 0，另一方获胜，游戏结束。
   * 存活牌 = 手牌 + 战场上属于自己的牌（只有进墓地的牌才算失去生命；
   * 被标记但还没结算的牌仍在手牌，暂算存活）。
   * @returns 是否已产生胜者
   */
  private checkGameOver(): boolean {
    if (this.state.winner !== "") return true;
    if (this.state.players.size < 2) return false;

    for (const sessionId of this.state.players.keys()) {
      if (this.getAliveCount(sessionId) === 0) {
        const winner = this.getOtherSessionId(sessionId)!;
        this.state.winner = winner;
        this.clearPendingAction();
        this.clearTimer();
        this.state.turnOwner = "";
        this.state.turnActed = false;
        this.state.deadline = 0;
        console.log(`[gameOver] ${sessionId} 存活牌耗尽，${winner} 获胜！`);
        this.broadcast("gameOver", { winner, loser: sessionId });
        return true;
      }
    }
    return false;
  }

  /** 统一行动校验（出牌 / 用技能 / 流放前）：必须是当前行动方且本回合未结束 */
  private canAct(client: Client): boolean {
    if (this.state.winner !== "") return false;
    if (!this.gameStarted) {
      client.send("playRejected", { reason: "游戏还没开始" });
      return false;
    }
    if (this.state.pendingAction.type !== "") {
      client.send("playRejected", { reason: "请先完成当前结算" });
      return false;
    }
    if (client.sessionId !== this.state.turnOwner) {
      client.send("playRejected", { reason: "还没轮到你" });
      return false;
    }
    if (this.state.turnActed) {
      client.send("playRejected", { reason: "你已结束本回合" });
      return false;
    }
    return true;
  }

  // ==============================================================
  //  计时
  // ==============================================================

  /** 为本回合（或当前选择）开启倒计时 */
  private startTimer() {
    this.clearTimer();
    this.timer = this.clock.setTimeout(() => this.onTimerExpired(), this.turnDuration);
  }

  private clearTimer() {
    this.timer?.clear();
    this.timer = null;
  }

  /** 倒计时结束：自动跳过"选择"或"挂机的当前行动方" */
  private onTimerExpired() {
    this.timer = null;
    if (this.state.winner !== "" || !this.gameStarted) return;

    if (this.state.pendingAction.type !== "") {
      // 自动跳过当前选择（狼刀/开枪/解药/流放/毒药）
      const type = this.state.pendingAction.type;
      const actor = this.state.pendingAction.actor;
      const { id: playedId, index: playedIndex } = this.takePendingCard();
      this.clearPendingAction();
      if (playedId) this.returnCardToHand(actor, playedId, playedIndex);
      console.warn(`[timer] 超时兜底：自动跳过 ${actor} 的 ${type} 选择`);
      this.afterSelection(actor);
      return;
    }

    // 当前行动方挂机 → 自动结束回合（交给下家）
    if (this.state.turnOwner && !this.state.turnActed) {
      console.warn(`[timer] 超时：自动结束 ${this.state.turnOwner} 的回合`);
      this.endTurn(this.state.turnOwner);
    }
  }

  // ==============================================================
  //  工具方法
  // ==============================================================

  /**
   * 清理僵尸座位：state.players 里有、但已经不在 this.clients 中的玩家
   * （说明该连接已断开却没走 onLeave，会一直占着 maxClients 的名额）
   */
  private cleanupStalePlayers() {
    const alive = new Set(this.clients.map((c) => c.sessionId));
    const stale: string[] = [];
    this.state.players.forEach((_player, sessionId) => {
      if (!alive.has(sessionId)) stale.push(sessionId);
    });
    if (stale.length === 0) return;

    stale.forEach((sessionId) => this.state.players.delete(sessionId));
    console.warn(`[cleanup] 清理 ${stale.length} 个僵尸座位：${stale.join(", ")}`);

    // 如果因此对局人数不足，把房间恢复到"可重新开局"的初始态
    if (this.state.players.size < 2) {
      this.gameStarted = false;
      this.clearTimer();
      this.state.turnOwner = "";
      this.state.turnActed = false;
      this.state.turnSeq = 0;
      this.state.round = 0;
      this.state.winner = "";
      this.state.deadline = 0;
      this.state.phase = "night";
      this.pendingNextSeq = -1;
      this.clearPendingAction();
      this.deathQueue = [];
    }
  }

  /**
   * 【回收】把一张已打出的牌从行动区移回手牌。
   *
   * 规则：行动区 = "外出执行任务的临时区"，不是永久存放区。
   * 牌打出去 → 发动技能 → 结算完毕 → 立刻回到手牌，下一阶段可以再次打出。
   * 这也是为什么"行动区的牌"依然算存活：它只是临时离场，本来就还是你的牌。
   */
  private returnCardToHand(sessionId: string, cardId: string, insertAt = -1) {
    const player = this.state.players.get(sessionId);
    if (!player) return;

    const i = player.play.findIndex((c) => c.id === cardId);
    if (i === -1) return;

    const [card] = player.play.splice(i, 1);
    player.playCount = player.play.length;
    // 白天打出的牌是公开的：它一回到手牌，公开信息随之清空
    if (card.id === this.revealedCardId) this.clearRevealed(player);

    card.owner = sessionId;
    // 插回原来的位置；若不合法（期间手牌变短）则放到末尾
    if (insertAt >= 0 && insertAt <= player.hand.length) {
      player.hand.splice(insertAt, 0, card);
    } else {
      player.hand.push(card);
    }
    player.handCount = player.hand.length;

    console.log(`[return] ${card.name} 完成任务，回到 ${sessionId} 的手牌`);

    // 单独通知该客户端，便于前端播放"回手"动画
    this.clients
      .find((c) => c.sessionId === sessionId)
      ?.send("cardReturned", { cardId, name: card.name });
  }

  /** 取出并清空"待回收的牌"及其原位（避免 pending 结束后残留） */
  private takePendingCard(): { id: string; index: number } {
    const id = this.pendingCardId;
    const index = this.pendingCardIndex;
    this.pendingCardId = "";
    this.pendingCardIndex = -1;
    return { id, index };
  }

  /**
   * ★ 女巫学徒的代价：每次【真正发动】技能时，50% 概率把药泼到自己身上（天亮才生效）。
   * - 只在技能结算【之前】调用：失手 → 这瓶药【整瓶作废】，目标完全不受影响（毒不死人 / 复活不了人）。
   * - 只对 skill === "witchApprentice" 生效；正牌女巫不受影响。
   * - 药照样算用掉（witchReviveUsed / witchPoisonUsed 不退还）。
   * @returns true = 失手（调用方必须跳过技能效果）
   */
  private rollApprenticeRisk(sessionId: string, cardId: string): boolean {
    if (!cardId) return false;
    const player = this.state.players.get(sessionId);
    if (!player) return false;
    const card = player.hand.find((c) => c.id === cardId);
    if (!card || card.skill !== "witchApprentice") return false;
    // ★ 被强化的女巫学徒：这一次必定不失手（消耗掉强化）
    if (card.blessCharges > 0) {
      card.blessCharges--;
      this.hint(sessionId, "🧪 强化生效：这一次你没有失手");
      return false;
    }
    if (Math.random() >= 0.5) return false;

    this.markDeath(card, sessionId, "apprenticeRisk");
    this.hint(sessionId, "🧪 女巫学徒失手：药水泼了自己一身，技能作废（天亮你也会倒下）");
    console.log(`[apprentice] ${sessionId} 的女巫学徒失手，技能作废且把自己毒死（天亮生效）`);
    return true;
  }

  /** ★ 白天打出的牌【公开身份】：双方都能看到这张牌是什么（夜里打出的仍然私密） */
  private revealPlayCard(player: PlayerState, card: Card) {
    player.revealedName = card.name;
    player.revealedType = card.type;
    this.revealedCardId = card.id;
  }

  /** 清空某玩家的"白天公开牌"信息 */
  private clearRevealed(player?: PlayerState) {
    if (player) {
      player.revealedName = "";
      player.revealedType = "";
    }
    this.revealedCardId = "";
  }

  /** 该牌是否已被标记为死亡 */
  private isMarked(cardId: string): boolean {
    return this.deathQueue.some((e) => e.card.id === cardId);
  }

  /**
   * ★ 这张牌此刻是否算【狼人阵营】：
   *   狼牌本身（type=wolf，含隐狼 / 狼王 / 大野狼 / 白狼王 / 狼美人），
   *   以及【已经变狼的野孩子】——榜样死后它真正成了狼，夜里能独自出刀，
   *   骑士决斗会杀死它，预言家也会查验出狼。
   */
  private isWolfSide(card: Card): boolean {
    return card.type === "wolf" || card.turnedWolf === true;
  }

  // ★ 锈剑骑士反噬用的「威胁系数」排序：数值越大越危险（应被优先拖走）。
  //   排序（高→低）：白狼王 > 狼王 > 大野狼 > 毒狼 > 种狼 > 狼美人 > 隐狼 > 普通狼人
  private wolfThreatScore(skill: string): number {
    const order = [
      "whiteWolfKing", // 8
      "wolfKing", // 7
      "greatWolf", // 6
      "poisonWolf", // 5
      "breedWolf", // 4
      "wolfBeauty", // 3
      "hiddenWolf", // 2
      "", // 1（普通狼人）
    ];
    const i = order.indexOf(skill);
    return i < 0 ? 0 : order.length - i;
  }

  /**
   * 女巫在选目标阶段「跳过」时退还药剂：因为技能最终没有生效，这瓶药不算用掉。
   * （若不想退还，把这个方法体注释掉即可——那样"开了瓶就得消耗"。）
   */
  private refundWitchPotion(sessionId: string, paType: string) {
    if (paType !== "witchRevive" && paType !== "witchPoison") return;
    const cardId = this.pendingWitchCardId;
    const blessed = this.pendingWitchBlessed;
    this.pendingWitchCardId = "";
    this.pendingWitchBlessed = false;
    if (!cardId) return;
    const player = this.state.players.get(sessionId);
    if (!player) return;
    const card = player.hand.find((c) => c.id === cardId);
    if (!card) return;
    // 用强化抵的那瓶 → 退还强化层数；否则退还药水瓶本身
    if (blessed) card.blessCharges++;
    else if (paType === "witchRevive") card.witchReviveUsed = false;
    else card.witchPoisonUsed = false;
    console.log(`[witch] ${sessionId} 放弃了 ${paType}，药剂退还（可再次使用）`);
  }

  /** 某玩家手牌中"未被标记"的牌数（即当前可被刀/被毒的目标数） */
  private countKillable(sessionId: string): number {
    const player = this.state.players.get(sessionId);
    if (!player) return 0;
    let n = 0;
    player.hand.forEach((card) => {
      if (!this.isMarked(card.id)) n++;
    });
    return n;
  }

  private setPendingAction(
    type: PendingActionType,
    actor: string,
    zone: PendingZone,
    description: string
  ) {
    this.state.pendingAction.type = type;
    this.state.pendingAction.actor = actor;
    this.state.pendingAction.zone = zone;
    this.state.pendingAction.description = description;
    // 任何需要选择的目标都给一个倒计时（避免有人不选导致整局卡住）
    this.startTimer();
  }

  private clearPendingAction() {
    this.state.pendingAction.type = "";
    this.state.pendingAction.actor = "";
    this.state.pendingAction.zone = "";
    this.state.pendingAction.description = "";
    this.pendingWitchCardId = ""; // 结算结束：不再允许退还药剂
    this.pendingWitchBlessed = false;
  }

  /**
   * 给行动方单独发一条通知（提示"该你选目标了"）。
   */
  private notifyActor(sessionId: string) {
    this.clients
      .find((c) => c.sessionId === sessionId)
      ?.send("actionRequired", {
        type: this.state.pendingAction.type,
        zone: this.state.pendingAction.zone,
        description: this.state.pendingAction.description,
      });
  }

  /** 计算某玩家的存活牌数（手牌 + 自己行动区里的牌） */
  private getAliveCount(sessionId: string): number {
    const player = this.state.players.get(sessionId);
    if (!player) return 0;
    return player.handCount + player.play.length;
  }

  private createCard(id: string, name: string, type: CardType, skill: string): Card {
    const card = new Card();
    card.id = id;
    card.name = name;
    card.type = type;
    card.skill = skill;
    return card;
  }

  private shuffle<T>(arr: T[]) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
  }


  private getOtherSessionId(current: string): string | undefined {
    for (const sessionId of this.state.players.keys()) {
      if (sessionId !== current) return sessionId;
    }
    return undefined;
  }
}
