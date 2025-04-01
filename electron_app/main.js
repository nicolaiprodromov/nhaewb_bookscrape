// electron_app/main.js
const { app, BrowserWindow, session, ipcMain, dialog } = require('electron'); // Added dialog
const path = require('path');
const { loadConfig } = require('./main_process/config-loader');
const { setupIpcHandlers } = require('./main_process/ipc-handlers');
const { setupDownloadDir } = require('./main_process/image-downloader');
const { startServer } = require('./server'); // Server logic still in server.js

// --- Configuration Loading ---
let config;
const configPath = path.join(__dirname, 'config.json');
try {
    config = loadConfig(configPath);
} catch (err) {
    // config-loader already logged the error
    // Show dialog if app is ready, otherwise exit in ready handler
    const showErrorAndQuit = () => {
         dialog.showErrorBox('Configuration Error', `Failed to load or parse configuration file (${configPath}).\nError: ${err.message}\n\nThe application cannot start.`);
         app.quit();
    }
    if (app.isReady()) { showErrorAndQuit(); } else { app.on('ready', showErrorAndQuit); }
    // Prevent further execution if config fails
    return;
}

// --- Constants and Global State ---
let mainWindow = null;
const webviewMap = new Map(); // Maps webview ID to its WebContents object

// --- Main Window Creation ---
function createWindow() {
    const preloadScriptPath = path.join(__dirname, 'preload.js');
    console.log(`[Main] Using preload script: ${preloadScriptPath}`);

    // Define webPreferences WITH PRELOAD
    const rendererWebPreferences = {
        nodeIntegration: false,
        contextIsolation: true,
        webviewTag: true, // Essential for <webview> tag
        webSecurity: false, // Set to true unless absolutely necessary for specific cross-origin webview content
        preload: preloadScriptPath
    };
    if (!rendererWebPreferences.webSecurity) {
        console.warn("[Main] WARNING: webSecurity is disabled in renderer webPreferences. This reduces security.");
    }
    console.log('[Main] Creating BrowserWindow with webPreferences:', rendererWebPreferences);

    mainWindow = new BrowserWindow({
        width: 1300,
        height: 850,
        webPreferences: rendererWebPreferences,
        show: false // Don't show until ready
    });

    // Pass webview configurations to renderer via query parameter
    const webviewConfigsParam = encodeURIComponent(JSON.stringify(config.webviews));
    const indexHtmlPath = path.join(__dirname, 'index.html');
    console.log(`[Main] Loading index.html from: ${indexHtmlPath}`);
    mainWindow.loadFile(indexHtmlPath, { query: { webviewConfigs: webviewConfigsParam } });

    // Gracefully show window when ready
     mainWindow.once('ready-to-show', () => {
         mainWindow.show();
          console.log('[Main] Main window ready and shown.');
          // Open DevTools optionally after showing
          // mainWindow.webContents.openDevTools({ mode: 'detach' });
     });

    // --- Webview Event Handling ---
    mainWindow.webContents.on('did-attach-webview', (event, attachedWebContents) => {
        if (!attachedWebContents || attachedWebContents.isDestroyed()) { return; }
        console.log(`[Main] Webview attached. Initial URL: ${attachedWebContents.getURL()}`);

        // Associate webview with an ID from config based on initial URL hostname
        const initialUrl = attachedWebContents.getURL();
        let associatedId = null;
        let wvConfig = null;

        try {
            // Handle cases where initialUrl might be empty or about:blank
            const initialHostname = (initialUrl && !initialUrl.startsWith('about:')) ? new URL(initialUrl).hostname : null;
             if (initialHostname) {
                wvConfig = config.webviews.find(cfg => {
                    try {
                         // Ensure cfg.initialUrl is valid before creating URL object
                         return cfg.initialUrl && new URL(cfg.initialUrl).hostname === initialHostname;
                    } catch { return false; } // Handle invalid initialUrl in config
                 });
                 if (wvConfig) associatedId = wvConfig.id;
             }
        } catch (urlError) { console.warn(`[Main] Error parsing initial webview URL ${initialUrl}: ${urlError.message}`); }


        const associateWebview = (id, wc) => {
            if (!id || !wc || wc.isDestroyed()) return;
            if (webviewMap.has(id)) {
                 console.warn(`[Main] Webview ID "${id}" already associated. Overwriting.`);
                 // Handle potential cleanup of old WC if necessary? Usually handled by 'destroyed'.
            }
            webviewMap.set(id, wc);
            console.log(`[Main] Associated WebContents ID: "${id}"`);

            // --- Webview Lifecycle Monitoring ---
            wc.once('destroyed', () => {
                 console.log(`[Webview ${id}] Destroyed.`);
                 if (webviewMap.get(id) === wc) webviewMap.delete(id);
            });
            wc.on('crashed', (e, killed) => {
                console.error(`[Webview ${id}] CRASHED! Killed: ${killed}`);
                if (webviewMap.get(id) === wc) webviewMap.delete(id); // Remove crashed webview from map
                // Optionally notify renderer or attempt reload
            });
            wc.on('did-fail-load', (e, code, desc, url, isMainFrame) => {
                // Ignore user abort (-3). Log other main frame errors.
                if (isMainFrame && code !== -3) {
                    console.error(`[Webview ${id}] Failed Load. Code: ${code}, Desc: ${desc}, URL: ${url}`);
                }
            });
             // Optional: Log console messages from webview
             // wc.on('console-message', (e) => console.log(`[Webview ${id} Console Lvl ${e.level}] ${e.message}`));
        };

        if (associatedId) {
            console.log(`[Main] Initial association for attached webview: ${associatedId}`);
            associateWebview(associatedId, attachedWebContents);
        } else {
            // If no initial match, wait for dom-ready to get the final URL
            console.log("[Main] No initial hostname match, waiting for dom-ready to associate...");
            attachedWebContents.once('dom-ready', () => {
                if (!attachedWebContents || attachedWebContents.isDestroyed()) return;
                const finalUrl = attachedWebContents.getURL();
                 console.log(`[Main] Webview dom-ready. Final URL for association check: ${finalUrl}`);
                let finalAssociatedId = null;
                try {
                    // Handle cases where finalUrl might be empty or about:blank
                     const finalHostname = (finalUrl && !finalUrl.startsWith('about:')) ? new URL(finalUrl).hostname : null;
                     if (finalHostname) {
                         const finalWvConfig = config.webviews.find(cfg => {
                             try {
                                 // Ensure cfg.initialUrl is valid
                                 return cfg.initialUrl && new URL(cfg.initialUrl).hostname === finalHostname;
                              }
                             catch { return false; }
                         });
                         if (finalWvConfig) finalAssociatedId = finalWvConfig.id;
                     }
                 } catch (urlError) { console.warn(`[Main] Error parsing final webview URL ${finalUrl}: ${urlError.message}`); }

                if (finalAssociatedId) {
                    associateWebview(finalAssociatedId, attachedWebContents);
                } else {
                    console.error(`[Main] ERROR: Could not associate webview with any config ID. Final URL: ${finalUrl}`);
                    // Decide how to handle unassociated webviews (e.g., destroy, ignore)
                }
            });
        }
    });

    mainWindow.on('closed', () => {
        console.log('[Main] Main window closed.');
        mainWindow = null;
    });
}

