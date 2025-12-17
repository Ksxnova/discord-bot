require("dotenv").config();

const http = require("http");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const OpenAI = require("openai");
const crypto = require("crypto");

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
   Keep-alive (Render needs a port)
========================= */
const PORT = process.env.PORT || 3000;
http
  .createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("sparxo online\n");
  })
  .listen(PORT, () => console.log("Keep-alive server on", PORT));

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

  // ✅ Plans
  SPARXO_PLUS_ROLE_ID: process.env.SPARXO_PLUS_ROLE_ID || "",
  SPARXO_PRO_ROLE_ID: process.env.SPARXO_PRO_ROLE_ID || "",
};

function requireEnv(key, value) {
  if (!value) console.error(`❌ Missing ${key}`);
}
requireEnv("DISCORD_TOKEN", ENV.DISCORD_TOKEN);
requireEnv("OPENAI_KEY", ENV.OPENAI_KEY);
requireEnv("AI_CHANNEL_ID", ENV.AI_CHANNEL_ID);
requireEnv("ADMIN_CHANNEL_ID", ENV.ADMIN_CHANNEL_ID);

const SETTINGS = {
  DELETE_AFTER_MS: Math.max(10, ENV.DELETE_AFTER_SECONDS) * 1000,
  COOLDOWN_MS: Math.max(1, ENV.AI_COOLDOWN_SECONDS) * 1000,
  MAX_IMAGES: 2,
  MAX_TOKENS: 450,
  MODEL: "gpt-4o-mini",

  // ✅ Plan limits (per hour)
  FREE_PER_HOUR: 2,
  PLUS_PER_HOUR: 4,
  // PRO: unlimited
};

/* =========================
   Discord client + OpenAI
========================= */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers, // ✅ needed for role syncing
  ],
});

const openai = new OpenAI({ apiKey: ENV.OPENAI_KEY });

/* =========================
   Circuit breaker / Locks
========================= */
let aiBlockedUntil = 0;
let globalAiBusy = false;

const handled = new Set();
setInterval(() => handled.clear(), 5 * 60 * 1000);

const lastUse = new Map();
function onCooldown(userId) {
  const now = Date.now();
  const prev = lastUse.get(userId) || 0;
  if (now - prev < SETTINGS.COOLDOWN_MS) return true;
  lastUse.set(userId, now);
  return false;
}

/* =========================
   ✅ Missing helpers added back
========================= */
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

function parseRetryAfterMs(msgLower) {
  const m = msgLower.match(/try again in\s+(\d+)m(\d+)s/i);
  if (m) return (Number(m[1]) * 60 + Number(m[2])) * 1000;
  const s = msgLower.match(/try again in\s+(\d+)s/i);
  if (s) return Number(s[1]) * 1000;
  return null;
}

/* =========================
   Clean embed replies
========================= */
function splitForEmbed(text, maxLen = 3800) {
  const s = String(text || "").trim();
  if (!s) return ["(no response)"];
  const parts = [];
  for (let i = 0; i < s.length; i += maxLen) parts.push(s.slice(i, i + maxLen));
  return parts;
}

async function sendCleanEmbeds(channelOrMessage, text) {
  const parts = splitForEmbed(text, 3800);
  const sent = [];

  const sendFn = channelOrMessage.send
    ? (payload) => channelOrMessage.send(payload)
    : (payload) => channelOrMessage.reply(payload);

  const first = new EmbedBuilder().setDescription(parts[0]);
  sent.push(await sendFn({ embeds: [first] }));

  for (let i = 1; i < parts.length && i < 3; i++) {
    const e = new EmbedBuilder().setDescription(parts[i]);
    sent.push(
      await (channelOrMessage.channel?.send?.bind(channelOrMessage.channel) || sendFn)({
        embeds: [e],
      })
    );
  }

  if (parts.length > 3) {
    sent.push(
      await (channelOrMessage.channel?.send?.bind(channelOrMessage.channel) || sendFn)({
        embeds: [new EmbedBuilder().setDescription("…(trimmed)")],
      })
    );
  }

  return sent;
}

