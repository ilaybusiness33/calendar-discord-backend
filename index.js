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
app.use(express.json());
const PORT = process.env.PORT || 3000;

/* =========================
   ENV
========================= */
const TZ = "Asia/Jerusalem";
const CALENDAR_ID = process.env.GCAL_CALENDAR_ID;

const BOARD_CHANNEL_ID = process.env.BOARD_CHANNEL_ID || "1449107600024141865";
const UPDATES_CHANNEL_ID = process.env.UPDATES_CHANNEL_ID || "1449054314327834717";

let BOARD_MESSAGE_ID = process.env.BOARD_MESSAGE_ID || "";

const AUTO_WATCH = process.env.AUTO_WATCH === "1";

const EMBED_COLOR = 65528;
const THUMB_URL =
  "https://cdn.discordapp.com/attachments/1311690456974884874/1430985279388516385/8d7591e81b8c0282.png";

const BOARD_REFRESH_MS = 60 * 1000; // כל דקה (כששירות ער)

/* =========================
   Discord
========================= */
const discordClient = new Client({
  intents: [GatewayIntentBits.Guilds]
});

let readyOnce = false;
async function onDiscordReady() {
  if (readyOnce) return;
  readyOnce = true;

  console.log(`Discord bot logged in as ${discordClient.user.tag}`);

  await warmupKnownEvents();
  await ensureMonthlyBoardMessage();
  await updateMonthlyBoardEmbed({ reason: "startup" });

  // רענון אוטומטי כל דקה (כש-Render לא ישן)
  setInterval(async () => {
    try {
      await updateMonthlyBoardEmbed({ reason: "interval" });
    } catch (e) {
      console.error("Auto board refresh failed:", e);
    }
  }, BOARD_REFRESH_MS);

  // Watch אוטומטי אחרי Restart/Deploy
  if (AUTO_WATCH) {
    await startWatchSilently();
  } else {
    console.log("AUTO_WATCH is off. Run /watch/start manually if needed.");
  }
}

// תאימות v14/v15
discordClient.once("ready", onDiscordReady);
discordClient.once("clientReady", onDiscordReady);

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

function cal() {
  return google.calendar({ version: "v3", auth: oauth2Client });
}

/* =========================
   Date helpers
========================= */
function dayNameHe(d) {
  return new Intl.DateTimeFormat("he-IL", { timeZone: TZ, weekday: "long" }).format(d);
}

function dateShort(d) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    day: "2-digit",
    month: "2-digit",
    year: "2-digit"
  }).formatToParts(d);

  const dd = parts.find(p => p.type === "day")?.value || "00";
  const mm = parts.find(p => p.type === "month")?.value || "00";
  const yy = parts.find(p => p.type === "year")?.value || "00";

  return `${dd}.${mm}.${yy}`;
}

function timeHM(d) {
  return new Intl.DateTimeFormat("he-IL", { timeZone: TZ, hour: "2-digit", minute: "2-digit" }).format(d);
}

function localDayKey(d) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(d); // YYYY-MM-DD
}

function eventStartDate(ev) {
  if (ev?.start?.date) return new Date(ev.start.date + "T00:00:00");
  if (ev?.start?.dateTime) return new Date(ev.start.dateTime);
  return null;
}

function isAllDay(ev) {
  return !!ev?.start?.date;
}

function timeRangeLabel(ev) {
  if (isAllDay(ev)) return "כל היום";

  const s = ev?.start?.dateTime ? new Date(ev.start.dateTime) : null;
  const e = ev?.end?.dateTime ? new Date(ev.end.dateTime) : null;

  if (!s) return "זמן לא ידוע";
  if (!e) return timeHM(s);

  return `${timeHM(s)} - ${timeHM(e)}`;
}

function eventLink(ev) {
  return ev?.htmlLink || "";
}

function safeTitle(ev) {
  return (ev?.summary || "(ללא כותרת)").trim();
}

/* =========================
   Fetch events (next month)
========================= */
async function fetchNextMonthEvents({ showDeleted = false } = {}) {
  const now = new Date();
  const timeMin = new Date(now.getTime() - 12 * 60 * 60 * 1000).toISOString();
  const timeMax = new Date(now.getTime() + 32 * 24 * 60 * 60 * 1000).toISOString();

  const resp = await cal().events.list({
    calendarId: CALENDAR_ID,
    timeMin,
    timeMax,
    singleEvents: true,
    orderBy: "startTime",
    showDeleted,
    maxResults: 250
  });

  return resp.data.items || [];
}

