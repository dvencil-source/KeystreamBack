const express = require('express');
const cors = require('cors');
const ytdl = require('@distube/ytdl-core');

const app = express();
const PORT = process.env.PORT || 3001;

// ─── MIDDLEWARE ───────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// ─── RATE LIMITER (in-memory, per IP) ────────────────────────
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 20;

function rateLimit(req, res, next) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const entry = rateLimitMap.get(ip) || { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };

  if (now > entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + RATE_LIMIT_WINDOW_MS;
  }

  entry.count++;
  rateLimitMap.set(ip, entry);

  if (rateLimitMap.size > 1000) {
    for (const [key, val] of rateLimitMap) {
      if (now > val.resetAt) rateLimitMap.delete(key);
    }
  }

  if (entry.count > RATE_LIMIT_MAX) {
    return res.status(429).json({ error: 'Too many requests — please wait a minute before trying again' });
  }
  next();
}

// Helper: wrap a promise with a timeout
function withTimeout(promise, ms, label) {
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms)
  );
  return Promise.race([promise, timeout]);
}

// ─── ROUTES ──────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'KeyStream Audio Server', version: '1.0.0' });
});

app.get('/api/yt/info', rateLimit, async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing url parameter' });

  if (!ytdl.validateURL(url)) {
    return res.status(400).json({ error: 'Invalid YouTube URL' });
  }

  try {
    const info = await withTimeout(ytdl.getInfo(url), 15000, 'getInfo');
    const details = info.videoDetails;

    res.json({
      title:     details.title,
      duration:  parseInt(details.lengthSeconds, 10),
      thumbnail: details.thumbnails?.[details.thumbnails.length - 1]?.url || '',
      author:    details.author?.name || '',
    });
  } catch (err) {
    console.error('[/api/yt/info]', err.message);
    res.status(500).json({ error: 'Could not fetch video info: ' + err.message });
  }
});

app.get('/api/yt/audio', rateLimit, async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing url parameter' });

  if (!ytdl.validateURL(url)) {
    return res.status(400).json({ error: 'Invalid YouTube URL' });
  }

  try {
    const info = await withTimeout(ytdl.getInfo(url), 15000, 'getInfo');

    const format = ytdl.chooseFormat(info.formats, {
      quality: 'highestaudio',
      filter: 'audioonly',
    });

    if (!format) {
      return res.status(500).json({ error: 'No audio-only format available for this video' });
    }

    res.setHeader('Content-Type', format.mimeType || 'audio/webm');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-store');

    if (format.contentLength) {
      res.setHeader('Content-Length', format.contentLength);
    }

    const stream = ytdl.downloadFromInfo(info, {
      format,
      requestOptions: {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
      },
    });

    stream.on('error', (err) => {
      console.error('[/api/yt/audio] stream error:', err.message);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Stream failed: ' + err.message });
      } else {
        res.destroy();
      }
    });

    req.on('close', () => stream.destroy());

    stream.pipe(res);
  } catch (err) {
    console.error('[/api/yt/audio]', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Could not stream audio: ' + err.message });
    }
  }
});

// ─── SERVER STARTUP ───────────────────────────────────────────
const server = app.listen(PORT, () => {
  console.log(`KeyStream server running on port ${PORT}`);
});

// ─── GRACEFUL SHUTDOWN ────────────────────────────────────────
process.on('SIGTERM', () => {
  console.log('SIGTERM received — shutting down gracefully');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000);
});

// ─── SAFETY NET ───────────────────────────────────────────────
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err.message);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});
