```js
require("dotenv").config();

const express = require("express");
const { Pool } = require("pg");

for (const name of ["DISCORD_TOKEN", "OWNER_ID", "APPROVAL_CHANNEL_ID", "DATABASE_URL"]) {
  if (!process.env[name]) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
}

const TOKEN = process.env.DISCORD_TOKEN.trim();
const API_BASE = "https://discord.com/api/v10";
const GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";

const app = express();
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

let discordSocket = null;
let discordUser = null;
let discordReady = false;
let loginInProgress = false;
let reconnectTimer = null;
let heartbeatTimer = null;
let heartbeatAcked = true;
let reconnectAttempt = 0;
let gatewaySessionId = null;
let gatewayResumeUrl = null;
let gatewaySequence = null;
let gatewayConnecting = false;

/*
========================================================
UTILITY
========================================================
*/

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isDiscordConnected() {
  return (
    discordReady &&
    !!discordSocket &&
    discordSocket.readyState === WebSocket.OPEN
  );
}

function logDiscordState() {
  console.log(
    `Discord state: ready=${discordReady}, socket=${
      discordSocket ? discordSocket.readyState : "none"
    }, user=${discordUser?.username || "none"}, session=${
      gatewaySessionId ? "yes" : "no"
    }`
  );
}

function safeTokenPreview() {
  if (!TOKEN) return "missing";
  if (TOKEN.length < 12) return `${TOKEN.slice(0, 3)}***`;
  return `${TOKEN.slice(0, 10)}...${TOKEN.slice(-4)}`;
}

/*
========================================================
DISCORD REST
========================================================
*/

async function discordFetch(path, options = {}, attempt = 0) {
  const MAX_ATTEMPTS = 5;

  const headers = {
    Authorization: `Bot ${TOKEN}`,
    "User-Agent": "All-In-One-Approver/1.0",
    ...(options.body !== undefined
      ? { "Content-Type": "application/json" }
      : {}),
    ...(options.headers || {})
  };

  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
    signal: options.signal || AbortSignal.timeout(15000)
  });

  if (response.status === 429 && attempt < MAX_ATTEMPTS) {
    let retryMs = 1000;
    let global = false;

    try {
      const data = await response.clone().json();

      if (data?.retry_after != null) {
        retryMs = Math.ceil(Number(data.retry_after) * 1000);
      }

      global = data?.global === true;
    } catch {
      const retryAfterHeader = response.headers.get("Retry-After");

      if (retryAfterHeader) {
        const seconds = Number(retryAfterHeader);
        if (Number.isFinite(seconds)) {
          retryMs = Math.ceil(seconds * 1000);
        }
      }
    }

    retryMs = Math.max(1000, retryMs);

    console.warn(
      `Discord REST rate limited${
        global ? " (GLOBAL)" : ""
      }; retrying in ${retryMs}ms (attempt ${attempt + 1}/${MAX_ATTEMPTS}).`
    );

    await sleep(retryMs);

    return discordFetch(path, options, attempt + 1);
  }

  return response;
}

async function discordJson(path, options = {}) {
  const response = await discordFetch(path, options);
  const text = await response.text();

  let data = null;

  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!response.ok) {
    const detail =
      typeof data === "string"
        ? data
        : JSON.stringify(data);

    const err = new Error(
      `Discord API ${response.status}: ${detail.slice(0, 1000)}`
    );

    err.status = response.status;
    err.discordData = data;

    throw err;
  }

  return data;
}

/*
========================================================
DATABASE
========================================================
*/

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS hub_users (
      user_id TEXT PRIMARY KEY,
      username TEXT,
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      logged_at TIMESTAMPTZ
    );

    ALTER TABLE hub_users ADD COLUMN IF NOT EXISTS logged_at TIMESTAMPTZ;

    CREATE TABLE IF NOT EXISTS permanent_whitelist (
      user_id TEXT PRIMARY KEY,
      username TEXT,
      approved_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS permanent_blacklist (
      user_id TEXT PRIMARY KEY,
      username TEXT,
      blocked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS access_sessions (
      session_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      username TEXT,
      decision TEXT NOT NULL DEFAULT 'pending',
      decided_at TIMESTAMPTZ
    );
  `);

  console.log("Database initialized.");
}

