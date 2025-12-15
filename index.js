require("dotenv").config();

const axios = require("axios");
const OpenAI = require("openai");
const {
  Client,
  GatewayIntentBits,
  Events,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
  PermissionsBitField,
} = require("discord.js");

/* =========================
   ENV / SETTINGS
========================= */
const ENV = {
  DISCORD_TOKEN: process.env.DISCORD_TOKEN,
  OPENAI_KEY: process.env.OPENAI_KEY,
  SERPAPI_KEY: process.env.SERPAPI_KEY || "",
  ADMIN_CHANNEL_ID: process.env.ADMIN_CHANNEL_ID || "",
  PANEL_CHANNEL_ID: process.env.PANEL_CHANNEL_ID || "",
  AI_CHANNEL_ID: process.env.AI_CHANNEL_ID || "",
  BRAINROT_CHANNEL_ID: process.env.BRAINROT_CHANNEL_ID || "",
  BRAINROT_INTERVAL_MINUTES: Number(process.env.BRAINROT_INTERVAL_MINUTES || 20),
};

const DELETE_AFTER_MS = 60_000; // 1 minute
const AI_COOLDOWN_MS = 10_000;  // 10s per user
const MAX_IMAGES = 2;

/* =========================
   DISCORD CLIENT
========================= */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const openai = new OpenAI({ apiKey: ENV.OPENAI_KEY });

/* =========================
   UTIL
========================= */
function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function chunkText(text, size = 1900) {
  const chunks = [];
  const t = String(text || "");
  for (let i = 0; i < t.length; i += size) chunks.push(t.slice(i, i + size));
  return chunks.length ? chunks : [""];
}

async function replyInChunks(message, text) {
  const chunks = chunkText(text);
  const sent = [];
  for (const part of chunks) {
    // reply() keeps context; use send() if you prefer
    const m = await message.reply(part);
    sent.push(m);
  }
  return sent;
}

function isEducationRelated(text) {
  const t = (text || "").toLowerCase();
  const words = [
    "math","algebra","geometry","trig","calculus","equation","simplify","factor",
    "science","physics","chemistry","biology",
    "english","essay","grammar","literature",
    "history","geography",
    "homework","revision","exam","test","worksheet","question",
    "solve","prove","derive","calculate","evaluate",
  ];
  return words.some(w => t.includes(w));
}

function needsWeb(text) {
  const t = (text || "").toLowerCase();
  const triggers = [
    "latest","today","current","news","update","updated","release","version",
    "price","cost","in stock","availability",
    "2024","2025","2026",
  ];
  return triggers.some(w => t.includes(w));
}

async function webSearch(query) {
  if (!ENV.SERPAPI_KEY) return [];
  const { data } = await axios.get("https://serpapi.com/search.json", {
    params: { engine: "google", q: query, api_key: ENV.SERPAPI_KEY, num: 5 },
    timeout: 15000,
  });
  return (data.organic_results || []).slice(0, 5).map(r => ({
    title: r.title,
    link: r.link,
    snippet: r.snippet,
  }));
}

function isAdmin(member) {
  if (!member) return false;
  return member.permissions.has(PermissionsBitField.Flags.Administrator) ||
         member.permissions.has(PermissionsBitField.Flags.ManageGuild);
}

/* =========================
   AI CHANNEL CLEANING
   (only deletes non-ai messages inside AI_CHANNEL_ID)
========================= */
let aiCleanEnabled = true; // you can toggle with !aiclean on/off (admin)
function isAllowedInAiChannel(content) {
  const c = (content || "").trim().toLowerCase();
  return (
    c.startsWith("!ai ") ||
    c.startsWith("!aiw ") ||
    c.startsWith("!brainrot ") ||
    c.startsWith("!aiclean ")
  );
}

/* =========================
   ANTI DOUBLE-REPLY + COOLDOWN
========================= */
const handledMessageIds = new Set();
setInterval(() => handledMessageIds.clear(), 5 * 60 * 1000);

const lastAiUse = new Map(); // userId -> timestamp

function onCooldown(userId) {
  const now = Date.now();
  const prev = lastAiUse.get(userId) || 0;
  if (now - prev < AI_COOLDOWN_MS) return true;
  lastAiUse.set(userId, now);
  return false;
}

/* =========================
   BRAINROT
========================= */
let brainrotEnabled = true;
let brainrotTimer = null;

const BRAINROT_LINES = [
  "67 67 67",
  "admin abuse is on today ✅",
  "admin abuse is not on today ❌",
  "math was NOT mathing",
  "certified nerd moment 🤓",
  "we move",
  "skill issue (respectfully)",
];

