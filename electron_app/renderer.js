// electron_app/renderer.js
// Handles core Electron integration, webview setup, and initializes UI modules.

// Global constants needed by UI modules
window.PYTHON_BACKEND_URL = 'http://localhost:5000'; // Or read from config if needed client-side

// --- Electron API Check ---
if (typeof window.electronAPI === 'undefined') {
    console.error("FATAL: Preload script ('electronAPI') failed or is missing. IPC bridge broken.");
    // Try to display a critical error message even if UI fails
    document.body.innerHTML = '<div style="padding: 20px; color: red; font-family: sans-serif;"><h1>Critical Error</h1><p>Cannot communicate with the main application process (preload script failed). Please check logs or restart.</p></div>';
    throw new Error("electronAPI not available");
}

// --- Early DOM Element References ---
// Get references to elements needed by various modules *before* initialization
// Keep these minimal, modules can get their own specific elements if needed
window.statusBar = document.getElementById('status-bar');
window.tabContentContainer = document.getElementById('tab-content-container');
window.contentScrollContainer = document.getElementById('content-scroll-container');
window.initialLoader = document.getElementById('initial-loader');
window.infiniteScrollStatus = document.getElementById('infinite-scroll-status');
window.scrollLoader = document.getElementById('scroll-loader');
window.endOfContentMessage = document.getElementById('end-of-content-message');
window.bookSearchInput = document.getElementById('book-search-input');
window.overlay = document.getElementById('overlay');
window.toggleOverlayBtn = document.getElementById('toggle-overlay-btn'); // Reference for the button
// Panel Elements
window.trackerPanel = document.getElementById('tracker-panel');
window.toggleTrackerBtn = document.getElementById('toggle-tracker-btn');
window.cartPanel = document.getElementById('cart-panel');
window.toggleCartBtn = document.getElementById('toggle-cart-btn');
window.rightControls = document.getElementById('right-controls');
window.resizeHandle = document.getElementById('resize-handle');
window.trackerContent = document.getElementById('tracker-content');
window.trackerCategoriesContainer = document.getElementById('tracker-categories-container');
window.addCategoryBtn = document.getElementById('add-category-btn');
window.addStackLottieContainer = document.getElementById('add-stack-lottie-container');
// Details Overlay Elements
window.detailsOverlay = document.getElementById('details-overlay');
window.detailsOverlayContent = document.querySelector('.details-overlay-content');
window.detailsTitle = document.getElementById('details-title');
window.detailsBody = document.getElementById('details-body');
window.detailsCloseBtn = document.querySelector('.details-overlay-close-btn');
// Webview Container
const wvContainer = document.getElementById('webview-container');

// Basic check for essential layout containers and the toggle button
if (!wvContainer || !window.statusBar || !window.tabContentContainer || !window.contentScrollContainer || !window.overlay || !window.toggleOverlayBtn) { // Added toggleOverlayBtn check
     document.body.innerHTML = '<div style="padding: 20px; color: red; font-family: sans-serif;"><h1>Fatal Error</h1><p>Core UI layout elements (including overlay toggle) are missing from index.html. Application cannot start.</p></div>';
    throw new Error("Fatal Error: Core UI layout elements missing.");
}

let webviewReady = false; // Flag: at least one webview finished initial load

