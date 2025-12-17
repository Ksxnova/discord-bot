require("dotenv").config();

const http = require("http");
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
  ChannelType,
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
  MEMORY_TURNS: 8,          // added: short memory
  MEMORY_TTL_MS: 45 * 60 * 1000,
};

/* =========================
   Client + OpenAI
========================= */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages, // added: DM support
  ],
});

const openai = new OpenAI({ apiKey: ENV.OPENAI_KEY });

/* =========================
   State: cooldowns / locks
========================= */
let aiBlockedUntil = 0;
let globalAiBusy = false;

const inFlightByMessage = new Set();
const handledMessageIds = new Set();

function markHandled(id) {
  handledMessageIds.add(id);
  setTimeout(() => handledMessageIds.delete(id), 5 * 60 * 1000);
}

const lastUseByUser = new Map();
function isOnCooldown(userId) {
  const now = Date.now();
  const prev = lastUseByUser.get(userId) || 0;
  if (now - prev < SETTINGS.COOLDOWN_MS) return true;
  lastUseByUser.set(userId, now);
  return false;
}

/* =========================
   Added: conversation memory
   Keyed by (userId + locationId)
========================= */
const memory = new Map(); // key -> { updatedAt, turns: [{role, content}] }

function memKey(userId, locationId) {
  return `${userId}:${locationId}`;
}

function getMemory(userId, locationId) {
  const k = memKey(userId, locationId);
  const v = memory.get(k);
  if (!v) return [];
  if (Date.now() - v.updatedAt > SETTINGS.MEMORY_TTL_MS) {
    memory.delete(k);
    return [];
  }
  return v.turns || [];
}

function pushMemory(userId, locationId, role, content) {
  const k = memKey(userId, locationId);
  const turns = getMemory(userId, locationId).slice(); // ensures TTL check
  turns.push({ role, content });
  const trimmed = turns.slice(-SETTINGS.MEMORY_TURNS * 2); // ~turn pairs
  memory.set(k, { updatedAt: Date.now(), turns: trimmed });
}

// periodic cleanup
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of memory.entries()) {
    if (!v?.updatedAt || now - v.updatedAt > SETTINGS.MEMORY_TTL_MS) memory.delete(k);
  }
}, 10 * 60 * 1000);

/* =========================
   Added: reply-to-continue mapping
========================= */
const botReplyToLocation = new Map(); // botMessageId -> { userId, locationId }
function rememberBotReply(botMsgId, userId, locationId) {
  botReplyToLocation.set(botMsgId, { userId, locationId, t: Date.now() });
  setTimeout(() => botReplyToLocation.delete(botMsgId), 60 * 60 * 1000);
}

/* =========================
   Helpers
========================= */
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
  return words.some((w) => t.includes(w));
}

function needsWeb(text) {
  const t = (text || "").toLowerCase();
  return [
    "latest","today","current","news","update","updated","release","version",
    "price","cost","in stock","availability","2024","2025","2026",
  ].some((w) => t.includes(w));
}

function parseRetryAfterMs(msgLower) {
  const m = msgLower.match(/try again in\s+(\d+)m(\d+)s/i);
  if (m) return (Number(m[1]) * 60 + Number(m[2])) * 1000;
  const s = msgLower.match(/try again in\s+(\d+)s/i);
  if (s) return Number(s[1]) * 1000;
  return null;
}

/* =========================
   Clean embed reply
========================= */
function splitForEmbed(text, maxLen = 3800) {
  const s = String(text || "").trim();
  if (!s) return ["(no response)"];
  const parts = [];
  for (let i = 0; i < s.length; i += maxLen) parts.push(s.slice(i, i + maxLen));
  return parts;
}

async function replyClean(message, answerText, userId, locationId) {
  const parts = splitForEmbed(answerText, 3800);
  const sent = [];

  const first = new EmbedBuilder().setDescription(parts[0]);
  const m1 = await message.reply({ embeds: [first] });
  sent.push(m1);
  rememberBotReply(m1.id, userId, locationId);

  // at most 2 extra clean embeds
  for (let i = 1; i < parts.length && i < 3; i++) {
    const e = new EmbedBuilder().setDescription(parts[i]);
    const mi = await message.channel.send({ embeds: [e] });
    sent.push(mi);
    rememberBotReply(mi.id, userId, locationId);
  }

  if (parts.length > 3) {
    const e = new EmbedBuilder().setDescription("…(trimmed)");
    const mt = await message.channel.send({ embeds: [e] });
    sent.push(mt);
    rememberBotReply(mt.id, userId, locationId);
  }

  return sent;
}

