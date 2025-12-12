const express = require("express");
const { Client, GatewayIntentBits } = require("discord.js");
const { google } = require("googleapis");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

// חשוב: גוגל שולח webhook כ-POST. אנחנו רק צריכים לקבל אותו מהר ולהחזיר 200.
app.use(express.json());

/* =========================
   Discord Bot
========================= */
const discordClient = new Client({
  intents: [GatewayIntentBits.Guilds]
});

discordClient.once("ready", () => {
  console.log(`Discord bot logged in as ${discordClient.user.tag}`);
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

// נטען refresh token קבוע (כדי שלא נאבד חיבור אחרי restart)
if (process.env.GOOGLE_REFRESH_TOKEN) {
  oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  console.log("Loaded GOOGLE_REFRESH_TOKEN from env ✅");
} else {
  console.log("GOOGLE_REFRESH_TOKEN is missing (OAuth will work only until restart) ⚠️");
}

function getCalendarClient() {
  return google.calendar({ version: "v3", auth: oauth2Client });
}

/* =========================
   OAuth Routes
========================= */
app.get("/auth/google", (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: ["https://www.googleapis.com/auth/calendar.readonly"],
    prompt: "consent" // חשוב: כדי לקבל refresh_token
  });
  res.redirect(url);
});

app.get("/oauth/callback", async (req, res) => {
  try {
    const { code } = req.query;
    if (!code) return res.status(400).send("Missing code");

    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    // חשוב: refresh_token מופיע בדרך כלל רק בפעם הראשונה (או כשיש prompt: consent)
    if (tokens.refresh_token) {
      console.log("✅ COPY THIS refresh_token into Render ENV (GOOGLE_REFRESH_TOKEN):");
      console.log(tokens.refresh_token);
    } else {
      console.log("No refresh_token returned (maybe already granted before). If needed, revoke access and try again with prompt=consent.");
    }

    res.send("✅ Google Calendar connected successfully! (Check Render logs for refresh_token)");
  } catch (err) {
    console.error("OAuth error:", err);
    res.status(500).send("OAuth failed");
  }
});

/* =========================
   Test: Read events from ONE calendar
========================= */
app.get("/test-calendar", async (req, res) => {
  try {
    const calendar = getCalendarClient();
    const response = await calendar.events.list({
      calendarId: process.env.GCAL_CALENDAR_ID,
      maxResults: 10,
      singleEvents: true,
      orderBy: "startTime"
    });
    res.json(response.data.items || []);
  } catch (err) {
    console.error("Calendar error:", err);
    res.status(500).send("Failed to fetch calendar events");
  }
});

/* =========================
   WATCH (Push Notifications)
========================= */
let watchState = {
  channelId: null,
  resourceId: null,
  expiration: null,
  lastUpdatedMin: null
};

// מתחילים Watch
app.get("/watch/start", async (req, res) => {
  try {
    const calendar = getCalendarClient();

    const channelId = crypto.randomUUID();
    const webhookUrl = "https://calendar-discord-backend.onrender.com/webhook/google";

    // נרשום updatedMin כדי למשוך רק שינויים אחרי רגע ההפעלה
    watchState.lastUpdatedMin = new Date(Date.now() - 5 * 60 * 1000).toISOString(); // 5 דקות באפר

    const response = await calendar.events.watch({
      calendarId: process.env.GCAL_CALENDAR_ID,
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

// עוצרים Watch (מומלץ כשעושים ניסויים)
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

/* =========================
   WEBHOOK receiver
   Google sends headers:
   X-Goog-Resource-State, X-Goog-Resource-ID, X-Goog-Channel-ID, etc.
========================= */
app.post("/webhook/google", async (req, res) => {
  // חייבים להחזיר 200 מהר
  res.status(200).send("OK");

  try {
    const resourceState = req.get("x-goog-resource-state");
    const channelId = req.get("x-goog-channel-id");

    console.log("Webhook received:", { resourceState, channelId });

    // גוגל שולח גם "sync" בהתחלה לפעמים
    if (!watchState.channelId || channelId !== watchState.channelId) return;

    // מושכים אירועים ששונו מאז lastUpdatedMin
    const calendar = getCalendarClient();

    const updatedMin = watchState.lastUpdatedMin || new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const response = await calendar.events.list({
      calendarId: process.env.GCAL_CALENDAR_ID,
      updatedMin,
      maxResults: 10,
      singleEvents: true,
      orderBy: "updated"
    });

    // מעדכנים כדי שבפעם הבאה נמשוך רק דברים חדשים יותר
    watchState.lastUpdatedMin = new Date(Date.now() - 5 * 1000).toISOString();

    const items = response.data.items || [];
    if (items.length === 0) return;

    const channel = await discordClient.channels.fetch(process.env.DISCORD_CHANNEL_ID);

    for (const ev of items) {
      const title = ev.summary || "(ללא כותרת)";
      const link = ev.htmlLink || "";
      const start =
        ev.start?.dateTime ||
        ev.start?.date ||
        "זמן לא ידוע";

      await channel.send(`📅 **שינוי ביומן**\n**${title}**\n🕒 ${start}\n${link}`);
    }
  } catch (err) {
    console.error("Webhook handling error:", err);
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
