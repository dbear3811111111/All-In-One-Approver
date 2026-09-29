require("dotenv").config();

const express = require("express");
const { Pool } = require("pg");

for (const name of [
  "DISCORD_TOKEN",
  "OWNER_ID",
  "APPROVAL_CHANNEL_ID",
  "DATABASE_URL"
]) {
  if (!process.env[name]) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
}

const TOKEN = process.env.DISCORD_TOKEN.trim();

const API_BASE = "https://discord.com/api/v10";
const GATEWAY_URL =
  "wss://gateway.discord.gg/?v=10&encoding=json";

const app = express();
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

let discordSocket = null;
let discordUser = null;
let discordReady = false;
let slashCommandsRegistered = false;

let loginInProgress = false;
let gatewayConnecting = false;

let reconnectTimer = null;
let heartbeatTimer = null;
let heartbeatAcked = true;

let reconnectAttempt = 0;

let gatewaySessionId = null;
let gatewayResumeUrl = null;
let gatewaySequence = null;

const slashCommands = [
  {
    name: "whitelist",
    description: "Permanently allow a user to open the hub",
    options: [
      {
        name: "user_id",
        description: "Roblox UserId",
        type: 3,
        required: true
      },
      {
        name: "username",
        description: "Roblox username (optional)",
        type: 3,
        required: false
      }
    ]
  },
  {
    name: "blacklist",
    description: "Permanently deny a user from opening the hub",
    options: [
      {
        name: "user_id",
        description: "Roblox UserId",
        type: 3,
        required: true
      },
      {
        name: "username",
        description: "Roblox username (optional)",
        type: 3,
        required: false
      }
    ]
  },
  {
    name: "unwhitelist",
    description: "Remove a user from the whitelist",
    options: [
      {
        name: "user_id",
        description: "Roblox UserId",
        type: 3,
        required: true
      }
    ]
  },
  {
    name: "unblacklist",
    description: "Remove a user from the blacklist",
    options: [
      {
        name: "user_id",
        description: "Roblox UserId",
        type: 3,
        required: true
      }
    ]
  },
  {
    name: "list",
    description: "Show current whitelist and blacklist"
  }
];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isDiscordConnected() {
  return (
    discordReady &&
    discordSocket &&
    discordSocket.readyState === WebSocket.OPEN
  );
}

function logDiscordState() {
  console.log(
    `Discord state: ready=${discordReady}, ` +
    `socket=${discordSocket ? discordSocket.readyState : "none"}, ` +
    `user=${discordUser?.username || "none"}, ` +
    `session=${gatewaySessionId ? "yes" : "no"}`
  );
}

function safeTokenPreview() {
  if (!TOKEN) return "missing";

  if (TOKEN.length < 12) {
    return `${TOKEN.slice(0, 3)}***`;
  }

  return `${TOKEN.slice(0, 10)}...${TOKEN.slice(-4)}`;
}

