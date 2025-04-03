// src/main/webview-controller.js
const fs = require('fs');
const path = require('path');
// Use imported function and constant
const { downloadImage, limitConcurrency, DOWNLOAD_DIR } = require('./image-downloader'); // Path Updated
const { URL } = require('url');

// --- Load WebView Extraction Scripts ---
// Scripts are now in src/webview-scripts
const SCRIPT_DIR = path.join(__dirname, '../webview-scripts'); // Path Updated
let jsListFetch = '';
let jsBookDetailExtraction = '';
try {
    jsListFetch = fs.readFileSync(path.join(SCRIPT_DIR, 'list-extraction.js'), 'utf8');
    jsBookDetailExtraction = fs.readFileSync(path.join(SCRIPT_DIR, 'detail-extraction.js'), 'utf8');
    if (!jsListFetch || !jsBookDetailExtraction) throw new Error("One or more scripts are empty.");
    console.log("[WebviewCtrl] Extraction scripts loaded.");
} catch (err) {
    console.error("[WebviewCtrl FATAL] Failed to load extraction scripts:", err);
    // Provide dummy scripts that return errors if loading fails
    jsListFetch = '(() => ({ success: false, error: "List extraction script failed to load in main process." }))()';
    jsBookDetailExtraction = '(() => ({ success: false, error: "Detail extraction script failed to load in main process." }))()';
}

let webviewMapRef = null;
let configRef = null;

function initialize(map, config) {
    webviewMapRef = map;
    configRef = config;
    console.log('[WebviewCtrl] Initialized with webview map and config.');
}

/** Gets the webview instance, checking if it's valid */
function getValidWebview(webviewId) {
    if (!webviewMapRef) {
        console.error("[WebviewCtrl] Error: webviewMapRef not initialized.");
        throw new Error("Webview Controller not initialized.");
    }
    const wc = webviewMapRef.get(webviewId);
    if (!wc || wc.isDestroyed()) {
        console.error(`[WebviewCtrl] Error: Webview "${webviewId}" not found or destroyed.`);
        // Attempt to find *any* valid webview as a fallback? Risky.
        // const fallbackWc = Array.from(webviewMapRef.values()).find(w => w && !w.isDestroyed());
        // if (fallbackWc) {
        //     console.warn(`[WebviewCtrl] Warning: Using fallback webview as "${webviewId}" is unavailable.`);
        //     return fallbackWc;
        // }
        throw new Error(`Webview "${webviewId}" is unavailable.`);
    }
    return wc;
}

