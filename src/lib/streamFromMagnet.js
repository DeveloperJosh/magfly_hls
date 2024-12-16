// src/streamFromInput.js

import WebTorrent from 'webtorrent';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';
import path from 'path';
import fs from 'fs';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

ffmpeg.setFfmpegPath(ffmpegPath);

const s3 = new S3Client({
  endpoint: "https://neko-minio.b1pohl.easypanel.host", 
  region: "us-east-1",
  credentials: {
    accessKeyId: process.env.MINIO_ROOT_USER || "admin", 
    secretAccessKey: process.env.MINIO_ROOT_PASSWORD || "password",
  },
  forcePathStyle: true 
});

const BUCKET_NAME = "hls"; 
const ROOT_OUTPUT_DIR = path.resolve('./hls-output');

const processStatus = {}; 
const playlistUrlsMap = {}; 
/**
 * Ensure the root output directory exists.
 */
function ensureRootOutputDir() {
  if (!fs.existsSync(ROOT_OUTPUT_DIR)) {
    fs.mkdirSync(ROOT_OUTPUT_DIR, { recursive: true });
    console.log(`Created root output directory: ${ROOT_OUTPUT_DIR}`);
  }
}

/**
 * Generate a random alphanumeric string.
 * @returns {string} - Random alphanumeric string.
 */
function generateRandomUnicodeName() {
  const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 12 }, () => characters.charAt(Math.floor(Math.random() * characters.length))).join('');
}

/**
 * Update process status by UUID.
 * @param {string} uniqueId - Unique process identifier.
 * @param {string} status - Status message.
 */
function updateStatus(uniqueId, status) {
  processStatus[uniqueId] = status;
  console.log(`[${uniqueId}] Status: ${status}`);
}

/**
 * Get the current status of a process by UUID.
 * @param {string} uniqueId - Unique process identifier.
 * @returns {string} - Current status.
 */
export function getStatusById(uniqueId) {
  return processStatus[uniqueId] || 'Unknown ID or process not started.';
}

/**
 * Get the playlist URLs for a process by UUID.
 * @param {string} uniqueId - Unique process identifier.
 * @returns {Array<{ playlistUrl: string, fileName: string }>} - Playlist URLs.
 */
export function getPlaylistUrls(uniqueId) {
  return playlistUrlsMap[uniqueId] || [];
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
  try {
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key,
      Body: fileStream,
      ContentType: contentType
    }));
    console.log(`File uploaded: ${key}`);
  } catch (err) {
    console.error(`Error uploading file ${filePath} to MinIO:`, err);
    throw err;
  }
}

/**
 * Clean up temporary files and directories.
 * @param {string} outputDir - Directory to be deleted.
 */
function cleanup(outputDir) {
  try {
    if (fs.existsSync(outputDir)) {
      fs.rmSync(outputDir, { recursive: true, force: true });
      console.log(`Cleaned up directory: ${outputDir}`);
    }
  } catch (err) {
    console.warn(`Failed to clean up directory ${outputDir}:`, err);
  }
}

/**
 * Upload all HLS files to MinIO for a single video file and return the playlist URL.
 * @param {string} outputDir - Directory containing HLS files.
 * @param {string} uniqueId - Unique identifier for the stream.
 * @returns {Promise<string>} - URL to the `.m3u8` file on MinIO.
 */
/**
 * Upload all HLS files to MinIO for a single video file and return the playlist URL.
 * @param {string} outputDir - Directory containing HLS files.
 * @param {string} uniqueId - Unique identifier for the stream.
 * @returns {Promise<string>} - URL to the `.m3u8` file on MinIO.
 */
async function uploadHLSFilesForVideo(outputDir, uniqueId) {
  const files = fs.readdirSync(outputDir);
  const totalFiles = files.length;
  let uploadedFiles = 0;

  const m3u8File = files.find(f => f.endsWith('.m3u8'));
  if (!m3u8File) throw new Error('No .m3u8 file found after transcoding.');

  const m3u8FilePath = path.join(outputDir, m3u8File);
  let m3u8Content = fs.readFileSync(m3u8FilePath, 'utf-8');

  const tsFileMapping = {};

  const tsFiles = files.filter(f => f.endsWith('.ts'));
  for (const tsFile of tsFiles) {
    const randomTsName = `${generateRandomUnicodeName()}.ts`;
    const tsKey = `${uniqueId}/${randomTsName}`;
    const tsFilePath = path.join(outputDir, tsFile);

    await uploadFileToMinIO(tsFilePath, tsKey, 'video/mp2t');
    uploadedFiles++;
    console.log(`[${uniqueId}] Upload progress: ${Math.round((uploadedFiles / totalFiles) * 100)}%`);

    tsFileMapping[tsFile] = randomTsName;
  }

  Object.entries(tsFileMapping).forEach(([oldName, newName]) => {
    m3u8Content = m3u8Content.replace(new RegExp(oldName, 'g'), newName);
  });

  fs.writeFileSync(m3u8FilePath, m3u8Content, 'utf-8');

  const randomM3u8Name = `${generateRandomUnicodeName()}.m3u8`;
  const m3u8Key = `${uniqueId}/${randomM3u8Name}`;

  await uploadFileToMinIO(m3u8FilePath, m3u8Key, 'application/vnd.apple.mpegurl');
  uploadedFiles++;
  console.log(`[${uniqueId}] Upload progress: ${Math.round((uploadedFiles / totalFiles) * 100)}%`);

  const playlistUrl = `https://neko-minio.b1pohl.easypanel.host/${BUCKET_NAME}/${m3u8Key}`;
  playlistUrlsMap[uniqueId] = playlistUrlsMap[uniqueId] || [];
  playlistUrlsMap[uniqueId].push({ playlistUrl, fileName: m3u8File });
  console.log(`[${uniqueId}] Playlist URL: ${playlistUrl}`);
  return playlistUrl;
}

