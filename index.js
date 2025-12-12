const express = require("express");
const { Client, GatewayIntentBits } = require("discord.js");

const app = express();
const PORT = process.env.PORT || 3000;

// דיסקורד
const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

client.once("ready", () => {
  console.log(`Discord bot logged in as ${client.user.tag}`);
});

client.login(process.env.DISCORD_TOKEN);

// בדיקה – שליחת הודעה
app.get("/test-discord", async (req, res) => {
  try {
    const channel = await client.channels.fetch(
      process.env.DISCORD_CHANNEL_ID
    );

    await channel.send("✅ הודעת בדיקה מה־Backend!");

    res.send("Message sent to Discord");
  } catch (err) {
    console.error(err);
    res.status(500).send("Failed to send message");
  }
});

app.get("/", (req, res) => {
  res.send("Backend is running ✅");
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
