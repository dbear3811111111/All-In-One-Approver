require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} = require("discord.js");

const express = require("express");
const { Pool } = require("pg");
const tls = require("tls");
const crypto = require("crypto");
const dns = require("dns").promises;

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


// ============================================================
// DISCORD CLIENT
// ============================================================

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds
  ],

  ws: {
    version: "10",
    encoding: "json",
    compression: null,

    // More generous diagnostics/timeouts.
    handshakeTimeout: 30000,
    helloTimeout: 60000,
    readyTimeout: 30000
  }
});

let loginInProgress = false;
let slashCommandsRegistered = false;


// ============================================================
// DISCORD DEBUGGING
// ============================================================

function redactSecrets(message) {
  let text = String(message);

  if (process.env.DISCORD_TOKEN) {
    const escaped = process.env.DISCORD_TOKEN.replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&"
    );

    text = text.replace(
      new RegExp(escaped, "g"),
      "[REDACTED_TOKEN]"
    );
  }

  // Generic Discord token-looking pattern.
  text = text.replace(
    /([A-Za-z\d_-]{20,})\.[A-Za-z\d_-]{4,}\.[A-Za-z\d_-]{20,}/g,
    "[REDACTED_TOKEN]"
  );

  return text;
}


// Discord.js internal debug output.
client.on("debug", (message) => {
  console.log(
    `[discord.js DEBUG] ${redactSecrets(message)}`
  );
});


// General client error.
client.on("error", (err) => {
  console.error(
    "Discord client error:",
    err?.stack || err
  );
});


// Shard errors.
client.on("shardError", (err, shardId) => {
  console.error(
    `Discord shard ${shardId} error:`,
    err?.stack || err
  );
});


// Shard disconnect.
client.on("shardDisconnect", (event, shardId) => {
  console.error(
    `Discord shard ${shardId} disconnected.`
  );

  console.error(
    "Close code:",
    event?.code
  );

  console.error(
    "Close reason:",
    event?.reason || "(none)"
  );
});


// Shard reconnecting.
client.on("shardReconnecting", (shardId) => {
  console.log(
    `Discord shard ${shardId} is reconnecting...`
  );
});


// Shard ready.
client.on("shardReady", (shardId) => {
  console.log(
    `Discord shard ${shardId} is ready.`
  );
});


// ============================================================
// EXPRESS
// ============================================================

const app = express();

app.use(express.json());


// ============================================================
// DATABASE
// ============================================================

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,

  ssl: {
    rejectUnauthorized: false
  }
});


// ============================================================
// DISCORD READY
// ============================================================

client.once("ready", async () => {
  console.log("");
  console.log("========================================");
  console.log("DISCORD READY");
  console.log("========================================");

  console.log(
    `Discord bot is READY as ${client.user.tag} (${client.user.id})`
  );

  console.log(
    `Connected to ${client.guilds.cache.size} guild(s).`
  );

  try {
    const approvalChannel = await client.channels
      .fetch(String(process.env.APPROVAL_CHANNEL_ID))
      .catch((err) => {
        console.error(
          "Could not fetch APPROVAL_CHANNEL_ID:",
          err?.message || err
        );

        return null;
      });

    const guild = approvalChannel?.guild;

    if (guild) {
      await guild.commands.set(slashCommands);

      slashCommandsRegistered = true;

      console.log(
        `Registered ${slashCommands.length} slash commands in guild ${guild.id}`
      );
    } else {
      console.error(
        "Could not find APPROVAL_CHANNEL_ID guild; slash commands were not registered."
      );
    }

  } catch (err) {
    console.error(
      "Slash-command registration failed:",
      err?.stack || err
    );
  }
});


// ============================================================
// DATABASE INITIALIZATION
// ============================================================

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


// ============================================================
// LOG NEW ROBLOX USER
// ============================================================

