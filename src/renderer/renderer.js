// src/renderer/renderer.js
// Handles core Electron integration, webview setup, and initializes UI modules.

// --- Electron API Check ---
if (typeof window.electronAPI === 'undefined') { console.error("FATAL: Preload script ('electronAPI') failed. IPC bridge broken."); document.body.innerHTML = '<div style="padding:20px;color:red;font-family:sans-serif;"><h1>Critical Error</h1><p>Cannot communicate with the main application process (preload script failed). Please restart the application.</p></div>'; throw new Error("electronAPI not available in renderer process. Preload script might have failed."); } else { console.log("[Renderer] electronAPI bridge confirmed."); }

// --- Early DOM Element References ---
function getRequiredElement(id, name) { const element = document.getElementById(id); if (!element) { console.error(`[Renderer Fatal] Required element #${id} (${name}) not found.`); throw new Error(`Fatal Error: UI element #${id} (${name}) is missing.`); } return element; }
function getOptionalElement(id) { return document.getElementById(id); }

// Declare variables for all elements
let statusBar, tabContentContainer, contentScrollContainer, initialLoader, infiniteScrollStatus, scrollLoader, endOfContentMessage, bookSearchInput, overlay, toggleOverlayBtn, notesPanel, toggleNotesBtn, notesContent, notesLottieContainer, notesTextarea, notesPreview, notesEditorContainer, notesToggleViewBtn, trackerPanel, toggleTrackerBtn, resizeHandle, trackerContent, trackerCategoriesContainer, addCategoryBtn, addStackLottieContainer, cartPanel, toggleCartBtn, rightControls, detailsOverlay, detailsOverlayContent, detailsTitle, detailsBody, detailsCloseBtn, wvContainer, tabBar; // Added tabBar