async function logNewHubUser(userId, username) {
  const id = String(userId).trim();
  const name = String(username || "unknown").trim();

  const existing = await pool.query(
    "SELECT logged_at FROM hub_users WHERE user_id = $1 LIMIT 1",
    [id]
  );

  if (existing.rowCount && existing.rows[0].logged_at) {
    return false;
  }

  const channelId = String(
    process.env.ROBLOX_LOG_CHANNEL_ID || ""
  ).trim();

  if (!channelId) {
    console.error(
      "ROBLOX_LOG_CHANNEL_ID is not set; cannot log new Roblox users."
    );
    return false;
  }

  const logRow = {
    type: 1,
    components: [
      {
        type: 2,
        custom_id: `copyid:${id}`,
        label: "Copy User ID",
        emoji: { name: "📋" },
        style: 2
      }
    ]
  };

  try {
    await discordJson(`/channels/${channelId}/messages`, {
      method: "POST",
      body: JSON.stringify({
        content: `Roblox Username: **${name}**\nUser ID: \`${id}\``,
        components: [logRow]
      })
    });
  } catch (err) {
    console.error(
      "Could not send new-user log:",
      err?.message || err
    );

    return false;
  }

  await pool.query(
    `INSERT INTO hub_users (user_id, username, logged_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (user_id)
     DO UPDATE SET username = EXCLUDED.username, logged_at = NOW()`,
    [id, name]
  );

  console.log(
    `Logged new Roblox user ${name} (${id}) to channel ${channelId}`
  );

  return true;
}

async function getPermanentStatus(userId) {
  const id = String(userId);

  const black = await pool.query(
    "SELECT 1 FROM permanent_blacklist WHERE user_id = $1 LIMIT 1",
    [id]
  );

  if (black.rowCount) {
    return "blacklisted";
  }

  const white = await pool.query(
    "SELECT 1 FROM permanent_whitelist WHERE user_id = $1 LIMIT 1",
    [id]
  );

  if (white.rowCount) {
    return "whitelisted";
  }

  return null;
}

async function getSessionDecision(userId, sessionId) {
  const result = await pool.query(
    "SELECT decision FROM access_sessions WHERE user_id = $1 AND session_id = $2 LIMIT 1",
    [String(userId), String(sessionId)]
  );

  return result.rowCount
    ? result.rows[0].decision
    : null;
}

async function setSessionDecision(
  userId,
  username,
  sessionId,
  decision
) {
  await pool.query(
    `INSERT INTO access_sessions
      (session_id, user_id, username, decision, decided_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (session_id)
     DO UPDATE SET
       user_id = EXCLUDED.user_id,
       username = EXCLUDED.username,
       decision = EXCLUDED.decision,
       decided_at = NOW()`,
    [
      String(sessionId),
      String(userId),
      String(username || "unknown"),
      String(decision)
    ]
  );
}

async function getStoredUsername(userId, fallback = "unknown") {
  const result = await pool.query(
    "SELECT username FROM hub_users WHERE user_id = $1 LIMIT 1",
    [String(userId)]
  );

  return result.rowCount && result.rows[0].username
    ? result.rows[0].username
    : String(fallback || "unknown");
}

async function addWhitelist(userId, username) {
  await pool.query(
    `INSERT INTO permanent_whitelist
      (user_id, username)
     VALUES ($1, $2)
     ON CONFLICT (user_id)
     DO UPDATE SET
       username = EXCLUDED.username,
       approved_at = NOW()`,
    [String(userId), String(username || "unknown")]
  );

  await pool.query(
    "DELETE FROM permanent_blacklist WHERE user_id = $1",
    [String(userId)]
  );
}

async function addBlacklist(userId, username) {
  await pool.query(
    `INSERT INTO permanent_blacklist
      (user_id, username)
     VALUES ($1, $2)
     ON CONFLICT (user_id)
     DO UPDATE SET
       username = EXCLUDED.username,
       blocked_at = NOW()`,
    [String(userId), String(username || "unknown")]
  );

  await pool.query(
    "DELETE FROM permanent_whitelist WHERE user_id = $1",
    [String(userId)]
  );

  await pool.query(
    "DELETE FROM access_sessions WHERE user_id = $1",
    [String(userId)]
  );
}

async function removeWhitelist(userId) {
  const result = await pool.query(
    "DELETE FROM permanent_whitelist WHERE user_id = $1",
    [String(userId)]
  );

  return result.rowCount > 0;
}

async function removeBlacklist(userId) {
  const result = await pool.query(
    "DELETE FROM permanent_blacklist WHERE user_id = $1",
    [String(userId)]
  );

  return result.rowCount > 0;
}

