// electron_app/renderer_process/tracker-ui.js

// Assumes necessary DOM elements are globally available or passed in
// Requires: trackerCategoriesContainer, addCategoryBtn, statusBar, tabContentContainer, addStackLottieContainer
// Requires access to: AppUIUtils, AppDetailsOverlay.showDetailsOverlay, AppPanelManager, electronAPI, PYTHON_BACKEND_URL

// --- State Variables ---
let trackerData = []; // Holds the main array of categories and books
let draggedItemInfo = null; // Info about the item being dragged (book node or category header)
let currentDragOverElement = null; // The specific drop zone being hovered over
const bookSpecsCache = new Map(); // Cache for fetched book specs { link -> specs }
const deleteConfirmTimers = new Map(); // Timers for category delete confirmation { categoryId -> timerId }
const DELETE_CONFIRM_TIMEOUT = 2500; // ms

// --- NEW Tracking State Variables ---
let priceCheckIntervalId = null;
const BOOST_DURATION_MS  = 60 * 60 * 1000;  // 1 hour
const BOOST_INTERVAL_MS  = 1 * 60 * 1000;   // 5 minutes
const NORMAL_INTERVAL_MS = 60 * 60 * 1000;  // 1 hour
let appStartTime = Date.now();
let isCurrentlyCheckingPrices = false; // Prevent overlapping checks

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

/** Loads tracker data from main process and renders the UI */
async function loadAndDisplayTrackedItems() {
    console.log("[Tracker UI] Requesting tracker data load...");
     if(window.statusBar) window.statusBar.textContent = 'Loading tracker...';

    if (!window.electronAPI || typeof window.electronAPI.loadTrackedBooks !== 'function') {
        console.error("[Tracker UI] Cannot load: electronAPI.loadTrackedBooks not available.");
        if(window.statusBar) window.statusBar.textContent = 'Error: Load API unavailable!';
        trackerData = [{ id: window.AppUIUtils.generateUniqueId(), name: "Default (API Load Failed)", books: [], isCollapsed: false, priceHistory: [] }]; // Add priceHistory default
        renderCategoriesAndBooks(); // Render default state
        stopPriceCheckingInterval(); // Ensure interval doesn't run
        return;
    }

    try {
        const loadedData = await window.electronAPI.loadTrackedBooks();
        console.log(`[Tracker UI] Received ${loadedData?.length ?? 0} categories from main process.`);
        bookSpecsCache.clear();

        trackerData = (Array.isArray(loadedData) && loadedData.length > 0)
            ? loadedData.map(cat => {
                const categoryId = cat.id || window.AppUIUtils.generateUniqueId();
                const books = (cat.books || []).map(b => {
                    if (b.link && b.specs && typeof b.specs === 'object') {
                        bookSpecsCache.set(b.link, b.specs);
                    }
                    // **MODIFICATION:** Ensure priceHistory is an array, default to empty
                    const priceHistory = Array.isArray(b.priceHistory) ? b.priceHistory : [];
                    // Return book data *without* specs, but *with* priceHistory
                    return { ...b, specs: undefined, priceHistory: priceHistory };
                });
                return {
                    id: categoryId,
                    name: cat.name || "Untitled Stack",
                    isCollapsed: cat.isCollapsed || false,
                    books: books,
                    color: getCategoryColorById(categoryId)
                };
            })
            : [{ // Default if loading fails or file is empty
                id: window.AppUIUtils.generateUniqueId(),
                name: "My First Stack",
                books: [],
                isCollapsed: false,
                color: getCategoryColorById(null),
                priceHistory: [] // Add priceHistory default
            }];

        renderCategoriesAndBooks();
        applyTrackerColorsToBookList();

        const totalBooks = trackerData.reduce((sum, cat) => sum + (cat.books?.length || 0), 0);
        if(window.statusBar) window.statusBar.textContent = `Tracker Loaded: ${trackerData.length} stacks, ${totalBooks} items.`;
        console.log(`[Tracker UI] Load and render complete. Cache size: ${bookSpecsCache.size}`);

        // **NEW:** Start the price checking interval after successful load
        startPriceCheckingInterval();

    } catch (err) {
        console.error("[Tracker UI] Error loading/processing tracker data:", err);
        if(window.statusBar) window.statusBar.textContent = 'Error loading tracker!';
        trackerData = [{ id: window.AppUIUtils.generateUniqueId(), name: "Default (Load Error)", books: [], isCollapsed: false, color: getCategoryColorById(null), priceHistory: [] }];
        renderCategoriesAndBooks();
        alert(`Failed to load tracker data: ${err.message}`);
         // Stop any potentially running interval on load error
         stopPriceCheckingInterval();
    }
}