try {
    // Existing elements...
    statusBar = getRequiredElement('status-bar', 'Status Bar'); tabContentContainer = getRequiredElement('tab-content-container', 'Tab Content Container'); contentScrollContainer = getRequiredElement('content-scroll-container', 'Content Scroll Container'); initialLoader = getRequiredElement('initial-loader', 'Initial Loader'); infiniteScrollStatus = getRequiredElement('infinite-scroll-status', 'Infinite Scroll Status'); scrollLoader = getRequiredElement('scroll-loader', 'Scroll Loader'); endOfContentMessage = getRequiredElement('end-of-content-message', 'End of Content Message'); bookSearchInput = getRequiredElement('book-search-input', 'Book Search Input'); overlay = getRequiredElement('overlay', 'Main Overlay'); toggleOverlayBtn = getRequiredElement('toggle-overlay-btn', 'Toggle Overlay Button'); rightControls = getRequiredElement('right-controls', 'Right Controls'); wvContainer = getRequiredElement('webview-container', 'Webview Container'); detailsOverlay = getRequiredElement('details-overlay', 'Details Overlay');
    notesPanel = getRequiredElement('notes-panel', 'Notes Panel'); toggleNotesBtn = getRequiredElement('toggle-notes-btn', 'Toggle Notes Button'); notesContent = getRequiredElement('notes-content', 'Notes Content'); notesLottieContainer = getRequiredElement('notes-lottie-container', 'Notes Lottie Container'); notesEditorContainer = getRequiredElement('notes-editor-container', 'Notes Editor Container'); notesTextarea = getRequiredElement('notes-textarea', 'Notes Textarea'); notesPreview = getRequiredElement('notes-preview', 'Notes Preview'); notesToggleViewBtn = getRequiredElement('notes-toggle-view-btn', 'Notes Toggle View Button');
    trackerPanel = getRequiredElement('tracker-panel', 'Tracker Panel'); toggleTrackerBtn = getRequiredElement('toggle-tracker-btn', 'Toggle Tracker Button'); resizeHandle = getRequiredElement('resize-handle', 'Resize Handle'); trackerContent = getRequiredElement('tracker-content', 'Tracker Content'); trackerCategoriesContainer = getRequiredElement('tracker-categories-container', 'Tracker Categories Container'); addCategoryBtn = getRequiredElement('add-category-btn', 'Add Category Button'); addStackLottieContainer = getRequiredElement('add-stack-lottie-container', 'Tracker Lottie Container');
    cartPanel = getRequiredElement('cart-panel', 'Cart Panel'); toggleCartBtn = getRequiredElement('toggle-cart-btn', 'Toggle Cart Button');
    detailsOverlayContent = document.querySelector('.details-overlay-content'); detailsTitle = getOptionalElement('details-title'); detailsBody = getOptionalElement('details-body'); detailsCloseBtn = document.querySelector('.details-overlay-close-btn');
    // New element
    tabBar = getRequiredElement('tab-bar', 'Tab Bar');

    if (!detailsOverlayContent || !detailsTitle || !detailsBody || !detailsCloseBtn) console.warn("[Renderer] Warning: One or more optional details overlay elements not found.");
    console.log("[Renderer] All required DOM elements found.");

    // Assign to window scope
    window.statusBar = statusBar; window.tabContentContainer = tabContentContainer; window.contentScrollContainer = contentScrollContainer; window.initialLoader = initialLoader; window.infiniteScrollStatus = infiniteScrollStatus; window.scrollLoader = scrollLoader; window.endOfContentMessage = endOfContentMessage; window.bookSearchInput = bookSearchInput; window.overlay = overlay; window.toggleOverlayBtn = toggleOverlayBtn; window.notesPanel = notesPanel; window.toggleNotesBtn = toggleNotesBtn; window.trackerPanel = trackerPanel; window.toggleTrackerBtn = toggleTrackerBtn; window.cartPanel = cartPanel; window.toggleCartBtn = toggleCartBtn; window.notesContent = notesContent; window.notesLottieContainer = notesLottieContainer; window.notesEditorContainer = notesEditorContainer; window.notesTextarea = notesTextarea; window.notesPreview = notesPreview; window.notesToggleViewBtn = notesToggleViewBtn; window.trackerContent = trackerContent; window.trackerCategoriesContainer = trackerCategoriesContainer; window.addCategoryBtn = addCategoryBtn; window.addStackLottieContainer = addStackLottieContainer; window.rightControls = rightControls; window.resizeHandle = resizeHandle; window.detailsOverlay = detailsOverlay; window.detailsOverlayContent = detailsOverlayContent; window.detailsTitle = detailsTitle; window.detailsBody = detailsBody; window.detailsCloseBtn = detailsCloseBtn; window.tabBar = tabBar; // Added tabBar
} catch (error) { document.body.innerHTML = `<div style="padding:20px;color:red;font-family:sans-serif;"><h1>Fatal Error</h1><p>Core UI layout elements are missing. The application cannot start correctly.</p><p>Error: ${error.message}</p></div>`; throw error; }

// Global state for easy access by modules
window.AppRuntime = {
    appConfig: null, // Holds the full config passed from main
    webviewConfigs: [], // Extracted from appConfig
    primaryUserBrowserId: null,
    primaryListFetcherId: null,
    primaryDetailFetcherId: null,
    primaryWebviewBaseListUrl: null, // Still needed for list fetching
    uiConfig: null, // To hold loaded UI config
    isInitialized: false
};

let webviewsReadyCount = 0; // Track how many webviews are ready
let uiConfigLoaded = false; // Flag: ui-config.json loaded
let totalWebviewsExpected = 0; // Number of webviews defined in config