/* =========================
   Monthly Board Embed (your style)
========================= */
function buildMonthlyBoardEmbed(events) {
  const active = events.filter(e => e.status !== "cancelled");

  const byDay = new Map();
  for (const ev of active) {
    const d = eventStartDate(ev);
    if (!d) continue;
    const key = localDayKey(d);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(ev);
  }

  const days = Array.from(byDay.keys()).sort();

  const embed = new EmbedBuilder()
    .setTitle("📅🎬 חבילת העריכה הכוללת - לוח חודשי")
    .setDescription(
      "הלוח החודשי מציג את **כל האירועים והפעילויות הקרובות של החבילה**.\n*הלוח מתעדכן אוטומטית לפי אירועים שנקבעים ביומן גוגל.*"
    )
    .setColor(EMBED_COLOR)
    .setThumbnail(THUMB_URL)
    .setFooter({ text: "חבילת העריכה הכוללת - יומן רשמי" });

  const fields = [];
  const SEP = "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━";

  // 25 fields מקסימום - 2 fields ליום -> 12 ימים = 24 fields
  const MAX_DAYS = 12;
  let usedDays = 0;

  for (const key of days) {
    if (usedDays >= MAX_DAYS) break;

    const d = new Date(key + "T00:00:00");
    const weekday = dayNameHe(d);
    const date = dateShort(d);

    const dayEvents = (byDay.get(key) || []).slice().sort((a, b) => {
      const aAll = isAllDay(a);
      const bAll = isAllDay(b);
      if (aAll && !bAll) return -1;
      if (!aAll && bAll) return 1;

      const aS = a?.start?.dateTime ? new Date(a.start.dateTime).getTime() : 0;
      const bS = b?.start?.dateTime ? new Date(b.start.dateTime).getTime() : 0;
      return aS - bS;
    });

    fields.push({
      name: SEP,
      value: `📆 **${weekday} - ${date}**`
    });

    const lines = dayEvents.map(ev => {
      const t = timeRangeLabel(ev);
      const title = safeTitle(ev);
      return `🔹 **${t}** - \`${title}\``;
    });

    fields.push({
      name: "\u200b",
      value: lines.join("\n") || "—"
    });

    usedDays++;
  }

  if (days.length > usedDays) {
    const left = days.length - usedDays;
    fields.push({
      name: SEP,
      value:
        `📌 יש עוד **${left}** ימים עם אירועים בחודש הקרוב.\n` +
        `לצפייה מלאה: https://calendar.google.com/calendar/u/0/r?cid=${encodeURIComponent(CALENDAR_ID)}`
    });
  }

  embed.addFields(fields.slice(0, 25));
  return embed;
}

function buildBoardButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("board_today").setLabel("היום").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("board_refresh").setLabel("רענן").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setStyle(ButtonStyle.Link)
      .setLabel("פתח ביומן")
      .setURL(`https://calendar.google.com/calendar/u/0/r?cid=${encodeURIComponent(CALENDAR_ID)}`)
  );
}

/* =========================
   Board message (edit, not resend)
========================= */
async function ensureMonthlyBoardMessage() {
  const channel = await discordClient.channels.fetch(BOARD_CHANNEL_ID);

  // אם יש MESSAGE_ID מה-ENV, נוודא שהוא קיים
  if (BOARD_MESSAGE_ID) {
    const existing = await channel.messages.fetch(BOARD_MESSAGE_ID).catch(() => null);
    if (existing) return;
    BOARD_MESSAGE_ID = "";
  }

  // אם אין — ניצור פעם אחת, ונגיד לך את ה-ID כדי לשים ב-ENV
  const events = await fetchNextMonthEvents({ showDeleted: false });
  const embed = buildMonthlyBoardEmbed(events);
  const row = buildBoardButtons();

  const msg = await channel.send({ embeds: [embed], components: [row] });
  BOARD_MESSAGE_ID = msg.id;

  console.log("✅ Board message created. Set BOARD_MESSAGE_ID in Render ENV to persist:");
  console.log(BOARD_MESSAGE_ID);
}

