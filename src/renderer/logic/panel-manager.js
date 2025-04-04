// src/renderer/logic/panel-manager.js
// Assumes necessary DOM elements (window.*) and AppUIUtils are globally available

let activeSidePanel = null; const VALID_PANELS = ['tracker', 'cart', 'notes'];

function toggleSidePanel(panelId) {
    if (!panelId || !VALID_PANELS.includes(panelId)) { console.warn("[Panel Manager] Invalid panelId provided:", panelId); return; }
    const isOpening = activeSidePanel !== panelId; const panelToShow = isOpening ? panelId : null;
    const panels = { tracker: window.trackerPanel, cart: window.cartPanel, notes: window.notesPanel };
    const buttons = { tracker: window.toggleTrackerBtn, cart: window.toggleCartBtn, notes: window.toggleNotesBtn };

    VALID_PANELS.forEach(id => {
        if (panels[id]) panels[id].classList.add('collapsed');
        if (buttons[id]) {
            buttons[id].classList.remove('active', 'panel-shown'); buttons[id].classList.add('panel-hidden');
            if (window.AppUIUtils?.applyIcon) window.AppUIUtils.applyIcon(buttons[id], 'panelToggleExpand'); // Set expand icon
            buttons[id].title = `Show ${id.charAt(0).toUpperCase() + id.slice(1)}`;
        }
    });

    if (panelToShow) {
        if (panels[panelToShow]) panels[panelToShow].classList.remove('collapsed');
        if (buttons[panelToShow]) {
            buttons[panelToShow].classList.add('active', 'panel-shown'); buttons[panelToShow].classList.remove('panel-hidden');
             if (window.AppUIUtils?.applyIcon) window.AppUIUtils.applyIcon(buttons[panelToShow], 'panelToggleCollapse'); // Set collapse icon
            buttons[panelToShow].title = `Hide ${panelToShow.charAt(0).toUpperCase() + panelToShow.slice(1)}`;
        }
        activeSidePanel = panelToShow; console.log(`[Panel Manager] Opened panel: ${panelToShow}`);
    } else { activeSidePanel = null; console.log(`[Panel Manager] Closed active panel.`); }

    if (window.resizeHandle) window.resizeHandle.style.display = (activeSidePanel === 'tracker') ? 'block' : 'none';
}

function setInitialSidePanelState() {
    VALID_PANELS.forEach(id => { const panel = window[`${id}Panel`]; if (panel) panel.classList.add('collapsed'); });
    [window.toggleTrackerBtn, window.toggleCartBtn, window.toggleNotesBtn].forEach(btn => {
        if (btn) {
            btn.classList.remove('active', 'panel-shown'); btn.classList.add('panel-hidden');
            const panelId = btn.dataset.panel;
            if (panelId) btn.title = `Show ${panelId.charAt(0).toUpperCase() + panelId.slice(1)}`;
             if (window.AppUIUtils?.applyIcon) window.AppUIUtils.applyIcon(btn, 'panelToggleExpand'); // Set initial expand icon
        }
    });
    activeSidePanel = null; if (window.resizeHandle) window.resizeHandle.style.display = 'none';
    console.log("[Panel Manager] Initial side panel state set (collapsed).");
}

let isResizing = false, startX = 0, startWidth = 0; const minTrackerWidth = 150, maxTrackerWidth = 800;
function handleResizeMouseDown(event) { if (activeSidePanel !== 'tracker' || !window.trackerPanel || window.trackerPanel.classList.contains('collapsed')) return; event.preventDefault(); isResizing = true; startX = event.clientX; const currentStyleWidth = getComputedStyle(document.documentElement).getPropertyValue('--side-panel-width'); startWidth = parseInt(currentStyleWidth, 10) || window.trackerPanel.offsetWidth; document.addEventListener('mousemove', handleResizeMouseMove); document.addEventListener('mouseup', handleResizeMouseUp); document.body.style.cursor = 'col-resize'; if(window.resizeHandle) window.resizeHandle.style.backgroundColor = 'rgba(120, 130, 150, 0.8)'; if(window.contentScrollContainer) window.contentScrollContainer.style.pointerEvents = 'none'; if(window.trackerPanel) window.trackerPanel.style.transition = 'none'; }
function handleResizeMouseMove(event) { if (!isResizing) return; const currentX = event.clientX; const deltaX = currentX - startX; let newWidth = startWidth - deltaX; newWidth = Math.max(minTrackerWidth, Math.min(newWidth, maxTrackerWidth)); document.documentElement.style.setProperty('--side-panel-width', `${newWidth}px`); }
function handleResizeMouseUp() { if (isResizing) { isResizing = false; document.removeEventListener('mousemove', handleResizeMouseMove); document.removeEventListener('mouseup', handleResizeMouseUp); document.body.style.cursor = ''; if(window.resizeHandle) window.resizeHandle.style.backgroundColor = ''; if(window.contentScrollContainer) window.contentScrollContainer.style.pointerEvents = ''; if(window.trackerPanel) window.trackerPanel.style.transition = ''; console.log(`[Panel Manager] Resize ended. New tracker panel width variable set to: ${getComputedStyle(document.documentElement).getPropertyValue('--side-panel-width')}`); } }

function setupPanelEventListeners() {
     const buttonsPresent = window.toggleTrackerBtn && window.toggleCartBtn && window.toggleNotesBtn;
     if (!window.resizeHandle || !buttonsPresent) { console.error("[Panel Manager] Cannot setup listeners - essential panel control elements missing."); return; }
    window.resizeHandle.addEventListener('mousedown', handleResizeMouseDown);
    window.toggleTrackerBtn.addEventListener('click', () => toggleSidePanel('tracker'));
    window.toggleCartBtn.addEventListener('click', () => toggleSidePanel('cart'));
    window.toggleNotesBtn.addEventListener('click', () => toggleSidePanel('notes'));
    console.log("[Panel Manager] Panel toggle and resize event listeners setup.");
}
window.AppPanelManager = { initialize: () => { setInitialSidePanelState(); setupPanelEventListeners(); }, toggleSidePanel };
console.log("[Panel Manager] Module loaded.");