async function getLists() {
  const white = await pool.query(
    "SELECT user_id, username, approved_at FROM permanent_whitelist ORDER BY approved_at DESC"
  );

  const black = await pool.query(
    "SELECT user_id, username, blocked_at FROM permanent_blacklist ORDER BY blocked_at DESC"
  );

  return {
    whitelist: white.rows,
    blacklist: black.rows
  };
}

/*
========================================================
EMBEDS / BUTTONS
========================================================
*/

function makeEmbed(
  title,
  description,
  fields = [],
  color = 0xff3333
) {
  return {
    title,
    description,
    fields,
    color,
    timestamp: new Date().toISOString()
  };
}

function makeAccessRequestEmbed({
  username,
  userId,
  displayName,
  place,
  jobId,
  placeId,
  sessionId
}) {
  return makeEmbed(
    "Hub Access Request",
    `**${displayName || username}** (\`${username}\`) wants to open the hub.`,
    [
      {
        name: "Roblox User",
        value: String(username),
        inline: true
      },
      {
        name: "UserId",
        value: String(userId),
        inline: true
      },
      {
        name: "Place",
        value: String(place || "unknown"),
        inline: true
      },
      {
        name: "Place ID",
        value: String(placeId || "unknown"),
        inline: true
      },
      {
        name: "Session",
        value: `\`${String(sessionId).slice(0, 24)}\``,
        inline: false
      },
      {
        name: "Server",
        value: jobId ? `\`${jobId}\`` : "n/a",
        inline: false
      }
    ]
  );
}

function makeAccessButtons(userId, sessionId) {
  return [
    {
      type: 1,
      components: [
        {
          type: 2,
          custom_id: `accept:${userId}:${sessionId}`,
          label: "Accept",
          style: 3
        },
        {
          type: 2,
          custom_id: `deny:${userId}:${sessionId}`,
          label: "Deny",
          style: 4
        },
        {
          type: 2,
          custom_id: `whitelist:${userId}:${sessionId}`,
          label: "Whitelist",
          style: 1
        },
        {
          type: 2,
          custom_id: `blacklist:${userId}:${sessionId}`,
          label: "Blacklist",
          style: 2
        }
      ]
    }
  ];
}

/*
========================================================
OWNER DM
========================================================
*/

async function createOwnerDm() {
  const data = await discordJson("/users/@me/channels", {
    method: "POST",
    body: JSON.stringify({
      recipient_id: String(process.env.OWNER_ID)
    })
  });

  return data.id;
}

async function sendOwnerAccessRequest(payload) {
  const channelId = await createOwnerDm();

  return discordJson(`/channels/${channelId}/messages`, {
    method: "POST",
    body: JSON.stringify({
      embeds: [makeAccessRequestEmbed(payload)],
      components: makeAccessButtons(
        payload.userId,
        payload.sessionId
      )
    })
  });
}

/*
========================================================
INTERACTIONS
========================================================
*/

async function interactionCallback(
  interactionId,
  interactionToken,
  data
) {
  return discordJson(
    `/interactions/${interactionId}/${interactionToken}/callback`,
    {
      method: "POST",
      body: JSON.stringify(data)
    }
  );
}

async function interactionReply(
  interaction,
  content,
  extra = {}
) {
  return interactionCallback(
    interaction.id,
    interaction.token,
    {
      type: 4,
      data: {
        content,
        ...extra
      }
    }
  );
}

async function interactionDefer(interaction) {
  return interactionCallback(
    interaction.id,
    interaction.token,
    {
      type: 5,
      data: {
        flags: 64
      }
    }
  );
}

async function interactionEditOriginal(
  interaction,
  data
) {
  return discordJson(
    `/webhooks/${discordUser.id}/${interaction.token}/messages/@original`,
    {
      method: "PATCH",
      body: JSON.stringify(data)
    }
  );
}

async function interactionUpdate(
  interaction,
  data
) {
  return interactionCallback(
    interaction.id,
    interaction.token,
    {
      type: 7,
      data
    }
  );
}

function getOption(interaction, name) {
  const option = interaction?.data?.options?.find(
    o => o.name === name
  );

  return option?.value != null
    ? String(option.value)
    : null;
}

/*
========================================================
INTERACTION HANDLER
========================================================
*/

