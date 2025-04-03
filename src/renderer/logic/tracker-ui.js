// src/renderer/logic/tracker-ui.js

// Assumes necessary DOM elements (window.*), electronAPI, AppUIUtils are globally available via renderer.js
// Assumes AppPanelManager, AppDetailsOverlay, AppRuntime are globally available
// Assumes Chart.js is loaded globally (though not directly used here, details-overlay uses its data)

let trackerData = []; // Holds the array of category objects [{id, name, books:[...], isCollapsed, color}, ...]
let draggedItemInfo = null; // Info about the item being dragged {type, data, link?, sourceCategoryId?, ...}
let currentDragOverElement = null; // Tracks the element currently being dragged over for styling exit correctly

// Central cache for book specifications (details) fetched via IPC
const bookSpecsCache = new Map(); // Map<bookLink, specsObject | errorObject>

// Map to store timers for delete confirmations (key: categoryId, value: timerId)
const deleteConfirmTimers = new Map();
const DELETE_CONFIRM_TIMEOUT = 3000; // 3 seconds to confirm delete

// Price Checking State
let priceCheckIntervalId = null;
const BOOST_DURATION_MS = 5 * 60 * 1000;   // Check frequently for 5 minutes after app start
const BOOST_INTERVAL_MS = 1 * 60 * 1000;   // Check every 1 minute during boost
const NORMAL_INTERVAL_MS = 30 * 60 * 1000; // Check every 30 minutes normally
let appStartTime = Date.now();
let isCurrentlyCheckingPrices = false;

// Color palette for categories (ensure good contrast and distinctiveness)
// Using HSL values for easier manipulation (e.g., adjusting lightness/saturation for backgrounds)
const categoryColorPalette = [
    { h: 210, s: 55, l: 55 }, { h: 160, s: 50, l: 48 }, { h: 30, s: 60, l: 50 },
    { h: 280, s: 40, l: 58 }, { h: 50, s: 65, l: 52 }, { h: 0, s: 55, l: 60 },
    { h: 100, s: 45, l: 50 }, { h: 240, s: 45, l: 60 }, { h: 180, s: 40, l: 45 },
    { h: 330, s: 50, l: 55 }, { h: 130, s: 48, l: 52 }, { h: 260, s: 50, l: 56 }
];

/** Generates a color from the palette based on category ID */
function getCategoryColorById(categoryId) {
    if (!categoryId) return categoryColorPalette[0]; // Default color
    // Use a simple hash function (from ui-utils) to pick a color somewhat consistently
    const hash = window.AppUIUtils.simpleHash(categoryId);
    return categoryColorPalette[hash % categoryColorPalette.length];
}

/** Loads tracked items from main process and renders the UI */
async function loadAndDisplayTrackedItems() {
    console.log("[Tracker UI] Requesting tracker data load via IPC...");
    if(window.statusBar) window.statusBar.textContent = 'Loading tracker data...';
    resetAllDeleteConfirmations(); // Clear any pending confirms before reload

    // Check if electronAPI is available
    if (!window.electronAPI?.loadTrackedBooks) {
        console.error("[Tracker UI] Cannot load: electronAPI.loadTrackedBooks is unavailable.");
        if(window.statusBar) window.statusBar.textContent = 'Error: Tracker load API unavailable!';
        // Provide minimal default state if API fails
        trackerData = [{
            id: window.AppUIUtils.generateUniqueId(),
            name:"Default Stack (API Load Failed)",
            books:[],
            isCollapsed:false,
            color: getCategoryColorById(null) // Assign default color
        }];
        renderCategoriesAndBooks(); // Render the default state
        stopPriceCheckingInterval(); // Stop price checks if loading failed
        return;
    }

    try {
        // Call IPC handler to load data
        const loadedData = await window.electronAPI.loadTrackedBooks();
        console.log(`[Tracker UI] Received ${loadedData?.length ?? 0} categories from main process.`);
        bookSpecsCache.clear(); // Clear old specs cache on reload

        // Process loaded data or create default if empty/invalid
        if (Array.isArray(loadedData) && loadedData.length > 0) {
            trackerData = loadedData.map(cat => {
                // Ensure each category has necessary fields and structure
                const id = cat.id || window.AppUIUtils.generateUniqueId(); // Generate ID if missing
                const name = cat.name || "Untitled Stack";
                const isCollapsed = cat.isCollapsed === true; // Default to false if missing/invalid
                const color = cat.color || getCategoryColorById(id); // Assign color if missing

                // Process books within the category
                const books = (Array.isArray(cat.books) ? cat.books : []).map(b => {
                    if (!b || typeof b !== 'object' || !b.link) return null; // Skip invalid book entries, ensure link exists
                    // Cache specs if they exist in the loaded data and are valid
                    if (b.link && b.specs && !b.specs.fetchError) {
                        bookSpecsCache.set(b.link, b.specs);
                    }
                    // Return book structure for UI state (exclude specs here)
                    return {
                        link: b.link,
                        title: b.title,
                        current_price: b.current_price,
                        old_price: b.old_price,
                        voucher_price: b.voucher_price,
                        voucher_code: b.voucher_code,
                        local_image_filename: b.local_image_filename,
                        // Ensure priceHistory is always an array, sort by timestamp ascending
                        priceHistory: Array.isArray(b.priceHistory) ? b.priceHistory.sort((a,b) => a.timestamp - b.timestamp) : []
                        // specs are handled by the cache, not stored directly in UI state
                    };
                }).filter(b => b !== null); // Filter out invalid/skipped books

                return { id, name, isCollapsed, books, color };
            });
        } else {
            // If loaded data is empty or not an array, create a default stack
            console.log("[Tracker UI] No valid tracker data loaded, creating default stack.");
             trackerData = [{
                 id: window.AppUIUtils.generateUniqueId(),
                 name:"My First Stack",
                 books:[],
                 isCollapsed:false,
                 color: getCategoryColorById(null) // Assign default color
             }];
        }

        renderCategoriesAndBooks(); // Render the categories and their books
        applyTrackerColorsToBookList(); // Update book list item borders

        const totalBooks = trackerData.reduce((sum, cat) => sum + (cat.books?.length || 0), 0);
        if(window.statusBar) window.statusBar.textContent = `Tracker Loaded: ${trackerData.length} stacks, ${totalBooks} items.`;
        console.log(`[Tracker UI] Load complete. Specs cache size: ${bookSpecsCache.size}`);

        startPriceCheckingInterval(); // Start or reschedule price checks

    } catch (err) {
        console.error("[Tracker UI] Error loading/processing tracker data:", err);
        if(window.statusBar) window.statusBar.textContent = 'Error loading tracker data!';
        // Fallback to default state on error
        trackerData = [{
            id: window.AppUIUtils.generateUniqueId(),
            name:"Default Stack (Load Error)",
            books:[],
            isCollapsed:false,
             color: getCategoryColorById(null)
        }];
        renderCategoriesAndBooks();
        alert(`Failed to load tracker data: ${err.message}`); // Notify user
        stopPriceCheckingInterval();
    }
}

