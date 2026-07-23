/**
 * Telegram Inline “每日群友” Bot - Cloudflare Workers / Pages 单文件版
 *
 * 必需绑定/变量：
 *   DATABASE             Cloudflare D1 绑定
 *   TG_BOT_TOKEN          BotFather 提供的机器人 Token（Secret）
 *   TG_WEBHOOK_SECRET     Webhook Secret，1-256 位，仅 A-Z a-z 0-9 _ -（Secret）
 *   ADMIN_SECRET          管理接口密钥（Secret）
 *
 * 建议变量：
 *   TG_BOT_USERNAME       机器人用户名，不含 @；未配置时会通过 getMe 获取
 *   DOMAIN                自定义域名或 workers.dev 域名，可带或不带 https://
 *   DAILY_TIMEZONE         每日刷新时区，默认 Asia/Kuala_Lumpur
 *
 * 部署后：
 *   1. BotFather -> /setinline 开启 Inline Mode
 *   2. 将机器人加入群组
 *   3. 进入机器人后台网址初始化机器人 https://你的域名/setup?key=你的ADMIN_SECRET
 *   4. 在群里直接输入 @机器人用户名，选择“每日群友”或“纯文本”
 *
 * 说明：
 *   - 为了积累更完整的成员池，建议 /setprivacy -> Disable，或将机器人设为管理员。
 *   - 即使 Privacy Mode 开启，机器人仍能识别通过自身 Inline Mode 发送的消息。
 */

const API_BASE = "https://api.telegram.org";
const DRAW_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_DAILY_TIMEZONE = "Asia/Kuala_Lumpur";
const ALLOWED_UPDATES = [
  "message",
  "edited_message",
  "inline_query",
  "chosen_inline_result",
  "callback_query",
  "chat_member",
  "my_chat_member",
];

let schemaReady = false;
let cachedBotUsername = "";

export default {
  async fetch(request, env, ctx) {
    try {
      const configError = validateConfig(env);
      if (configError) {
        return text(configError, 500);
      }

      await ensureSchema(env.DATABASE);

      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/") {
        return json({
          ok: true,
          service: "Telegram Inline 每日群友 Bot",
          endpoints: ["POST /webhook", "GET /setup", "GET /webhook-info", "GET /delete-webhook"],
          usage: "将机器人加入群后，直接输入 @机器人用户名 选择选项",
        });
      }

      if (request.method === "GET" && url.pathname === "/setup") {
        if (!isAdminRequest(request, env)) return text("Unauthorized", 401);
        return handleSetup(request, env);
      }

      if (request.method === "GET" && url.pathname === "/webhook-info") {
        if (!isAdminRequest(request, env)) return text("Unauthorized", 401);
        const result = await telegram(env, "getWebhookInfo");
        return json({ ok: true, result });
      }

      if (request.method === "GET" && url.pathname === "/delete-webhook") {
        if (!isAdminRequest(request, env)) return text("Unauthorized", 401);
        const result = await telegram(env, "deleteWebhook", { drop_pending_updates: false });
        return json({ ok: true, result });
      }

      if (request.method === "POST" && url.pathname === "/webhook") {
        if (!verifyWebhookSecret(request, env)) {
          return text("Forbidden", 403);
        }

        let update;
        try {
          update = await request.json();
        } catch {
          return text("Bad Request", 400);
        }

        const claimed = await claimUpdate(env.DATABASE, update.update_id);
        if (!claimed) return text("OK");

        // Inline 查询、按钮回调，以及通过本 Bot 发送的内联消息需要立即处理。
        // 后者会把一次性 context_id 与真实群 chat_id 静默关联，取代 /bind。
        const inlineContextMessage =
          extractInlineContext(update.message) ||
          extractInlineContext(update.edited_message);

        if (update.inline_query || update.callback_query || inlineContextMessage) {
          await handleUpdate(update, env);
          return text("OK");
        }

        // 其他群消息和成员更新仅用于静默积累成员池，可异步完成。
        ctx.waitUntil(
          handleUpdate(update, env).catch((error) => {
            console.error("Background update failed:", error);
          }),
        );
        return text("OK");
      }

      return text("Not Found", 404);
    } catch (error) {
      console.error("Worker error:", error);
      return json({ ok: false, error: safeError(error) }, 500);
    }
  },
};

