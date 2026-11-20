import { schema, t, type SchemaType } from "@colyseus/schema";

/**
 * 手牌的私有 view tag。
 * 标记了 .view(HAND_VIEW_TAG) 的字段，只有通过 client.view.add(玩家实例, HAND_VIEW_TAG)
 * 授权过的客户端才能收到——从而实现"手牌私有化"。
 */
export const HAND_VIEW_TAG = 1;

/**
 * 丘比特连接标记的私有 view tag。
 * PlayerState.linkedSlots 标记了该 view 才可见——
 * 只有【发动丘比特技能的那一方】的客户端会被授权，从而实现
 * "被连接的牌带「丘」标记，但只有连接方看得到"。
 */
export const LINK_VIEW_TAG = 2;

/**
 * 狼美人魅惑标记的私有 view tag。
 * PlayerState.charmedSlots / charmedPlaySlots 标记了该 view 才可见——
 * 只有【发动狼美人魅惑的那一方】（魅惑者）的客户端会被授权，从而实现
 * "被魅惑的牌（在对方手上/行动区）显示爱心，但只有魅惑者看得到"。
 */
export const BEAUTY_VIEW_TAG = 3;

/**
 * 狼刀杀害标记的私有 view tag。
 * PlayerState.killedSlots / killedPlaySlots 标记了该 view 才可见——
 * 只有【出狼刀的那一方】（凶手）的客户端会被授权，从而实现
 * "对方被狼刀标记（天亮才生效）的牌在卡背显示「杀」字，但只有狼人使用者看得到"。
 * 天亮结算后该牌进墓地、deathQueue 清空，标记随之自动消失。
 */
export const KILL_VIEW_TAG = 4;

/**
 * 女巫毒杀标记的私有 view tag。
 * PlayerState.poisonedSlots / poisonedPlaySlots 标记了该 view 才可见——
 * 只有【下毒的女巫那一方】的客户端会被授权，从而实现
 * "对方被女巫毒药标记（天亮才生效）的牌在卡背显示「杀毒」二字，但只有女巫使用者看得到"。
 * 天亮结算后该牌进墓地、deathQueue 清空，标记随之自动消失。
 */
export const POISON_VIEW_TAG = 5;

/** 野孩子榜样标记：只有【野孩子使用者】客户端被授权，能看到榜样卡背的「榜」字 */
export const IDOL_VIEW_TAG = 6;

/** 卡牌类型：wolf 狼人 / villager 平民 / god 神牌 */
export type CardType = "wolf" | "villager" | "god";

/**
 * 游戏阶段（宏观昼夜，仅用于展示）：
 * - night 黑夜：按顺序由 P1、P2 各自行动（出狼人牌刀人、女巫用药）。
 *              造成的死亡只做"标记"，牌仍留在手牌里，不进墓地。
 * - day   白天：进入时先统一结算黑夜标记（进墓地 + 触发技能链 + 胜负判定），
 *              然后按顺序由 P1、P2 各自行动（满足条件可"流放"对方一张手牌）。
 */
export type Phase = "night" | "day";