let boardEditLock = false;
async function updateMonthlyBoardEmbed({ reason = "unknown" } = {}) {
  if (boardEditLock) return;
  boardEditLock = true;

  try {
    const channel = await discordClient.channels.fetch(BOARD_CHANNEL_ID);
    const msg = await channel.messages.fetch(BOARD_MESSAGE_ID).catch(() => null);

    // אם ההודעה נמחקה/לא קיימת, ניצור חדשה (רק פעם)
    if (!msg) {
      BOARD_MESSAGE_ID = "";
      await ensureMonthlyBoardMessage();
      return;
    }

    const events = await fetchNextMonthEvents({ showDeleted: false });
    const embed = buildMonthlyBoardEmbed(events);
    const row = buildBoardButtons();

    await msg.edit({ embeds: [embed], components: [row] });
  } catch (err) {
    console.error("updateMonthlyBoardEmbed error:", err);
  } finally {
    boardEditLock = false;
  }
}

/* =========================
   Buttons actions
========================= */
discordClient.on("interactionCreate", async (interaction) => {
  try {
    if (!interaction.isButton()) return;

    if (interaction.customId === "board_refresh") {
      await interaction.deferUpdate();
      await updateMonthlyBoardEmbed({ reason: "button_refresh" });
      return;
    }

    if (interaction.customId === "board_today") {
      const events = await fetchNextMonthEvents({ showDeleted: false });

      const todayKey = localDayKey(new Date());
      const todayEvents = events
        .filter(e => e.status !== "cancelled")
        .filter(e => {
          const d = eventStartDate(e);
          return d && localDayKey(d) === todayKey;
        })
        .sort((a, b) => {
          const aAll = isAllDay(a);
          const bAll = isAllDay(b);
          if (aAll && !bAll) return -1;
          if (!aAll && bAll) return 1;

          const aS = a?.start?.dateTime ? new Date(a.start.dateTime).getTime() : 0;
          const bS = b?.start?.dateTime ? new Date(b.start.dateTime).getTime() : 0;
          return aS - bS;
        });

      const embed = new EmbedBuilder()
        .setTitle("📌 היום ביומן")
        .setColor(EMBED_COLOR)
        .setThumbnail(THUMB_URL)
        .setFooter({ text: "חבילת העריכה הכוללת - יומן רשמי" });

      if (todayEvents.length === 0) {
        embed.setDescription("אין אירועים להיום ✅");
      } else {
        const lines = todayEvents.map(ev => {
          const t = timeRangeLabel(ev);
          const title = safeTitle(ev);
          return `🔹 **${t}** - \`${title}\``;
        });
        embed.setDescription(lines.join("\n"));
      }

      return interaction.reply({ embeds: [embed], ephemeral: true });
    }
  } catch (err) {
    console.error("interactionCreate error:", err);
  }
});

/* =========================
   Change tracking (updates channel)
========================= */
const knownMeta = new Map(); // id -> snapshot

function snapshotMeta(ev) {
  const title = safeTitle(ev);
  const allDay = isAllDay(ev);
  const startRaw = ev?.start?.date || ev?.start?.dateTime || "";
  const endRaw = ev?.end?.date || ev?.end?.dateTime || "";

  const startD = eventStartDate(ev);
  const dateText = startD ? `${dayNameHe(startD)} - ${dateShort(startD)}` : "תאריך לא ידוע";
  const timeText = timeRangeLabel(ev);

  return { title, allDay, startRaw, endRaw, dateText, timeText };
}