async function logNewHubUser(userId, username) {
  const id = String(userId).trim();
  const name = String(username || "unknown").trim();

  const existing = await pool.query(
    "SELECT logged_at FROM hub_users WHERE user_id = $1 LIMIT 1",
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

  const channel = await client.channels
    .fetch(channelId)
    .catch((err) => {
      console.error(
        "Could not fetch ROBLOX_LOG_CHANNEL_ID:",
        err?.message || err
      );

      return null;
    });

  if (!channel || !channel.isTextBased()) {
    console.error(
      "ROBLOX_LOG_CHANNEL_ID is not a text-based Discord channel."
    );

    return false;
  }

  const logRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`copyid:${id}`)
      .setLabel("Copy User ID")
      .setEmoji("📋")
      .setStyle(ButtonStyle.Secondary)
  );

  try {
    await channel.send({
      content:
        `Roblox Username: **${name}**\n` +
        `User ID: \`${id}\``,
      components: [logRow]
    });

  } catch (err) {
    console.error(
      "Could not send new-user log:",
      err?.message || err
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
    `Logged new Roblox user ${name} (${id}) to channel ${channelId}`
  );

  return true;
}


// ============================================================
// ACCESS STATUS
// ============================================================

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

  return "none";
}


async function getSessionDecision(userId, sessionId) {
  const result = await pool.query(
    `
    SELECT decision
    FROM access_sessions
    WHERE session_id = $1
      AND user_id = $2
    LIMIT 1
    `,
    [
      String(sessionId),
      String(userId)
    ]
  );

  return result.rowCount
    ? result.rows[0].decision
    : "none";
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
      decision
    ]
  );
}


// ============================================================
// WHITELIST / BLACKLIST
// ============================================================

async function addWhitelist(userId, username) {
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


async function addBlacklist(userId, username) {
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
  const white = await pool.query(
    `
    SELECT user_id, username, approved_at
    FROM permanent_whitelist
    ORDER BY approved_at DESC
    `
  );

  const black = await pool.query(
    `
    SELECT user_id, username, blocked_at
    FROM permanent_blacklist
    ORDER BY blocked_at DESC
    `
  );

  return {
    whitelist: white.rows,
    blacklist: black.rows
  };
}


// ============================================================
// SLASH COMMANDS
// ============================================================

const slashCommands = [
  {
    name: "whitelist",
    description:
      "Permanently allow a user to open the hub",

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
    description:
      "Permanently deny a user from opening the hub",

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
    description:
      "Remove a user from the whitelist",

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
    description:
      "Remove a user from the blacklist",

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
    description:
      "Show current whitelist and blacklist"
  }
];


// ============================================================
// WEB SERVER
// ============================================================

app.get("/", (_req, res) => {
  res.status(200).send(
    client.isReady()
      ? "All-In-One Approver is online and connected to Discord."
      : "All-In-One Approver web service is online, but the Discord bot is not connected."
  );
});


// ============================================================
// WAKE
// ============================================================

app.get("/wake", (_req, res) => {
  if (client.isReady()) {
    return res.status(200).json({
      ok: true,
      connected: true,
      message:
        "Discord bot is already online."
    });
  }

  if (loginInProgress) {
    return res.status(202).json({
      ok: true,
      connected: false,
      message:
        "Discord login is already in progress. Check Render logs in a few seconds."
    });
  }

  loginDiscord("/wake");

  return res.status(202).json({
    ok: true,
    connected: false,
    message:
      "Discord login started in the background. Check /health or Render logs."
  });
});


// ============================================================
// HEALTH
// ============================================================

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    discordConnected: client.isReady(),
    discordUser: client.user?.tag || null,
    slashCommandsRegistered
  });
});


// ============================================================
// ROBLOX CHECK
// ============================================================

app.get("/check", async (req, res) => {
  try {
    const userId = String(
      req.query.userId || ""
    ).trim();

    const sessionId = String(
      req.query.sessionId || ""
    ).trim();

    const username = String(
      req.query.username || ""
    ).trim();

    if (!userId) {
      return res.status(400).json({
        error: "missing userId"
      });
    }

    await logNewHubUser(
      userId,
      username
    ).catch((err) => {
      console.error(
        "User logging error:",
        err?.message || err
      );
    });

    const status =
      await getPermanentStatus(userId);

    if (status === "blacklisted") {
      return res.json({
        ok: true,
        approved: false,
        denied: true,
        permanent: true
      });
    }

    if (status === "whitelisted") {
      return res.json({
        ok: true,
        approved: true,
        permanent: true
      });
    }

    if (!sessionId) {
      return res.json({
        ok: true,
        approved: false,
        pending: true
      });
    }

    const decision =
      await getSessionDecision(
        userId,
        sessionId
      );

    if (decision === "accepted") {
      return res.json({
        ok: true,
        approved: true
      });
    }

    if (decision === "denied") {
      return res.json({
        ok: true,
        approved: false,
        denied: true
      });
    }

    return res.json({
      ok: true,
      approved: false,
      pending: true
    });

  } catch (err) {
    console.error(
      "check error:",
      err
    );

    return res.status(500).json({
      error: "check failed"
    });
  }
});