/* =========================
   Web search (SerpAPI)
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
    c === "!aiclear"
  );
}

/* =========================
   Brainrot (channel-only, no OpenAI)
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
   "why is the toaster crying",
   "my fridge just sent me a text",
   "quantum squirrels stole my homework",
   "i put a shoe on my cat and now it can speak French",
 "pineapples are secretly plotting with my socks",
   "did you know memes have a pet dimension",
 "the walls are auditioning for a Broadway show",
 "cats know the secrets of the WiFi",
 "my coffee is judging me",
 "aliens declined my invitation to dinner"
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
   Panel
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
    .setTitle("Sparxo Homework completer")
    .setDescription("Click below to get your homework done.\n**All of your homework or xp u wanted will be completed.**");

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(IDS.BTN_START).setLabel("Start request").setStyle(ButtonStyle.Primary)
  );

  await channel.send({ embeds: [embed], components: [row] });
}

/* =========================
   Added: per-user thread in AI channel
========================= */
async function getOrCreateUserThread(message) {
  if (!message.guild) return null;
  if (!ENV.AI_CHANNEL_ID) return null;
  if (message.channel.id !== ENV.AI_CHANNEL_ID) return null;

  const parent = message.channel;
  const threadName = `sparxo-${message.author.username}`.slice(0, 90);

  const active = await parent.threads.fetchActive().catch(() => null);
  const existing = active?.threads?.find((t) => t.name === threadName);
  if (existing) return existing;

  const thread = await parent.threads.create({
    name: threadName,
    autoArchiveDuration: 60,
    reason: `Sparxo session for ${message.author.tag}`,
  });

  return thread;
}

function isSparxoThread(channel) {
  return (
    channel?.isThread?.() &&
    typeof channel.name === "string" &&
    channel.name.startsWith("sparxo-")
  );
}

/* =========================
   OpenAI call (clean output + memory)
========================= */
function systemPrompt(isTutor) {
  return (
`You are "Sparxo", a helpful assistant for teens.

Output rules:
- Give ONLY the answer. No meta talk.
- Keep it clean and direct.
- No random jokes or filler.
- If schoolwork: explain method/steps so the user learns.

If maths/science:
- Use numbered steps.
- Keep equations on separate lines.
- Final answer on its own line.`
  + (isTutor ? "\nTutor mode: step-by-step." : "\nNormal mode.")
  );
}

async function runAI({ prompt, imageUrls, forceWeb, memoryTurns }) {
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

  const messages = [
    { role: "system", content: systemPrompt(tutor) },
    ...(memoryTurns || []),
    { role: "user", content: userContent },
  ];

  const resp = await openai.chat.completions.create({
    model: SETTINGS.MODEL,
    max_tokens: SETTINGS.MAX_TOKENS,
    messages,
  });

  return (resp.choices?.[0]?.message?.content ?? "").trim() || "No response.";
}

/* =========================
   Ready
========================= */
client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);
  console.log("messageCreate listeners:", client.listenerCount("messageCreate"));
  console.log("process pid:", process.pid);
  console.log("OPENAI_KEY hash:", safeKeyHash(ENV.OPENAI_KEY));

  if (ENV.PANEL_CHANNEL_ID) await sendPanel(ENV.PANEL_CHANNEL_ID);
  await startBrainrot();
});

