// src/renderer/logic/notes-manager.js
// Handles Notes panel logic: GFM Markdown rendering, collapsible sections, persistence, view toggling.
// Assumes necessary DOM elements, Marked, highlight.js, AppUIUtils, AppTrackerUI (for Lottie) are available.

(function() {
    const NOTES_STORAGE_KEY = 'appNotesContent', COLLAPSE_STATE_KEY = 'appNotesCollapseState', RENDER_DEBOUNCE_MS = 250, VIEW_STATE_KEY = 'appNotesViewState';
    let renderDebounceTimer = null, notesTextarea, notesPreview, notesContainer, notesToggleBtn, isPreviewMode = false, closedSectionIds = new Set();

    function initialize() {
        console.log("[Notes Manager] Initializing...");
        notesTextarea = window.notesTextarea; notesPreview = window.notesPreview; notesContainer = window.notesEditorContainer; notesToggleBtn = window.notesToggleViewBtn;
        if (!notesTextarea || !notesPreview || !notesContainer || !notesToggleBtn) { console.error("[Notes Manager] Fatal: Required Notes elements not found."); return; }
        if (typeof marked === 'undefined') { console.error("[Notes Manager] Fatal: Marked library not loaded."); notesPreview.innerHTML = '<p class="error-message">Error: Markdown library failed to load.</p>'; notesTextarea.disabled = true; return; }
        if (typeof hljs !== 'undefined') { marked.setOptions({ highlight: (code, lang) => { const language = hljs.getLanguage(lang) ? lang : 'plaintext'; try { return hljs.highlight(code, { language, ignoreIllegals: true }).value; } catch (e) { console.error("Hijs error:", e); return code; } }, gfm: true, breaks: true, pedantic: false, smartLists: true, smartypants: false }); console.log("[Notes Manager] Marked configured with highlight.js for GFM."); }
        else { console.warn("[Notes Manager] Warning: highlight.js not loaded. Syntax highlighting disabled."); marked.setOptions({ gfm: true, breaks: true, pedantic: false, smartLists: true, smartypants: false }); }

        // Use AppTrackerUI's exposed function to create Lottie
        if (window.AppTrackerUI?.createHeaderLottie) { window.AppTrackerUI.createHeaderLottie('notes-lottie-container', 'notesHeader', 'Notes Panel'); }
        else { console.warn("[Notes Manager] AppTrackerUI.createHeaderLottie not available."); }

        loadNotes(); loadCollapseState(); loadViewState(); renderNotePreview(); updateView();
        notesTextarea.addEventListener('input', handleInput); notesPreview.addEventListener('click', handlePreviewClick); notesToggleBtn.addEventListener('click', toggleView);
        console.log("[Notes Manager] Initialization complete.");
    }
    function toggleView() { isPreviewMode = !isPreviewMode; updateView(); saveViewState(); }
    function updateView() { if (isPreviewMode) { renderNotePreview(); notesTextarea.style.display = 'none'; notesPreview.style.display = 'block'; notesToggleBtn.textContent = 'Edit'; notesToggleBtn.title = 'Switch to Editor'; } else { notesTextarea.style.display = 'block'; notesPreview.style.display = 'none'; notesToggleBtn.textContent = 'Preview'; notesToggleBtn.title = 'Switch to Preview'; } }
    function saveViewState() { try { localStorage.setItem(VIEW_STATE_KEY, isPreviewMode ? 'preview' : 'editor'); } catch (e) { console.error("[Notes Manager] Error saving view state:", e); } }
    function loadViewState() { try { const s = localStorage.getItem(VIEW_STATE_KEY); isPreviewMode = s === 'preview'; console.log(`[Notes Manager] Loaded view state: ${isPreviewMode ? 'preview' : 'editor'}`); } catch (e) { console.error("[Notes Manager] Error loading view state:", e); isPreviewMode = false; } }
    function handleInput() { clearTimeout(renderDebounceTimer); renderDebounceTimer = setTimeout(() => { renderNotePreview(); saveNotes(); }, RENDER_DEBOUNCE_MS); }
    function handlePreviewClick(event) { const summary = event.target.closest('summary.notes-section-summary'); if (!summary) return; const detailsElement = summary.closest('details.notes-section'); const sectionId = detailsElement?.dataset.sectionId; if (detailsElement && sectionId) { setTimeout(() => { const isOpen = detailsElement.hasAttribute('open'); if (isOpen) { closedSectionIds.delete(sectionId); } else { closedSectionIds.add(sectionId); } saveCollapseState(); }, 0); } }
    function loadNotes() { try { const savedNotes = localStorage.getItem(NOTES_STORAGE_KEY); if (savedNotes !== null) { notesTextarea.value = savedNotes; console.log("[Notes Manager] Loaded notes."); } else { console.log("[Notes Manager] No saved notes found."); notesTextarea.value = "# Section 1\n\nContent for section 1.\n\n## Subsection 1.1\n\nMore content.\n\n# Section 2\n\n```javascript\nconsole.log('Hello');\n```\n\n- List item"; } } catch (e) { console.error("[Notes Manager] Error loading notes:", e); } }
    function saveNotes() { try { localStorage.setItem(NOTES_STORAGE_KEY, notesTextarea.value); } catch (e) { console.error("[Notes Manager] Error saving notes:", e); } }
    function loadCollapseState() { try { const s = localStorage.getItem(COLLAPSE_STATE_KEY); closedSectionIds = s ? new Set(JSON.parse(s)) : new Set(); console.log(`[Notes Manager] Loaded ${closedSectionIds.size} closed section states.`); } catch (e) { console.error("[Notes Manager] Error loading collapse state:", e); closedSectionIds = new Set(); } }
    function saveCollapseState() { try { localStorage.setItem(COLLAPSE_STATE_KEY, JSON.stringify(Array.from(closedSectionIds))); } catch (e) { console.error("[Notes Manager] Error saving collapse state:", e); } }
    function renderNotePreview() {
        if (!notesPreview || typeof marked === 'undefined') return;
        try { const markdownInput = notesTextarea.value; const rawHtml = marked.parse(markdownInput); const processedHtml = addCollapsingSections(rawHtml); notesPreview.innerHTML = processedHtml; if (typeof hljs !== 'undefined') { notesPreview.querySelectorAll('pre code:not(.hljs)').forEach((block) => { try { hljs.highlightElement(block); } catch (e) { console.error("Hijs error:", e, block.textContent?.substring(0, 50)); } }); } } catch (error) { console.error("[Notes Manager] Error parsing or processing Markdown:", error); notesPreview.innerHTML = `<p class="error-message">Error rendering preview: ${error.message}</p>`; }
    }
    function addCollapsingSections(html) {
        const container = document.createElement('div'); container.innerHTML = html; const outputContainer = document.createElement('div'); let currentDetails = null; let sectionCounter = 0;
        Array.from(container.childNodes).forEach(node => { if (node.nodeName.match(/^H[1-6]$/)) { const sectionId = `notes-section-${sectionCounter++}`; currentDetails = document.createElement('details'); currentDetails.classList.add('notes-section'); currentDetails.dataset.sectionId = sectionId; if (!closedSectionIds.has(sectionId)) currentDetails.setAttribute('open', ''); const summary = document.createElement('summary'); summary.classList.add('notes-section-summary'); summary.appendChild(node); currentDetails.appendChild(summary); outputContainer.appendChild(currentDetails); } else if (currentDetails) { currentDetails.appendChild(node); } else { outputContainer.appendChild(node); } }); return outputContainer.innerHTML;
    }
    window.AppNotesManager = { initialize };
})();