/** Navigates a webview and waits for it to finish loading */
async function navigateWebview(webviewId, targetUrl) {
    const wc = getValidWebview(webviewId); // Throws if invalid
    const timeoutMs = configRef?.timeouts?.navigation || 90000;
    console.log(`[WebviewCtrl] Navigating "${webviewId}" to: ${targetUrl.substring(0,100)}... (Timeout: ${timeoutMs / 1000}s)`);

    let finishListener, failListener, crashListener, destroyListener, timeoutHandle;
    const cleanupListeners = () => {
        try {
             if (wc && !wc.isDestroyed()) {
                 if (finishListener) wc.removeListener('did-finish-load', finishListener);
                 if (failListener) wc.removeListener('did-fail-load', failListener);
                 if (crashListener) wc.removeListener('crashed', crashListener);
                 if (destroyListener) wc.removeListener('destroyed', destroyListener);
             }
        } catch (e) { console.warn(`[WebviewCtrl] Error during listener cleanup for ${webviewId}: ${e.message}`); }
        if (timeoutHandle) clearTimeout(timeoutHandle);
        finishListener = failListener = crashListener = destroyListener = timeoutHandle = null;
    };

    try {
        const navigationPromise = new Promise((resolve, reject) => {
             if (wc.isDestroyed()) return reject(new Error("Webview destroyed before navigation listener setup."));

            failListener = (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
                // Ignore sub-frame errors or user aborts (-3)
                if (isMainFrame && errorCode !== -3 /* ABORTED */) {
                     cleanupListeners();
                     reject(new Error(`Navigation failed (${errorCode}): ${errorDescription} for ${validatedURL}`));
                } else if (isMainFrame && errorCode === -3) {
                     console.warn(`[Webview ${webviewId}] Navigation aborted (-3) for "${validatedURL || targetUrl}". Still waiting for potential success or timeout.`);
                     // Don't reject on user abort, let timeout handle it if needed
                }
            };

            finishListener = () => {
                 if (wc.isDestroyed()) {
                     cleanupListeners(); // Ensure cleanup even if destroyed after event fires
                     reject(new Error("Webview destroyed immediately after did-finish-load."));
                     return;
                 }
                 // Small delay to ensure URL is updated reliably after finish-load
                 setTimeout(() => {
                     if (wc.isDestroyed()) {
                         cleanupListeners();
                         reject(new Error("Webview destroyed shortly after did-finish-load."));
                         return;
                     }
                     cleanupListeners();
                     resolve({ success: true, loadedUrl: wc.getURL() });
                 }, 50); // 50ms delay, adjust if needed
            };

             crashListener = (event, killed) => {
                 cleanupListeners();
                 reject(new Error(`Webview crashed during navigation (killed: ${killed})`));
             };

             destroyListener = () => {
                 cleanupListeners();
                 reject(new Error("Webview destroyed during navigation"));
             };

            wc.once('did-finish-load', finishListener); // Use once? If redirects happen, 'on' might be better but riskier
            wc.on('did-fail-load', failListener);
            wc.once('crashed', crashListener);
            wc.once('destroyed', destroyListener);

            // Initiate navigation
            wc.loadURL(targetUrl);
        });

        const timeoutPromise = new Promise((_, reject) => {
            timeoutHandle = setTimeout(() => {
                 cleanupListeners();
                 reject(new Error(`Navigation timed out after ${timeoutMs / 1000}s`));
            }, timeoutMs);
        });

        // Wait for navigation success or timeout/failure
        const result = await Promise.race([navigationPromise, timeoutPromise]);

        // Check final URL if needed (e.g., against redirects)
        // if (result.loadedUrl !== targetUrl) { console.warn(`[WebviewCtrl] Navigation ended at different URL: ${result.loadedUrl}`); }

        console.log(`[WebviewCtrl] Navigation finished for "${webviewId}".`);
        return result;

    } catch (error) {
        console.error(`[WebviewCtrl] Navigation process error for "${webviewId}" to ${targetUrl.substring(0,100)}...:`, error.message);
        cleanupListeners(); // Ensure cleanup on errors thrown within the try block
        throw error; // Re-throw for the calling function (e.g., IPC handler)
    }
}


/** Executes JS in a webview with timeout */
async function executeJavaScript(webviewId, script, timeoutKey) {
    const wc = getValidWebview(webviewId); // Throws if invalid
    const defaultTimeout = configRef?.timeouts?.[timeoutKey] || 75000;
    console.log(`[WebviewCtrl] Executing JS in "${webviewId}" (Timeout Key: ${timeoutKey}, ${defaultTimeout / 1000}s)`);

    let execTimeoutHandle = null;
    try {
        const executionPromise = wc.executeJavaScript(script, true); // true = user gesture might be needed by some sites

        const timeoutPromise = new Promise((_, reject) => {
            execTimeoutHandle = setTimeout(() => {
                reject(new Error(`JS execution (${timeoutKey}) timed out after ${defaultTimeout / 1000}s`));
            }, defaultTimeout);
        });

        // Wait for script execution or timeout
        const result = await Promise.race([executionPromise, timeoutPromise]);

        // If we reached here, execution completed before timeout
        clearTimeout(execTimeoutHandle);
        execTimeoutHandle = null; // Clear handle

        // Basic check on the result structure expected from our scripts
        if (typeof result !== 'object' || result === null || typeof result.success !== 'boolean') {
             console.error('[WebviewCtrl] Warning: JS execution result has unexpected format:', result);
             throw new Error(`JS execution (${timeoutKey}) returned invalid format.`);
        }

        return result; // Return the direct result from executeJavaScript

    } catch (error) {
        console.error(`[WebviewCtrl] Error during JS execution process for "${webviewId}" (${timeoutKey}):`, error.message);
        if (execTimeoutHandle) clearTimeout(execTimeoutHandle); // Ensure timeout is cleared on error too
        // Consider if webview is still usable or should be marked as failed
        throw error; // Re-throw for the calling function
    }
}