// --- App Lifecycle Events ---
app.whenReady().then(async () => {
    console.log('[Main] App is ready.');

     // --- Setup Image Download Directory ---
     try {
         setupDownloadDir(); // Ensure image dir exists before server starts
     } catch (dirError) {
          dialog.showErrorBox('Startup Error', `Failed to create required image directory.\nError: ${dirError.message}\n\nThe application cannot start.`);
          app.quit();
          return; // Prevent further execution
     }


    // --- Content Security Policy ---
    // Apply a stricter CSP. Allows localhost for server/images, lottie host, and unpkg for player.
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
        let csp = "default-src 'self';"; // Default restrictive
        csp += " script-src 'self' https://unpkg.com;"; // Scripts from self and unpkg
        csp += " style-src 'self' 'unsafe-inline';"; // Styles from self, allow inline (check if needed)
        csp += " font-src 'self';"; // Fonts from self
         // Allow images from self, data:, and localhost (both ports: Electron server & Python backend)
        csp += ` img-src 'self' data: http://localhost:${config.electronServerPort} http://localhost:5000;`; // Added Python backend port 5000
         // Allow connections to self, localhost (both ports), and Lottie host
        // *** FIX: Added Python backend port 5000 to connect-src ***
        csp += ` connect-src 'self' http://localhost:${config.electronServerPort} http://localhost:5000 https://lottie.host;`;

        callback({
            responseHeaders: {
                ...details.responseHeaders,
                'Content-Security-Policy': [csp]
            }
        });
    });
    console.log('[Main] Session CSP Header modification registered.');

    // --- Setup IPC Handlers ---
    setupIpcHandlers();

    // --- Create Main Window ---
    createWindow();

    // --- Start HTTP Bridge Server ---
    try {
        startServer(config.electronServerPort, webviewMap, config); // Pass map and config
    } catch (serverError) {
        console.error("[Main] FATAL: Could not start HTTP bridge server:", serverError);
         dialog.showErrorBox('Server Error', `Failed to start the internal HTTP server.\nError: ${serverError.message}\n\nThe application cannot start.`);
        app.quit();
        process.exit(1); // Ensure exit
    }

    // --- macOS Activation ---
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            console.log('[Main] App activated, creating new window.');
            createWindow();
        }
    });
});

// --- Window Closing Behavior ---
app.on('window-all-closed', () => {
    // Quit app on all platforms except macOS (standard behavior)
    if (process.platform !== 'darwin') {
        console.log('[Main] All windows closed, quitting app.');
        app.quit();
    } else {
         console.log('[Main] All windows closed (macOS), app remains active.');
    }
});

// --- App Quit ---
app.on('quit', () => {
    console.log('[Main] Application quitting.');
    // Perform any cleanup here if needed
});

// --- Global Error Handling ---
process.on('uncaughtException', (error, origin) => {
    console.error('[Main] === UNCAUGHT EXCEPTION ===');
    console.error(`[Main] Origin: ${origin}`);
    console.error('[Main] Error:', error);
    console.error('================================');
     // Optionally show dialog and quit on critical errors
      try { // Prevent dialog errors from causing loops
          dialog.showErrorBox('Uncaught Exception', `A critical error occurred: ${error.message}\nOrigin: ${origin}\n\nThe application might need to close.`);
      } catch(e) { console.error("Error showing dialog for uncaughtException:", e); }
     // app.quit(); // Decide if you want to auto-quit on these
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('[Main] === UNHANDLED REJECTION ===');
    console.error('[Main] Reason:', reason);
    // console.error('[Main] Promise:', promise); // Can be verbose
    console.error('================================');
     // Optionally show dialog
      try {
          dialog.showErrorBox('Unhandled Rejection', `An unhandled promise rejection occurred.\nReason: ${reason}`);
      } catch(e) { console.error("Error showing dialog for unhandledRejection:", e); }
});