async function startBrainrot() {
  if (brainrotTimer) clearInterval(brainrotTimer);
  brainrotTimer = null;

  if (!brainrotEnabled) return;
  if (!ENV.BRAINROT_CHANNEL_ID) return;

  const channel = await client.channels.fetch(ENV.BRAINROT_CHANNEL_ID).catch(() => null);
  if (!channel) {
    console.error("Brainrot channel not found. Check BRAINROT_CHANNEL_ID.");
    return;
  }

  const minutes = Math.max(1, ENV.BRAINROT_INTERVAL_MINUTES);
  console.log(`Brainrot ON every ${minutes} minutes`);

  brainrotTimer = setInterval(async () => {
    try {
      await channel.send(pick(BRAINROT_LINES));
    } catch (e) {
      console.error("Brainrot error:", e?.message || e);
    }
  }, minutes * 60 * 1000);
}

/* =========================
   PANEL (Request wizard)
========================= */
const IDS = {
  BTN_START: "start_request",
  MODAL: "request_modal",
  FIELD_DETAILS: "details",
  SEL_PLATFORM: "select_platform",
  SEL_TYPE: "select_type",
};

const sessions = new Map();

async function postPanelOnce() {
  if (!ENV.PANEL_CHANNEL_ID) return;

  const channel = await client.channels.fetch(ENV.PANEL_CHANNEL_ID).catch(() => null);
  if (!channel) {
    console.error("Panel channel not found. Check PANEL_CHANNEL_ID.");
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle("Request Bot")
    .setDescription(
      "Click the button below to submit a one-time request.\n" +
      "Do **not** enter passwords or sensitive info."
    );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(IDS.BTN_START)
      .setLabel("Start Request")
      .setStyle(ButtonStyle.Primary)
  );

  await channel.send({ embeds: [embed], components: [row] });
}

/* =========================
   READY
========================= */
client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  await postPanelOnce();
  await startBrainrot();
});

/* =========================
   MESSAGE COMMANDS
========================= */
client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot) return;

    // AI channel auto-clean
    if (aiCleanEnabled && ENV.AI_CHANNEL_ID && message.channel.id === ENV.AI_CHANNEL_ID) {
      if (!isAllowedInAiChannel(message.content)) {
        setTimeout(() => message.delete().catch(() => {}), 2000);
        return;
      }
    }

    // admin toggle AI cleaning
    if (message.content.startsWith("!aiclean")) {
      if (!message.guild) return;
      if (!isAdmin(message.member)) return message.reply("Admins only.");

      const arg = message.content.split(/\s+/)[1]?.toLowerCase();
      if (arg === "on") {
        aiCleanEnabled = true;
        return message.reply("✅ AI channel cleaning: ON");
      }
      if (arg === "off") {
        aiCleanEnabled = false;
        return message.reply("🛑 AI channel cleaning: OFF");
      }
      return message.reply("Use `!aiclean on` or `!aiclean off`");
    }

    // brainrot toggle
    if (message.content.startsWith("!brainrot")) {
      if (!message.guild) return;
      if (!isAdmin(message.member)) return message.reply("Admins only.");

      const arg = message.content.split(/\s+/)[1]?.toLowerCase();
      if (arg === "on") {
        brainrotEnabled = true;
        await startBrainrot();
        return message.reply("✅ Brainrot: ON");
      }
      if (arg === "off") {
        brainrotEnabled = false;
        await startBrainrot();
        return message.reply("🛑 Brainrot: OFF");
      }
      return message.reply("Use `!brainrot on` or `!brainrot off`");
    }

    // AI commands
    const isAiw = message.content.startsWith("!aiw ");
    const isAi = message.content.startsWith("!ai ");
    if (!isAiw && !isAi) return;

    // prevent double-processing
    if (handledMessageIds.has(message.id)) return;
    handledMessageIds.add(message.id);

    if (onCooldown(message.author.id)) {
      return message.reply("⏳ Slow down a sec (cooldown). Try again in a few seconds.");
    }

    const prompt = message.content.slice(isAiw ? 4 : 3).trim();
    if (!prompt) return message.reply("Use: `!ai your question` or `!aiw your question`");

    await message.channel.sendTyping().catch(() => {});

    // images
    const imageUrls = [];
    for (const att of message.attachments.values()) {
      const ct = att.contentType || "";
      if (ct.startsWith("image/")) imageUrls.push(att.url);
    }

    const tutor = isEducationRelated(prompt);
    const systemPrompt = tutor
      ? "You are a chill-but-smart tutor for a teen. Teach step-by-step and help them understand."
      : "You are a chill, friendly assistant for a teen. Be casual and helpful.";

    const doWeb = isAiw || needsWeb(prompt);
    const results = doWeb ? await webSearch(prompt) : [];

    const sourcesText = results.length
      ? results.map((r, i) => `${i + 1}) ${r.title}\n${r.snippet}\n${r.link}`).join("\n\n")
      : "No web search used.";

    const userContent = [
      {
        type: "text",
        text:
          `User message:\n${prompt}\n\n` +
          `Web info (only if needed):\n${sourcesText}\n\n` +
          `If an image is attached, describe what you see before answering.`,
      },
    ];

    for (const url of imageUrls.slice(0, MAX_IMAGES)) {
      userContent.push({ type: "image_url", image_url: { url } });
    }

    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
    });

    let out = resp.choices?.[0]?.message?.content ?? "No response.";

    if (!tutor) out += `\n\n${pick(["🫡","lol","real","fair","🤝","we move"])}`;

    if (results.length) {
      out += "\n\nSources:\n" + results.map((r, i) => `${i + 1}) ${r.link}`).join("\n");
    }

    // send safely in chunks (NO crashes)
    const sentMsgs = await replyInChunks(message, out);

    // delete command + bot replies after 1 minute
    setTimeout(async () => {
      for (const m of sentMsgs) await m.delete().catch(() => {});
      await message.delete().catch(() => {});
    }, DELETE_AFTER_MS);

  } catch (e) {
    console.error("messageCreate error:", e);
    try {
      await message.reply("❌ Error. Check logs / keys / permissions.");
    } catch {}
  }
});