/** Saves the current tracker state (trackerData) to the main process */
async function saveTrackerData(operationDescription = 'save') {
    console.log(`[Tracker UI] Preparing to save data via IPC (${operationDescription})...`);
    if(window.statusBar) window.statusBar.textContent = `Saving tracker (${operationDescription})...`;

    // Check if electronAPI is available
    if (!window.electronAPI?.saveTrackedBooks) {
        console.error("[Tracker UI] Cannot save: electronAPI.saveTrackedBooks unavailable.");
        if(window.statusBar) window.statusBar.textContent = 'Error: Save API unavailable!';
        alert("Error: Could not save tracker data (API not found).");
        return;
    }

    try {
        // Prepare the data structure for saving (include specs from cache)
        const dataToSave = trackerData.map(cat => ({
            id: cat.id || window.AppUIUtils.generateUniqueId(), // Ensure ID exists
            name: cat.name || "Untitled Stack",
            isCollapsed: cat.isCollapsed === true,
            color: cat.color || getCategoryColorById(cat.id), // Ensure color exists
            books: cat.books.map(book => {
                const specs = bookSpecsCache.get(book.link);
                // Create book object for saving
                const savedBook = {
                    link: book.link,
                    title: book.title,
                    current_price: book.current_price,
                    old_price: book.old_price,
                    voucher_price: book.voucher_price,
                    voucher_code: book.voucher_code,
                    local_image_filename: book.local_image_filename,
                    // Include specs only if they are valid and not an error object
                    specs: (specs && !specs.fetchError) ? specs : undefined,
                    // Ensure price history is saved correctly, sorted
                    priceHistory: Array.isArray(book.priceHistory) ? book.priceHistory.sort((a,b) => a.timestamp - b.timestamp) : []
                };
                // Remove specs property entirely if it's undefined to keep JSON clean
                if (savedBook.specs === undefined) {
                    delete savedBook.specs;
                }
                return savedBook;
            })
        }));

        // Call IPC handler to save data
        const success = await window.electronAPI.saveTrackedBooks(dataToSave);

        if (success) {
            const totalBooks = trackerData.reduce((sum, cat) => sum + (cat.books?.length || 0), 0);
            if(window.statusBar) window.statusBar.textContent = `Tracker saved: ${trackerData.length} stacks, ${totalBooks} items.`;
            console.log(`[Tracker UI] Save successful (${operationDescription}).`);
            applyTrackerColorsToBookList(); // Refresh book list borders after save
        } else {
            // Main process should have shown an error dialog if saving failed
            console.error("[Tracker UI] IPC save operation reported failure.");
            if(window.statusBar) window.statusBar.textContent = 'Error saving tracker!';
        }
    } catch (err) {
        console.error("[Tracker UI] Error during saveTrackerData preparation or IPC call:", err);
        if(window.statusBar) window.statusBar.textContent = 'Error saving tracker!';
        alert(`An error occurred while trying to save tracker data: ${err.message}`);
    }
}


// --- Rendering Functions ---

/** Renders all categories and their books into the container */
function renderCategoriesAndBooks() {
    if (!window.trackerCategoriesContainer) { console.error("[Tracker UI] Cannot render: trackerCategoriesContainer not found."); return; }
    resetAllDeleteConfirmations();
    window.trackerCategoriesContainer.innerHTML = '';

    if (!trackerData || trackerData.length === 0) {
        window.trackerCategoriesContainer.innerHTML = '<p class="tracker-node-placeholder">No stacks defined. Click "New Stack" or drag books here to start tracking!</p>';
        return;
    }

    window.trackerCategoriesContainer.appendChild(createCategoryDropZoneElement(0));
    trackerData.forEach((category, index) => {
        if (!category || typeof category !== 'object' || !category.id) { console.warn(`[Tracker UI] Skipping render of invalid category at index ${index}:`, category); return; }
        if (!category.color) { category.color = getCategoryColorById(category.id); }
        const categoryElement = createCategoryElement(category, index);
        window.trackerCategoriesContainer.appendChild(categoryElement);
        window.trackerCategoriesContainer.appendChild(createCategoryDropZoneElement(index + 1));
    });
     console.debug("[Tracker UI] Finished rendering categories.");
}

