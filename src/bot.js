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
const dns = require("dns").promises;
const https = require("https");
const tls = require("tls");


// =========================
// REQUIRED ENVIRONMENT VARIABLES
// =========================

for (const name of [
  "DISCORD_TOKEN",
  "OWNER_ID",
  "APPROVAL_CHANNEL_ID",
  "DATABASE_URL"
]) {
  if (!process.env[name]) {
    console.error(
      `Missing required environment variable: ${name}`
    );

    process.exit(1);
  }
}


// =========================
// DISCORD CLIENT
// =========================

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds
  ]
});

let loginInProgress = false;
let slashCommandsRegistered = false;


// =========================
// EXPRESS SERVER
// =========================

const app = express();

app.use(express.json());


// =========================
// DATABASE
// =========================

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,

  ssl: {
    rejectUnauthorized: false
  }
});


// =========================
// DISCORD DEBUG EVENTS
// =========================

client.on("debug", (message) => {
  console.log(
    `[discord.js DEBUG] ${message}`
  );
});


client.on("warn", (message) => {
  console.warn(
    `[discord.js WARN] ${message}`
  );
});


client.on("error", (err) => {
  console.error(
    "[discord.js ERROR]",
    err?.stack || err
  );
});


client.on("shardError", (err, shardId) => {
  console.error(
    `[discord.js SHARD ERROR] shard=${shardId}`,
    err?.stack || err
  );
});


client.on("shardReconnecting", (shardId) => {
  console.log(
    `[discord.js SHARD RECONNECTING] shard=${shardId}`
  );
});


client.on("shardDisconnect", (event, shardId) => {
  console.error(
    `[discord.js SHARD DISCONNECT] shard=${shardId}`,
    `code=${event?.code}`,
    `reason=${event?.reason || "none"}`
  );
});


client.on("shardReady", (shardId) => {
  console.log(
    `[discord.js SHARD READY] shard=${shardId}`
  );
});


// =========================
// DISCORD READY
// =========================