function validateConfig(env) {
  if (!env.DATABASE) return "缺少 D1 绑定：DATABASE";
  if (!env.TG_BOT_TOKEN) return "缺少 Secret：TG_BOT_TOKEN";
  if (!env.TG_WEBHOOK_SECRET) return "缺少 Secret：TG_WEBHOOK_SECRET";
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(env.TG_WEBHOOK_SECRET)) {
    return "TG_WEBHOOK_SECRET 格式错误：只能使用 A-Z、a-z、0-9、_、-";
  }
  if (!env.ADMIN_SECRET) return "缺少 Secret：ADMIN_SECRET";
  return "";
}

async function ensureSchema(db) {
  if (schemaReady) return;

  await db.batch([
    db.prepare(`
      CREATE TABLE IF NOT EXISTS groups (
        chat_id TEXT PRIMARY KEY,
        chat_instance TEXT UNIQUE,
        title TEXT,
        username TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS group_users (
        chat_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        first_name TEXT,
        last_name TEXT,
        username TEXT,
        is_bot INTEGER NOT NULL DEFAULT 0,
        active INTEGER NOT NULL DEFAULT 1,
        last_seen_at INTEGER NOT NULL,
        PRIMARY KEY (chat_id, user_id)
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS inline_contexts (
        context_id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        message_id INTEGER,
        initiator_id TEXT NOT NULL,
        mode TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS inline_draws (
        draw_id TEXT PRIMARY KEY,
        inline_message_id TEXT,
        chat_id TEXT NOT NULL,
        chat_instance TEXT NOT NULL,
        initiator_id TEXT NOT NULL,
        initiator_name TEXT NOT NULL,
        selected_user_id TEXT NOT NULL,
        selected_name TEXT NOT NULL,
        selected_username TEXT,
        mode TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS daily_draws (
        draw_date TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        initiator_id TEXT NOT NULL,
        initiator_name TEXT NOT NULL,
        selected_user_id TEXT NOT NULL,
        selected_name TEXT NOT NULL,
        selected_username TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (draw_date, chat_id, initiator_id)
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS app_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS processed_updates (
        update_id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL
      )
    `),
    db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_groups_chat_instance
      ON groups(chat_instance)
    `),
    db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_group_users_draw
      ON group_users(chat_id, active, is_bot)
    `),
    db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_inline_contexts_created
      ON inline_contexts(created_at)
    `),
    db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_inline_draws_created
      ON inline_draws(created_at)
    `),
    db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_daily_draws_date
      ON daily_draws(draw_date)
    `),
  ]);

  schemaReady = true;
}

async function claimUpdate(db, updateId) {
  if (updateId === undefined || updateId === null) return true;
  const result = await db
    .prepare("INSERT OR IGNORE INTO processed_updates (update_id, created_at) VALUES (?1, ?2)")
    .bind(String(updateId), Date.now())
    .run();
  return Number(result.meta?.changes || 0) > 0;
}

async function handleSetup(request, env) {
  const requestUrl = new URL(request.url);
  const webhookUrl = buildWebhookUrl(requestUrl, env);

  const result = await telegram(env, "setWebhook", {
    url: webhookUrl,
    secret_token: env.TG_WEBHOOK_SECRET,
    allowed_updates: ALLOWED_UPDATES,
    drop_pending_updates: false,
  });

  const me = await telegram(env, "getMe");
  cachedBotUsername = me.username || cachedBotUsername;

  return json({
    ok: true,
    webhook_url: webhookUrl,
    bot: {
      id: me.id,
      username: me.username,
      supports_inline_queries: me.supports_inline_queries,
      can_read_all_group_messages: me.can_read_all_group_messages,
    },
    set_webhook: result,
    next: [
      "BotFather 使用 /setinline 开启 Inline Mode",
      "将机器人加入目标群组",
      "直接输入 @机器人用户名，无需 /bind",
      "建议 /setprivacy -> Disable，以积累更完整的成员池",
    ],
  });
}

function buildWebhookUrl(requestUrl, env) {
  if (!env.DOMAIN) return `${requestUrl.origin}/webhook`;
  const domain = String(env.DOMAIN).trim().replace(/\/+$/, "");
  if (/^https?:\/\//i.test(domain)) return `${domain}/webhook`;
  return `https://${domain}/webhook`;
}

