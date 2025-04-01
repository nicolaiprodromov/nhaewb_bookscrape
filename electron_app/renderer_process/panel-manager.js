// electron_app/renderer_process/panel-manager.js

// Assumes necessary DOM elements are globally available or passed in
// Requires: trackerPanel, cartPanel, toggleTrackerBtn, toggleCartBtn, resizeHandle, contentScrollContainer

// State variable (could be managed centrally in AppUI if preferred)
let activeSidePanel = null;

/** Toggles the visibility and state of side panels */
function toggleSidePanel(panelId) {
    if (!panelId || (panelId !== 'tracker' && panelId !== 'cart')) return;

    const isOpening = activeSidePanel !== panelId;
    const panelToShow = isOpening ? panelId : null;

    const panels = { tracker: window.trackerPanel, cart: window.cartPanel };
    const buttons = { tracker: window.toggleTrackerBtn, cart: window.toggleCartBtn };

    // Collapse all panels and reset buttons first
    Object.keys(panels).forEach(id => {
        if (panels[id]) panels[id].classList.add('collapsed');
        if (buttons[id]) {
            buttons[id].classList.remove('active', 'panel-shown');
            buttons[id].classList.add('panel-hidden');
             buttons[id].title = `Show ${id.charAt(0).toUpperCase() + id.slice(1)}`;
        }
    });

    // Open the target panel if needed
    if (panelToShow) {
        if (panels[panelToShow]) panels[panelToShow].classList.remove('collapsed');
        if (buttons[panelToShow]) {
            buttons[panelToShow].classList.add('active', 'panel-shown');
            buttons[panelToShow].classList.remove('panel-hidden');
            buttons[panelToShow].title = `Hide ${panelToShow.charAt(0).toUpperCase() + panelToShow.slice(1)}`;
        }
        activeSidePanel = panelToShow;
    } else {
        activeSidePanel = null; // No panel is active
    }

    // Show/hide resize handle only for tracker panel
    if (window.resizeHandle) {
        window.resizeHandle.style.display = (activeSidePanel === 'tracker') ? 'block' : 'none';
    }
}

/** Sets the initial state of side panels (collapsed) */
function setInitialSidePanelState() {
    if (window.trackerPanel) window.trackerPanel.classList.add('collapsed');
    if (window.cartPanel) window.cartPanel.classList.add('collapsed');

    [window.toggleTrackerBtn, window.toggleCartBtn].forEach(btn => {
        if (btn) {
            btn.classList.remove('active', 'panel-shown');
            btn.classList.add('panel-hidden');
            const panelId = btn.dataset.panel;
             btn.title = `Show ${panelId.charAt(0).toUpperCase() + panelId.slice(1)}`;
        }
    });
    activeSidePanel = null;
    if (window.resizeHandle) window.resizeHandle.style.display = 'none';
     console.log("[Panel Manager] Initial state set.");
}

// --- Resizing Logic ---
let isResizing = false;
let startX = 0;
let startWidth = 0;
const minTrackerWidth = 150;
const maxTrackerWidth = 800; // Or adjust as needed

function handleResizeMouseDown(event) {
    // Only allow resize if tracker panel is active and not collapsed
    if (activeSidePanel !== 'tracker' || !window.trackerPanel || window.trackerPanel.classList.contains('collapsed')) {
        return;
    }
    isResizing = true;
    startX = event.clientX;
    // Read the current width from the CSS variable or offsetWidth
    const currentStyleWidth = getComputedStyle(document.documentElement).getPropertyValue('--side-panel-width');
    startWidth = parseInt(currentStyleWidth, 10) || window.trackerPanel.offsetWidth;

    document.addEventListener('mousemove', handleResizeMouseMove);
    document.addEventListener('mouseup', handleResizeMouseUp);
    event.preventDefault(); // Prevent text selection during drag
    document.body.style.cursor = 'col-resize';
    // Disable pointer events on content area to prevent interference
    if(window.contentScrollContainer) window.contentScrollContainer.style.pointerEvents = 'none';
    // Disable transitions during resize for smoother feel
    if(window.trackerPanel) window.trackerPanel.style.transition = 'none';
    if(window.resizeHandle) window.resizeHandle.style.backgroundColor = 'rgba(120, 130, 150, 0.8)'; // Visual feedback
}

function handleResizeMouseMove(event) {
    if (!isResizing) return;
    const currentX = event.clientX;
    const deltaX = currentX - startX;
    let newWidth = startWidth - deltaX; // Subtract delta because we are resizing from the left edge

    // Clamp width within min/max bounds
    newWidth = Math.max(minTrackerWidth, Math.min(newWidth, maxTrackerWidth));

    // Update the CSS variable
    document.documentElement.style.setProperty('--side-panel-width', `${newWidth}px`);
}

function handleResizeMouseUp() {
    if (isResizing) {
        isResizing = false;
        document.removeEventListener('mousemove', handleResizeMouseMove);
        document.removeEventListener('mouseup', handleResizeMouseUp);
        document.body.style.cursor = ''; // Reset cursor
        if(window.contentScrollContainer) window.contentScrollContainer.style.pointerEvents = ''; // Re-enable events
        if(window.trackerPanel) window.trackerPanel.style.transition = ''; // Re-enable transitions
        if(window.resizeHandle) window.resizeHandle.style.backgroundColor = ''; // Reset handle style
         console.log(`[Panel Manager] Resize ended. New width var: ${getComputedStyle(document.documentElement).getPropertyValue('--side-panel-width')}`);
    }
}

/** Setup event listeners related to panels */
function setupPanelEventListeners() {
     if (!window.resizeHandle || !window.toggleTrackerBtn || !window.toggleCartBtn) {
         console.error("[Panel Manager] Cannot setup listeners - essential elements missing.");
         return;
     }
    window.resizeHandle.addEventListener('mousedown', handleResizeMouseDown);
    // Add listeners for toggle buttons
    document.querySelectorAll('.panel-toggle-btn').forEach(button => {
        button.addEventListener('click', () => toggleSidePanel(button.dataset.panel));
    });
    console.log("[Panel Manager] Event listeners setup.");
}

// Export functions/state if needed (using simple window attachment)
window.AppPanelManager = {
    initialize: () => {
        setInitialSidePanelState();
        setupPanelEventListeners();
    },
    toggleSidePanel,
    // No need to expose internal resize handlers
};
console.log("[Panel Manager] Module loaded.");