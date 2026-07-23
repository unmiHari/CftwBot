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
 *
 * 部署后：
 *   1. BotFather -> /setinline 开启 Inline Mode
 *   2. BotFather -> /setprivacy -> Disable（用于从普通群消息积累成员池）
 *   3. 将机器人加入群；建议设为管理员，以接收 chat_member 更新
 *   4. 请求 /setup，并携带 Authorization: Bearer <ADMIN_SECRET>
 *   5. 群内发送 /bind，点击“绑定此群”，然后使用 @机器人用户名
 */

const API_BASE = "https://api.telegram.org";
const DRAW_TTL_MS = 7 * 24 * 60 * 60 * 1000;
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
          usage: "在群内发送 /bind 完成绑定，然后输入 @机器人用户名",
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

        // Inline 查询和按钮回调需要尽快响应，直接等待处理完成。
        if (update.inline_query || update.callback_query) {
          await handleUpdate(update, env);
          return text("OK");
        }

        // 群消息和成员更新只用于积累成员池，可异步完成。
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
      CREATE INDEX IF NOT EXISTS idx_inline_draws_created
      ON inline_draws(created_at)
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
      "建议 /setprivacy -> Disable",
      "将机器人加入群并发送 /bind",
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
      message_text: "正在抽取……",
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

  if (data === "bind_group") {
    await handleBindCallback(callback, env);
    return;
  }

  if (data.startsWith("draw|")) {
    await handleDrawCallback(callback, env);
    return;
  }

  if (data.startsWith("wife|")) {
    await handleWifeCallback(callback, env);
    return;
  }

  await answerCallback(callback.id, env, "无效操作", true);
}

async function handleBindCallback(callback, env) {
  const message = callback.message;
  const chat = message?.chat;

  if (!chat || !isGroupChat(chat)) {
    await answerCallback(callback.id, env, "请在群组中绑定", true);
    return;
  }

  const chatId = String(chat.id);
  await upsertGroup(env.DATABASE, chat, callback.chat_instance, true);
  await upsertUser(env.DATABASE, chatId, callback.from, true);

  let importedAdmins = 0;
  try {
    const admins = await telegram(env, "getChatAdministrators", { chat_id: chat.id });
    for (const member of admins || []) {
      if (member.user) {
        await upsertUser(env.DATABASE, chatId, member.user, member.status !== "left" && member.status !== "kicked");
        importedAdmins += 1;
      }
    }
  } catch (error) {
    console.warn("Import administrators failed:", error);
  }

  await answerCallback(callback.id, env, "绑定成功");

  const count = await getGroupUserCount(env.DATABASE, chatId);
  await editCallbackText(
    callback,
    env,
    `✅ <b>本群绑定成功</b>\n\n已记录 ${count} 位成员（其中导入 ${importedAdmins} 位管理员）。\n机器人会从后续群消息和成员变更中继续积累成员。`,
    {
      inline_keyboard: [[{ text: "开始抽取", switch_inline_query_current_chat: "" }]],
    },
  );
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

  // 先结束客户端按钮加载动画；实际结果随后通过编辑消息展示。
  await answerCallback(callback.id, env, "正在抽取……");

  try {
    if (!callback.inline_message_id || !callback.chat_instance) {
      await showDrawFailure(callback, env);
      return;
    }

    const group = await env.DATABASE
      .prepare("SELECT * FROM groups WHERE chat_instance = ?1 AND active = 1 LIMIT 1")
      .bind(callback.chat_instance)
      .first();

    if (!group) {
      await showDrawFailure(callback, env);
      return;
    }

    await upsertUser(env.DATABASE, String(group.chat_id), callback.from, true);

    const selected = await env.DATABASE
      .prepare(`
        SELECT user_id, first_name, last_name, username
        FROM group_users
        WHERE chat_id = ?1 AND active = 1 AND is_bot = 0
        ORDER BY RANDOM()
        LIMIT 1
      `)
      .bind(String(group.chat_id))
      .first();

    if (!selected) {
      await showDrawFailure(callback, env);
      return;
    }

    const initiatorName = displayName(callback.from);
    const selectedName = displayName(selected);
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
        String(group.chat_id),
        callback.chat_instance,
        initiatorId,
        initiatorName,
        String(selected.user_id),
        selectedName,
        selected.username || null,
        mode === "p" ? "photo" : "text",
        Date.now(),
      )
      .run();

    const resultText = [
      `哇，${mention(initiatorId, initiatorName)}！`,
      `你的今日女友是 ${mention(String(selected.user_id), selectedName)} ~`,
    ].join("\n");

    const keyboard = {
      inline_keyboard: [[{ text: "老婆~", callback_data: `wife|${drawId}` }]],
    };

    if (mode === "p") {
      const photoFileId = await getProfilePhotoFileId(selected.user_id, env);
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

async function handleWifeCallback(callback, env) {
  const [, drawId] = (callback.data || "").split("|");
  if (!drawId) {
    await answerCallback(callback.id, env, "操作参数无效", true);
    return;
  }

  const draw = await env.DATABASE
    .prepare("SELECT * FROM inline_draws WHERE draw_id = ?1 LIMIT 1")
    .bind(drawId)
    .first();

  if (!draw || Date.now() - Number(draw.created_at) > DRAW_TTL_MS) {
    await answerCallback(callback.id, env, "这个抽取结果已经失效了~", true);
    return;
  }

  if (String(callback.from.id) !== String(draw.initiator_id)) {
    await answerCallback(callback.id, env, "只有发起人可以喊老婆~", true);
    return;
  }

  try {
    const wifeText = `${mention(String(draw.selected_user_id), draw.selected_name)} 哇，老婆~`;
    await telegram(env, "sendMessage", {
      chat_id: draw.chat_id,
      text: wifeText,
      parse_mode: "HTML",
    });
    await answerCallback(callback.id, env, "已经帮你喊老婆啦~");
  } catch (error) {
    console.error("Send wife message failed:", error);
    await answerCallback(callback.id, env, "发送失败，请确认机器人仍在群内", true);
  }
}

async function showDrawFailure(callback, env) {
  const username = await getBotUsername(env).catch(() => "");
  const keyboard = username
    ? { inline_keyboard: [[{ text: "进入机器人主页", url: `https://t.me/${username}?start=draw_error` }]] }
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

    const command = parseCommand(message.text || "");
    if (command === "bind") {
      await telegram(env, "sendMessage", {
        chat_id: chat.id,
        text: "点击下面的按钮绑定本群。绑定后，内联消息的按钮才能识别当前群组。",
        reply_markup: {
          inline_keyboard: [[{ text: "绑定此群", callback_data: "bind_group" }]],
        },
      });
      return;
    }

    if (command === "members") {
      const count = await getGroupUserCount(env.DATABASE, chatId);
      await telegram(env, "sendMessage", {
        chat_id: chat.id,
        text: `当前成员池已记录 ${count} 位非机器人成员。`,
      });
    }
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
        "这是一个群组内联抽取机器人。",
        "",
        "使用步骤：",
        "1. 将机器人加入群组",
        "2. 在群内发送 /bind 并点击绑定",
        "3. 输入 @机器人用户名，选择“每日群友”或“纯文本”",
        "",
        "为了积累更完整的成员池，请关闭 Bot Privacy Mode，或将机器人设为管理员。",
      ].join("\n"),
      reply_markup: inlineButton,
    });
  }
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

  const status = update.new_chat_member?.status;
  const active = !["left", "kicked"].includes(status);
  await upsertGroup(env.DATABASE, chat, null, active);
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
