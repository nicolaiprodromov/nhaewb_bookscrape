// src/main/image-downloader.js
const fs = require('fs'); // Use sync for setup
const fsp = require('fs').promises; // Use promises for async operations
const path = require('path');
const crypto = require('crypto');
const { net } = require('electron'); // Use Electron's net module
const { URL } = require('url'); // Ensure URL is required

// Download directory is now in project_root/data/downloaded_images
const DOWNLOAD_DIR = path.join(__dirname, '../../data/downloaded_images'); // Path updated

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
        // Wrap task execution in a promise chain
        const p = Promise.resolve().then(() => task()).catch(err => {
            // Log task-specific errors but don't stop other tasks
            console.error('[Concurrency Err] Task failed:', err.message || err);
            return null; // Resolve with null on error
        });
        results.push(p);

        // If concurrency limit is effective
        if (limit > 0 && limit <= tasks.length) {
            // Add promise to executing array and remove it when done (finally)
            const e = p.finally(() => executing.splice(executing.indexOf(e), 1));
            executing.push(e);
            // If executing array is full, wait for one to finish
            if (executing.length >= limit) {
                await Promise.race(executing);
            }
        }
    }
    // Wait for all tasks to complete (or fail individually)
    return Promise.all(results);
}

// --- Image Download Function ---
// Takes session from webview for cookies/auth context
function downloadImage(imageUrl, refererUrl, session) {
    return new Promise(async (resolve) => { // Added async for await fsp.access
        if (!imageUrl || typeof imageUrl !== 'string') {
             console.warn('[DL Warn] Invalid Image URL (null or not string):', imageUrl); return resolve(null);
        }
        // Basic URL check
        if (!imageUrl.startsWith('http:') && !imageUrl.startsWith('https:')) {
             console.warn('[DL Warn] Invalid Image URL (not HTTP/S):', imageUrl.substring(0, 100)); return resolve(null);
        }

        if (!session || typeof session !== 'object' || typeof session.protocol !== 'object') {
             console.warn('[DL Warn] Invalid session provided for:', imageUrl.substring(0,100)); return resolve(null);
        }

        let urlObj;
        try {
            urlObj = new URL(imageUrl);
        } catch (urlError) {
            console.warn(`[DL Warn] Invalid Image URL format "${imageUrl.substring(0, 100)}...": ${urlError.message}`);
            return resolve(null);
        }

        const hash = crypto.createHash('sha1').update(imageUrl).digest('hex');
        // Gracefully handle URLs with no path extension
        let ext = path.extname(urlObj.pathname);
        if (!ext || ext.length > 5 || ext.length < 2) { // Basic sanity check on extension
             ext = '.jpg'; // Default extension
        }
        const localFilename = `${hash}${ext}`;
        const localFilepath = path.join(DOWNLOAD_DIR, localFilename);

        // Check if file exists and is readable before attempting download
        try {
            await fsp.access(localFilepath, fs.constants.R_OK);
            // console.debug(`[DL Cache] Found readable: ${localFilename}`);
            return resolve(localFilename);
        } catch (err) {
            // File doesn't exist or isn't readable, proceed with download
            // console.debug(`[DL Cache] Not found or unreadable, downloading: ${localFilename}`);
        }

        const reqOptions = {
            url: imageUrl,
            session: session,
            useSessionCookies: true,
            // redirect: 'follow' // 'follow' is default, explicit if needed
        };
        const request = net.request(reqOptions);
        let writeStream = null;
        let responseReceived = false; // Flag to prevent cleanup races

        // Ensure cleanup happens only once
        const cleanup = (errMessage) => {
            if (errMessage) console.error(`[DL Cleanup] Error for ${localFilename}: ${errMessage}`);
            request.abort(); // Abort ongoing request if any
            if (writeStream && !writeStream.closed) {
                writeStream.close(() => {
                    // Attempt to delete partially written file on error/abort
                    if (errMessage) {
                        fsp.unlink(localFilepath).catch(unlinkErr => {
                            if (unlinkErr.code !== 'ENOENT') { // Ignore if already gone
                                console.warn(`[DL Cleanup] Failed to delete partial file ${localFilename}: ${unlinkErr.message}`);
                            }
                        });
                    }
                });
            } else if (errMessage) {
                 // If stream never opened but error occurred, still try unlink just in case
                 fsp.unlink(localFilepath).catch(unlinkErr => {
                     if (unlinkErr.code !== 'ENOENT') {
                         console.warn(`[DL Cleanup] Failed to delete potentially empty file ${localFilename}: ${unlinkErr.message}`);
                     }
                 });
            }
            resolve(null); // Always resolve null on error/abort after cleanup
        };

        request.on('response', (response) => {
            responseReceived = true;
            if (response.statusCode >= 200 && response.statusCode < 300) {
                const contentType = response.headers['content-type']?.[0] || ''; // Headers are arrays
                if (!contentType.startsWith('image/')) {
                    console.warn(`[DL Warn] Not an image (${contentType}) URL: ${imageUrl.substring(0, 100)}...`);
                    response.resume(); // Consume data
                    cleanup(`Non-image content type: ${contentType}`);
                    return;
                }

                try {
                    writeStream = fs.createWriteStream(localFilepath);

                    writeStream.on('finish', () => {
                        // console.debug(`[DL OK] Saved: ${localFilename}`);
                        resolve(localFilename); // Resolve with filename on success
                    });
                    writeStream.on('error', (streamError) => {
                        cleanup(`Stream Write Error: ${streamError.message}`);
                    });

                    response.pipe(writeStream);

                } catch (streamCreateError) {
                    console.error(`[DL Err] Stream Create ${localFilepath}:`, streamCreateError);
                    response.resume(); // Consume data if stream failed
                    cleanup(`Stream Creation Error: ${streamCreateError.message}`);
                }

            } else {
                console.warn(`[DL Warn] Failed status ${response.statusCode} for URL: ${imageUrl.substring(0, 100)}...`);
                response.resume(); // Consume data
                cleanup(`HTTP Status ${response.statusCode}`);
            }
        });

        request.on('error', (error) => {
            // This catches fundamental network errors (DNS, connection refused etc.)
            if (!responseReceived) { // Only cleanup if response wasn't handled
                 cleanup(`Request Error: ${error.message}`);
            }
        });

        request.on('abort', () => {
             // console.debug(`[DL Abort] URL: ${imageUrl.substring(0, 100)}...`);
             // Cleanup is usually handled by the code path that called abort
             // or by error/response handlers. Avoid redundant cleanup here.
             // If cleanup hasn't happened, resolve(null) might be needed
             // but typically another event triggers the cleanup.
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
        // Sec-Fetch-Site might vary, 'cross-site' is common for CDNs
        request.setHeader('Sec-Fetch-Site', 'cross-site'); // Or 'same-origin' if applicable

        try {
            // console.debug(`[DL Start] URL: ${imageUrl.substring(0, 100)}...`);
            request.end();
        } catch (endError) {
            console.error(`[DL Err] req.end() ${imageUrl.substring(0, 100)}...:`, endError);
            if (!responseReceived) {
                 cleanup(`Request End Error: ${endError.message}`);
            }
        }
    });
}

module.exports = {
    setupDownloadDir,
    downloadImage,
    limitConcurrency,
    DOWNLOAD_DIR // Export constant for main.js protocol handler
};