/** Saves the current trackerData state to the main process */
async function saveTrackerData(operationDescription = 'save') {
    // Debounce or queue saves if they happen very frequently? For now, direct save.
    console.log(`[Tracker UI] Saving data via IPC (${operationDescription})...`);
    if(window.statusBar) window.statusBar.textContent = `Saving tracker (${operationDescription})...`;

    if (!window.electronAPI || typeof window.electronAPI.saveTrackedBooks !== 'function') {
        console.error("[Tracker UI] Cannot save: electronAPI.saveTrackedBooks not available.");
        if(window.statusBar) window.statusBar.textContent = 'Error: Save API unavailable!';
        alert("Error: Could not save tracker data (API missing).");
        return; // Prevent attempting to save
    }

    try {
        // **MODIFICATION:** Include priceHistory when saving
        const dataToSave = trackerData.map(category => ({
            id: category.id || window.AppUIUtils.generateUniqueId(),
            name: category.name || "Untitled",
            isCollapsed: category.isCollapsed || false,
            books: category.books.map(book => {
                const cachedSpecs = bookSpecsCache.get(book.link);
                // Ensure book object contains essential fields + priceHistory + cached specs
                const savedBook = {
                    link: book.link,
                    title: book.title,
                    current_price: book.current_price, // Keep last known top-level price? Optional.
                    old_price: book.old_price,         // Optional.
                    voucher_price: book.voucher_price, // Optional.
                    voucher_code: book.voucher_code,   // Optional.
                    local_image_filename: book.local_image_filename, // Keep image filename
                    // Include specs only if cached and not an error
                    specs: (cachedSpecs && !cachedSpecs.fetchError) ? cachedSpecs : undefined,
                    // Ensure priceHistory is an array
                    priceHistory: Array.isArray(book.priceHistory) ? book.priceHistory : []
                };
                // Remove undefined spec field if not present
                if (savedBook.specs === undefined) delete savedBook.specs;
                return savedBook;
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


// --- UI Rendering ---

/** Renders all categories and their books based on the trackerData state */
function renderCategoriesAndBooks() {
    if (!window.trackerCategoriesContainer) return;

    const currentCollapseStates = {};
    window.trackerCategoriesContainer.querySelectorAll('.tracker-category').forEach(el => {
        const id = el.dataset.categoryId;
        if (id) currentCollapseStates[id] = el.classList.contains('collapsed');
    });

    resetAllDeleteConfirmations();
    window.trackerCategoriesContainer.innerHTML = '';

    if (!trackerData || trackerData.length === 0) {
        window.trackerCategoriesContainer.innerHTML = '<p class="tracker-node-placeholder">No stacks yet. Create one or drag books here!</p>';
        const placeholder = window.trackerCategoriesContainer.querySelector('.tracker-node-placeholder');
        if(placeholder) {
             placeholder.addEventListener('dragover', handleBookDragOverPlaceholder);
             placeholder.addEventListener('dragleave', handleBookDragLeavePlaceholder);
             placeholder.addEventListener('drop', handleBookDropInPlaceholder);
        }
        return;
    }

    window.trackerCategoriesContainer.appendChild(createCategoryDropZoneElement(0));

    trackerData.forEach((categoryData, index) => {
        if (!categoryData || typeof categoryData !== 'object') {
            console.warn(`[Tracker UI] Skipping invalid category data at index ${index}`);
            return;
        }
        if (currentCollapseStates[categoryData.id] !== undefined) {
            categoryData.isCollapsed = currentCollapseStates[categoryData.id];
        }
        // Ensure color is assigned if missing
        if (!categoryData.color) {
            categoryData.color = getCategoryColorById(categoryData.id);
        }

        const categoryElement = createCategoryElement(categoryData, index);
        window.trackerCategoriesContainer.appendChild(categoryElement);
        window.trackerCategoriesContainer.appendChild(createCategoryDropZoneElement(index + 1));
    });
}


/** Creates a single category element (header and book container) */
function createCategoryElement(categoryData, index) {
    const categoryDiv = document.createElement('div');
    categoryDiv.className = `tracker-category${categoryData.isCollapsed ? ' collapsed' : ''}`;
    categoryDiv.dataset.categoryId = categoryData.id;
    if (categoryData.color) {
        const alpha = getComputedStyle(document.documentElement).getPropertyValue('--category-base-bg-alpha').trim() || 0.5;
        categoryDiv.style.backgroundColor = window.AppUIUtils.createHslaColor(categoryData.color, parseFloat(alpha));
    }

    const headerDiv = document.createElement('div');
    headerDiv.className = 'category-header';
    headerDiv.draggable = true;
    headerDiv.dataset.categoryId = categoryData.id;
    headerDiv.addEventListener('dragstart', handleCategoryDragStart);
    headerDiv.addEventListener('dragend', handleCategoryDragEnd);
    headerDiv.addEventListener('mousedown', (e) => { if (e.target.closest('button, input')) { e.stopPropagation(); } }, true);

    const collapseBtn = document.createElement('button');
    collapseBtn.className = 'collapse-category-btn';
    collapseBtn.innerHTML = categoryData.isCollapsed ? 'â–¶' : 'â–¼';
    collapseBtn.title = categoryData.isCollapsed ? 'Expand Stack' : 'Collapse Stack';
    collapseBtn.addEventListener('click', handleCategoryCollapseToggle);

    const viewBtn = document.createElement('button');
    viewBtn.className = 'view-category-btn';
    viewBtn.innerHTML = 'ðŸ‘ ï¸ ';
    viewBtn.title = `View details for stack: ${categoryData.name || 'Unnamed'}`;
    viewBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const catId = categoryDiv.dataset.categoryId;
        const category = trackerData.find(c => c.id === catId);
        if (category && window.AppDetailsOverlay?.showDetailsOverlay) {
             window.AppDetailsOverlay.showDetailsOverlay({ type: 'category', ...category });
        } else { console.warn("Cannot show category details", category, window.AppDetailsOverlay); }
    });

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'category-name-input';
    nameInput.value = categoryData.name || 'Unnamed Stack';
    nameInput.dataset.originalName = categoryData.name || 'Unnamed Stack';
    nameInput.placeholder = 'Stack Name';
    nameInput.title = 'Click to rename stack';
    nameInput.addEventListener('blur', handleCategoryRename);
    nameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); nameInput.blur(); }
        else if (e.key === 'Escape') { nameInput.value = nameInput.dataset.originalName; nameInput.blur(); }
    });
    nameInput.addEventListener('click', (e) => e.stopPropagation());

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'delete-category-btn';
    deleteBtn.innerHTML = 'Ã—';
    deleteBtn.title = 'Delete stack';
    deleteBtn.addEventListener('click', handleDeleteCategory);

    headerDiv.appendChild(collapseBtn);
    headerDiv.appendChild(viewBtn);
    headerDiv.appendChild(nameInput);
    headerDiv.appendChild(deleteBtn);

    const booksContainer = document.createElement('div');
    booksContainer.className = 'category-books-container';
    booksContainer.dataset.categoryId = categoryData.id;

    booksContainer.addEventListener('dragover', handleBookDragOverCategory);
    booksContainer.addEventListener('dragleave', handleBookDragLeaveCategory);
    booksContainer.addEventListener('drop', handleBookDropInCategory);
    booksContainer.addEventListener('dragover', handleNodeDragOver);
    booksContainer.addEventListener('dragleave', handleNodeDragLeave);
    booksContainer.addEventListener('drop', handleNodeDrop);

    categoryDiv.appendChild(headerDiv);
    categoryDiv.appendChild(booksContainer);

    renderCategoryBooks(booksContainer, categoryData.books || [], categoryData.id, categoryData.color);

    return categoryDiv;
}

/** Renders the books (tracker nodes) inside a specific category container */
function renderCategoryBooks(containerElement, booksArray, categoryId, categoryColor) {
    if (!containerElement) return;
    containerElement.innerHTML = ''; // Clear previous nodes/placeholders

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
        booksArray.forEach((bookData, bookIndex) => {
            addSingleTrackerNodeElement(containerElement, bookData, categoryId, categoryColor);
            containerElement.appendChild(createNodeDropZoneElement(categoryId, bookIndex + 1));
        });
    }
}