function isAdminRequest(request, env) {
  const auth = request.headers.get("Authorization") || "";
  if (auth === `Bearer ${env.ADMIN_SECRET}`) return true;
  const key = new URL(request.url).searchParams.get("key");
  return Boolean(key && key === env.ADMIN_SECRET);
}

function verifyWebhookSecret(request, env) {
  return request.headers.get("X-Telegram-Bot-Api-Secret-Token") === env.TG_WEBHOOK_SECRET;
}

async function handleUpdate(update, env) {
  if (update.inline_query) {
    await handleInlineQuery(update.inline_query, env);
    return;
  }

  if (update.callback_query) {
    await handleCallbackQuery(update.callback_query, env);
    return;
  }

  if (update.chat_member) {
    await handleChatMemberUpdate(update.chat_member, env);
    return;
  }

  if (update.my_chat_member) {
    await handleMyChatMemberUpdate(update.my_chat_member, env);
    return;
  }

  const message = update.message || update.edited_message;
  if (message) {
    await handleMessage(message, env);
  }
}

async function handleInlineQuery(query, env) {
  const today = currentDateKey(env);
  await ensureDailyReset(env.DATABASE, today);

  const queryText = String(query.query || "").trim();
  if (queryText.startsWith("wife:")) {
    await handleWifeInlineQuery(query, env, queryText.slice("wife:".length));
    return;
  }

  const initiatorId = String(query.from.id);
  const nonce = randomId(10);

  const results = [
    makeInlineResult({
      id: `photo_${nonce}`,
      title: "每日群友",
      description: "抽取你的群友，并尝试显示头像",
      mode: "p",
      initiatorId,
      nonce,
    }),
    makeInlineResult({
      id: `text_${nonce}`,
      title: "纯文本",
      description: "不加载被抽取群友的头像",
      mode: "t",
      initiatorId,
      nonce,
    }),
  ];

  await telegram(env, "answerInlineQuery", {
    inline_query_id: query.id,
    results,
    cache_time: 0,
    is_personal: true,
  });
}

function makeInlineResult({ id, title, description, mode, initiatorId, nonce }) {
  return {
    type: "article",
    id,
    title,
    description,
    input_message_content: {
      message_text: "无法查看你的聊天上下文，请点击下方按钮继续",
    },
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "点击抽取",
            callback_data: `draw|${mode}|${initiatorId}|${nonce}`,
          },
        ],
      ],
    },
  };
}

async function handleCallbackQuery(callback, env) {
  const data = callback.data || "";

  if (data.startsWith("draw|")) {
    await handleDrawCallback(callback, env);
    return;
  }

  await answerCallback(callback.id, env, "无效操作", true);
}

