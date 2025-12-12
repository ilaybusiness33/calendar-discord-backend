const express = require("express");
const { Client, GatewayIntentBits } = require("discord.js");
const { google } = require("googleapis");

const app = express();
const PORT = process.env.PORT || 3000;

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

/* התחלת OAuth */
app.get("/auth/google", (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: ["https://www.googleapis.com/auth/calendar.readonly"],
    prompt: "consent"
  });

  res.redirect(url);
});

/* חזרה מגוגל אחרי אישור */
app.get("/oauth/callback", async (req, res) => {
  try {
    const { code } = req.query;

    if (!code) {
      return res.status(400).send("Missing code");
    }

    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    console.log("Google OAuth success");
    res.send("✅ Google Calendar connected successfully!");
  } catch (err) {
    console.error("OAuth error:", err);
    res.status(500).send("OAuth failed");
  }
});

/* =========================
   בדיקה – קריאת אירועים
   (יומן אחד בלבד!)
========================= */
app.get("/test-calendar", async (req, res) => {
  try {
    const calendar = google.calendar({
      version: "v3",
      auth: oauth2Client
    });

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
   בדיקת חיים
========================= */
app.get("/", (req, res) => {
  res.send("Backend is running ✅");
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