/**
 * Process all video files in the torrent.
 * @param {WebTorrent.Torrent} torrent - Torrent object from WebTorrent.
 * @param {string} uniqueId - Unique process identifier.
 * @returns {Promise<Array<{ playlistUrl: string, fileName: string }>>}
 */
async function processTorrentFiles(torrent, uniqueId) {
  const videoFiles = torrent.files.filter((f) => /\.(mp4|mkv|avi|mov)$/i.test(f.name));
  if (videoFiles.length === 0) throw new Error('No suitable video files found in the torrent.');

  const playlistUrls = [];
  for (const file of videoFiles) {
    const sanitizedFileName = file.name.replace(/\W+/g, '_');
    const outputDir = path.join(ROOT_OUTPUT_DIR, `hls-output-${sanitizedFileName}`);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    updateStatus(uniqueId, `Processing file: ${file.name}`);
    const stream = file.createReadStream();
    const m3u8Path = path.join(outputDir, 'index.m3u8');

    await new Promise((resolve, reject) => {
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
          console.log(`[${uniqueId}] FFmpeg started for ${file.name}: ${cmd}`);
        })
        .on('progress', (progress) => {
          if (progress.percent) {
            console.log(`[${uniqueId}] FFmpeg progress for ${file.name}: ${Math.round(progress.percent)}%`);
          }
        })
        .on('end', async () => {
          console.log(`[${uniqueId}] HLS transcoding finished for ${file.name}`);
          try {
            const playlistUrl = await uploadHLSFilesForVideo(outputDir, uniqueId);
            playlistUrls.push({ playlistUrl, fileName: file.name });
            cleanup(outputDir); // Cleanup after processing
            resolve();
          } catch (err) {
            cleanup(outputDir);
            reject(err);
          }
        })
        .on('error', (err) => {
          console.error(`[${uniqueId}] FFmpeg error for ${file.name}:`, err);
          cleanup(outputDir);
          reject(err);
        })
        .run();
    });
  }
  return playlistUrls;
}

/**
 * Determine if input is a magnet URI or torrent file buffer.
 * @param {string|Buffer} input - Magnet URI string or torrent file buffer.
 * @returns {Promise<string|Buffer>} - Magnet URI or torrent file buffer.
 */
export async function resolveInput(input) {
  if (typeof input === 'string' && input.startsWith('magnet:?')) {
    console.log('Detected magnet link.');
    return input;
  }

  if (Buffer.isBuffer(input)) {
    console.log('Detected torrent file buffer.');
    return input;
  }

  throw new Error('Invalid input: Must be a magnet URI string or a torrent file buffer.');
}

/**
 * Stream from a magnet URI or torrent file buffer.
 * @param {string|Buffer} input - Magnet URI or torrent file buffer.
 * @param {string} uniqueId - Unique identifier for the stream.
 * @returns {Promise<Array<{ playlistUrl: string, fileName: string }>>}
 */
export async function streamFromInput(input, uniqueId) {
  ensureRootOutputDir();
  const resolvedInput = await resolveInput(input);

  return new Promise((resolve, reject) => {
    const wtClient = new WebTorrent({ utp: false });

    console.log(`[${uniqueId}] Adding torrent.`);
    wtClient.add(resolvedInput, async (torrent) => {
      try {
        updateStatus(uniqueId, 'Torrent added. Processing video files...');

        torrent.on('download', (bytes) => {
          console.log(`[${uniqueId}] Downloaded ${bytes} bytes.`);
        });

        torrent.on('done', () => {
          console.log(`[${uniqueId}] Torrent download complete.`);
          updateStatus(uniqueId, 'Torrent download complete. Processing files...');
        });

        const playlistUrls = await processTorrentFiles(torrent, uniqueId);
        wtClient.destroy(() => {
          console.log(`[${uniqueId}] WebTorrent client destroyed.`);
        });
        updateStatus(uniqueId, 'Process complete.');
        resolve(playlistUrls);
      } catch (err) {
        wtClient.destroy(() => {
          console.error(`[${uniqueId}] Error during WebTorrent client destruction:`, err);
        });
        updateStatus(uniqueId, `Error during processing: ${err.message}`);
        reject(err);
      }
    });

    wtClient.on('error', (err) => {
      if (err.code === 'UTP_ECONNRESET') {
        console.warn(`[${uniqueId}] Warning: UTP connection reset.`);
      } else {
        console.error(`[${uniqueId}] WebTorrent error:`, err);
        updateStatus(uniqueId, `WebTorrent error: ${err.message}`);
        reject(err);
      }
    });
  });
}
