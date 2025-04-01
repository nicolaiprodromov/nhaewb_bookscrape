// electron_app/renderer_process/tracker-ui.js

// Assumes necessary DOM elements are globally available or passed in
// Requires: trackerCategoriesContainer, addCategoryBtn, statusBar, tabContentContainer, addStackLottieContainer
// Requires access to: AppUI.utils, AppUI.detailsOverlay.showDetailsOverlay, AppPanelManager, electronAPI

// --- State Variables ---
let trackerData = []; // Holds the main array of categories and books
let draggedItemInfo = null; // Info about the item being dragged (book node or category header)
let currentDragOverElement = null; // The specific drop zone being hovered over
const bookSpecsCache = new Map(); // Cache for fetched book specs { link -> specs }
const deleteConfirmTimers = new Map(); // Timers for category delete confirmation { categoryId -> timerId }
const DELETE_CONFIRM_TIMEOUT = 2500; // ms

// Color palette for categories
const categoryColorPalette = [
    { h: 210, s: 35, l: 48 }, { h: 160, s: 35, l: 42 }, { h: 30, s: 40, l: 48 },
    { h: 280, s: 25, l: 52 }, { h: 50, s: 45, l: 50 }, { h: 0, s: 40, l: 55 },
    { h: 100, s: 30, l: 48 }, { h: 240, s: 30, l: 55 }, { h: 180, s: 25, l: 45 }
];

/** Get a consistent color for a category based on its ID */
function getCategoryColorById(categoryId) {
    if (!categoryId) return categoryColorPalette[0]; // Default for safety
    const hash = window.AppUIUtils.simpleHash(categoryId);
    return categoryColorPalette[hash % categoryColorPalette.length];
}

// --- Core Data Persistence ---

/** Saves the current trackerData state to the main process */
async function saveTrackerData(operationDescription = 'save') {
    console.log(`[Tracker UI] Saving data via IPC (${operationDescription})...`);
    if(window.statusBar) window.statusBar.textContent = `Saving tracker (${operationDescription})...`;

    if (!window.electronAPI || typeof window.electronAPI.saveTrackedBooks !== 'function') {
        console.error("[Tracker UI] Cannot save: electronAPI.saveTrackedBooks not available.");
        if(window.statusBar) window.statusBar.textContent = 'Error: Save API unavailable!';
        alert("Error: Could not save tracker data (API missing).");
        return;
    }

    try {
        // Add specs from cache back into the data before saving
        const dataToSave = trackerData.map(category => ({
            id: category.id || window.AppUIUtils.generateUniqueId(), // Ensure ID exists
            name: category.name || "Untitled",
            isCollapsed: category.isCollapsed || false,
            books: category.books.map(book => {
                const cachedSpecs = bookSpecsCache.get(book.link);
                // Include specs only if they exist in the cache and are not errors
                return (cachedSpecs && !cachedSpecs.fetchError)
                    ? { ...book, specs: cachedSpecs }
                    : { ...book, specs: undefined }; // Ensure 'specs' field is removed if not available/cached
            })
        }));

        const success = await window.electronAPI.saveTrackedBooks(dataToSave);

        if (success) {
            const totalBooks = trackerData.reduce((sum, cat) => sum + (cat.books?.length || 0), 0);
            if(window.statusBar) window.statusBar.textContent = `Tracker saved: ${trackerData.length} stacks, ${totalBooks} items.`;
            applyTrackerColorsToBookList(); // Re-apply colors after save confirmation
        } else {
            console.error("[Tracker UI] IPC save reported failure.");
            if(window.statusBar) window.statusBar.textContent = 'Error saving tracker!';
            alert("Error: Could not save tracker data (Save failed).");
        }
    } catch (err) {
        console.error("[Tracker UI] Error during saveTrackerData:", err);
        if(window.statusBar) window.statusBar.textContent = 'Error saving tracker!';
        alert(`Error saving tracker data: ${err.message}`);
    }
}

/** Loads tracker data from main process and renders the UI */
async function loadAndDisplayTrackedItems() {
    console.log("[Tracker UI] Requesting tracker data load...");
     if(window.statusBar) window.statusBar.textContent = 'Loading tracker...';

    if (!window.electronAPI || typeof window.electronAPI.loadTrackedBooks !== 'function') {
        console.error("[Tracker UI] Cannot load: electronAPI.loadTrackedBooks not available.");
        if(window.statusBar) window.statusBar.textContent = 'Error: Load API unavailable!';
        trackerData = [{ id: window.AppUIUtils.generateUniqueId(), name: "Default (API Load Failed)", books: [], isCollapsed: false }];
        renderCategoriesAndBooks(); // Render default state
        return;
    }

    try {
        const loadedData = await window.electronAPI.loadTrackedBooks();
        console.log(`[Tracker UI] Received ${loadedData?.length ?? 0} categories from main process.`);

        // Reset cache before loading
        bookSpecsCache.clear();

        // Process loaded data, ensure defaults, cache specs
        trackerData = (Array.isArray(loadedData) && loadedData.length > 0)
            ? loadedData.map(cat => {
                const categoryId = cat.id || window.AppUIUtils.generateUniqueId();
                const books = (cat.books || []).map(b => {
                    // Populate cache from loaded data's 'specs' field
                    if (b.link && b.specs && typeof b.specs === 'object') {
                         // console.debug(`[Tracker Load] Caching specs for ${b.link}`);
                        bookSpecsCache.set(b.link, b.specs);
                    }
                    // Return book data *without* specs field for main state
                    return { ...b, specs: undefined };
                });
                return {
                    id: categoryId,
                    name: cat.name || "Untitled Stack",
                    isCollapsed: cat.isCollapsed || false,
                    books: books,
                    // Add color info during processing
                    color: getCategoryColorById(categoryId)
                };
            })
            : [{ // Default if loading fails or file is empty
                id: window.AppUIUtils.generateUniqueId(),
                name: "My First Stack",
                books: [],
                isCollapsed: false,
                color: getCategoryColorById(null) // Get default color
            }];

        renderCategoriesAndBooks(); // Render the UI based on processed data
        applyTrackerColorsToBookList(); // Apply colors to main book list

        const totalBooks = trackerData.reduce((sum, cat) => sum + (cat.books?.length || 0), 0);
        if(window.statusBar) window.statusBar.textContent = `Tracker Loaded: ${trackerData.length} stacks, ${totalBooks} items.`;
        console.log(`[Tracker UI] Load and render complete. Cache size: ${bookSpecsCache.size}`);

    } catch (err) {
        console.error("[Tracker UI] Error loading/processing tracker data:", err);
        if(window.statusBar) window.statusBar.textContent = 'Error loading tracker!';
        // Set a default state on error
        trackerData = [{ id: window.AppUIUtils.generateUniqueId(), name: "Default (Load Error)", books: [], isCollapsed: false, color: getCategoryColorById(null) }];
        renderCategoriesAndBooks();
        alert(`Failed to load tracker data: ${err.message}`);
    }
}