// ============================================================
// ACCESS REQUEST
// ============================================================

app.post("/request", async (req, res) => {
  try {
    const {
      userId,
      username,
      displayName,
      sessionId,
      place,
      placeId,
      jobId
    } = req.body || {};

    if (!userId || !sessionId) {
      return res.status(400).json({
        error:
          "userId and sessionId are required"
      });
    }

    const permanentStatus =
      await getPermanentStatus(userId);

    if (permanentStatus === "blacklisted") {
      return res.json({
        ok: true,
        approved: false,
        denied: true,
        permanent: true
      });
    }

    if (permanentStatus === "whitelisted") {
      return res.json({
        ok: true,
        approved: true,
        permanent: true
      });
    }

    const decision =
      await getSessionDecision(
        userId,
        sessionId
      );

    if (decision === "accepted") {
      return res.json({
        ok: true,
        approved: true
      });
    }

    if (decision === "denied") {
      return res.json({
        ok: true,
        approved: false,
        denied: true
      });
    }

    const embed = new EmbedBuilder()
      .setTitle("Hub Access Request")
      .setDescription(
        `**${displayName || username}** (\`${username}\`) wants to open the hub.`
      )
      .addFields(
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
          value:
            `\`${String(sessionId).slice(0, 24)}\``,
          inline: false
        },
        {
          name: "Server",
          value:
            jobId
              ? `\`${jobId}\``
              : "n/a",
          inline: false
        }
      )
      .setColor(0xff3333)
      .setTimestamp();

    const row =
      new ActionRowBuilder().addComponents(

        new ButtonBuilder()
          .setCustomId(
            `accept:${userId}:${sessionId}:${username}`
          )
          .setLabel("Accept")
          .setStyle(ButtonStyle.Success),

        new ButtonBuilder()
          .setCustomId(
            `deny:${userId}:${sessionId}:${username}`
          )
          .setLabel("Deny")
          .setStyle(ButtonStyle.Danger),

        new ButtonBuilder()
          .setCustomId(
            `whitelist:${userId}:${sessionId}:${username}`
          )
          .setLabel("Whitelist")
          .setStyle(ButtonStyle.Primary),

        new ButtonBuilder()
          .setCustomId(
            `blacklist:${userId}:${sessionId}:${username}`
          )
          .setLabel("Blacklist")
          .setStyle(ButtonStyle.Secondary)
      );

    const owner =
      await client.users
        .fetch(
          String(process.env.OWNER_ID)
        )
        .catch((err) => {
          console.error(
            "Could not fetch OWNER_ID:",
            err?.message || err
          );

          return null;
        });

    if (!owner) {
      return res.status(500).json({
        error:
          "could not find OWNER_ID on Discord"
      });
    }

    try {
      const dm =
        await owner.createDM();

      await dm.send({
        embeds: [embed],
        components: [row]
      });

    } catch (dmErr) {
      console.error(
        "Owner DM failed:",
        dmErr?.message || dmErr
      );

      return res.status(500).json({
        error:
          "could not DM owner; check OWNER_ID and Discord DM privacy settings"
      });
    }

    return res.json({
      ok: true,
      approved: false
    });

  } catch (err) {
    console.error(
      "request error:",
      err
    );

    return res.status(500).json({
      error: "request failed"
    });
  }
});


// ============================================================
// DISCORD INTERACTIONS
// ============================================================