/** Creates the DOM element for a single category */
function createCategoryElement(category, index) {
    const div = document.createElement('div');
    div.className = `tracker-category ${category.isCollapsed ? 'collapsed' : ''}`;
    div.dataset.categoryId = category.id;
    div.dataset.categoryIndex = index; // Store index for potential use

    if (category.color) {
        const bgAlpha = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--category-base-bg-alpha').trim() || 0.5);
        div.style.backgroundColor = window.AppUIUtils.createHslaColor(category.color, bgAlpha);
    }

    const header = document.createElement('div');
    header.className = 'category-header';
    header.draggable = true;
    header.dataset.categoryId = category.id;
    header.addEventListener('dragstart', handleCategoryDragStart);
    header.addEventListener('dragend', handleCategoryDragEnd);
    header.addEventListener('mousedown', (e) => { if (e.target.closest('button, input')) e.stopPropagation(); }, true);

    const collapseBtn = document.createElement('button');
    collapseBtn.className = 'collapse-category-btn';
    collapseBtn.innerHTML = category.isCollapsed ? '▶' : '▼';
    collapseBtn.title = category.isCollapsed ? 'Expand Stack' : 'Collapse Stack';
    collapseBtn.addEventListener('click', handleCategoryCollapseToggle);
    header.appendChild(collapseBtn);

    const viewBtn = document.createElement('button');
    viewBtn.className = 'view-category-btn';
    viewBtn.innerHTML = 'ℹ️ ';
    viewBtn.title = `View Stack Details: ${category.name || 'Unnamed'}`;
    viewBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const catData = trackerData.find(c => c.id === div.dataset.categoryId);
        if (catData && window.AppDetailsOverlay?.showDetailsOverlay) { window.AppDetailsOverlay.showDetailsOverlay({ type: 'category', ...catData }); }
        else { console.warn("[Tracker UI] Cannot show category details - data or overlay function missing."); }
    });
    header.appendChild(viewBtn);

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'category-name-input';
    nameInput.value = category.name || 'Unnamed Stack';
    nameInput.dataset.originalName = category.name || 'Unnamed Stack';
    nameInput.placeholder = 'Stack Name';
    nameInput.title = 'Click to rename stack';
    nameInput.addEventListener('blur', handleCategoryRename);
    nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); nameInput.blur(); } else if (e.key === 'Escape') { nameInput.value = nameInput.dataset.originalName; nameInput.blur(); } });
    nameInput.addEventListener('click', (e) => e.stopPropagation());
    header.appendChild(nameInput);

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'delete-category-btn';
    deleteBtn.innerHTML = '×';
    deleteBtn.title = 'Delete Stack';
    deleteBtn.addEventListener('click', handleDeleteCategory);
    header.appendChild(deleteBtn);
    div.appendChild(header);

    const booksContainer = document.createElement('div');
    booksContainer.className = 'category-books-container';
    booksContainer.dataset.categoryId = category.id;
    booksContainer.addEventListener('dragover', handleBookDragOverCategory);
    booksContainer.addEventListener('dragleave', handleBookDragLeaveCategory);
    booksContainer.addEventListener('drop', handleBookDropInCategory);
    booksContainer.addEventListener('dragover', handleNodeDragOver);
    booksContainer.addEventListener('dragleave', handleNodeDragLeave);
    booksContainer.addEventListener('drop', handleNodeDrop);
    div.appendChild(booksContainer);
    renderCategoryBooks(booksContainer, category.books || [], category.id, category.color);
    return div;
}

/** Renders the book nodes (and drop zones) within a specific category's container */
function renderCategoryBooks(containerElement, booksArray, categoryId, categoryColor) {
    if (!containerElement) return;
    containerElement.innerHTML = '';
    containerElement.appendChild(createNodeDropZoneElement(categoryId, 0));
    if (!booksArray || booksArray.length === 0) {
        const placeholder = document.createElement('div');
        placeholder.className = 'tracker-node-placeholder';
        placeholder.textContent = '(Drag books here)';
        placeholder.addEventListener('dragover', handleBookDragOverCategory);
        placeholder.addEventListener('dragleave', handleBookDragLeaveCategory);
        placeholder.addEventListener('drop', handleBookDropInCategory);
        containerElement.appendChild(placeholder);
    } else {
        booksArray.forEach((book, index) => {
            addSingleTrackerNodeElement(containerElement, book, categoryId, categoryColor, index);
            containerElement.appendChild(createNodeDropZoneElement(categoryId, index + 1));
        });
    }
}

