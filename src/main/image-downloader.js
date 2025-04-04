// src/main/image-downloader.js
const fs = require('fs'); // Use sync for setup
const fsp = require('fs').promises; // Use promises for async operations
const path = require('path');
const crypto = require('crypto');
const { net } = require('electron'); // Use Electron's net module
const { URL } = require('url'); // Ensure URL is required

// Download directory is now in project_root/data/downloaded_images
const DOWNLOAD_DIR = path.join(__dirname, '../../data/downloaded_images'); // Path updated
const VALID_IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp']; // Added list for check

// --- Directory Setup ---
function setupDownloadDir() {
    console.log(`[Image Downloader] Setting up download directory: ${DOWNLOAD_DIR}`);
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
        throw new Error(`Failed to create image download directory: ${mkdirError.message}`);
    }
}

// --- Concurrency Limiter ---
async function limitConcurrency(tasks, limit) {
    const results = []; const executing = [];
    for (const task of tasks) {
        const p = Promise.resolve().then(() => task()).catch(err => {
            console.error('[Concurrency Err] Task failed:', err.message || err); return null;
        });
        results.push(p);
        if (limit > 0 && limit <= tasks.length) {
            const e = p.finally(() => executing.splice(executing.indexOf(e), 1)); executing.push(e);
            if (executing.length >= limit) { await Promise.race(executing); }
        }
    }
    return Promise.all(results);
}