async function handleDrawCallback(callback, env) {
  const parts = (callback.data || "").split("|");
  if (parts.length !== 4) {
    await answerCallback(callback.id, env, "抽取参数无效", true);
    return;
  }

  const [, mode, initiatorId] = parts;
  const clickerId = String(callback.from.id);

  if (clickerId !== initiatorId) {
    await answerCallback(callback.id, env, "只有发起人可以点击抽取~", true);
    return;
  }

  await answerCallback(callback.id, env, "正在抽取……");

  try {
    if (!callback.inline_message_id) {
      await showDrawFailure(callback, env);
      return;
    }

    const nonce = parts[3];
    const context = await waitForInlineContext(env.DATABASE, nonce);

    if (!context) {
      await showDrawFailure(callback, env);
      return;
    }

    const chatId = String(context.chat_id);
    const today = currentDateKey(env);

    await ensureDailyReset(env.DATABASE, today);
    await upsertUser(env.DATABASE, chatId, callback.from, true);

    const dailyDraw = await getOrCreateDailyDraw(
      env.DATABASE,
      today,
      chatId,
      initiatorId,
      callback.from,
    );

    if (!dailyDraw) {
      await showDrawFailure(callback, env);
      return;
    }

    const initiatorName = dailyDraw.initiator_name || displayName(callback.from);
    const selectedUserId = String(dailyDraw.selected_user_id);
    const selectedName = dailyDraw.selected_name || "群友";
    const drawId = randomId(20);

    await env.DATABASE
      .prepare(`
        INSERT INTO inline_draws (
          draw_id, inline_message_id, chat_id, chat_instance,
          initiator_id, initiator_name, selected_user_id,
          selected_name, selected_username, mode, created_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
      `)
      .bind(
        drawId,
        callback.inline_message_id,
        chatId,
        callback.chat_instance || "",
        initiatorId,
        initiatorName,
        selectedUserId,
        selectedName,
        dailyDraw.selected_username || null,
        mode === "p" ? "photo" : "text",
        Date.now(),
      )
      .run();

    const resultText = [
      `哇，${mention(initiatorId, initiatorName)}！`,
      `你的今日女友是 ${mention(selectedUserId, selectedName)} ~`,
    ].join("\n");

    // Telegram 不允许 callback 按钮直接替用户发送新消息。
    // 此按钮会在当前聊天打开 Inline Mode；用户再点唯一结果后，
    // Telegram 才会以发起用户身份发送新的 via @bot 消息。
    const keyboard = {
      inline_keyboard: [
        [
          {
            text: "老婆~",
            switch_inline_query_current_chat: `wife:${drawId}`,
          },
        ],
      ],
    };

    if (mode === "p") {
      const photoFileId = await getProfilePhotoFileId(selectedUserId, env);
      if (photoFileId) {
        try {
          await telegram(env, "editMessageMedia", {
            inline_message_id: callback.inline_message_id,
            media: {
              type: "photo",
              media: photoFileId,
              caption: resultText,
              parse_mode: "HTML",
            },
            reply_markup: keyboard,
          });
          return;
        } catch (error) {
          console.warn("Avatar mode failed, falling back to text:", error);
        }
      }
    }

    await telegram(env, "editMessageText", {
      inline_message_id: callback.inline_message_id,
      text: resultText,
      parse_mode: "HTML",
      reply_markup: keyboard,
    });
  } catch (error) {
    console.error("Draw failed:", error);
    await showDrawFailure(callback, env);
  }
}

async function waitForInlineContext(db, contextId) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const context = await db
      .prepare(`
        SELECT context_id, chat_id, message_id, initiator_id, mode, created_at
        FROM inline_contexts
        WHERE context_id = ?1
        LIMIT 1
      `)
      .bind(contextId)
      .first();

    if (context) return context;
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  return null;
}

async function handleWifeInlineQuery(query, env, drawId) {
  if (!/^[A-Za-z0-9_-]{6,32}$/.test(String(drawId || ""))) {
    await answerEmptyInlineQuery(query.id, env);
    return;
  }

  const draw = await env.DATABASE
    .prepare("SELECT * FROM inline_draws WHERE draw_id = ?1 LIMIT 1")
    .bind(drawId)
    .first();

  const today = currentDateKey(env);
  const isCurrentDay =
    draw && dateKeyForTimestamp(Number(draw.created_at), env) === today;

  if (
    !draw ||
    !isCurrentDay ||
    Date.now() - Number(draw.created_at) > DRAW_TTL_MS ||
    String(query.from.id) !== String(draw.initiator_id)
  ) {
    await answerEmptyInlineQuery(query.id, env);
    return;
  }

  const wifeText = `${mention(String(draw.selected_user_id), draw.selected_name)} 哇，老婆~`;

  await telegram(env, "answerInlineQuery", {
    inline_query_id: query.id,
    results: [
      {
        type: "article",
        id: `wife_${draw.draw_id}`,
        title: `${draw.selected_name} 哇，老婆~`,
        description: "点击发送新的 via @bot 消息",
        input_message_content: {
          message_text: wifeText,
          parse_mode: "HTML",
        },
      },
    ],
    cache_time: 0,
    is_personal: true,
  });
}

async function answerEmptyInlineQuery(inlineQueryId, env) {
  await telegram(env, "answerInlineQuery", {
    inline_query_id: inlineQueryId,
    results: [],
    cache_time: 0,
    is_personal: true,
  });
}