// --- UI Rendering ---

/** Renders all categories and their books based on the trackerData state */
function renderCategoriesAndBooks() {
    if (!window.trackerCategoriesContainer) return;

    // Preserve collapse state if possible (though loadAndDisplayTrackedItems should handle it)
    const currentCollapseStates = {};
    window.trackerCategoriesContainer.querySelectorAll('.tracker-category').forEach(el => {
        const id = el.dataset.categoryId;
        if (id) currentCollapseStates[id] = el.classList.contains('collapsed');
    });

    resetAllDeleteConfirmations(); // Clear any pending deletes before re-render
    window.trackerCategoriesContainer.innerHTML = ''; // Clear container

    if (!trackerData || trackerData.length === 0) {
        window.trackerCategoriesContainer.innerHTML = '<p class="tracker-node-placeholder">No stacks yet. Create one or drag books here!</p>';
        // Add drop handling to the main placeholder if needed (though usually handled by category drop zones)
        const placeholder = window.trackerCategoriesContainer.querySelector('.tracker-node-placeholder');
        if(placeholder) {
             placeholder.addEventListener('dragover', handleBookDragOverPlaceholder);
             placeholder.addEventListener('dragleave', handleBookDragLeavePlaceholder);
             placeholder.addEventListener('drop', handleBookDropInPlaceholder);
        }
        return;
    }

    // Add top drop zone for inserting at the beginning
    window.trackerCategoriesContainer.appendChild(createCategoryDropZoneElement(0));

    trackerData.forEach((categoryData, index) => {
        // Ensure data integrity before rendering
        if (!categoryData || typeof categoryData !== 'object') {
            console.warn(`[Tracker UI] Skipping invalid category data at index ${index}`);
            return;
        }
         // Apply preserved collapse state if it exists
         if (currentCollapseStates[categoryData.id] !== undefined) {
             categoryData.isCollapsed = currentCollapseStates[categoryData.id];
         }

        const categoryElement = createCategoryElement(categoryData, index);
        window.trackerCategoriesContainer.appendChild(categoryElement);

        // Add drop zone between categories
        window.trackerCategoriesContainer.appendChild(createCategoryDropZoneElement(index + 1));
    });
     // console.debug("[Tracker UI] Categories rendered.");
}


/** Creates a single category element (header and book container) */
function createCategoryElement(categoryData, index) {
    const categoryDiv = document.createElement('div');
    categoryDiv.className = `tracker-category${categoryData.isCollapsed ? ' collapsed' : ''}`;
    categoryDiv.dataset.categoryId = categoryData.id;
    // Apply color using HSLA and alpha variable from CSS
    if (categoryData.color) {
        const alpha = getComputedStyle(document.documentElement).getPropertyValue('--category-base-bg-alpha').trim() || 0.5;
        categoryDiv.style.backgroundColor = window.AppUIUtils.createHslaColor(categoryData.color, parseFloat(alpha));
    }

    // --- Category Header ---
    const headerDiv = document.createElement('div');
    headerDiv.className = 'category-header';
    headerDiv.draggable = true; // Enable dragging the category
    headerDiv.dataset.categoryId = categoryData.id; // For drag identification
    headerDiv.addEventListener('dragstart', handleCategoryDragStart);
    headerDiv.addEventListener('dragend', handleCategoryDragEnd);
    // Prevent drag starting on buttons/input
    headerDiv.addEventListener('mousedown', (e) => { if (e.target.closest('button, input')) { e.stopPropagation(); } }, true);


    // Collapse Button
    const collapseBtn = document.createElement('button');
    collapseBtn.className = 'collapse-category-btn';
    collapseBtn.innerHTML = categoryData.isCollapsed ? '▶' : '▼';
    collapseBtn.title = categoryData.isCollapsed ? 'Expand Stack' : 'Collapse Stack';
    collapseBtn.addEventListener('click', handleCategoryCollapseToggle);

    // View Details Button
    const viewBtn = document.createElement('button');
    viewBtn.className = 'view-category-btn';
    viewBtn.innerHTML = '👁️'; // Simple eye icon
    viewBtn.title = `View details for stack: ${categoryData.name || 'Unnamed'}`;
    viewBtn.addEventListener('click', (e) => {
        e.stopPropagation(); // Prevent header drag start
        const catId = categoryDiv.dataset.categoryId;
        const category = trackerData.find(c => c.id === catId);
        if (category && window.AppDetailsOverlay?.showDetailsOverlay) {
             // Pass a copy with type information
             window.AppDetailsOverlay.showDetailsOverlay({ type: 'category', ...category });
        } else {
             console.warn("Cannot show category details", category, window.AppDetailsOverlay);
        }
    });

    // Name Input
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'category-name-input';
    nameInput.value = categoryData.name || 'Unnamed Stack';
    nameInput.dataset.originalName = categoryData.name || 'Unnamed Stack';
    nameInput.placeholder = 'Stack Name';
    nameInput.title = 'Click to rename stack';
    nameInput.addEventListener('blur', handleCategoryRename);
    nameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); nameInput.blur(); } // Save on Enter
        else if (e.key === 'Escape') { nameInput.value = nameInput.dataset.originalName; nameInput.blur(); } // Cancel on Escape
    });
    nameInput.addEventListener('click', (e) => e.stopPropagation()); // Prevent header drag start

    // Delete Button
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'delete-category-btn';
    deleteBtn.innerHTML = '×';
    deleteBtn.title = 'Delete stack';
    deleteBtn.addEventListener('click', handleDeleteCategory);

    headerDiv.appendChild(collapseBtn);
    headerDiv.appendChild(viewBtn);
    headerDiv.appendChild(nameInput);
    headerDiv.appendChild(deleteBtn);

    // --- Books Container ---
    const booksContainer = document.createElement('div');
    booksContainer.className = 'category-books-container';
    booksContainer.dataset.categoryId = categoryData.id; // For drop identification

    // Event listeners for dropping books INTO this category
    booksContainer.addEventListener('dragover', handleBookDragOverCategory);
    booksContainer.addEventListener('dragleave', handleBookDragLeaveCategory);
    booksContainer.addEventListener('drop', handleBookDropInCategory);

    // Event listeners for reordering nodes WITHIN this category
    booksContainer.addEventListener('dragover', handleNodeDragOver); // Needs to check type
    booksContainer.addEventListener('dragleave', handleNodeDragLeave);
    booksContainer.addEventListener('drop', handleNodeDrop); // Needs to check type


    // Assemble Category Element
    categoryDiv.appendChild(headerDiv);
    categoryDiv.appendChild(booksContainer);

    // Render books *after* the container is created
    renderCategoryBooks(booksContainer, categoryData.books || [], categoryData.id, categoryData.color);

    return categoryDiv;
}

