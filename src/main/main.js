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
// config.json is now at the project root
const configPath = path.join(app.getAppPath(), 'config.json'); // More robust path
try {
    config = loadConfig(configPath);
} catch (err) {
    const showErrorAndQuit = () => {
         dialog.showErrorBox('Configuration Error', `Failed to load/parse config (${configPath}).\nError: ${err.message}\n\nApp cannot start.`);
         app.quit();
    }
    // Ensure app is ready before showing dialog
    if (app.isReady()) { showErrorAndQuit(); } else { app.on('ready', showErrorAndQuit); }
    return; // Stop execution if config fails
}

// --- Constants and Global State ---
let mainWindow = null;
const webviewMap = new Map(); // Maps webview ID to its WebContents object

// --- Main Window Creation ---
function createWindow() {
    // preload.js is now in the same directory as main.js
    const preloadScriptPath = path.join(__dirname, 'preload.js'); // Path updated
    const rendererWebPreferences = {
        nodeIntegration: false, contextIsolation: true, webviewTag: true,
        webSecurity: true, // Keep webSecurity enabled
        preload: preloadScriptPath
    };
    console.log('[Main] Creating BrowserWindow with webPreferences:', rendererWebPreferences);
    mainWindow = new BrowserWindow({
        width: 1300, height: 850, webPreferences: rendererWebPreferences, show: false
    });

    const webviewConfigsParam = encodeURIComponent(JSON.stringify(config.webviews));
    // index.html is now in src/renderer/
    const indexHtmlPath = path.join(__dirname, '../renderer/index.html'); // Path updated
    console.log(`[Main] Loading index.html from: ${indexHtmlPath}`);
    mainWindow.loadFile(indexHtmlPath, { query: { webviewConfigs: webviewConfigsParam } });

    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
        console.log('[Main] Main window ready.');
        // mainWindow.webContents.openDevTools({ mode: 'detach' }); // Uncomment for debugging
    });

    // --- Webview Event Handling (Association Logic - Remains the same logic) ---
    mainWindow.webContents.on('did-attach-webview', (event, attachedWebContents) => {
        if (!attachedWebContents || attachedWebContents.isDestroyed()) return;
        console.log(`[Main] Webview attached. Initial URL: ${attachedWebContents.getURL()}`);
        const initialUrl = attachedWebContents.getURL();
        let associatedId = null, wvConfig = null;
        try {
            const initialHostname = (initialUrl && !initialUrl.startsWith('about:')) ? new URL(initialUrl).hostname : null;
            if (initialHostname) {
                wvConfig = config.webviews.find(cfg => cfg.initialUrl && new URL(cfg.initialUrl).hostname === initialHostname);
                if (wvConfig) associatedId = wvConfig.id;
            }
        } catch (urlError) { console.warn(`[Main] Error parsing initial webview URL ${initialUrl}: ${urlError.message}`); }

        const associateWebview = (id, wc) => {
            if (!id || !wc || wc.isDestroyed()) return;
            if (webviewMap.has(id)) console.warn(`[Main] Webview ID "${id}" already associated. Overwriting.`);
            webviewMap.set(id, wc); console.log(`[Main] Associated WebContents ID: "${id}"`);
            wc.once('destroyed', () => { console.log(`[Webview ${id}] Destroyed.`); if (webviewMap.get(id) === wc) webviewMap.delete(id); });
            wc.on('crashed', (e, killed) => { console.error(`[Webview ${id}] CRASHED! Killed: ${killed}`); if (webviewMap.get(id) === wc) webviewMap.delete(id); });
            wc.on('did-fail-load', (e, code, desc, url, isMainFrame) => { if (isMainFrame && code !== -3) console.error(`[Webview ${id}] Failed Load. Code: ${code}, Desc: ${desc}, URL: ${url}`); });
        };

        if (associatedId) { associateWebview(associatedId, attachedWebContents); }
        else {
            console.log("[Main] No initial hostname match, waiting for dom-ready to associate...");
            attachedWebContents.once('dom-ready', () => {
                if (!attachedWebContents || attachedWebContents.isDestroyed()) return;
                const finalUrl = attachedWebContents.getURL(); console.log(`[Main] Webview dom-ready. Final URL: ${finalUrl}`);
                let finalAssociatedId = null;
                try {
                    const finalHostname = (finalUrl && !finalUrl.startsWith('about:')) ? new URL(finalUrl).hostname : null;
                    if (finalHostname) {
                        const finalWvConfig = config.webviews.find(cfg => cfg.initialUrl && new URL(cfg.initialUrl).hostname === finalHostname);
                        if (finalWvConfig) finalAssociatedId = finalWvConfig.id;
                    }
                } catch (urlError) { console.warn(`[Main] Error parsing final webview URL ${finalUrl}: ${urlError.message}`); }
                if (finalAssociatedId) associateWebview(finalAssociatedId, attachedWebContents);
                else console.error(`[Main] ERROR: Could not associate webview. Final URL: ${finalUrl}`);
            });
        }
    }); // end did-attach-webview

    mainWindow.on('closed', () => { console.log('[Main] Main window closed.'); mainWindow = null; });
}