/** Loads ui-config.json */
async function loadUiConfig() {
    try {
        const response = await fetch('./ui-config.json'); // Path relative to index.html
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        window.AppRuntime.uiConfig = await response.json();
        uiConfigLoaded = true;
        console.log("[Renderer] UI Config loaded successfully.");

        if(window.AppUIUtils?.applyIcon) {
            window.AppUIUtils.applyIcon(initialLoader, 'initialLoader');
            if (scrollLoader) window.AppUIUtils.applyIcon(scrollLoader, 'scrollLoader');
            else console.warn("[Renderer] Scroll loader element not found during UI config load.");

            if (toggleOverlayBtn) window.AppUIUtils.applyIcon(toggleOverlayBtn, 'toggleOverlayHide');
            if (toggleNotesBtn) window.AppUIUtils.applyIcon(toggleNotesBtn, 'panelToggleExpand');
            if (toggleTrackerBtn) window.AppUIUtils.applyIcon(toggleTrackerBtn, 'panelToggleExpand');
            if (toggleCartBtn) window.AppUIUtils.applyIcon(toggleCartBtn, 'panelToggleExpand');
        }
    } catch (error) {
        console.error("[Renderer] Failed to load ui-config.json:", error);
        statusBar.textContent = 'Error: Failed to load UI config!';
    }
}

/** Switches the visible webview */
function switchTab(webviewId) {
    const webviews = wvContainer.querySelectorAll('webview');
    const tabs = tabBar.querySelectorAll('.tab-button');

    webviews.forEach(wv => {
        wv.classList.toggle('active', wv.id === webviewId);
        wv.classList.toggle('hidden', wv.id !== webviewId); // Explicitly hide others
    });

    tabs.forEach(tab => {
        tab.classList.toggle('active', tab.dataset.webviewId === webviewId);
    });
    console.log(`[Renderer] Switched to tab: ${webviewId}`);
}

