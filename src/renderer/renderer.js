// src/renderer/renderer.js
// Handles core Electron integration, webview setup, and initializes UI modules.

// --- Electron API Check ---
if (typeof window.electronAPI === 'undefined') {
    console.error("FATAL: Preload script ('electronAPI') failed. IPC bridge broken.");
    // Simple error message for the user
    document.body.innerHTML = '<div style="padding:20px;color:red;font-family:sans-serif;"><h1>Critical Error</h1><p>Cannot communicate with the main application process (preload script failed). Please restart the application.</p></div>';
    // Throw error to stop further script execution
    throw new Error("electronAPI not available in renderer process. Preload script might have failed.");
} else {
    console.log("[Renderer] electronAPI bridge confirmed.");
}


// --- Early DOM Element References ---
// Using function scope to avoid polluting global scope immediately
function getRequiredElement(id, name) {
    const element = document.getElementById(id);
    if (!element) {
        console.error(`[Renderer Fatal] Required element #${id} (${name}) not found.`);
        throw new Error(`Fatal Error: UI element #${id} (${name}) is missing.`);
    }
    return element;
}

function getOptionalElement(id) {
    return document.getElementById(id);
}

let statusBar, tabContentContainer, contentScrollContainer, initialLoader,
    infiniteScrollStatus, scrollLoader, endOfContentMessage, bookSearchInput,
    overlay, toggleOverlayBtn, trackerPanel, toggleTrackerBtn, cartPanel,
    toggleCartBtn, rightControls, resizeHandle, trackerContent,
    trackerCategoriesContainer, addCategoryBtn, addStackLottieContainer,
    detailsOverlay, detailsOverlayContent, detailsTitle, detailsBody, detailsCloseBtn,
    wvContainer;

try {
    // Assign required elements
    statusBar = getRequiredElement('status-bar', 'Status Bar');
    tabContentContainer = getRequiredElement('tab-content-container', 'Tab Content Container');
    contentScrollContainer = getRequiredElement('content-scroll-container', 'Content Scroll Container');
    initialLoader = getRequiredElement('initial-loader', 'Initial Loader');
    infiniteScrollStatus = getRequiredElement('infinite-scroll-status', 'Infinite Scroll Status');
    scrollLoader = getRequiredElement('scroll-loader', 'Scroll Loader');
    endOfContentMessage = getRequiredElement('end-of-content-message', 'End of Content Message');
    bookSearchInput = getRequiredElement('book-search-input', 'Book Search Input');
    overlay = getRequiredElement('overlay', 'Main Overlay');
    toggleOverlayBtn = getRequiredElement('toggle-overlay-btn', 'Toggle Overlay Button');
    trackerPanel = getRequiredElement('tracker-panel', 'Tracker Panel');
    toggleTrackerBtn = getRequiredElement('toggle-tracker-btn', 'Toggle Tracker Button');
    cartPanel = getRequiredElement('cart-panel', 'Cart Panel');
    toggleCartBtn = getRequiredElement('toggle-cart-btn', 'Toggle Cart Button');
    rightControls = getRequiredElement('right-controls', 'Right Controls');
    resizeHandle = getRequiredElement('resize-handle', 'Resize Handle');
    trackerContent = getRequiredElement('tracker-content', 'Tracker Content');
    trackerCategoriesContainer = getRequiredElement('tracker-categories-container', 'Tracker Categories Container');
    addCategoryBtn = getRequiredElement('add-category-btn', 'Add Category Button');
    addStackLottieContainer = getRequiredElement('add-stack-lottie-container', 'Add Stack Lottie Container');
    detailsOverlay = getRequiredElement('details-overlay', 'Details Overlay');
    wvContainer = getRequiredElement('webview-container', 'Webview Container');

    // Assign optional elements (querySelector might return null)
    detailsOverlayContent = document.querySelector('.details-overlay-content');
    detailsTitle = getOptionalElement('details-title'); // Could be considered required?
    detailsBody = getOptionalElement('details-body');   // Could be considered required?
    detailsCloseBtn = document.querySelector('.details-overlay-close-btn');

    if (!detailsOverlayContent || !detailsTitle || !detailsBody || !detailsCloseBtn) {
        console.warn("[Renderer] Warning: One or more optional details overlay elements not found.");
        // Decide if this is critical - maybe disable details overlay feature?
    }
    console.log("[Renderer] All required DOM elements found.");

    // Make frequently used elements globally accessible (consider a namespace later if needed)
    window.statusBar = statusBar;
    window.tabContentContainer = tabContentContainer;
    window.contentScrollContainer = contentScrollContainer;
    window.initialLoader = initialLoader;
    window.infiniteScrollStatus = infiniteScrollStatus;
    window.scrollLoader = scrollLoader;
    window.endOfContentMessage = endOfContentMessage;
    window.bookSearchInput = bookSearchInput;
    window.overlay = overlay;
    window.toggleOverlayBtn = toggleOverlayBtn;
    window.trackerPanel = trackerPanel;
    window.toggleTrackerBtn = toggleTrackerBtn;
    window.cartPanel = cartPanel;
    window.toggleCartBtn = toggleCartBtn;
    window.rightControls = rightControls;
    window.resizeHandle = resizeHandle;
    window.trackerContent = trackerContent;
    window.trackerCategoriesContainer = trackerCategoriesContainer;
    window.addCategoryBtn = addCategoryBtn;
    window.addStackLottieContainer = addStackLottieContainer;
    window.detailsOverlay = detailsOverlay;
    window.detailsOverlayContent = detailsOverlayContent;
    window.detailsTitle = detailsTitle;
    window.detailsBody = detailsBody;
    window.detailsCloseBtn = detailsCloseBtn;

} catch (error) {
    // Handle missing required elements
    document.body.innerHTML = `<div style="padding:20px;color:red;font-family:sans-serif;"><h1>Fatal Error</h1><p>Core UI layout elements are missing. The application cannot start correctly.</p><p>Error: ${error.message}</p></div>`;
    throw error; // Re-throw to stop execution
}


