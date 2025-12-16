require("dotenv").config();

/* =========================
   Render keep-alive (FREE web service needs a port)
========================= */
const http = require("http");
const PORT = process.env.PORT || 3000;
http
  .createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("sparxo online\n");
  })
  .listen(PORT, () => console.log("Keep-alive server on", PORT));

/* =========================
   Imports
========================= */
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
   ENV
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

  DELETE_AFTER_SECONDS: Number(process.env.DELETE_AFTER_SECONDS || 60),
  AI_COOLDOWN_SECONDS: Number(process.env.AI_COOLDOWN_SECONDS || 10),
};

if (!ENV.DISCORD_TOKEN) console.error("❌ Missing DISCORD_TOKEN");
if (!ENV.OPENAI_KEY) console.error("❌ Missing OPENAI_KEY");
if (!ENV.AI_CHANNEL_ID) console.error("❌ Missing AI_CHANNEL_ID");
if (!ENV.ADMIN_CHANNEL_ID) console.error("❌ Missing ADMIN_CHANNEL_ID");

/* =========================
   Settings
========================= */
const DELETE_AFTER_MS = Math.max(10, ENV.DELETE_AFTER_SECONDS) * 1000;
const COOLDOWN_MS = Math.max(1, ENV.AI_COOLDOWN_SECONDS) * 1000;
const MAX_IMAGES = 2;
const MAX_TOKENS = 450; // keep short-ish

/* =========================
   Discord client + OpenAI
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
   RATE-LIMIT CIRCUIT BREAKER
   Only trip it on real OpenAI 429 / rate_limit code
========================= */
let aiBlockedUntil = 0;

/* =========================
   Helpers
========================= */
function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function chunkText(text, size = 1900) {
  const t = String(text || "");
  const chunks = [];
  for (let i = 0; i < t.length; i += size) chunks.push(t.slice(i, i + size));
  return chunks.length ? chunks : [""];
}

async function replyChunks(message, text) {
  const chunks = chunkText(text);
  const sent = [];
  for (const part of chunks) {
    const m = await message.reply(part);
    sent.push(m);
  }
  return sent;
}

function isAdmin(member) {
  if (!member) return false;
  return (
    member.permissions.has(PermissionsBitField.Flags.Administrator) ||
    member.permissions.has(PermissionsBitField.Flags.ManageGuild)
  );
}

function isEducationRelated(text) {
  const t = (text || "").toLowerCase();
  const words = [
    "math",
    "algebra",
    "geometry",
    "trig",
    "calculus",
    "equation",
    "simplify",
    "factor",
    "science",
    "physics",
    "chemistry",
    "biology",
    "english",
    "essay",
    "grammar",
    "literature",
    "history",
    "geography",
    "homework",
    "revision",
    "exam",
    "test",
    "worksheet",
    "question",
    "solve",
    "prove",
    "derive",
    "calculate",
    "evaluate",
  ];
  return words.some((w) => t.includes(w));
}

function needsWeb(text) {
  const t = (text || "").toLowerCase();
  const triggers = [
    "latest",
    "today",
    "current",
    "news",
    "update",
    "updated",
    "release",
    "version",
    "price",
    "cost",
    "in stock",
    "availability",
    "2024",
    "2025",
    "2026",
  ];
  return triggers.some((w) => t.includes(w));
}

/* =========================
   Web search (ONLY used when needed)
========================= */
async function webSearch(query) {
  if (!ENV.SERPAPI_KEY) return [];
  const { data } = await axios.get("https://serpapi.com/search.json", {
    params: { engine: "google", q: query, api_key: ENV.SERPAPI_KEY, num: 5 },
    timeout: 15000,
  });

  return (data.organic_results || []).slice(0, 4).map((r) => ({
    title: r.title,
    link: r.link,
    snippet: String(r.snippet || "").slice(0, 180),
  }));
}

/* =========================
   AI channel cleaning (only in AI_CHANNEL_ID)
========================= */
let aiCleanEnabled = true;

function allowedInAiChannel(content) {
  const c = (content || "").trim().toLowerCase();
  return (
    c.startsWith("!ai ") ||
    c.startsWith("!aiw ") ||
    c.startsWith("!aiclean ") ||
    c.startsWith("!brainrot ") ||
    c === "!panel" ||
    c === "!help"
  );
}

/* =========================
   Anti-double reply + cooldown + in-flight lock
========================= */
const handled = new Set();
function markHandled(id) {
  handled.add(id);
  setTimeout(() => handled.delete(id), 5 * 60 * 1000);
}

