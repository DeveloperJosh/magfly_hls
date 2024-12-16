import express from 'express';
import streamFromMagnet from './lib/streamFromMagnet.js';

const app = express();
const PORT = 3000;

// In-memory job storage
// jobs[id] = { status: 'Processing' | 'Done' | 'Error', link: string | null, message?: string }
const jobs = {};

/**
 * Start Stream Endpoint
 * GET /start-stream?magnet=<magnet_link>
 * Returns: { id: <job_id> }
 */
app.get('/start-stream', async (req, res) => {
  const { magnet } = req.query;
  if (!magnet) {
    return res.status(400).json({ error: 'Missing magnet link' });
  }

  const jobId = Date.now().toString(36) + Math.random().toString(36).substr(2, 9);

  jobs[jobId] = { status: 'Processing', link: null };

  (async () => {
    try {
      const { playlistUrl } = await streamFromMagnet(magnet);

      jobs[jobId] = { status: 'Done', link: playlistUrl };
    } catch (err) {
      console.error(`Error processing job ${jobId}:`, err);
      jobs[jobId] = { status: 'Error', link: null, message: err.message };
    }
  })();

  res.json({ id: jobId });
});

/**
 * Status Endpoint
 * GET /status?id=<job_id>
 * Returns:
 *   - { status: 'Processing' }
 *   - { status: 'Done', link: <playlistUrl> }
 *   - { status: 'Error', message: <error_message> }
 */
app.get('/status', (req, res) => {
  const { id } = req.query;
  if (!id || !jobs[id]) {
    return res.status(404).json({ error: 'Not found' });
  }

  const job = jobs[id];
  if (job.status === 'Processing') {
    return res.json({ status: 'Processing' });
  } else if (job.status === 'Done') {
    return res.json({ status: 'Done', link: job.link });
  } else if (job.status === 'Error') {
    return res.json({ status: 'Error', message: job.message || 'Something went wrong during processing.' });
  }
});

/**
 * Health Check Endpoint
 * GET /health
 * Returns: { status: 'OK' }
 */
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK' });
});

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});