// Global state for easy access by modules
window.AppRuntime = {
    webviewConfigs: [],
    primaryWebviewId: null,
    primaryWebviewBaseListUrl: null,
    isInitialized: false // Flag to track overall initialization
};

let webviewReady = false; // Flag: at least one webview finished initial load

try {
    // --- Add Main Overlay Toggle Listener ---
    toggleOverlayBtn.addEventListener('click', () => {
        overlay.classList.toggle('hidden');
        const isHidden = overlay.classList.contains('hidden');
        toggleOverlayBtn.textContent = isHidden ? '▶️' : '👁️'; // Update icon based on state
        toggleOverlayBtn.title = isHidden ? "Show UI" : "Hide UI";
    });
    console.log("[Renderer] Main overlay toggle listener added.");

    // --- Webview Creation ---
    const urlParams = new URLSearchParams(window.location.search);
    const webviewConfigsParam = urlParams.get('webviewConfigs');
    try {
        if (webviewConfigsParam) {
            window.AppRuntime.webviewConfigs = JSON.parse(decodeURIComponent(webviewConfigsParam));
            console.log("[Renderer] Parsed webview configs:", window.AppRuntime.webviewConfigs);
        } else {
            console.warn("[Renderer] No webviewConfigs parameter found in URL query.");
        }
    } catch (e) {
        console.error("[Renderer] Error parsing webview configs:", e);
        statusBar.textContent = 'Error: Invalid webview config!'; throw e;
    }

    if (window.AppRuntime.webviewConfigs.length > 0) {
        // Set primary webview details (assuming first one is primary)
        window.AppRuntime.primaryWebviewId = window.AppRuntime.webviewConfigs[0].id;
        window.AppRuntime.primaryWebviewBaseListUrl = window.AppRuntime.webviewConfigs[0].listDataBaseUrl;
        if (!window.AppRuntime.primaryWebviewBaseListUrl) {
            console.warn(`[Renderer] Warning: listDataBaseUrl not set for primary webview "${window.AppRuntime.primaryWebviewId}" in config.json. List fetching may fail.`);
        }
        console.log(`[Renderer] Primary webview set: ID=${window.AppRuntime.primaryWebviewId}, BaseURL=${window.AppRuntime.primaryWebviewBaseListUrl || 'N/A'}`);

        statusBar.textContent = `Loading ${window.AppRuntime.webviewConfigs.length} webview(s)...`;
        window.AppRuntime.webviewConfigs.forEach(cfg => {
            if (!cfg.id || !cfg.initialUrl) {
                console.warn("[Renderer] Skipping invalid webview config (missing id or initialUrl):", cfg);
                return;
            }
            const wv = document.createElement('webview');
            wv.id = cfg.id;
            wv.src = cfg.initialUrl;
            if (cfg.partition) wv.partition = cfg.partition;
            wv.setAttribute('allowpopups', ''); // Allow popups if needed by the site

            // Event Listeners for each webview
            wv.addEventListener('dom-ready', () => {
                console.log(`[Webview] DOM Ready: ${cfg.id} (URL: ${wv.getURL()})`);
                if (!webviewReady) {
                    webviewReady = true; // Mark as ready on the first successful load
                    statusBar.textContent = `Webview Ready: ${cfg.id}`;
                    // Consider triggering initialization checks here if needed earlier
                }
                // Example: Inject utility script or check for specific elements if needed
                // wv.executeJavaScript('console.log("Webview DOM Ready from Renderer");');
            });
            wv.addEventListener('did-fail-load', (e) => {
                // Ignore user aborts (-3)
                if (e.errorCode !== -3) {
                    console.error(`[Webview] Load Fail: ${cfg.id} Code:${e.errorCode} Desc:${e.errorDescription} URL:${e.validatedURL}`);
                    if (!webviewReady) { // Show error only if no webview has loaded yet
                        statusBar.textContent = `Error: Webview ${cfg.id} load failed.`;
                    }
                } else {
                    console.warn(`[Webview] Load Aborted (-3): ${cfg.id} URL:${e.validatedURL}`);
                }
            });
            wv.addEventListener('crashed', (e) => {
                console.error(`[Webview] CRASHED: ${cfg.id}`, e);
                statusBar.textContent = `Error: Webview ${cfg.id} CRASHED! Reload recommended.`;
                // Maybe attempt a reload? wv.reload(); - Could cause loops.
            });
            wv.addEventListener('destroyed', () => {
                 console.log(`[Webview] Destroyed: ${cfg.id}`);
                 // Handle cleanup if necessary
            });

            wvContainer.appendChild(wv);
            console.log(`[Renderer] Webview "${cfg.id}" element created and added.`);
        });
    } else {
        statusBar.textContent = 'Error: No webviews configured!';
        throw new Error("No webviews configured.");
    }

    // --- Asynchronous UI Initialization ---
    let initAttempts = 0; const maxInitAttempts = 40; const initCheckInterval = 500; // 20 seconds total timeout
    console.log(`[Renderer] Waiting for webview readiness and UI modules (max ${maxInitAttempts} checks)...`);

    const checkAndInitialize = setInterval(async () => {
        initAttempts++;
        const uiModulesReady = window.AppPanelManager?.initialize &&
                               window.AppTrackerUI?.initialize &&
                               window.AppBookListManager?.initialize &&
                               window.AppDetailsOverlay?.initialize &&
                               window.AppUIUtils; // Check utils too

        if (webviewReady && uiModulesReady && !window.AppRuntime.isInitialized) {
            clearInterval(checkAndInitialize);
            console.log("[Renderer] Webview ready & UI modules loaded. Initializing UI...");
            statusBar.textContent = "Initializing UI modules...";
            try {
                // Initialize modules in logical order
                window.AppPanelManager.initialize();
                window.AppDetailsOverlay.initialize();
                await window.AppTrackerUI.initialize(); // Load tracker data first (awaits async load)
                await window.AppBookListManager.initialize(); // Load initial book list (awaits async load)

                window.AppRuntime.isInitialized = true; // Mark initialization complete
                console.log("[Renderer] UI Initialization complete.");
                statusBar.textContent = "Application Ready.";
                // Hide initial loader now that content should be loading/loaded
                 if (initialLoader) initialLoader.style.display = 'none';

            } catch (initError) {
                console.error("FATAL: Error during UI module initialization:", initError);
                statusBar.textContent = 'Error: UI Initialization Failed!';
                // Display error message in the main content area
                if(tabContentContainer) {
                    tabContentContainer.innerHTML = `<div class="error-message" style="padding:20px;"><h2>Initialization Failed</h2><p>Could not initialize core UI components.</p><p>Error: ${initError.message}</p><pre>${initError.stack || ''}</pre></div>`;
                }
                // Ensure loaders are hidden on failure
                if(initialLoader) initialLoader.style.display = 'none';
                if(infiniteScrollStatus) infiniteScrollStatus.style.display = 'none';
            }
        } else if (initAttempts >= maxInitAttempts) {
            clearInterval(checkAndInitialize);
            const reason = !webviewReady ? "Webview(s) did not become ready." : "UI modules failed to load.";
            console.error(`[Renderer] Initialization timed out after ${initAttempts} attempts. Reason: ${reason}`);
            statusBar.textContent = `Error: Initialization Timeout (${reason})`;
            // Display timeout error
            if(initialLoader) {
                initialLoader.innerHTML = `<div class="error-message" style="padding:20px;"><h2>Initialization Timeout</h2><p>The application took too long to start.</p><p>Reason: ${reason}</p></div>`;
                initialLoader.style.display = 'flex'; // Ensure loader area is visible for error
            }
            if(infiniteScrollStatus) infiniteScrollStatus.style.display = 'none'; // Hide scroll status area
            if(tabContentContainer) tabContentContainer.innerHTML = ''; // Clear potentially partial content

        } else if (initAttempts % 10 === 0) { // Log progress periodically
            console.log(`[Renderer] Initialization check ${initAttempts}: WV Ready=${webviewReady}, UI Modules Ready=${!!uiModulesReady}`);
        }
    }, initCheckInterval);

} catch (error) {
    // --- Fatal Error Handling for setup before the interval ---
    console.error("Fatal error during initial renderer setup:", error);
    if (statusBar) statusBar.textContent = "Fatal Setup Error!";
    // Display critical error in the main area
    if (tabContentContainer) {
         tabContentContainer.innerHTML = `<div class="error-message" style="padding:20px;"><h2>Critical Setup Error</h2><p>A fatal error occurred during application setup.</p><p>Error: ${error.message}</p><pre>${error.stack || ''}</pre></div>`;
    }
    // Hide loaders if they exist
    if (initialLoader) initialLoader.style.display = 'none';
    if (infiniteScrollStatus) infiniteScrollStatus.style.display = 'none';
}

console.log("[Renderer] Core script execution finished.");