/* =========================
   AI channel cleaning
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
    c === "!help" ||
    c === "!aistatus" ||
    c === "!aiclear" ||
    c === "!plan" ||
    c === "!usage" ||
    c.startsWith("!setplan ") ||
    c === "!syncplans"
  );
}

/* =========================
   Brainrot (NO OpenAI)
========================= */
let brainrotEnabled = true;
let brainrotTimer = null;

const BRAINROT_LINES = [
  "67 67 67",
  "Sparxo admin abuse is on today ✅",
  "Sparxo admin abuse is not on today ❌",
  "math is NOT mathing",
  "certified nerd moment 🤓",
  "we move",
  "bro forgot the minus sign again",
];

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

async function startBrainrot() {
  if (brainrotTimer) clearInterval(brainrotTimer);
  brainrotTimer = null;

  if (!brainrotEnabled) return;
  if (!ENV.BRAINROT_CHANNEL_ID) return;

  const ch = await client.channels.fetch(ENV.BRAINROT_CHANNEL_ID).catch(() => null);
  if (!ch) return console.error("Brainrot channel not found. Check BRAINROT_CHANNEL_ID.");

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
   Panel (admin request flow)
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
    .setTitle("Sparxo Helper Panel")
    .setDescription("Click below to get your homework done.\n**Your homework will be completed shortly**");

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(IDS.BTN_START).setLabel("Start request").setStyle(ButtonStyle.Primary)
  );

  await channel.send({ embeds: [embed], components: [row] });
}

/* =========================
   Plan system (Plus/Pro)
========================= */
const PLANS_FILE = path.join(__dirname, "plans.json");

function loadPlanOverrides() {
  try {
    if (!fs.existsSync(PLANS_FILE)) return {};
    return JSON.parse(fs.readFileSync(PLANS_FILE, "utf8")) || {};
  } catch {
    return {};
  }
}
function savePlanOverrides(obj) {
  try {
    fs.writeFileSync(PLANS_FILE, JSON.stringify(obj, null, 2), "utf8");
  } catch (e) {
    console.error("Failed to write plans.json:", e?.message || e);
  }
}

let planOverrides = loadPlanOverrides();

function safeKeyHash(key) {
  if (!key) return "missing";
  return crypto.createHash("sha256").update(key).digest("hex").slice(0, 12);
}

function isAdmin(member) {
  if (!member) return false;
  return (
    member.permissions.has(PermissionsBitField.Flags.Administrator) ||
    member.permissions.has(PermissionsBitField.Flags.ManageGuild)
  );
}

function getUserPlan(member) {
  if (!member) return "free";
  const override = planOverrides[member.id];
  if (override === "pro" || override === "plus" || override === "free") return override;

  const hasPro = ENV.SPARXO_PRO_ROLE_ID && member.roles.cache.has(ENV.SPARXO_PRO_ROLE_ID);
  const hasPlus = ENV.SPARXO_PLUS_ROLE_ID && member.roles.cache.has(ENV.SPARXO_PLUS_ROLE_ID);
  if (hasPro) return "pro";
  if (hasPlus) return "plus";
  return "free";
}

const usage = new Map();
function getLimitForPlan(plan) {
  if (plan === "pro") return Infinity;
  if (plan === "plus") return SETTINGS.PLUS_PER_HOUR;
  return SETTINGS.FREE_PER_HOUR;
}
function canUseAI(userId, plan) {
  const now = Date.now();
  let u = usage.get(userId);
  if (!u || now > u.resetAt) u = { count: 0, resetAt: now + 60 * 60 * 1000 };

  const limit = getLimitForPlan(plan);
  if (u.count >= limit) {
    usage.set(userId, u);
    return { ok: false, resetInSec: Math.ceil((u.resetAt - now) / 1000) };
  }
  u.count++;
  usage.set(userId, u);
  return { ok: true, resetInSec: Math.ceil((u.resetAt - now) / 1000) };
}

function usageStatus(userId, plan) {
  const now = Date.now();
  const u = usage.get(userId);
  const limit = getLimitForPlan(plan);
  if (plan === "pro") return { plan, limit: "unlimited", used: u?.count || 0, resetInSec: u ? Math.ceil((u.resetAt - now) / 1000) : 3600 };
  if (!u || now > u.resetAt) return { plan, limit, used: 0, resetInSec: 3600 };
  return { plan, limit, used: u.count, resetInSec: Math.ceil((u.resetAt - now) / 1000) };
}