client.once("ready", async () => {
  console.log(
    `Discord bot is READY as ${client.user.tag} (${client.user.id})`
  );

  console.log(
    `Connected to ${client.guilds.cache.size} guild(s).`
  );

  try {
    const approvalChannel =
      await client.channels
        .fetch(
          String(
            process.env.APPROVAL_CHANNEL_ID
          )
        )
        .catch((err) => {

          console.error(
            "Could not fetch APPROVAL_CHANNEL_ID:",
            err?.message || err
          );

          return null;
        });


    const guild =
      approvalChannel?.guild;


    if (guild) {

      await guild.commands.set(
        slashCommands
      );

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


// =========================
// DATABASE INITIALIZATION
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


  console.log(
    "Database initialized."
  );
}


// =========================
// LOG NEW ROBLOX USER
// =========================

async function logNewHubUser(
  userId,
  username
) {

  const id =
    String(userId).trim();

  const name =
    String(
      username || "unknown"
    ).trim();


  const existing =
    await pool.query(
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


  const channelId =
    String(
      process.env.ROBLOX_LOG_CHANNEL_ID || ""
    ).trim();


  if (!channelId) {

    console.error(
      "ROBLOX_LOG_CHANNEL_ID is not set; cannot log new Roblox users."
    );

    return false;
  }


  const channel =
    await client.channels
      .fetch(channelId)
      .catch((err) => {

        console.error(
          "Could not fetch ROBLOX_LOG_CHANNEL_ID:",
          err?.message || err
        );

        return null;
      });


  if (
    !channel ||
    !channel.isTextBased()
  ) {

    console.error(
      "ROBLOX_LOG_CHANNEL_ID is not a text-based Discord channel."
    );

    return false;
  }


  const logRow =
    new ActionRowBuilder()
      .addComponents(

        new ButtonBuilder()
          .setCustomId(
            `copyid:${id}`
          )
          .setLabel(
            "Copy User ID"
          )
          .setEmoji("📋")
          .setStyle(
            ButtonStyle.Secondary
          )
      );


  try {

    await channel.send({
      content:
        `Roblox Username: **${name}**\n` +
        `User ID: \`${id}\``,

      components: [
        logRow
      ]
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
      (
        user_id,
        username,
        logged_at
      )
    VALUES
      (
        $1,
        $2,
        NOW()
      )
    ON CONFLICT (user_id)
    DO UPDATE SET
      username = EXCLUDED.username,
      logged_at = NOW()
    `,
    [
      id,
      name
    ]
  );


  console.log(
    `Logged new Roblox user ${name} (${id}) to channel ${channelId}`
  );


  return true;
}


// =========================
// ACCESS STATUS
// =========================

async function getPermanentStatus(
  userId
) {

  const id =
    String(userId);


  const black =
    await pool.query(
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


  const white =
    await pool.query(
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


// =========================
// SESSION DECISION
// =========================

async function getSessionDecision(
  userId,
  sessionId
) {

  const result =
    await pool.query(
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


// =========================
// SET SESSION DECISION
// =========================

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
      (
        $1,
        $2,
        $3,
        $4,
        NOW()
      )
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


// =========================
// WHITELIST
// =========================

async function addWhitelist(
  userId,
  username
) {

  await pool.query(
    `
    INSERT INTO permanent_whitelist
      (
        user_id,
        username
      )
    VALUES
      (
        $1,
        $2
      )
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
    [
      String(userId)
    ]
  );
}


// =========================
// BLACKLIST
// =========================

async function addBlacklist(
  userId,
  username
) {

  await pool.query(
    `
    INSERT INTO permanent_blacklist
      (
        user_id,
        username
      )
    VALUES
      (
        $1,
        $2
      )
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
    [
      String(userId)
    ]
  );


  await pool.query(
    `
    DELETE FROM access_sessions
    WHERE user_id = $1
    `,
    [
      String(userId)
    ]
  );
}


// =========================
// REMOVE WHITELIST
// =========================

async function removeWhitelist(
  userId
) {

  const result =
    await pool.query(
      `
      DELETE FROM permanent_whitelist
      WHERE user_id = $1
      `,
      [
        String(userId)
      ]
    );


  return result.rowCount > 0;
}


// =========================
// REMOVE BLACKLIST
// =========================

async function removeBlacklist(
  userId
) {

  const result =
    await pool.query(
      `
      DELETE FROM permanent_blacklist
      WHERE user_id = $1
      `,
      [
        String(userId)
      ]
    );


  return result.rowCount > 0;
}


// =========================
// GET LISTS
// =========================

async function getLists() {

  const white =
    await pool.query(
      `
      SELECT
        user_id,
        username,
        approved_at
      FROM permanent_whitelist
      ORDER BY approved_at DESC
      `
    );


  const black =
    await pool.query(
      `
      SELECT
        user_id,
        username,
        blocked_at
      FROM permanent_blacklist
      ORDER BY blocked_at DESC
      `
    );


  return {
    whitelist: white.rows,
    blacklist: black.rows
  };
}


// =========================
// SLASH COMMANDS
// =========================

const slashCommands = [

  {
    name: "whitelist",

    description:
      "Permanently allow a user to open the hub",

    options: [

      {
        name: "user_id",

        description:
          "Roblox UserId",

        type: 3,

        required: true
      },

      {
        name: "username",

        description:
          "Roblox username (optional)",

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

        description:
          "Roblox UserId",

        type: 3,

        required: true
      },

      {
        name: "username",

        description:
          "Roblox username (optional)",

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

        description:
          "Roblox UserId",

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

        description:
          "Roblox UserId",

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


// =========================
// WEB SERVER
// =========================

app.get(
  "/",
  (_req, res) => {

    res.status(200).send(

      client.isReady()

        ? "All-In-One Approver is online and connected to Discord."

        : "All-In-One Approver web service is online, but the Discord bot is not connected."
    );
  }
);


// =========================
// WAKE
// =========================

app.get(
  "/wake",
  (_req, res) => {

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


    loginDiscord(
      "/wake"
    );


    return res.status(202).json({
      ok: true,
      connected: false,

      message:
        "Discord login started in the background. Check /health or Render logs."
    });
  }
);


// =========================
// HEALTH
// =========================

app.get(
  "/health",
  (_req, res) => {

    res.json({

      ok: true,

      discordConnected:
        client.isReady(),

      discordUser:
        client.user?.tag || null,

      slashCommandsRegistered
    });
  }
);


// =========================
// ROBLOX CHECK
// =========================

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


      const username =
        String(
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
        await getPermanentStatus(
          userId
        );


      if (
        status === "blacklisted"
      ) {

        return res.json({

          ok: true,

          approved: false,

          denied: true,

          permanent: true
        });
      }


      if (
        status === "whitelisted"
      ) {

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
  }
);


// =========================
// ACCESS REQUEST
// =========================

app.post(
  "/request",
  async (req, res) => {

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


      if (
        !userId ||
        !sessionId
      ) {

        return res.status(400).json({

          error:
            "userId and sessionId are required"
        });
      }


      const permanentStatus =
        await getPermanentStatus(
          userId
        );


      if (
        permanentStatus === "blacklisted"
      ) {

        return res.json({

          ok: true,

          approved: false,

          denied: true,

          permanent: true
        });
      }


      if (
        permanentStatus === "whitelisted"
      ) {

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


      const embed =
        new EmbedBuilder()

          .setTitle(
            "Hub Access Request"
          )

          .setDescription(
            `**${displayName || username}** (\`${username}\`) wants to open the hub.`
          )

          .addFields(

            {
              name: "Roblox User",

              value:
                String(username),

              inline: true
            },

            {
              name: "UserId",

              value:
                String(userId),

              inline: true
            },

            {
              name: "Place",

              value:
                String(
                  place || "unknown"
                ),

              inline: true
            },

            {
              name: "Place ID",

              value:
                String(
                  placeId || "unknown"
                ),

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

          .setColor(
            0xff3333
          )

          .setTimestamp();


      const row =
        new ActionRowBuilder()
          .addComponents(

            new ButtonBuilder()

              .setCustomId(
                `accept:${userId}:${sessionId}:${username}`
              )

              .setLabel(
                "Accept"
              )

              .setStyle(
                ButtonStyle.Success
              ),


            new ButtonBuilder()

              .setCustomId(
                `deny:${userId}:${sessionId}:${username}`
              )

              .setLabel(
                "Deny"
              )

              .setStyle(
                ButtonStyle.Danger
              ),


            new ButtonBuilder()

              .setCustomId(
                `whitelist:${userId}:${sessionId}:${username}`
              )

              .setLabel(
                "Whitelist"
              )

              .setStyle(
                ButtonStyle.Primary
              ),


            new ButtonBuilder()

              .setCustomId(
                `blacklist:${userId}:${sessionId}:${username}`
              )

              .setLabel(
                "Blacklist"
              )

              .setStyle(
                ButtonStyle.Secondary
              )
          );


      const owner =
        await client.users
          .fetch(
            String(
              process.env.OWNER_ID
            )
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

          embeds: [
            embed
          ],

          components: [
            row
          ]
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

        error:
          "request failed"
      });
    }
  }
);


// =========================
// DISCORD INTERACTIONS
// =========================

client.on(
  "interactionCreate",
  async (interaction) => {


    // =========================
    // COPY USER ID
    // =========================

    if (
      interaction.isButton() &&
      interaction.customId.startsWith(
        "copyid:"
      )
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


      if (
        !/^\d+$/.test(userId)
      ) {

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


    // =========================
    // SLASH COMMANDS
    // =========================

    if (
      interaction.isChatInputCommand()
    ) {

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
            .getString(
              "user_id"
            )
            ?.trim();


        const username =
          interaction.options
            .getString(
              "username"
            )
            ?.trim() ||
          "unknown";


        await interaction.deferReply({
          ephemeral: true
        });


        // =========================
        // /WHITELIST
        // =========================

        if (
          command === "whitelist"
        ) {

          if (
            !/^\d+$/.test(
              userId || ""
            )
          ) {

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


        // =========================
        // /BLACKLIST
        // =========================

        if (
          command === "blacklist"
        ) {

          if (
            !/^\d+$/.test(
              userId || ""
            )
          ) {

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


        // =========================
        // /UNWHITELIST
        // =========================

        if (
          command === "unwhitelist"
        ) {

          if (
            !/^\d+$/.test(
              userId || ""
            )
          ) {

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


        // =========================
        // /UNBLACKLIST
        // =========================

        if (
          command === "unblacklist"
        ) {

          if (
            !/^\d+$/.test(
              userId || ""
            )
          ) {

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


        // =========================
        // /LIST
        // =========================

        if (
          command === "list"
        ) {

          const {
            whitelist,
            blacklist
          } =
            await getLists();


          const format =
            (rows) =>

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
                    ).slice(
                      0,
                      1024
                    ),

                  inline: false
                },

                {
                  name:
                    `⛔ Blacklist (${blacklist.length})`,

                  value:
                    format(
                      blacklist
                    ).slice(
                      0,
                      1024
                    ),

                  inline: false
                }
              )

              .setColor(
                0x5865f2
              )

              .setTimestamp();


          return interaction.editReply({

            embeds: [
              embed
            ]
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
            .catch(
              () => {}
            );

        } else {

          await interaction
            .reply({

              content:
                "❌ Database error while running that command.",

              ephemeral: true

            })
            .catch(
              () => {}
            );
        }
      }


      return;
    }


    // =========================
    // BUTTON CHECK
    // =========================

    if (
      !interaction.isButton()
    ) {

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
      interaction.customId.split(
        ":"
      );


    const action =
      parts[0];


    const userId =
      parts[1];


    const sessionId =
      parts[2];


    const username =
      parts
        .slice(3)
        .join(":") ||
      "unknown";


    try {


      // =========================
      // ACCEPT
      // =========================

      if (
        action === "accept"
      ) {

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


      // =========================
      // DENY
      // =========================

      if (
        action === "deny"
      ) {

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


      // =========================
      // WHITELIST
      // =========================

      if (
        action === "whitelist"
      ) {

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


      // =========================
      // BLACKLIST
      // =========================

      if (
        action === "blacklist"
      ) {

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
          .catch(
            () => {}
          );
      }
    }
  }
);


// =========================
// DISCORD NETWORK DIAGNOSTIC
// =========================

function testHttpsConnection(
  hostname,
  path = "/",
  timeoutMs = 10000
) {

  return new Promise(
    (resolve) => {

      const request =
        https.get(

          {
            hostname,

            path,

            method: "GET",

            headers: {
              "User-Agent":
                "All-In-One-Approver-Diagnostic"
            }
          },

          (response) => {

            response.resume();


            response.on(
              "end",
              () => {

                resolve({

                  ok: true,

                  status:
                    response.statusCode
                });
              }
            );
          }
        );


      request.setTimeout(

        timeoutMs,

        () => {

          request.destroy(
            new Error(
              "HTTPS connection timed out"
            )
          );
        }
      );


      request.on(
        "error",
        (err) => {

          resolve({

            ok: false,

            error:
              err?.message ||
              String(err),

            code:
              err?.code ||
              null
          });
        }
      );
    }
  );
}


// =========================
// GATEWAY TLS TEST
// =========================

function testGatewayTls(
  hostname = "gateway.discord.gg",
  port = 443,
  timeoutMs = 10000
) {

  return new Promise(
    (resolve) => {

      let finished = false;


      const finish =
        (result) => {

          if (finished) {
            return;
          }

          finished = true;

          resolve(result);
        };


      const socket =
        tls.connect({

          host:
            hostname,

          port,

          servername:
            hostname,

          timeout:
            timeoutMs
        });


      socket.once(
        "secureConnect",
        () => {

          finish({

            ok: true,

            authorized:
              socket.authorized,

            authorizationError:
              socket.authorizationError ||
              null
          });


          socket.destroy();
        }
      );


      socket.once(
        "timeout",
        () => {

          finish({

            ok: false,

            error:
              "TLS connection timed out"
          });


          socket.destroy();
        }
      );


      socket.once(
        "error",
        (err) => {

          finish({

            ok: false,

            error:
              err?.message ||
              String(err),

            code:
              err?.code ||
              null
          });
        }
      );
    }
  );
}


// =========================
// DISCORD NETWORK DIAGNOSTIC
// =========================

async function diagnoseDiscordNetwork() {

  console.log(
    "========================================"
  );

  console.log(
    "Discord network diagnostic starting..."
  );

  console.log(
    "========================================"
  );


  // =========================
  // DNS: DISCORD.COM
  // =========================

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
      "Discord DNS (discord.com): FAILED ->",
      err?.message || err
    );
  }


  // =========================
  // DNS: GATEWAY
  // =========================

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
      "Discord Gateway DNS (gateway.discord.gg): FAILED ->",
      err?.message || err
    );
  }


  // =========================
  // HTTPS
  // =========================

  const httpsResult =
    await testHttpsConnection(
      "discord.com",
      "/",
      10000
    );


  if (
    httpsResult.ok
  ) {

    console.log(
      `Discord HTTPS (discord.com): OK -> HTTP ${httpsResult.status}`
    );

  } else {

    console.error(

      "Discord HTTPS (discord.com): FAILED ->",

      httpsResult.error,

      httpsResult.code
        ? `(code: ${httpsResult.code})`
        : ""
    );
  }


  // =========================
  // GATEWAY TLS
  // =========================

  const tlsResult =
    await testGatewayTls();


  if (
    tlsResult.ok
  ) {

    console.log(
      "Discord Gateway TLS (gateway.discord.gg:443): OK"
    );


    if (
      !tlsResult.authorized
    ) {

      console.warn(

        "Discord Gateway TLS certificate was not reported as authorized:",

        tlsResult.authorizationError ||
          "unknown certificate error"
      );
    }

  } else {

    console.error(

      "Discord Gateway TLS (gateway.discord.gg:443): FAILED ->",

      tlsResult.error,

      tlsResult.code
        ? `(code: ${tlsResult.code})`
        : ""
    );
  }


  console.log(
    "========================================"
  );

  console.log(
    "Discord network diagnostic finished."
  );

  console.log(
    "========================================"
  );
}


// =========================
// DISCORD LOGIN
// =========================

async function loginDiscord(
  reason = "startup"
) {

  if (
    client.isReady()
  ) {

    console.log(

      `Discord is already connected; ignoring login request (${reason}).`
    );

    return true;
  }


  if (
    loginInProgress
  ) {

    console.log(

      `Discord login is already in progress; ignoring login request (${reason}).`
    );

    return false;
  }


  if (
    !process.env.DISCORD_TOKEN
  ) {

    console.error(
      "DISCORD_TOKEN is missing; cannot connect to Discord."
    );

    return false;
  }


  loginInProgress = true;


  console.log(
    `Attempting Discord login (${reason})...`
  );


  // =========================
  // DISCORD.JS VERSION
  // =========================

  try {

    console.log(

      `discord.js version: ${
        require("discord.js").version ||
        "unknown"
      }`

    );

  } catch (err) {

    console.log(
      "Could not determine discord.js version."
    );
  }


  let loginPromise;


  try {

    // IMPORTANT:
    //
    // Do NOT manually call Discord's /gateway endpoint.
    //
    // discord.js handles the Gateway connection itself.

    loginPromise =
      client.login(
        process.env.DISCORD_TOKEN
      );


    const timeoutPromise =
      new Promise(
        (_, reject) => {

          setTimeout(
            () => {

              reject(
                new Error(
                  "Discord login timed out after 30 seconds."
                )
              );

            },
            30000
          );
        }
      );


    await Promise.race([

      loginPromise,

      timeoutPromise

    ]);


    console.log(
      "Discord login call completed."
    );


    return true;


  } catch (err) {

    console.error(
      "Discord login failed or timed out:"
    );


    console.error(
      err?.stack || err
    );


    console.error(
      "Client ready state:",
      client.isReady()
    );


    console.error(
      "Discord user:",
      client.user?.tag ||
      "none"
    );


    try {

      await client.destroy();


      console.log(
        "Stuck Discord connection destroyed."
      );

    } catch (destroyErr) {

      console.error(

        "Error destroying Discord connection:",

        destroyErr?.message ||
          destroyErr
      );
    }


    return false;


  } finally {

    loginInProgress = false;
  }
}


// =========================
// START
// =========================

async function start() {

  await initDb();


  const port =
    Number(
      process.env.PORT ||
      10000
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


  // =========================
  // TEST DISCORD NETWORK FIRST
  // =========================

  await diagnoseDiscordNetwork();


  // =========================
  // CONNECT TO DISCORD
  // =========================

  loginDiscord(
    "startup"
  );
}


start().catch(
  (err) => {

    console.error(
      "Fatal startup error:",
      err?.stack ||
        err
    );


    process.exit(1);
  }
);