/* =========================
   messageCreate
========================= */
client.on("messageCreate", async (message) => {
  try {
    const isDM = message.channel.type === ChannelType.DM;

    // Prevent loops
    if (!message.author) return;
    if (message.author.bot) return;
    if (message.webhookId) return;

    // AI channel cleaning (server only)
    if (!isDM && aiCleanEnabled && ENV.AI_CHANNEL_ID && message.channel.id === ENV.AI_CHANNEL_ID) {
      if (!allowedInAiChannel(message.content)) {
        setTimeout(() => message.delete().catch(() => {}), 1500);
        return;
      }
    }

    /* =========================
       Admin / help commands (work in server)
    ========================= */
    if (!isDM && message.content === "!help") {
      return message.reply(
        "Commands:\n" +
        "`!ai <question>`\n" +
        "`!aiw <question>` (force web)\n" +
        "`!aiclean on/off` (admin)\n" +
        "`!brainrot on/off` (admin)\n" +
        "`!panel` (admin)\n" +
        "`!aistatus` (admin)\n" +
        "`!aiclear` (admin)\n\n" +
        "Tip: reply to Sparxo to continue the convo."
      );
    }

    if (!isDM && message.content === "!aistatus") {
      if (!isAdmin(message.member)) return message.reply("Admins only.");
      const leftMs = Math.max(0, aiBlockedUntil - Date.now());
      const leftSec = Math.ceil(leftMs / 1000);
      return message.reply(
        "AI status:\n" +
        `• blocked: ${leftMs ? `${leftSec}s left` : "NO"}\n` +
        `• global busy: ${globalAiBusy ? "YES" : "NO"}\n` +
        `• listeners: ${client.listenerCount("messageCreate")}\n` +
        `• OPENAI_KEY hash: ${safeKeyHash(ENV.OPENAI_KEY)}`
      );
    }

    if (!isDM && message.content === "!aiclear") {
      if (!isAdmin(message.member)) return message.reply("Admins only.");
      aiBlockedUntil = 0;
      globalAiBusy = false;
      return message.reply("✅ Cleared AI cooldown/busy state.");
    }

    if (!isDM && message.content.startsWith("!aiclean")) {
      if (!isAdmin(message.member)) return message.reply("Admins only.");
      const arg = message.content.split(/\s+/)[1]?.toLowerCase();
      if (arg === "on") { aiCleanEnabled = true; return message.reply("✅ AI cleaning ON"); }
      if (arg === "off") { aiCleanEnabled = false; return message.reply("🛑 AI cleaning OFF"); }
      return message.reply("Use `!aiclean on` or `!aiclean off`");
    }

    if (!isDM && message.content.startsWith("!brainrot")) {
      if (!isAdmin(message.member)) return message.reply("Admins only.");
      const arg = message.content.split(/\s+/)[1]?.toLowerCase();
      if (arg === "on") { brainrotEnabled = true; await startBrainrot(); return message.reply("✅ Brainrot ON"); }
      if (arg === "off") { brainrotEnabled = false; await startBrainrot(); return message.reply("🛑 Brainrot OFF"); }
      return message.reply("Use `!brainrot on` or `!brainrot off`");
    }

    if (!isDM && message.content === "!panel") {
      if (!isAdmin(message.member)) return message.reply("Admins only.");
      if (!ENV.PANEL_CHANNEL_ID) return message.reply("PANEL_CHANNEL_ID not set.");
      await sendPanel(ENV.PANEL_CHANNEL_ID);
      return message.reply("✅ Panel sent.");
    }

    /* =========================
       AI trigger logic (NEW)
       - DMs: any message triggers AI (unless it starts with "!")
       - Threads named sparxo-*: any message triggers AI
       - Reply-to-Sparxo: triggers AI
       - Commands !ai / !aiw work anywhere
    ========================= */
    const isAiw = message.content.startsWith("!aiw ");
    const isAi = message.content.startsWith("!ai ");
    const inThread = isSparxoThread(message.channel);

    const isReplyToBot =
      message.reference?.messageId &&
      botReplyToLocation.has(message.reference.messageId);

    const shouldRunAI =
      isAiw || isAi ||
      (isDM && !message.content.startsWith("!")) ||
      inThread ||
      isReplyToBot;

    if (!shouldRunAI) return;

    // Circuit breaker
    if (Date.now() < aiBlockedUntil) {
      const leftSec = Math.max(1, Math.ceil((aiBlockedUntil - Date.now()) / 1000));
      return message.reply(`Cooling down. Try again in ${leftSec}s.`);
    }

    // Dedupe
    if (handledMessageIds.has(message.id)) return;
    markHandled(message.id);

    // Per-user cooldown
    if (isOnCooldown(message.author.id)) {
      return message.reply("Try again in a few seconds.");
    }

    // Locks
    if (inFlightByMessage.has(message.id)) return;
    inFlightByMessage.add(message.id);

    if (globalAiBusy) {
      inFlightByMessage.delete(message.id);
      return message.reply("Busy. Try again shortly.");
    }
    globalAiBusy = true;

    // Determine prompt
    let prompt = "";
    if (isAiw) prompt = message.content.slice(4).trim();
    else if (isAi) prompt = message.content.slice(3).trim();
    else prompt = message.content.trim();

    if (!prompt) {
      globalAiBusy = false;
      inFlightByMessage.delete(message.id);
      return message.reply("Send a message with your question.");
    }

    // Determine conversation location (memory + “private session”)
    // - DM: location is the DM channel id
    // - Sparxo thread: location is thread id
    // - Reply-to-bot: use stored location
    // - Otherwise: location is the current channel id
    let locationId = message.channel.id;

    if (isReplyToBot) {
      const info = botReplyToLocation.get(message.reference.messageId);
      if (info?.locationId) locationId = info.locationId;
    }

    // If they used !ai/!aiw in the AI channel, move convo into a thread
    let targetMessageForReply = message;
    if (!isDM && (isAi || isAiw) && ENV.AI_CHANNEL_ID && message.channel.id === ENV.AI_CHANNEL_ID) {
      const thread = await getOrCreateUserThread(message).catch(() => null);
      if (thread) {
        locationId = thread.id;
        // send a clean note once and then continue in thread
        await thread.send(`Hi ${message.author}, ask here anytime.`);
        // also reply in original channel with thread link
        await message.reply(`I made your thread: <#${thread.id}>`);
        // from here, answer in thread by faking a "message-like" reply target:
        targetMessageForReply = {
          reply: (payload) => thread.send(payload),
          channel: thread,
        };
      }
    }

    // Images (only if present)
    const imageUrls = [];
    for (const att of message.attachments.values()) {
      const ct = att.contentType || "";
      if (ct.startsWith("image/")) imageUrls.push(att.url);
    }

    await message.channel.sendTyping().catch(() => {});

    // Memory turns for this user+location
    const memTurns = getMemory(message.author.id, locationId);

    let out;
    try {
      // store user turn
      pushMemory(message.author.id, locationId, "user", prompt);

      out = await runAI({
        prompt,
        imageUrls,
        forceWeb: isAiw,
        memoryTurns: memTurns,
      });

      // store assistant turn
      pushMemory(message.author.id, locationId, "assistant", out);

    } catch (err) {
      const status = err?.status ?? err?.response?.status;
      const code = String(err?.code || err?.error?.code || "");
      const msg = String(err?.message || "");
      const msgLower = msg.toLowerCase();
      const headers = err?.headers || err?.response?.headers || {};

      console.error("[OPENAI ERROR]", { status, code, message: msg, retryAfter: headers["retry-after"] });

      if (status === 429 && (code.includes("insufficient_quota") || msgLower.includes("quota"))) {
        return message.reply("OpenAI billing/quota issue.");
      }

      if (status === 429 && (code.includes("rate_limit") || msgLower.includes("rate limit"))) {
        let waitMs = 180 * 1000;
        const ra = Number(headers["retry-after"]);
        if (Number.isFinite(ra) && ra > 0) waitMs = ra * 1000;
        const parsed = parseRetryAfterMs(msgLower);
        if (parsed) waitMs = parsed;

        const newUntil = Date.now() + waitMs;
        aiBlockedUntil = Math.max(aiBlockedUntil, newUntil);

        return message.reply(`Rate limited. Try again in ${Math.ceil(waitMs / 1000)}s.`);
      }

      if (status === 401 || msgLower.includes("invalid api key")) {
        return message.reply("Invalid OpenAI key.");
      }

      return message.reply("AI error. Try again soon.");
    } finally {
      globalAiBusy = false;
      inFlightByMessage.delete(message.id);
    }

    // Clean embed reply
    const sent = await replyClean(
      // if thread routing happened, use that target “message”
      targetMessageForReply,
      out,
      message.author.id,
      locationId
    );

    // Optional auto-delete (keeps your original behavior; DMs usually should not auto-delete)
    if (!isDM) {
      setTimeout(async () => {
        for (const m of sent) await m.delete().catch(() => {});
        await message.delete().catch(() => {});
      }, SETTINGS.DELETE_AFTER_MS);
    }

  } catch (e) {
    console.error("messageCreate error:", e);
    try { await message.reply("Error. Check logs."); } catch {}
  }
});

/* =========================
   Interactions (Panel)
========================= */
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isButton() && interaction.customId === IDS.BTN_START) {
      const modal = new ModalBuilder().setCustomId(IDS.MODAL).setTitle("Help Request");

      const details = new TextInputBuilder()
        .setCustomId(IDS.FIELD_DETAILS)
        // label must be <= 45 chars
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
      if (!admin) {
        return interaction.update({ content: "Admin channel not found.", components: [] });
      }

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
   Brainrot start + panel on ready
========================= */
client.once("ready", async () => {
  if (ENV.PANEL_CHANNEL_ID) await sendPanel(ENV.PANEL_CHANNEL_ID);
  await startBrainrot();
});

/* =========================
   Login
========================= */
client.login(ENV.DISCORD_TOKEN);









