// src/main/main.js
const { app, BrowserWindow, session, ipcMain, dialog, protocol } = require('electron');
const path = require('path');
const fs = require('fs'); // Need fs for protocol handler
const { loadConfig } = require('./config-loader'); // Path updated
const { setupIpcHandlers } = require('./ipc-handlers'); // Path updated
const { setupDownloadDir, DOWNLOAD_DIR } = require('./image-downloader'); // Path updated
const webviewController = require('./webview-controller'); // Path updated

// --- Configuration Loading ---
let config;
const configPath = path.join(app.getAppPath(), 'config.json');
try {
    config = loadConfig(configPath);
    // Add validation for the new config keys
    if (!config.defaultUserBrowserId || typeof config.defaultUserBrowserId !== 'string') throw new Error("Config missing or invalid 'defaultUserBrowserId'.");
    if (!config.defaultListFetcherId || typeof config.defaultListFetcherId !== 'string') throw new Error("Config missing or invalid 'defaultListFetcherId'.");
    if (!config.defaultDetailFetcherId || typeof config.defaultDetailFetcherId !== 'string') throw new Error("Config missing or invalid 'defaultDetailFetcherId'.");
    const expectedIds = new Set([config.defaultUserBrowserId, config.defaultListFetcherId, config.defaultDetailFetcherId]);
    if (!config.webviews || config.webviews.length < expectedIds.size) throw new Error("Insufficient webview configurations provided.");
    const actualIds = new Set(config.webviews.map(wv => wv.id));
    for (const expectedId of expectedIds) { if (!actualIds.has(expectedId)) throw new Error(`Webview configuration for ID "${expectedId}" not found.`); }

} catch (err) {
    const showErrorAndQuit = () => { dialog.showErrorBox('Configuration Error', `Failed to load/parse/validate config (${configPath}).\nError: ${err.message}\n\nApp cannot start.`); app.quit(); }
    if (app.isReady()) { showErrorAndQuit(); } else { app.on('ready', showErrorAndQuit); }
    return;
}

// --- Constants and Global State ---
let mainWindow = null;
const webviewMap = new Map(); // Will store webContents by their ID

// --- Main Window Creation ---
function createWindow() {
    const preloadScriptPath = path.join(__dirname, 'preload.js');
    const rendererWebPreferences = {
        nodeIntegration: false, contextIsolation: true, webviewTag: true,
        webSecurity: true, preload: preloadScriptPath
        // Removed additionalArguments
    };
    console.log('[Main] Creating BrowserWindow with webPreferences:', rendererWebPreferences);
    mainWindow = new BrowserWindow({
        width: 1300, height: 850, webPreferences: rendererWebPreferences, show: false
    });

    // *** Revert to using query parameters to pass config ***
    const appConfigParam = encodeURIComponent(JSON.stringify(config));
    const indexHtmlPath = path.join(__dirname, '../renderer/index.html');
    console.log(`[Main] Loading index.html from: ${indexHtmlPath}`);
    mainWindow.loadFile(indexHtmlPath, {
        query: { 'app-config': appConfigParam } // Pass config via query
    });

    mainWindow.once('ready-to-show', () => { mainWindow.show(); console.log('[Main] Main window ready.'); /* mainWindow.webContents.openDevTools({ mode: 'detach' }); */ });

    // Simplified webview association logic
    mainWindow.webContents.on('did-attach-webview', (event, attachedWebContents) => {
        if (!attachedWebContents || attachedWebContents.isDestroyed()) return;
        // Find the config based on the initial URL or wait for it
        const tryAssociate = (wc) => {
             if (!wc || wc.isDestroyed()) return;
             const currentUrl = wc.getURL();
             console.log(`[Main] Trying to associate webview with URL: ${currentUrl}`);
             // Match based on initialUrl OR if URL is about:blank and config matches
             const wvConfig = config.webviews.find(cfg => cfg.initialUrl === currentUrl || (currentUrl === 'about:blank' && cfg.initialUrl === 'about:blank'));

             if (wvConfig && wvConfig.id) {
                 const webviewId = wvConfig.id;
                 if (webviewMap.has(webviewId)) {
                     // If it's the detailFetcher which starts as about:blank, allow association even if already present
                     // (Might happen on reload or initial setup races)
                     if (webviewId === config.defaultDetailFetcherId) {
                         console.warn(`[Main] Re-associating Webview ID "${webviewId}".`);
                     } else {
                         console.warn(`[Main] Webview ID "${webviewId}" already associated. Overwriting.`);
                     }
                 }
                 webviewMap.set(webviewId, wc); console.log(`[Main] Associated WebContents ID: "${webviewId}"`);
                 wc.once('destroyed', () => { console.log(`[Webview ${webviewId}] Destroyed.`); if (webviewMap.get(webviewId) === wc) webviewMap.delete(webviewId); });
                 wc.on('crashed', (e, killed) => { console.error(`[Webview ${webviewId}] CRASHED! Killed: ${killed}`); if (webviewMap.get(webviewId) === wc) webviewMap.delete(webviewId); });
                 wc.on('did-fail-load', (e, code, desc, url, isMainFrame) => { if (isMainFrame && code !== -3) console.error(`[Webview ${webviewId}] Failed Load. Code: ${code}, Desc: ${desc}, URL: ${url}`); });
                 return true;
             }
             return false;
        };

        if (!tryAssociate(attachedWebContents)) {
             console.log(`[Main] Initial URL match failed for ${attachedWebContents.getURL()}, waiting for dom-ready...`);
             attachedWebContents.once('dom-ready', () => {
                 if (attachedWebContents && !attachedWebContents.isDestroyed()) {
                     if (!tryAssociate(attachedWebContents)) {
                         console.error(`[Main] ERROR: Could not associate webview after dom-ready. Final URL: ${attachedWebContents.getURL()}`);
                     }
                 }
             });
        }
    });

    mainWindow.on('closed', () => { console.log('[Main] Main window closed.'); mainWindow = null; });
}