const inFlight = new Set(); // ensures 1 AI request per message

const lastUse = new Map();
function onCooldown(userId) {
  const now = Date.now();
  const prev = lastUse.get(userId) || 0;
  if (now - prev < COOLDOWN_MS) return true;
  lastUse.set(userId, now);
  return false;
}

/* =========================
   Brainrot (ONLY posts in BRAINROT_CHANNEL_ID)
   IMPORTANT: NO OpenAI here
========================= */
let brainrotEnabled = true;
let brainrotTimer = null;

const BRAINROT_LINES = [
  "67 67 67",
  "admin abuse is on today ✅",
  "admin abuse is not on today ❌",
  "math is NOT mathing",
  "certified nerd moment 🤓",
  "we move",
  "bro forgot the minus sign again",
];

async function startBrainrot() {
  if (brainrotTimer) clearInterval(brainrotTimer);
  brainrotTimer = null;

  if (!brainrotEnabled) return;
  if (!ENV.BRAINROT_CHANNEL_ID) return;

  const ch = await client.channels.fetch(ENV.BRAINROT_CHANNEL_ID).catch(() => null);
  if (!ch) {
    console.error("Brainrot channel not found. Check BRAINROT_CHANNEL_ID.");
    return;
  }

  const minutes = Math.max(1, ENV.BRAINROT_INTERVAL_MINUTES);
  console.log(`Brainrot ON every ${minutes} minutes (channel only)`);

  brainrotTimer = setInterval(async () => {
    try {
      await ch.send(pick(BRAINROT_LINES));
    } catch (e) {
      console.error("Brainrot send error:", e?.message || e);
    }
  }, minutes * 60 * 1000);
}

/* =========================
   Panel (button -> modal -> dropdowns -> admin)
========================= */
const IDS = {
  BTN_START: "start_request",
  MODAL: "req_modal",
  FIELD_DETAILS: "details",
  SEL_SUBJECT: "sel_subject",
  SEL_TYPE: "sel_type",
};

const sessions = new Map();

async function sendPanel(channelId) {
  if (!channelId) return;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) return;

  const embed = new EmbedBuilder()
    .setTitle("Sparxo Sparx Helper")
    .setDescription("Click below to request help.\n**Do NOT share passwords or private info.**");

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(IDS.BTN_START)
      .setLabel("Start Homework request")
      .setStyle(ButtonStyle.Primary)
  );

  await channel.send({ embeds: [embed], components: [row] });
}

/* =========================
   AI (Sparxo persona + tutor)
========================= */
function systemPrompt(isTutor) {
  return (
    `You are "Sparxo", a chill, nerdy, funny helper for teens.

Academic integrity:
- Do NOT help users cheat or "complete" graded tasks for them.
- Teach the method, give hints, explain steps, and help them learn.

Style:
- If maths/science/education: step-by-step and explain why.
- Otherwise: chill, casual, but still helpful.
- Keep it not too long unless the user asks for detail.`
    + (isTutor ? "\nTutor mode: step-by-step." : "\nChill mode.")
  );
}

async function runAI({ prompt, imageUrls, forceWeb }) {
  const tutor = isEducationRelated(prompt);

  const doWeb = forceWeb || needsWeb(prompt);
  const results = doWeb ? await webSearch(prompt) : [];

  const sourcesBlock = results.length
    ? results.map((r, i) => `${i + 1}) ${r.title} — ${r.snippet}\n${r.link}`).join("\n\n")
    : "";

  const userContent = [
    {
      type: "text",
      text:
        `User message:\n${prompt}\n\n` +
        (results.length ? `Helpful web snippets:\n${sourcesBlock}\n\n` : "") +
        `If an image is attached, briefly describe it then answer.`,
    },
  ];

  for (const url of (imageUrls || []).slice(0, MAX_IMAGES)) {
    userContent.push({ type: "image_url", image_url: { url } });
  }

  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    max_tokens: MAX_TOKENS,
    messages: [
      { role: "system", content: systemPrompt(tutor) },
      { role: "user", content: userContent },
    ],
  });

  let out = resp.choices?.[0]?.message?.content ?? "No response.";

  if (results.length) {
    out += "\n\nSources:\n" + results.map((r, i) => `${i + 1}) ${r.link}`).join("\n");
  }

  return out;
}

/* =========================
   Ready
========================= */
client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);
  console.log("messageCreate listeners:", client.listenerCount("messageCreate"));
  console.log("process pid:", process.pid);

  if (ENV.PANEL_CHANNEL_ID) await sendPanel(ENV.PANEL_CHANNEL_ID);
  await startBrainrot();
});

