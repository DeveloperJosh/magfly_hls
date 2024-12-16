import express from 'express';
import multer from 'multer';
import bodyParser from 'body-parser';
import { randomUUID } from 'crypto';
import { streamFromInput, getStatusById, getPlaylistUrls, updateStatus } from './lib/streamFromMagnet.js';

const app = express();
const port = 3000;

const upload = multer({ dest: 'uploads/' });

// Middleware to parse JSON bodies
app.use(bodyParser.json());

app.get('/', (req, res) => {
  res.json({
    '/': 'This page.',
    '/start-stream?magnet=': 'Start streaming from a magnet link or torrent file.',
    '/status/:uuid': 'Get the status of a stream by UUID.',
    '/playlist/:uuid': 'Get the playlist URLs of a stream by UUID.',
  });
});

app.post('/start-stream', upload.single('torrentFile'), async (req, res) => {
  const uniqueId = randomUUID();
  console.log(`[${uniqueId}] Initializing stream process.`);

  let input;

  try {
    if (req.body.magnet) {
      input = req.body.magnet;
      console.log(`[${uniqueId}] Received magnet link: ${input}`);
    } else if (req.file) {
      const torrentFilePath = req.file.path;
      input = fs.readFileSync(torrentFilePath);
      console.log(`[${uniqueId}] Received torrent file: ${req.file.originalname}`);
      fs.unlinkSync(torrentFilePath);
    } else {
      return res.status(400).json({ error: 'No magnet link or torrent file provided.' });
    }

    res.json({ uniqueId });

    streamFromInput(input, uniqueId).catch((err) => {
      console.error(`[${uniqueId}] Streaming failed:`, err);
      updateStatus(uniqueId, `Error during processing: ${err.message}`);
    });
  } catch (err) {
    console.error(`[${uniqueId}] Error starting stream:`, err);
    return res.status(500).json({ uniqueId, error: err.message });
  }
});

app.get('/status/:uuid', (req, res) => {
  const uniqueId = req.params.uuid;
  const status = getStatusById(uniqueId);
  res.json({ uniqueId, status });
});

app.get('/playlist/:uuid', (req, res) => {
  const uniqueId = req.params.uuid;
  const playlistUrls = getPlaylistUrls(uniqueId);

  if (!playlistUrls || playlistUrls.length === 0) {
    return res.status(404).json({ error: 'Playlist URLs not found for this UUID.' });
  }

  res.json({ uniqueId, playlistUrls });
});

app.listen(port, () => {
  console.log(`Server listening on http://localhost:${port}`);
});
