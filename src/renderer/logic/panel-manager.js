// src/renderer/logic/panel-manager.js

// Assumes necessary DOM elements (window.*) are globally available via renderer.js

// State variable to track the currently active/open side panel ('tracker', 'cart', or null)
let activeSidePanel = null;

/**
 * Toggles the visibility and state of side panels (tracker or cart).
 * Only one panel can be open at a time.
 * @param {'tracker' | 'cart'} panelId - The ID of the panel to toggle.
 */
function toggleSidePanel(panelId) {
    if (!panelId || (panelId !== 'tracker' && panelId !== 'cart')) {
        console.warn("[Panel Manager] Invalid panelId provided:", panelId);
        return;
    }

    // Determine if we are opening the clicked panel or closing the active one
    const isOpening = activeSidePanel !== panelId;
    const panelToShow = isOpening ? panelId : null; // null means close whatever is open

    // Get references to panels and buttons (assuming they exist on window)
    const panels = {
        tracker: window.trackerPanel,
        cart: window.cartPanel
    };
    const buttons = {
        tracker: window.toggleTrackerBtn,
        cart: window.toggleCartBtn
    };

    // --- Step 1: Collapse all panels and reset all buttons ---
    Object.keys(panels).forEach(id => {
        if (panels[id]) {
            panels[id].classList.add('collapsed');
        }
        if (buttons[id]) {
            buttons[id].classList.remove('active', 'panel-shown'); // Remove active/shown states
            buttons[id].classList.add('panel-hidden'); // Add hidden state (controls arrow direction)
            // Update tooltip to "Show..."
            buttons[id].title = `Show ${id.charAt(0).toUpperCase() + id.slice(1)}`;
        }
    });

    // --- Step 2: Open the target panel if one was specified ---
    if (panelToShow) {
        if (panels[panelToShow]) {
            panels[panelToShow].classList.remove('collapsed'); // Expand the target panel
        }
        if (buttons[panelToShow]) {
            buttons[panelToShow].classList.add('active', 'panel-shown'); // Set active/shown state
            buttons[panelToShow].classList.remove('panel-hidden'); // Remove hidden state
            // Update tooltip to "Hide..."
            buttons[panelToShow].title = `Hide ${panelToShow.charAt(0).toUpperCase() + panelToShow.slice(1)}`;
        }
        activeSidePanel = panelToShow; // Update the active panel state
        console.log(`[Panel Manager] Opened panel: ${panelToShow}`);
    } else {
        // If panelToShow is null, it means we clicked the already active panel's button
        activeSidePanel = null; // No panel is active
        console.log(`[Panel Manager] Closed active panel.`);
    }

    // --- Step 3: Manage Resize Handle Visibility ---
    // Show resize handle ONLY if the tracker panel is the one being shown
    if (window.resizeHandle) {
        window.resizeHandle.style.display = (activeSidePanel === 'tracker') ? 'block' : 'none';
    }

    // Optional: Adjust main content padding/margin based on active panel?
    // Example: if (window.contentScrollContainer) {
    //    window.contentScrollContainer.style.marginRight = activeSidePanel ? 'var(--side-panel-width)' : '0';
    // }
}

/** Sets the initial state of side panels (all collapsed) */
function setInitialSidePanelState() {
    if (window.trackerPanel) window.trackerPanel.classList.add('collapsed');
    if (window.cartPanel) window.cartPanel.classList.add('collapsed');

    // Reset buttons to initial "Show" state
    [window.toggleTrackerBtn, window.toggleCartBtn].forEach(btn => {
        if (btn) {
            btn.classList.remove('active', 'panel-shown');
            btn.classList.add('panel-hidden');
            const panelId = btn.dataset.panel; // Get panel ID from data attribute
            btn.title = `Show ${panelId.charAt(0).toUpperCase() + panelId.slice(1)}`;
        }
    });

    activeSidePanel = null; // No panel active initially
    if (window.resizeHandle) window.resizeHandle.style.display = 'none'; // Hide resizer

    console.log("[Panel Manager] Initial side panel state set (collapsed).");
}