async function ensureDailyReset(db, today) {
  const state = await db
    .prepare("SELECT value FROM app_meta WHERE key = 'daily_draw_date' LIMIT 1")
    .first();

  if (state?.value === today) return;

  // 并发时只删除非今天的数据，因此不会误删另一个请求刚写入的今日记录。
  await db.batch([
    db.prepare("DELETE FROM daily_draws WHERE draw_date <> ?1").bind(today),
    db
      .prepare(`
        INSERT INTO app_meta (key, value, updated_at)
        VALUES ('daily_draw_date', ?1, ?2)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at
      `)
      .bind(today, Date.now()),
  ]);
}

async function getOrCreateDailyDraw(db, drawDate, chatId, initiatorId, initiator) {
  let saved = await db
    .prepare(`
      SELECT *
      FROM daily_draws
      WHERE draw_date = ?1 AND chat_id = ?2 AND initiator_id = ?3
      LIMIT 1
    `)
    .bind(drawDate, chatId, initiatorId)
    .first();

  if (saved) return saved;

  const selected = await db
    .prepare(`
      SELECT user_id, first_name, last_name, username
      FROM group_users
      WHERE chat_id = ?1 AND active = 1 AND is_bot = 0
      ORDER BY RANDOM()
      LIMIT 1
    `)
    .bind(chatId)
    .first();

  if (!selected) return null;

  const initiatorName = displayName(initiator);
  const selectedName = displayName(selected);

  await db
    .prepare(`
      INSERT OR IGNORE INTO daily_draws (
        draw_date, chat_id, initiator_id, initiator_name,
        selected_user_id, selected_name, selected_username, created_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
    `)
    .bind(
      drawDate,
      chatId,
      initiatorId,
      initiatorName,
      String(selected.user_id),
      selectedName,
      selected.username || null,
      Date.now(),
    )
    .run();

  // 并发点击时，以数据库中首次成功写入的结果为准。
  saved = await db
    .prepare(`
      SELECT *
      FROM daily_draws
      WHERE draw_date = ?1 AND chat_id = ?2 AND initiator_id = ?3
      LIMIT 1
    `)
    .bind(drawDate, chatId, initiatorId)
    .first();

  return saved || null;
}

function currentDateKey(env) {
  return dateKeyForTimestamp(Date.now(), env);
}

function dateKeyForTimestamp(timestamp, env) {
  const timeZone = String(env.DAILY_TIMEZONE || DEFAULT_DAILY_TIMEZONE).trim();

  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date(timestamp));

    const values = Object.fromEntries(
      parts
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, part.value]),
    );

    return `${values.year}-${values.month}-${values.day}`;
  } catch (error) {
    console.warn(`Invalid DAILY_TIMEZONE "${timeZone}", falling back to UTC:`, error);
    return new Date(timestamp).toISOString().slice(0, 10);
  }
}

async function showDrawFailure(callback, env) {
  const username = await getBotUsername(env).catch(() => "");
  const keyboard = username
    ? { inline_keyboard: [[{ text: "进入主页", url: `https://t.me/${username}?start=draw_error` }]] }
    : undefined;

  const payload = {
    inline_message_id: callback.inline_message_id,
    text: "抽取失败了~不知道是什么原因，进入机器人主页告诉我们！",
  };
  if (keyboard) payload.reply_markup = keyboard;

  try {
    await telegram(env, "editMessageText", payload);
  } catch (error) {
    console.error("Unable to show draw failure:", error);
  }
}

async function getProfilePhotoFileId(userId, env) {
  try {
    const photos = await telegram(env, "getUserProfilePhotos", {
      user_id: Number(userId),
      offset: 0,
      limit: 1,
    });
    const sizes = photos?.photos?.[0];
    if (!Array.isArray(sizes) || sizes.length === 0) return "";
    return sizes[sizes.length - 1]?.file_id || "";
  } catch (error) {
    console.warn("getUserProfilePhotos failed:", error);
    return "";
  }
}