async function discordFetch(path, options = {}, attempt = 0) {
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
    signal:
      options.signal ||
      AbortSignal.timeout(15000)
  });

  if (response.status === 429 && attempt < 3) {
    let retryMs = 1000;

    try {
      const data = await response.clone().json();

      retryMs = Math.max(
        250,
        Number(data.retry_after || 1) * 1000
      );
    } catch {}

    console.warn(
      `Discord REST rate limited; retrying in ${Math.ceil(
        retryMs
      )}ms.`
    );

    await sleep(retryMs);

    return discordFetch(
      path,
      options,
      attempt + 1
    );
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

    const error = new Error(
      `Discord API ${response.status}: ${detail.slice(
        0,
        1000
      )}`
    );

    error.status = response.status;
    error.discordData = data;

    throw error;
  }

  return data;
}

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS hub_users (
      user_id TEXT PRIMARY KEY,
      username TEXT,
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      logged_at TIMESTAMPTZ
    );

    ALTER TABLE hub_users
      ADD COLUMN IF NOT EXISTS logged_at TIMESTAMPTZ;

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
    `
    SELECT logged_at
    FROM hub_users
    WHERE user_id = $1
    LIMIT 1
    `,
    [id]
  );

  if (
    existing.rowCount &&
    existing.rows[0].logged_at
  ) {
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

  try {
    await discordJson(
      `/channels/${channelId}/messages`,
      {
        method: "POST",

        body: JSON.stringify({
          content:
            `Roblox Username: **${name}**\n` +
            `User ID: \`${id}\``
        })
      }
    );
  } catch (error) {
    console.error(
      "Could not send new-user log:",
      error?.message || error
    );

    return false;
  }

  await pool.query(
    `
    INSERT INTO hub_users
      (user_id, username, logged_at)
    VALUES
      ($1, $2, NOW())

    ON CONFLICT (user_id)
    DO UPDATE SET
      username = EXCLUDED.username,
      logged_at = NOW()
    `,
    [id, name]
  );

  console.log(
    `Logged new Roblox user ${name} (${id})`
  );

  return true;
}

async function getPermanentStatus(userId) {
  const id = String(userId);

  const black = await pool.query(
    `
    SELECT 1
    FROM permanent_blacklist
    WHERE user_id = $1
    LIMIT 1
    `,
    [id]
  );

  if (black.rowCount) {
    return "blacklisted";
  }

  const white = await pool.query(
    `
    SELECT 1
    FROM permanent_whitelist
    WHERE user_id = $1
    LIMIT 1
    `,
    [id]
  );

  if (white.rowCount) {
    return "whitelisted";
  }

  return null;
}

async function getSessionDecision(
  userId,
  sessionId
) {
  const result = await pool.query(
    `
    SELECT decision
    FROM access_sessions
    WHERE user_id = $1
      AND session_id = $2
    LIMIT 1
    `,
    [
      String(userId),
      String(sessionId)
    ]
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
    `
    INSERT INTO access_sessions
      (
        session_id,
        user_id,
        username,
        decision,
        decided_at
      )
    VALUES
      ($1, $2, $3, $4, NOW())

    ON CONFLICT (session_id)
    DO UPDATE SET
      user_id = EXCLUDED.user_id,
      username = EXCLUDED.username,
      decision = EXCLUDED.decision,
      decided_at = NOW()
    `,
    [
      String(sessionId),
      String(userId),
      String(username || "unknown"),
      String(decision)
    ]
  );
}

async function addWhitelist(
  userId,
  username
) {
  await pool.query(
    `
    INSERT INTO permanent_whitelist
      (user_id, username)
    VALUES
      ($1, $2)

    ON CONFLICT (user_id)
    DO UPDATE SET
      username = EXCLUDED.username,
      approved_at = NOW()
    `,
    [
      String(userId),
      String(username || "unknown")
    ]
  );

  await pool.query(
    `
    DELETE FROM permanent_blacklist
    WHERE user_id = $1
    `,
    [String(userId)]
  );
}

async function addBlacklist(
  userId,
  username
) {
  await pool.query(
    `
    INSERT INTO permanent_blacklist
      (user_id, username)
    VALUES
      ($1, $2)

    ON CONFLICT (user_id)
    DO UPDATE SET
      username = EXCLUDED.username,
      blocked_at = NOW()
    `,
    [
      String(userId),
      String(username || "unknown")
    ]
  );

  await pool.query(
    `
    DELETE FROM permanent_whitelist
    WHERE user_id = $1
    `,
    [String(userId)]
  );

  await pool.query(
    `
    DELETE FROM access_sessions
    WHERE user_id = $1
    `,
    [String(userId)]
  );
}

async function removeWhitelist(userId) {
  const result = await pool.query(
    `
    DELETE FROM permanent_whitelist
    WHERE user_id = $1
    `,
    [String(userId)]
  );

  return result.rowCount > 0;
}