client.on(
  "interactionCreate",
  async (interaction) => {

    // --------------------------------------------------------
    // COPY USER ID
    // --------------------------------------------------------

    if (
      interaction.isButton() &&
      interaction.customId.startsWith("copyid:")
    ) {

      if (
        interaction.user.id !==
        process.env.OWNER_ID
      ) {
        return interaction.reply({
          content:
            "Only the owner can use this button.",
          ephemeral: true
        });
      }

      const userId =
        interaction.customId.slice(
          "copyid:".length
        );

      if (!/^\d+$/.test(userId)) {
        return interaction.reply({
          content:
            "❌ Invalid Roblox UserId.",
          ephemeral: true
        });
      }

      return interaction.reply({
        content:
          `📋 **Roblox UserId**\n` +
          `\`\`\`text\n${userId}\n\`\`\`\n` +
          `Use Discord's copy button on the code block to copy it.`,
        ephemeral: true
      });
    }


    // --------------------------------------------------------
    // SLASH COMMANDS
    // --------------------------------------------------------

    if (interaction.isChatInputCommand()) {

      if (
        interaction.user.id !==
        process.env.OWNER_ID
      ) {
        return interaction.reply({
          content:
            "Only the owner can use these commands.",
          ephemeral: true
        });
      }

      try {
        const command =
          interaction.commandName;

        const userId =
          interaction.options
            .getString("user_id")
            ?.trim();

        const username =
          interaction.options
            .getString("username")
            ?.trim() ||
          "unknown";

        await interaction.deferReply({
          ephemeral: true
        });


        // /whitelist
        if (command === "whitelist") {

          if (!/^\d+$/.test(userId || "")) {
            return interaction.editReply(
              "❌ Invalid Roblox UserId. Use the numeric UserId."
            );
          }

          await addWhitelist(
            userId,
            username
          );

          return interaction.editReply(
            `✅ Permanently whitelisted \`${username}\` ` +
            `(UserId: \`${userId}\`).`
          );
        }


        // /blacklist
        if (command === "blacklist") {

          if (!/^\d+$/.test(userId || "")) {
            return interaction.editReply(
              "❌ Invalid Roblox UserId. Use the numeric UserId."
            );
          }

          await addBlacklist(
            userId,
            username
          );

          return interaction.editReply(
            `⛔ Permanently blacklisted \`${username}\` ` +
            `(UserId: \`${userId}\`).`
          );
        }


        // /unwhitelist
        if (command === "unwhitelist") {

          if (!/^\d+$/.test(userId || "")) {
            return interaction.editReply(
              "❌ Invalid Roblox UserId. Use the numeric UserId."
            );
          }

          const removed =
            await removeWhitelist(
              userId
            );

          return interaction.editReply(
            removed
              ? `✅ Removed UserId \`${userId}\` from the permanent whitelist.`
              : `ℹ️ UserId \`${userId}\` was not on the permanent whitelist.`
          );
        }


        // /unblacklist
        if (command === "unblacklist") {

          if (!/^\d+$/.test(userId || "")) {
            return interaction.editReply(
              "❌ Invalid Roblox UserId. Use the numeric UserId."
            );
          }

          const removed =
            await removeBlacklist(
              userId
            );

          return interaction.editReply(
            removed
              ? `✅ Removed UserId \`${userId}\` from the permanent blacklist.`
              : `ℹ️ UserId \`${userId}\` was not on the permanent blacklist.`
          );
        }


        // /list
        if (command === "list") {

          const {
            whitelist,
            blacklist
          } = await getLists();

          const format = (rows) =>
            rows.length
              ? rows
                  .map(
                    (r) =>
                      `\`${r.user_id}\` — ${r.username || "unknown"}`
                  )
                  .join("\n")
              : "None";

          const embed =
            new EmbedBuilder()
              .setTitle(
                "Current Access Lists"
              )
              .addFields(
                {
                  name:
                    `✅ Whitelist (${whitelist.length})`,
                  value:
                    format(
                      whitelist
                    ).slice(0, 1024),
                  inline: false
                },
                {
                  name:
                    `⛔ Blacklist (${blacklist.length})`,
                  value:
                    format(
                      blacklist
                    ).slice(0, 1024),
                  inline: false
                }
              )
              .setColor(0x5865f2)
              .setTimestamp();

          return interaction.editReply({
            embeds: [embed]
          });
        }


        return interaction.editReply(
          "Unknown command."
        );

      } catch (err) {

        console.error(
          "slash command error:",
          err
        );

        if (
          interaction.deferred ||
          interaction.replied
        ) {
          await interaction
            .editReply(
              "❌ Database error while running that command."
            )
            .catch(() => {});
        } else {
          await interaction
            .reply({
              content:
                "❌ Database error while running that command.",
              ephemeral: true
            })
            .catch(() => {});
        }
      }

      return;
    }


    // --------------------------------------------------------
    // BUTTONS
    // --------------------------------------------------------

    if (!interaction.isButton()) {
      return;
    }

    if (
      interaction.user.id !==
      process.env.OWNER_ID
    ) {
      return interaction.reply({
        content:
          "Only the owner can use these buttons.",
        ephemeral: true
      });
    }

    const parts =
      interaction.customId.split(":");

    const action = parts[0];
    const userId = parts[1];
    const sessionId = parts[2];

    const username =
      parts
        .slice(3)
        .join(":") ||
      "unknown";


    try {

      // ACCEPT
      if (action === "accept") {

        await setSessionDecision(
          userId,
          username,
          sessionId,
          "accepted"
        );

        await interaction.update({
          content:
            `✅ **Accepted for this session only** — \`${username}\`\n` +
            `This does NOT whitelist them.`,
          embeds:
            interaction.message.embeds,
          components: []
        });

        return;
      }


      // DENY
      if (action === "deny") {

        await setSessionDecision(
          userId,
          username,
          sessionId,
          "denied"
        );

        await interaction.update({
          content:
            `❌ **Denied** — \`${username}\`\n` +
            `This does NOT blacklist them.`,
          embeds:
            interaction.message.embeds,
          components: []
        });

        return;
      }


      // WHITELIST
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

        await interaction.update({
          content:
            `✅ **Whitelisted permanently** — \`${username}\``,
          embeds:
            interaction.message.embeds,
          components: []
        });

        return;
      }


      // BLACKLIST
      if (action === "blacklist") {

        await addBlacklist(
          userId,
          username
        );

        await interaction.update({
          content:
            `⛔ **Blacklisted permanently** — \`${username}\``,
          embeds:
            interaction.message.embeds,
          components: []
        });

        return;
      }

    } catch (err) {

      console.error(
        "interaction error:",
        err
      );

      if (
        !interaction.replied &&
        !interaction.deferred
      ) {
        await interaction
          .reply({
            content:
              "Database error while updating this request.",
            ephemeral: true
          })
          .catch(() => {});
      }
    }
  }
);