/**
 * 技能类型（"" = 无技能）
 * - hunter    猎人：进入墓地时，开枪带走对方一张手牌（天亮结算时触发）
 * - wolfKing  狼王：进入墓地时，带走对方一张手牌（天亮结算时触发）
 * - witch     女巫：夜间主动使用——解药（从自己墓地复活一张牌回手牌）/ 毒药（标记对方一张牌）
 *              每瓶终身限一次（Card.witchReviveUsed / witchPoisonUsed）
 * - elder     长老：平民身份，但拥有【2 张票权】（白天投票流放时按票权计算）
 * - thief     盗贼：平民身份（1 票）。拿到它的第一个夜晚回合【强制】与对手随机一张手牌交换；
 *              换过一次后 thiefUsed = true，之后它就是一张白板平民（不再触发任何技能）
 * - greatWolf 大野狼：狼人身份，但【自带一把独立的狼刀】——不占用"狼人/狼王共用刀"，
 *              本夜即使共用刀已用过，它仍然可以再出刀杀一张牌
 * - whiteWolfKing 白狼王：狼人身份。夜里与狼人共用一把刀（普通狼）；
 *              白天可【主动自爆】——带走对方一张手牌，同时自己死亡，且双方都不触发死亡技能。
 *              ★ 它是主动技能，没有任何死亡触发技：夜里被刀、白天被决斗/流放处死都只是普通死亡
 * - seer     预言家：神职。夜里可【查验】对方一张手牌的身份（隐狼会被查验为平民）
 * - hiddenWolf 隐狼：狼人身份，其它与普通狼人无异（共用狼刀），
 *              唯一区别是【被预言家查验时显示为平民】
 * - witchApprentice 女巫学徒：神职，技能与女巫完全相同（一瓶解药 + 一瓶毒药），
 *              但【每次发动技能有 50% 概率把自己毒死】（天亮生效）
 * - knight    骑士：神职。白天【决斗】对方一张手牌：是狼人则狼死、骑士活（还能再决斗）；
 *              不是狼人则骑士自己死（隐狼按狼人判定）
 * - fool      白痴：平民身份（1 票）。白天被流放时可【翻牌免疫】放逐；
 *              翻牌后永久免疫放逐，但狼刀 / 毒药 / 自爆等其它死法照常
 * - cupid     丘比特：神职。夜里【连接】自己一张手牌与对方一张手牌的生命——
 *              其中任意一张死亡，另一张同时死亡；触发一次后链接消失
 * - angel     天使：平民身份。任何死法死亡时【重生】（每局一次）并摸一张手牌，
 *              重生后变成白板平民（此后不再重生）
 * - necromancer 通灵师：神职。夜里把自己送进墓地，换回自己墓地的一张牌，
 *              换回的那张【技能重置】（用过的药 / 已行动的标记全部清空）
 */
export type SkillType =
  | ""
  | "hunter"
  | "wolfKing"
  | "witch"
  | "elder"
  | "thief"
  | "greatWolf"
  | "whiteWolfKing"
  | "seer"
  | "hiddenWolf"
  | "witchApprentice"
  | "knight"
  | "fool"
  | "cupid"
  | "angel"
  | "necromancer"
  | "miracleMerchant"
  | "guard"
  | "wildChild"
  | "bomber"
  | "wolfBeauty"
  | "oldRogue";

/**
 * pendingAction.type —— 当前"需要玩家做出选择"的结算类型
 * - ""            无
 * - wolfKnife     狼人刀人：由出狼方选择对方一张手牌（标记为死亡，天亮才生效）
 * - hunter        猎人死亡，选择对方一张手牌开枪带走（立即生效）
 * - wolfKing      狼王死亡，选择对方一张手牌带走（立即生效）
 * - witchRevive   女巫解药，从【自己的墓地】选择一张牌复活回手牌
 * - witchPoison   女巫毒药，选择对方一张手牌标记死亡
 * - exile         流放：白天满足条件时，选择对方一张手牌直接送进墓地（立即生效）
 * - thiefSwap     盗贼出牌后，选择对方一张手牌交换（那张归你，盗贼归对方并变成白板平民）
 * - seerCheck     预言家出牌后，选择对方一张手牌查验身份
 * - whiteWolfBlast 白狼王白天主动自爆，选择对方一张手牌一起带走
 * - knightDuel   骑士白天决斗，选择对方一张手牌
 * - cupidLink1   丘比特连接第一步：选择自己一张手牌
 * - cupidLink2   丘比特连接第二步：选择对方一张手牌
 * - necromancer  通灵师：选择自己墓地的一张牌换回手牌
 */
export type PendingActionType =
  | ""
  | "wolfKnife"
  | "hunter"
  | "wolfKing"
  | "witchRevive"
  | "witchPoison"
  | "exile"
  | "thiefSwap"
  | "seerCheck"
  | "whiteWolfBlast"
  | "knightDuel"
  | "cupidLink1"
  | "cupidLink2"
  | "necromancer"
  | "merchantBless"
  | "witchBless"
  | "wolfBeautyChoice"
  | "wolfBeautyCharm"
  | "guardPick"
  | "wildChildIdol"
  | "poisonWolf" // 毒狼：死亡带走对手一张手牌（算作毒杀）
  | "breedWolf"; // 种狼：击杀后从己方墓地选一张牌变为狼人加入手牌

/**
 * pendingAction.zone —— 玩家应该从哪个区域选择目标
 * - graveyard     自己的墓地（女巫解药：选一张死掉的牌复活回手牌）
 * - opponentHand  对方的手牌（看不到具体牌，按位置编号选）
 * - hand          自己的手牌（丘比特连接）
 * - anyHand       任意一方的手牌（丘比特连接：己方 / 对方都能选，靠消息里的 side 区分）
 */