/* =========================
   PANEL INTERACTIONS
========================= */
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // Button -> Modal
    if (interaction.isButton() && interaction.customId === IDS.BTN_START) {
      const modal = new ModalBuilder()
        .setCustomId(IDS.MODAL)
        .setTitle("Request Details");

      const details = new TextInputBuilder()
        .setCustomId(IDS.FIELD_DETAILS)
        .setLabel("What do you need help with?")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(1000);

      modal.addComponents(new ActionRowBuilder().addComponents(details));
      return await interaction.showModal(modal);
    }

    // Modal submit -> platform dropdown
    if (interaction.isModalSubmit() && interaction.customId === IDS.MODAL) {
      const details = interaction.fields.getTextInputValue(IDS.FIELD_DETAILS);
      sessions.set(interaction.user.id, { details });

      const platform = new StringSelectMenuBuilder()
        .setCustomId(IDS.SEL_PLATFORM)
        .setPlaceholder("Choose a platform")
        .addOptions(
          { label: "Maths", value: "Maths", emoji: "🔢" },
          { label: "Science", value: "Science", emoji: "🔬" },
          { label: "Reading", value: "Reading", emoji: "📚" }
        );

      return await interaction.reply({
        content: "✅ Saved! Choose your platform:",
        components: [new ActionRowBuilder().addComponents(platform)],
        ephemeral: true,
      });
    }

    // Platform select -> type dropdown
    if (interaction.isStringSelectMenu() && interaction.customId === IDS.SEL_PLATFORM) {
      const session = sessions.get(interaction.user.id);
      if (!session) {
        return await interaction.reply({
          content: "Session expired. Click the panel button again.",
          ephemeral: true,
        });
      }

      session.platform = interaction.values[0];
      sessions.set(interaction.user.id, session);

      const type = new StringSelectMenuBuilder()
        .setCustomId(IDS.SEL_TYPE)
        .setPlaceholder("Choose task type")
        .addOptions(
          { label: "Homework", value: "Homework", emoji: "📝" },
          { label: "XP Boosts", value: "XP Boosts", emoji: "🚀" }
        );

      return await interaction.update({
        content: `✅ Platform: **${session.platform}**\nNow choose task type:`,
        components: [new ActionRowBuilder().addComponents(type)],
      });
    }

    // Type select -> send to admin channel
    if (interaction.isStringSelectMenu() && interaction.customId === IDS.SEL_TYPE) {
      const session = sessions.get(interaction.user.id);
      if (!session) {
        return await interaction.reply({
          content: "Session expired. Click the panel button again.",
          ephemeral: true,
        });
      }

      session.type = interaction.values[0];

      const adminChannel = await client.channels
        .fetch(ENV.ADMIN_CHANNEL_ID)
        .catch(() => null);

      if (!adminChannel) {
        return await interaction.update({
          content: "❌ Admin channel not found. Check ADMIN_CHANNEL_ID.",
          components: [],
        });
      }

      const embed = new EmbedBuilder()
        .setTitle("New Request")
        .addFields(
          { name: "User", value: `${interaction.user.tag} (${interaction.user.id})` },
          { name: "From Server", value: interaction.guild?.name ?? "Unknown" },
          { name: "Platform", value: session.platform ?? "—" },
          { name: "Task Type", value: session.type ?? "—" },
          { name: "Details", value: (session.details || "—").slice(0, 1024) }
        )
        .setTimestamp();

      await adminChannel.send({ embeds: [embed] });
      sessions.delete(interaction.user.id);

      return await interaction.update({
        content: "✅ Sent to admins! Thanks.",
        components: [],
      });
    }
  } catch (e) {
    console.error("interaction error:", e);
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: "❌ Error. Try again.", ephemeral: true }).catch(() => {});
    }
  }
});

/* =========================
   LOGIN
========================= */
client.login(ENV.DISCORD_TOKEN);