// --- App Lifecycle Events ---
app.whenReady().then(async () => {
    console.log('[Main] App is ready.');
    try {
        setupDownloadDir(); // This function now returns the path, but we use the imported DOWNLOAD_DIR constant
    } catch (dirError) {
        dialog.showErrorBox('Startup Error', `Failed image dir setup: ${dirError.message}`);
        app.quit();
        return;
    }

    // --- Custom Protocol for Local Images ---
    // Note: DOWNLOAD_DIR is imported from image-downloader.js, which calculates the correct path
    protocol.registerFileProtocol('localimg', (request, callback) => {
        try {
            const url = request.url.substring('localimg://'.length);
            const decodedUrl = decodeURI(url); // Decode potential URI encoding
            const filePath = path.join(DOWNLOAD_DIR, path.normalize(decodedUrl)); // Use imported DOWNLOAD_DIR

            // Security: Ensure the path is within the DOWNLOAD_DIR
            if (!filePath.startsWith(path.normalize(DOWNLOAD_DIR))) {
                 console.error(`[Protocol] Forbidden path request: ${filePath}`);
                 // Use a more specific error code if available, otherwise -6 (FILE_NOT_FOUND) is okay
                 return callback({ error: -10 /* net::ERR_ACCESS_DENIED */ });
            }

            fs.access(filePath, fs.constants.R_OK, (err) => {
                if (err) {
                    console.error(`[Protocol] Image not found or unreadable: ${filePath}`, err);
                    return callback({ error: -6 }); // File not found
                }
                return callback({ path: filePath });
            });
        } catch (error) {
            console.error(`[Protocol] Error processing localimg request ${request.url}:`, error);
            return callback({ error: -2 }); // Generic failure
        }
    });
    console.log(`[Main] 'localimg://' protocol registered for directory: ${DOWNLOAD_DIR}`);

    // --- Content Security Policy (Updated) ---
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
        let csp = "default-src 'self';";
        csp += " script-src 'self' https://unpkg.com;"; // Keep player scripts
        csp += " style-src 'self' 'unsafe-inline';"; // Allow inline styles if needed
        csp += " font-src 'self';"; // Assumes fonts are served from the app itself
        csp += " img-src 'self' data: localimg:;"; // Allow self, data:, and custom protocol
        csp += " connect-src 'self' https://lottie.host;"; // Keep Lottie host
        callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] } });
    });
    console.log('[Main] Session CSP Header modification registered (localimg included).');

    // --- Initialize Controller & Setup IPC ---
    webviewController.initialize(webviewMap, config); // Initialize with map and config
    setupIpcHandlers(webviewController); // Pass controller to handlers

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