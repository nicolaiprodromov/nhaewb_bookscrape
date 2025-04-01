// electron_app/server.js
const http = require('http');
const url = require('url');
const fs = require('fs'); // Need fs for reading extraction scripts
const fsp = require('fs').promises; // Need promises version for image check
const path = require('path');

// Import helper functions and modules
const { sendError, sendSuccess } = require('./main_process/server-utils');
const { downloadImage, limitConcurrency, DOWNLOAD_DIR } = require('./main_process/image-downloader');

// --- Load WebView Extraction Scripts ---
const SCRIPT_DIR = path.join(__dirname, 'webview-scripts');
let jsListFetch = '';
let jsBookDetailExtraction = ''; // This script now extracts BOTH specs and prices
try {
    jsListFetch = fs.readFileSync(path.join(SCRIPT_DIR, 'list-extraction.js'), 'utf8');
    // Load the updated detail script
    jsBookDetailExtraction = fs.readFileSync(path.join(SCRIPT_DIR, 'detail-extraction.js'), 'utf8');
    if (!jsListFetch || !jsBookDetailExtraction) throw new Error("One or more scripts are empty.");
    console.log("[HTTP Server] WebView extraction scripts loaded successfully.");
} catch (err) {
    console.error("[HTTP Server FATAL] Failed to load WebView extraction scripts:", err);
    console.error("--> Extraction functionality will be broken!");
    // process.exit(1); // Uncomment to make script loading critical
}


