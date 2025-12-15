
require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
  PermissionsBitField,
  Events,
} = require("discord.js");

const OpenAI = require("openai");
const axios = require("axios");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const openai = new OpenAI({ apiKey: process.env.OPENAI_KEY });

/* =========================
   UTIL
========================= */
function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function isEducation(text) {
  const t = text.toLowerCase();
  return [
    "math","solve","equation","algebra","geometry","calculus",
    "science","physics","chemistry","biology",
    "homework","exam","test","question"
  ].some(w => t.includes(w));
}

function needsWeb(text) {
  const t = text.toLowerCase();
  return ["latest","today","current","news","update","2025"].some(w => t.includes(w));
}

/* =========================
   BRAINROT
========================= */
let brainrotEnabled = true;
let brainrotTimer = null;

const BRAINROT_LINES = [
  "67 67 67",
  "admin abuse is on today",
  "admin abuse is not on today",
  "math was NOT mathing",
  "skill issue (respectfully)",
  "certified nerd moment",
  "we move",
];

async function startBrainrot() {
  if (brainrotTimer) clearInterval(brainrotTimer);
  brainrotTimer = null;
  if (!brainrotEnabled) return;

  const channel = await client.channels.fetch(process.env.BRAINROT_CHANNEL_ID).catch(() => null);
  if (!channel) return;

  const mins = Number(process.env.BRAINROT_INTERVAL_MINUTES || 20);
  brainrotTimer = setInterval(() => {
    channel.send(pick(BRAINROT_LINES)).catch(() => {});
  }, mins * 60000);

  console.log("Brainrot running");
}

/* =========================
   PANEL
========================= */
const IDS = {
  BTN: "start_request",
  MODAL: "request_modal",
  DETAILS: "details",
  PLATFORM: "platform",
  TYPE: "type",
};

const sessions = new Map();

async function postPanel() {
  const channel = await client.channels.fetch(process.env.PANEL_CHANNEL_ID).catch(() => null);
  if (!channel) return;

  const embed = new EmbedBuilder()
    .setTitle("Request Bot")
    .setDescription("Click below to submit a request.");

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(IDS.BTN)
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
  await postPanel();
  await startBrainrot();
});

/* =========================
   MESSAGE COMMANDS
========================= */
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  /* ---- brainrot toggle ---- */
  if (message.content.startsWith("!brainrot")) {
    if (!message.member.permissions.has(PermissionsBitField.Flags.ManageGuild))
      return message.reply("Admins only.");

    if (message.content.endsWith("on")) {
      brainrotEnabled = true;
      await startBrainrot();
      return message.reply("Brainrot ON");
    }
    if (message.content.endsWith("off")) {
      brainrotEnabled = false;
      await startBrainrot();
      return message.reply("Brainrot OFF");
    }
    return;
  }

  /* ---- AI ---- */
  const forceWeb = message.content.startsWith("!aiw ");
  const normalAi = message.content.startsWith("!ai ");
  if (!forceWeb && !normalAi) return;

  const prompt = message.content.slice(forceWeb ? 4 : 3).trim();
  if (!prompt) return;

  const tutor = isEducation(prompt);
  const systemPrompt = tutor
    ? "You are a chill math tutor. Explain step by step."
    : "You are a chill friendly assistant.";

  const web = forceWeb || needsWeb(prompt);
  const sources = web && process.env.SERPAPI_KEY
    ? (await axios.get("https://serpapi.com/search.json", {
        params: { q: prompt, api_key: process.env.SERPAPI_KEY },
      })).data.organic_results?.slice(0,3).map(r => r.link) || []
    : [];

  const images = [...message.attachments.values()]
    .filter(a => a.contentType?.startsWith("image/"))
    .map(a => ({ type: "image_url", image_url: { url: a.url } }));

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: [{ type: "text", text: prompt }, ...images] },
    ],
  });

  let reply = response.choices[0].message.content;
  if (sources.length) reply += "\n\nSources:\n" + sources.join("\n");

  const botMsg = await message.reply(reply);

  setTimeout(() => {
    message.delete().catch(() => {});
    botMsg.delete().catch(() => {});
  }, 120000);
});

/* =========================
   PANEL INTERACTIONS
========================= */
client.on(Events.InteractionCreate, async (i) => {
  if (i.isButton() && i.customId === IDS.BTN) {
    const modal = new ModalBuilder()
      .setCustomId(IDS.MODAL)
      .setTitle("Request");

    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId(IDS.DETAILS)
          .setLabel("What do you need?")
          .setStyle(TextInputStyle.Paragraph)
      )
    );
    return i.showModal(modal);
  }

  if (i.isModalSubmit()) {
    sessions.set(i.user.id, { details: i.fields.getTextInputValue(IDS.DETAILS) });

    const menu = new StringSelectMenuBuilder()
      .setCustomId(IDS.PLATFORM)
      .setOptions(
        { label: "Maths", value: "Maths" },
        { label: "Science", value: "Science" },
        { label: "Reading", value: "Reading" }
      );

    return i.reply({ components: [new ActionRowBuilder().addComponents(menu)], ephemeral: true });
  }

  if (i.isStringSelectMenu() && i.customId === IDS.PLATFORM) {
    sessions.get(i.user.id).platform = i.values[0];

    const menu = new StringSelectMenuBuilder()
      .setCustomId(IDS.TYPE)
      .setOptions(
        { label: "Homework", value: "Homework" },
        { label: "XP Boost", value: "XP" }
      );

    return i.update({ components: [new ActionRowBuilder().addComponents(menu)] });
  }

  if (i.isStringSelectMenu() && i.customId === IDS.TYPE) {
    const data = sessions.get(i.user.id);
    data.type = i.values[0];

    const admin = await client.channels.fetch(process.env.ADMIN_CHANNEL_ID);
    await admin.send({
      embeds: [new EmbedBuilder()
        .setTitle("New Request")
        .addFields(
          { name: "User", value: i.user.tag },
          { name: "Platform", value: data.platform },
          { name: "Type", value: data.type },
          { name: "Details", value: data.details }
        )
      ]
    });

    sessions.delete(i.user.id);
    return i.update({ content: "Sent to admins!", components: [] });
  }
});

client.login(process.env.DISCORD_TOKEN);