async function handleInteraction(interaction) {
  const type = interaction.type;

  /*
  Application command
  */

  if (type === 2) {
    const userId = String(
      interaction.member?.user?.id ||
      interaction.user?.id ||
      ""
    );

    if (userId !== String(process.env.OWNER_ID)) {
      return interactionReply(
        interaction,
        "Only the owner can use these commands.",
        { flags: 64 }
      );
    }

    const command = String(
      interaction.data?.name || ""
    );

    const robloxUserId = getOption(
      interaction,
      "user_id"
    )?.trim();

    const username =
      getOption(interaction, "username")?.trim() ||
      "unknown";

    await interactionDefer(interaction);

    try {
      if (command === "whitelist") {
        if (!/^\d+$/.test(robloxUserId || "")) {
          return interactionEditOriginal(
            interaction,
            {
              content:
                "❌ Invalid Roblox UserId. Use the numeric UserId."
            }
          );
        }

        await addWhitelist(
          robloxUserId,
          username
        );

        return interactionEditOriginal(
          interaction,
          {
            content:
              `✅ Permanently whitelisted \`${username}\` ` +
              `(UserId: \`${robloxUserId}\`).`
          }
        );
      }

      if (command === "blacklist") {
        if (!/^\d+$/.test(robloxUserId || "")) {
          return interactionEditOriginal(
            interaction,
            {
              content:
                "❌ Invalid Roblox UserId. Use the numeric UserId."
            }
          );
        }

        await addBlacklist(
          robloxUserId,
          username
        );

        return interactionEditOriginal(
          interaction,
          {
            content:
              `⛔ Permanently blacklisted \`${username}\` ` +
              `(UserId: \`${robloxUserId}\`).`
          }
        );
      }

      if (command === "unwhitelist") {
        if (!/^\d+$/.test(robloxUserId || "")) {
          return interactionEditOriginal(
            interaction,
            {
              content:
                "❌ Invalid Roblox UserId. Use the numeric UserId."
            }
          );
        }

        const removed =
          await removeWhitelist(
            robloxUserId
          );

        return interactionEditOriginal(
          interaction,
          {
            content: removed
              ? `✅ Removed UserId \`${robloxUserId}\` from the permanent whitelist.`
              : `ℹ️ UserId \`${robloxUserId}\` was not on the permanent whitelist.`
          }
        );
      }

      if (command === "unblacklist") {
        if (!/^\d+$/.test(robloxUserId || "")) {
          return interactionEditOriginal(
            interaction,
            {
              content:
                "❌ Invalid Roblox UserId. Use the numeric UserId."
            }
          );
        }

        const removed =
          await removeBlacklist(
            robloxUserId
          );

        return interactionEditOriginal(
          interaction,
          {
            content: removed
              ? `✅ Removed UserId \`${robloxUserId}\` from the permanent blacklist.`
              : `ℹ️ UserId \`${robloxUserId}\` was not on the permanent blacklist.`
          }
        );
      }

      if (command === "list") {
        const {
          whitelist,
          blacklist
        } = await getLists();

        const format = rows =>
          rows.length
            ? rows
                .map(
                  r =>
                    `\`${r.user_id}\` — ${
                      r.username || "unknown"
                    }`
                )
                .join("\n")
                .slice(0, 1024)
            : "None";

        return interactionEditOriginal(
          interaction,
          {
            embeds: [
              {
                title: "Current Access Lists",
                fields: [
                  {
                    name: `✅ Whitelist (${whitelist.length})`,
                    value: format(whitelist),
                    inline: false
                  },
                  {
                    name: `⛔ Blacklist (${blacklist.length})`,
                    value: format(blacklist),
                    inline: false
                  }
                ],
                color: 0x5865f2,
                timestamp: new Date().toISOString()
              }
            ]
          }
        );
      }

      return interactionEditOriginal(
        interaction,
        {
          content: "Unknown command."
        }
      );
    } catch (err) {
      console.error(
        "slash command error:",
        err?.stack || err
      );

      return interactionEditOriginal(
        interaction,
        {
          content:
            "❌ Database error while running that command."
        }
      ).catch(() => {});
    }
  }

  /*
  Message component / button
  */

  if (type !== 3) return;

  const componentUserId = String(
    interaction.member?.user?.id ||
    interaction.user?.id ||
    ""
  );

  const customId = String(
    interaction.data?.custom_id || ""
  );

  /*
  Copy User ID button
  */

  if (customId.startsWith("copyid:")) {
    if (
      componentUserId !==
      String(process.env.OWNER_ID)
    ) {
      return interactionReply(
        interaction,
        "Only the owner can use this button.",
        { flags: 64 }
      );
    }

    const userId = customId.slice(
      "copyid:".length
    );

    if (!/^\d+$/.test(userId)) {
      return interactionReply(
        interaction,
        "❌ Invalid Roblox UserId.",
        { flags: 64 }
      );
    }

    return interactionReply(
      interaction,
      `📋 **Roblox UserId**\n\`\`\`text\n${userId}\n\`\`\`\nUse Discord's copy button on the code block to copy it.`,
      { flags: 64 }
    );
  }

  if (
    componentUserId !==
    String(process.env.OWNER_ID)
  ) {
    return interactionReply(
      interaction,
      "Only the owner can use these buttons.",
      { flags: 64 }
    );
  }

  const parts = customId.split(":");

  const action = parts[0];
  const userId = parts[1];
  const sessionId = parts[2];

  if (
    ![
      "accept",
      "deny",
      "whitelist",
      "blacklist"
    ].includes(action) ||
    !userId ||
    !sessionId
  ) {
    return interactionReply(
      interaction,
      "Unknown button action.",
      { flags: 64 }
    );
  }

  try {
    const message = interaction.message;

    const username =
      await getStoredUsername(
        userId,
        "unknown"
      );

    if (action === "accept") {
      await setSessionDecision(
        userId,
        username,
        sessionId,
        "accepted"
      );

      return interactionUpdate(
        interaction,
        {
          content:
            `✅ **Accepted for this session only** — \`${username}\`\n` +
            `This does NOT whitelist them.`,
          embeds: message?.embeds || [],
          components: []
        }
      );
    }

    if (action === "deny") {
      await setSessionDecision(
        userId,
        username,
        sessionId,
        "denied"
      );

      return interactionUpdate(
        interaction,
        {
          content:
            `❌ **Denied** — \`${username}\`\n` +
            `This does NOT blacklist them.`,
          embeds: message?.embeds || [],
          components: []
        }
      );
    }

    if (action === "whitelist") {
      await addWhitelist(
        userId,
        username
      );

      await setSessionDecision(
        userId,
        username,
        sessionId,
        "accepted"
      );

      return interactionUpdate(
        interaction,
        {
          content:
            `✅ **Whitelisted permanently** — \`${username}\``,
          embeds: message?.embeds || [],
          components: []
        }
      );
    }

    if (action === "blacklist") {
      await addBlacklist(
        userId,
        username
      );

      return interactionUpdate(
        interaction,
        {
          content:
            `⛔ **Blacklisted permanently** — \`${username}\``,
          embeds: message?.embeds || [],
          components: []
        }
      );
    }
  } catch (err) {
    console.error(
      "interaction error:",
      err?.stack || err
    );

    return interactionReply(
      interaction,
      "Database error while updating this request.",
      { flags: 64 }
    ).catch(() => {});
  }
}

