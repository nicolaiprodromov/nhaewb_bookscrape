// electron_app/main_process/webview-controller.js
const fs = require('fs');
const path = require('path');
const { downloadImage, limitConcurrency } = require('./image-downloader');
const { URL } = require('url'); // For URL manipulation

// --- Load WebView Extraction Scripts ---
const SCRIPT_DIR = path.join(__dirname, '..', 'webview-scripts');
let jsListFetch = '';
let jsBookDetailExtraction = '';
try {
    jsListFetch = fs.readFileSync(path.join(SCRIPT_DIR, 'list-extraction.js'), 'utf8');
    jsBookDetailExtraction = fs.readFileSync(path.join(SCRIPT_DIR, 'detail-extraction.js'), 'utf8');
    if (!jsListFetch || !jsBookDetailExtraction) throw new Error("One or more scripts are empty.");
    console.log("[WebviewCtrl] Extraction scripts loaded.");
} catch (err) {
    console.error("[WebviewCtrl FATAL] Failed to load extraction scripts:", err);
    // This is critical, maybe throw? Or allow app to run degraded?
    jsListFetch = '(() => ({ success: false, error: "List script load failed" }))()';
    jsBookDetailExtraction = '(() => ({ success: false, error: "Detail script load failed" }))()';
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
        throw new Error(`Webview "${webviewId}" is unavailable.`);
    }
    return wc;
}

/** Navigates a webview and waits for it to finish loading */
async function navigateWebview(webviewId, targetUrl) {
    const wc = getValidWebview(webviewId);
    const timeoutMs = configRef?.timeouts?.navigation || 90000;
    console.log(`[WebviewCtrl] Navigating "${webviewId}" to: ${targetUrl} (Timeout: ${timeoutMs / 1000}s)`);

    let finishListener, failListener, timeoutHandle;
    const cleanupListeners = () => {
        try { // Add try-catch as wc might become invalid during cleanup
             if (wc && !wc.isDestroyed()) {
                 if (finishListener) wc.removeListener('did-finish-load', finishListener);
                 if (failListener) wc.removeListener('did-fail-load', failListener);
             }
        } catch (e) { console.warn(`[WebviewCtrl] Error during listener cleanup for ${webviewId}: ${e.message}`); }
        if (timeoutHandle) clearTimeout(timeoutHandle);
        finishListener = failListener = timeoutHandle = null;
    };

    try {
        const navigationPromise = new Promise((resolve, reject) => {
             if (wc.isDestroyed()) return reject(new Error("Webview destroyed before navigation listener setup."));

            failListener = (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
                if (isMainFrame && errorCode !== -3 && validatedURL === targetUrl) {
                     cleanupListeners();
                     reject(new Error(`Navigation failed: ${errorCode} ${errorDescription}`));
                } else if (isMainFrame && errorCode === -3) {
                     console.warn(`[Webview ${webviewId}] Navigation aborted (-3) for "${validatedURL || targetUrl}".`);
                     // Don't reject on user abort, but don't resolve either until timeout or success
                }
            };
            finishListener = () => {
                 if (wc.isDestroyed()) {
                     cleanupListeners();
                     reject(new Error("Webview destroyed after did-finish-load."));
                     return;
                 }
                 cleanupListeners();
                 resolve({ success: true, loadedUrl: wc.getURL() });
            };
            wc.on('did-finish-load', finishListener);
            wc.on('did-fail-load', failListener);
            wc.loadURL(targetUrl);
        });

        const timeoutPromise = new Promise((_, reject) => {
            timeoutHandle = setTimeout(() => {
                 cleanupListeners();
                 reject(new Error(`Navigation timed out (${timeoutMs / 1000}s)`));
            }, timeoutMs);
        });

        const result = await Promise.race([navigationPromise, timeoutPromise]);
        console.log(`[WebviewCtrl] Navigation finished for "${webviewId}". Final URL: ${result.loadedUrl}`);
        return result;
    } catch (error) {
        console.error(`[WebviewCtrl] Navigation process error for "${webviewId}" to ${targetUrl}:`, error.message);
        cleanupListeners();
        throw error; // Re-throw for IPC handler
    }
}

/** Executes JS in a webview with timeout */
async function executeJavaScript(webviewId, script, timeoutKey) {
    const wc = getValidWebview(webviewId);
    const defaultTimeout = configRef?.timeouts?.[timeoutKey] || 75000;
    console.log(`[WebviewCtrl] Executing JS in "${webviewId}" (Timeout Key: ${timeoutKey}, ${defaultTimeout / 1000}s)`);

    let execTimeoutHandle = null;
    try {
        const executionPromise = wc.executeJavaScript(script, true); // true = user gesture
        const timeoutPromise = new Promise((_, reject) => {
            execTimeoutHandle = setTimeout(() => {
                reject(new Error(`JS execution (${timeoutKey}) timed out (${defaultTimeout / 1000}s)`));
            }, defaultTimeout);
        });
        const result = await Promise.race([executionPromise, timeoutPromise]);
        clearTimeout(execTimeoutHandle);
        return result; // Return the direct result from executeJavaScript
    } catch (error) {
        console.error(`[WebviewCtrl] Error during JS execution process for "${webviewId}" (${timeoutKey}):`, error.message);
        if (execTimeoutHandle) clearTimeout(execTimeoutHandle);
        throw error; // Re-throw for IPC handler
    }
}