async function applyPlanRole(member, plan) {
  if (!member?.guild) return;
  const proId = ENV.SPARXO_PRO_ROLE_ID;
  const plusId = ENV.SPARXO_PLUS_ROLE_ID;
  if (!proId && !plusId) return;

  const hasPro = proId ? member.roles.cache.has(proId) : false;
  const hasPlus = plusId ? member.roles.cache.has(plusId) : false;

  if (plan === "pro") {
    if (proId && !hasPro) await member.roles.add(proId).catch(() => {});
    if (plusId && hasPlus) await member.roles.remove(plusId).catch(() => {});
    return;
  }

  if (plan === "plus") {
    if (plusId && !hasPlus) await member.roles.add(plusId).catch(() => {});
    if (proId && hasPro) await member.roles.remove(proId).catch(() => {});
    return;
  }

  if (plusId && hasPlus) await member.roles.remove(plusId).catch(() => {});
  if (proId && hasPro) await member.roles.remove(proId).catch(() => {});
}

async function syncAllPlans(guild) {
  if (!guild) return;
  const members = await guild.members.fetch().catch(() => null);
  if (!members) return;

  for (const [userId, plan] of Object.entries(planOverrides)) {
    const m = members.get(userId);
    if (m) await applyPlanRole(m, plan);
  }
}

/* =========================
   AI logic
========================= */
function systemPrompt(isTutor) {
  return (
`You are "Sparxo", a helpful assistant for teens.

Output rules:
- Give ONLY the answer. No meta talk.
- Keep it clean and direct.
- If schoolwork: explain the method/steps so they learn.

If maths/science:
- Use numbered steps.
- Keep equations on separate lines.
- Final answer on its own line.`
    + (isTutor ? "\nTutor mode: step-by-step." : "\nNormal mode.")
  );
}

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
        (results.length ? `Helpful web snippets (summarize, don't quote):\n${sourcesBlock}\n\n` : "") +
        `Return ONLY the final answer. No "Sources" section.`,
    },
  ];

  for (const url of (imageUrls || []).slice(0, SETTINGS.MAX_IMAGES)) {
    userContent.push({ type: "image_url", image_url: { url } });
  }

  const resp = await openai.chat.completions.create({
    model: SETTINGS.MODEL,
    max_tokens: SETTINGS.MAX_TOKENS,
    messages: [
      { role: "system", content: systemPrompt(tutor) },
      { role: "user", content: userContent },
    ],
  });

  return (resp.choices?.[0]?.message?.content ?? "").trim() || "No response.";
}

/* =========================
   Ready + periodic sync
========================= */
client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);
  console.log("OPENAI_KEY hash:", safeKeyHash(ENV.OPENAI_KEY));
  console.log("messageCreate listeners:", client.listenerCount("messageCreate"));

  if (ENV.PANEL_CHANNEL_ID) await sendPanel(ENV.PANEL_CHANNEL_ID);
  await startBrainrot();

  setInterval(async () => {
    for (const guild of client.guilds.cache.values()) {
      await syncAllPlans(guild);
    }
  }, 10 * 60 * 1000);
});

client.on(Events.GuildMemberAdd, async (member) => {
  const plan = planOverrides[member.id];
  if (plan) await applyPlanRole(member, plan);
});