/** Fetches list data: navigates (if URL provided), waits, executes script, downloads images */
async function fetchListData(webviewId, pageUrl) {
    try {
        await navigateWebview(webviewId, pageUrl);

        const postNavDelay = configRef?.timeouts?.postNavigationDelay || 1500;
        if (postNavDelay > 0) {
            console.log(`[WebviewCtrl] Waiting ${postNavDelay}ms post-navigation delay...`);
            await new Promise(resolve => setTimeout(resolve, postNavDelay));
        }

        console.log(`[WebviewCtrl] Executing list extraction script for ${pageUrl.substring(0,100)}...`);
        const result = await executeJavaScript(webviewId, jsListFetch, 'listExtraction');

        if (result.success !== true) {
            const errorMsg = result?.error || 'List JS execution failed or returned unsuccessful status.';
            console.error(`[WebviewCtrl] List extraction failed in "${webviewId}": ${errorMsg}`);
            if(result?.stack) console.error(`[WebviewCtrl] List JS Stack Trace: ${result.stack}`);
            throw new Error(`List Extraction Script Failed: ${errorMsg}`);
        }

        const booksData = result.data || [];
        console.log(`[WebviewCtrl] List JS successful for "${webviewId}". Found ${booksData.length} items.`);

        // --- Image Downloading ---
        if (Array.isArray(booksData) && booksData.length > 0) {
            const wc = getValidWebview(webviewId); // Get WC again for session/URL
            const webviewSession = wc.session;
            const currentWebviewUrl = wc.getURL(); // Use final URL as referer
            const maxConcurrent = configRef?.imageDownloadConcurrency || 8;

            console.log(`[WebviewCtrl] Starting image download batch (${booksData.length} potential images, concurrency limit ${maxConcurrent})...`);
            const downloadTasks = booksData
                .filter(book => book && book.image_url) // Ensure book and image_url exist
                .map(book => async () => { // Wrap task in async func for limitConcurrency
                    try {
                         const localFilename = await downloadImage(book.image_url, currentWebviewUrl, webviewSession);
                         if (localFilename) book.local_image_filename = localFilename;
                         // console.debug(`Image processed for ${book.title || 'book'}: ${localFilename || 'failed/skipped'}`);
                    } catch (downloadError) {
                         console.error(`[WebviewCtrl] Error downloading image ${book.image_url} for "${book.title || 'book'}":`, downloadError);
                    } finally {
                         delete book.image_url; // Remove original URL after processing attempt
                    }
                });

            await limitConcurrency(downloadTasks, maxConcurrent);
            console.log(`[WebviewCtrl] Finished image download batch for "${webviewId}".`);
        } else if (Array.isArray(booksData)) {
            console.log(`[WebviewCtrl] List JS returned 0 items for "${webviewId}", skipping image downloads.`);
        } else {
             console.warn(`[WebviewCtrl] List JS result data for "${webviewId}" was not an array, skipping image downloads.`);
        }

        return { success: true, data: booksData }; // Return final data with local filenames

    } catch (error) {
        console.error(`[WebviewCtrl] Overall error in fetchListData for "${webviewId}" URL ${pageUrl.substring(0,100)}...:`, error.message);
        return { success: false, error: error.message }; // Return error structure
    }
}


/** Fetches detail/price data: navigates, waits, executes script */
async function fetchDetailData(webviewId, bookUrl) {
     try {
        await navigateWebview(webviewId, bookUrl);

        const postNavDelay = configRef?.timeouts?.postNavigationDelay || 1500;
        if (postNavDelay > 0) {
            console.log(`[WebviewCtrl] Waiting ${postNavDelay}ms post-navigation delay...`);
            await new Promise(resolve => setTimeout(resolve, postNavDelay));
        }

        console.log(`[WebviewCtrl] Executing detail extraction script for ${bookUrl.substring(0,100)}...`);
        const result = await executeJavaScript(webviewId, jsBookDetailExtraction, 'detailExtraction');

        if (result.success !== true) {
             const errorMsg = result?.error || 'Detail JS execution failed or returned unsuccessful status.';
             console.error(`[WebviewCtrl] Detail extraction failed in "${webviewId}": ${errorMsg}`);
             if(result?.stack) console.error(`[WebviewCtrl] Detail JS Stack Trace: ${result.stack}`);
             throw new Error(`Detail Extraction Script Failed: ${errorMsg}`);
        }

        const extractedData = result.data || {};
        console.log(`[WebviewCtrl] Detail JS successful for "${webviewId}".`);
        // Expected structure: { specs: {...}, prices: {...} }
        return {
            success: true,
            details: extractedData.specs || {}, // Return empty object if missing
            prices: extractedData.prices || {}   // Return empty object if missing
        };

    } catch (error) {
        console.error(`[WebviewCtrl] Overall error in fetchDetailData for "${webviewId}" URL ${bookUrl.substring(0,100)}...:`, error.message);
        return { success: false, error: error.message }; // Return error structure
    }
}


module.exports = {
    initialize,
    fetchListData,
    fetchDetailData
};