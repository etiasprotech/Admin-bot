const axios = require('axios');
const yts = require('yt-search');
const fs = require('fs');
const path = require('path');

// ===== YOUR BOT CONFIG =====
const BOT_NAME = "ETIAS-AI";
const BOT_IMAGE_PATH = path.join(__dirname, '..', 'media/bot.jpg');

const AXIOS_DEFAULTS = {
  timeout: 30000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36'
  }
};

async function tryRequest(fn) {
  try { return await fn(); }
  catch (e) {
    console.log(`[API FAIL] ${e.message}`);
    return null;
  }
}

async function getEliteProTechDownloadByUrl(youtubeUrl) {
  const apiUrl = `https://eliteprotech-apis.zone.id/ytdown?url=${encodeURIComponent(youtubeUrl)}&format=mp3`;
  const res = await tryRequest(() => axios.get(apiUrl, AXIOS_DEFAULTS));
  if (res?.data?.success && res?.data?.downloadURL) {
    return { download: res.data.downloadURL, title: res.data.title };
  }
  throw new Error('EliteProTech failed');
}
async function getYupraDownloadByUrl(youtubeUrl) {
  const apiUrl = `https://api.yupra.my.id/api/downloader/ytmp3?url=${encodeURIComponent(youtubeUrl)}`;
  const res = await tryRequest(() => axios.get(apiUrl, AXIOS_DEFAULTS));
  if (res?.data?.success && res?.data?.data?.download_url) {
    return { download: res.data.data.download_url, title: res.data.data.title, thumbnail: res.data.data.thumbnail };
  }
  throw new Error('Yupra failed');
}
async function getOkatsuDownloadByUrl(youtubeUrl) {
  const apiUrl = `https://okatsu-rolezapiiz.vercel.app/downloader/ytmp3?url=${encodeURIComponent(youtubeUrl)}`;
  const res = await tryRequest(() => axios.get(apiUrl, AXIOS_DEFAULTS));
  if (res?.data?.dl) {
    return { download: res.data.dl, title: res.data.title, thumbnail: res.data.thumb };
  }
  throw new Error('Okatsu failed');
}

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
      const search = await yts({ videoId: query.split('v=')[1]?.split('&')[0] || query });
      video = search || { url: query, title: 'YouTube Audio', author: { name: 'Unknown' }, timestamp: 'Unknown', ago: 'Unknown', views: 0, likes: 0, url: query, thumbnail: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg' };
      if (!video.url) video.url = query;
    } else {
      const search = await yts(query);
      if (!search?.videos.length) {
        await sock.sendMessage(chatId, { text: '❌ No results found.' }, { quoted: msg });
        return;
      }
      video = search.videos[0];
    }

    // ===== DATA FOR CAPTION =====
    const title = video.title || 'Unknown';
    const artist = video.author?.name || video.author || 'Unknown Artist';
    const duration = video.timestamp || video.duration?.timestamp || 'Unknown';
    const year = video.ago || video.uploadDate || '2024';
    const plays = video.views? video.views.toLocaleString() : '0';
    const likes = video.likes? video.likes.toLocaleString() : '0';
    const url = video.url;

    // LOAD LOCAL BOT IMAGE
    let botImageBuffer;
    try {
      botImageBuffer = fs.readFileSync(BOT_IMAGE_PATH);
    } catch (e) {
      console.log('[PLAY] No local bot.jpg, using thumbnail');
      botImageBuffer = null;
    }

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
│ ❤️ Likes: ${likes}
└─────────────┘

🔗 *Link:* ${url}

> POWERED BY ETIAS-TECH`;

    if (botImageBuffer) {
      await sock.sendMessage(chatId, { image: botImageBuffer, caption }, { quoted: msg });
    } else {
      await sock.sendMessage(chatId, { image: { url: video.thumbnail }, caption }, { quoted: msg });
    }

    // ===== DOWNLOAD AUDIO WITH FALLBACK =====
    let audioBuffer = null;
    const apiMethods = [
      { name: 'EliteProTech', method: () => getEliteProTechDownloadByUrl(video.url) },
      { name: 'Yupra', method: () => getYupraDownloadByUrl(video.url) },
      { name: 'Okatsu', method: () => getOkatsuDownloadByUrl(video.url) }
    ];

    for (const api of apiMethods) {
      try {
        console.log(`[PLAY] Trying ${api.name}...`);
        const data = await api.method();
        const audioUrl = data.download;
        if (!audioUrl) continue;

        const res = await axios.get(audioUrl, {
          responseType: 'arraybuffer',
          timeout: 90000,
          headers: { 'User-Agent': 'Mozilla/5.0 Chrome/120.0.0.0 Safari/537.36' }
        });
        audioBuffer = Buffer.from(res.data);
        console.log(`[PLAY] Success ${api.name} - ${audioBuffer.length} bytes`);
        break;
      } catch (e) {
        console.log(`[PLAY] ${api.name} failed: ${e.message}`);
      }
    }

    if (!audioBuffer) {
      await sock.sendMessage(chatId, { text: '❌ All APIs failed. Try again.' }, { quoted: msg });
      return;
    }

    await sock.sendMessage(chatId, {
      audio: audioBuffer,
      mimetype: 'audio/mpeg',
      fileName: `${title}.mp3`
    }, { quoted: msg });

  } catch (err) {
    console.log('[PLAY ERROR]', err);
    await sock.sendMessage(chatId, { text: `❌ Error: ${err.message}` }, { quoted: msg });
  }
};
