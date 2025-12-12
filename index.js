const express = require("express");
const { google } = require("googleapis");
const crypto = require("crypto");

const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} = require("discord.js");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

/* =========================
   ENV
========================= */
const BOARD_CHANNEL_ID = process.env.BOARD_CHANNEL_ID || "1449107600024141865";
const UPDATES_CHANNEL_ID = process.env.UPDATES_CHANNEL_ID || "1449054314327834717";
const BOARD_MESSAGE_ID = process.env.BOARD_MESSAGE_ID || ""; // נשים אחרי setup

const CALENDAR_ID = process.env.GCAL_CALENDAR_ID;

const TZ = "Asia/Jerusalem";

/* =========================
   Discord Bot
========================= */
const discordClient = new Client({
  intents: [GatewayIntentBits.Guilds]
});

discordClient.once("ready", async () => {
  console.log(`Discord bot logged in as ${discordClient.user.tag}`);
  await warmupKnownEvents();
  await updateMonthlyBoard({ createIfMissing: true });
});

discordClient.login(process.env.DISCORD_TOKEN);

/* =========================
   Google OAuth
========================= */
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

if (process.env.GOOGLE_REFRESH_TOKEN) {
  oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  console.log("Loaded GOOGLE_REFRESH_TOKEN from env ✅");
} else {
  console.log("GOOGLE_REFRESH_TOKEN is missing ⚠️");
}

function getCalendarClient() {
  return google.calendar({ version: "v3", auth: oauth2Client });
}

/* =========================
   Helpers - formatting
========================= */
function fmtDate(d) {
  return new Intl.DateTimeFormat("he-IL", {
    timeZone: TZ,
    day: "2-digit",
    month: "2-digit",
    year: "numeric"
  }).format(d);
}

function fmtTime(d) {
  return new Intl.DateTimeFormat("he-IL", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit"
  }).format(d);
}

function toDateFromEventStart(ev) {
  // all-day
  if (ev?.start?.date) {
    // ev.start.date is YYYY-MM-DD (no time)
    return new Date(ev.start.date + "T00:00:00");
  }
  // timed
  if (ev?.start?.dateTime) return new Date(ev.start.dateTime);
  return null;
}

function eventWhenText(ev) {
  if (ev?.start?.date) {
    const d = new Date(ev.start.date + "T00:00:00");
    return `כל היום - ${fmtDate(d)}`;
  }
  if (ev?.start?.dateTime) {
    const d = new Date(ev.start.dateTime);
    return `${fmtDate(d)} - ${fmtTime(d)}`;
  }
  return "זמן לא ידוע";
}

function safeTitle(ev) {
  return (ev.summary || "(ללא כותרת)").trim();
}

function lineForEvent(ev) {
  const title = safeTitle(ev);
  const when = eventWhenText(ev);
  const link = ev.htmlLink || "";
  return `- **${title}**\n  - ${when}${link ? `\n  - ${link}` : ""}`;
}

function sameDay(a, b) {
  const da = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(a); // YYYY-MM-DD
  const db = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(b);
  return da === db;
}

function dayKey(d) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(d); // YYYY-MM-DD
}

/* =========================
   Events fetching
========================= */
async function fetchEventsRange({ timeMin, timeMax, showDeleted = false, orderBy = "startTime" }) {
  const calendar = getCalendarClient();
  const resp = await calendar.events.list({
    calendarId: CALENDAR_ID,
    timeMin,
    timeMax,
    singleEvents: true,
    orderBy,
    showDeleted,
    maxResults: 250
  });
  return resp.data.items || [];
}