try {
    // --- Add Main Overlay Toggle Listener ---
    toggleOverlayBtn.addEventListener('click', () => {
        overlay.classList.toggle('hidden');
        const isHidden = overlay.classList.contains('hidden');
        if (window.AppUIUtils?.applyIcon) { window.AppUIUtils.applyIcon(toggleOverlayBtn, isHidden ? 'toggleOverlayShow' : 'toggleOverlayHide'); }
        toggleOverlayBtn.title = isHidden ? "Show UI" : "Hide UI";
    });
    console.log("[Renderer] Main overlay toggle listener added.");

    // --- Parse Config from Query Parameter ---
    const urlParams = new URLSearchParams(window.location.search);
    const appConfigParam = urlParams.get('app-config'); // Get param passed from main
    let configJson = null;

    if (appConfigParam) {
        configJson = decodeURIComponent(appConfigParam);
    } else {
        console.error("[Renderer] App config query parameter 'app-config' not found.");
        statusBar.textContent = 'Error: App config missing!';
        throw new Error("App config query parameter not found.");
    }

    if (configJson) {
        try {
            window.AppRuntime.appConfig = JSON.parse(configJson);
            window.AppRuntime.webviewConfigs = window.AppRuntime.appConfig.webviews || [];
            window.AppRuntime.primaryUserBrowserId = window.AppRuntime.appConfig.defaultUserBrowserId;
            window.AppRuntime.primaryListFetcherId = window.AppRuntime.appConfig.defaultListFetcherId;
            window.AppRuntime.primaryDetailFetcherId = window.AppRuntime.appConfig.defaultDetailFetcherId;

            // Find the list fetcher config to get the base URL
            const listFetcherConfig = window.AppRuntime.webviewConfigs.find(
                cfg => cfg.id === window.AppRuntime.primaryListFetcherId
            );
            window.AppRuntime.primaryWebviewBaseListUrl = listFetcherConfig?.listDataBaseUrl;

            if (!window.AppRuntime.primaryUserBrowserId || !window.AppRuntime.primaryListFetcherId || !window.AppRuntime.primaryDetailFetcherId) {
                 throw new Error("Missing one or more default webview IDs in config.");
            }
            if (!window.AppRuntime.primaryWebviewBaseListUrl && window.AppRuntime.primaryListFetcherId) { // Check only if list fetcher is defined
                console.warn(`[Renderer] Warning: listDataBaseUrl not set for list fetcher "${window.AppRuntime.primaryListFetcherId}" in config.json. List fetching may fail.`);
            }
            console.log("[Renderer] Parsed app config from query param:", window.AppRuntime.appConfig);
            totalWebviewsExpected = window.AppRuntime.webviewConfigs.length;

        } catch (e) {
            console.error("[Renderer] Error parsing app config from query param:", e);
            statusBar.textContent = 'Error: Invalid app config!'; throw e;
        }
    }
     // Removed the `else` block that threw error if configJson was null, as it was already handled above

    // --- Webview and Tab Creation ---
    if (window.AppRuntime.webviewConfigs.length > 0) {
        statusBar.textContent = `Loading ${window.AppRuntime.webviewConfigs.length} webview(s)...`;
        wvContainer.innerHTML = ''; // Clear container
        tabBar.innerHTML = ''; // Clear tab bar

        window.AppRuntime.webviewConfigs.forEach((cfg, index) => {
            if (!cfg.id || !cfg.initialUrl) { console.warn("[Renderer] Skipping invalid webview config (missing id or initialUrl):", cfg); return; }

            // Create Webview
            const wv = document.createElement('webview');
            wv.id = cfg.id;
            wv.src = cfg.initialUrl;
            if (cfg.partition) wv.partition = cfg.partition;
            wv.classList.add('webview-instance'); // Add class for styling/selection

            // Default to active if it's the userBrowser, otherwise hidden
            if (cfg.id === window.AppRuntime.primaryUserBrowserId) {
                 wv.classList.add('active');
            } else {
                 wv.classList.add('hidden');
            }

            wv.addEventListener('dom-ready', () => { console.log(`[Webview] DOM Ready: ${cfg.id} (URL: ${wv.getURL()})`); webviewsReadyCount++; statusBar.textContent = `Webview Ready: ${cfg.id} (${webviewsReadyCount}/${totalWebviewsExpected})`; });
            wv.addEventListener('did-fail-load', (e) => { if (e.errorCode !== -3) { console.error(`[Webview] Load Fail: ${cfg.id} Code:${e.errorCode} Desc:${e.errorDescription} URL:${e.validatedURL}`); statusBar.textContent = `Error: Webview ${cfg.id} load failed.`; } else { console.warn(`[Webview] Load Aborted (-3): ${cfg.id} URL:${e.validatedURL}`); } });
            wv.addEventListener('crashed', (e) => { console.error(`[Webview] CRASHED: ${cfg.id}`, e); statusBar.textContent = `Error: Webview ${cfg.id} CRASHED! Reload recommended.`; });
            wv.addEventListener('destroyed', () => { console.log(`[Webview] Destroyed: ${cfg.id}`); });
            wvContainer.appendChild(wv); console.log(`[Renderer] Webview "${cfg.id}" element created and added.`);

            // Create Tab Button
            const tabButton = document.createElement('button');
            tabButton.className = 'tab-button';
            tabButton.textContent = cfg.description || cfg.id; // Use description or ID for tab text
            tabButton.dataset.webviewId = cfg.id;
            if (cfg.id === window.AppRuntime.primaryUserBrowserId) {
                tabButton.classList.add('active'); // Activate the default tab
            }
            tabButton.addEventListener('click', () => switchTab(cfg.id));
            tabBar.appendChild(tabButton);
        });
         // Ensure only the default tab is active initially
         if (window.AppRuntime.primaryUserBrowserId) {
             switchTab(window.AppRuntime.primaryUserBrowserId);
         } else if (window.AppRuntime.webviewConfigs.length > 0) {
             // Fallback to the first configured webview if default isn't set right
             switchTab(window.AppRuntime.webviewConfigs[0].id);
         }
    } else { statusBar.textContent = 'Error: No webviews configured!'; throw new Error("No webviews configured."); }

    // --- Load UI Config & Initialize UI ---
    loadUiConfig(); // Start loading UI config asynchronously

    let initAttempts = 0; const maxInitAttempts = 60; const initCheckInterval = 500; // Increased attempts/timeout
    console.log(`[Renderer] Waiting for webviews (${totalWebviewsExpected}), UI modules, and UI config (max ${maxInitAttempts} checks)...`);

    const checkAndInitialize = setInterval(async () => {
        initAttempts++;
        const allWebviewsReady = (webviewsReadyCount >= totalWebviewsExpected);
        const uiModulesReady = window.AppPanelManager?.initialize && window.AppTrackerUI?.initialize && window.AppBookListManager?.initialize && window.AppDetailsOverlay?.initialize && window.AppNotesManager?.initialize && window.AppUIUtils;

        if (allWebviewsReady && uiModulesReady && uiConfigLoaded && !window.AppRuntime.isInitialized) {
            clearInterval(checkAndInitialize);
            console.log("[Renderer] All webviews ready, UI modules loaded, UI config loaded. Initializing UI...");
            statusBar.textContent = "Initializing UI modules...";
            try {
                window.AppPanelManager.initialize();
                window.AppDetailsOverlay.initialize();
                await window.AppTrackerUI.initialize();
                await window.AppNotesManager.initialize();
                await window.AppBookListManager.initialize(); // Loads initial list data

                window.AppRuntime.isInitialized = true;
                console.log("[Renderer] UI Initialization complete.");
                statusBar.textContent = "Application Ready.";
                if (initialLoader) initialLoader.style.display = 'none';
            } catch (initError) {
                console.error("FATAL: Error during UI module initialization:", initError); statusBar.textContent = 'Error: UI Initialization Failed!';
                if(tabContentContainer) { tabContentContainer.innerHTML = `<div class="error-message" style="padding:20px;"><h2>Initialization Failed</h2><p>Could not initialize core UI components.</p><p>Error: ${initError.message}</p><pre>${initError.stack || ''}</pre></div>`; }
                if(initialLoader) initialLoader.style.display = 'none'; if(infiniteScrollStatus) infiniteScrollStatus.style.display = 'none';
            }
        } else if (initAttempts >= maxInitAttempts) {
            clearInterval(checkAndInitialize);
            const reason = !allWebviewsReady ? `Webviews not ready (${webviewsReadyCount}/${totalWebviewsExpected}).` : !uiModulesReady ? "UI modules failed to load." : "UI config failed to load.";
            console.error(`[Renderer] Initialization timed out after ${initAttempts} attempts. Reason: ${reason}`); statusBar.textContent = `Error: Initialization Timeout (${reason})`;
            if(initialLoader) { initialLoader.innerHTML = `<div class="error-message" style="padding:20px;"><h2>Initialization Timeout</h2><p>The application took too long to start.</p><p>Reason: ${reason}</p></div>`; initialLoader.style.display = 'flex'; }
            if(infiniteScrollStatus) infiniteScrollStatus.style.display = 'none'; if(tabContentContainer) tabContentContainer.innerHTML = '';
        } else if (initAttempts % 10 === 0) {
            console.log(`[Renderer] Initialization check ${initAttempts}: Webviews Ready=${webviewsReadyCount}/${totalWebviewsExpected}, UI Modules Ready=${!!uiModulesReady}, UI Config Loaded=${uiConfigLoaded}`);
        }
    }, initCheckInterval);

} catch (error) {
    console.error("Fatal error during initial renderer setup:", error); if (statusBar) statusBar.textContent = "Fatal Setup Error!";
    if (tabContentContainer) { tabContentContainer.innerHTML = `<div class="error-message" style="padding:20px;"><h2>Critical Setup Error</h2><p>A fatal error occurred during application setup.</p><p>Error: ${error.message}</p><pre>${error.stack || ''}</pre></div>`; }
    if (initialLoader) initialLoader.style.display = 'none'; if (infiniteScrollStatus) infiniteScrollStatus.style.display = 'none';
}
console.log("[Renderer] Core script execution finished.");