/* =========================
   Message commands
========================= */
client.on("messageCreate", async (message) => {
  try {
    if (message.author?.bot) return;
    if (!message.guild) return;

    if (aiCleanEnabled && ENV.AI_CHANNEL_ID && message.channel.id === ENV.AI_CHANNEL_ID) {
      if (!allowedInAiChannel(message.content)) {
        setTimeout(() => message.delete().catch(() => {}), 1500);
        return;
      }
    }

    if (message.content === "!help") {
      return message.reply(
        "Commands:\n" +
        "`!ai <question>`\n" +
        "`!aiw <question>` (force web)\n" +
        "`!plan` (shows your plan)\n" +
        "`!usage` (messages left this hour)\n\n" +
        "Admin:\n" +
        "`!aiclean on/off`\n" +
        "`!brainrot on/off`\n" +
        "`!panel`\n" +
        "`!aistatus`\n" +
        "`!aiclear`\n" +
        "`!setplan @user free/plus/pro`\n" +
        "`!syncplans`"
      );
    }

    if (message.content === "!plan") {
      const plan = getUserPlan(message.member);
      return message.reply(`Your plan: **${plan.toUpperCase()}**`);
    }

    if (message.content === "!usage") {
      const plan = getUserPlan(message.member);
      const s = usageStatus(message.author.id, plan);
      const mins = Math.ceil(s.resetInSec / 60);
      if (plan === "pro") return message.reply(`Plan: **PRO** (unlimited). Resets in ~${mins}m.`);
      const remaining = Math.max(0, s.limit - s.used);
      return message.reply(`Plan: **${plan.toUpperCase()}** — remaining: **${remaining}/${s.limit}** (resets in ~${mins}m).`);
    }

    if (message.content === "!aistatus") {
      if (!isAdmin(message.member)) return message.reply("Admins only.");
      const leftSec = Math.max(0, Math.ceil((aiBlockedUntil - Date.now()) / 1000));
      return message.reply(
        "AI status:\n" +
        `• blocked: ${leftSec ? `${leftSec}s left` : "NO"}\n` +
        `• global busy: ${globalAiBusy ? "YES" : "NO"}\n` +
        `• OPENAI_KEY hash: ${safeKeyHash(ENV.OPENAI_KEY)}`
      );
    }

    if (message.content === "!aiclear") {
      if (!isAdmin(message.member)) return message.reply("Admins only.");
      aiBlockedUntil = 0;
      globalAiBusy = false;
      return message.reply("✅ Cleared AI cooldown/busy state.");
    }

    if (message.content.startsWith("!aiclean")) {
      if (!isAdmin(message.member)) return message.reply("Admins only.");
      const arg = message.content.split(/\s+/)[1]?.toLowerCase();
      if (arg === "on") { aiCleanEnabled = true; return message.reply("✅ AI cleaning ON"); }
      if (arg === "off") { aiCleanEnabled = false; return message.reply("🛑 AI cleaning OFF"); }
      return message.reply("Use `!aiclean on` or `!aiclean off`");
    }

    if (message.content.startsWith("!brainrot")) {
      if (!isAdmin(message.member)) return message.reply("Admins only.");
      const arg = message.content.split(/\s+/)[1]?.toLowerCase();
      if (arg === "on") { brainrotEnabled = true; await startBrainrot(); return message.reply("✅ Brainrot ON"); }
      if (arg === "off") { brainrotEnabled = false; await startBrainrot(); return message.reply("🛑 Brainrot OFF"); }
      return message.reply("Use `!brainrot on` or `!brainrot off`");
    }

    if (message.content === "!panel") {
      if (!isAdmin(message.member)) return message.reply("Admins only.");
      if (!ENV.PANEL_CHANNEL_ID) return message.reply("PANEL_CHANNEL_ID not set.");
      await sendPanel(ENV.PANEL_CHANNEL_ID);
      return message.reply("✅ Panel sent.");
    }

    if (message.content.startsWith("!setplan ")) {
      if (!isAdmin(message.member)) return message.reply("Admins only.");
      const parts = message.content.trim().split(/\s+/);
      const plan = (parts[2] || "").toLowerCase();

      const mention = message.mentions.members.first();
      if (!mention) return message.reply("Usage: `!setplan @user free/plus/pro`");
      if (!["free","plus","pro"].includes(plan)) return message.reply("Plan must be: free / plus / pro");

      planOverrides[mention.id] = plan;
      savePlanOverrides(planOverrides);

      await applyPlanRole(mention, plan);
      return message.reply(`✅ Set ${mention.user.tag} to **${plan.toUpperCase()}** and synced roles.`);
    }

    if (message.content === "!syncplans") {
      if (!isAdmin(message.member)) return message.reply("Admins only.");
      await syncAllPlans(message.guild);
      return message.reply("✅ Synced plan roles for all saved users.");
    }

    const isAiw = message.content.startsWith("!aiw ");
    const isAi = message.content.startsWith("!ai ");
    if (!isAiw && !isAi) return;

    if (Date.now() < aiBlockedUntil) {
      const leftSec = Math.max(1, Math.ceil((aiBlockedUntil - Date.now()) / 1000));
      return message.reply(`Cooling down. Try again in ${leftSec}s.`);
    }

    if (handled.has(message.id)) return;
    handled.add(message.id);

    const plan = getUserPlan(message.member);

    if (plan !== "pro" && onCooldown(message.author.id)) {
      return message.reply("Try again in a few seconds.");
    }

    const use = canUseAI(message.author.id, plan);
    if (!use.ok) {
      const mins = Math.ceil(use.resetInSec / 60);
      if (plan === "free") return message.reply(`Limit reached. Try again in ~${mins}m (or upgrade to Plus/Pro).`);
      return message.reply(`Plus limit reached. Try again in ~${mins}m (or upgrade to Pro).`);
    }

    if (globalAiBusy) {
      if (plan !== "pro") return message.reply("Busy. Try again shortly.");
    }
    globalAiBusy = true;

    const prompt = message.content.slice(isAiw ? 4 : 3).trim();
    if (!prompt) {
      globalAiBusy = false;
      return message.reply("Use `!ai your question` (or `!aiw` for web).");
    }

    await message.channel.sendTyping().catch(() => {});

    const imageUrls = [];
    for (const att of message.attachments.values()) {
      const ct = att.contentType || "";
      if (ct.startsWith("image/")) imageUrls.push(att.url);
    }

    let out;
    try {
      out = await runAI({ prompt, imageUrls, forceWeb: isAiw });
    } catch (err) {
      const status = err?.status ?? err?.response?.status;
      const msg = String(err?.message || "").toLowerCase();
      const headers = err?.headers || err?.response?.headers || {};

      if (status === 429 && (msg.includes("rate limit") || msg.includes("rate_limit"))) {
        let waitMs = 180 * 1000;
        const ra = Number(headers["retry-after"]);
        if (Number.isFinite(ra) && ra > 0) waitMs = ra * 1000;
        const parsed = parseRetryAfterMs(msg);
        if (parsed) waitMs = parsed;

        aiBlockedUntil = Math.max(aiBlockedUntil, Date.now() + waitMs);
        return message.reply(`Rate limited. Try again in ${Math.ceil(waitMs / 1000)}s.`);
      }

      if (status === 401 || msg.includes("invalid api key")) {
        return message.reply("Invalid OpenAI key.");
      }

      console.error("OpenAI error:", err);
      return message.reply("AI error. Try again soon.");
    } finally {
      globalAiBusy = false;
    }

    const sent = await sendCleanEmbeds(message, out);

    setTimeout(async () => {
      for (const m of sent) await m.delete().catch(() => {});
      await message.delete().catch(() => {});
    }, SETTINGS.DELETE_AFTER_MS);
  } catch (e) {
    console.error("messageCreate error:", e);
    try { await message.reply("Error. Check logs."); } catch {}
  }
});