// ============================================================
// RAW DISCORD WEBSOCKET DIAGNOSTIC
//
// This is independent of discord.js.
//
// We already know this succeeds on your Render service,
// but we're keeping it here so future deploys immediately
// tell us whether Discord's Gateway is reachable.
// ============================================================

function createWebSocketKey() {
  return crypto
    .randomBytes(16)
    .toString("base64");
}


function parseWebSocketFrames(buffer) {
  const frames = [];

  let offset = 0;

  while (offset + 2 <= buffer.length) {

    const first = buffer[offset];
    const second = buffer[offset + 1];

    const fin = (first & 0x80) !== 0;
    const opcode = first & 0x0f;

    const masked = (second & 0x80) !== 0;

    let payloadLength = second & 0x7f;

    offset += 2;

    if (payloadLength === 126) {

      if (offset + 2 > buffer.length) {
        break;
      }

      payloadLength =
        buffer.readUInt16BE(offset);

      offset += 2;

    } else if (payloadLength === 127) {

      if (offset + 8 > buffer.length) {
        break;
      }

      const high =
        buffer.readUInt32BE(offset);

      const low =
        buffer.readUInt32BE(offset + 4);

      offset += 8;

      payloadLength =
        high * 4294967296 + low;
    }

    let mask;

    if (masked) {

      if (offset + 4 > buffer.length) {
        break;
      }

      mask =
        buffer.subarray(
          offset,
          offset + 4
        );

      offset += 4;
    }

    if (
      offset + payloadLength >
      buffer.length
    ) {
      break;
    }

    let payload =
      buffer.subarray(
        offset,
        offset + payloadLength
      );

    offset += payloadLength;

    if (masked) {

      const decoded =
        Buffer.alloc(payload.length);

      for (
        let i = 0;
        i < payload.length;
        i++
      ) {
        decoded[i] =
          payload[i] ^
          mask[i % 4];
      }

      payload = decoded;
    }

    frames.push({
      fin,
      opcode,
      payload
    });
  }

  return frames;
}