/* =========================
   UPDATE EMBEDS - YOUR TEMPLATES + BACKTICKS
========================= */
function buildUpdateEmbed({ type, ev, oldMeta }) {
  const link = eventLink(ev);
  const newMeta = snapshotMeta(ev);
  const today = dateShort(new Date());
  const SEP_NAME = "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━";

  // אם אין oldMeta (נדיר), נשתמש ב-newMeta כדי לא לשבור אמבד
  const oldSafe = oldMeta || newMeta;

  if (type === "cancelled") {
    const embed = new EmbedBuilder()
      .setTitle("ביטול אירוע | חבילת העריכה הכוללת")
      .setDescription("אירוע שתוכנן מראש **בוטל**.\nלהלן פרטי האירוע כפי שהיו לפני הביטול:")
      .setColor(15158332)
      .addFields(
        { name: "🛠 פעולה", value: "`בוטל`", inline: true },
        { name: "📅 תאריך הביטול", value: `\`${today}\``, inline: true },
        { name: SEP_NAME, value: "📌 **פרטי האירוע (לפני הביטול)**" },
        { name: "📝 כותרת האירוע", value: `**\`${oldSafe.title}\`**` },
        { name: "📆 תאריך", value: `\`${oldSafe.dateText}\``, inline: true },
        { name: "⏰ שעה", value: `\`${oldSafe.timeText}\``, inline: true }
      )
      .setFooter({ text: "חבילת העריכה הכוללת - מערכת אירועים" });

    const components = [];
    if (link) {
      components.push(
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel("פתח ביומן").setURL(link)
        )
      );
    }
    return { embed, components };
  }

  if (type === "created") {
    const embed = new EmbedBuilder()
      .setTitle("אירוע חדש | חבילת העריכה הכוללת")
      .setDescription("אירוע חדש **נוסף ליומן**.\nלהלן פרטי האירוע:")
      .setColor(5763719)
      .addFields(
        { name: "🛠 פעולה", value: "`אירוע חדש`", inline: true },
        { name: "📅 תאריך פרסום", value: `\`${today}\``, inline: true },
        { name: SEP_NAME, value: "📌 **פרטי האירוע**" },
        { name: "📝 כותרת האירוע", value: `**\`${newMeta.title}\`**` },
        { name: "📆 תאריך", value: `\`${newMeta.dateText}\``, inline: true },
        { name: "⏰ שעה", value: `\`${newMeta.timeText}\``, inline: true }
      )
      .setFooter({ text: "חבילת העריכה הכוללת - מערכת אירועים" });

    const components = [];
    if (link) {
      components.push(
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel("פתח ביומן").setURL(link)
        )
      );
    }
    return { embed, components };
  }

  // updated
  const embed = new EmbedBuilder()
    .setTitle("עדכון אירוע | חבילת העריכה הכוללת")
    .setDescription("אירוע קיים **עודכן**.\nלהלן פרטי האירוע לפני ואחרי העדכון:")
    .setColor(16705372)
    .addFields(
      { name: "🛠 פעולה", value: "`עודכן`", inline: true },
      { name: "📅 תאריך העדכון", value: `\`${today}\``, inline: true },

      { name: SEP_NAME, value: "📌 **פרטי האירוע (לפני העדכון)**" },
      { name: "📝 כותרת האירוע", value: `\`${oldSafe.title}\`` },
      { name: "📆 תאריך", value: `\`${oldSafe.dateText}\``, inline: true },
      { name: "⏰ שעה", value: `\`${oldSafe.timeText}\``, inline: true },

      { name: SEP_NAME, value: "__📌 **פרטי האירוע (לאחר העדכון)**__" },
      { name: "📝 כותרת האירוע", value: `**\`${newMeta.title}\`**` },
      { name: "📆 תאריך", value: `\`${newMeta.dateText}\``, inline: true },
      { name: "⏰ שעה", value: `\`${newMeta.timeText}\``, inline: true }
    )
    .setFooter({ text: "חבילת העריכה הכוללת - מערכת אירועים" });

  const components = [];
  if (link) {
    components.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel("פתח ביומן").setURL(link)
      )
    );
  }

  return { embed, components };
}

async function warmupKnownEvents() {
  try {
    const events = await fetchNextMonthEvents({ showDeleted: true });
    for (const ev of events) {
      if (!ev?.id) continue;
      if (ev.status === "cancelled") continue;
      knownMeta.set(ev.id, snapshotMeta(ev));
    }
    console.log(`Known events warmup: ${knownMeta.size}`);
  } catch (err) {
    console.error("warmupKnownEvents error:", err);
  }
}

/* =========================
   Google Watch + Webhook
========================= */
let watchState = {
  channelId: null,
  resourceId: null,
  expiration: null,
  lastUpdatedMin: null
};

