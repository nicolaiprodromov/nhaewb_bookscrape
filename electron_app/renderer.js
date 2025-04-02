// electron_app/renderer.js
// Handles core Electron integration, webview setup, and initializes UI modules.

// --- Electron API Check ---
if (typeof window.electronAPI === 'undefined') {
    console.error("FATAL: Preload script ('electronAPI') failed. IPC bridge broken.");
    document.body.innerHTML = '<div style="padding:20px;color:red;font-family:sans-serif;"><h1>Critical Error</h1><p>Cannot communicate with the main application process (preload script failed).</p></div>';
    throw new Error("electronAPI not available");
}

// --- Early DOM Element References ---
window.statusBar = document.getElementById('status-bar');
window.tabContentContainer = document.getElementById('tab-content-container');
window.contentScrollContainer = document.getElementById('content-scroll-container');
window.initialLoader = document.getElementById('initial-loader');
window.infiniteScrollStatus = document.getElementById('infinite-scroll-status');
window.scrollLoader = document.getElementById('scroll-loader');
window.endOfContentMessage = document.getElementById('end-of-content-message');
window.bookSearchInput = document.getElementById('book-search-input');
window.overlay = document.getElementById('overlay');
window.toggleOverlayBtn = document.getElementById('toggle-overlay-btn');
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
if (!wvContainer || !window.statusBar || !window.tabContentContainer || !window.contentScrollContainer || !window.overlay || !window.toggleOverlayBtn) {
    document.body.innerHTML = '<div style="padding:20px;color:red;font-family:sans-serif;"><h1>Fatal Error</h1><p>Core UI layout elements (including overlay toggle) missing.</p></div>';
    throw new Error("Fatal Error: Core UI layout elements missing.");
}

// Global state for easy access by modules
window.AppRuntime = {
    webviewConfigs: [],
    primaryWebviewId: null,
    primaryWebviewBaseListUrl: null
};

let webviewReady = false; // Flag: at least one webview finished initial load

