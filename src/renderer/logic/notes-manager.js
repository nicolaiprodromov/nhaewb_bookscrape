// src/renderer/logic/notes-manager.js
// Handles Notes panel logic: parsing indentation, markdown rendering, collapsing, persistence.

// Assumes necessary DOM elements (window.*), Marked library, and AppTrackerUI (for Lottie) are available.

(function() {
    const NOTES_STORAGE_KEY = 'appNotesContent';
    const COLLAPSE_STATE_KEY = 'appNotesCollapseState';
    const RENDER_DEBOUNCE_MS = 250; // Debounce Markdown rendering/saving

    let renderDebounceTimer = null;
    let notesTextarea, notesPreview; // Assigned in initialize

    // Store collapsed state by node ID (generated during parsing)
    let collapsedNodes = new Set();

    /**
     * Initializes the Notes Manager.
     */
    function initialize() {
        console.log("[Notes Manager] Initializing...");
        notesTextarea = window.notesTextarea;
        notesPreview = window.notesPreview;

        if (!notesTextarea || !notesPreview) {
            console.error("[Notes Manager] Fatal: Textarea or Preview element not found.");
            return; // Stop initialization if elements are missing
        }
        if (typeof marked === 'undefined') {
            console.error("[Notes Manager] Fatal: Marked library not loaded.");
            notesPreview.innerHTML = '<p class="error-message">Error: Markdown library failed to load.</p>';
            notesTextarea.disabled = true;
            return;
        }

        // Create Lottie animation in header (reuse function from Tracker UI)
        if (window.AppTrackerUI?.createHeaderLottie) {
            window.AppTrackerUI.createHeaderLottie(
                'notes-lottie-container', // Container ID for notes
                'https://lottie.host/09161c5a-4b8f-499e-ac79-3d86f3d1d6ea/s81A6BbO3u.lottie', // Example notes/edit Lottie
                'Notes Panel'
            );
        }

        loadNotes();
        loadCollapseState();
        renderNotePreview(); // Initial render

        notesTextarea.addEventListener('input', handleInput);
        // Add click listener to the preview area for handling collapse toggles
        notesPreview.addEventListener('click', handlePreviewClick);

        console.log("[Notes Manager] Initialization complete.");
    }

    /**
     * Handles input events on the textarea, debouncing the rendering.
     */
    function handleInput() {
        clearTimeout(renderDebounceTimer);
        renderDebounceTimer = setTimeout(() => {
            renderNotePreview();
            saveNotes();
            // Saving collapse state isn't strictly needed on text input,
            // but could be done here if IDs might change frequently.
        }, RENDER_DEBOUNCE_MS);
    }

    /**
     * Handles clicks within the preview area, specifically for toggles.
     */
    function handlePreviewClick(event) {
        const toggle = event.target.closest('.note-node-toggle');
        if (!toggle) return; // Exit if click wasn't on a toggle

        const nodeElement = toggle.closest('.note-node');
        const nodeId = nodeElement?.dataset.nodeId;

        if (nodeElement && nodeId) {
            nodeElement.classList.toggle('collapsed');
            const isCollapsed = nodeElement.classList.contains('collapsed');

            if (isCollapsed) {
                collapsedNodes.add(nodeId);
                toggle.textContent = 'â–¶'; // Collapsed indicator
            } else {
                collapsedNodes.delete(nodeId);
                toggle.textContent = 'â–¼'; // Expanded indicator
            }
            saveCollapseState(); // Persist the change
        }
    }

    /**
     * Loads notes content from localStorage.
     */
    function loadNotes() {
        try {
            const savedNotes = localStorage.getItem(NOTES_STORAGE_KEY);
            if (savedNotes !== null) {
                notesTextarea.value = savedNotes;
                console.log("[Notes Manager] Loaded notes from localStorage.");
            } else {
                 console.log("[Notes Manager] No saved notes found.");
            }
        } catch (e) {
            console.error("[Notes Manager] Error loading notes from localStorage:", e);
            // Optionally show an error to the user
        }
    }

    /**
     * Saves notes content to localStorage.
     */
    function saveNotes() {
        try {
            localStorage.setItem(NOTES_STORAGE_KEY, notesTextarea.value);
            // console.debug("[Notes Manager] Saved notes to localStorage.");
        } catch (e) {
            console.error("[Notes Manager] Error saving notes to localStorage:", e);
            // Optionally show an error to the user
        }
    }

    /**
     * Loads collapsed node state from localStorage.
     */
    function loadCollapseState() {
         try {
             const savedState = localStorage.getItem(COLLAPSE_STATE_KEY);
             if (savedState) {
                 collapsedNodes = new Set(JSON.parse(savedState));
                 console.log(`[Notes Manager] Loaded ${collapsedNodes.size} collapsed node states.`);
             } else {
                 collapsedNodes = new Set(); // Initialize if nothing saved
             }
         } catch (e) {
             console.error("[Notes Manager] Error loading collapse state:", e);
             collapsedNodes = new Set(); // Reset on error
         }
     }

    /**
     * Saves collapsed node state to localStorage.
     */
    function saveCollapseState() {
        try {
            localStorage.setItem(COLLAPSE_STATE_KEY, JSON.stringify(Array.from(collapsedNodes)));
            // console.debug("[Notes Manager] Saved collapse state.");
        } catch (e) {
            console.error("[Notes Manager] Error saving collapse state:", e);
        }
    }

    /**
     * Parses the indented text from the textarea into a tree structure.
     * Uses 2 spaces per indent level.
     * @returns {Array<object>} An array of root node objects.
     */
    function parseIndentedText() {
        const lines = notesTextarea.value.split('\n');
        const rootNodes = [];
        const nodeStack = [{ level: -1, node: { children: rootNodes } }]; // Stack to track parent nodes
        const indentSize = 2; // Number of spaces per indent level

        lines.forEach((line, index) => {
            const leadingSpaces = line.match(/^ */)[0].length;
            const currentLevel = Math.floor(leadingSpaces / indentSize);
            const content = line.trim();

            // Create a unique ID for the node (simple approach based on index and level)
            const nodeId = `note-${index}-${currentLevel}`;

            // Ignore empty lines unless they are the only content of a node (handled by content check)
            if (content === '' && currentLevel === 0 && nodeStack.length === 1) return;

            const newNode = {
                id: nodeId,
                text: content,
                level: currentLevel,
                children: []
            };

            // Find the correct parent based on indentation level
            while (nodeStack[nodeStack.length - 1].level >= currentLevel) {
                nodeStack.pop(); // Go up the hierarchy
            }

            // Add the new node to the children of the current parent
            const parentNode = nodeStack[nodeStack.length - 1].node;
            if(parentNode) {
                 parentNode.children.push(newNode);
            } else {
                 console.warn(`[Notes Manager] Could not find parent for line ${index + 1}. Adding to root.`);
                 rootNodes.push(newNode); // Fallback: add to root
            }


            // Push the new node onto the stack as a potential parent for subsequent lines
            nodeStack.push({ level: currentLevel, node: newNode });
        });

        return rootNodes;
    }

    /**
     * Renders the parsed note tree into the preview div.
     */
    function renderNotePreview() {
        if (!notesPreview || typeof marked === 'undefined') return;

        const noteTree = parseIndentedText();
        const html = renderNodeTreeToHtml(noteTree);
        notesPreview.innerHTML = html;
         // console.debug("[Notes Manager] Rendered notes preview.");
    }

    /**
     * Recursively renders the node tree into an HTML string.
     * @param {Array<object>} nodes - The array of nodes to render.
     * @returns {string} The generated HTML.
     */
    function renderNodeTreeToHtml(nodes) {
        let html = '';
        if (!nodes || nodes.length === 0) return '';

        nodes.forEach(node => {
            const hasChildren = node.children && node.children.length > 0;
            const isCollapsed = collapsedNodes.has(node.id);
            const collapsedClass = isCollapsed ? ' collapsed' : '';
            const noChildrenClass = !hasChildren ? ' no-children' : '';

            // Use marked to render the node's text content as Markdown inline
            // Ensure GFM breaks are enabled for line breaks within a node if needed
            const renderedContent = marked.parseInline(node.text || '', { breaks: true });

            html += `<div class="note-node${collapsedClass}${noChildrenClass}" data-node-id="${node.id}">`;
            html += `<div class="note-node-header">`; // Wrapper for toggle and content
            // Add toggle button - content depends on collapsed state and if it has children
            html += `<span class="note-node-toggle">${hasChildren ? (isCollapsed ? 'â–¶' : 'â–¼') : ''}</span>`;
            // Wrap content in a span for easier styling/selection if needed
            html += `<span class="note-node-content">${renderedContent}</span>`;
            html += `</div>`; // End note-node-header

            if (hasChildren) {
                html += `<div class="note-node-children">`;
                html += renderNodeTreeToHtml(node.children); // Recursively render children
                html += `</div>`;
            }
            html += `</div>`; // End note-node
        });

        return html;
    }


    // Expose initialization function
    window.AppNotesManager = {
        initialize
    };

})(); // IIFE