/** Renders the books (tracker nodes) inside a specific category container */
function renderCategoryBooks(containerElement, booksArray, categoryId, categoryColor) {
    if (!containerElement) return;
    containerElement.innerHTML = ''; // Clear previous nodes/placeholders

    // Add top drop zone for inserting at the beginning of the list
    containerElement.appendChild(createNodeDropZoneElement(categoryId, 0));

    if (!booksArray || booksArray.length === 0) {
        const placeholder = document.createElement('div');
        placeholder.className = 'tracker-node-placeholder';
        placeholder.textContent = '(Drag books here)';
        // Add drop listeners to the placeholder itself
        placeholder.addEventListener('dragover', handleBookDragOverCategory); // Reuse category dragover
        placeholder.addEventListener('dragleave', handleBookDragLeaveCategory);
        placeholder.addEventListener('drop', handleBookDropInCategory);
        containerElement.appendChild(placeholder);
    } else {
        booksArray.forEach((bookData, bookIndex) => {
            addSingleTrackerNodeElement(containerElement, bookData, categoryId, categoryColor);
            // Add drop zone between nodes
            containerElement.appendChild(createNodeDropZoneElement(categoryId, bookIndex + 1));
        });
    }
     // console.debug(`[Tracker UI] Rendered ${booksArray?.length ?? 0} books for Cat ${categoryId}`);
}

