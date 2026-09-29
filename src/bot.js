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

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

let loginInProgress = false;
let slashCommandsRegistered = false;

const app = express();
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

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

client.once("ready", async () => {
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
      err?.message || err
    );
  }
});

client.on("error", (err) => {
  console.error(
    "Discord client error:",
    err?.message || err
  );
});

client.on("shardError", (err) => {
  console.error(
    "Discord shard error:",
    err?.message || err
  );
});

client.on("shardDisconnect", (event, shardId) => {
  console.error(
    `Discord shard ${shardId} disconnected:`,
    event?.code,
    event?.reason || ""
  );
});

client.on("shardReconnecting", (shardId) => {
  console.log(
    `Discord shard ${shardId} is reconnecting...`
  );
});

client.on("shardReady", (shardId) => {
  console.log(
    `Discord shard ${shardId} is ready.`
  );
});


// =========================
// DATABASE
// =========================

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


// =========================
// USER LOGGING
// =========================

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
      "ROBLOX_LOG_CHANNEL_ID is not set."
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
    `Logged new Roblox user ${name} (${id})`
  );

  return true;
}


// =========================
// ACCESS FUNCTIONS
// =========================

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


// =========================
// WEB ROUTES
// =========================

app.get("/", (_req, res) => {
  res.status(200).send(
    client.isReady()
      ? "All-In-One Approver is online and connected to Discord."
      : "All-In-One Approver web service is online, but the Discord bot is not connected."
  );
});


// IMPORTANT:
// /wake does NOT perform a gateway HTTP request.
// It only starts one Discord.js login if needed.

app.get("/wake", (_req, res) => {
  if (client.isReady()) {
    return res.status(200).json({
      ok: true,
      connected: true,
      message: "Discord bot is already online."
    });
  }

  if (loginInProgress) {
    return res.status(202).json({
      ok: true,
      connected: false,
      message:
        "Discord login is already in progress. Check /health."
    });
  }

  loginDiscord("/wake");

  return res.status(202).json({
    ok: true,
    connected: false,
    message:
      "Discord login started. Check /health or Render logs."
  });
});


app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    discordConnected: client.isReady(),
    discordUser: client.user?.tag || null,
    slashCommandsRegistered
  });
});


// =========================
// ROBLOX CHECK
// =========================

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

    const status = await getPermanentStatus(
      userId
    );

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


// =========================
// ACCESS REQUEST
// =========================

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
      const dm = await owner.createDM();

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
      approved: false,
      pending: true
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


// =========================
// DISCORD INTERACTIONS
// =========================

client.on(
  "interactionCreate",
  async (interaction) => {

    // COPY USER ID BUTTON
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


    // SLASH COMMANDS
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


        if (command === "unwhitelist") {

          if (!/^\d+$/.test(userId || "")) {
            return interaction.editReply(
              "❌ Invalid Roblox UserId.`
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


        if (command === "unblacklist") {

          if (!/^\d+$/.test(userId || "")) {
            return interaction.editReply(
              "❌ Invalid Roblox UserId."
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


// =========================
// DISCORD LOGIN
// =========================

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

  console.log(
    `Attempting Discord login (${reason})...`
  );


  try {

    // Discord.js handles the Gateway connection itself.
    // No manual /gateway HTTP request.
    await client.login(
      process.env.DISCORD_TOKEN
    );

    console.log(
      "Discord login call completed; waiting for READY event..."
    );

    return true;

  } catch (err) {

    console.error(
      "Discord login failed:"
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

    // IMPORTANT:
    // Do not immediately retry.
    // Discord.js handles Gateway reconnects itself.

    return false;

  } finally {

    loginInProgress = false;
  }
}


// =========================
// START SERVER
// =========================

async function start() {

  try {

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

    // ONE login attempt on startup.
    // No gateway diagnostic request.
    loginDiscord("startup");

  } catch (err) {

    console.error(
      "Fatal startup error:",
      err?.stack || err
    );

    process.exit(1);
  }
}

start();