try {
    // --- Add Main Overlay Toggle Listener ---
    window.toggleOverlayBtn.addEventListener('click', () => {
        if (window.overlay) {
            window.overlay.classList.toggle('hidden');
            const isHidden = window.overlay.classList.contains('hidden');
            window.toggleOverlayBtn.textContent = isHidden ? 'ðŸ”½' : 'ðŸ‘ ï¸ ';
            window.toggleOverlayBtn.title = isHidden ? "Show UI" : "Hide UI";
        } else { console.error("Cannot toggle overlay: #overlay not found."); }
    });
    console.log("[Renderer] Main overlay toggle listener added.");

    // --- Webview Creation ---
    const urlParams = new URLSearchParams(window.location.search);
    const webviewConfigsParam = urlParams.get('webviewConfigs');
    try {
        if (webviewConfigsParam) window.AppRuntime.webviewConfigs = JSON.parse(decodeURIComponent(webviewConfigsParam));
    } catch (e) {
        console.error("[Renderer] Error parsing webview configs:", e);
        window.statusBar.textContent = 'Error: Invalid webview config!'; throw e;
    }

    if (window.AppRuntime.webviewConfigs.length > 0) {
        window.AppRuntime.primaryWebviewId = window.AppRuntime.webviewConfigs[0].id; // Assume first is primary
        window.AppRuntime.primaryWebviewBaseListUrl = window.AppRuntime.webviewConfigs[0].listDataBaseUrl; // Store base URL
        if (!window.AppRuntime.primaryWebviewBaseListUrl) console.warn(`[Renderer] Warning: listDataBaseUrl not set for primary webview "${window.AppRuntime.primaryWebviewId}" in config.json. List fetching may fail.`);

        window.statusBar.textContent = `Loading ${window.AppRuntime.webviewConfigs.length} webview(s)...`;
        window.AppRuntime.webviewConfigs.forEach(cfg => {
            if (!cfg.id || !cfg.initialUrl) { console.warn("[Renderer] Skipping invalid webview config:", cfg); return; }
            const wv = document.createElement('webview');
            wv.id = cfg.id; wv.src = cfg.initialUrl; if (cfg.partition) wv.partition = cfg.partition; wv.setAttribute('allowpopups', '');
            wv.addEventListener('dom-ready', () => {
                console.log(`[Webview] DOM Ready: ${cfg.id}`);
                if (!webviewReady) {
                    webviewReady = true; window.statusBar.textContent = `Webview Ready: ${cfg.id}`; /* Start init check */
                }
            });
            wv.addEventListener('did-fail-load', (e) => { if (e.errorCode !== -3) { console.error(`[Webview] Load Fail: ${cfg.id} Code:${e.errorCode} Desc:${e.errorDescription} URL:${e.validatedURL}`); if (!webviewReady) window.statusBar.textContent = `Error: Webview ${cfg.id} load failed.`; } });
            wv.addEventListener('crashed', (e) => { console.error(`[Webview] CRASHED: ${cfg.id}`, e); window.statusBar.textContent = `Error: Webview ${cfg.id} CRASHED!`; });
            wvContainer.appendChild(wv);
        });
    } else { window.statusBar.textContent = 'Error: No webviews configured!'; throw new Error("No webviews configured."); }

    // --- Asynchronous UI Initialization ---
    let initAttempts = 0; const maxInitAttempts = 40; const initCheckInterval = 500;
    console.log(`[Renderer] Waiting for webview readiness and UI modules (max ${maxInitAttempts} checks)...`);

    const checkAndInitialize = setInterval(async () => {
        initAttempts++;
        const uiModulesReady = window.AppPanelManager?.initialize && window.AppTrackerUI?.initialize && window.AppBookListManager?.initialize && window.AppDetailsOverlay?.initialize;
        if (webviewReady && uiModulesReady) {
            clearInterval(checkAndInitialize); console.log("[Renderer] Webview ready & modules loaded. Initializing UI...");
            try {
                window.AppPanelManager.initialize();
                window.AppDetailsOverlay.initialize();
                await window.AppTrackerUI.initialize(); // Load tracker data first
                await window.AppBookListManager.initialize(); // Load books last
                console.log("[Renderer] UI Initialization complete."); window.statusBar.textContent = "Application Ready.";
            } catch (initError) {
                console.error("FATAL: Error during UI module initialization:", initError); window.statusBar.textContent = 'Error: UI Init Failed!';
                if(window.tabContentContainer) window.tabContentContainer.innerHTML = `<p class="error-message">Critical Error: UI init failed.<br>${initError.message}</p>`;
                if(window.initialLoader) window.initialLoader.style.display = 'none'; if(window.infiniteScrollStatus) window.infiniteScrollStatus.style.display = 'none';
            }
        } else if (initAttempts >= maxInitAttempts) {
            clearInterval(checkAndInitialize); const reason = !webviewReady ? "Webview(s) not ready." : "UI modules failed load.";
            console.error(`[Renderer] Init timed out. Reason: ${reason}`); window.statusBar.textContent = `Error: Init Timeout (${reason})`;
            if(window.initialLoader) window.initialLoader.innerHTML = `<p class="error-message">App failed to initialize (${reason})</p>`;
            if(window.infiniteScrollStatus) window.infiniteScrollStatus.style.display = 'none';
        } else if (initAttempts % 10 === 0) { console.log(`[Renderer] Waiting... (Attempt ${initAttempts}) WV Ready: ${webviewReady}, UI Modules: ${!!uiModulesReady}`); }
    }, initCheckInterval);

} catch (error) {
    // --- Fatal Error Handling ---
    console.error("Fatal error during initial renderer setup:", error);
    if (window.statusBar) window.statusBar.textContent = "Fatal Setup Error!";
    if (window.tabContentContainer) window.tabContentContainer.innerHTML = `<p class="error-message">Critical setup error:<br>${error.message}</p>`;
    if (window.initialLoader) window.initialLoader.style.display = 'none'; if (window.infiniteScrollStatus) window.infiniteScrollStatus.style.display = 'none';
}

console.log("[Renderer] Core script executed.");