/* =========================
   Panel interactions
========================= */
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isButton() && interaction.customId === IDS.BTN_START) {
      const modal = new ModalBuilder().setCustomId(IDS.MODAL).setTitle("Homework Request");

      const details = new TextInputBuilder()
        .setCustomId(IDS.FIELD_DETAILS)
        .setLabel("Your sparx password and mail")
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
        content: "Pick a subject:",
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
        content: `Subject: **${s.subject}**\nPick request type:`,
        components: [new ActionRowBuilder().addComponents(type)],
      });
    }

    if (interaction.isStringSelectMenu() && interaction.customId === IDS.SEL_TYPE) {
      const s = sessions.get(interaction.user.id);
      if (!s) return interaction.reply({ content: "Session expired. Try again.", ephemeral: true });

      s.type = interaction.values[0];

      const admin = await client.channels.fetch(ENV.ADMIN_CHANNEL_ID).catch(() => null);
      if (!admin) return interaction.update({ content: "Admin channel not found.", components: [] });

      const embed = new EmbedBuilder()
        .setTitle("New Help Request")
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

      return interaction.update({ content: "Sent to admins. Thanks!", components: [] });
    }
  } catch (e) {
    console.error("interaction error:", e);
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: "Error. Try again.", ephemeral: true }).catch(() => {});
    }
  }
});

/* =========================
   Login
========================= */
client.login(ENV.DISCORD_TOKEN);