// --- Main Server Logic ---
function startServer(port, webviewMap, config) {
    // Default timeouts from config or fallback values
    const defaultNavTimeoutMs = config?.timeouts?.navigation || 90000;
    const defaultExecTimeoutMs = config?.timeouts?.extraction || 75000; // Default for list/general extraction
    // Use detailExtraction timeout if present, otherwise fallback to general extraction timeout
    const defaultDetailExecTimeoutMs = config?.timeouts?.detailExtraction || defaultExecTimeoutMs;

    console.log(`[HTTP Server] Defaults(ms): Nav=${defaultNavTimeoutMs}, Extract=${defaultExecTimeoutMs}, DetailExtract=${defaultDetailExecTimeoutMs}`);
    const MAX_CONCURRENT_DOWNLOADS = 8; // Keep concurrency limit reasonable
    console.log(`[HTTP Server] Max concurrent image downloads: ${MAX_CONCURRENT_DOWNLOADS}`);

    const server = http.createServer(async (req, res) => {
        // Basic CORS / OPTIONS handling
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS'); // Only GET needed currently
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        if (req.method === 'OPTIONS') {
            res.writeHead(204); // No Content
            res.end();
            return;
        }

        const parsedUrl = url.parse(req.url, true);
        const pathname = parsedUrl.pathname;
        const query = parsedUrl.query;

        // --- Find Target Webview ---
        const targetId = query.id;
        let webviewContents = null;
        if (targetId) {
            webviewContents = webviewMap.get(targetId);
             if (!webviewContents || webviewContents.isDestroyed()) {
                 if (pathname === '/navigate' || pathname === '/execute-fetch' || pathname === '/execute-book-detail-fetch') {
                      console.warn(`[HTTP Server] Request for invalid/destroyed webview ID: "${targetId}" for ${pathname}`);
                      return sendError(res, 404, `Not Found: Webview "${targetId}" is invalid or destroyed.`);
                 }
             }
        } else {
             if (pathname === '/navigate' || pathname === '/execute-fetch' || pathname === '/execute-book-detail-fetch') {
                 console.warn(`[HTTP Server] Missing required "id" parameter for ${pathname}`);
                 return sendError(res, 400, 'Bad Request: Missing "id" query parameter.');
             }
        }


        // --- Endpoint Routing ---

        // --- /navigate ---
        if (pathname === '/navigate' && req.method === 'GET') {
            const navUrlEncoded = query.url;
            const timeoutQuery = parseInt(query.timeout, 10); // Timeout in seconds from query
            const navTimeoutMs = !isNaN(timeoutQuery) ? timeoutQuery * 1000 : defaultNavTimeoutMs;

            if (!navUrlEncoded) return sendError(res, 400, 'Bad Request: Missing "url" query parameter.');

            let navUrlDecoded;
            try { navUrlDecoded = decodeURIComponent(navUrlEncoded); }
            catch (e) { return sendError(res, 400, `Bad Request: Invalid 'url' encoding: ${e.message}`); }

            console.log(`[HTTP Server] Navigating "${targetId}" to: ${navUrlDecoded} (Timeout: ${navTimeoutMs / 1000}s)`);

            let finishListener, failListener, timeoutHandle;
            const cleanupNavListeners = () => {
                if (webviewContents && !webviewContents.isDestroyed()) {
                    if (finishListener) webviewContents.removeListener('did-finish-load', finishListener);
                    if (failListener) webviewContents.removeListener('did-fail-load', failListener);
                }
                if (timeoutHandle) clearTimeout(timeoutHandle);
                finishListener = failListener = timeoutHandle = null;
            };

            try {
                const navigationPromise = new Promise((resolve, reject) => {
                    if (!webviewContents || webviewContents.isDestroyed()) return reject(new Error("Webview destroyed before navigation start."));

                    failListener = (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
                        if (isMainFrame && errorCode !== -3 && (validatedURL === navUrlDecoded || !validatedURL )) {
                            console.error(`[Webview ${targetId}] Navigation failed. Code: ${errorCode}, Desc: "${errorDescription}"`);
                            cleanupNavListeners();
                            reject(new Error(`Navigation failed: ${errorCode} ${errorDescription}`));
                        } else if (isMainFrame && errorCode === -3) {
                             console.warn(`[Webview ${targetId}] Navigation aborted by user or script (-3) for "${validatedURL || navUrlDecoded}".`);
                        }
                    };

                    finishListener = () => {
                        if (webviewContents.isDestroyed()) {
                            console.warn(`[Webview ${targetId}] 'did-finish-load' event received, but webview is destroyed.`);
                             cleanupNavListeners();
                            reject(new Error("Navigation finished, but webview destroyed immediately after."));
                            return;
                        }
                        const finalUrl = webviewContents.getURL();
                        console.log(`[Webview ${targetId}] Navigation finished. Final URL: ${finalUrl}`);
                        cleanupNavListeners();
                        resolve({ success: true, loadedUrl: finalUrl });
                    };

                    webviewContents.on('did-finish-load', finishListener);
                    webviewContents.on('did-fail-load', failListener);

                    try {
                        if (webviewContents.isDestroyed()) throw new Error("Webview destroyed just before loadURL call.");
                        webviewContents.loadURL(navUrlDecoded);
                    } catch (loadError) {
                        console.error(`[Webview ${targetId}] Error calling loadURL:`, loadError);
                        cleanupNavListeners();
                        reject(new Error(`Navigation initiation failed: ${loadError.message}`));
                    }
                });

                const timeoutPromise = new Promise((_, reject) => {
                    timeoutHandle = setTimeout(() => {
                        console.error(`[HTTP Server] Navigation timeout for "${targetId}" after ${navTimeoutMs / 1000}s.`);
                        cleanupNavListeners();
                        reject(new Error(`Navigation timed out (${navTimeoutMs / 1000}s)`));
                    }, navTimeoutMs);
                });

                const result = await Promise.race([navigationPromise, timeoutPromise]);
                console.log(`[HTTP Server] Navigation resolved successfully for "${targetId}".`);
                sendSuccess(res, result);

            } catch (navigationError) {
                console.error(`[HTTP Server] Navigation process failed for "${targetId}":`, navigationError.message);
                 cleanupNavListeners();
                if (!res.headersSent) {
                    sendError(res, 500, `Navigation Process Error: ${navigationError.message}`);
                } else {
                     console.warn(`[HTTP Server] Cannot send navigation error response for "${targetId}", headers already sent.`);
                }
            }
        }

        // --- /execute-fetch (Book List Extraction) ---
        else if (pathname === '/execute-fetch' && req.method === 'GET') {
             if (!jsListFetch) return sendError(res, 500, "Server Configuration Error: List extraction script not loaded.");

            const execTimeoutQuery = parseInt(query.exec_timeout, 10);
            const executionTimeoutMs = !isNaN(execTimeoutQuery) ? execTimeoutQuery * 1000 : defaultExecTimeoutMs;
            const webviewSession = webviewContents.session;
            const currentWebviewUrl = webviewContents.getURL();

            console.log(`[HTTP Server] Executing list fetch script in "${targetId}" (URL: ${currentWebviewUrl}, Timeout: ${executionTimeoutMs / 1000}s)...`);

            let execTimeoutHandle = null;
            try {
                if (webviewContents.isDestroyed()) throw new Error("Webview destroyed before JS execution.");

                const executionPromise = webviewContents.executeJavaScript(jsListFetch, true);

                const execTimeoutPromise = new Promise((_, reject) => {
                    execTimeoutHandle = setTimeout(() => {
                        console.error(`[HTTP Server] List JS execution timed out for "${targetId}" (${executionTimeoutMs / 1000}s).`);
                        reject(new Error(`JS execution timed out (${executionTimeoutMs / 1000}s)`));
                    }, executionTimeoutMs);
                });

                const result = await Promise.race([executionPromise, execTimeoutPromise]);
                clearTimeout(execTimeoutHandle);
                execTimeoutHandle = null;

                if (result && result.success === true) {
                    const booksData = result.data || [];
                    console.log(`[HTTP Server] List JS execution successful for "${targetId}". Found ${booksData.length} items.`);

                    const downloadTasks = [];
                    if (Array.isArray(booksData)) {
                         console.log(`[HTTP Server] Preparing ${booksData.length} image download tasks (Limit: ${MAX_CONCURRENT_DOWNLOADS})...`);
                        for (const book of booksData) {
                            if (book.image_url) {
                                const currentBook = book;
                                const task = async () => {
                                    const localFilename = await downloadImage(currentBook.image_url, currentWebviewUrl, webviewSession);
                                    if (localFilename) {
                                        currentBook.local_image_filename = localFilename;
                                    }
                                    delete currentBook.image_url;
                                };
                                downloadTasks.push(task);
                            } else {
                                delete book.image_url;
                            }
                        }
                        await limitConcurrency(downloadTasks, MAX_CONCURRENT_DOWNLOADS);
                         console.log(`[HTTP Server] Finished image download batch for "${targetId}".`);
                    } else {
                         console.warn(`[HTTP Server] JS result data for "${targetId}" was not an array, skipping image downloads.`);
                    }

                    sendSuccess(res, { success: true, data: booksData });

                } else {
                    const errorMessage = result?.error || 'Unknown JS execution error.';
                    console.error(`[HTTP Server] List JS execution failed in webview "${targetId}": ${errorMessage}`);
                    if (result?.stack) console.error(`[HTTP Server] JS Stack Trace: ${result.stack}`);
                    if (!res.headersSent) sendError(res, 500, `JS Execution Failed: ${errorMessage}`);
                    else console.warn(`[HTTP Server] Cannot send JS execution error response for "${targetId}", headers sent.`);
                }

            } catch (execError) {
                console.error(`[HTTP Server] Error during list JS execution process for "${targetId}":`, execError.message);
                 if (execTimeoutHandle) clearTimeout(execTimeoutHandle);
                 if (!res.headersSent) sendError(res, 500, `JS Execution Process Error: ${execError.message}`);
                 else console.warn(`[HTTP Server] Cannot send JS process error response for "${targetId}", headers sent.`);
            }
        }

        // --- /execute-book-detail-fetch (Now extracts Specs AND Prices) ---
        else if (pathname === '/execute-book-detail-fetch' && req.method === 'GET') {
            if (!jsBookDetailExtraction) return sendError(res, 500, "Server Configuration Error: Detail extraction script not loaded.");

            const detailTimeoutQuery = parseInt(query.exec_timeout, 10);
            const executionTimeoutMs = !isNaN(detailTimeoutQuery) ? detailTimeoutQuery * 1000 : defaultDetailExecTimeoutMs; // Use detail default

            console.log(`[HTTP Server] Executing book detail/price fetch script in "${targetId}" (Timeout: ${executionTimeoutMs / 1000}s)...`);

            let detailExecTimeoutHandle = null;
            try {
                if (webviewContents.isDestroyed()) throw new Error("Webview destroyed before detail JS execution.");

                const detailExecPromise = webviewContents.executeJavaScript(jsBookDetailExtraction, true); // true = user gesture

                const detailTimeoutPromise = new Promise((_, reject) => {
                    detailExecTimeoutHandle = setTimeout(() => {
                        console.error(`[HTTP Server] Detail/Price JS execution timed out for "${targetId}" (${executionTimeoutMs / 1000}s).`);
                        reject(new Error(`Detail/Price JS execution timed out (${executionTimeoutMs / 1000}s)`));
                    }, executionTimeoutMs);
                });

                const result = await Promise.race([detailExecPromise, detailTimeoutPromise]);
                clearTimeout(detailExecTimeoutHandle);
                detailExecTimeoutHandle = null;

                if (result && result.success === true && result.data) {
                    // **MODIFICATION:** Extract both specs and prices from the result.data
                    const extractedSpecs = result.data.specs || {};
                    const extractedPrices = result.data.prices || {};
                    console.log(`[HTTP Server] Detail/Price JS successful for "${targetId}". Prices:`, extractedPrices);
                    // Send back BOTH specs and prices
                    sendSuccess(res, {
                        success: true,
                        details: extractedSpecs, // Keep 'details' key for specs cache compatibility
                        prices: extractedPrices // Add 'prices' key for price tracking
                    });
                } else {
                    const errorMessage = result?.error || 'Unknown detail/price JS execution error.';
                    console.error(`[HTTP Server] Detail/Price JS execution failed in webview "${targetId}": ${errorMessage}`);
                    if (result?.stack) console.error(`[HTTP Server] Detail/Price JS Stack: ${result.stack}`);
                    if (!res.headersSent) sendError(res, 500, `Detail/Price JS Execution Failed: ${errorMessage}`);
                    else console.warn(`[HTTP Server] Cannot send detail/price JS error response for "${targetId}", headers sent.`);
                }
            } catch (detailExecError) {
                console.error(`[HTTP Server] Error during detail/price JS execution process for "${targetId}":`, detailExecError.message);
                if (detailExecTimeoutHandle) clearTimeout(detailExecTimeoutHandle);
                if (!res.headersSent) sendError(res, 500, `Detail/Price JS Execution Process Error: ${detailExecError.message}`);
                else console.warn(`[HTTP Server] Cannot send detail/price JS process error response for "${targetId}", headers sent.`);
            }
        }

        // --- /local-image ---
         else if (pathname === '/local-image' && req.method === 'GET') {
             const filename = query.filename;
             if (!filename) return sendError(res, 400, "Missing 'filename' query parameter.");
             if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
                 return sendError(res, 400, "Invalid characters in filename.");
             }
             try {
                 const imagePath = path.join(DOWNLOAD_DIR, filename);
                 await fsp.access(imagePath, fs.constants.R_OK);
                 res.setHeader('Cache-Control', 'public, max-age=604800');
                 res.writeHead(200);
                 fs.createReadStream(imagePath).pipe(res);
             } catch (err) {
                 if (err.code === 'ENOENT') {
                      console.warn(`[HTTP Server] Local image not found: ${filename}`);
                      sendError(res, 404, "Image not found.");
                 } else {
                     console.error(`[HTTP Server] Error accessing or serving image ${filename}:`, err);
                     sendError(res, 500, "Internal server error serving image.");
                 }
             }
         }

        // --- Unknown Endpoint ---
        else {
            console.warn(`[HTTP Server] Unknown endpoint requested: ${req.method} ${pathname}`);
            if (!res.headersSent) sendError(res, 404, `Not Found: ${req.method} ${pathname}`);
            else console.warn("[HTTP Server] Headers already sent, cannot send 404 for unknown endpoint.");
        }
    }); // End http.createServer

    server.listen(port, 'localhost', () => {
        console.log(`[HTTP Server] Bridge server listening on http://localhost:${port}`);
    });

    server.on('error', (err) => {
        console.error('[HTTP Server] Server error:', err);
        if (err.code === 'EADDRINUSE') {
            console.error(`[HTTP Server FATAL] Port ${port} is already in use. Cannot start server.`);
             if (app && typeof app.quit === 'function') {
                 dialog.showErrorBox('Server Error', `Port ${port} is already in use. The application cannot start.`);
                 app.quit();
             }
             process.exit(1);
        }
    });

    return server; // Return the server instance
}

module.exports = { startServer };