/*
========================================================
GATEWAY
========================================================
*/

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
  }

  heartbeatTimer = null;
  heartbeatAcked = true;
}

function startHeartbeat(intervalMs) {
  stopHeartbeat();

  const sendHeartbeat = () => {
    if (
      !discordSocket ||
      discordSocket.readyState !== WebSocket.OPEN
    ) {
      return;
    }

    if (!heartbeatAcked) {
      console.warn(
        "Discord heartbeat was not acknowledged; reconnecting."
      );

      try {
        discordSocket.close(
          4000,
          "Heartbeat timeout"
        );
      } catch {}

      return;
    }

    heartbeatAcked = false;

    discordSocket.send(
      JSON.stringify({
        op: 1,
        d: gatewaySequence
      })
    );
  };

  heartbeatTimer = setInterval(
    sendHeartbeat,
    intervalMs
  );

  sendHeartbeat();
}

function sendGateway(payload) {
  if (
    !discordSocket ||
    discordSocket.readyState !== WebSocket.OPEN
  ) {
    throw new Error(
      "Discord Gateway socket is not open."
    );
  }

  discordSocket.send(
    JSON.stringify(payload)
  );
}

function identifyGateway() {
  console.log(
    "Discord Gateway: sending IDENTIFY..."
  );

  sendGateway({
    op: 2,
    d: {
      token: TOKEN,
      intents: 1,
      properties: {
        os: "linux",
        browser: "all-in-one-approver",
        device: "all-in-one-approver"
      }
    }
  });
}

