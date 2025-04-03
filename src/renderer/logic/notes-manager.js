// src/renderer/logic/notes-manager.js
// Handles Notes panel logic: GFM Markdown rendering, collapsible sections based on headings, persistence, view toggling.

// Assumes necessary DOM elements (window.*), Marked library, highlight.js, and AppTrackerUI (for Lottie) are available.

(function() {
    const NOTES_STORAGE_KEY = 'appNotesContent';
    const COLLAPSE_STATE_KEY = 'appNotesCollapseState'; // Stores IDs of *closed* sections
    const RENDER_DEBOUNCE_MS = 250;
    const VIEW_STATE_KEY = 'appNotesViewState';

    let renderDebounceTimer = null;
    let notesTextarea, notesPreview, notesContainer, notesToggleBtn;
    let isPreviewMode = false;
    // Store IDs of *closed* <details> elements
    let closedSectionIds = new Set();

    /** Initializes the Notes Manager. */
    function initialize() {
        console.log("[Notes Manager] Initializing...");
        notesTextarea = window.notesTextarea;
        notesPreview = window.notesPreview;
        notesContainer = window.notesEditorContainer;
        notesToggleBtn = window.notesToggleViewBtn;

        if (!notesTextarea || !notesPreview || !notesContainer || !notesToggleBtn) {
            console.error("[Notes Manager] Fatal: Required Notes elements not found."); return;
        }
        if (typeof marked === 'undefined') {
            console.error("[Notes Manager] Fatal: Marked library not loaded.");
            notesPreview.innerHTML = '<p class="error-message">Error: Markdown library failed to load.</p>';
            notesTextarea.disabled = true; return;
        }
        if (typeof hljs !== 'undefined') {
            marked.setOptions({
                highlight: (code, lang) => {
                    const language = hljs.getLanguage(lang) ? lang : 'plaintext';
                    try { return hljs.highlight(code, { language, ignoreIllegals: true }).value; }
                    catch (e) { console.error("Hijs error:", e); return code; }
                }, gfm: true, breaks: true, pedantic: false, smartLists: true, smartypants: false
            });
            console.log("[Notes Manager] Marked configured with highlight.js for GFM.");
        } else {
             console.warn("[Notes Manager] Warning: highlight.js not loaded. Syntax highlighting disabled.");
             marked.setOptions({ gfm: true, breaks: true, pedantic: false, smartLists: true, smartypants: false });
        }

        // Create Lottie animation
        if (window.AppTrackerUI?.createHeaderLottie) {
            window.AppTrackerUI.createHeaderLottie('notes-lottie-container', 'https://lottie.host/09161c5a-4b8f-499e-ac79-3d86f3d1d6ea/s81A6BbO3u.lottie', 'Notes Panel');
        } else { console.warn("[Notes Manager] AppTrackerUI.createHeaderLottie not available."); }

        loadNotes();
        loadCollapseState();
        loadViewState();
        renderNotePreview(); // Initial render
        updateView();

        notesTextarea.addEventListener('input', handleInput);
        notesPreview.addEventListener('click', handlePreviewClick); // Handle clicks on summary
        notesToggleBtn.addEventListener('click', toggleView);

        console.log("[Notes Manager] Initialization complete.");
    }

    /** Toggles between editor and preview mode. */
    function toggleView() { isPreviewMode = !isPreviewMode; updateView(); saveViewState(); }

    /** Updates UI based on isPreviewMode. */
    function updateView() {
        if (isPreviewMode) {
            renderNotePreview(); // Re-render ensures collapse state is applied correctly
            notesTextarea.style.display = 'none'; notesPreview.style.display = 'block';
            notesToggleBtn.textContent = 'Edit'; notesToggleBtn.title = 'Switch to Editor';
        } else {
            notesTextarea.style.display = 'block'; notesPreview.style.display = 'none';
            notesToggleBtn.textContent = 'Preview'; notesToggleBtn.title = 'Switch to Preview';
        }
    }

    /** Saves the view state (editor/preview). */
    function saveViewState() { try { localStorage.setItem(VIEW_STATE_KEY, isPreviewMode ? 'preview' : 'editor'); } catch (e) { console.error("[Notes Manager] Error saving view state:", e); } }

    /** Loads the view state. */
    function loadViewState() { try { const s = localStorage.getItem(VIEW_STATE_KEY); isPreviewMode = s === 'preview'; console.log(`[Notes Manager] Loaded view state: ${isPreviewMode ? 'preview' : 'editor'}`); } catch (e) { console.error("[Notes Manager] Error loading view state:", e); isPreviewMode = false; } }

    /** Handles textarea input. */
    function handleInput() { clearTimeout(renderDebounceTimer); renderDebounceTimer = setTimeout(() => { renderNotePreview(); saveNotes(); }, RENDER_DEBOUNCE_MS); }

    /** Handles clicks in the preview, specifically on <summary> for toggling <details>. */
    function handlePreviewClick(event) {
        const summary = event.target.closest('summary.notes-section-summary');
        if (!summary) return;

        const detailsElement = summary.closest('details.notes-section');
        const sectionId = detailsElement?.dataset.sectionId;

        if (detailsElement && sectionId) {
            // Use setTimeout to check state *after* the browser handles the default toggle
            setTimeout(() => {
                const isOpen = detailsElement.hasAttribute('open');
                if (isOpen) { closedSectionIds.delete(sectionId); }
                else { closedSectionIds.add(sectionId); }
                saveCollapseState();
                // console.debug(`[Notes Manager] Collapse state toggled for ${sectionId}. Now ${isOpen ? 'open' : 'closed'}.`);
            }, 0);
        }
    }

    /** Loads notes content. */
    function loadNotes() {
        try {
            const savedNotes = localStorage.getItem(NOTES_STORAGE_KEY);
            if (savedNotes !== null) { notesTextarea.value = savedNotes; console.log("[Notes Manager] Loaded notes."); }
            else { console.log("[Notes Manager] No saved notes found."); notesTextarea.value = "# Section 1\n\nContent for section 1.\n\n## Subsection 1.1\n\nMore content.\n\n# Section 2\n\n```javascript\nconsole.log('Hello');\n```\n\n- List item"; }
        } catch (e) { console.error("[Notes Manager] Error loading notes:", e); }
    }

    /** Saves notes content. */
    function saveNotes() { try { localStorage.setItem(NOTES_STORAGE_KEY, notesTextarea.value); } catch (e) { console.error("[Notes Manager] Error saving notes:", e); } }

    /** Loads collapsed section IDs. */
    function loadCollapseState() { try { const s = localStorage.getItem(COLLAPSE_STATE_KEY); closedSectionIds = s ? new Set(JSON.parse(s)) : new Set(); console.log(`[Notes Manager] Loaded ${closedSectionIds.size} closed section states.`); } catch (e) { console.error("[Notes Manager] Error loading collapse state:", e); closedSectionIds = new Set(); } }

    /** Saves collapsed section IDs. */
    function saveCollapseState() { try { localStorage.setItem(COLLAPSE_STATE_KEY, JSON.stringify(Array.from(closedSectionIds))); } catch (e) { console.error("[Notes Manager] Error saving collapse state:", e); } }

    /**
     * Parses full Markdown and injects collapsible sections based on headings.
     */
    function renderNotePreview() {
        if (!notesPreview || typeof marked === 'undefined') return;
        try {
            const markdownInput = notesTextarea.value;
            const rawHtml = marked.parse(markdownInput);
            const processedHtml = addCollapsingSections(rawHtml); // Add <details> tags
            notesPreview.innerHTML = processedHtml;

            // Apply highlighting
            if (typeof hljs !== 'undefined') {
                 notesPreview.querySelectorAll('pre code:not(.hljs)').forEach((block) => { // Avoid re-highlighting
                     try { hljs.highlightElement(block); }
                     catch (e) { console.error("Hijs error:", e, block.textContent?.substring(0, 50)); }
                 });
            }
             // console.debug("[Notes Manager] Rendered notes preview with collapsing sections.");
        } catch (error) {
             console.error("[Notes Manager] Error parsing or processing Markdown:", error);
             notesPreview.innerHTML = `<p class="error-message">Error rendering preview: ${error.message}</p>`;
        }
    }

    /**
     * Post-processes HTML, wrapping content under headings in <details> elements.
     * @param {string} html Raw HTML string from marked.parse().
     * @returns {string} HTML string with <details> elements.
     */
    function addCollapsingSections(html) {
        const container = document.createElement('div');
        container.innerHTML = html;
        const outputContainer = document.createElement('div');
        let currentDetails = null;
        let sectionCounter = 0; // Simple counter for unique IDs

        Array.from(container.childNodes).forEach(node => {
            // Check if the node is a heading element (H1-H6)
            if (node.nodeName.match(/^H[1-6]$/)) {
                // Create a new details section
                const sectionId = `notes-section-${sectionCounter++}`;
                currentDetails = document.createElement('details');
                currentDetails.classList.add('notes-section');
                currentDetails.dataset.sectionId = sectionId;

                // Check saved state: If ID is NOT in closed set, it should be open
                if (!closedSectionIds.has(sectionId)) {
                    currentDetails.setAttribute('open', '');
                }

                const summary = document.createElement('summary');
                summary.classList.add('notes-section-summary');
                // Move the heading content into the summary
                summary.appendChild(node); // Moves the heading node itself
                currentDetails.appendChild(summary);
                outputContainer.appendChild(currentDetails); // Add details to output
            } else if (currentDetails) {
                // If we are inside a details section, append the node to it
                currentDetails.appendChild(node);
            } else {
                // If not a heading and not inside a details section, append directly
                outputContainer.appendChild(node);
            }
        });

        return outputContainer.innerHTML;
    }

    // Expose initialization function
    window.AppNotesManager = { initialize };

})(); // IIFE