try {
    // --- Add Main Overlay Toggle Listener ---
    // Ensure this runs after the elements are found
    window.toggleOverlayBtn.addEventListener('click', () => {
        if (window.overlay) { // Check if overlay element exists
            window.overlay.classList.toggle('hidden');
            const isHidden = window.overlay.classList.contains('hidden');
            window.toggleOverlayBtn.textContent = isHidden ? '🔽' : '👁️'; // Update icon (adjust if needed)
            window.toggleOverlayBtn.title = isHidden ? "Show UI" : "Hide UI"; // Update tooltip
        } else {
            console.error("Cannot toggle overlay: #overlay element not found.");
        }
    });
    console.log("[Renderer] Main overlay toggle listener added.");
    // --- End Add Listener ---


    // --- Webview Creation ---
    const urlParams = new URLSearchParams(window.location.search);
    const webviewConfigsParam = urlParams.get('webviewConfigs');
    let webviewConfigs = [];
    try {
        if (webviewConfigsParam) {
            webviewConfigs = JSON.parse(decodeURIComponent(webviewConfigsParam));
        }
    } catch (e) {
        console.error("[Renderer] Error parsing webview configs from URL:", e);
        window.statusBar.textContent = 'Error: Invalid webview config!';
        throw e; // Re-throw to be caught by outer try/catch
    }

    if (webviewConfigs.length > 0) {
        window.statusBar.textContent = `Loading ${webviewConfigs.length} webview(s)...`;
        webviewConfigs.forEach(cfg => {
            if (!cfg.id || !cfg.initialUrl) {
                console.warn("[Renderer] Skipping invalid webview config entry:", cfg);
                return;
            }
            const wv = document.createElement('webview');
            wv.id = cfg.id;
            wv.src = cfg.initialUrl;
            if (cfg.partition) wv.partition = cfg.partition;
            wv.setAttribute('allowpopups', ''); // Allow popups if needed

            wv.addEventListener('dom-ready', () => {
                console.log(`[Webview] DOM Ready: ${cfg.id}`);
                if (!webviewReady) { // Only trigger UI init on the first webview ready
                    webviewReady = true;
                    window.statusBar.textContent = `Webview Ready: ${cfg.id}`;
                    // Start initialization check (see below)
                }
                // Optional: Add event listener for specific webview if needed
                // wv.addEventListener('console-message', (e) => console.log(`[Webview ${cfg.id} Console] ${e.message}`));
            });

            wv.addEventListener('did-fail-load', (e) => {
                if (e.errorCode !== -3) { // Ignore user abort (-3)
                    console.error(`[Webview] Load Fail: ${cfg.id} Code:${e.errorCode} Desc:${e.errorDescription} URL:${e.validatedURL}`);
                    if (!webviewReady) { // Update status only if initial load failed
                        window.statusBar.textContent = `Error: Webview ${cfg.id} load failed (${e.errorCode}). Check Main logs.`;
                    }
                }
            });

            wv.addEventListener('crashed', (e) => {
                console.error(`[Webview] CRASHED: ${cfg.id}`, e);
                window.statusBar.textContent = `Error: Webview ${cfg.id} CRASHED! Reload recommended.`;
                // Optionally attempt reload or show more prominent error
            });

             // Optional: Listen for IPC messages *from* the webview if needed via preload script in webview
             // wv.addEventListener('ipc-message', (event) => { console.log(`IPC from ${cfg.id}:`, event.channel, event.args); });


            wvContainer.appendChild(wv);
        });
    } else {
        window.statusBar.textContent = 'Error: No webviews configured!';
        throw new Error("No webviews configured.");
    }

    // --- Asynchronous UI Initialization ---
    // Waits for webview readiness and ensures UI modules are loaded.

    let initAttempts = 0;
    const maxInitAttempts = 40; // Wait up to ~20 seconds
    const initCheckInterval = 500; // Check every 500ms

    console.log(`[Renderer] Waiting for webview readiness and UI module loading (max ${maxInitAttempts} checks)...`);

    const checkAndInitialize = setInterval(async () => {
        initAttempts++;

        // *** FIX: Check for modules directly on window ***
        const uiModulesReady =
                               window.AppPanelManager?.initialize &&
                               window.AppTrackerUI?.initialize &&
                               window.AppBookListManager?.initialize &&
                               window.AppDetailsOverlay?.initialize; // Add other critical modules if needed

        if (webviewReady && uiModulesReady) {
            clearInterval(checkAndInitialize);
            console.log("[Renderer] Webview ready and UI modules loaded. Initializing application UI...");
            try {
                // Initialize modules in logical order
                window.AppPanelManager.initialize();
                window.AppDetailsOverlay.initialize();
                // Initialize Tracker UI first (loads saved data)
                await window.AppTrackerUI.initialize();
                // Initialize Book List last (might depend on tracker data for coloring)
                await window.AppBookListManager.initialize();

                console.log("[Renderer] UI Initialization complete.");
                 window.statusBar.textContent = "Application Ready."; // Final ready state

            } catch (initError) {
                 console.error("FATAL: Error during UI module initialization:", initError);
                 window.statusBar.textContent = 'Error: UI Initialization Failed!';
                 if(window.tabContentContainer) window.tabContentContainer.innerHTML = `<p class="error-message">Critical Error: UI components failed to initialize.<br>${initError.message}</p>`;
                 if(window.initialLoader) window.initialLoader.style.display = 'none';
                 if(window.infiniteScrollStatus) window.infiniteScrollStatus.style.display = 'none';
            }

        } else if (initAttempts >= maxInitAttempts) {
            clearInterval(checkAndInitialize);
            const reason = !webviewReady ? "Webview(s) did not become ready." : "UI modules failed to load.";
            console.error(`[Renderer] Initialization timed out after ${initAttempts} attempts. Reason: ${reason}`);
            window.statusBar.textContent = `Error: Initialization Timeout (${reason})`;
            if(window.initialLoader) window.initialLoader.innerHTML = `<p class="error-message">Application failed to initialize (${reason})<br>Check console (Ctrl+Shift+I) & main process logs.</p>`;
             if(window.infiniteScrollStatus) window.infiniteScrollStatus.style.display = 'none';
            // Optionally try a fallback initialization (e.g., tracker only) if desired
            // if (!webviewReady && window.AppTrackerUI?.initialize) {
            //     console.warn("[Renderer] Attempting fallback: Initialize Tracker Panel Only...");
            //     try {
            //         window.AppPanelManager.initialize(); // Init panels anyway
            //         await window.AppTrackerUI.initialize(); // Init tracker
            //         window.statusBar.textContent = "Error: Webview Failed. Tracker initialized.";
            //         if(window.tabContentContainer) window.tabContentContainer.innerHTML = `<p class="error-message">Webviews failed to load. Tracker panel is available.</p>`;
            //     } catch (fallbackError) { console.error("Fallback init failed:", fallbackError); }
            // }
        } else {
             // Still waiting... log progress occasionally
             if (initAttempts % 10 === 0) {
                 console.log(`[Renderer] Still waiting... (Attempt ${initAttempts}/${maxInitAttempts}) WebView Ready: ${webviewReady}, UI Modules: ${!!uiModulesReady}`);
             }
        }
    }, initCheckInterval);

} catch (error) {
    // --- Fatal Error Handling for Core Setup ---
    console.error("Fatal error during initial renderer setup (webview creation or config parsing):", error);
    if (window.statusBar) window.statusBar.textContent = "Fatal Setup Error!";
    if (window.tabContentContainer) window.tabContentContainer.innerHTML = `<p class="error-message">Critical setup error:<br>${error.message}<br>Check console (Ctrl+Shift+I) & main process logs.</p>`;
    // Prevent further UI initialization attempts
    if (window.initialLoader) window.initialLoader.style.display = 'none';
    if (window.infiniteScrollStatus) window.infiniteScrollStatus.style.display = 'none';
}

console.log("[Renderer] Core script executed.");