export type PendingZone = "" | "graveyard" | "opponentHand" | "hand" | "anyHand";

/**
 * 一张卡牌
 * - skill: 技能标识（"" = 无技能），决定死亡时是否触发技能
 * - owner: 归属。打出该牌的玩家 sessionId；死亡时会被设置为原持有者（墓地展示 / 女巫判定用）
 */
export const Card = schema({
  id: t.string(),           // 唯一 id，如 "wolf-3"
  name: t.string(),         // 显示名，如 "狼人"、"猎人"
  type: t.string(),         // "wolf" | "villager" | "god"
  skill: t.string().default(""),
  owner: t.string().default(""),
  /**
   * 本回合是否已经行动过（一张牌每个回合只能行动一次）。
   * 前端据此决定颜色：可行动=彩色，已行动/不可行动=灰色。
   * 手牌与行动区都是私有视图，所以只有牌的主人才看得到这个标记。
   */
  acted: t.boolean().default(false),
  /**
   * ★ 女巫两瓶药的使用记录（仅 skill === "witch" 的牌有意义）：
   * - witchReviveUsed：解药已用过（一瓶限一次）
   * - witchPoisonUsed：毒药已用过（一瓶限一次）
   * 每张女巫牌各自独立：换一张女巫，它的两瓶药都是新的。
   * 手牌 / 墓地都是私有视图，所以对方看不到你哪瓶药还在。
   */
  witchReviveUsed: t.boolean().default(false),
  witchPoisonUsed: t.boolean().default(false),
  /**
   * 盗贼是否已执行过【强制换牌】。
   * 触发一次后置 true → 之后它就只是一张白板平民（type 仍是 villager，1 票，无技能）。
   */
  thiefUsed: t.boolean().default(false),
  /**
   * 白痴是否已【翻牌】。翻牌后永久免疫流放（狼刀/毒药/自爆等死法照常）。
   */
  foolRevealed: t.boolean().default(false),
  /**
   * ★ 是否对对手【永久明牌】（天使重生的牌）。
   * 手牌是私有视图，对方看不到这张牌本身，所以还要靠 PlayerState.openCards 同步一份公开镜像。
   */
  revealed: t.boolean().default(false),
  /**
   * ★ 明牌时对外显示的身份（默认空 = 显示真实身份）。
   * 预言家查验的牌走这里：隐狼被查验后明牌也显示「平民」（伪装不穿帮）。
   */
  revealedAsName: t.string().default(""),
  revealedAsType: t.string().default(""),
  /**
   * ★ 奇迹商人的强化余量（>0 表示被强化过）：
   * 各神职按自己的方式消耗 —— 猎人=这一枪还能补带 1 张（合计带走 2 张），
   * 其余神职=还能多发动一次 / 免疫一次代价。
   */
  blessCharges: t.int32().default(0),
  /**
   * ★ 奇迹商人强化女巫时，玩家当场选择补的那一瓶："" | "revive" | "poison"。
   * 只对 skill === "witch" 的牌有意义（与 blessCharges 配套）。
   */
  blessPotion: t.string().default(""),
  /**
   * ★ 整局只能用一次的技能是否已用掉（奇迹商人的强化、野孩子指定榜样）。
   */
  usedOnce: t.boolean().default(false),
  /**
   * ★ 狼美人：当前被她魅惑的那张牌 id（每夜可换，只记最后一张）。
   * 狼美人死亡时，这张牌随之死亡（不触发死亡技能）。
   */
  charmedId: t.string().default(""),
  /**
   * ★ 狼美人：本夜是否已经发动过【魅惑】。每个黑夜回合开始重置。
   * 她一夜只有一次行动：魅惑过之后若共用狼刀已被别人用掉，这张牌就彻底不可用。
   */
  charmUsedTonight: t.boolean().default(false),
  /**
   * ★ 老流氓：被杀死时不真死，而是进入【负伤】状态（仍算存活），
   * 直到 injuredUntil 记录的那个回合结束才真正死亡。
   */
  injured: t.boolean().default(false),
  /** 负伤到期回合（绝对回合序号，见 absTurnIndex） */
  injuredUntil: t.int32().default(0),
  /**
   * ★ 野孩子变狼标记：榜样死后 type 变 wolf（共用狼刀、被查验为狼），
   * 但卡面仍显示「野孩子」，只在右下角标一个「狼」字以示区别。
   */
  turnedWolf: t.boolean().default(false),
});
export type Card = SchemaType<typeof Card>;