// --- Image Download Function ---
function downloadImage(imageUrl, refererUrl, session) {
    return new Promise(async (resolve) => {
        console.debug(`[DL Debug] Attempting download for URL: ${imageUrl?.substring(0, 150)}...`);

        if (!imageUrl || typeof imageUrl !== 'string') { console.warn('[DL Warn] Invalid Image URL (null or not string):', imageUrl); return resolve(null); }
        if (!imageUrl.startsWith('http:') && !imageUrl.startsWith('https:')) { console.warn('[DL Warn] Invalid Image URL (not HTTP/S):', imageUrl.substring(0, 100)); return resolve(null); }
        if (!session || typeof session !== 'object' || typeof session.protocol !== 'object') { console.warn(`[DL Warn] Invalid session provided for: ${imageUrl.substring(0,100)}`); return resolve(null); }

        let urlObj;
        try { urlObj = new URL(imageUrl); } catch (urlError) { console.warn(`[DL Warn] Invalid Image URL format "${imageUrl.substring(0, 100)}...": ${urlError.message}`); return resolve(null); }

        const hash = crypto.createHash('sha1').update(imageUrl).digest('hex');
        let ext = path.extname(urlObj.pathname).toLowerCase(); // Ensure lowercase for comparison
        if (!VALID_IMAGE_EXTENSIONS.includes(ext)) { ext = '.jpg'; console.debug(`[DL Debug] URL extension "${ext}" invalid or missing, defaulting to .jpg`); } // Use default if extension is weird
        const localFilename = `${hash}${ext}`;
        const localFilepath = path.join(DOWNLOAD_DIR, localFilename);
        console.debug(`[DL Debug] Target local path: ${localFilepath}`);

        try {
            console.debug(`[DL Debug] Checking cache for: ${localFilename}`);
            await fsp.access(localFilepath, fs.constants.R_OK);
            console.log(`[DL Cache] Found readable, resolving with existing: ${localFilename}`);
            return resolve(localFilename);
        } catch (err) {
            console.log(`[DL Cache] Not found or unreadable (${err.code}), proceeding with download for: ${localFilename}`);
        }

        const reqOptions = { url: imageUrl, session: session, useSessionCookies: true };
        const request = net.request(reqOptions);
        let writeStream = null; let responseReceived = false; let cleanupCalled = false;

        const cleanup = (errMessage) => {
             if (cleanupCalled) { console.debug(`[DL Debug Cleanup] Already called for ${localFilename}, skipping.`); return; } cleanupCalled = true;
            if (errMessage) console.error(`[DL Cleanup] Error for ${localFilename}: ${errMessage}`); else console.debug(`[DL Debug Cleanup] Initiated for ${localFilename} (no error message).`);
            request.abort();
            if (writeStream && !writeStream.closed) {
                console.debug(`[DL Debug Cleanup] Closing write stream for ${localFilename}`);
                writeStream.close(() => { if (errMessage) { console.debug(`[DL Debug Cleanup] Attempting unlink of partial file ${localFilename}`); fsp.unlink(localFilepath).catch(unlinkErr => { if (unlinkErr.code !== 'ENOENT') { console.warn(`[DL Cleanup] Failed to delete partial file ${localFilename}: ${unlinkErr.message}`); } else { console.debug(`[DL Debug Cleanup] Partial file ${localFilename} already gone.`); } }); } });
            } else if (errMessage) { console.debug(`[DL Debug Cleanup] Write stream not open/closed. Attempting unlink of potentially empty file ${localFilename}`); fsp.unlink(localFilepath).catch(unlinkErr => { if (unlinkErr.code !== 'ENOENT') { console.warn(`[DL Cleanup] Failed to delete potentially empty file ${localFilename}: ${unlinkErr.message}`); } else { console.debug(`[DL Debug Cleanup] Potentially empty file ${localFilename} already gone.`); } }); }
            resolve(null);
        };

        request.on('response', (response) => {
            responseReceived = true;
            const finalUrl = response.url || imageUrl; // Prefer final URL if redirects occurred
            const contentType = (response.headers['content-type']?.[0] || '').toLowerCase();
            console.log(`[DL Debug Response] Status ${response.statusCode} for URL: ${finalUrl.substring(0, 100)}... Content-Type: ${contentType}`);

            if (response.statusCode >= 200 && response.statusCode < 300) {
                let allowSave = false;
                if (contentType.startsWith('image/')) {
                    allowSave = true; // Standard case
                } else {
                    // --- Relaxed Check ---
                    console.warn(`[DL Warn] Incorrect Content-Type "${contentType}" for ${finalUrl.substring(0, 100)}...`);
                    // Check if the derived file extension is a known image type
                    if (VALID_IMAGE_EXTENSIONS.includes(ext)) {
                        console.warn(`[DL Warn] Allowing download based on extension "${ext}" despite invalid Content-Type.`);
                        allowSave = true;
                    } else {
                        console.error(`[DL Error] Rejecting download: Invalid Content-Type "${contentType}" AND invalid/unknown extension "${ext}" for ${finalUrl.substring(0, 100)}...`);
                    }
                    // --- End Relaxed Check ---
                }

                if (allowSave) {
                    try {
                        console.debug(`[DL Debug Response] Creating write stream for ${localFilepath}`);
                        writeStream = fs.createWriteStream(localFilepath);
                        writeStream.on('finish', () => { console.log(`[DL OK] Saved: ${localFilename}`); resolve(localFilename); });
                        writeStream.on('error', (streamError) => { console.error(`[DL Error Stream] Write Error for ${localFilename}:`, streamError); cleanup(`Stream Write Error: ${streamError.message}`); });
                        response.pipe(writeStream); console.debug(`[DL Debug Response] Piping response to stream for ${localFilename}`);
                    } catch (streamCreateError) { console.error(`[DL Err] Stream Create Error for ${localFilepath}:`, streamCreateError); response.resume(); cleanup(`Stream Creation Error: ${streamCreateError.message}`); }
                } else { // If not allowed to save (bad content-type AND bad extension)
                    response.resume(); cleanup(`Rejected due to invalid Content-Type and extension`);
                }
            } else { // Handle non-2xx status codes
                console.warn(`[DL Warn] Failed status ${response.statusCode} for URL: ${finalUrl.substring(0, 100)}...`);
                response.resume(); cleanup(`HTTP Status ${response.statusCode}`);
            }
        });

        request.on('error', (error) => { console.error(`[DL Error Request] Request Error for ${imageUrl.substring(0, 100)}...: ${error.message}`); if (!responseReceived) { cleanup(`Request Error: ${error.message}`); } });
        request.on('abort', () => { console.debug(`[DL Abort] Request aborted for URL: ${imageUrl.substring(0, 100)}...`); });

        // Set Headers
        request.setHeader('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
        request.setHeader('Accept', 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8');
        request.setHeader('Accept-Language', 'en-US,en;q=0.9');
        if (refererUrl && typeof refererUrl === 'string' && refererUrl.startsWith('http')) { request.setHeader('Referer', refererUrl); }
        request.setHeader('Sec-Fetch-Dest', 'image'); request.setHeader('Sec-Fetch-Mode', 'no-cors'); request.setHeader('Sec-Fetch-Site', 'cross-site');

        try {
            console.debug(`[DL Debug] Starting request.end() for URL: ${imageUrl.substring(0, 100)}...`);
            request.end();
        } catch (endError) { console.error(`[DL Err] req.end() failed for ${imageUrl.substring(0, 100)}...:`, endError); if (!responseReceived) { cleanup(`Request End Error: ${endError.message}`); } }
    });
}

module.exports = {
    setupDownloadDir,
    downloadImage,
    limitConcurrency,
    DOWNLOAD_DIR
};