async function handleMessage(message, env) {
  const chat = message.chat;

  if (isGroupChat(chat)) {
    const chatId = String(chat.id);
    await upsertGroup(env.DATABASE, chat, null, true);

    if (message.from) await upsertUser(env.DATABASE, chatId, message.from, true);
    if (message.reply_to_message?.from) {
      await upsertUser(env.DATABASE, chatId, message.reply_to_message.from, true);
    }

    for (const user of message.new_chat_members || []) {
      await upsertUser(env.DATABASE, chatId, user, true);
    }

    if (message.left_chat_member) {
      await setUserActive(env.DATABASE, chatId, String(message.left_chat_member.id), false);
    }

    const inlineContext = extractInlineContext(message);
    if (inlineContext) {
      await env.DATABASE
        .prepare(`
          INSERT INTO inline_contexts (
            context_id, chat_id, message_id, initiator_id, mode, created_at
          ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
          ON CONFLICT(context_id) DO UPDATE SET
            chat_id = excluded.chat_id,
            message_id = excluded.message_id,
            initiator_id = excluded.initiator_id,
            mode = excluded.mode,
            created_at = excluded.created_at
        `)
        .bind(
          inlineContext.contextId,
          chatId,
          message.message_id || null,
          inlineContext.initiatorId,
          inlineContext.mode,
          Date.now(),
        )
        .run();
    }

    // 群消息只用于静默维护成员池和内联上下文，不发送任何机器人回复。
    return;
  }

  if (chat?.type === "private" && parseCommand(message.text || "") === "start") {
    const username = await getBotUsername(env).catch(() => "");
    const inlineButton = username
      ? { inline_keyboard: [[{ text: "使用内联模式", switch_inline_query: "" }]] }
      : undefined;

    await telegram(env, "sendMessage", {
      chat_id: chat.id,
      text: [
        "这是一个群员老婆抽取机器人。",
        "",
        "使用步骤：",
        "1. 将机器人加入群组",
        "2. 直接输入 @机器人用户名",
        "3. 选择“每日群友”或“纯文本”并发送",
        "4. 点击消息中的“点击抽取”",
        "",
        "为了积累更完整的成员池，将机器人设为管理员。(可选)",
      ].join("\n"),
      reply_markup: inlineButton,
    });
  }
}

function extractInlineContext(message) {
  const rows = message?.reply_markup?.inline_keyboard;
  if (!Array.isArray(rows)) return null;

  for (const row of rows) {
    for (const button of row || []) {
      const data = button?.callback_data;
      if (typeof data !== "string" || !data.startsWith("draw|")) continue;

      const parts = data.split("|");
      if (parts.length !== 4) continue;

      const [, mode, initiatorId, contextId] = parts;
      if (!["p", "t"].includes(mode)) continue;
      if (!/^\d+$/.test(String(initiatorId))) continue;
      if (!/^[A-Za-z0-9_-]{6,32}$/.test(String(contextId))) continue;

      return { mode, initiatorId: String(initiatorId), contextId };
    }
  }
  return null;
}

async function handleChatMemberUpdate(update, env) {
  const chat = update.chat;
  if (!isGroupChat(chat)) return;

  const chatId = String(chat.id);
  await upsertGroup(env.DATABASE, chat, null, true);

  const member = update.new_chat_member;
  const user = member?.user;
  if (!user) return;

  const active = !["left", "kicked"].includes(member.status);
  await upsertUser(env.DATABASE, chatId, user, active);
}

async function handleMyChatMemberUpdate(update, env) {
  const chat = update.chat;
  if (!isGroupChat(chat)) return;

  const chatId = String(chat.id);
  const status = update.new_chat_member?.status;
  const active = !["left", "kicked"].includes(status);
  await upsertGroup(env.DATABASE, chat, null, active);

  if (!active) return;

  // 不发送任何群消息；仅在机器人加入/权限变化时静默导入管理员。
  if (update.from) {
    await upsertUser(env.DATABASE, chatId, update.from, true);
  }

  try {
    const admins = await telegram(env, "getChatAdministrators", { chat_id: chat.id });
    for (const member of admins || []) {
      if (member?.user) {
        const memberActive = !["left", "kicked"].includes(member.status);
        await upsertUser(env.DATABASE, chatId, member.user, memberActive);
      }
    }
  } catch (error) {
    console.warn("Silent administrator import failed:", error);
  }
}

async function upsertGroup(db, chat, chatInstance, active) {
  const now = Date.now();
  await db
    .prepare(`
      INSERT INTO groups (
        chat_id, chat_instance, title, username, active, created_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
      ON CONFLICT(chat_id) DO UPDATE SET
        chat_instance = COALESCE(excluded.chat_instance, groups.chat_instance),
        title = excluded.title,
        username = excluded.username,
        active = excluded.active,
        updated_at = excluded.updated_at
    `)
    .bind(
      String(chat.id),
      chatInstance || null,
      chat.title || null,
      chat.username || null,
      active ? 1 : 0,
      now,
      now,
    )
    .run();
}