/**
 * 明牌镜像（公开）：把"手牌里那张永久明牌"的身份 + 所在位置同步给对手。
 * 手牌整体是私有视图，只能靠这张小表让对手知道"第 slot 张是天使"。
 */
export const OpenCard = schema({
  id: t.string(),
  name: t.string(),
  type: t.string(),
  slot: t.int32().default(0),
});
export type OpenCard = SchemaType<typeof OpenCard>;

/**
 * 玩家状态
 * - handCount: 手牌数量（公开，所有人可见）
 * - hand:      手牌明细（私有，仅本人可见，见 HAND_VIEW_TAG）
 * - playCount: 行动区牌数（公开，所有人可见）
 * - play:      行动区明细（私有，仅本人可见）——打出的牌留在自己的行动区，
 *              对方只能看到"有几张"，看不到具体是什么牌
 * - lostThisNight: 本夜是否死过牌（公开，白天流放判定用）
 * - graveyard:    墓地（私有，仅本人可见）——自己死掉的牌。
 *                 ★ 每个玩家只能看到自己的墓地，看不到对方死了哪些牌。
 *                 女巫解药就是从这个区域复活一张牌回手牌。
 */
export const PlayerState = schema({
  handCount: t.int32().default(0),
  hand: t.array(Card).view(HAND_VIEW_TAG),
  playCount: t.int32().default(0),
  play: t.array(Card).view(HAND_VIEW_TAG),
  graveyard: t.array(Card).view(HAND_VIEW_TAG),
  lostThisNight: t.boolean().default(false),
  /**
   * 白天打出的牌【公开】：白天发动技能进入行动区的牌，双方都能看到它的身份
   * （夜里打出的牌仍然只有本人可见）。结算完毕 / 回手 / 死亡时清空。
   */
  revealedName: t.string().default(""),
  revealedType: t.string().default(""),
  /**
   * 永久明牌的手牌（公开）：天使重生过的牌会一直待在这里，对手看得到它的身份与位置。
   * 由服务端 syncOpenCards() 与手牌保持同步（顺序变动时 slot 跟着更新）。
   */
  openCards: t.array(OpenCard),
  /**
   * ★ 丘比特连接标记：本玩家手牌里【被连接】的牌的槽位（下标）。
   * 视图控制（LINK_VIEW_TAG）：只有发动丘比特技能的那个客户端被授权——
   * 对方（包括被连接牌的主人）都看不到。由 syncLinkedSlots() 与手牌保持同步。
   */
  linkedSlots: t.array("int32").view(LINK_VIEW_TAG),
  /**
   * ★ 狼美人魅惑标记：本玩家【手牌】里被魅惑的牌的槽位（下标）。
   * 视图控制（BEAUTY_VIEW_TAG）：只有【魅惑发起方】被授权——
   * 被魅惑牌的主人（以及中立视角）都看不到，只有魅惑者看得到爱心。
   * 由 syncCharmedSlots() 与手牌保持同步。
   */
  charmedSlots: t.array("int32").view(BEAUTY_VIEW_TAG),
  /**
   * ★ 同上，但针对【行动区】（charm 目标也可能被对方白天打进行动区）：
   * 本玩家行动区里被魅惑的牌的槽位（下标）。
   */
  charmedPlaySlots: t.array("int32").view(BEAUTY_VIEW_TAG),
  /**
   * ★ 狼刀杀害标记：本玩家【手牌】里被狼刀标记（天亮才生效）的牌的槽位（下标）。
   * 视图控制（KILL_VIEW_TAG）：只有【出刀方】被授权——被刀者自己看不到，
   * 只有狼人使用者看得到卡背的「杀」字。由 syncKilledSlots() 与手牌保持同步。
   */
  killedSlots: t.array("int32").view(KILL_VIEW_TAG),
  /**
   * ★ 同上，但针对【行动区】（被刀的牌也可能被打进行动区）：
   * 本玩家行动区里被狼刀标记的牌的槽位（下标）。
   */
  killedPlaySlots: t.array("int32").view(KILL_VIEW_TAG),
  /**
   * ★ 女巫毒杀标记：本玩家【手牌】里被女巫毒药标记（天亮才生效）的牌的槽位（下标）。
   * 视图控制（POISON_VIEW_TAG）：只有【下毒的女巫那一方】被授权——被毒者自己看不到，
   * 只有女巫使用者看得到卡背的「杀毒」二字。由 syncPoisonedSlots() 与手牌保持同步。
   */
  poisonedSlots: t.array("int32").view(POISON_VIEW_TAG),
  /**
   * ★ 同上，但针对【行动区】（被毒的牌也可能被打进行动区）：
   * 本玩家行动区里被女巫毒药标记的牌的槽位（下标）。
   */
  poisonedPlaySlots: t.array("int32").view(POISON_VIEW_TAG),
  /**
   * ★ 野孩子榜样标记：本玩家【手牌】里【被指定为榜样】的牌的槽位（下标）。
   * 视图控制（IDOL_VIEW_TAG）：只有【野孩子使用者】被授权——
   * 榜样的主人（以及中立视角）都看不到，只有野孩子使用者看得到卡背的「榜」字。
   * 由 syncIdolSlots() 与手牌保持同步；榜样死亡清空 idolId 后标记自动消失。
   */
  idolSlots: t.array("int32").view(IDOL_VIEW_TAG),
  /**
   * ★ 同上，但针对【行动区】（榜样也可能被打进行动区）：
   * 本玩家行动区里被指定为榜样的牌的槽位（下标）。
   */
  idolPlaySlots: t.array("int32").view(IDOL_VIEW_TAG),
});
export type PlayerState = SchemaType<typeof PlayerState>;

