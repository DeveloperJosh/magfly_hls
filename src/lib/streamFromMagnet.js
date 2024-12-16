// lib/streamFromMagnet.js
import WebTorrent from 'webtorrent';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { randomUUID } from 'crypto';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

// Set FFmpeg path
ffmpeg.setFfmpegPath(ffmpegPath);

// Configure MinIO
const s3 = new S3Client({
  endpoint: process.env.MINIO_ENDPOINT || "https://neko-minio.b1pohl.easypanel.host",
  region: "us-east-1",
  credentials: {
    accessKeyId: process.env.MINIO_ACCESS_KEY || "admin",
    secretAccessKey: process.env.MINIO_SECRET || "password"
  },
  forcePathStyle: true
});

const BUCKET_NAME = "hls";
const processStatus = {};

/**
 * Update process status by unique ID.
 * @param {string} uniqueId - Unique process identifier.
 * @param {string} status - Status message.
 */
function updateStatus(uniqueId, status) {
  processStatus[uniqueId] = status;
  console.log(`[${uniqueId}] Status: ${status}`);
}

/**
 * Get the current status of a process by ID.
 * @param {string} uniqueId - Unique process identifier.
 * @returns {string} - Current status of the process.
 */
export function getStatusById(uniqueId) {
  return processStatus[uniqueId] || 'Unknown ID or process not started.';
}

/**
 * Upload a single file to MinIO.
 * @param {string} filePath - Local file path.
 * @param {string} key - Object key in MinIO (e.g., "uniqueId/index.m3u8").
 * @param {string} [contentType='application/octet-stream'] - MIME type of the file.
 */
async function uploadFileToMinIO(filePath, key, contentType = 'application/octet-stream') {
  console.log(`Uploading ${filePath} to MinIO as ${key}...`);
  const fileStream = fs.createReadStream(filePath);
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: key,
    Body: fileStream,
    ContentType: contentType
  }));
  console.log(`File uploaded: ${key}`);
}

/**
 * Upload all HLS files to MinIO and return the playlist URL.
 * @param {string} outputDir - Directory containing HLS files.
 * @param {string} uniqueId - Unique identifier for the stream.
 * @returns {Promise<string>} - URL to the `.m3u8` file on MinIO.
 */
async function uploadHLSFilesToMinIO(outputDir, uniqueId) {
  updateStatus(uniqueId, 'Uploading HLS files to MinIO...');
  const files = fs.readdirSync(outputDir);
  const m3u8File = files.find(f => f.endsWith('.m3u8'));
  if (!m3u8File) throw new Error('No .m3u8 file found after transcoding.');

  const m3u8Key = `${uniqueId}/${m3u8File}`;
  await uploadFileToMinIO(path.join(outputDir, m3u8File), m3u8Key, 'application/vnd.apple.mpegurl');

  const tsFiles = files.filter(f => f.endsWith('.ts'));
  for (const tsFile of tsFiles) {
    const tsKey = `${uniqueId}/${tsFile}`;
    await uploadFileToMinIO(path.join(outputDir, tsFile), tsKey, 'video/mp2t');
  }

  const playlistUrl = `https://neko-minio.b1pohl.easypanel.host/${BUCKET_NAME}/${uniqueId}/${m3u8File}`;
  updateStatus(uniqueId, `Upload complete. Playlist URL: ${playlistUrl}`);
  return playlistUrl;
}

/**
 * Download torrent, transcode to HLS, upload to MinIO.
 * @param {string} magnetURI - Magnet link of the torrent.
 * @returns {Promise<{ playlistUrl: string, uniqueId: string }>}.
 */
export default async function streamFromMagnet(magnetURI) {
  const uniqueId = randomUUID();
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hls-output-'));
  updateStatus(uniqueId, 'Initializing stream process...');

  return new Promise((resolve, reject) => {
    const wtClient = new WebTorrent();
    wtClient.add(magnetURI, (torrent) => {
      updateStatus(uniqueId, 'Torrent added. Searching for suitable video file...');
      const file = torrent.files.find((f) => /\.(mp4|mkv|avi|mov)$/i.test(f.name));
      if (!file) {
        wtClient.destroy(() => {});
        updateStatus(uniqueId, 'No suitable video file found.');
        return reject(new Error('No suitable video file found in the torrent.'));
      }

      updateStatus(uniqueId, `File found: ${file.name}. Starting transcoding...`);
      const stream = file.createReadStream();

      const m3u8Path = path.join(outputDir, 'index.m3u8');
      ffmpeg(stream)
        .outputOptions([
          '-preset veryfast',
          '-profile:v baseline',
          '-level 3.0',
          '-start_number 0',
          '-hls_time 10',
          '-hls_list_size 0',
          '-f hls'
        ])
        .output(m3u8Path)
        .on('start', (cmd) => {
          updateStatus(uniqueId, 'FFmpeg started transcoding.');
          console.log(`[${uniqueId}] FFmpeg Command:`, cmd);
        })
        .on('end', async () => {
          updateStatus(uniqueId, 'HLS transcoding finished.');
          console.log(`[${uniqueId}] HLS transcoding finished.`);
          try {
            const playlistUrl = await uploadHLSFilesToMinIO(outputDir, uniqueId);
            fs.rmSync(outputDir, { recursive: true, force: true });
            wtClient.destroy(() => {});
            updateStatus(uniqueId, 'Process complete.');
            resolve({ playlistUrl, uniqueId });
          } catch (err) {
            fs.rmSync(outputDir, { recursive: true, force: true });
            wtClient.destroy(() => {});
            updateStatus(uniqueId, `Error during upload: ${err.message}`);
            reject(err);
          }
        })
        .on('error', (err) => {
          console.error(`[${uniqueId}] FFmpeg error:`, err);
          updateStatus(uniqueId, `FFmpeg error: ${err.message}`);
          fs.rmSync(outputDir, { recursive: true, force: true });
          wtClient.destroy(() => {});
          reject(err);
        })
        .run();
    });
  });
}