async function upsertUser(db, chatId, user, active) {
  if (!user?.id) return;
  await db
    .prepare(`
      INSERT INTO group_users (
        chat_id, user_id, first_name, last_name, username,
        is_bot, active, last_seen_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
      ON CONFLICT(chat_id, user_id) DO UPDATE SET
        first_name = excluded.first_name,
        last_name = excluded.last_name,
        username = excluded.username,
        is_bot = excluded.is_bot,
        active = excluded.active,
        last_seen_at = excluded.last_seen_at
    `)
    .bind(
      String(chatId),
      String(user.id),
      user.first_name || null,
      user.last_name || null,
      user.username || null,
      user.is_bot ? 1 : 0,
      active ? 1 : 0,
      Date.now(),
    )
    .run();
}

async function setUserActive(db, chatId, userId, active) {
  await db
    .prepare(`
      UPDATE group_users
      SET active = ?1, last_seen_at = ?2
      WHERE chat_id = ?3 AND user_id = ?4
    `)
    .bind(active ? 1 : 0, Date.now(), String(chatId), String(userId))
    .run();
}

async function getGroupUserCount(db, chatId) {
  const row = await db
    .prepare(`
      SELECT COUNT(*) AS count
      FROM group_users
      WHERE chat_id = ?1 AND active = 1 AND is_bot = 0
    `)
    .bind(String(chatId))
    .first();
  return Number(row?.count || 0);
}

async function editCallbackText(callback, env, textValue, replyMarkup) {
  const payload = {
    text: textValue,
    parse_mode: "HTML",
    reply_markup: replyMarkup,
  };

  if (callback.inline_message_id) {
    payload.inline_message_id = callback.inline_message_id;
  } else if (callback.message?.chat?.id && callback.message?.message_id) {
    payload.chat_id = callback.message.chat.id;
    payload.message_id = callback.message.message_id;
  } else {
    throw new Error("Callback message cannot be edited");
  }

  return telegram(env, "editMessageText", payload);
}

async function answerCallback(callbackQueryId, env, message = "", showAlert = false) {
  try {
    await telegram(env, "answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      text: message || undefined,
      show_alert: Boolean(showAlert),
      cache_time: 0,
    });
  } catch (error) {
    console.warn("answerCallbackQuery failed:", error);
  }
}

async function telegram(env, method, payload = {}) {
  const response = await fetch(`${API_BASE}/bot${env.TG_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(removeUndefined(payload)),
  });

  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.ok) {
    const description = data?.description || `${response.status} ${response.statusText}`;
    throw new Error(`Telegram ${method}: ${description}`);
  }
  return data.result;
}

async function getBotUsername(env) {
  const configured = String(env.TG_BOT_USERNAME || "").replace(/^@/, "").trim();
  if (configured) return configured;
  if (cachedBotUsername) return cachedBotUsername;

  const me = await telegram(env, "getMe");
  cachedBotUsername = me.username || "";
  return cachedBotUsername;
}

function parseCommand(textValue) {
  const match = String(textValue).trim().match(/^\/([a-zA-Z0-9_]+)(?:@[a-zA-Z0-9_]+)?(?:\s|$)/);
  return match ? match[1].toLowerCase() : "";
}

function isGroupChat(chat) {
  return chat?.type === "group" || chat?.type === "supergroup";
}

function displayName(user) {
  const name = [user?.first_name, user?.last_name].filter(Boolean).join(" ").trim();
  if (name) return name;
  if (user?.username) return `@${user.username}`;
  return "群友";
}

function mention(userId, name) {
  return `<a href="tg://user?id=${escapeHtml(String(userId))}">${escapeHtml(name || "群友")}</a>`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function randomId(length = 16) {
  return crypto.randomUUID().replaceAll("-", "").slice(0, length);
}

function removeUndefined(value) {
  if (Array.isArray(value)) return value.map(removeUndefined);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [key, removeUndefined(item)]),
    );
  }
  return value;
}

function safeError(error) {
  return error instanceof Error ? error.message : String(error);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function text(value, status = 200) {
  return new Response(value, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