/** Creates and adds a single tracker node (book item) element */
function addSingleTrackerNodeElement(container, bookData, categoryId, categoryColor) {
    if (!bookData || (!bookData.title && !bookData.link)) {
        console.warn("[Tracker UI] Skipping node render, missing title/link:", bookData);
        return;
    }

    const node = document.createElement('div');
    node.className = 'tracker-node';
    node.draggable = true; // Enable dragging this node

    const nodeLink = bookData.link || `no-link-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    node.dataset.link = nodeLink; // Use link as identifier
    node.dataset.categoryId = categoryId; // Store parent category ID

    // Store base book data (used for details overlay, potentially drag)
     try { node.dataset.bookData = JSON.stringify(bookData); } catch(e) { node.dataset.bookData = '{}';}


    // Apply border color based on category
    if (categoryColor) {
        const alpha = getComputedStyle(document.documentElement).getPropertyValue('--node-border-alpha').trim() || 0.8;
        node.style.borderColor = window.AppUIUtils.createHslaColor(categoryColor, parseFloat(alpha));
    } else {
        node.style.borderColor = 'var(--border-color)'; // Fallback border
    }

    // Title Span
    const titleSpan = document.createElement('span');
    titleSpan.className = 'tracker-node-title';
    titleSpan.textContent = bookData.title || 'Untitled Book';
    titleSpan.title = bookData.title || 'Untitled Book'; // Tooltip for overflow

    // Controls (Remove Button)
    const controlsDiv = document.createElement('div');
    controlsDiv.className = 'tracker-node-controls';
    const removeBtn = document.createElement('button');
    removeBtn.className = 'remove-node-btn';
    removeBtn.innerHTML = '×';
    removeBtn.title = 'Remove from tracker';
    removeBtn.addEventListener('click', handleRemoveTrackedItem);
    controlsDiv.appendChild(removeBtn);

    node.appendChild(titleSpan);
    node.appendChild(controlsDiv);

    // Event listeners for dragging THIS node
    node.addEventListener('dragstart', handleNodeDragStart);
    node.addEventListener('dragend', handleNodeDragEnd);

    // Click opens details overlay (ignore clicks on the remove button)
    node.addEventListener('click', (e) => {
        if (!e.target.closest('.remove-node-btn')) {
            try {
                const bkData = JSON.parse(e.currentTarget.dataset.bookData || '{}');
                if (window.AppDetailsOverlay?.showDetailsOverlay) {
                     window.AppDetailsOverlay.showDetailsOverlay(bkData);
                }
            } catch(err) { console.error("[Tracker UI] Error parsing node data for details click:", err); }
        }
    });

    // Insert the node before the last element (which should be a drop zone)
    const lastElement = container.lastElementChild;
    if (lastElement?.classList.contains('drop-zone')) {
        container.insertBefore(node, lastElement);
    } else {
        // Fallback if container was empty or didn't end with drop zone
        container.appendChild(node);
    }
}

/** Creates a drop zone element for reordering nodes within a category */
function createNodeDropZoneElement(categoryId, insertAtIndex) {
    const zone = document.createElement('div');
    zone.className = 'drop-zone node-drop-zone'; // Specific class for node drops
    zone.dataset.categoryId = categoryId;
    zone.dataset.insertAtIndex = insertAtIndex;
    // Add listeners for dragover/leave/drop specific to NODE reordering
    zone.addEventListener('dragover', handleNodeDragOver);
    zone.addEventListener('dragleave', handleNodeDragLeave);
    zone.addEventListener('drop', handleNodeDrop);
    return zone;
}

/** Creates a drop zone element for reordering categories */
function createCategoryDropZoneElement(insertAtIndex) {
    const zone = document.createElement('div');
    zone.className = 'drop-zone category-drop-zone'; // Specific class for category drops
    zone.dataset.insertAtIndex = insertAtIndex;
    // Add listeners for dragover/leave/drop specific to CATEGORY reordering
    zone.addEventListener('dragover', handleCategoryDragOverContainer);
    zone.addEventListener('dragleave', handleCategoryDragLeaveContainer);
    zone.addEventListener('drop', handleCategoryDrop);
    return zone;
}

/** Applies tracker category colors to the main book list items */
function applyTrackerColorsToBookList() {
    if (!window.tabContentContainer) return;
    // console.debug("[Tracker UI] Applying tracker colors to main list...");
    const linkToColorMap = new Map();

    // Build map of link -> color string
    trackerData.forEach((category) => {
        if (category.id && category.books && category.color) {
            const alpha = getComputedStyle(document.documentElement).getPropertyValue('--book-item-border-alpha').trim() || 0.8;
            const colorString = window.AppUIUtils.createHslaColor(category.color, parseFloat(alpha));
            category.books.forEach(book => {
                if (book && book.link) {
                    linkToColorMap.set(book.link, colorString);
                }
            });
        }
    });

    // Apply colors to book items in the main list
    window.tabContentContainer.querySelectorAll('.book-item').forEach(item => {
        const link = item.dataset.bookLink;
        if (link && linkToColorMap.has(link)) {
            item.style.borderLeftColor = linkToColorMap.get(link);
            item.classList.add('tracked-by-category');
        } else {
            item.style.borderLeftColor = 'transparent'; // Reset if not tracked
            item.classList.remove('tracked-by-category');
        }
    });
}

/** Checks if a book link is already present in any tracker category */
function isDuplicateTrackedItem(link) {
    if (!link || typeof link !== 'string') return false;
    return trackerData.some(category =>
        category.books.some(book => book && book.link === link)
    );
}


// --- Category/Node Actions ---

/** Handles renaming a category */
async function handleCategoryRename(event) {
    const inputElement = event.target;
    const categoryElement = inputElement.closest('.tracker-category');
    const categoryId = categoryElement?.dataset.categoryId;

    // Reset delete confirmation on the sibling button if it exists
    const deleteButton = categoryElement?.querySelector('.delete-category-btn');
    if (deleteButton && categoryId) resetDeleteConfirmation(deleteButton, categoryId);

    if (!categoryId) {
        console.error("[Tracker UI] Cannot rename category: Missing ID.");
        inputElement.value = inputElement.dataset.originalName || ''; // Revert
        return;
    }

    const categoryIndex = trackerData.findIndex(c => c.id === categoryId);
    if (categoryIndex === -1) {
        console.error(`[Tracker UI] Category ${categoryId} not found in state for rename.`);
        inputElement.value = inputElement.dataset.originalName || ''; // Revert
        return;
    }

    const newName = inputElement.value.trim();
    const originalName = trackerData[categoryIndex].name;

    if (newName && newName !== originalName) {
        console.log(`[Tracker UI] Renaming category ${categoryId} from "${originalName}" to "${newName}"`);
        trackerData[categoryIndex].name = newName;
        inputElement.dataset.originalName = newName; // Update original name tracking

        // Update view button title
        const viewButton = categoryElement.querySelector('.view-category-btn');
        if (viewButton) viewButton.title = `View details for stack: ${newName}`;

        await saveTrackerData('rename category');
    } else {
        // Revert to original name if new name is empty or unchanged
        inputElement.value = originalName;
        if (newName !== originalName) console.log("[Tracker UI] Category rename cancelled (empty name).");
    }
}

/** Handles deleting a category with confirmation */
async function handleDeleteCategory(event) {
    event.stopPropagation(); // Prevent triggering header drag/collapse
    const deleteButton = event.currentTarget;
    const categoryElement = deleteButton.closest('.tracker-category');
    const categoryId = categoryElement?.dataset.categoryId;

    if (!categoryId || !deleteButton) {
        console.error("[Tracker UI] Cannot find category ID or button for deletion.");
        return;
    }

    const isPending = deleteButton.dataset.deletePending === 'true';

    if (isPending) {
        // --- Confirmed Delete ---
        console.log(`[Tracker UI] Deleting category confirmed: ${categoryId}`);
        resetDeleteConfirmation(deleteButton, categoryId); // Clear timer and style

        const categoryIndex = trackerData.findIndex(c => c.id === categoryId);
        if (categoryIndex === -1) {
            console.error(`[Tracker UI] Category ${categoryId} not found in state for deletion.`);
            categoryElement.remove(); // Remove from DOM anyway
            // Remove associated drop zone if it exists
            const prevDropZone = categoryElement.previousElementSibling;
            if (prevDropZone?.classList.contains('category-drop-zone')) prevDropZone.remove();
            return;
        }

        // Remove category from state
        const removedCategory = trackerData.splice(categoryIndex, 1)[0];

        // Remove specs for books in the deleted category from the cache
        if (removedCategory && removedCategory.books) {
            removedCategory.books.forEach(book => bookSpecsCache.delete(book.link));
             console.log(`[Tracker UI] Cleared specs cache for ${removedCategory.books.length} books from deleted stack.`);
        }

        // Remove category element and its preceding drop zone from DOM
        const prevDropZone = categoryElement.previousElementSibling;
        categoryElement.remove();
        if (prevDropZone?.classList.contains('category-drop-zone')) prevDropZone.remove();

        // Re-index remaining category drop zones
        window.trackerCategoriesContainer?.querySelectorAll('.drop-zone.category-drop-zone')
            .forEach((zone, index) => zone.dataset.insertAtIndex = index);

        // Show placeholder if no categories left
        if (trackerData.length === 0 && window.trackerCategoriesContainer) {
             renderCategoriesAndBooks(); // Re-render to show placeholder
        }

        await saveTrackerData('delete category');

    } else {
        // --- Initiate Confirmation ---
        console.log(`[Tracker UI] Initiating delete confirmation for: ${categoryId}`);
        resetAllDeleteConfirmations(deleteButton); // Reset others

        deleteButton.dataset.deletePending = 'true';
        deleteButton.classList.add('delete-pending');
        deleteButton.innerHTML = '?'; // Indicate pending state
        deleteButton.title = 'Click again to confirm deletion';

        // Set timeout to auto-cancel confirmation
        const timerId = setTimeout(() => {
            console.log(`[Tracker UI] Delete confirmation timed out for: ${categoryId}`);
            resetDeleteConfirmation(deleteButton, categoryId);
        }, DELETE_CONFIRM_TIMEOUT);
        deleteConfirmTimers.set(categoryId, timerId);
    }
}

/** Resets the delete confirmation state for a specific button */
function resetDeleteConfirmation(button, categoryId) {
    if (!button || !categoryId) return;
    const timerId = deleteConfirmTimers.get(categoryId);
    if (timerId) {
        clearTimeout(timerId);
        deleteConfirmTimers.delete(categoryId);
    }
    button.classList.remove('delete-pending');
    button.innerHTML = '×';
    button.title = 'Delete stack';
    delete button.dataset.deletePending; // Remove attribute
}

/** Resets all pending delete confirmations, optionally excluding one button */
function resetAllDeleteConfirmations(excludeButton = null) {
     if (!window.trackerCategoriesContainer) return;
    window.trackerCategoriesContainer.querySelectorAll('.delete-category-btn.delete-pending').forEach(btn => {
        if (btn !== excludeButton) {
            const catElement = btn.closest('.tracker-category');
            const catId = catElement?.dataset.categoryId;
            if (catId) resetDeleteConfirmation(btn, catId);
        }
    });
}

/** Handles collapsing/expanding a category */
function handleCategoryCollapseToggle(event) {
    event.stopPropagation(); // Prevent header drag
    const button = event.currentTarget;
    const categoryElement = button.closest('.tracker-category');
    const categoryId = categoryElement?.dataset.categoryId;

    if (!categoryElement || !categoryId) return;

    // Reset delete confirmation on the sibling button if active
    const deleteButton = categoryElement.querySelector('.delete-category-btn');
    if (deleteButton) resetDeleteConfirmation(deleteButton, categoryId);

    const category = trackerData.find(c => c.id === categoryId);
    if (!category) {
         console.error(`[Tracker UI] Category ${categoryId} not found for collapse toggle.`);
         return;
    }

    const isCollapsed = categoryElement.classList.toggle('collapsed');
    category.isCollapsed = isCollapsed; // Update state
    button.innerHTML = isCollapsed ? '▶' : '▼'; // Update icon
    button.title = isCollapsed ? 'Expand Stack' : 'Collapse Stack'; // Update title

    // Save the new collapse state (debounced save might be better if toggling rapidly)
    saveTrackerData('toggle collapse');
}

/** Handles removing a tracked item (book node) */
async function handleRemoveTrackedItem(event) {
    event.stopPropagation(); // Prevent node click/drag
    const nodeElement = event.target.closest('.tracker-node');
    const link = nodeElement?.dataset.link;
    const categoryElement = nodeElement?.closest('.tracker-category');
    const categoryId = categoryElement?.dataset.categoryId;

    if (!nodeElement || !link || !categoryId) {
        console.error("[Tracker UI] Cannot find info to remove tracked item.");
        return;
    }

    const categoryIndex = trackerData.findIndex(c => c.id === categoryId);
    if (categoryIndex === -1) {
        console.error(`[Tracker UI] Category ${categoryId} not found in state for item removal.`);
        nodeElement.remove(); // Remove from DOM anyway
        return;
    }

    const category = trackerData[categoryIndex];
    const bookIndex = category.books.findIndex(b => b && b.link === link);

    if (bookIndex > -1) {
        const removedTitle = category.books[bookIndex].title || 'Untitled Book';
        category.books.splice(bookIndex, 1); // Remove from state
        bookSpecsCache.delete(link); // Remove from specs cache
         console.log(`[Tracker UI] Removed "${removedTitle}" (link: ${link}) from stack "${category.name}". Cache cleared.`);

        // Re-render books for that category
        const booksContainer = categoryElement.querySelector('.category-books-container');
        if (booksContainer) {
            renderCategoryBooks(booksContainer, category.books, categoryId, category.color);
        } else {
            console.warn("[Tracker UI] Books container not found for re-render after removal.");
            renderCategoriesAndBooks(); // Fallback: re-render everything
        }

        await saveTrackerData('remove book');
    } else {
        console.warn(`[Tracker UI] Tracked item with link ${link} not found in state for category ${categoryId}. Removing from DOM only.`);
        nodeElement.remove(); // Remove inconsistent node from DOM
    }
}

/** Handles adding a new category */
async function handleAddCategory() {
    resetAllDeleteConfirmations(); // Ensure no pending deletes interfere

    const newCategory = {
        id: window.AppUIUtils.generateUniqueId(),
        name: `Stack ${trackerData.length + 1}`, // Default name
        books: [],
        isCollapsed: false,
        color: getCategoryColorById(null) // Assign a color (will cycle)
    };
    // Add color based on new ID before pushing
    newCategory.color = getCategoryColorById(newCategory.id);

    trackerData.push(newCategory); // Add to state

    // Re-render might be simpler than manually adding elements + drop zones
    renderCategoriesAndBooks();

    // Scroll to and focus the new category's name input
    const newCategoryElement = window.trackerCategoriesContainer?.querySelector(`.tracker-category[data-category-id="${newCategory.id}"]`);
    if (newCategoryElement) {
        newCategoryElement.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        const nameInput = newCategoryElement.querySelector('.category-name-input');
        if (nameInput) {
            // Brief delay to ensure element is fully rendered and focusable
            setTimeout(() => {
                nameInput.focus();
                nameInput.select(); // Select text for easy renaming
            }, 100);
        }
    }

    await saveTrackerData('add category');
     console.log(`[Tracker UI] Added new category: ${newCategory.id}`);
}

/** Creates the persistent Lottie animation in the header */
function createPersistentLottie() {
     if (!window.addStackLottieContainer) return;
     window.addStackLottieContainer.innerHTML = ''; // Clear previous
     const player = document.createElement('dotlottie-player');
     // Use a relevant Lottie animation - replace URL if needed
     player.setAttribute('src', 'https://lottie.host/38d4bace-34fa-46aa-b4ff-f3e36e529bbe/j1vcYhDIk7.lottie');
     player.setAttribute('autoplay', '');
     player.setAttribute('loop', '');
     player.setAttribute('background', 'transparent');
     player.setAttribute('speed', '0.8');
     player.title = "Add New Stack (Button Below)"; // Accessibility
     window.addStackLottieContainer.appendChild(player);
     console.log("[Tracker UI] Persistent header Lottie created.");
}


// --- Drag and Drop Logic ---

// --- Book Drag (From Main List to Category) ---

function handleBookDragOverCategory(event) {
    // Only allow drop if dragging a 'book' type from main list
    if (draggedItemInfo?.type === 'book') {
        event.preventDefault(); // Necessary to allow drop
        event.dataTransfer.dropEffect = 'copy'; // Indicate copying action
        // Highlight the category or placeholder
        event.currentTarget.classList.add('drag-over-books');
        currentDragOverElement = event.currentTarget; // Track current hover target
    }
}

function handleBookDragLeaveCategory(event) {
    // Remove highlight only if leaving the specific element that was highlighted
    if (currentDragOverElement === event.currentTarget && !event.currentTarget.contains(event.relatedTarget)) {
        event.currentTarget.classList.remove('drag-over-books');
        currentDragOverElement = null;
    }
}

async function handleBookDropInCategory(event) {
    if (draggedItemInfo?.type !== 'book') return; // Ensure correct drag type

    event.preventDefault();
    event.stopPropagation(); // Prevent drop bubbling further

    const dropTarget = event.currentTarget; // Could be category container or placeholder
    dropTarget.classList.remove('drag-over-books'); // Remove highlight
    currentDragOverElement = null;

    const categoryElement = dropTarget.closest('.tracker-category');
    const categoryId = categoryElement?.dataset.categoryId;

    if (!categoryId) {
        console.error("[Tracker UI] Invalid target category ID on book drop:", categoryId);
        clearDraggedItemInfo();
        return;
    }

    const categoryIndex = trackerData.findIndex(c => c.id === categoryId);
    if (categoryIndex === -1) {
        console.error(`[Tracker UI] Target category ${categoryId} not found in state on book drop.`);
        clearDraggedItemInfo();
        return;
    }

    let bookData;
    try {
        // Use data from global state if available, fallback to dataTransfer
        bookData = draggedItemInfo.data || JSON.parse(event.dataTransfer.getData('application/json'));
    } catch (err) {
        console.error("[Tracker UI] Error getting book data on drop:", err);
        clearDraggedItemInfo();
        return;
    }

    if (!bookData || !bookData.link) {
        console.warn("[Tracker UI] Invalid book data received on drop.");
        clearDraggedItemInfo();
        return;
    }

    // --- Duplicate Check ---
    if (isDuplicateTrackedItem(bookData.link)) {
        alert(`"${bookData.title || 'Book'}" is already being tracked.`);
        console.log(`[Tracker UI] Blocked duplicate book drop: ${bookData.link}`);
        clearDraggedItemInfo();
        return;
    }

    console.log(`[Tracker UI] Adding book "${bookData.title}" to category ${categoryId}`);

    // Add book to state (IMPORTANT: Add without 'specs' initially)
    const bookToAdd = { ...bookData, specs: undefined };
    trackerData[categoryIndex].books.push(bookToAdd);

    // Re-render the books within that category
    const booksContainer = categoryElement.querySelector('.category-books-container');
    if (booksContainer) {
        renderCategoryBooks(booksContainer, trackerData[categoryIndex].books, categoryId, trackerData[categoryIndex].color);
    } else {
        console.error("[Tracker UI] Cannot find books container to re-render after drop.");
        renderCategoriesAndBooks(); // Fallback full re-render
    }

    await saveTrackerData('add book');
    clearDraggedItemInfo(); // Clear global drag state
}

// --- Placeholder Drop (for adding to first category when empty) ---
function handleBookDragOverPlaceholder(event) {
     // Allow drop only if dragging a book and there's at least one category defined (even if empty)
    if (draggedItemInfo?.type === 'book' && trackerData.length > 0) {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
        event.currentTarget.classList.add('drag-over-books'); // Use same highlight
         currentDragOverElement = event.currentTarget;
    }
}
function handleBookDragLeavePlaceholder(event) {
    if (currentDragOverElement === event.currentTarget && !event.currentTarget.contains(event.relatedTarget)) {
        event.currentTarget.classList.remove('drag-over-books');
         currentDragOverElement = null;
    }
}
async function handleBookDropInPlaceholder(event) {
     if (draggedItemInfo?.type !== 'book' || trackerData.length === 0) return;
     event.preventDefault();
     event.stopPropagation();
     event.currentTarget.classList.remove('drag-over-books');
     currentDragOverElement = null;

     // Add the book to the *first* category in the trackerData array
     const firstCategoryId = trackerData[0].id;
     const firstCategoryIndex = 0; // Index is always 0 here

     let bookData;
     try { bookData = draggedItemInfo.data || JSON.parse(event.dataTransfer.getData('application/json')); }
     catch (err) { console.error("Err get data placeholder drop:", err); clearDraggedItemInfo(); return; }

     if (!bookData || !bookData.link) { console.warn("Invalid data placeholder drop."); clearDraggedItemInfo(); return; }
     if (isDuplicateTrackedItem(bookData.link)) { alert("Book already tracked."); clearDraggedItemInfo(); return; }

     console.log(`[Tracker UI] Adding book "${bookData.title}" to first category ${firstCategoryId} via placeholder.`);
     const bookToAdd = { ...bookData, specs: undefined };
     trackerData[firstCategoryIndex].books.push(bookToAdd);

     // Re-render all categories as the placeholder will be replaced
     renderCategoriesAndBooks();
     await saveTrackerData('add book placeholder');
     clearDraggedItemInfo();
}


// --- Node Drag (Reordering within a Category) ---

function handleNodeDragStart(event) {
    const node = event.target.closest('.tracker-node');
    const sourceCategoryId = node?.dataset.categoryId;
    const sourceLink = node?.dataset.link; // Use link as identifier

    if (!node || !sourceCategoryId || !sourceLink) {
        console.warn("[Tracker UI] Invalid node drag start.");
        event.preventDefault();
        return;
    }

    const sourceCategoryIndex = trackerData.findIndex(c => c.id === sourceCategoryId);
    if (sourceCategoryIndex === -1) {
        console.error(`[Tracker UI] Source category ${sourceCategoryId} not found for node drag start.`);
        event.preventDefault();
        return;
    }

    const sourceCategory = trackerData[sourceCategoryIndex];
    const sourceNodeIndex = sourceCategory.books.findIndex(b => b.link === sourceLink);
    if (sourceNodeIndex === -1) {
        console.error(`[Tracker UI] Book with link ${sourceLink} not found in category ${sourceCategoryId} for drag start.`);
        event.preventDefault();
        return;
    }

    // Set global drag state for node reordering
    setDraggedItemInfo({
        type: 'node',
        link: sourceLink,
        sourceCategoryId: sourceCategoryId,
        sourceNodeIndex: sourceNodeIndex,
        // Include basic book data for potential future cross-category drop
        data: { ...sourceCategory.books[sourceNodeIndex] }
    });

    event.dataTransfer.effectAllowed = 'move';
    try {
        // Set minimal data for compatibility, link is primary identifier
        event.dataTransfer.setData('text/plain', sourceLink);
    } catch (err) {
         console.warn("[Tracker UI] Could not set text dataTransfer for node drag.");
    }

    // Add dragging class slightly later to ensure it's applied
    setTimeout(() => node.classList.add('dragging'), 0);
     console.debug(`[Tracker UI] Node drag start: ${sourceLink} from Cat ${sourceCategoryId} (idx ${sourceNodeIndex})`);
}

function handleNodeDragEnd(event) {
    clearNodeDropZoneStyles(); // Clear highlights
    // Remove dragging class from the source node
    if (draggedItemInfo?.type === 'node' && draggedItemInfo.link) {
        // Find node potentially anywhere if drag failed or completed
        const node = window.trackerCategoriesContainer?.querySelector(`.tracker-node[data-link="${CSS.escape(draggedItemInfo.link)}"]`);
        node?.classList.remove('dragging');
    }
    clearDraggedItemInfo(); // Clear global state
     // console.debug("[Tracker UI] Node drag end.");
}

function clearNodeDropZoneStyles() {
     if (!window.trackerCategoriesContainer) return;
    window.trackerCategoriesContainer.querySelectorAll('.drop-zone.node-drop-zone.drag-over')
        .forEach(zone => zone.classList.remove('drag-over'));
    currentDragOverElement = null; // Reset tracker
}

function handleNodeDragOver(event) {
    // Only allow drop if dragging a 'node' type
    if (draggedItemInfo?.type !== 'node') return;

    const dropZone = event.target.closest('.drop-zone.node-drop-zone');
    if (!dropZone) {
        // If hovering over category container but not a zone, clear styles
        if (currentDragOverElement && event.target.classList.contains('category-books-container')) {
             clearNodeDropZoneStyles();
        }
        return; // Not a valid drop zone for nodes
    }

    const targetCategoryId = dropZone.dataset.categoryId;
    const sourceCategoryId = draggedItemInfo.sourceCategoryId;

    // --- IMPORTANT: Only allow drop within the SAME category for now ---
    if (!targetCategoryId || targetCategoryId !== sourceCategoryId) {
        // console.debug(`[Tracker UI] Node drag over different category (${targetCategoryId}) - disallowed.`);
        clearNodeDropZoneStyles(); // Clear any accidental highlights
        return; // Do not allow drop across categories yet
    }

    event.preventDefault(); // Allow drop
    event.dataTransfer.dropEffect = 'move'; // Indicate moving action

    // Highlight the specific drop zone
    if (currentDragOverElement !== dropZone) {
        clearNodeDropZoneStyles(); // Clear previous highlight
        dropZone.classList.add('drag-over');
        currentDragOverElement = dropZone;
    }
}

function handleNodeDragLeave(event) {
    if (draggedItemInfo?.type !== 'node') return;
    const zone = event.target.closest('.drop-zone.node-drop-zone');
    // Check if leaving the currently highlighted zone
    if (zone && zone === currentDragOverElement && !zone.contains(event.relatedTarget)) {
        zone.classList.remove('drag-over');
        currentDragOverElement = null;
    }
}

async function handleNodeDrop(event) {
    if (draggedItemInfo?.type !== 'node') return; // Ensure correct type

    event.preventDefault();
    event.stopPropagation(); // Prevent drop bubbling

    const dropZone = event.target.closest('.drop-zone.node-drop-zone');
    clearNodeDropZoneStyles(); // Clear highlights regardless of success

    if (!dropZone) {
        console.warn("[Tracker UI] Node drop occurred outside a valid node drop zone.");
        clearDraggedItemInfo();
        return;
    }

    const targetCategoryId = dropZone.dataset.categoryId;
    const insertAtIndex = parseInt(dropZone.dataset.insertAtIndex, 10);
    const sourceCategoryId = draggedItemInfo.sourceCategoryId;
    const sourceLink = draggedItemInfo.link;
    const sourceNodeIndex = draggedItemInfo.sourceNodeIndex;

    // Validate state
    if (!sourceLink || sourceCategoryId !== targetCategoryId || isNaN(insertAtIndex) || isNaN(sourceNodeIndex)) {
        console.warn("[Tracker UI] Node drop ignored due to invalid state:", { draggedItemInfo, targetCategoryId, insertAtIndex });
        clearDraggedItemInfo();
        return;
    }

    const categoryIndex = trackerData.findIndex(c => c.id === sourceCategoryId);
    if (categoryIndex === -1) {
        console.error(`[Tracker UI] Source category ${sourceCategoryId} not found in state for node drop.`);
        clearDraggedItemInfo();
        return;
    }

    const category = trackerData[categoryIndex];
    if (!Array.isArray(category.books)) {
        console.error(`[Tracker UI] Category ${sourceCategoryId} books array is invalid.`);
        clearDraggedItemInfo();
        return;
    }

    // Ensure source index is valid
    if (sourceNodeIndex < 0 || sourceNodeIndex >= category.books.length) {
         console.error(`[Tracker UI] Invalid source node index ${sourceNodeIndex} for category ${sourceCategoryId}.`);
         clearDraggedItemInfo();
         return;
    }

     // Ensure target index is valid (0 to length)
     if (insertAtIndex < 0 || insertAtIndex > category.books.length) {
         console.error(`[Tracker UI] Invalid target insert index ${insertAtIndex} for category ${sourceCategoryId}.`);
         clearDraggedItemInfo();
         return;
     }


    // --- Perform the reorder in the state array ---
    console.log(`[Tracker UI] Reordering node "${sourceLink}" (idx ${sourceNodeIndex}) to index ${insertAtIndex} in Cat ${sourceCategoryId}`);

    // Remove the item from its original position
    const [itemToMove] = category.books.splice(sourceNodeIndex, 1);

    if (!itemToMove) {
         console.error(`[Tracker UI] Failed to splice item at index ${sourceNodeIndex} for reorder.`);
         // Attempt to re-render to fix potential inconsistencies
         renderCategoriesAndBooks();
         clearDraggedItemInfo();
         return;
    }

    // Adjust insertion index if the removal affected it
    const adjustedInsertIndex = (sourceNodeIndex < insertAtIndex) ? insertAtIndex - 1 : insertAtIndex;

    // Insert the item at the new position
    category.books.splice(adjustedInsertIndex, 0, itemToMove);


    // Re-render the books within that category
    const booksContainer = window.trackerCategoriesContainer?.querySelector(`.tracker-category[data-category-id="${sourceCategoryId}"] .category-books-container`);
    if (booksContainer) {
        renderCategoryBooks(booksContainer, category.books, sourceCategoryId, category.color);
    } else {
        console.error("[Tracker UI] Cannot find books container to re-render after node reorder.");
        renderCategoriesAndBooks(); // Fallback full re-render
    }

    await saveTrackerData('reorder book');
    clearDraggedItemInfo(); // Clear global state
}


// --- Category Drag (Reordering Categories) ---

function handleCategoryDragStart(event) {
    // Prevent starting drag on interactive elements within the header
    if (event.target.closest('button, input')) {
        event.preventDefault();
        return;
    }

    const header = event.target.closest('.category-header');
    const categoryElement = header?.closest('.tracker-category');
    const sourceCategoryId = categoryElement?.dataset.categoryId;

    if (!header || !categoryElement || !sourceCategoryId) {
        console.warn("[Tracker UI] Invalid category drag start.");
        event.preventDefault();
        return;
    }

    const sourceIndex = trackerData.findIndex(c => c.id === sourceCategoryId);
    if (sourceIndex === -1) {
        console.error(`[Tracker UI] Source category ${sourceCategoryId} not found in state for drag start.`);
        event.preventDefault();
        return;
    }

    resetAllDeleteConfirmations(); // Don't allow dragging with pending delete

    // Set global drag state for category reordering
    setDraggedItemInfo({
        type: 'category',
        sourceCategoryId: sourceCategoryId,
        sourceIndex: sourceIndex
    });

    event.dataTransfer.effectAllowed = 'move';
    try {
        // Set minimal data for compatibility
        event.dataTransfer.setData('text/plain', `category-${sourceCategoryId}`);
    } catch (err) {
         console.warn("[Tracker UI] Could not set text dataTransfer for category drag.");
    }

    // Make drop zones visible and apply dragging style to source category
     if (window.trackerCategoriesContainer) {
        window.trackerCategoriesContainer.querySelectorAll('.drop-zone.category-drop-zone')
            .forEach(zone => zone.classList.add('visible'));
     }
    setTimeout(() => {
        categoryElement.classList.add('dragging');
        header.classList.add('dragging'); // Style header too if needed
    }, 0);
     console.debug(`[Tracker UI] Category drag start: ${sourceCategoryId} (idx ${sourceIndex})`);
}

function handleCategoryDragEnd(event) {
    // Remove dragging class and hide drop zones
    if (draggedItemInfo?.type === 'category') {
        const sourceId = draggedItemInfo.sourceCategoryId;
         if (window.trackerCategoriesContainer) {
             const categoryElement = window.trackerCategoriesContainer.querySelector(`.tracker-category[data-category-id="${sourceId}"]`);
             categoryElement?.classList.remove('dragging');
             categoryElement?.querySelector('.category-header')?.classList.remove('dragging');
         }
    }
    clearCategoryDropZoneStyles(); // Hide and clear highlights
    clearDraggedItemInfo(); // Clear global state
     // console.debug("[Tracker UI] Category drag end.");
}

function clearCategoryDropZoneStyles() {
     if (!window.trackerCategoriesContainer) return;
    window.trackerCategoriesContainer.querySelectorAll('.drop-zone.category-drop-zone')
        .forEach(zone => zone.classList.remove('visible', 'drop-target-highlight'));
    currentDragOverElement = null; // Reset tracker
}

function handleCategoryDragOverContainer(event) {
    // Only allow drop if dragging a 'category' type
    if (draggedItemInfo?.type !== 'category') return;

    const dropZone = event.target.closest('.drop-zone.category-drop-zone.visible');
    if (!dropZone) {
         // Clear highlight if moving off a zone
         if (currentDragOverElement) {
            currentDragOverElement.classList.remove('drop-target-highlight');
            currentDragOverElement = null;
         }
        return; // Not a valid drop zone or not visible
    }

    event.preventDefault(); // Allow drop
    event.dataTransfer.dropEffect = 'move';

    // Highlight the specific drop zone being hovered over
    if (currentDragOverElement !== dropZone) {
        if (currentDragOverElement) currentDragOverElement.classList.remove('drop-target-highlight'); // Clear previous
        dropZone.classList.add('drop-target-highlight');
        currentDragOverElement = dropZone;
    }
}

function handleCategoryDragLeaveContainer(event) {
    if (draggedItemInfo?.type !== 'category') return;
    const zone = event.target.closest('.drop-zone.category-drop-zone.visible');
    // Determine if the mouse actually left the highlighted zone for good
    const relatedTarget = event.relatedTarget ? event.relatedTarget.closest('.drop-zone.category-drop-zone.visible') : null;
    if (currentDragOverElement && currentDragOverElement === zone && currentDragOverElement !== relatedTarget) {
        currentDragOverElement.classList.remove('drop-target-highlight');
        currentDragOverElement = null;
    }
}

async function handleCategoryDrop(event) {
    if (draggedItemInfo?.type !== 'category') return;

    event.preventDefault();
    event.stopPropagation();

    const dropZone = event.target.closest('.drop-zone.category-drop-zone.visible');
    clearCategoryDropZoneStyles(); // Hide zones and clear highlights

    if (!dropZone) {
        console.warn("[Tracker UI] Category drop occurred outside a valid category drop zone.");
        clearDraggedItemInfo();
        return;
    }

    const targetInsertIndex = parseInt(dropZone.dataset.insertAtIndex, 10);
    const sourceIndex = draggedItemInfo.sourceIndex;
    const sourceId = draggedItemInfo.sourceCategoryId;
    const localDragInfo = { ...draggedItemInfo }; // Copy info before clearing
    clearDraggedItemInfo(); // Clear global state

    // Validate state
    if (isNaN(targetInsertIndex) || sourceIndex == null || isNaN(sourceIndex) || !sourceId) {
        console.warn("[Tracker UI] Category drop ignored due to invalid state:", localDragInfo);
        return;
    }

    // No change if dropped in the same position or the position immediately after
    if (targetInsertIndex === sourceIndex || targetInsertIndex === sourceIndex + 1) {
        console.log("[Tracker UI] Category drop resulted in no change.");
         // Still might need to re-render if classes were added/removed incorrectly
         renderCategoriesAndBooks();
        return;
    }

    console.log(`[Tracker UI] Reordering category ${sourceId} from index ${sourceIndex} to insert at ${targetInsertIndex}`);

    // --- Perform reorder in the state array ---
    const [categoryToMove] = trackerData.splice(sourceIndex, 1);

    if (!categoryToMove) {
        console.error(`[Tracker UI] Failed to splice category at index ${sourceIndex} for reorder!`);
        renderCategoriesAndBooks(); // Re-render to restore consistency
        return;
    }

    // Adjust insertion index based on whether the item was moved from before or after the target
    const adjustedInsertIndex = (sourceIndex < targetInsertIndex) ? targetInsertIndex - 1 : targetInsertIndex;

    trackerData.splice(adjustedInsertIndex, 0, categoryToMove);

    // Re-render the entire category list to reflect the new order
    renderCategoriesAndBooks();

    await saveTrackerData('reorder category');
}


// --- Global Drag State Management ---

function setDraggedItemInfo(info) {
    draggedItemInfo = info;
    // console.debug("[Draggable State] Set:", draggedItemInfo);
}

function clearDraggedItemInfo() {
    // console.debug("[Draggable State] Cleared. Was:", draggedItemInfo);
    draggedItemInfo = null;
}


// --- Initialization ---
function setupTrackerEventListeners() {
    if (!window.addCategoryBtn) {
         console.error("[Tracker UI] Cannot setup listeners - Add Category Button missing.");
         return;
    }
    window.addCategoryBtn.addEventListener('click', handleAddCategory);
     // Global listener to reset delete confirmations if clicking outside relevant buttons
     document.body.addEventListener('click', (event) => {
         if (!event.target.closest('.delete-category-btn')) {
             resetAllDeleteConfirmations();
         }
     }, true); // Use capture phase
     console.log("[Tracker UI] Event listeners setup.");
}

// Export functions/state needed by other modules
window.AppTrackerUI = {
    initialize: async () => {
        createPersistentLottie();
        setupTrackerEventListeners();
        await loadAndDisplayTrackedItems(); // Load data and render initial UI
    },
    trackerData, // Expose state (use with caution)
    bookSpecsCache, // Expose cache
    saveTrackerData, // Expose save function if needed by price tracker?
    loadAndDisplayTrackedItems, // Expose load function
    applyTrackerColorsToBookList, // For book list manager
    // Drag state functions (used internally by book-list-manager and tracker-ui)
    setDraggedItemInfo,
    clearDraggedItemInfo
};
console.log("[Tracker UI] Module loaded.");