// --- App Lifecycle Events ---
app.whenReady().then(async () => {
    console.log('[Main] App is ready.');
    try { setupDownloadDir(); } catch (dirError) { dialog.showErrorBox('Startup Error', `Failed image dir setup: ${dirError.message}`); app.quit(); return; }

    // --- Custom Protocol for Local Images ---
    protocol.registerFileProtocol('localimg', (request, callback) => {
        try {
            const url = request.url.substring('localimg://'.length); const decodedUrl = decodeURI(url);
            const filePath = path.join(DOWNLOAD_DIR, path.normalize(decodedUrl));
            if (!filePath.startsWith(path.normalize(DOWNLOAD_DIR))) { console.error(`[Protocol] Forbidden path request: ${filePath}`); return callback({ error: -10 }); }
            fs.access(filePath, fs.constants.R_OK, (err) => { if (err) { console.error(`[Protocol] Image not found or unreadable: ${filePath}`, err); return callback({ error: -6 }); } return callback({ path: filePath }); });
        } catch (error) { console.error(`[Protocol] Error processing localimg request ${request.url}:`, error); return callback({ error: -2 }); }
    });
    console.log(`[Main] 'localimg://' protocol registered for directory: ${DOWNLOAD_DIR}`);

    // --- Content Security Policy (Updated) ---
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
        let csp = "default-src 'self';";
        csp += " script-src 'self' https://unpkg.com https://cdn.jsdelivr.net https://cdnjs.cloudflare.com;"; // Added Cloudflare for highlight.js
        csp += " style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com;"; // Added Cloudflare for highlight.js CSS. Keep 'unsafe-inline' if absolutely needed by libraries like Chart.js, otherwise try removing it.
        csp += " font-src 'self';";
        csp += " img-src 'self' data: localimg:;";
        csp += " connect-src 'self' https://lottie.host;"; // Lottie host
        // Explicitly allow webview protocols for src (adjust based on actual protocols used)
        // csp += " frame-src 'self' https: http: blob: data: about:;"; // Allow webview sources including about:blank
        callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] } });
    });
    console.log('[Main] Session CSP Header modification registered (unpkg, jsdelivr, cloudflare included).');

    // --- Initialize Controller & Setup IPC ---
    webviewController.initialize(webviewMap, config);
    setupIpcHandlers(webviewController);

    // --- Create Main Window ---
    createWindow();

    // --- macOS Activation ---
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

// --- Window Closing Behavior ---
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('quit', () => { console.log('[Main] Application quitting.'); });

// --- Global Error Handling ---
process.on('uncaughtException', (error, origin) => { console.error(`[Main] UNCAUGHT EXCEPTION (Origin: ${origin}):`, error); try { dialog.showErrorBox('Uncaught Exception', `Error: ${error.message}\nOrigin: ${origin}`); } catch(e){} });
process.on('unhandledRejection', (reason, promise) => { console.error('[Main] UNHANDLED REJECTION:', reason); try { dialog.showErrorBox('Unhandled Rejection', `Reason: ${reason}`); } catch(e){} });