/* =========================
   Monthly board rendering
========================= */
function buildMonthlyEmbed(events) {
  const now = new Date();
  const monthName = new Intl.DateTimeFormat("he-IL", { timeZone: TZ, month: "long", year: "numeric" }).format(now);

  // group by day
  const byDay = new Map();
  for (const ev of events) {
    const d = toDateFromEventStart(ev);
    if (!d) continue;
    const key = dayKey(d);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(ev);
  }

  // build a compact list (next 30-35 days)
  const keys = Array.from(byDay.keys()).sort();
  let desc = "";
  for (const k of keys) {
    const dayEvents = byDay.get(k) || [];
    // convert to nice heb date
    const d = new Date(k + "T00:00:00");
    const header = `📆 **${fmtDate(d)}**`;
    const lines = dayEvents
      .slice(0, 6)
      .map(ev => {
        const title = safeTitle(ev);
        const when = ev.start?.date ? "כל היום" : fmtTime(new Date(ev.start.dateTime));
        const link = ev.htmlLink ? ev.htmlLink : "";
        return `- ${when} - ${link ? `[${title}](${link})` : `**${title}**`}`;
      })
      .join("\n");

    desc += `${header}\n${lines}\n\n`;
    if (desc.length > 3500) break; // safety for embed
  }

  if (!desc.trim()) {
    desc = "אין אירועים החודש הקרוב (או שאין אירועים בטווח שהגדרנו).";
  }

  const embed = new EmbedBuilder()
    .setTitle(`🗓️ לוח חודשי - החודש הקרוב`)
    .setDescription(desc.trim())
    .setFooter({ text: `מתעדכן אוטומטית מהיומן - ${monthName}` });

  return embed;
}

function buildTodayEmbed(events) {
  const today = new Date();
  const todayEvents = events.filter(ev => {
    const d = toDateFromEventStart(ev);
    return d && sameDay(d, today) && ev.status !== "cancelled";
  });

  const embed = new EmbedBuilder()
    .setTitle("📌 היום ביומן")
    .setFooter({ text: "נשלח מהבוט - תצוגה יומית" });

  if (todayEvents.length === 0) {
    embed.setDescription("אין אירועים להיום ✅");
    return embed;
  }

  const lines = todayEvents
    .slice(0, 15)
    .map(ev => {
      const title = safeTitle(ev);
      const when = ev.start?.date ? "כל היום" : fmtTime(new Date(ev.start.dateTime));
      const link = ev.htmlLink ? ev.htmlLink : "";
      return `- ${when} - ${link ? `[${title}](${link})` : `**${title}**`}`;
    })
    .join("\n");

  embed.setDescription(lines);
  return embed;
}

function buildBoardButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("board_today")
      .setLabel("היום")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("board_refresh")
      .setLabel("רענן")
      .setStyle(ButtonStyle.Secondary)
  );
}

/* =========================
   Board message create/edit
========================= */
let cachedBoardMessageId = BOARD_MESSAGE_ID;
let boardUpdatePending = false;

async function updateMonthlyBoard({ createIfMissing = false } = {}) {
  try {
    const now = new Date();
    const timeMin = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const timeMax = new Date(now.getTime() + 35 * 24 * 60 * 60 * 1000).toISOString();

    const events = await fetchEventsRange({ timeMin, timeMax, showDeleted: false, orderBy: "startTime" });
    const embed = buildMonthlyEmbed(events);
    const row = buildBoardButtons();

    const channel = await discordClient.channels.fetch(BOARD_CHANNEL_ID);

    if (!cachedBoardMessageId) {
      if (!createIfMissing) return;

      const msg = await channel.send({ embeds: [embed], components: [row] });
      cachedBoardMessageId = msg.id;

      console.log("✅ Monthly board message created. Set this in Render ENV as BOARD_MESSAGE_ID:");
      console.log(cachedBoardMessageId);
      return;
    }

    const msg = await channel.messages.fetch(cachedBoardMessageId).catch(() => null);

    if (!msg) {
      if (!createIfMissing) return;
      const newMsg = await channel.send({ embeds: [embed], components: [row] });
      cachedBoardMessageId = newMsg.id;

      console.log("✅ Monthly board message re-created. Set this in Render ENV as BOARD_MESSAGE_ID:");
      console.log(cachedBoardMessageId);
      return;
    }

    await msg.edit({ embeds: [embed], components: [row] });
  } catch (err) {
    console.error("updateMonthlyBoard error:", err);
  }
}