/* =========================
   Message commands
========================= */
client.on("messageCreate", async (message) => {
  try {
    // Ignore DMs, bots, and webhooks (prevents phantom loops)
    if (!message.guild) return;
    if (!message.author) return;
    if (message.author.bot) return;
    if (message.webhookId) return;

    // AI channel cleaning
    if (aiCleanEnabled && ENV.AI_CHANNEL_ID && message.channel.id === ENV.AI_CHANNEL_ID) {
      if (!allowedInAiChannel(message.content)) {
        setTimeout(() => message.delete().catch(() => {}), 1500);
        return;
      }
    }

    if (message.content === "!help") {
      return message.reply(
        "Commands:\n" +
          "`!ai <question>` (normal)\n" +
          "`!aiw <question>` (force web search)\n" +
          "`!aiclean on/off` (admin)\n" +
          "`!brainrot on/off` (admin)\n" +
          "`!panel` (admin) reposts the panel"
      );
    }

    // Admin toggles
    if (message.content.startsWith("!aiclean")) {
      if (!message.guild || !isAdmin(message.member)) return message.reply("Admins only.");
      const arg = message.content.split(/\s+/)[1]?.toLowerCase();
      if (arg === "on") {
        aiCleanEnabled = true;
        return message.reply("✅ AI cleaning ON");
      }
      if (arg === "off") {
        aiCleanEnabled = false;
        return message.reply("🛑 AI cleaning OFF");
      }
      return message.reply("Use `!aiclean on` or `!aiclean off`");
    }

    if (message.content.startsWith("!brainrot")) {
      if (!message.guild || !isAdmin(message.member)) return message.reply("Admins only.");
      const arg = message.content.split(/\s+/)[1]?.toLowerCase();
      if (arg === "on") {
        brainrotEnabled = true;
        await startBrainrot();
        return message.reply("✅ Brainrot ON");
      }
      if (arg === "off") {
        brainrotEnabled = false;
        await startBrainrot();
        return message.reply("🛑 Brainrot OFF");
      }
      return message.reply("Use `!brainrot on` or `!brainrot off`");
    }

    if (message.content === "!panel") {
      if (!message.guild || !isAdmin(message.member)) return message.reply("Admins only.");
      if (!ENV.PANEL_CHANNEL_ID) return message.reply("PANEL_CHANNEL_ID not set.");
      await sendPanel(ENV.PANEL_CHANNEL_ID);
      return message.reply("✅ Panel sent.");
    }

    // AI commands
    const isAiw = message.content.startsWith("!aiw ");
    const isAi = message.content.startsWith("!ai ");
    if (!isAiw && !isAi) return;

    // Circuit breaker check + show remaining time
    if (Date.now() < aiBlockedUntil) {
      const leftMs = aiBlockedUntil - Date.now();
      const leftSec = Math.ceil(leftMs / 1000);
      return message.reply(`😴 Sparxo is cooling down (rate limit). Try again in ${leftSec}s.`);
    }

    // prevent double handling
    if (handled.has(message.id)) return;
    markHandled(message.id);

    // cooldown
    if (onCooldown(message.author.id)) {
      return message.reply("⏳ Chill 😭 try again in a few seconds.");
    }

    const prompt = message.content.slice(isAiw ? 4 : 3).trim();
    if (!prompt) return message.reply("Use `!ai your question` (or `!aiw` to force web).");

    // ensure 1 AI request per message no matter what
    if (inFlight.has(message.id)) return;
    inFlight.add(message.id);

    await message.channel.sendTyping().catch(() => {});

    // images
    const imageUrls = [];
    for (const att of message.attachments.values()) {
      const ct = att.contentType || "";
      if (ct.startsWith("image/")) imageUrls.push(att.url);
    }

    console.log("[OPENAI] calling", {
      messageId: message.id,
      userId: message.author.id,
      channelId: message.channel.id,
      forceWeb: isAiw,
    });

    let out;
    try {
      out = await runAI({ prompt, imageUrls, forceWeb: isAiw });
    } catch (err) {
      const status = err?.status ?? err?.response?.status;
      const code = String(err?.code || err?.error?.code || "");
      const msg = String(err?.message || "");

      console.error("[OPENAI ERROR]", { status, code, message: msg });

      // ✅ only trip circuit breaker on real 429 / rate_limit code
      if (status === 429 || code.includes("rate_limit")) {
        aiBlockedUntil = Date.now() + 3 * 60 * 1000;
        console.error("[AI BLOCK] OpenAI rate limit. Blocking until:", new Date(aiBlockedUntil).toISOString());
        return message.reply("😭 OpenAI rate limit — cooling down for 3 minutes.");
      }

      if (status === 401 || msg.toLowerCase().includes("invalid api key")) {
        return message.reply("❌ AI key error (admin needs to fix OPENAI_KEY in Render).");
      }

      return message.reply("❌ AI error. Try again soon.");
    } finally {
      inFlight.delete(message.id);
    }

    const sent = await replyChunks(message, out);

    setTimeout(async () => {
      for (const m of sent) await m.delete().catch(() => {});
      await message.delete().catch(() => {});
    }, DELETE_AFTER_MS);
  } catch (e) {
    console.error("messageCreate error:", e);
    try {
      await message.reply("❌ Error. Check logs.");
    } catch {}
  }
});