async function removeBlacklist(userId) {
  const result = await pool.query(
    `
    DELETE FROM permanent_blacklist
    WHERE user_id = $1
    `,
    [String(userId)]
  );

  return result.rowCount > 0;
}

async function getLists() {
  const whitelist = await pool.query(
    `
    SELECT user_id, username, approved_at
    FROM permanent_whitelist
    ORDER BY approved_at DESC
    `
  );

  const blacklist = await pool.query(
    `
    SELECT user_id, username, blocked_at
    FROM permanent_blacklist
    ORDER BY blocked_at DESC
    `
  );

  return {
    whitelist: whitelist.rows,
    blacklist: blacklist.rows
  };
}

function sendGateway(payload) {
  if (!discordSocket) return;

  if (
    discordSocket.readyState !== WebSocket.OPEN
  ) {
    return;
  }

  discordSocket.send(
    JSON.stringify(payload)
  );
}

function startHeartbeat(interval) {
  stopHeartbeat();

  heartbeatAcked = true;

  heartbeatTimer = setInterval(() => {
    if (!discordSocket) return;

    if (
      discordSocket.readyState !== WebSocket.OPEN
    ) {
      return;
    }

    if (!heartbeatAcked) {
      console.warn(
        "Discord heartbeat was not acknowledged. Reconnecting..."
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

    sendGateway({
      op: 1,
      d: gatewaySequence
    });
  }, interval);

  sendGateway({
    op: 1,
    d: gatewaySequence
  });
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  heartbeatAcked = true;
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
      },

      presence: {
        since: null,
        activities: [],
        status: "online",
        afk: false
      }
    }
  });
}