// --- Resizing Logic for Tracker Panel ---
let isResizing = false;
let startX = 0;
let startWidth = 0;
const minTrackerWidth = 150; // Minimum allowed width for the tracker panel
const maxTrackerWidth = 800; // Maximum allowed width for the tracker panel

function handleResizeMouseDown(event) {
    // Only allow resize if tracker panel is active and not collapsed
    if (activeSidePanel !== 'tracker' || !window.trackerPanel || window.trackerPanel.classList.contains('collapsed')) {
        return;
    }
    // Prevent default text selection behavior during drag
    event.preventDefault();

    isResizing = true;
    startX = event.clientX; // Record starting mouse position

    // Get the current width from the CSS variable or fallback to offsetWidth
    const currentStyleWidth = getComputedStyle(document.documentElement).getPropertyValue('--side-panel-width');
    startWidth = parseInt(currentStyleWidth, 10) || window.trackerPanel.offsetWidth;

    // Add global listeners for mouse move and mouse up
    document.addEventListener('mousemove', handleResizeMouseMove);
    document.addEventListener('mouseup', handleResizeMouseUp);

    // Apply visual feedback during resize
    document.body.style.cursor = 'col-resize'; // Change cursor globally
    if(window.resizeHandle) window.resizeHandle.style.backgroundColor = 'rgba(120, 130, 150, 0.8)'; // Highlight handle
    // Disable pointer events on potentially interfering elements (like main content)
    if(window.contentScrollContainer) window.contentScrollContainer.style.pointerEvents = 'none';
    // Disable CSS transitions on the panel for smoother live resizing
    if(window.trackerPanel) window.trackerPanel.style.transition = 'none';
}

function handleResizeMouseMove(event) {
    if (!isResizing) return;

    const currentX = event.clientX;
    const deltaX = currentX - startX; // Calculate mouse movement
    // New width is start width MINUS deltaX because we're dragging the left edge
    let newWidth = startWidth - deltaX;

    // Clamp the new width within the defined min/max bounds
    newWidth = Math.max(minTrackerWidth, Math.min(newWidth, maxTrackerWidth));

    // Update the CSS variable, which controls the actual panel width
    document.documentElement.style.setProperty('--side-panel-width', `${newWidth}px`);
}

function handleResizeMouseUp() {
    if (isResizing) {
        isResizing = false;
        // Remove global listeners
        document.removeEventListener('mousemove', handleResizeMouseMove);
        document.removeEventListener('mouseup', handleResizeMouseUp);

        // Reset visual feedback and interactions
        document.body.style.cursor = ''; // Reset global cursor
        if(window.resizeHandle) window.resizeHandle.style.backgroundColor = ''; // Reset handle style
        if(window.contentScrollContainer) window.contentScrollContainer.style.pointerEvents = ''; // Re-enable pointer events
        if(window.trackerPanel) window.trackerPanel.style.transition = ''; // Re-enable CSS transitions

        console.log(`[Panel Manager] Resize ended. New tracker panel width variable set to: ${getComputedStyle(document.documentElement).getPropertyValue('--side-panel-width')}`);
    }
}

/** Setup event listeners related to panels */
function setupPanelEventListeners() {
     if (!window.resizeHandle || !window.toggleTrackerBtn || !window.toggleCartBtn) {
         console.error("[Panel Manager] Cannot setup listeners - essential panel control elements missing.");
         return;
     }
    // Add listener for the tracker panel resize handle
    window.resizeHandle.addEventListener('mousedown', handleResizeMouseDown);

    // Add listeners for the toggle buttons using their specific IDs
    window.toggleTrackerBtn.addEventListener('click', () => toggleSidePanel('tracker'));
    window.toggleCartBtn.addEventListener('click', () => toggleSidePanel('cart'));

    console.log("[Panel Manager] Panel toggle and resize event listeners setup.");
}

// --- Initialization and Export ---
window.AppPanelManager = {
    initialize: () => {
        setInitialSidePanelState();
        setupPanelEventListeners();
    },
    toggleSidePanel // Expose toggle function if needed externally
    // No need to expose internal resize handlers or state
};

console.log("[Panel Manager] Module loaded.");