/* =========================
   Panel interactions
========================= */
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isButton() && interaction.customId === IDS.BTN_START) {
      const modal = new ModalBuilder().setCustomId(IDS.MODAL).setTitle("Help Request");

      const details = new TextInputBuilder()
        .setCustomId(IDS.FIELD_DETAILS)
        .setLabel("Explain what you need help with (don’t share passwords)")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(1000);

      modal.addComponents(new ActionRowBuilder().addComponents(details));
      return await interaction.showModal(modal);
    }

    if (interaction.isModalSubmit() && interaction.customId === IDS.MODAL) {
      const details = interaction.fields.getTextInputValue(IDS.FIELD_DETAILS);
      sessions.set(interaction.user.id, { details });

      const subject = new StringSelectMenuBuilder()
        .setCustomId(IDS.SEL_SUBJECT)
        .setPlaceholder("Choose subject")
        .addOptions(
          { label: "Maths", value: "Maths", emoji: "🔢" },
          { label: "Science", value: "Science", emoji: "🔬" },
          { label: "English/Reading", value: "English/Reading", emoji: "📚" },
          { label: "Other", value: "Other", emoji: "🧠" }
        );

      return await interaction.reply({
        content: "✅ Got it. Pick a subject:",
        components: [new ActionRowBuilder().addComponents(subject)],
        ephemeral: true,
      });
    }

    if (interaction.isStringSelectMenu() && interaction.customId === IDS.SEL_SUBJECT) {
      const s = sessions.get(interaction.user.id);
      if (!s) return interaction.reply({ content: "Session expired. Try again.", ephemeral: true });

      s.subject = interaction.values[0];

      const type = new StringSelectMenuBuilder()
        .setCustomId(IDS.SEL_TYPE)
        .setPlaceholder("Choose request type")
        .addOptions(
          { label: "Homework", value: "Homework", emoji: "📃" },
          { label: "XP", value: "XP", emoji: "✅" },
          { label: "Other", value: "Other", emoji: "💡" }
        );

      return interaction.update({
        content: `✅ Subject: **${s.subject}**\nNow pick request type:`,
        components: [new ActionRowBuilder().addComponents(type)],
      });
    }

    if (interaction.isStringSelectMenu() && interaction.customId === IDS.SEL_TYPE) {
      const s = sessions.get(interaction.user.id);
      if (!s) return interaction.reply({ content: "Session expired. Try again.", ephemeral: true });

      s.type = interaction.values[0];

      const admin = await client.channels.fetch(ENV.ADMIN_CHANNEL_ID).catch(() => null);
      if (!admin) {
        return interaction.update({
          content: "❌ Admin channel not found. Check ADMIN_CHANNEL_ID.",
          components: [],
        });
      }

      const embed = new EmbedBuilder()
        .setTitle("New Sparxo Help Request")
        .addFields(
          { name: "User", value: `${interaction.user.tag} (${interaction.user.id})` },
          { name: "Server", value: interaction.guild?.name ?? "Unknown" },
          { name: "Subject", value: s.subject ?? "—" },
          { name: "Type", value: s.type ?? "—" },
          { name: "Details", value: (s.details || "—").slice(0, 1024) }
        )
        .setTimestamp();

      await admin.send({ embeds: [embed] });
      sessions.delete(interaction.user.id);

      return interaction.update({ content: "✅ Sent to admins. Thanks!", components: [] });
    }
  } catch (e) {
    console.error("interaction error:", e);
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: "❌ Error. Try again.", ephemeral: true }).catch(() => {});
    }
  }
});

/* =========================
   Login
========================= */
client.login(ENV.DISCORD_TOKEN);







