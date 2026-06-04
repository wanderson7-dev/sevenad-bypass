module.exports = function handler(req, res) {
  try {
    const ffmpegPath = require('ffmpeg-static');
    res.status(200).json({ ok: true, ffmpegPath });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message, stack: e.stack });
  }
};