/**
 * 待结算动作（同步给所有客户端，用于前端提示"请选择技能目标"）
 * - type/zone 决定前端应该高亮哪个区域让玩家点选
 * - actor     必须执行选择的玩家 sessionId
 */
export const PendingAction = schema({
  type: t.string().default(""),
  actor: t.string().default(""),
  zone: t.string().default(""),
  description: t.string().default(""),
});
export type PendingAction = SchemaType<typeof PendingAction>;

/**
 * 房间状态
 *
 * 回合模型（顺序制，严格一人一轮）：
 *   一回合 = P1 黑夜 → P2 黑夜 →（天亮统一结算）→ P1 白天 → P2 白天 →（入夜，round+1）
 * - phase:       宏观昼夜 "night" | "day"（仅展示用）
 * - round:       第几个夜晚（从 1 开始）
 * - turnOwner:   当前回合归属的玩家 sessionId（公开，前端据此高亮"轮到谁"）
 * - turnSeq:     当前回合在"一回合"序列中的位置 0..3（0=P1夜 1=P2夜 2=P1昼 3=P2昼）
 * - turnActed:   当前回合归属者是否已结束本回合
 * - firstPlayer: P1（先手黑夜）的 sessionId（公开，便于前端标注"先手"）
 * - deadline:    本回合结束时间戳（服务端 Date.now() 毫秒）；0 = 结算中/未开始
 * - deck:        公共牌库
 * - players:     所有玩家状态，key 为 sessionId（墓地已移入 PlayerState.graveyard，私有）
 * - pendingAction: 当前等待玩家选择的结算（"" = 无）
 * - winner:      获胜者 sessionId（"" = 游戏进行中）
 */
export const MyState = schema({
  phase: t.string().default("night"),
  round: t.int32().default(0),
  turnOwner: t.string().default(""),
  turnSeq: t.int32().default(0),
  turnActed: t.boolean().default(false),
  /**
   * 本夜"狼刀"是否已被狼人 / 狼王使用过。
   * 狼人（type=wolf）与狼王（type=wolf, skill=wolfKing）共享同一把狼刀：
   * 一旦其中任意一张狼牌发动过刀杀，本夜其它狼牌都不可再行动（出牌被拒绝）。
   * 每个黑夜回合开始时由 startTurn 重置为 false。
   */
  wolfKnifeUsed: t.boolean().default(false),
  firstPlayer: t.string().default(""),
  deadline: t.float64().default(0),
  deck: t.array(Card),
  players: t.map(PlayerState),
  pendingAction: PendingAction,
  winner: t.string().default(""),
});
export type MyState = SchemaType<typeof MyState>;