/** Fetches list data: navigates (if URL provided), waits, executes script, downloads images */
async function fetchListData(webviewId, pageUrl) {
    try {
        await navigateWebview(webviewId, pageUrl);

        const postNavDelay = configRef?.timeouts?.postNavigationDelay || 1500;
        if (postNavDelay > 0) {
            console.log(`[WebviewCtrl] Waiting ${postNavDelay}ms post-navigation...`);
            await new Promise(resolve => setTimeout(resolve, postNavDelay));
        }

        const result = await executeJavaScript(webviewId, jsListFetch, 'listExtraction');

        if (!result || result.success !== true) {
            const errorMsg = result?.error || 'List JS execution failed or returned unsuccessful.';
            console.error(`[WebviewCtrl] List extraction failed in "${webviewId}": ${errorMsg}`);
            if(result?.stack) console.error(`[WebviewCtrl] List JS Stack: ${result.stack}`);
            throw new Error(`List Extraction Failed: ${errorMsg}`);
        }

        const booksData = result.data || [];
        console.log(`[WebviewCtrl] List JS successful for "${webviewId}". Found ${booksData.length} items.`);

        // --- Image Downloading ---
        if (Array.isArray(booksData) && booksData.length > 0) {
            const wc = getValidWebview(webviewId); // Get WC again for session/URL
            const webviewSession = wc.session;
            const currentWebviewUrl = wc.getURL(); // Referer URL
            const maxConcurrent = configRef?.imageDownloadConcurrency || 8;

            console.log(`[WebviewCtrl] Starting image download batch (${booksData.length} potential images, limit ${maxConcurrent})...`);
            const downloadTasks = booksData
                .filter(book => book && book.image_url)
                .map(book => async () => { // Wrap task in async func for limitConcurrency
                    const localFilename = await downloadImage(book.image_url, currentWebviewUrl, webviewSession);
                    if (localFilename) book.local_image_filename = localFilename;
                    delete book.image_url; // Remove original URL after processing
                });

            await limitConcurrency(downloadTasks, maxConcurrent);
            console.log(`[WebviewCtrl] Finished image download batch for "${webviewId}".`);
        } else {
             console.warn(`[WebviewCtrl] List JS result data for "${webviewId}" was not an array or empty, skipping image downloads.`);
        }

        return { success: true, data: booksData }; // Return final data with local filenames

    } catch (error) {
        console.error(`[WebviewCtrl] Error in fetchListData for "${webviewId}" URL ${pageUrl}:`, error.message);
        return { success: false, error: error.message }; // Return error structure
    }
}

/** Fetches detail/price data: navigates, waits, executes script */
async function fetchDetailData(webviewId, bookUrl) {
     try {
        await navigateWebview(webviewId, bookUrl);

        const postNavDelay = configRef?.timeouts?.postNavigationDelay || 1500;
        if (postNavDelay > 0) {
            console.log(`[WebviewCtrl] Waiting ${postNavDelay}ms post-navigation...`);
            await new Promise(resolve => setTimeout(resolve, postNavDelay));
        }

        const result = await executeJavaScript(webviewId, jsBookDetailExtraction, 'detailExtraction');

        if (!result || result.success !== true) {
             const errorMsg = result?.error || 'Detail JS execution failed or returned unsuccessful.';
             console.error(`[WebviewCtrl] Detail extraction failed in "${webviewId}": ${errorMsg}`);
             if(result?.stack) console.error(`[WebviewCtrl] Detail JS Stack: ${result.stack}`);
             throw new Error(`Detail Extraction Failed: ${errorMsg}`);
        }

        const extractedData = result.data || {};
        console.log(`[WebviewCtrl] Detail JS successful for "${webviewId}".`);
        // Expected structure: { specs: {...}, prices: {...} }
        return {
            success: true,
            details: extractedData.specs || {},
            prices: extractedData.prices || {}
        };

    } catch (error) {
        console.error(`[WebviewCtrl] Error in fetchDetailData for "${webviewId}" URL ${bookUrl}:`, error.message);
        return { success: false, error: error.message }; // Return error structure
    }
}

module.exports = {
    initialize,
    fetchListData,
    fetchDetailData
};