function resumeGateway() {
  console.log(
    "Discord Gateway: sending RESUME..."
  );

  sendGateway({
    op: 6,
    d: {
      token: TOKEN,
      session_id: gatewaySessionId,
      seq: gatewaySequence
    }
  });
}

async function handleGatewayDispatch(data) {
  if (data.s != null) {
    gatewaySequence = data.s;
  }

  switch (data.t) {
    case "READY":
      discordReady = true;
      loginInProgress = false;
      reconnectAttempt = 0;

      discordUser = data.d?.user || null;

      gatewaySessionId =
        data.d?.session_id || null;

      gatewayResumeUrl =
        data.d?.resume_gateway_url ||
        "wss://gateway.discord.gg";

      console.log(
        `Discord Gateway READY as ${
          discordUser?.username || "unknown"
        } (${discordUser?.id || "unknown"}).`
      );

      console.log(
        `Discord Gateway session established. Guilds in READY: ${
          data.d?.guilds?.length ?? 0
        }`
      );

      logDiscordState();

      /*
      IMPORTANT:
      Slash-command registration has intentionally
      been removed.

      The commands already registered in Discord
      will continue to work, but the bot will no
      longer repeatedly PUT the commands every
      time it reconnects.
      */

      break;

    case "RESUMED":
      discordReady = true;
      loginInProgress = false;
      reconnectAttempt = 0;

      console.log(
        "Discord Gateway session RESUMED."
      );

      logDiscordState();

      break;

    case "INTERACTION_CREATE":
      handleInteraction(data.d).catch(err => {
        console.error(
          "Unhandled interaction error:",
          err?.stack || err
        );
      });

      break;

    case "RECONNECT":
      console.warn(
        "Discord Gateway requested a reconnect."
      );

      try {
        discordSocket?.close(
          4000,
          "Discord requested reconnect"
        );
      } catch {}

      break;

    case "INVALID_SESSION":
      console.warn(
        `Discord Gateway INVALID_SESSION (resumable=${!!data.d}).`
      );

      gatewaySessionId = null;
      gatewaySequence = null;
      gatewayResumeUrl = null;

      try {
        discordSocket?.close(
          4000,
          "Invalid session"
        );
      } catch {}

      break;

    default:
      break;
  }
}

function parseGatewayMessage(raw) {
  try {
    if (typeof raw === "string") {
      return JSON.parse(raw);
    }

    if (raw instanceof ArrayBuffer) {
      return JSON.parse(
        Buffer.from(raw).toString("utf8")
      );
    }

    if (ArrayBuffer.isView(raw)) {
      return JSON.parse(
        Buffer.from(
          raw.buffer,
          raw.byteOffset,
          raw.byteLength
        ).toString("utf8")
      );
    }

    return JSON.parse(String(raw));
  } catch (err) {
    console.error(
      "Could not parse Discord Gateway message:",
      err?.message || err
    );

    return null;
  }
}