function runRawDiscordWebSocketDiagnostic() {
  return new Promise(async (resolve) => {

    console.log("");
    console.log("========================================");
    console.log("Discord raw WebSocket diagnostic starting...");
    console.log("========================================");

    let settled = false;
    let socket = null;

    const finish = (result) => {

      if (settled) {
        return;
      }

      settled = true;

      if (socket) {
        socket.destroy();
      }

      console.log(
        "Raw Discord WebSocket result:",
        result
      );

      resolve(result);
    };

    const timeout = setTimeout(() => {

      console.error(
        "Discord raw WebSocket diagnostic timed out."
      );

      finish({
        ok: false,
        hello: false,
        error: "timeout"
      });

    }, 15000);


    try {

      const addresses =
        await dns.lookup(
          "gateway.discord.gg",
          {
            all: true
          }
        );

      if (!addresses.length) {

        clearTimeout(timeout);

        return finish({
          ok: false,
          hello: false,
          error: "gateway.discord.gg DNS returned no addresses"
        });
      }

      const address =
        addresses[0].address;

      console.log(
        `Discord raw WebSocket target: ${address}:443`
      );

      const key =
        createWebSocketKey();

      socket = tls.connect({
        host: address,
        port: 443,
        servername: "gateway.discord.gg",
        rejectUnauthorized: true
      });

      let handshakeBuffer =
        Buffer.alloc(0);

      let handshakeComplete = false;

      let frameBuffer =
        Buffer.alloc(0);

      socket.setTimeout(12000);

      socket.on("secureConnect", () => {

        console.log(
          "Discord raw WebSocket: TLS CONNECTED"
        );

        const request =
          [
            "GET /?v=10&encoding=json HTTP/1.1",
            "Host: gateway.discord.gg",
            "Upgrade: websocket",
            "Connection: Upgrade",
            `Sec-WebSocket-Key: ${key}`,
            "Sec-WebSocket-Version: 13",
            "",
            ""
          ].join("\r\n");

        socket.write(request);
      });


      socket.on("data", (chunk) => {

        if (!handshakeComplete) {

          handshakeBuffer =
            Buffer.concat([
              handshakeBuffer,
              chunk
            ]);

          const headerEnd =
            handshakeBuffer.indexOf(
              "\r\n\r\n"
            );

          if (headerEnd === -1) {
            return;
          }

          const header =
            handshakeBuffer
              .subarray(
                0,
                headerEnd
              )
              .toString();

          console.log(
            "Discord raw WebSocket HTTP response:",
            header.split("\r\n")[0]
          );

          if (
            !/^HTTP\/1\.1 101/i.test(header)
          ) {

            clearTimeout(timeout);

            return finish({
              ok: false,
              hello: false,
              error:
                `WebSocket upgrade failed: ${header.split("\r\n")[0]}`
            });
          }

          handshakeComplete = true;

          console.log(
            "Discord raw WebSocket: UPGRADE SUCCESSFUL"
          );

          const remaining =
            handshakeBuffer.subarray(
              headerEnd + 4
            );

          frameBuffer =
            Buffer.concat([
              frameBuffer,
              remaining
            ]);

          handshakeBuffer =
            Buffer.alloc(0);

        } else {

          frameBuffer =
            Buffer.concat([
              frameBuffer,
              chunk
            ]);
        }


        if (!handshakeComplete) {
          return;
        }


        const frames =
          parseWebSocketFrames(
            frameBuffer
          );

        // We don't know how many bytes were
        // consumed by the parser, so for this
        // diagnostic we keep enough data for
        // normal Discord HELLO frames.
        //
        // Once a frame is successfully parsed,
        // clear the buffer.
        if (frames.length) {
          frameBuffer = Buffer.alloc(0);
        }


        for (const frame of frames) {

          if (frame.opcode === 0x8) {

            let closeCode = null;
            let closeReason = "";

            if (frame.payload.length >= 2) {
              closeCode =
                frame.payload.readUInt16BE(0);

              closeReason =
                frame.payload
                  .subarray(2)
                  .toString();
            }

            console.error(
              "Discord raw WebSocket: CLOSE received:",
              closeCode,
              closeReason
            );

            clearTimeout(timeout);

            return finish({
              ok: false,
              hello: false,
              closeCode,
              closeReason
            });
          }


          if (frame.opcode === 0x9) {
            console.log(
              "Discord raw WebSocket: PING received."
            );

            continue;
          }


          if (frame.opcode !== 0x1) {
            continue;
          }


          const text =
            frame.payload.toString();

          let data;

          try {
            data = JSON.parse(text);
          } catch {
            continue;
          }


          console.log(
            "Discord raw WebSocket: RECEIVED OP",
            data.op
          );


          if (data.op === 10) {

            console.log(
              "Discord raw WebSocket: HELLO RECEIVED"
            );

            clearTimeout(timeout);

            return finish({
              ok: true,
              hello: true
            });
          }
        }
      });


      socket.on("timeout", () => {

        console.error(
          "Discord raw WebSocket: socket timeout."
        );

        clearTimeout(timeout);

        finish({
          ok: false,
          hello: false,
          error: "socket timeout"
        });
      });


      socket.on("error", (err) => {

        console.error(
          "Discord raw WebSocket error:",
          err?.stack || err
        );

        clearTimeout(timeout);

        finish({
          ok: false,
          hello: false,
          error:
            err?.message || String(err)
        });
      });


      socket.on("close", () => {

        if (settled) {
          return;
        }

        console.error(
          "Discord raw WebSocket closed before HELLO."
        );

        clearTimeout(timeout);

        finish({
          ok: false,
          hello: false,
          error: "socket closed"
        });
      });

    } catch (err) {

      clearTimeout(timeout);

      console.error(
        "Discord raw WebSocket diagnostic exception:",
        err?.stack || err
      );

      finish({
        ok: false,
        hello: false,
        error:
          err?.message || String(err)
      });
    }
  });
}


