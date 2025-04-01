// electron_app/main_process/image-downloader.js
const fs = require('fs'); // Use sync for setup, async for operations if needed later
const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { net } = require('electron'); // Use Electron's net module

const DOWNLOAD_DIR = path.join(__dirname, '..', 'downloaded_images'); // Relative to main_process dir

// --- Directory Setup ---
function setupDownloadDir() {
    try {
        if (!fs.existsSync(DOWNLOAD_DIR)) {
            fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
            console.log(`[Image Downloader] Created image directory: ${DOWNLOAD_DIR}`);
        } else {
            console.log(`[Image Downloader] Image directory exists: ${DOWNLOAD_DIR}`);
        }
        return DOWNLOAD_DIR; // Return the confirmed path
    } catch (mkdirError) {
        console.error(`[Image Downloader FATAL] Cannot create image directory "${DOWNLOAD_DIR}":`, mkdirError);
        // Propagate error to let main process handle shutdown if needed
        throw new Error(`Failed to create image download directory: ${mkdirError.message}`);
    }
}

// --- Concurrency Limiter ---
async function limitConcurrency(tasks, limit) {
    const results = []; const executing = [];
    for (const task of tasks) {
        const p = Promise.resolve().then(() => task()).catch(err => { console.error('[Concurrency Err] Task failed:', err); return null; });
        results.push(p);
        if (limit <= tasks.length) {
            const e = p.finally(() => executing.splice(executing.indexOf(e), 1));
            executing.push(e);
            if (executing.length >= limit) { await Promise.race(executing); }
        }
    }
    return Promise.all(results);
}

// --- Image Download Function ---
// Takes session from webview for cookies/auth context
function downloadImage(imageUrl, refererUrl, session) {
    return new Promise(async (resolve) => { // Added async for await fs.access
        if (!imageUrl || typeof imageUrl !== 'string' || (!imageUrl.startsWith('http:') && !imageUrl.startsWith('https:'))) {
             console.warn('[DL Warn] Invalid URL:', imageUrl); return resolve(null);
        }
        if (!session || typeof session !== 'object' || typeof session.protocol !== 'object') {
             console.warn('[DL Warn] Invalid session for:', imageUrl); return resolve(null);
        }

        let urlObj; try { urlObj = new URL(imageUrl); } catch (urlError) { console.warn(`[DL Warn] URL format "${imageUrl}": ${urlError.message}`); return resolve(null); }

        const hash = crypto.createHash('sha1').update(imageUrl).digest('hex');
        const ext = path.extname(urlObj.pathname) || '.jpg'; // Default extension
        const localFilename = `${hash}${ext}`;
        const localFilepath = path.join(DOWNLOAD_DIR, localFilename);

        // Check if file exists before attempting download
        try {
            await fsp.access(localFilepath);
            // console.debug(`[DL Cache] Found: ${localFilename}`);
            return resolve(localFilename);
        } catch (err) {
            // File doesn't exist, proceed with download
        }

        const reqOptions = { url: imageUrl, session: session, useSessionCookies: true };
        const request = net.request(reqOptions);
        let writeStream = null;

        request.on('response', (response) => {
            if (response.statusCode >= 200 && response.statusCode < 300) {
                const contentType = response.headers['content-type'] || '';
                if (!contentType.startsWith('image/')) {
                    console.warn(`[DL Warn] Not an image (${contentType}) URL: ${imageUrl}`);
                    response.resume(); // Consume data to free resources
                    request.abort();
                    return resolve(null);
                }

                try {
                    writeStream = fs.createWriteStream(localFilepath);
                    writeStream.on('finish', () => {
                        // console.debug(`[DL OK] Saved: ${localFilename}`);
                        resolve(localFilename);
                    });
                    writeStream.on('error', (streamError) => {
                        console.error(`[DL Err] Stream Write ${localFilename}:`, streamError);
                        resolve(null);
                        // Attempt cleanup
                        try { if (fs.existsSync(localFilepath)) fs.unlinkSync(localFilepath); } catch (e) {}
                    });
                    response.pipe(writeStream);
                } catch (streamCreateError) {
                    console.error(`[DL Err] Stream Create ${localFilepath}:`, streamCreateError);
                    response.resume();
                    request.abort();
                    resolve(null);
                }
            } else {
                console.warn(`[DL Warn] Failed status ${response.statusCode} for URL: ${imageUrl.substring(0, 60)}...`);
                response.resume(); // Consume data
                resolve(null);
            }
        });

        request.on('error', (error) => {
            console.error(`[DL Err] Request ${imageUrl}:`, error.message);
            if (writeStream && !writeStream.closed) {
                writeStream.close(() => { /* Try cleanup */ try { if (fs.existsSync(localFilepath)) fs.unlinkSync(localFilepath); } catch (e) {} });
            }
            resolve(null);
        });

        request.on('abort', () => {
             // console.debug(`[DL Abort] URL: ${imageUrl}`);
             if (writeStream && !writeStream.closed) {
                 writeStream.close(() => { /* Try cleanup */ try { if (fs.existsSync(localFilepath)) fs.unlinkSync(localFilepath); } catch (e) {} });
             }
             // Don't resolve here, let other handlers manage resolution
        });

        // Set Headers
        request.setHeader('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
        request.setHeader('Accept', 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8');
        request.setHeader('Accept-Language', 'en-US,en;q=0.9');
        if (refererUrl && typeof refererUrl === 'string' && refererUrl.startsWith('http')) {
            request.setHeader('Referer', refererUrl);
        }
        request.setHeader('Sec-Fetch-Dest', 'image');
        request.setHeader('Sec-Fetch-Mode', 'no-cors');
        request.setHeader('Sec-Fetch-Site', 'same-origin'); // Adjust if needed, often same-origin for images loaded by page JS

        try {
            // console.debug(`[DL Start] URL: ${imageUrl}`);
            request.end();
        } catch (endError) {
            console.error(`[DL Err] req.end() ${imageUrl}:`, endError);
            resolve(null);
        }
    });
}

module.exports = {
    setupDownloadDir,
    downloadImage,
    limitConcurrency,
    DOWNLOAD_DIR // Export constant if server needs it directly
};