function scheduleBoardUpdate() {
  if (boardUpdatePending) return;
  boardUpdatePending = true;
  setTimeout(async () => {
    boardUpdatePending = false;
    await updateMonthlyBoard({ createIfMissing: true });
  }, 2500);
}

/* =========================
   Change feed (new/updated/cancelled)
========================= */
const knownEvents = new Map(); // id -> updated

async function warmupKnownEvents() {
  try {
    const now = new Date();
    const timeMin = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const timeMax = new Date(now.getTime() + 35 * 24 * 60 * 60 * 1000).toISOString();
    const events = await fetchEventsRange({ timeMin, timeMax, showDeleted: true, orderBy: "updated" });

    for (const ev of events) {
      if (!ev?.id) continue;
      knownEvents.set(ev.id, ev.updated || "");
    }
    console.log(`Known events warmup: ${knownEvents.size}`);
  } catch (err) {
    console.error("warmupKnownEvents error:", err);
  }
}

function emojiForChange(type) {
  if (type === "created") return "🆕";
  if (type === "updated") return "✏️";
  if (type === "cancelled") return "❌";
  return "📌";
}

function labelForChange(type) {
  if (type === "created") return "אירוע חדש";
  if (type === "updated") return "אירוע עודכן";
  if (type === "cancelled") return "אירוע בוטל";
  return "עדכון";
}

function buildChangesEmbed(changes) {
  const lines = changes.slice(0, 15).map(({ type, ev }) => {
    const title = safeTitle(ev);
    const when = eventWhenText(ev);
    const link = ev.htmlLink ? ev.htmlLink : "";
    const e = emojiForChange(type);
    const t = labelForChange(type);
    return `${e} **${t}** - ${link ? `[${title}](${link})` : title}\n- ${when}`;
  });

  const embed = new EmbedBuilder()
    .setTitle("📣 עדכונים ביומן")
    .setDescription(lines.join("\n\n"))
    .setFooter({ text: "הודעה אוטומטית מהבוט" });

  if (changes.length > 15) {
    embed.addFields({
      name: "עוד עדכונים",
      value: `יש עוד ${changes.length - 15} עדכונים - אם תרצה אוסיף סיכום מורחב.`
    });
  }

  return embed;
}

/* =========================
   Google Watch
========================= */
let watchState = {
  channelId: null,
  resourceId: null,
  expiration: null,
  lastUpdatedMin: null
};

app.get("/watch/start", async (req, res) => {
  try {
    const calendar = getCalendarClient();
    const channelId = crypto.randomUUID();
    const webhookUrl = "https://calendar-discord-backend.onrender.com/webhook/google";

    watchState.lastUpdatedMin = new Date(Date.now() - 5 * 60 * 1000).toISOString();

    const response = await calendar.events.watch({
      calendarId: CALENDAR_ID,
      requestBody: {
        id: channelId,
        type: "web_hook",
        address: webhookUrl
      }
    });

    watchState.channelId = channelId;
    watchState.resourceId = response.data.resourceId;
    watchState.expiration = response.data.expiration;

    res.json({
      ok: true,
      message: "Watch started ✅",
      channelId: watchState.channelId,
      resourceId: watchState.resourceId,
      expiration: watchState.expiration,
      webhook: webhookUrl
    });
  } catch (err) {
    console.error("Watch start error:", err);
    res.status(500).send("Failed to start watch");
  }
});

app.get("/watch/stop", async (req, res) => {
  try {
    const calendar = getCalendarClient();

    if (!watchState.channelId || !watchState.resourceId) {
      return res.json({ ok: true, message: "No active watch to stop" });
    }

    await calendar.channels.stop({
      requestBody: {
        id: watchState.channelId,
        resourceId: watchState.resourceId
      }
    });

    watchState = { channelId: null, resourceId: null, expiration: null, lastUpdatedMin: null };
    res.json({ ok: true, message: "Watch stopped ✅" });
  } catch (err) {
    console.error("Watch stop error:", err);
    res.status(500).send("Failed to stop watch");
  }
});