async function startWatchSilently() {
  try {
    // אם יש Watch קודם - ננסה לעצור אותו (לא חובה אבל נקי)
    if (watchState.channelId && watchState.resourceId) {
      try {
        await cal().channels.stop({
          requestBody: { id: watchState.channelId, resourceId: watchState.resourceId }
        });
      } catch (_) {}
    }

    const channelId = crypto.randomUUID();
    const webhookUrl = "https://calendar-discord-backend.onrender.com/webhook/google";

    watchState.lastUpdatedMin = new Date(Date.now() - 15 * 60 * 1000).toISOString();

    const response = await cal().events.watch({
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

    console.log("Watch started ✅", {
      channelId: watchState.channelId,
      resourceId: watchState.resourceId,
      expiration: watchState.expiration
    });
  } catch (err) {
    console.error("startWatchSilently error:", err);
  }
}

app.get("/watch/start", async (req, res) => {
  await startWatchSilently();
  res.json({ ok: true, message: "Watch started ✅", watchState });
});

app.get("/watch/status", (req, res) => {
  res.json({
    ok: true,
    watchActive: !!watchState.channelId,
    watchState,
    boardChannelId: BOARD_CHANNEL_ID,
    updatesChannelId: UPDATES_CHANNEL_ID,
    boardMessageId: BOARD_MESSAGE_ID || null,
    autoWatch: AUTO_WATCH
  });
});

app.get("/watch/stop", async (req, res) => {
  try {
    if (!watchState.channelId || !watchState.resourceId) {
      return res.json({ ok: true, message: "No active watch to stop" });
    }

    await cal().channels.stop({
      requestBody: { id: watchState.channelId, resourceId: watchState.resourceId }
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

    console.log("Webhook received:", { resourceState, channelId });

    if (!watchState.channelId || channelId !== watchState.channelId) {
      console.log("Webhook ignored: watch is not active or channelId mismatch");
      return;
    }

    const updatedMin = watchState.lastUpdatedMin || new Date(Date.now() - 20 * 60 * 1000).toISOString();

    const resp = await cal().events.list({
      calendarId: CALENDAR_ID,
      updatedMin,
      maxResults: 50,
      singleEvents: true,
      orderBy: "updated",
      showDeleted: true
    });

    const items = resp.data.items || [];

    // עדכון lastUpdatedMin
    let maxUpdated = null;
    for (const ev of items) {
      if (ev?.updated) {
        if (!maxUpdated || ev.updated > maxUpdated) maxUpdated = ev.updated;
      }
    }
    watchState.lastUpdatedMin = maxUpdated
      ? new Date(new Date(maxUpdated).getTime() - 1000).toISOString()
      : new Date(Date.now() - 5000).toISOString();

    // תמיד נעדכן לוח (edit להודעה אחת)
    await updateMonthlyBoardEmbed({ reason: "webhook" });

    // לא שולחים הודעות "sync" כדי לא להספים
    if (resourceState === "sync") return;
    if (items.length === 0) return;

    const updatesChannel = await discordClient.channels.fetch(UPDATES_CHANNEL_ID);

    for (const ev of items) {
      if (!ev?.id) continue;

      const oldM = knownMeta.get(ev.id);
      const cancelled = ev.status === "cancelled";

      let type = "updated";
      if (!oldM && !cancelled) type = "created";
      if (cancelled) type = "cancelled";

      const { embed, components } = buildUpdateEmbed({ type, ev, oldMeta: oldM });

      if (cancelled) knownMeta.delete(ev.id);
      else knownMeta.set(ev.id, snapshotMeta(ev));

      await updatesChannel.send({ embeds: [embed], components });
    }
  } catch (err) {
    console.error("Webhook handling error:", err);
  }
});

/* =========================
   Debug - test update channel permissions
========================= */
app.get("/debug/test-update", async (req, res) => {
  try {
    const ch = await discordClient.channels.fetch(UPDATES_CHANNEL_ID);
    const embed = new EmbedBuilder()
      .setTitle("✅ בדיקת שליחה - ערוץ עדכונים")
      .setColor(EMBED_COLOR)
      .setThumbnail(THUMB_URL)
      .setDescription("אם אתה רואה את זה - לבוט יש הרשאה לשלוח כאן.")
      .setFooter({ text: "בדיקה" });

    await ch.send({ embeds: [embed] });
    res.send("Sent test update embed ✅");
  } catch (err) {
    console.error(err);
    res.status(500).send("Failed to send test embed");
  }
});

/* =========================
   Health
========================= */
app.get("/", (req, res) => {
  res.send("Backend is running ✅");
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