// ============================================================
// DISCORD LOGIN
// ============================================================

async function loginDiscord(
  reason = "startup"
) {

  if (client.isReady()) {

    console.log(
      `Discord is already connected; ignoring login request (${reason}).`
    );

    return true;
  }

  if (loginInProgress) {

    console.log(
      `Discord login is already in progress; ignoring login request (${reason}).`
    );

    return false;
  }

  if (!process.env.DISCORD_TOKEN) {

    console.error(
      "DISCORD_TOKEN is missing; cannot connect to Discord."
    );

    return false;
  }

  loginInProgress = true;

  console.log("");
  console.log("========================================");
  console.log(
    `Attempting Discord login (${reason})...`
  );
  console.log("========================================");

  console.log(
    "discord.js version:",
    require("discord.js").version
  );

  console.log(
    "Discord WebSocket options:",
    {
      version: "10",
      encoding: "json",
      compression: null,
      handshakeTimeout: 30000,
      helloTimeout: 60000,
      readyTimeout: 30000
    }
  );

  console.log(
    "Token exists:",
    Boolean(process.env.DISCORD_TOKEN)
  );

  console.log(
    "Token length:",
    process.env.DISCORD_TOKEN.length
  );


  try {

    console.log(
      "Calling client.login()..."
    );

    console.log(
      "Waiting for discord.js Gateway events..."
    );

    const loginPromise =
      client.login(
        process.env.DISCORD_TOKEN
      );


    const watchdog =
      new Promise((_, reject) => {

        setTimeout(() => {

          reject(
            new Error(
              "discord.js login did not finish within 90 seconds."
            )
          );

        }, 90000);
      });


    await Promise.race([
      loginPromise,
      watchdog
    ]);


    console.log(
      "client.login() promise completed."
    );

    console.log(
      "client.isReady():",
      client.isReady()
    );

    console.log(
      "client.user:",
      client.user
        ? `${client.user.tag} (${client.user.id})`
        : "none"
    );

    return true;

  } catch (err) {

    console.error("");
    console.error(
      "========================================"
    );
    console.error(
      "Discord login failed or timed out"
    );
    console.error(
      "========================================"
    );

    console.error(
      err?.stack || err
    );

    const status =
      err?.status ??
      err?.statusCode ??
      err?.response?.status;

    const code =
      err?.code ??
      err?.cause?.code;

    if (status) {
      console.error(
        `Discord/HTTP status: ${status}`
      );
    }

    if (code) {
      console.error(
        `Error code: ${code}`
      );
    }

    console.error(
      "Client ready state:",
      client.isReady()
    );

    console.error(
      "Discord user:",
      client.user
        ? client.user.tag
        : "none"
    );

    return false;

  } finally {

    loginInProgress = false;
  }
}