function resumeGateway() {
  console.log(
    "Discord Gateway: attempting RESUME..."
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

async function registerSlashCommands() {
  if (!discordUser) return;

  const channelId =
    String(
      process.env.APPROVAL_CHANNEL_ID
    ).trim();

  try {
    const channel = await discordJson(
      `/channels/${channelId}`
    );

    if (!channel.guild_id) {
      console.error(
        "APPROVAL_CHANNEL_ID is not inside a Discord server."
      );

      return;
    }

    await discordJson(
      `/applications/${discordUser.id}/guilds/${channel.guild_id}/commands`,
      {
        method: "PUT",
        body: JSON.stringify(
          slashCommands
        )
      }
    );

    slashCommandsRegistered = true;

    console.log(
      `Registered ${slashCommands.length} slash commands.`
    );
  } catch (error) {
    console.error(
      "Failed to register slash commands:",
      error?.stack || error
    );
  }
}

async function sendOwnerDM(content) {
  const ownerId =
    String(process.env.OWNER_ID).trim();

  const channel = await discordJson(
    `/users/@me/channels`,
    {
      method: "POST",
      body: JSON.stringify({
        recipient_id: ownerId
      })
    }
  );

  return discordJson(
    `/channels/${channel.id}/messages`,
    {
      method: "POST",
      body: JSON.stringify({
        content
      })
    }
  );
}

async function sendOwnerAccessRequest(data) {
  const {
    username,
    userId,
    displayName,
    place,
    jobId,
    placeId,
    sessionId
  } = data;

  const ownerId =
    String(process.env.OWNER_ID).trim();

  const channel =
    await discordJson(
      `/users/@me/channels`,
      {
        method: "POST",
        body: JSON.stringify({
          recipient_id: ownerId
        })
      }
    );

  const message =
    await discordJson(
      `/channels/${channel.id}/messages`,
      {
        method: "POST",

        body: JSON.stringify({
          content:
            `🔐 **Hub Access Request**\n\n` +
            `**Username:** ${username}\n` +
            `**User ID:** ${userId}\n` +
            `**Display Name:** ${displayName || "N/A"}\n` +
            `**Place:** ${place || "N/A"}\n` +
            `**Place ID:** ${placeId || "N/A"}\n` +
            `**Job ID:** ${jobId || "N/A"}\n` +
            `**Session ID:** ${sessionId}`,

          components: [
            {
              type: 1,

              components: [
                {
                  type: 2,
                  style: 3,
                  label: "Accept",
                  custom_id:
                    `accept:${userId}:${sessionId}`
                },

                {
                  type: 2,
                  style: 4,
                  label: "Deny",
                  custom_id:
                    `deny:${userId}:${sessionId}`
                },

                {
                  type: 2,
                  style: 1,
                  label: "Whitelist",
                  custom_id:
                    `whitelist:${userId}:${sessionId}`
                },

                {
                  type: 2,
                  style: 4,
                  label: "Blacklist",
                  custom_id:
                    `blacklist:${userId}:${sessionId}`
                }
              ]
            }
          ]
        })
      }
    );

  return message;
}

async function acknowledgeInteraction(
  interaction,
  content,
  ephemeral = true
) {
  const flags = ephemeral ? 64 : 0;

  return discordJson(
    `/interactions/${interaction.id}/${interaction.token}/callback`,
    {
      method: "POST",

      body: JSON.stringify({
        type: 4,

        data: {
          content,
          flags
        }
      })
    }
  );
}

async function updateInteractionMessage(
  interaction,
  content
) {
  return discordJson(
    `/webhooks/${discordUser.id}/${interaction.token}/messages/@original`,
    {
      method: "PATCH",

      body: JSON.stringify({
        content,
        components: []
      })
    }
  );
}

async function handleButtonInteraction(
  interaction
) {
  const customId =
    String(
      interaction.data?.custom_id || ""
    );

  const parts = customId.split(":");

  if (parts.length < 3) return;

  const action = parts[0];
  const userId = parts[1];
  const sessionId = parts.slice(2).join(":");

  if (action === "copyid") {
    await acknowledgeInteraction(
      interaction,
      `User ID: ${userId}`,
      true
    );

    return;
  }

  if (
    String(interaction.member?.user?.id) !==
    String(process.env.OWNER_ID)
  ) {
    await acknowledgeInteraction(
      interaction,
      "You are not authorized to use these buttons.",
      true
    );

    return;
  }

  const username =
    await getStoredUsername(
      userId
    );

  if (action === "accept") {
    await setSessionDecision(
      userId,
      username,
      sessionId,
      "accepted"
    );

    await acknowledgeInteraction(
      interaction,
      "✅ Access accepted for this session.",
      true
    );

    return;
  }

  if (action === "deny") {
    await setSessionDecision(
      userId,
      username,
      sessionId,
      "denied"
    );

    await acknowledgeInteraction(
      interaction,
      "❌ Access denied for this session.",
      true
    );

    return;
  }

  if (action === "whitelist") {
    await addWhitelist(
      userId,
      username
    );

    await acknowledgeInteraction(
      interaction,
      `✅ <@${userId}> has been permanently whitelisted.`,
      true
    );

    return;
  }

  if (action === "blacklist") {
    await addBlacklist(
      userId,
      username
    );

    await acknowledgeInteraction(
      interaction,
      `🚫 <@${userId}> has been permanently blacklisted.`,
      true
    );

    return;
  }
}

async function handleSlashCommand(
  interaction
) {
  const name =
    interaction.data?.name;

  if (
    String(interaction.member?.user?.id) !==
    String(process.env.OWNER_ID)
  ) {
    await acknowledgeInteraction(
      interaction,
      "You are not authorized to use this command.",
      true
    );

    return;
  }

  const options =
    interaction.data?.options || [];

  const getOption = key =>
    options.find(
      option => option.name === key
    )?.value;

  if (name === "whitelist") {
    const userId =
      getOption("user_id");

    const username =
      getOption("username") ||
      await getStoredUsername(userId);

    await addWhitelist(
      userId,
      username
    );

    await acknowledgeInteraction(
      interaction,
      `✅ Permanently whitelisted **${username}** (${userId}).`,
      true
    );

    return;
  }

  if (name === "blacklist") {
    const userId =
      getOption("user_id");

    const username =
      getOption("username") ||
      await getStoredUsername(userId);

    await addBlacklist(
      userId,
      username
    );

    await acknowledgeInteraction(
      interaction,
      `🚫 Permanently blacklisted **${username}** (${userId}).`,
      true
    );

    return;
  }

  if (name === "unwhitelist") {
    const userId =
      getOption("user_id");

    const removed =
      await removeWhitelist(
        userId
      );

    await acknowledgeInteraction(
      interaction,
      removed
        ? `✅ Removed ${userId} from the whitelist.`
        : `ℹ️ ${userId} was not on the whitelist.`,
      true
    );

    return;
  }

  if (name === "unblacklist") {
    const userId =
      getOption("user_id");

    const removed =
      await removeBlacklist(
        userId
      );

    await acknowledgeInteraction(
      interaction,
      removed
        ? `✅ Removed ${userId} from the blacklist.`
        : `ℹ️ ${userId} was not on the blacklist.`,
      true
    );

    return;
  }

  if (name === "list") {
    const lists =
      await getLists();

    const white =
      lists.whitelist.length
        ? lists.whitelist
            .map(
              x =>
                `• ${x.username || "unknown"} — \`${x.user_id}\``
            )
            .join("\n")
        : "None";

    const black =
      lists.blacklist.length
        ? lists.blacklist
            .map(
              x =>
                `• ${x.username || "unknown"} — \`${x.user_id}\``
            )
            .join("\n")
        : "None";

    await acknowledgeInteraction(
      interaction,
      `**Whitelist**\n${white}\n\n**Blacklist**\n${black}`,
      true
    );
  }
}

async function handleInteraction(
  interaction
) {
  try {
    if (interaction.type === 2) {
      await handleSlashCommand(
        interaction
      );

      return;
    }

    if (interaction.type === 3) {
      await handleButtonInteraction(
        interaction
      );

      return;
    }
  } catch (error) {
    console.error(
      "Interaction error:",
      error?.stack || error
    );

    try {
      await acknowledgeInteraction(
        interaction,
        "An error occurred while processing that action.",
        true
      );
    } catch {}
  }
}

async function handleGatewayDispatch(
  data
) {
  gatewaySequence = data.s;

  switch (data.t) {
    case "READY":
      discordUser = data.d?.user || null;

      gatewaySessionId =
        data.d?.session_id ||
        gatewaySessionId;

      gatewayResumeUrl =
        data.d?.resume_gateway_url ||
        GATEWAY_URL;

      discordReady = true;
      loginInProgress = false;
      gatewayConnecting = false;
      reconnectAttempt = 0;

      console.log(
        `Discord Gateway READY as ${
          discordUser?.username || "unknown"
        }`
      );

      logDiscordState();

      await registerSlashCommands();

      break;

    case "RESUMED":
      discordReady = true;
      loginInProgress = false;
      gatewayConnecting = false;
      reconnectAttempt = 0;

      console.log(
        "Discord Gateway session RESUMED."
      );

      logDiscordState();

      break;

    case "INTERACTION_CREATE":
      await handleInteraction(
        data.d
      );

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
  } catch (error) {
    console.error(
      "Could not parse Discord Gateway message:",
      error?.message || error
    );

    return null;
  }
}

function connectGateway(
  reason = "startup"
) {
  if (
    gatewayConnecting ||
    isDiscordConnected()
  ) {
    return;
  }

  gatewayConnecting = true;
  loginInProgress = true;
  discordReady = false;
  slashCommandsRegistered = false;

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
    socket =
      new WebSocket(
        GATEWAY_URL
      );
  } catch (error) {
    gatewayConnecting = false;
    loginInProgress = false;

    console.error(
      "Could not create Discord WebSocket:",
      error?.stack || error
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
        `Discord Gateway CLOSED: code=${event.code}, reason=${event.reason || "none"}, wasReady=${wasReady}`
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

  const delay =
    Math.min(
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
    const response =
      await fetch(
        "https://discord.com/api/v10/gateway",
        {
          headers: {
            "User-Agent":
              "All-In-One-Approver/1.0"
          },

          signal:
            AbortSignal.timeout(
              10000
            )
        }
      );

    console.log(
      `Discord HTTPS gateway check: HTTP ${response.status}`
    );
  } catch (error) {
    console.error(
      `Discord HTTPS check failed: ${
        error?.name || "Error"
      }: ${
        error?.message || error
      }`
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

app.get(
  "/",
  (_req, res) => {
    res.status(200).send(
      isDiscordConnected()
        ? "All-In-One Approver is online and connected to Discord."
        : "All-In-One Approver web service is online, but the Discord bot is not connected."
    );
  }
);

app.get(
  "/wake",
  (_req, res) => {
    if (
      isDiscordConnected()
    ) {
      return res
        .status(200)
        .json({
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
      return res
        .status(202)
        .json({
          ok: true,
          connected: false,
          message:
            "Discord Gateway connection is already in progress."
        });
    }

    connectGateway(
      "/wake"
    );

    return res
      .status(202)
      .json({
        ok: true,
        connected: false,
        message:
          "Discord Gateway connection started."
      });
  }
);

app.get(
  "/health",
  (_req, res) => {
    res.json({
      ok: true,

      discordConnected:
        isDiscordConnected(),

      discordUser:
        discordUser
          ? discordUser.username
          : null,

      slashCommandsRegistered,

      gatewaySession:
        !!gatewaySessionId
    });
  }
);

app.get(
  "/check",
  async (req, res) => {
    try {
      const userId =
        String(
          req.query.userId || ""
        ).trim();

      const sessionId =
        String(
          req.query.sessionId || ""
        ).trim();

      if (
        !userId ||
        !sessionId
      ) {
        return res
          .status(400)
          .json({
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
        decision ===
        "accepted"
      ) {
        return res.json({
          approved: true
        });
      }

      if (
        decision ===
        "denied"
      ) {
        return res.json({
          approved: false,
          denied: true
        });
      }

      res.json({
        approved: false
      });
    } catch (error) {
      console.error(
        "check error:",
        error?.stack || error
      );

      res
        .status(500)
        .json({
          approved: false
        });
    }
  }
);

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
        return res
          .status(400)
          .json({
            error:
              "missing username, userId, or sessionId"
          });
      }

      if (
        !isDiscordConnected()
      ) {
        return res
          .status(503)
          .json({
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
        decision ===
        "accepted"
      ) {
        return res.json({
          ok: true,
          approved: true
        });
      }

      if (
        decision ===
        "denied"
      ) {
        return res.json({
          ok: true,
          approved: false,
          denied: true
        });
      }

      try {
        await sendOwnerAccessRequest({
          username,
          userId,
          displayName,
          place,
          jobId,
          placeId,
          sessionId
        });
      } catch (error) {
        console.error(
          "Owner DM failed:",
          error?.stack || error
        );

        return res
          .status(500)
          .json({
            error:
              "could not DM owner"
          });
      }

      res.json({
        ok: true,
        approved: false
      });
    } catch (error) {
      console.error(
        "request error:",
        error?.stack || error
      );

      res
        .status(500)
        .json({
          error:
            "request failed"
        });
    }
  }
);

async function start() {
  await initDb();

  const port =
    Number(
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

  connectGateway(
    "startup"
  );
}

start().catch(error => {
  console.error(
    "Fatal startup error:",
    error?.stack || error
  );

  process.exit(1);
});