/** Creates and adds a single tracker node (book item) element */
function addSingleTrackerNodeElement(container, bookData, categoryId, categoryColor) {
    if (!bookData || (!bookData.title && !bookData.link)) {
        console.warn("[Tracker UI] Skipping node render, missing title/link:", bookData);
        return;
    }

    const node = document.createElement('div');
    node.className = 'tracker-node';
    node.draggable = true;

    const nodeLink = bookData.link || `no-link-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    node.dataset.link = nodeLink;
    node.dataset.categoryId = categoryId;

    // Store base book data (including priceHistory for details overlay)
     try {
        // Make sure to stringify the priceHistory as well
        const dataToStore = { ...bookData, priceHistory: bookData.priceHistory || [] };
        node.dataset.bookData = JSON.stringify(dataToStore);
    } catch(e) { node.dataset.bookData = '{}'; console.error("Error stringifying node data:", e)}

    if (categoryColor) {
        const alpha = getComputedStyle(document.documentElement).getPropertyValue('--node-border-alpha').trim() || 0.8;
        node.style.borderColor = window.AppUIUtils.createHslaColor(categoryColor, parseFloat(alpha));
    } else {
        node.style.borderColor = 'var(--border-color)';
    }

    const titleSpan = document.createElement('span');
    titleSpan.className = 'tracker-node-title';
    titleSpan.textContent = bookData.title || 'Untitled Book';
    titleSpan.title = bookData.title || 'Untitled Book';

    const controlsDiv = document.createElement('div');
    controlsDiv.className = 'tracker-node-controls';
    const removeBtn = document.createElement('button');
    removeBtn.className = 'remove-node-btn';
    removeBtn.innerHTML = 'Ã—';
    removeBtn.title = 'Remove from tracker';
    removeBtn.addEventListener('click', handleRemoveTrackedItem);
    controlsDiv.appendChild(removeBtn);

    node.appendChild(titleSpan);
    node.appendChild(controlsDiv);

    node.addEventListener('dragstart', handleNodeDragStart);
    node.addEventListener('dragend', handleNodeDragEnd);

    node.addEventListener('click', (e) => {
        if (!e.target.closest('.remove-node-btn')) {
            try {
                const bkData = JSON.parse(e.currentTarget.dataset.bookData || '{}');
                if (window.AppDetailsOverlay?.showDetailsOverlay) {
                     // Pass the full data including priceHistory
                     window.AppDetailsOverlay.showDetailsOverlay(bkData);
                }
            } catch(err) { console.error("[Tracker UI] Error parsing node data for details click:", err); }
        }
    });

    const lastElement = container.lastElementChild;
    if (lastElement?.classList.contains('drop-zone')) {
        container.insertBefore(node, lastElement);
    } else {
        container.appendChild(node);
    }
}

/** Creates a drop zone element for reordering nodes within a category */
function createNodeDropZoneElement(categoryId, insertAtIndex) {
    const zone = document.createElement('div');
    zone.className = 'drop-zone node-drop-zone';
    zone.dataset.categoryId = categoryId;
    zone.dataset.insertAtIndex = insertAtIndex;
    zone.addEventListener('dragover', handleNodeDragOver);
    zone.addEventListener('dragleave', handleNodeDragLeave);
    zone.addEventListener('drop', handleNodeDrop);
    return zone;
}

/** Creates a drop zone element for reordering categories */
function createCategoryDropZoneElement(insertAtIndex) {
    const zone = document.createElement('div');
    zone.className = 'drop-zone category-drop-zone';
    zone.dataset.insertAtIndex = insertAtIndex;
    zone.addEventListener('dragover', handleCategoryDragOverContainer);
    zone.addEventListener('dragleave', handleCategoryDragLeaveContainer);
    zone.addEventListener('drop', handleCategoryDrop);
    return zone;
}

/** Applies tracker category colors to the main book list items */
function applyTrackerColorsToBookList() {
    if (!window.tabContentContainer) return;
    const linkToColorMap = new Map();

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

    window.tabContentContainer.querySelectorAll('.book-item').forEach(item => {
        const link = item.dataset.bookLink;
        if (link && linkToColorMap.has(link)) {
            item.style.borderLeftColor = linkToColorMap.get(link);
            item.classList.add('tracked-by-category');
        } else {
            item.style.borderLeftColor = 'transparent';
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
    const deleteButton = categoryElement?.querySelector('.delete-category-btn');
    if (deleteButton && categoryId) resetDeleteConfirmation(deleteButton, categoryId);

    if (!categoryId) {
        console.error("[Tracker UI] Cannot rename category: Missing ID.");
        inputElement.value = inputElement.dataset.originalName || ''; return;
    }
    const categoryIndex = trackerData.findIndex(c => c.id === categoryId);
    if (categoryIndex === -1) {
        console.error(`[Tracker UI] Category ${categoryId} not found in state for rename.`);
        inputElement.value = inputElement.dataset.originalName || ''; return;
    }
    const newName = inputElement.value.trim();
    const originalName = trackerData[categoryIndex].name;
    if (newName && newName !== originalName) {
        trackerData[categoryIndex].name = newName;
        inputElement.dataset.originalName = newName;
        const viewButton = categoryElement.querySelector('.view-category-btn');
        if (viewButton) viewButton.title = `View details for stack: ${newName}`;
        await saveTrackerData('rename category');
    } else {
        inputElement.value = originalName;
        if (newName !== originalName) console.log("[Tracker UI] Category rename cancelled (empty name).");
    }
}

/** Handles deleting a category with confirmation */
async function handleDeleteCategory(event) {
    event.stopPropagation();
    const deleteButton = event.currentTarget;
    const categoryElement = deleteButton.closest('.tracker-category');
    const categoryId = categoryElement?.dataset.categoryId;
    if (!categoryId || !deleteButton) return;

    const isPending = deleteButton.dataset.deletePending === 'true';
    if (isPending) {
        resetDeleteConfirmation(deleteButton, categoryId);
        const categoryIndex = trackerData.findIndex(c => c.id === categoryId);
        if (categoryIndex === -1) { categoryElement.remove(); return; }
        const removedCategory = trackerData.splice(categoryIndex, 1)[0];
        if (removedCategory?.books) {
            removedCategory.books.forEach(book => bookSpecsCache.delete(book.link));
        }
        const prevDropZone = categoryElement.previousElementSibling;
        categoryElement.remove();
        if (prevDropZone?.classList.contains('category-drop-zone')) prevDropZone.remove();
        window.trackerCategoriesContainer?.querySelectorAll('.drop-zone.category-drop-zone')
            .forEach((zone, index) => zone.dataset.insertAtIndex = index);
        if (trackerData.length === 0 && window.trackerCategoriesContainer) renderCategoriesAndBooks();
        await saveTrackerData('delete category');
    } else {
        resetAllDeleteConfirmations(deleteButton);
        deleteButton.dataset.deletePending = 'true';
        deleteButton.classList.add('delete-pending');
        deleteButton.innerHTML = '?';
        deleteButton.title = 'Click again to confirm deletion';
        const timerId = setTimeout(() => resetDeleteConfirmation(deleteButton, categoryId), DELETE_CONFIRM_TIMEOUT);
        deleteConfirmTimers.set(categoryId, timerId);
    }
}

/** Resets the delete confirmation state for a specific button */
function resetDeleteConfirmation(button, categoryId) {
    if (!button || !categoryId) return;
    const timerId = deleteConfirmTimers.get(categoryId);
    if (timerId) { clearTimeout(timerId); deleteConfirmTimers.delete(categoryId); }
    button.classList.remove('delete-pending');
    button.innerHTML = 'Ã—';
    button.title = 'Delete stack';
    delete button.dataset.deletePending;
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
    event.stopPropagation();
    const button = event.currentTarget;
    const categoryElement = button.closest('.tracker-category');
    const categoryId = categoryElement?.dataset.categoryId;
    if (!categoryElement || !categoryId) return;
    const deleteButton = categoryElement.querySelector('.delete-category-btn');
    if (deleteButton) resetDeleteConfirmation(deleteButton, categoryId);
    const category = trackerData.find(c => c.id === categoryId);
    if (!category) return;
    const isCollapsed = categoryElement.classList.toggle('collapsed');
    category.isCollapsed = isCollapsed;
    button.innerHTML = isCollapsed ? 'â–¶' : 'â–¼';
    button.title = isCollapsed ? 'Expand Stack' : 'Collapse Stack';
    saveTrackerData('toggle collapse');
}

/** Handles removing a tracked item (book node) */
async function handleRemoveTrackedItem(event) {
    event.stopPropagation();
    const nodeElement = event.target.closest('.tracker-node');
    const link = nodeElement?.dataset.link;
    const categoryElement = nodeElement?.closest('.tracker-category');
    const categoryId = categoryElement?.dataset.categoryId;
    if (!nodeElement || !link || !categoryId) return;

    const categoryIndex = trackerData.findIndex(c => c.id === categoryId);
    if (categoryIndex === -1) { nodeElement.remove(); return; }
    const category = trackerData[categoryIndex];
    const bookIndex = category.books.findIndex(b => b && b.link === link);
    if (bookIndex > -1) {
        category.books.splice(bookIndex, 1);
        bookSpecsCache.delete(link);
        const booksContainer = categoryElement.querySelector('.category-books-container');
        if (booksContainer) renderCategoryBooks(booksContainer, category.books, categoryId, category.color);
        else renderCategoriesAndBooks();
        await saveTrackerData('remove book');
    } else {
        nodeElement.remove();
    }
}

/** Handles adding a new category */
async function handleAddCategory() {
    resetAllDeleteConfirmations();
    const newCategory = {
        id: window.AppUIUtils.generateUniqueId(),
        name: `Stack ${trackerData.length + 1}`,
        books: [],
        isCollapsed: false,
        priceHistory: [], // Add priceHistory default
        color: getCategoryColorById(null)
    };
    newCategory.color = getCategoryColorById(newCategory.id);
    trackerData.push(newCategory);
    renderCategoriesAndBooks();
    const newCategoryElement = window.trackerCategoriesContainer?.querySelector(`.tracker-category[data-category-id="${newCategory.id}"]`);
    if (newCategoryElement) {
        newCategoryElement.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        const nameInput = newCategoryElement.querySelector('.category-name-input');
        if (nameInput) setTimeout(() => { nameInput.focus(); nameInput.select(); }, 100);
    }
    await saveTrackerData('add category');
}

/** Creates the persistent Lottie animation in the header */
function createPersistentLottie() {
     if (!window.addStackLottieContainer) return;
     window.addStackLottieContainer.innerHTML = '';
     const player = document.createElement('dotlottie-player');
     player.setAttribute('src', 'https://lottie.host/38d4bace-34fa-46aa-b4ff-f3e36e529bbe/j1vcYhDIk7.lottie');
     player.setAttribute('autoplay', '');
     player.setAttribute('loop', '');
     player.setAttribute('background', 'transparent');
     player.setAttribute('speed', '0.8');
     player.title = "Add New Stack (Button Below)";
     window.addStackLottieContainer.appendChild(player);
     console.log("[Tracker UI] Persistent header Lottie created.");
}


// --- Drag and Drop Logic ---

// Book Drag (From Main List to Category)
function handleBookDragOverCategory(event) {
    if (draggedItemInfo?.type === 'book') {
        event.preventDefault(); event.dataTransfer.dropEffect = 'copy';
        event.currentTarget.classList.add('drag-over-books');
        currentDragOverElement = event.currentTarget;
    }
}
function handleBookDragLeaveCategory(event) {
    if (currentDragOverElement === event.currentTarget && !event.currentTarget.contains(event.relatedTarget)) {
        event.currentTarget.classList.remove('drag-over-books');
        currentDragOverElement = null;
    }
}
async function handleBookDropInCategory(event) {
    if (draggedItemInfo?.type !== 'book') return;
    event.preventDefault(); event.stopPropagation();
    const dropTarget = event.currentTarget; dropTarget.classList.remove('drag-over-books');
    currentDragOverElement = null;
    const categoryElement = dropTarget.closest('.tracker-category');
    const categoryId = categoryElement?.dataset.categoryId;
    if (!categoryId) { clearDraggedItemInfo(); return; }
    const categoryIndex = trackerData.findIndex(c => c.id === categoryId);
    if (categoryIndex === -1) { clearDraggedItemInfo(); return; }
    let bookData;
    try { bookData = draggedItemInfo.data || JSON.parse(event.dataTransfer.getData('application/json')); }
    catch (err) { clearDraggedItemInfo(); return; }
    if (!bookData || !bookData.link) { clearDraggedItemInfo(); return; }
    if (isDuplicateTrackedItem(bookData.link)) { alert("Book already tracked."); clearDraggedItemInfo(); return; }
    // Add book with empty price history
    const bookToAdd = { ...bookData, specs: undefined, priceHistory: [] };
    trackerData[categoryIndex].books.push(bookToAdd);
    const booksContainer = categoryElement.querySelector('.category-books-container');
    if (booksContainer) renderCategoryBooks(booksContainer, trackerData[categoryIndex].books, categoryId, trackerData[categoryIndex].color);
    else renderCategoriesAndBooks();
    await saveTrackerData('add book');
    clearDraggedItemInfo();
}

// Placeholder Drop (for adding to first category when empty)
function handleBookDragOverPlaceholder(event) {
    if (draggedItemInfo?.type === 'book' && trackerData.length > 0) {
        event.preventDefault(); event.dataTransfer.dropEffect = 'copy';
        event.currentTarget.classList.add('drag-over-books');
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
     event.preventDefault(); event.stopPropagation(); event.currentTarget.classList.remove('drag-over-books');
     currentDragOverElement = null;
     const firstCategoryId = trackerData[0].id; const firstCategoryIndex = 0;
     let bookData;
     try { bookData = draggedItemInfo.data || JSON.parse(event.dataTransfer.getData('application/json')); }
     catch (err) { clearDraggedItemInfo(); return; }
     if (!bookData || !bookData.link) { clearDraggedItemInfo(); return; }
     if (isDuplicateTrackedItem(bookData.link)) { alert("Book already tracked."); clearDraggedItemInfo(); return; }
     // Add book with empty price history
     const bookToAdd = { ...bookData, specs: undefined, priceHistory: [] };
     trackerData[firstCategoryIndex].books.push(bookToAdd);
     renderCategoriesAndBooks();
     await saveTrackerData('add book placeholder');
     clearDraggedItemInfo();
}

// Node Drag (Reordering within a Category)
function handleNodeDragStart(event) {
    const node = event.target.closest('.tracker-node');
    const sourceCategoryId = node?.dataset.categoryId; const sourceLink = node?.dataset.link;
    if (!node || !sourceCategoryId || !sourceLink) { event.preventDefault(); return; }
    const sourceCategoryIndex = trackerData.findIndex(c => c.id === sourceCategoryId);
    if (sourceCategoryIndex === -1) { event.preventDefault(); return; }
    const sourceCategory = trackerData[sourceCategoryIndex];
    const sourceNodeIndex = sourceCategory.books.findIndex(b => b.link === sourceLink);
    if (sourceNodeIndex === -1) { event.preventDefault(); return; }
    setDraggedItemInfo({ type: 'node', link: sourceLink, sourceCategoryId: sourceCategoryId, sourceNodeIndex: sourceNodeIndex, data: { ...sourceCategory.books[sourceNodeIndex] } });
    event.dataTransfer.effectAllowed = 'move';
    try { event.dataTransfer.setData('text/plain', sourceLink); } catch (err) {}
    setTimeout(() => node.classList.add('dragging'), 0);
}
function handleNodeDragEnd(event) {
    clearNodeDropZoneStyles();
    if (draggedItemInfo?.type === 'node' && draggedItemInfo.link) {
        const node = window.trackerCategoriesContainer?.querySelector(`.tracker-node[data-link="${CSS.escape(draggedItemInfo.link)}"]`);
        node?.classList.remove('dragging');
    } clearDraggedItemInfo();
}
function clearNodeDropZoneStyles() {
     if (!window.trackerCategoriesContainer) return;
    window.trackerCategoriesContainer.querySelectorAll('.drop-zone.node-drop-zone.drag-over')
        .forEach(zone => zone.classList.remove('drag-over'));
    currentDragOverElement = null;
}
function handleNodeDragOver(event) {
    if (draggedItemInfo?.type !== 'node') return;
    const dropZone = event.target.closest('.drop-zone.node-drop-zone');
    if (!dropZone) { if (currentDragOverElement && event.target.classList.contains('category-books-container')) clearNodeDropZoneStyles(); return; }
    const targetCategoryId = dropZone.dataset.categoryId; const sourceCategoryId = draggedItemInfo.sourceCategoryId;
    if (!targetCategoryId || targetCategoryId !== sourceCategoryId) { clearNodeDropZoneStyles(); return; }
    event.preventDefault(); event.dataTransfer.dropEffect = 'move';
    if (currentDragOverElement !== dropZone) { clearNodeDropZoneStyles(); dropZone.classList.add('drag-over'); currentDragOverElement = dropZone; }
}
function handleNodeDragLeave(event) {
    if (draggedItemInfo?.type !== 'node') return;
    const zone = event.target.closest('.drop-zone.node-drop-zone');
    if (zone && zone === currentDragOverElement && !zone.contains(event.relatedTarget)) { zone.classList.remove('drag-over'); currentDragOverElement = null; }
}
async function handleNodeDrop(event) {
    if (draggedItemInfo?.type !== 'node') return;
    event.preventDefault(); event.stopPropagation();
    const dropZone = event.target.closest('.drop-zone.node-drop-zone'); clearNodeDropZoneStyles();
    if (!dropZone) { clearDraggedItemInfo(); return; }
    const targetCategoryId = dropZone.dataset.categoryId; const insertAtIndex = parseInt(dropZone.dataset.insertAtIndex, 10);
    const sourceCategoryId = draggedItemInfo.sourceCategoryId; const sourceLink = draggedItemInfo.link; const sourceNodeIndex = draggedItemInfo.sourceNodeIndex;
    if (!sourceLink || sourceCategoryId !== targetCategoryId || isNaN(insertAtIndex) || isNaN(sourceNodeIndex)) { clearDraggedItemInfo(); return; }
    const categoryIndex = trackerData.findIndex(c => c.id === sourceCategoryId); if (categoryIndex === -1) { clearDraggedItemInfo(); return; }
    const category = trackerData[categoryIndex]; if (!Array.isArray(category.books)) { clearDraggedItemInfo(); return; }
    if (sourceNodeIndex < 0 || sourceNodeIndex >= category.books.length) { clearDraggedItemInfo(); return; }
    if (insertAtIndex < 0 || insertAtIndex > category.books.length) { clearDraggedItemInfo(); return; }
    const [itemToMove] = category.books.splice(sourceNodeIndex, 1);
    if (!itemToMove) { renderCategoriesAndBooks(); clearDraggedItemInfo(); return; }
    const adjustedInsertIndex = (sourceNodeIndex < insertAtIndex) ? insertAtIndex - 1 : insertAtIndex;
    category.books.splice(adjustedInsertIndex, 0, itemToMove);
    const booksContainer = window.trackerCategoriesContainer?.querySelector(`.tracker-category[data-category-id="${sourceCategoryId}"] .category-books-container`);
    if (booksContainer) renderCategoryBooks(booksContainer, category.books, sourceCategoryId, category.color);
    else renderCategoriesAndBooks();
    await saveTrackerData('reorder book');
    clearDraggedItemInfo();
}

// Category Drag (Reordering Categories)
function handleCategoryDragStart(event) {
    if (event.target.closest('button, input')) { event.preventDefault(); return; }
    const header = event.target.closest('.category-header'); const categoryElement = header?.closest('.tracker-category'); const sourceCategoryId = categoryElement?.dataset.categoryId;
    if (!header || !categoryElement || !sourceCategoryId) { event.preventDefault(); return; }
    const sourceIndex = trackerData.findIndex(c => c.id === sourceCategoryId); if (sourceIndex === -1) { event.preventDefault(); return; }
    resetAllDeleteConfirmations();
    setDraggedItemInfo({ type: 'category', sourceCategoryId: sourceCategoryId, sourceIndex: sourceIndex });
    event.dataTransfer.effectAllowed = 'move'; try { event.dataTransfer.setData('text/plain', `category-${sourceCategoryId}`); } catch (err) {}
    if (window.trackerCategoriesContainer) { window.trackerCategoriesContainer.querySelectorAll('.drop-zone.category-drop-zone').forEach(zone => zone.classList.add('visible')); }
    setTimeout(() => { categoryElement.classList.add('dragging'); header.classList.add('dragging'); }, 0);
}
function handleCategoryDragEnd(event) {
    if (draggedItemInfo?.type === 'category') {
        const sourceId = draggedItemInfo.sourceCategoryId;
        if (window.trackerCategoriesContainer) {
            const categoryElement = window.trackerCategoriesContainer.querySelector(`.tracker-category[data-category-id="${sourceId}"]`);
            categoryElement?.classList.remove('dragging'); categoryElement?.querySelector('.category-header')?.classList.remove('dragging');
        }
    } clearCategoryDropZoneStyles(); clearDraggedItemInfo();
}
function clearCategoryDropZoneStyles() {
     if (!window.trackerCategoriesContainer) return;
    window.trackerCategoriesContainer.querySelectorAll('.drop-zone.category-drop-zone')
        .forEach(zone => zone.classList.remove('visible', 'drop-target-highlight'));
    currentDragOverElement = null;
}
function handleCategoryDragOverContainer(event) {
    if (draggedItemInfo?.type !== 'category') return;
    const dropZone = event.target.closest('.drop-zone.category-drop-zone.visible');
    if (!dropZone) { if (currentDragOverElement) { currentDragOverElement.classList.remove('drop-target-highlight'); currentDragOverElement = null; } return; }
    event.preventDefault(); event.dataTransfer.dropEffect = 'move';
    if (currentDragOverElement !== dropZone) { if (currentDragOverElement) currentDragOverElement.classList.remove('drop-target-highlight'); dropZone.classList.add('drop-target-highlight'); currentDragOverElement = dropZone; }
}
function handleCategoryDragLeaveContainer(event) {
    if (draggedItemInfo?.type !== 'category') return;
    const zone = event.target.closest('.drop-zone.category-drop-zone.visible');
    const relatedTarget = event.relatedTarget ? event.relatedTarget.closest('.drop-zone.category-drop-zone.visible') : null;
    if (currentDragOverElement && currentDragOverElement === zone && currentDragOverElement !== relatedTarget) { currentDragOverElement.classList.remove('drop-target-highlight'); currentDragOverElement = null; }
}
async function handleCategoryDrop(event) {
    if (draggedItemInfo?.type !== 'category') return;
    event.preventDefault(); event.stopPropagation();
    const dropZone = event.target.closest('.drop-zone.category-drop-zone.visible'); clearCategoryDropZoneStyles();
    if (!dropZone) { clearDraggedItemInfo(); return; }
    const targetInsertIndex = parseInt(dropZone.dataset.insertAtIndex, 10); const sourceIndex = draggedItemInfo.sourceIndex; const sourceId = draggedItemInfo.sourceCategoryId;
    const localDragInfo = { ...draggedItemInfo }; clearDraggedItemInfo();
    if (isNaN(targetInsertIndex) || sourceIndex == null || isNaN(sourceIndex) || !sourceId) return;
    if (targetInsertIndex === sourceIndex || targetInsertIndex === sourceIndex + 1) { renderCategoriesAndBooks(); return; }
    const [categoryToMove] = trackerData.splice(sourceIndex, 1);
    if (!categoryToMove) { renderCategoriesAndBooks(); return; }
    const adjustedInsertIndex = (sourceIndex < targetInsertIndex) ? targetInsertIndex - 1 : targetInsertIndex;
    trackerData.splice(adjustedInsertIndex, 0, categoryToMove);
    renderCategoriesAndBooks();
    await saveTrackerData('reorder category');
}


// --- Global Drag State Management ---
function setDraggedItemInfo(info) { draggedItemInfo = info; }
function clearDraggedItemInfo() { draggedItemInfo = null; }


// --- NEW Price Tracking Logic ---

/** Fetches prices for a single book from the backend */
async function fetchBookPrices(bookLink, bookTitle = 'book') {
    if (!bookLink) return null;
    console.info(`[Tracker Price Check] Fetching prices for: ${bookTitle} (${bookLink})`); // Use console.info
    try {
        if (!window.PYTHON_BACKEND_URL) throw new Error("Backend URL not configured.");
        const encodedUrl = encodeURIComponent(bookLink);
        const fetchUrl = `${window.PYTHON_BACKEND_URL}/fetch-book-details-and-prices?url=${encodedUrl}`;
        const response = await fetch(fetchUrl);
        if (!response.ok) {
            let errorMsg = `HTTP error ${response.status}`;
            try { const errData = await response.json(); errorMsg += `: ${errData.error || 'Unknown backend error'}`; } catch { /* ignore */ }
            throw new Error(errorMsg);
        }
        const result = await response.json();
        if (!result.success) {
            throw new Error(result.error || 'Backend reported failure fetching prices');
        }
        const fetchedPrices = result.prices;
        if (typeof fetchedPrices !== 'object' || fetchedPrices === null) {
             throw new Error("Invalid price data format received from backend.");
        }
        console.info(`[Tracker Price Check] Prices received for ${bookTitle}:`, fetchedPrices); // Use console.info
        if (result.details && typeof result.details === 'object') {
            bookSpecsCache.set(bookLink, result.details);
        }
        return fetchedPrices;
    } catch (error) {
        console.error(`[Tracker Price Check] Error fetching prices for ${bookLink}:`, error);
        return { fetchError: error.message };
    }
}

/** The main function called by the interval to check all tracked book prices */
async function performPriceCheckCycle() {
    if (isCurrentlyCheckingPrices) {
        console.warn("[Tracker Price Check] Skipping cycle, previous check still running.");
        return;
    }
    if (!trackerData || trackerData.length === 0) {
        console.log("[Tracker Price Check] No tracked items to check.");
        scheduleNextPriceCheck(); // Still need to schedule the next one
        return;
    }

    isCurrentlyCheckingPrices = true;
    const checkStartTime = Date.now();
    let booksChecked = 0;
    let updatesMade = false;
    console.log("[Tracker Price Check] Starting price check cycle...");
    if(window.statusBar) window.statusBar.textContent = 'Checking tracked prices...';

    for (const category of trackerData) {
        if (category.books && category.books.length > 0) {
            for (const book of category.books) {
                if (book && book.link) {
                    const fetchedPrices = await fetchBookPrices(book.link, book.title);
                    booksChecked++;

                    if (fetchedPrices && !fetchedPrices.fetchError) {
                        if (!Array.isArray(book.priceHistory)) book.priceHistory = [];
                        book.priceHistory.push({
                            timestamp: Date.now(),
                            currentPrice: fetchedPrices.currentPrice,
                            oldPrice: fetchedPrices.oldPrice,
                            voucherPrice: fetchedPrices.voucherPrice,
                            voucherCode: fetchedPrices.voucherCode
                        });
                        updatesMade = true;
                        // Optional: Update top-level book price fields for immediate display?
                        book.current_price = fetchedPrices.currentPrice;
                        book.old_price = fetchedPrices.oldPrice;
                        book.voucher_price = fetchedPrices.voucherPrice;
                        book.voucher_code = fetchedPrices.voucherCode;
                    } else {
                        console.warn(`[Tracker Price Check] Failed to get prices for "${book.title || book.link}". Error: ${fetchedPrices?.fetchError || 'Unknown'}`);
                    }
                    await new Promise(resolve => setTimeout(resolve, 200)); // Small delay
                }
            }
        }
    }

    const durationMs = Date.now() - checkStartTime;
    console.log(`[Tracker Price Check] Cycle finished in ${durationMs / 1000}s. Checked: ${booksChecked} books.`);

    if (updatesMade) {
        console.log("[Tracker Price Check] Price updates found, saving data...");
        // Optional: Re-render nodes if top-level prices were updated
        // renderCategoriesAndBooks(); // This might be too disruptive?
        await saveTrackerData('update prices');
    } else {
         if(window.statusBar) window.statusBar.textContent = 'Price check complete (no changes).';
    }

    isCurrentlyCheckingPrices = false;
    scheduleNextPriceCheck(); // Schedule the next check after this one completes
}

/** Determines the next interval time and schedules the check */
function scheduleNextPriceCheck() {
     if (priceCheckIntervalId) { clearTimeout(priceCheckIntervalId); }

    const timeSinceStart = Date.now() - appStartTime;
    let intervalMs;

    if (timeSinceStart < BOOST_DURATION_MS) {
        intervalMs = BOOST_INTERVAL_MS;
        console.log(`[Tracker Price Check] Scheduling next check in ${intervalMs / 1000 / 60} mins (Boost Active).`);
    } else {
        intervalMs = NORMAL_INTERVAL_MS;
        console.log(`[Tracker Price Check] Scheduling next check in ${intervalMs / 1000 / 60} mins (Normal).`);
    }

     priceCheckIntervalId = setTimeout(() => {
         performPriceCheckCycle();
     }, intervalMs);
}


/** Starts the periodic price checking */
function startPriceCheckingInterval() {
    console.log("[Tracker Price Check] Initializing price checking schedule...");
    stopPriceCheckingInterval();
    appStartTime = Date.now();
    isCurrentlyCheckingPrices = false;
    setTimeout(() => {
         performPriceCheckCycle();
    }, 5000); // Start first check after 5 seconds
}

/** Stops the periodic price checking */
function stopPriceCheckingInterval() {
    if (priceCheckIntervalId) {
        clearTimeout(priceCheckIntervalId);
        priceCheckIntervalId = null;
        console.log("[Tracker Price Check] Price checking interval stopped.");
    }
    isCurrentlyCheckingPrices = false;
}


// --- Initialization ---
function setupTrackerEventListeners() {
    if (!window.addCategoryBtn) {
         console.error("[Tracker UI] Cannot setup listeners - Add Category Button missing.");
         return;
    }
    window.addCategoryBtn.addEventListener('click', handleAddCategory);
     document.body.addEventListener('click', (event) => {
         if (!event.target.closest('.delete-category-btn')) {
             resetAllDeleteConfirmations();
         }
     }, true);
     console.log("[Tracker UI] Event listeners setup.");
}

// Export functions/state needed by other modules
window.AppTrackerUI = {
    initialize: async () => {
        createPersistentLottie();
        setupTrackerEventListeners();
        await loadAndDisplayTrackedItems(); // Loads data, renders, and STARTS the interval
    },
    trackerData,
    bookSpecsCache,
    saveTrackerData,
    loadAndDisplayTrackedItems,
    applyTrackerColorsToBookList,
    setDraggedItemInfo,
    clearDraggedItemInfo,
    stopPriceChecking: stopPriceCheckingInterval // Expose stop function
};
console.log("[Tracker UI] Module loaded.");