/** Creates and appends a single tracker node (book item) to the container */
function addSingleTrackerNodeElement(containerElement, book, categoryId, categoryColor, index) {
    if (!book || typeof book !== 'object' || (!book.title && !book.link)) { console.warn("[Tracker UI] Skipping node render, invalid book data:", book); return; }
    const node = document.createElement('div');
    node.className = 'tracker-node';
    node.draggable = true;
    const link = book.link || `no-link-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    node.dataset.link = link;
    node.dataset.categoryId = categoryId;
    node.dataset.nodeIndex = index;

    try {
        // Include priceHistory in the dataset for the click handler
        const nodeData = {
            link: book.link, title: book.title, current_price: book.current_price,
            old_price: book.old_price, voucher_price: book.voucher_price,
            voucher_code: book.voucher_code, local_image_filename: book.local_image_filename,
            priceHistory: book.priceHistory || [] // Ensure history is included
        };
        node.dataset.bookData = JSON.stringify(nodeData); // This now includes price history
    } catch (e) { console.error("[Tracker UI] Error stringifying node data:", e); node.dataset.bookData = '{}'; }

    if (categoryColor) {
        const borderAlpha = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--node-border-alpha').trim() || 0.8);
        node.style.borderColor = window.AppUIUtils.createHslaColor(categoryColor, borderAlpha);
    } else { node.style.borderColor = 'var(--border-color)'; }

    const titleSpan = document.createElement('span');
    titleSpan.className = 'tracker-node-title';
    titleSpan.textContent = book.title || 'Untitled Book';
    titleSpan.title = book.title || 'Untitled Book';
    node.appendChild(titleSpan);

    const controlsDiv = document.createElement('div');
    controlsDiv.className = 'tracker-node-controls';
    const removeBtn = document.createElement('button');
    removeBtn.className = 'remove-node-btn';
    removeBtn.innerHTML = '×';
    removeBtn.title = 'Remove this book from tracker';
    removeBtn.addEventListener('click', handleRemoveTrackedItem);
    controlsDiv.appendChild(removeBtn);
    node.appendChild(controlsDiv);

    node.addEventListener('dragstart', handleNodeDragStart);
    node.addEventListener('dragend', handleNodeDragEnd);
    node.addEventListener('click', (e) => {
        if (!e.target.closest('.remove-node-btn')) {
            try {
                const data = JSON.parse(e.currentTarget.dataset.bookData || '{}');
                // Data now includes priceHistory when passed to overlay
                if (window.AppDetailsOverlay?.showDetailsOverlay) { window.AppDetailsOverlay.showDetailsOverlay(data); }
                else { console.warn("[Tracker UI] Cannot show details - AppDetailsOverlay unavailable."); }
            } catch (err) { console.error("[Tracker UI] Error parsing node data on click:", err); alert("Error loading details for this item."); }
        }
    });

    const lastDropZone = containerElement.querySelector('.drop-zone.node-drop-zone:last-of-type');
    if (lastDropZone) { containerElement.insertBefore(node, lastDropZone); }
    else { containerElement.appendChild(node); }
}

/** Creates a drop zone element for reordering nodes within a category */
function createNodeDropZoneElement(categoryId, insertIndex) {
    const zone = document.createElement('div');
    zone.className = 'drop-zone node-drop-zone';
    zone.dataset.categoryId = categoryId;
    zone.dataset.insertAtIndex = insertIndex;
    zone.addEventListener('dragover', handleNodeDragOver);
    zone.addEventListener('dragleave', handleNodeDragLeave);
    zone.addEventListener('drop', handleNodeDrop);
    return zone;
}

/** Creates a drop zone element for reordering categories */
function createCategoryDropZoneElement(insertIndex) {
    const zone = document.createElement('div');
    zone.className = 'drop-zone category-drop-zone';
    zone.dataset.insertAtIndex = insertIndex;
    zone.addEventListener('dragover', handleCategoryDragOverContainer);
    zone.addEventListener('dragleave', handleCategoryDragLeaveContainer);
    zone.addEventListener('drop', handleCategoryDrop);
    return zone;
}

/** Updates book item borders in the main list based on tracked items */
function applyTrackerColorsToBookList() {
    if (!window.tabContentContainer) return;
    const trackedBookColors = new Map();
    trackerData.forEach((category) => {
        if (category.id && category.books && category.color) {
            const borderAlpha = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--book-item-border-alpha').trim() || 0.8);
            const colorString = window.AppUIUtils.createHslaColor(category.color, borderAlpha);
            category.books.forEach(book => { if (book && book.link) { trackedBookColors.set(book.link, colorString); } });
        }
    });
    window.tabContentContainer.querySelectorAll('.book-item').forEach(item => {
        const link = item.dataset.bookLink;
        if (link && trackedBookColors.has(link)) {
            item.style.borderLeftColor = trackedBookColors.get(link);
            item.classList.add('tracked-by-category');
        } else { item.style.borderLeftColor = 'transparent'; item.classList.remove('tracked-by-category'); }
    });
}

/** Checks if a book with the given link is already tracked in any category */
function isDuplicateTrackedItem(link) {
    if (!link || typeof link !== 'string') return false;
    return trackerData.some(category =>
        category.books.some(book => book && book.link === link)
    );
}

// --- Event Handlers ---
async function handleCategoryRename(event) {
    const input = event.target; const categoryElement = input.closest('.tracker-category'); const categoryId = categoryElement?.dataset.categoryId;
    if (!categoryId) { console.error("[Tracker UI] Cannot rename category: Missing category ID."); input.value = input.dataset.originalName || ''; return; }
    const deleteBtn = categoryElement?.querySelector('.delete-category-btn'); if (deleteBtn) resetDeleteConfirmation(deleteBtn, categoryId);
    const categoryIndex = trackerData.findIndex(c => c.id === categoryId);
    if (categoryIndex === -1) { console.error(`[Tracker UI] Category ${categoryId} not found for rename.`); input.value = input.dataset.originalName || ''; return; }
    const newName = input.value.trim(); const originalName = trackerData[categoryIndex].name;
    if (newName && newName !== originalName) {
        trackerData[categoryIndex].name = newName; input.dataset.originalName = newName;
        const viewBtn = categoryElement.querySelector('.view-category-btn'); if (viewBtn) viewBtn.title = `View Stack Details: ${newName}`;
        await saveTrackerData('rename category');
    } else { input.value = originalName; if (newName !== originalName) console.log("[Tracker UI] Rename cancelled (name was empty)."); }
}

async function handleDeleteCategory(event) {
    event.stopPropagation(); const button = event.currentTarget; const categoryElement = button.closest('.tracker-category'); const categoryId = categoryElement?.dataset.categoryId;
    if (!categoryId || !button) return;
    const isPendingConfirmation = button.dataset.deletePending === 'true';
    if (isPendingConfirmation) {
        console.log(`[Tracker UI] Confirmed delete for category: ${categoryId}`); resetDeleteConfirmation(button, categoryId);
        const categoryIndex = trackerData.findIndex(c => c.id === categoryId);
        if (categoryIndex === -1) { console.warn(`[Tracker UI] Category ${categoryId} already removed from data? Removing element.`); categoryElement.remove(); return; }
        const removedCategory = trackerData.splice(categoryIndex, 1)[0];
        if (removedCategory?.books) { removedCategory.books.forEach(book => { if (book.link) bookSpecsCache.delete(book.link); }); console.log(`[Tracker UI] Cleared specs cache for ${removedCategory.books.length} items from deleted category ${categoryId}.`); }
        const precedingDropZone = categoryElement.previousElementSibling; categoryElement.remove();
        if (precedingDropZone?.classList.contains('category-drop-zone')) { precedingDropZone.remove(); }
        window.trackerCategoriesContainer?.querySelectorAll('.drop-zone.category-drop-zone').forEach((zone, index) => { zone.dataset.insertAtIndex = index; });
        if (trackerData.length === 0 && window.trackerCategoriesContainer) { renderCategoriesAndBooks(); }
        await saveTrackerData('delete category');
    } else {
        console.log(`[Tracker UI] Initiating delete confirmation for category: ${categoryId}`); resetAllDeleteConfirmations(button);
        button.dataset.deletePending = 'true'; button.classList.add('delete-pending'); button.innerHTML = '?'; button.title = 'Click again to confirm delete';
        const timerId = setTimeout(() => { console.log(`[Tracker UI] Delete confirmation timed out for ${categoryId}.`); resetDeleteConfirmation(button, categoryId); }, DELETE_CONFIRM_TIMEOUT);
        deleteConfirmTimers.set(categoryId, timerId);
    }
}

function resetDeleteConfirmation(button, categoryId) {
    if (!button || !categoryId) return;
    const timerId = deleteConfirmTimers.get(categoryId); if (timerId) { clearTimeout(timerId); deleteConfirmTimers.delete(categoryId); }
    button.classList.remove('delete-pending'); button.innerHTML = '×'; button.title = 'Delete Stack'; delete button.dataset.deletePending;
}

function resetAllDeleteConfirmations(excludedButton = null) {
    if (!window.trackerCategoriesContainer) return;
    window.trackerCategoriesContainer.querySelectorAll('.delete-category-btn.delete-pending').forEach(button => {
        if (button !== excludedButton) {
            const categoryElement = button.closest('.tracker-category'); const categoryId = categoryElement?.dataset.categoryId; if (categoryId) { resetDeleteConfirmation(button, categoryId); }
        }
    });
}

function handleCategoryCollapseToggle(event) {
    event.stopPropagation(); const button = event.currentTarget; const categoryElement = button.closest('.tracker-category'); const categoryId = categoryElement?.dataset.categoryId;
    if (!categoryElement || !categoryId) return;
    const deleteBtn = categoryElement.querySelector('.delete-category-btn'); if (deleteBtn) resetDeleteConfirmation(deleteBtn, categoryId);
    const category = trackerData.find(c => c.id === categoryId); if (!category) return;
    const isNowCollapsed = categoryElement.classList.toggle('collapsed'); category.isCollapsed = isNowCollapsed;
    button.innerHTML = isNowCollapsed ? '▶' : '▼'; button.title = isNowCollapsed ? 'Expand Stack' : 'Collapse Stack';
    saveTrackerData('toggle collapse');
}

async function handleRemoveTrackedItem(event) {
    event.stopPropagation(); const nodeElement = event.target.closest('.tracker-node'); const link = nodeElement?.dataset.link; const categoryElement = nodeElement?.closest('.tracker-category'); const categoryId = categoryElement?.dataset.categoryId;
    if (!nodeElement || !link || !categoryId) { console.warn("[Tracker UI] Could not remove item - missing node, link, or category ID."); return; }
    const categoryIndex = trackerData.findIndex(c => c.id === categoryId);
    if (categoryIndex === -1) { console.warn(`[Tracker UI] Category ${categoryId} not found for item removal. Removing element only.`); nodeElement.remove(); return; }
    const category = trackerData[categoryIndex]; const bookIndex = category.books.findIndex(b => b && b.link === link);
    if (bookIndex > -1) {
        const removedBook = category.books.splice(bookIndex, 1)[0]; console.log(`[Tracker UI] Removed book "${removedBook?.title || link}" from category ${categoryId}.`);
        bookSpecsCache.delete(link);
        const booksContainer = categoryElement.querySelector('.category-books-container');
        if (booksContainer) { renderCategoryBooks(booksContainer, category.books, categoryId, category.color); } else { renderCategoriesAndBooks(); }
        await saveTrackerData('remove book'); applyTrackerColorsToBookList();
    } else { console.warn(`[Tracker UI] Book with link ${link} not found in category ${categoryId} data. Removing element only.`); nodeElement.remove(); }
}

async function handleAddCategory() {
    resetAllDeleteConfirmations();
    const newCategory = { id: window.AppUIUtils.generateUniqueId(), name: `New Stack ${trackerData.length + 1}`, books: [], isCollapsed: false, priceHistory: [], color: null };
    newCategory.color = getCategoryColorById(newCategory.id);
    trackerData.push(newCategory); renderCategoriesAndBooks();
    const newElement = window.trackerCategoriesContainer?.querySelector(`.tracker-category[data-category-id="${newCategory.id}"]`);
    if (newElement) {
        newElement.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        const nameInput = newElement.querySelector('.category-name-input');
        if (nameInput) { setTimeout(() => { nameInput.focus(); nameInput.select(); }, 150); }
    }
    await saveTrackerData('add category'); console.log(`[Tracker UI] Added new category: ${newCategory.id}`);
}

function createPersistentLottie() {
    if (!window.addStackLottieContainer) return;
    window.addStackLottieContainer.innerHTML = '';
    const player = document.createElement('dotlottie-player');
    player.setAttribute('src', 'https://lottie.host/38d4bace-34fa-46aa-b4ff-f3e36e529bbe/j1vcYhDIk7.lottie');
    player.setAttribute('autoplay', ''); player.setAttribute('loop', ''); player.setAttribute('background', 'transparent'); player.setAttribute('speed', '0.8');
    player.style.width = '100%'; player.style.height = '100%'; player.title = "Click 'New Stack' button below to add";
    window.addStackLottieContainer.appendChild(player); console.log("[Tracker UI] Header Lottie animation created.");
}

// --- Drag and Drop Handlers ---
function handleBookDragOverCategory(e) { if (draggedItemInfo?.type === 'book') { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; e.currentTarget.classList.add('drag-over-books'); currentDragOverElement = e.currentTarget; } }
function handleBookDragLeaveCategory(e) { if (currentDragOverElement === e.currentTarget && !e.currentTarget.contains(e.relatedTarget)) { e.currentTarget.classList.remove('drag-over-books'); currentDragOverElement = null; } }
async function handleBookDropInCategory(e) {
    if (draggedItemInfo?.type !== 'book') return; e.preventDefault(); e.stopPropagation();
    const target = e.currentTarget; target.classList.remove('drag-over-books'); currentDragOverElement = null;
    const categoryElement = target.closest('.tracker-category'); const categoryId = categoryElement?.dataset.categoryId || target.dataset.categoryId;
    if (!categoryId) { console.warn("[Tracker UI] Book drop failed: Could not determine target category ID."); clearDraggedItemInfo(); return; }
    const categoryIndex = trackerData.findIndex(c => c.id === categoryId);
    if (categoryIndex === -1) { console.error(`[Tracker UI] Book drop failed: Target category ${categoryId} not found.`); clearDraggedItemInfo(); return; }
    let bookData; try { bookData = draggedItemInfo.data || JSON.parse(e.dataTransfer.getData('application/json')); } catch (err) { console.error("[Tracker UI] Book drop failed: Could not parse book data.", err); clearDraggedItemInfo(); return; }
    if (!bookData || !bookData.link) { console.warn("[Tracker UI] Book drop failed: Invalid or missing book link in data."); clearDraggedItemInfo(); return; }
    if (isDuplicateTrackedItem(bookData.link)) { alert(`"${bookData.title || 'This book'}" is already being tracked.`); clearDraggedItemInfo(); return; }
    const bookToAdd = { link: bookData.link, title: bookData.title, current_price: bookData.current_price, old_price: bookData.old_price, voucher_price: bookData.voucher_price, voucher_code: bookData.voucher_code, local_image_filename: bookData.local_image_filename, priceHistory: [] };
    trackerData[categoryIndex].books.push(bookToAdd);
    const booksContainer = categoryElement?.querySelector('.category-books-container');
    if (booksContainer) { renderCategoryBooks(booksContainer, trackerData[categoryIndex].books, categoryId, trackerData[categoryIndex].color); } else { renderCategoriesAndBooks(); }
    await saveTrackerData('add book'); applyTrackerColorsToBookList(); clearDraggedItemInfo();
}
function handleNodeDragStart(e) {
    const node = e.target.closest('.tracker-node'); const sourceCategoryId = node?.dataset.categoryId; const sourceLink = node?.dataset.link; const sourceNodeIndex = parseInt(node?.dataset.nodeIndex, 10);
    if (!node || !sourceCategoryId || !sourceLink || isNaN(sourceNodeIndex)) { console.warn("[Tracker UI] Node drag start prevented: Missing data attributes."); e.preventDefault(); return; }
    const sourceCategory = trackerData.find(c => c.id === sourceCategoryId); if (!sourceCategory || sourceNodeIndex < 0 || sourceNodeIndex >= sourceCategory.books.length) { console.warn("[Tracker UI] Node drag start prevented: Source category or node index invalid."); e.preventDefault(); return; }
    setDraggedItemInfo({ type: 'node', link: sourceLink, sourceCategoryId: sourceCategoryId, sourceNodeIndex: sourceNodeIndex, data: { ...sourceCategory.books[sourceNodeIndex] } });
    e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', sourceLink); } catch (err) { console.warn("[Tracker UI] Error setting text/plain dataTransfer for node drag:", err); }
    setTimeout(() => node.classList.add('dragging'), 0);
}
function handleNodeDragEnd(e) {
    clearNodeDropZoneStyles();
    if (draggedItemInfo?.type === 'node' && draggedItemInfo.link) { const node = window.trackerCategoriesContainer?.querySelector(`.tracker-node[data-link="${CSS.escape(draggedItemInfo.link)}"]`); node?.classList.remove('dragging'); }
    clearDraggedItemInfo();
}
function clearNodeDropZoneStyles() { if (!window.trackerCategoriesContainer) return; window.trackerCategoriesContainer.querySelectorAll('.drop-zone.node-drop-zone.drag-over').forEach(zone => { zone.classList.remove('drag-over'); }); currentDragOverElement = null; }
function handleNodeDragOver(e) {
    if (draggedItemInfo?.type !== 'node') return; const dropZone = e.target.closest('.drop-zone.node-drop-zone');
    if (dropZone && dropZone.dataset.categoryId === draggedItemInfo.sourceCategoryId) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (currentDragOverElement !== dropZone) { clearNodeDropZoneStyles(); dropZone.classList.add('drag-over'); currentDragOverElement = dropZone; } }
    else { clearNodeDropZoneStyles(); }
}
function handleNodeDragLeave(e) { if (draggedItemInfo?.type !== 'node') return; const zone = e.target.closest('.drop-zone.node-drop-zone'); if (zone && zone === currentDragOverElement && !zone.contains(e.relatedTarget)) { zone.classList.remove('drag-over'); currentDragOverElement = null; } }
async function handleNodeDrop(e) {
    if (draggedItemInfo?.type !== 'node') return; e.preventDefault(); e.stopPropagation();
    const dropZone = e.target.closest('.drop-zone.node-drop-zone'); clearNodeDropZoneStyles();
    if (!dropZone) { console.warn("[Tracker UI] Node drop occurred outside a valid drop zone."); clearDraggedItemInfo(); return; }
    const targetCategoryId = dropZone.dataset.categoryId; const targetIndex = parseInt(dropZone.dataset.insertAtIndex, 10);
    const sourceCategoryId = draggedItemInfo.sourceCategoryId; const sourceNodeIndex = draggedItemInfo.sourceNodeIndex; const sourceLink = draggedItemInfo.link;
    if (!sourceLink || sourceCategoryId !== targetCategoryId || isNaN(targetIndex) || isNaN(sourceNodeIndex)) { console.error("[Tracker UI] Node drop failed: Invalid source/target data.", { sourceLink, sourceCategoryId, targetCategoryId, sourceNodeIndex, targetIndex }); clearDraggedItemInfo(); return; }
    const categoryIndex = trackerData.findIndex(c => c.id === sourceCategoryId); if (categoryIndex === -1) { console.error(`[Tracker UI] Node drop failed: Category ${sourceCategoryId} not found.`); clearDraggedItemInfo(); return; }
    const category = trackerData[categoryIndex]; if (sourceNodeIndex < 0 || sourceNodeIndex >= category.books.length) { console.error(`[Tracker UI] Node drop failed: Invalid source index ${sourceNodeIndex}.`); clearDraggedItemInfo(); return; }
    if (targetIndex < 0 || targetIndex > category.books.length) { console.error(`[Tracker UI] Node drop failed: Invalid target index ${targetIndex}.`); clearDraggedItemInfo(); return; }
    const [movedItem] = category.books.splice(sourceNodeIndex, 1); if (!movedItem || movedItem.link !== sourceLink) { console.error("[Tracker UI] Node drop failed: Item mismatch after splice."); renderCategoriesAndBooks(); clearDraggedItemInfo(); return; }
    const actualInsertIndex = (sourceNodeIndex < targetIndex) ? targetIndex - 1 : targetIndex; category.books.splice(actualInsertIndex, 0, movedItem);
    const booksContainer = window.trackerCategoriesContainer?.querySelector(`.tracker-category[data-category-id="${sourceCategoryId}"] .category-books-container`);
    if (booksContainer) { renderCategoryBooks(booksContainer, category.books, sourceCategoryId, category.color); } else { renderCategoriesAndBooks(); }
    await saveTrackerData('reorder book'); clearDraggedItemInfo();
}
function handleCategoryDragStart(e) {
    if (e.target.closest('button, input')) { e.preventDefault(); return; }
    const header = e.target.closest('.category-header'); const categoryElement = header?.closest('.tracker-category'); const sourceCategoryId = categoryElement?.dataset.categoryId; const sourceIndex = parseInt(categoryElement?.dataset.categoryIndex, 10);
    if (!header || !categoryElement || !sourceCategoryId || isNaN(sourceIndex)) { console.warn("[Tracker UI] Category drag start prevented: Missing data attributes."); e.preventDefault(); return; }
    resetAllDeleteConfirmations(); setDraggedItemInfo({ type: 'category', sourceCategoryId: sourceCategoryId, sourceIndex: sourceIndex });
    e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', `category-${sourceCategoryId}`); } catch (err) { console.warn("[Tracker UI] Error setting text/plain dataTransfer for category drag:", err); }
    if (window.trackerCategoriesContainer) { window.trackerCategoriesContainer.querySelectorAll('.drop-zone.category-drop-zone').forEach(zone => { zone.classList.add('visible'); }); }
    setTimeout(() => { categoryElement.classList.add('dragging'); header.classList.add('dragging'); }, 0);
}
function handleCategoryDragEnd(e) {
    if (draggedItemInfo?.type === 'category') { const sourceId = draggedItemInfo.sourceCategoryId; if (window.trackerCategoriesContainer) { const categoryElement = window.trackerCategoriesContainer.querySelector(`.tracker-category[data-category-id="${sourceId}"]`); categoryElement?.classList.remove('dragging'); categoryElement?.querySelector('.category-header')?.classList.remove('dragging'); } }
    clearCategoryDropZoneStyles(); clearDraggedItemInfo();
}
function clearCategoryDropZoneStyles() { if (!window.trackerCategoriesContainer) return; window.trackerCategoriesContainer.querySelectorAll('.drop-zone.category-drop-zone').forEach(zone => { zone.classList.remove('visible', 'drop-target-highlight'); }); currentDragOverElement = null; }
function handleCategoryDragOverContainer(e) {
    if (draggedItemInfo?.type !== 'category') return; const zone = e.target.closest('.drop-zone.category-drop-zone.visible');
    if (zone) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (currentDragOverElement !== zone) { if (currentDragOverElement) currentDragOverElement.classList.remove('drop-target-highlight'); zone.classList.add('drop-target-highlight'); currentDragOverElement = zone; } }
    else { if (currentDragOverElement) { currentDragOverElement.classList.remove('drop-target-highlight'); currentDragOverElement = null; } }
}
function handleCategoryDragLeaveContainer(e) { if (draggedItemInfo?.type !== 'category') return; const zone = e.target.closest('.drop-zone.category-drop-zone.visible'); const relatedTargetZone = e.relatedTarget ? e.relatedTarget.closest('.drop-zone.category-drop-zone.visible') : null; if (currentDragOverElement && currentDragOverElement === zone && currentDragOverElement !== relatedTargetZone) { currentDragOverElement.classList.remove('drop-target-highlight'); currentDragOverElement = null; } }
async function handleCategoryDrop(e) {
    if (draggedItemInfo?.type !== 'category') return; e.preventDefault(); e.stopPropagation();
    const dropZone = e.target.closest('.drop-zone.category-drop-zone.visible'); clearCategoryDropZoneStyles();
    if (!dropZone) { console.warn("[Tracker UI] Category drop occurred outside a valid drop zone."); clearDraggedItemInfo(); return; }
    const targetIndex = parseInt(dropZone.dataset.insertAtIndex, 10); const sourceIndex = draggedItemInfo.sourceIndex; const sourceId = draggedItemInfo.sourceCategoryId;
    if (isNaN(targetIndex) || sourceIndex == null || isNaN(sourceIndex) || !sourceId) { console.error("[Tracker UI] Category drop failed: Invalid source/target index.", { sourceId, sourceIndex, targetIndex }); clearDraggedItemInfo(); return; }
    if (targetIndex === sourceIndex || targetIndex === sourceIndex + 1) { console.debug("[Tracker UI] Category drop resulted in no change of order."); renderCategoriesAndBooks(); clearDraggedItemInfo(); return; }
    const [movedCategory] = trackerData.splice(sourceIndex, 1); if (!movedCategory || movedCategory.id !== sourceId) { console.error("[Tracker UI] Category drop failed: Category mismatch after splice."); renderCategoriesAndBooks(); clearDraggedItemInfo(); return; }
    const actualInsertIndex = (sourceIndex < targetIndex) ? targetIndex - 1 : targetIndex; trackerData.splice(actualInsertIndex, 0, movedCategory);
    renderCategoriesAndBooks(); await saveTrackerData('reorder category'); clearDraggedItemInfo();
}
function setDraggedItemInfo(info) { draggedItemInfo = info; }
function clearDraggedItemInfo() { draggedItemInfo = null; }

// --- Price Checking Logic ---
async function fetchBookPricesAndSpecs(bookLink, bookTitle = 'book') {
    if (!bookLink || typeof bookLink !== 'string' || !bookLink.startsWith('http')) { console.warn(`[Tracker Price Check] Invalid link for price check: ${bookLink}`); return null; }
    if (!window.electronAPI?.fetchDetailData) { console.error("[Tracker Price Check] Cannot fetch: electronAPI.fetchDetailData unavailable."); return { fetchError: "IPC API unavailable" }; }
    console.info(`[Tracker Price Check] Fetching prices/specs for: "${bookTitle}" (${bookLink})`);
    try {
        const webviewId = window.AppRuntime?.primaryWebviewId; if (!webviewId) { throw new Error("Primary webview ID not set for price check."); }
        const result = await window.electronAPI.fetchDetailData(webviewId, bookLink);
        if (!result.success) { throw new Error(result.error || 'IPC fetchDetailData failed for price/spec check'); }
        const prices = (typeof result.prices === 'object' && result.prices !== null) ? result.prices : {};
        const specs = (typeof result.details === 'object' && result.details !== null) ? result.details : {};
        if (specs && !specs.fetchError) bookSpecsCache.set(bookLink, specs); // Cache only valid specs
        return prices;
    } catch (error) { console.error(`[Tracker Price Check] Error fetching price/spec data for ${bookLink}:`, error); return { fetchError: error.message || 'Unknown fetch error' }; }
}

async function performPriceCheckCycle() {
    if (isCurrentlyCheckingPrices) { console.warn("[Tracker] Price check cycle skipped, previous cycle still running."); return; }
    if (!trackerData || trackerData.length === 0) { console.log("[Tracker] No tracked items to check prices for."); scheduleNextPriceCheck(); return; }
    isCurrentlyCheckingPrices = true; const startTime = Date.now(); let itemsChecked = 0; let updatesFound = false; let errorsEncountered = 0;
    console.log("[Tracker] Starting price check cycle..."); if (window.statusBar) window.statusBar.textContent = 'Checking tracked item prices...';

    for (const category of trackerData) {
        if (category.books && category.books.length > 0) {
            for (const book of category.books) {
                if (book && book.link) {
                    itemsChecked++;
                    const fetchedPrices = await fetchBookPricesAndSpecs(book.link, book.title);
                    await new Promise(r => setTimeout(r, 300)); // Small delay

                    let fetchError = null;
                    if (fetchedPrices?.fetchError) {
                        fetchError = fetchedPrices.fetchError;
                        errorsEncountered++;
                        console.warn(`[Tracker] Failed to fetch prices for "${book.title || book.link}". Error: ${fetchError}`);
                    } else if (fetchedPrices) {
                        // Check if prices actually changed (for logging/save flag)
                        const priceChanged = book.current_price !== fetchedPrices.currentPrice ||
                                             book.old_price !== fetchedPrices.oldPrice ||
                                             book.voucher_price !== fetchedPrices.voucherPrice ||
                                             book.voucher_code !== fetchedPrices.voucherCode;

                        if (priceChanged) {
                            console.log(`[Tracker] Price change detected for "${book.title || book.link}"`);
                            updatesFound = true;
                        }

                        // ** FIX: Update the book object in trackerData directly **
                        book.current_price = fetchedPrices.currentPrice;
                        book.old_price = fetchedPrices.oldPrice;
                        book.voucher_price = fetchedPrices.voucherPrice;
                        book.voucher_code = fetchedPrices.voucherCode;

                        // Ensure priceHistory array exists
                        if (!Array.isArray(book.priceHistory)) book.priceHistory = [];

                        // Create the history entry *using the fetched prices*
                        const historyEntry = {
                            timestamp: Date.now(),
                            currentPrice: fetchedPrices.currentPrice,
                            oldPrice: fetchedPrices.oldPrice,
                            voucherPrice: fetchedPrices.voucherPrice,
                            voucherCode: fetchedPrices.voucherCode
                        };

                        // ** FIX: Push the new history entry to the book object **
                        book.priceHistory.push(historyEntry);

                        // Optional: Limit history length
                        // const MAX_HISTORY = 100; // Example limit
                        // if (book.priceHistory.length > MAX_HISTORY) {
                        //     book.priceHistory = book.priceHistory.slice(-MAX_HISTORY); // Keep only the last N entries
                        // }

                    } else {
                         fetchError = 'Unknown fetch error';
                         errorsEncountered++;
                         console.warn(`[Tracker] Fetch returned null for "${book.title || book.link}".`);
                    }

                    // **Dispatch event with the *updated* book object (including new history)**
                    document.dispatchEvent(new CustomEvent('priceUpdate', {
                        detail: {
                            link: book.link,
                            bookData: book, // Send the fully updated book object
                            error: fetchError
                        }
                    }));
                }
            } // End books loop
        }
    } // End categories loop

    const duration = Date.now() - startTime;
    console.log(`[Tracker] Price check cycle finished in ${duration / 1000}s. Checked: ${itemsChecked}. Updates: ${updatesFound}. Errors: ${errorsEncountered}.`);

    if (updatesFound) {
        console.log("[Tracker] Price updates found, saving data...");
        await saveTrackerData('update prices'); // Save data includes the updated history
    } else {
        if (window.statusBar) window.statusBar.textContent = `Price check complete (${itemsChecked} items, no changes).`;
    }

    isCurrentlyCheckingPrices = false;
    scheduleNextPriceCheck(); // Schedule the next run
}


function scheduleNextPriceCheck() {
    if (priceCheckIntervalId) { clearTimeout(priceCheckIntervalId); priceCheckIntervalId = null; }
    const timeSinceStart = Date.now() - appStartTime; let intervalMs; let intervalType;
    if (timeSinceStart < BOOST_DURATION_MS) { intervalMs = BOOST_INTERVAL_MS; intervalType = 'Boost'; }
    else { intervalMs = NORMAL_INTERVAL_MS; intervalType = 'Normal'; }
    console.log(`[Tracker] Scheduling next price check in ${intervalMs / 1000 / 60} minutes (${intervalType} interval).`);
    priceCheckIntervalId = setTimeout(() => { performPriceCheckCycle(); }, intervalMs);
}

function startPriceCheckingInterval() {
    console.log("[Tracker] Initializing price check schedule..."); stopPriceCheckingInterval(); appStartTime = Date.now(); isCurrentlyCheckingPrices = false;
    const initialDelay = 10 * 1000; console.log(`[Tracker] Performing initial price check in ${initialDelay / 1000} seconds...`);
    priceCheckIntervalId = setTimeout(() => { performPriceCheckCycle(); }, initialDelay);
}

function stopPriceCheckingInterval() {
    if (priceCheckIntervalId) { clearTimeout(priceCheckIntervalId); priceCheckIntervalId = null; console.log("[Tracker] Price checking interval stopped."); }
    isCurrentlyCheckingPrices = false;
}

function setupTrackerEventListeners() {
    if (!window.addCategoryBtn) { console.error("[Tracker UI] Cannot setup listeners - Add Category Button missing."); return; }
    window.addCategoryBtn.addEventListener('click', handleAddCategory);
    document.body.addEventListener('click', (e) => { if (!e.target.closest('.delete-category-btn')) { resetAllDeleteConfirmations(); } }, true);
    console.log("[Tracker UI] Tracker event listeners setup.");
}

// --- Initialization and Export ---
window.AppTrackerUI = {
    initialize: async () => {
        console.log("[Tracker UI] Initializing..."); createPersistentLottie(); setupTrackerEventListeners();
        await loadAndDisplayTrackedItems(); console.log("[Tracker UI] Initialization complete.");
    },
    trackerData, bookSpecsCache, saveTrackerData, loadAndDisplayTrackedItems, applyTrackerColorsToBookList,
    setDraggedItemInfo, clearDraggedItemInfo, stopPriceChecking: stopPriceCheckingInterval
};

console.log("[Tracker UI] Module loaded.");