function connectGateway(reason = "startup") {
  if (
    gatewayConnecting ||
    isDiscordConnected()
  ) {
    return;
  }

  gatewayConnecting = true;
  loginInProgress = true;
  discordReady = false;

  console.log(
    `Attempting direct Discord Gateway connection (${reason})...`
  );

  console.log(
    `Token exists: ${!!TOKEN}; token length: ${TOKEN.length}`
  );

  console.log(
    "Using Node built-in WebSocket; discord.js Gateway client is bypassed."
  );

  let socket;

  try {
    socket = new WebSocket(
      GATEWAY_URL
    );
  } catch (err) {
    gatewayConnecting = false;
    loginInProgress = false;

    console.error(
      "Could not create Discord WebSocket:",
      err?.stack || err
    );

    scheduleReconnect();

    return;
  }

  discordSocket = socket;

  socket.addEventListener(
    "open",
    () => {
      console.log(
        "Discord Gateway WebSocket: OPEN"
      );
    }
  );

  socket.addEventListener(
    "message",
    async event => {
      const data =
        parseGatewayMessage(
          event.data
        );

      if (!data) return;

      if (data.op === 10) {
        console.log(
          `Discord Gateway HELLO received. Heartbeat interval: ${data.d?.heartbeat_interval}ms`
        );

        gatewayConnecting = false;

        startHeartbeat(
          Number(
            data.d.heartbeat_interval
          )
        );

        if (
          gatewaySessionId &&
          gatewaySequence != null
        ) {
          resumeGateway();
        } else {
          identifyGateway();
        }

        return;
      }

      if (data.op === 11) {
        heartbeatAcked = true;
        return;
      }

      if (data.op === 0) {
        await handleGatewayDispatch(
          data
        );

        return;
      }

      if (data.op === 1) {
        heartbeatAcked = false;

        sendGateway({
          op: 1,
          d: gatewaySequence
        });

        return;
      }

      if (data.op === 7) {
        console.warn(
          "Discord Gateway OP 7 RECONNECT received."
        );

        try {
          socket.close(
            4000,
            "Reconnect requested"
          );
        } catch {}

        return;
      }

      if (data.op === 9) {
        console.warn(
          `Discord Gateway OP 9 INVALID_SESSION received (resumable=${!!data.d}).`
        );

        if (!data.d) {
          gatewaySessionId = null;
          gatewaySequence = null;
          gatewayResumeUrl = null;
        }

        setTimeout(() => {
          try {
            socket.close(
              4000,
              "Invalid session"
            );
          } catch {}
        }, data.d ? 1000 : 3000);
      }
    }
  );

  socket.addEventListener(
    "error",
    event => {
      console.error(
        "Discord Gateway WebSocket error:",
        event?.error?.message ||
          event?.message ||
          "WebSocket error"
      );
    }
  );

  socket.addEventListener(
    "close",
    event => {
      stopHeartbeat();

      const wasReady =
        discordReady;

      discordReady = false;
      gatewayConnecting = false;
      loginInProgress = false;

      console.error(
        `Discord Gateway CLOSED: code=${event.code}, reason=${
          event.reason || "none"
        }, wasReady=${wasReady}`
      );

      if (
        discordSocket === socket
      ) {
        discordSocket = null;
      }

      logDiscordState();

      scheduleReconnect();
    }
  );
}

function scheduleReconnect() {
  if (
    reconnectTimer ||
    isDiscordConnected()
  ) {
    return;
  }

  reconnectAttempt += 1;

  const delay = Math.min(
    300000,
    5000 *
      Math.pow(
        2,
        Math.min(
          reconnectAttempt - 1,
          5
        )
      )
  );

  console.log(
    `Discord reconnect attempt #${reconnectAttempt} scheduled in ${Math.round(
      delay / 1000
    )} seconds.`
  );

  reconnectTimer =
    setTimeout(() => {
      reconnectTimer = null;

      connectGateway(
        `automatic retry #${reconnectAttempt}`
      );
    }, delay);
}

/*
========================================================
DISCORD NETWORK CHECK
========================================================
*/

async function checkDiscordNetwork() {
  console.log(
    "\n========================================"
  );

  console.log(
    "Discord network diagnostic starting..."
  );

  console.log(
    "========================================"
  );

  try {
    const gateway = await fetch(
      "https://discord.com/api/v10/gateway",
      {
        headers: {
          "User-Agent":
            "All-In-One-Approver/1.0"
        },
        signal:
          AbortSignal.timeout(10000)
      }
    );

    console.log(
      `Discord HTTPS gateway check: HTTP ${gateway.status}`
    );

    if (!gateway.ok) {
      console.error(
        (
          await gateway.text()
        ).slice(0, 500)
      );
    }
  } catch (err) {
    console.error(
      `Discord HTTPS check failed: ${
        err?.name || "Error"
      }: ${err?.message || err}`
    );
  }

  console.log(
    "========================================"
  );

  console.log(
    "Discord network diagnostic finished."
  );

  console.log(
    "========================================\n"
  );
}

/*
========================================================
HTTP ROUTES
========================================================
*/

app.get("/", (_req, res) => {
  res.status(200).send(
    isDiscordConnected()
      ? "All-In-One Approver is online and connected to Discord."
      : "All-In-One Approver web service is online, but the Discord bot is not connected."
  );
});

app.get("/wake", (_req, res) => {
  if (isDiscordConnected()) {
    return res.status(200).json({
      ok: true,
      connected: true,
      message:
        "Discord bot is already online."
    });
  }

  if (
    loginInProgress ||
    gatewayConnecting
  ) {
    return res.status(202).json({
      ok: true,
      connected: false,
      message:
        "Discord Gateway connection is already in progress. Check /health or Render logs."
    });
  }

  connectGateway("/wake");

  return res.status(202).json({
    ok: true,
    connected: false,
    message:
      "Discord Gateway connection started in the background. Check /health."
  });
});