// ============================================================
// NETWORK DIAGNOSTIC
// ============================================================

async function runDiscordNetworkDiagnostic() {

  console.log("");
  console.log("========================================");
  console.log("Discord network diagnostic starting...");
  console.log("========================================");


  // DNS: discord.com
  try {

    const result =
      await dns.lookup(
        "discord.com"
      );

    console.log(
      `Discord DNS (discord.com): OK -> ${result.address}`
    );

  } catch (err) {

    console.error(
      "Discord DNS (discord.com): FAILED",
      err?.message || err
    );
  }


  // DNS: gateway.discord.gg
  try {

    const result =
      await dns.lookup(
        "gateway.discord.gg"
      );

    console.log(
      `Discord Gateway DNS (gateway.discord.gg): OK -> ${result.address}`
    );

  } catch (err) {

    console.error(
      "Discord Gateway DNS (gateway.discord.gg): FAILED",
      err?.message || err
    );
  }


  // HTTPS test
  await new Promise((resolve) => {

    const request =
      require("https").get(
        "https://discord.com/",
        {
          timeout: 10000
        },
        (response) => {

          console.log(
            `Discord HTTPS (discord.com): OK -> HTTP ${response.statusCode}`
          );

          response.resume();

          response.on(
            "end",
            resolve
          );
        }
      );

    request.on("timeout", () => {

      console.error(
        "Discord HTTPS (discord.com): TIMEOUT"
      );

      request.destroy();

      resolve();
    });

    request.on("error", (err) => {

      console.error(
        "Discord HTTPS (discord.com): FAILED",
        err?.message || err
      );

      resolve();
    });
  });


  // TLS test
  await new Promise((resolve) => {

    const socket =
      tls.connect({
        host: "gateway.discord.gg",
        port: 443,
        servername: "gateway.discord.gg",
        rejectUnauthorized: true,
        timeout: 10000
      });

    socket.once(
      "secureConnect",
      () => {

        console.log(
          "Discord Gateway TLS (gateway.discord.gg:443): OK"
        );

        socket.destroy();

        resolve();
      }
    );

    socket.once(
      "timeout",
      () => {

        console.error(
          "Discord Gateway TLS: TIMEOUT"
        );

        socket.destroy();

        resolve();
      }
    );

    socket.once(
      "error",
      (err) => {

        console.error(
          "Discord Gateway TLS: FAILED",
          err?.message || err
        );

        socket.destroy();

        resolve();
      }
    );
  });


  console.log("");
  console.log("========================================");
  console.log("Discord network diagnostic finished.");
  console.log("========================================");
}


// ============================================================
// START
// ============================================================

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


  // First verify basic Discord connectivity.
  await runDiscordNetworkDiagnostic();


  // Then independently verify that the Gateway
  // can complete a WebSocket upgrade and send HELLO.
  const rawResult =
    await runRawDiscordWebSocketDiagnostic();


  if (
    rawResult?.ok &&
    rawResult?.hello
  ) {

    console.log("");
    console.log(
      "Raw WebSocket works. Starting discord.js login..."
    );

  } else {

    console.error("");
    console.error(
      "Raw WebSocket diagnostic failed."
    );

    console.error(
      "Skipping discord.js login because the Gateway test failed."
    );

    return;
  }


  // Finally start discord.js.
  loginDiscord("startup");
}


start().catch((err) => {

  console.error(
    "Fatal startup error:",
    err?.stack || err
  );

  process.exit(1);
});