app.post("/webhook/google", async (req, res) => {
  res.status(200).send("OK");

  try {
    const resourceState = req.get("x-goog-resource-state");
    const channelId = req.get("x-goog-channel-id");

    if (!watchState.channelId || channelId !== watchState.channelId) return;

    // "sync" מגיע לפעמים - עדיין נעדכן לוח אבל לא נספים
    const calendar = getCalendarClient();

    const updatedMin = watchState.lastUpdatedMin || new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const response = await calendar.events.list({
      calendarId: CALENDAR_ID,
      updatedMin,
      maxResults: 50,
      singleEvents: true,
      orderBy: "updated",
      showDeleted: true
    });

    watchState.lastUpdatedMin = new Date(Date.now() - 5 * 1000).toISOString();

    const items = response.data.items || [];
    if (items.length === 0) {
      // עדיין נעדכן לוח כדי להיות בטוחים
      scheduleBoardUpdate();
      return;
    }

    const changes = [];

    for (const ev of items) {
      if (!ev?.id) continue;

      const prevUpdated = knownEvents.get(ev.id);
      const isCancelled = ev.status === "cancelled";

      if (isCancelled) {
        // בוטל
        changes.push({ type: "cancelled", ev });
        knownEvents.delete(ev.id);
        continue;
      }

      if (!prevUpdated) {
        changes.push({ type: "created", ev });
      } else if ((ev.updated || "") !== prevUpdated) {
        changes.push({ type: "updated", ev });
      }

      knownEvents.set(ev.id, ev.updated || "");
    }

    // עדכון לוח חודשי (edit להודעה אחת)
    scheduleBoardUpdate();

    // שליחת עדכונים לחדר העדכונים
    if (changes.length > 0 && resourceState !== "sync") {
      const channel = await discordClient.channels.fetch(UPDATES_CHANNEL_ID);
      const embed = buildChangesEmbed(changes);
      await channel.send({ embeds: [embed] });
    }
  } catch (err) {
    console.error("Webhook handling error:", err);
  }
});

/* =========================
   Buttons (Today / Refresh)
========================= */
discordClient.on("interactionCreate", async (interaction) => {
  try {
    if (!interaction.isButton()) return;

    if (interaction.customId === "board_today") {
      const now = new Date();
      const timeMin = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
      const timeMax = new Date(now.getTime() + 35 * 24 * 60 * 60 * 1000).toISOString();
      const events = await fetchEventsRange({ timeMin, timeMax, showDeleted: false, orderBy: "startTime" });

      const embed = buildTodayEmbed(events);
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (interaction.customId === "board_refresh") {
      await interaction.deferUpdate();
      await updateMonthlyBoard({ createIfMissing: true });
      return;
    }
  } catch (err) {
    console.error("interactionCreate error:", err);
  }
});

/* =========================
   Setup endpoint (creates board + returns msg id)
========================= */
app.get("/board/setup", async (req, res) => {
  await updateMonthlyBoard({ createIfMissing: true });
  res.json({
    ok: true,
    boardChannelId: BOARD_CHANNEL_ID,
    boardMessageId: cachedBoardMessageId || null,
    note: "If boardMessageId is not saved in ENV, set BOARD_MESSAGE_ID to this value for persistence."
  });
});

/* =========================
   Tests / Health
========================= */
app.get("/test-calendar", async (req, res) => {
  try {
    const now = new Date();
    const timeMin = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const timeMax = new Date(now.getTime() + 35 * 24 * 60 * 60 * 1000).toISOString();
    const events = await fetchEventsRange({ timeMin, timeMax, showDeleted: false, orderBy: "startTime" });
    res.json(events);
  } catch (err) {
    console.error(err);
    res.status(500).send("Failed to fetch events");
  }
});

app.get("/", (req, res) => {
  res.send("Backend is running ✅");
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