app.get("/health", (_req, res) =>
  res.json({
    ok: true,
    discordConnected:
      isDiscordConnected(),
    discordUser: discordUser
      ? `${discordUser.username}${
          discordUser.discriminator &&
          discordUser.discriminator !== "0"
            ? `#${discordUser.discriminator}`
            : ""
        }`
      : null,
    gatewaySession:
      !!gatewaySessionId
  })
);

app.get("/check", async (req, res) => {
  try {
    const userId = String(
      req.query.userId || ""
    ).trim();

    const sessionId = String(
      req.query.sessionId || ""
    ).trim();

    if (!userId || !sessionId) {
      return res.status(400).json({
        approved: false
      });
    }

    const permanent =
      await getPermanentStatus(
        userId
      );

    if (
      permanent ===
      "blacklisted"
    ) {
      return res.json({
        approved: false,
        denied: true,
        blacklisted: true
      });
    }

    if (
      permanent ===
      "whitelisted"
    ) {
      return res.json({
        approved: true,
        whitelisted: true
      });
    }

    const decision =
      await getSessionDecision(
        userId,
        sessionId
      );

    if (
      decision === "accepted"
    ) {
      return res.json({
        approved: true
      });
    }

    if (
      decision === "denied"
    ) {
      return res.json({
        approved: false,
        denied: true
      });
    }

    res.json({
      approved: false
    });
  } catch (err) {
    console.error(
      "check error:",
      err?.stack || err
    );

    res.status(500).json({
      approved: false
    });
  }
});

app.post(
  "/request",
  async (req, res) => {
    try {
      const {
        username,
        userId,
        displayName,
        place,
        jobId,
        placeId,
        sessionId
      } = req.body;

      if (
        !username ||
        !userId ||
        !sessionId
      ) {
        return res.status(400).json({
          error:
            "missing username, userId, or sessionId"
        });
      }

      if (
        !isDiscordConnected()
      ) {
        return res.status(503).json({
          error:
            "Discord bot is not connected yet"
        });
      }

      await logNewHubUser(
        userId,
        username
      );

      const permanent =
        await getPermanentStatus(
          userId
        );

      if (
        permanent ===
        "blacklisted"
      ) {
        return res.json({
          ok: true,
          approved: false,
          blacklisted: true
        });
      }

      if (
        permanent ===
        "whitelisted"
      ) {
        return res.json({
          ok: true,
          approved: true,
          whitelisted: true
        });
      }

      const decision =
        await getSessionDecision(
          userId,
          sessionId
        );

      if (
        decision === "accepted"
      ) {
        return res.json({
          ok: true,
          approved: true
        });
      }

      if (
        decision === "denied"
      ) {
        return res.json({
          ok: true,
          approved: false,
          denied: true
        });
      }

      try {
        await sendOwnerAccessRequest(
          {
            username,
            userId,
            displayName,
            place,
            jobId,
            placeId,
            sessionId
          }
        );
      } catch (dmErr) {
        console.error(
          "Owner DM failed:",
          dmErr?.stack || dmErr
        );

        return res.status(500).json({
          error:
            "could not DM owner; check OWNER_ID and Discord DM privacy settings"
        });
      }

      res.json({
        ok: true,
        approved: false
      });
    } catch (err) {
      console.error(
        "request error:",
        err?.stack || err
      );

      res.status(500).json({
        error: "request failed"
      });
    }
  }
);

/*
========================================================
START
========================================================
*/

async function start() {
  await initDb();

  const port = Number(
    process.env.PORT || 10000
  );

  app.listen(
    port,
    "0.0.0.0",
    () => {
      console.log(
        `HTTP server listening on ${port}`
      );
    }
  );

  console.log(
    "========================================"
  );

  console.log(
    "Starting All-In-One Approver"
  );

  console.log(
    "========================================"
  );

  console.log(
    `Token loaded: ${!!TOKEN} (${safeTokenPreview()})`
  );

  await checkDiscordNetwork();

  connectGateway("startup");
}

start().catch(err => {
  console.error(
    "Fatal startup error:",
    err?.stack || err
  );

  process.exit(1);
});
```

**After replacing it:** commit/push it to your Render repo and redeploy. You should **not** need to change your environment variables or database. The existing `/whitelist`, `/blacklist`, `/unwhitelist`, `/unblacklist`, and `/list` commands should still work because this change only removes the bot's automatic command-registration request.
