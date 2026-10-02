const axios = require('axios');
const yts = require('yt-search');
const fs = require('fs');
const path = require('path');

const BOT_NAME = "*ETIAS-AI*";
const BOT_IMAGE_PATH = path.join(__dirname, '..', 'media/bot.png');

module.exports.name = "play";
module.exports.execute = async (sock, msg, args) => {
  const chatId = msg.key.remoteJid;
  const query = args.join(' ').trim();

  if (!query) {
    await sock.sendMessage(chatId, { text: '❌ Usage:.play <song name>' }, { quoted: msg });
    return;
  }

  try {
    let video;
    if (query.includes('youtube.com') || query.includes('youtu.be')) {
      video = { url: query, title: 'YouTube Audio', author: { name: 'Unknown' }, timestamp: 'Unknown', ago: 'Unknown', views: 0, thumbnail: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg' };
    } else {
      const search = await yts(query);
      if (!search?.videos.length) {
        await sock.sendMessage(chatId, { text: '❌ No results found.' }, { quoted: msg });
        return;
      }
      video = search.videos[0];
    }

    const title = video.title || 'Unknown';
    const artist = video.author?.name || video.author || 'Unknown Artist';
    const duration = video.timestamp || 'Unknown';
    const year = video.ago || '2024';
    const plays = video.views? video.views.toLocaleString() : '0';
    const url = video.url;

    let botImageBuffer;
    try { botImageBuffer = fs.readFileSync(BOT_IMAGE_PATH); } catch { botImageBuffer = null; }

    const caption =
`┏━━━━━━━━━━━━━━━━━━━━┓
┃ 🤖 ${BOT_NAME} ┃
┗━━━━━━━━━━━━━━━━━━━━┛

*🎵 Title:* ${title}
*👤 Artist:* ${artist}

┌─ 📊 *INFO* ─┐
│ ⏱️ Duration: ${duration}
│ 📅 Year: ${year}
│ 👁️ Plays: ${plays}
└─────────────┘

🔗 *Link:* ${url}

> *POWERED BY ETIAS-TECH*`;

    if (botImageBuffer) {
      await sock.sendMessage(chatId, { image: botImageBuffer, caption }, { quoted: msg });
    } else {
      await sock.sendMessage(chatId, { image: { url: video.thumbnail }, caption }, { quoted: msg });
    }

    // PRINCE TECH ONLY
    console.log(`[PLAY] Trying PrinceTech...`);
    const apiUrl = `https://api.princetechn.com/api/download/mp3?apikey=prince&url=${encodeURIComponent(video.url)}`;
    const apiRes = await axios.get(apiUrl, {
      timeout: 30000,
      headers: { 'User-Agent': 'Mozilla/5.0 Chrome/120.0.0.0' }
    });

    const data = apiRes.data;
    const audioUrl = data?.result?.download || data?.download || data?.url || data?.result?.url || data?.data?.download;

    if (!audioUrl) {
      throw new Error('No download link');
    }

    console.log(`[PLAY] Got link, downloading audio...`);
    const audioRes = await axios.get(audioUrl, {
      responseType: 'arraybuffer',
      timeout: 90000,
      headers: { 'User-Agent': 'Mozilla/5.0 Chrome/120.0.0.0' }
    });

    const audioBuffer = Buffer.from(audioRes.data);
    console.log(`[PLAY] Success - ${audioBuffer.length} bytes`);

    await sock.sendMessage(chatId, {
      audio: audioBuffer,
      mimetype: 'audio/mpeg',
      fileName: `${title}.mp3`
    }, { quoted: msg });

  } catch (err) {
    console.log('[PLAY ERROR]', err.message);
    await sock.sendMessage(chatId, { text: `❌ Error: ${err.message}` }, { quoted: msg });
  }
};
