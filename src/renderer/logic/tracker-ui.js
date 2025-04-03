// src/renderer/logic/tracker-ui.js

// Assumes necessary DOM elements (window.*), electronAPI, AppUIUtils are globally available via renderer.js
// Assumes AppPanelManager, AppDetailsOverlay, AppRuntime are globally available

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
                    if (!b || typeof b !== 'object') return null; // Skip invalid book entries
                    // Cache specs if they exist in the loaded data
                    if (b.link && b.specs) {
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
                        // Ensure priceHistory is always an array
                        priceHistory: Array.isArray(b.priceHistory) ? b.priceHistory : []
                        // specs are handled by the cache, not stored directly in UI state
                    };
                }).filter(b => b !== null && b.link); // Filter out invalid/skipped books and ensure link exists

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
                    // Ensure price history is saved correctly
                    priceHistory: Array.isArray(book.priceHistory) ? book.priceHistory : []
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
            // Avoid redundant alert if main process already showed one
            // alert("Error: Could not save tracker data (Save operation failed).");
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
    if (!window.trackerCategoriesContainer) {
        console.error("[Tracker UI] Cannot render: trackerCategoriesContainer not found.");
        return;
    }

    // Preserve collapse states if possible (optional, can simplify by just using trackerData state)
    // const currentCollapseStates = {};
    // window.trackerCategoriesContainer.querySelectorAll('.tracker-category').forEach(el => {
    //     if(el.dataset.categoryId) currentCollapseStates[el.dataset.categoryId] = el.classList.contains('collapsed');
    // });

    // Clear pending delete confirmations before re-rendering
    resetAllDeleteConfirmations();
    // Clear current content
    window.trackerCategoriesContainer.innerHTML = '';

    if (!trackerData || trackerData.length === 0) {
        // Display placeholder if no categories exist
        window.trackerCategoriesContainer.innerHTML = '<p class="tracker-node-placeholder">No stacks defined. Click "New Stack" or drag books here to start tracking!</p>';
        const placeholder = window.trackerCategoriesContainer.querySelector('.tracker-node-placeholder');
        if (placeholder) {
            // Add drop listeners to the main placeholder *only if* no categories exist
             // These seem incorrect - should drop onto category or specific drop zone
             // placeholder.addEventListener('dragover', handleBookDragOverCategory); // Incorrect target?
             // placeholder.addEventListener('dragleave', handleBookDragLeaveCategory);
             // placeholder.addEventListener('drop', handleBookDropInCategory); // Incorrect target?
             console.warn("[Tracker UI] Placeholder drag listeners might be incorrect.");
        }
        return;
    }

    // Add initial drop zone for reordering before the first category
    window.trackerCategoriesContainer.appendChild(createCategoryDropZoneElement(0));

    // Render each category
    trackerData.forEach((category, index) => {
        if (!category || typeof category !== 'object' || !category.id) {
            console.warn(`[Tracker UI] Skipping render of invalid category at index ${index}:`, category);
            return;
        }
        // Ensure category has a color (assign if missing)
        if (!category.color) {
            category.color = getCategoryColorById(category.id);
        }
        // Create category element
        const categoryElement = createCategoryElement(category, index);
        window.trackerCategoriesContainer.appendChild(categoryElement);
        // Add drop zone after each category for reordering
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

    // Apply background color based on category color
    if (category.color) {
        const bgAlpha = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--category-base-bg-alpha').trim() || 0.5);
        div.style.backgroundColor = window.AppUIUtils.createHslaColor(category.color, bgAlpha);
    }

    // --- Category Header ---
    const header = document.createElement('div');
    header.className = 'category-header';
    header.draggable = true; // Make header draggable for reordering category
    header.dataset.categoryId = category.id;
    header.addEventListener('dragstart', handleCategoryDragStart);
    header.addEventListener('dragend', handleCategoryDragEnd);
    // Prevent drag starting on buttons/input inside header
    header.addEventListener('mousedown', (e) => {
        if (e.target.closest('button, input')) {
            e.stopPropagation(); // Don't let mousedown on controls bubble up to header
        }
    }, true); // Use capture phase

    // Collapse Button
    const collapseBtn = document.createElement('button');
    collapseBtn.className = 'collapse-category-btn';
    collapseBtn.innerHTML = category.isCollapsed ? 'â–¶' : 'â–¼'; // Use standard arrows
    collapseBtn.title = category.isCollapsed ? 'Expand Stack' : 'Collapse Stack';
    collapseBtn.addEventListener('click', handleCategoryCollapseToggle);
    header.appendChild(collapseBtn);

     // View Details Button
     const viewBtn = document.createElement('button');
     viewBtn.className = 'view-category-btn';
     viewBtn.innerHTML = 'â„¹ï¸ '; // Info icon
     viewBtn.title = `View Stack Details: ${category.name || 'Unnamed'}`;
     viewBtn.addEventListener('click', (e) => {
         e.stopPropagation(); // Prevent header drag start
         const catData = trackerData.find(c => c.id === div.dataset.categoryId);
         if (catData && window.AppDetailsOverlay?.showDetailsOverlay) {
             window.AppDetailsOverlay.showDetailsOverlay({ type: 'category', ...catData });
         } else {
             console.warn("[Tracker UI] Cannot show category details - data or overlay function missing.");
         }
     });
     header.appendChild(viewBtn);

    // Name Input
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'category-name-input';
    nameInput.value = category.name || 'Unnamed Stack';
    nameInput.dataset.originalName = category.name || 'Unnamed Stack'; // Store original name
    nameInput.placeholder = 'Stack Name';
    nameInput.title = 'Click to rename stack';
    nameInput.addEventListener('blur', handleCategoryRename); // Save on blur
    nameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); nameInput.blur(); } // Save on Enter
        else if (e.key === 'Escape') { nameInput.value = nameInput.dataset.originalName; nameInput.blur(); } // Revert on Escape
    });
    nameInput.addEventListener('click', (e) => e.stopPropagation()); // Prevent header drag
    header.appendChild(nameInput);

    // Delete Button
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'delete-category-btn';
    deleteBtn.innerHTML = 'Ã—'; // Standard close icon
    deleteBtn.title = 'Delete Stack';
    deleteBtn.addEventListener('click', handleDeleteCategory);
    header.appendChild(deleteBtn);

    div.appendChild(header);

    // --- Books Container ---
    const booksContainer = document.createElement('div');
    booksContainer.className = 'category-books-container';
    booksContainer.dataset.categoryId = category.id; // Link to category
    // Drag listeners for adding books *to* this category
    booksContainer.addEventListener('dragover', handleBookDragOverCategory);
    booksContainer.addEventListener('dragleave', handleBookDragLeaveCategory);
    booksContainer.addEventListener('drop', handleBookDropInCategory);
    // Drag listeners for reordering nodes *within* this category
    booksContainer.addEventListener('dragover', handleNodeDragOver); // Needed for drop zone detection
    booksContainer.addEventListener('dragleave', handleNodeDragLeave); // Needed for drop zone exit
    booksContainer.addEventListener('drop', handleNodeDrop); // Needed for node drop zone

    div.appendChild(booksContainer);

    // Render books into the container
    renderCategoryBooks(booksContainer, category.books || [], category.id, category.color);

    return div;
}

/** Renders the book nodes (and drop zones) within a specific category's container */
function renderCategoryBooks(containerElement, booksArray, categoryId, categoryColor) {
    if (!containerElement) return;

    // Clear previous content (important for re-renders)
    containerElement.innerHTML = '';

    // Add initial drop zone for inserting at the beginning
    containerElement.appendChild(createNodeDropZoneElement(categoryId, 0));

    if (!booksArray || booksArray.length === 0) {
        // Display placeholder if category is empty
        const placeholder = document.createElement('div');
        placeholder.className = 'tracker-node-placeholder';
        placeholder.textContent = '(Drag books here)';
        // Add drop listeners to the placeholder itself
        placeholder.addEventListener('dragover', handleBookDragOverCategory);
        placeholder.addEventListener('dragleave', handleBookDragLeaveCategory);
        placeholder.addEventListener('drop', handleBookDropInCategory);
        containerElement.appendChild(placeholder);
    } else {
        // Render each book node and a drop zone after it
        booksArray.forEach((book, index) => {
            addSingleTrackerNodeElement(containerElement, book, categoryId, categoryColor, index);
            // Add drop zone after each node for reordering
            containerElement.appendChild(createNodeDropZoneElement(categoryId, index + 1));
        });
    }
}

/** Creates and appends a single tracker node (book item) to the container */
function addSingleTrackerNodeElement(containerElement, book, categoryId, categoryColor, index) {
    // Basic validation for the book object
    if (!book || typeof book !== 'object' || (!book.title && !book.link)) {
        console.warn("[Tracker UI] Skipping node render, invalid book data:", book);
        return;
    }

    const node = document.createElement('div');
    node.className = 'tracker-node';
    node.draggable = true; // Make the node draggable

    // Use link as the primary identifier, fallback if necessary
    const link = book.link || `no-link-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    node.dataset.link = link;
    node.dataset.categoryId = categoryId;
    node.dataset.nodeIndex = index; // Store index for drag/drop logic

    // Store essential book data for click/drag events (minimize stored data)
    try {
        const nodeData = {
            link: book.link,
            title: book.title,
            current_price: book.current_price, // Needed for details overlay preview
            old_price: book.old_price,
            voucher_price: book.voucher_price,
            voucher_code: book.voucher_code,
            local_image_filename: book.local_image_filename,
            priceHistory: book.priceHistory || [] // Include history for details view
        };
        node.dataset.bookData = JSON.stringify(nodeData);
    } catch (e) {
        console.error("[Tracker UI] Error stringifying node data:", e);
        node.dataset.bookData = '{}'; // Fallback
    }

    // Apply border color based on category color
    if (categoryColor) {
        const borderAlpha = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--node-border-alpha').trim() || 0.8);
        // Use a slightly lighter/more opaque version for the border maybe?
        node.style.borderColor = window.AppUIUtils.createHslaColor(categoryColor, borderAlpha);
    } else {
        node.style.borderColor = 'var(--border-color)'; // Fallback border
    }

    // Title Span
    const titleSpan = document.createElement('span');
    titleSpan.className = 'tracker-node-title';
    titleSpan.textContent = book.title || 'Untitled Book';
    titleSpan.title = book.title || 'Untitled Book'; // Tooltip
    node.appendChild(titleSpan);

    // Controls Container
    const controlsDiv = document.createElement('div');
    controlsDiv.className = 'tracker-node-controls';

    // Remove Button
    const removeBtn = document.createElement('button');
    removeBtn.className = 'remove-node-btn';
    removeBtn.innerHTML = 'Ã—';
    removeBtn.title = 'Remove this book from tracker';
    removeBtn.addEventListener('click', handleRemoveTrackedItem);
    controlsDiv.appendChild(removeBtn);

    node.appendChild(controlsDiv);

    // Event listeners for the node itself
    node.addEventListener('dragstart', handleNodeDragStart);
    node.addEventListener('dragend', handleNodeDragEnd);
    // Click listener for showing details (ignore clicks on the remove button)
    node.addEventListener('click', (e) => {
        if (!e.target.closest('.remove-node-btn')) {
            try {
                const data = JSON.parse(e.currentTarget.dataset.bookData || '{}');
                if (window.AppDetailsOverlay?.showDetailsOverlay) {
                    // Pass the stored data, overlay will fetch full specs if needed
                    window.AppDetailsOverlay.showDetailsOverlay(data);
                } else {
                     console.warn("[Tracker UI] Cannot show details - AppDetailsOverlay unavailable.");
                }
            } catch (err) {
                console.error("[Tracker UI] Error parsing node data on click:", err);
                alert("Error loading details for this item.");
            }
        }
    });

    // Insert the node before the last element (which should be a drop zone)
    // This ensures nodes are added between drop zones correctly during initial render.
    const lastDropZone = containerElement.querySelector('.drop-zone.node-drop-zone:last-of-type');
    if (lastDropZone) {
         containerElement.insertBefore(node, lastDropZone);
    } else {
         // Fallback if no drop zone found (e.g., first item)
         containerElement.appendChild(node);
    }
}

/** Creates a drop zone element for reordering nodes within a category */
function createNodeDropZoneElement(categoryId, insertIndex) {
    const zone = document.createElement('div');
    zone.className = 'drop-zone node-drop-zone';
    zone.dataset.categoryId = categoryId;
    zone.dataset.insertAtIndex = insertIndex; // Index where a dropped item should be inserted
    // Drag listeners for node reordering
    zone.addEventListener('dragover', handleNodeDragOver);
    zone.addEventListener('dragleave', handleNodeDragLeave);
    zone.addEventListener('drop', handleNodeDrop);
    return zone;
}

/** Creates a drop zone element for reordering categories */
function createCategoryDropZoneElement(insertIndex) {
    const zone = document.createElement('div');
    zone.className = 'drop-zone category-drop-zone'; // Initially hidden via CSS
    zone.dataset.insertAtIndex = insertIndex; // Index where a dropped category should be inserted
    // Drag listeners for category reordering
    zone.addEventListener('dragover', handleCategoryDragOverContainer);
    zone.addEventListener('dragleave', handleCategoryDragLeaveContainer);
    zone.addEventListener('drop', handleCategoryDrop);
    return zone;
}


/** Updates book item borders in the main list based on tracked items */
function applyTrackerColorsToBookList() {
    if (!window.tabContentContainer) return; // Ensure book list container exists

    // Create a map of bookLink -> categoryColor for efficient lookup
    const trackedBookColors = new Map();
    trackerData.forEach((category) => {
        if (category.id && category.books && category.color) {
            // Get calculated color string once per category
            const borderAlpha = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--book-item-border-alpha').trim() || 0.8);
            const colorString = window.AppUIUtils.createHslaColor(category.color, borderAlpha);
            // Add each book link from this category to the map
            category.books.forEach(book => {
                if (book && book.link) {
                    trackedBookColors.set(book.link, colorString);
                }
            });
        }
    });

    // Iterate over all book items currently rendered in the main list
    window.tabContentContainer.querySelectorAll('.book-item').forEach(item => {
        const link = item.dataset.bookLink;
        if (link && trackedBookColors.has(link)) {
            // Apply color and class if the book is tracked
            item.style.borderLeftColor = trackedBookColors.get(link);
            item.classList.add('tracked-by-category');
        } else {
            // Reset style and class if the book is not tracked (or link missing)
            item.style.borderLeftColor = 'transparent'; // Or var(--border-color)
            item.classList.remove('tracked-by-category');
        }
    });
     // console.debug("[Tracker UI] Applied category colors to book list items.");
}

/** Checks if a book with the given link is already tracked in any category */
function isDuplicateTrackedItem(link) {
    if (!link || typeof link !== 'string') return false;
    return trackerData.some(category =>
        category.books.some(book => book && book.link === link)
    );
}


// --- Event Handlers ---

/** Handle category rename input blur (save) */
async function handleCategoryRename(event) {
    const input = event.target;
    const categoryElement = input.closest('.tracker-category');
    const categoryId = categoryElement?.dataset.categoryId;

    // Ensure category ID exists
    if (!categoryId) {
        console.error("[Tracker UI] Cannot rename category: Missing category ID.");
        input.value = input.dataset.originalName || ''; // Revert if ID missing
        return;
    }

    // Reset delete confirmation state if active for this category
    const deleteBtn = categoryElement?.querySelector('.delete-category-btn');
    if (deleteBtn) resetDeleteConfirmation(deleteBtn, categoryId);

    // Find the category index in our data
    const categoryIndex = trackerData.findIndex(c => c.id === categoryId);
    if (categoryIndex === -1) {
        console.error(`[Tracker UI] Category ${categoryId} not found in data for rename.`);
        input.value = input.dataset.originalName || ''; // Revert if data missing
        return;
    }

    const newName = input.value.trim(); // Trim whitespace
    const originalName = trackerData[categoryIndex].name;

    // Save only if the name is valid and actually changed
    if (newName && newName !== originalName) {
        trackerData[categoryIndex].name = newName; // Update data model
        input.dataset.originalName = newName; // Update original name dataset attr

        // Update associated UI elements (like view button title)
        const viewBtn = categoryElement.querySelector('.view-category-btn');
        if (viewBtn) viewBtn.title = `View Stack Details: ${newName}`;

        await saveTrackerData('rename category'); // Save changes
    } else {
        // If name is empty or unchanged, revert input value to original
        input.value = originalName;
        if (newName !== originalName) console.log("[Tracker UI] Rename cancelled (name was empty).");
    }
}

/** Handle clicking the delete category button (initiates confirmation) */
async function handleDeleteCategory(event) {
    event.stopPropagation(); // Prevent triggering header drag, etc.
    const button = event.currentTarget;
    const categoryElement = button.closest('.tracker-category');
    const categoryId = categoryElement?.dataset.categoryId;

    if (!categoryId || !button) return; // Exit if no ID or button

    const isPendingConfirmation = button.dataset.deletePending === 'true';

    if (isPendingConfirmation) {
        // --- Confirmed Delete ---
        console.log(`[Tracker UI] Confirmed delete for category: ${categoryId}`);
        resetDeleteConfirmation(button, categoryId); // Clear timer and pending state immediately

        // Find index and remove from data model
        const categoryIndex = trackerData.findIndex(c => c.id === categoryId);
        if (categoryIndex === -1) {
            console.warn(`[Tracker UI] Category ${categoryId} already removed from data? Removing element.`);
            categoryElement.remove(); // Remove element anyway
            return; // No save needed if not in data
        }

        const removedCategory = trackerData.splice(categoryIndex, 1)[0];

        // Clear specs cache for books in the removed category
        if (removedCategory?.books) {
            removedCategory.books.forEach(book => {
                 if (book.link) bookSpecsCache.delete(book.link);
            });
            console.log(`[Tracker UI] Cleared specs cache for ${removedCategory.books.length} items from deleted category ${categoryId}.`);
        }

        // Remove the category element and its preceding drop zone from DOM
        const precedingDropZone = categoryElement.previousElementSibling;
        categoryElement.remove();
        // Only remove drop zone if it's a category drop zone
        if (precedingDropZone?.classList.contains('category-drop-zone')) {
            precedingDropZone.remove();
        }

        // Re-index remaining category drop zones
        window.trackerCategoriesContainer?.querySelectorAll('.drop-zone.category-drop-zone').forEach((zone, index) => {
            zone.dataset.insertAtIndex = index;
        });

        // If last category was deleted, render the placeholder
        if (trackerData.length === 0 && window.trackerCategoriesContainer) {
            renderCategoriesAndBooks(); // Re-render to show placeholder
        }

        await saveTrackerData('delete category'); // Save the updated data

    } else {
        // --- Initiate Confirmation ---
        console.log(`[Tracker UI] Initiating delete confirmation for category: ${categoryId}`);
        // Reset all other pending confirmations first
        resetAllDeleteConfirmations(button); // Exclude current button

        // Set pending state on the button
        button.dataset.deletePending = 'true';
        button.classList.add('delete-pending');
        button.innerHTML = '?'; // Change icon to indicate confirmation needed
        button.title = 'Click again to confirm delete';

        // Start timer to automatically cancel confirmation
        const timerId = setTimeout(() => {
            console.log(`[Tracker UI] Delete confirmation timed out for ${categoryId}.`);
            resetDeleteConfirmation(button, categoryId);
        }, DELETE_CONFIRM_TIMEOUT);

        // Store the timer ID
        deleteConfirmTimers.set(categoryId, timerId);
    }
}

/** Resets the delete confirmation state for a specific button/category */
function resetDeleteConfirmation(button, categoryId) {
    if (!button || !categoryId) return;

    // Clear the timeout if it exists
    const timerId = deleteConfirmTimers.get(categoryId);
    if (timerId) {
        clearTimeout(timerId);
        deleteConfirmTimers.delete(categoryId); // Remove from map
    }

    // Reset button appearance and state
    button.classList.remove('delete-pending');
    button.innerHTML = 'Ã—'; // Reset icon
    button.title = 'Delete Stack';
    delete button.dataset.deletePending; // Remove pending flag
}

/** Resets all pending delete confirmations, optionally excluding one button */
function resetAllDeleteConfirmations(excludedButton = null) {
    if (!window.trackerCategoriesContainer) return;

    // Find all buttons currently in pending state
    window.trackerCategoriesContainer.querySelectorAll('.delete-category-btn.delete-pending').forEach(button => {
        if (button !== excludedButton) {
            const categoryElement = button.closest('.tracker-category');
            const categoryId = categoryElement?.dataset.categoryId;
            if (categoryId) {
                resetDeleteConfirmation(button, categoryId);
            }
        }
    });
}

/** Handle category collapse/expand toggle */
function handleCategoryCollapseToggle(event) {
    event.stopPropagation(); // Prevent header drag start
    const button = event.currentTarget;
    const categoryElement = button.closest('.tracker-category');
    const categoryId = categoryElement?.dataset.categoryId;

    if (!categoryElement || !categoryId) return;

    // Reset delete confirmation if active for this category
    const deleteBtn = categoryElement.querySelector('.delete-category-btn');
    if (deleteBtn) resetDeleteConfirmation(deleteBtn, categoryId);

    // Find the category in data
    const category = trackerData.find(c => c.id === categoryId);
    if (!category) return;

    // Toggle collapsed state in DOM and data model
    const isNowCollapsed = categoryElement.classList.toggle('collapsed');
    category.isCollapsed = isNowCollapsed;

    // Update button appearance and title
    button.innerHTML = isNowCollapsed ? 'â–¶' : 'â–¼';
    button.title = isNowCollapsed ? 'Expand Stack' : 'Collapse Stack';

    // Save the state change (throttled save might be better here if toggling rapidly)
    saveTrackerData('toggle collapse');
}

/** Handle removing a tracked book item from a category */
async function handleRemoveTrackedItem(event) {
    event.stopPropagation(); // Prevent node click/drag start

    const nodeElement = event.target.closest('.tracker-node');
    const link = nodeElement?.dataset.link;
    const categoryElement = nodeElement?.closest('.tracker-category');
    const categoryId = categoryElement?.dataset.categoryId;

    if (!nodeElement || !link || !categoryId) {
        console.warn("[Tracker UI] Could not remove item - missing node, link, or category ID.");
        return;
    }

    // Find category index
    const categoryIndex = trackerData.findIndex(c => c.id === categoryId);
    if (categoryIndex === -1) {
        console.warn(`[Tracker UI] Category ${categoryId} not found for item removal. Removing element only.`);
        nodeElement.remove(); // Remove from DOM anyway
        return;
    }

    const category = trackerData[categoryIndex];
    // Find book index within the category
    const bookIndex = category.books.findIndex(b => b && b.link === link);

    if (bookIndex > -1) {
        // Remove book from data model
        const removedBook = category.books.splice(bookIndex, 1)[0];
        console.log(`[Tracker UI] Removed book "${removedBook?.title || link}" from category ${categoryId}.`);

        // Remove associated specs from cache
        bookSpecsCache.delete(link);

        // Re-render the books within this category to update the DOM
        const booksContainer = categoryElement.querySelector('.category-books-container');
        if (booksContainer) {
            renderCategoryBooks(booksContainer, category.books, categoryId, category.color);
        } else {
            // Fallback: re-render all categories if container not found (less efficient)
            renderCategoriesAndBooks();
        }

        // Save the changes
        await saveTrackerData('remove book');
        applyTrackerColorsToBookList(); // Update book list borders

    } else {
        console.warn(`[Tracker UI] Book with link ${link} not found in category ${categoryId} data. Removing element only.`);
        nodeElement.remove(); // Remove from DOM if not found in data
    }
}

/** Handle adding a new category */
async function handleAddCategory() {
    resetAllDeleteConfirmations(); // Clear confirms before adding

    // Create new category object
    const newCategory = {
        id: window.AppUIUtils.generateUniqueId(), // Generate unique ID
        name: `New Stack ${trackerData.length + 1}`, // Default name
        books: [],
        isCollapsed: false,
        priceHistory: [], // Not used at category level, but consistent
        color: null // Color will be assigned below
    };
    // Assign color based on ID
    newCategory.color = getCategoryColorById(newCategory.id);

    // Add to data model
    trackerData.push(newCategory);

    // Re-render the tracker UI
    renderCategoriesAndBooks();

    // --- Focus and Scroll ---
    // Find the newly added category element after render
    const newElement = window.trackerCategoriesContainer?.querySelector(`.tracker-category[data-category-id="${newCategory.id}"]`);
    if (newElement) {
        // Scroll the new category into view
        newElement.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

        // Find the name input within the new element
        const nameInput = newElement.querySelector('.category-name-input');
        if (nameInput) {
            // Delay focus slightly to ensure element is fully rendered and scroll complete
            setTimeout(() => {
                nameInput.focus();
                nameInput.select(); // Select text for easy renaming
            }, 150); // Adjust delay if needed
        }
    }

    // Save the new state
    await saveTrackerData('add category');
    console.log(`[Tracker UI] Added new category: ${newCategory.id}`);
}

/** Creates the persistent Lottie animation in the header */
function createPersistentLottie() {
    if (!window.addStackLottieContainer) return;
    window.addStackLottieContainer.innerHTML = ''; // Clear previous if any

    const player = document.createElement('dotlottie-player');
    // Use a relevant Lottie animation for "Add Stack" or similar concept
    player.setAttribute('src', 'https://lottie.host/38d4bace-34fa-46aa-b4ff-f3e36e529bbe/j1vcYhDIk7.lottie'); // Example Add animation
    player.setAttribute('autoplay', '');
    player.setAttribute('loop', '');
    player.setAttribute('background', 'transparent');
    player.setAttribute('speed', '0.8');
    player.style.width = '100%';
    player.style.height = '100%';
    player.title = "Click 'New Stack' button below to add"; // Tooltip

    window.addStackLottieContainer.appendChild(player);
    console.log("[Tracker UI] Header Lottie animation created.");
}


// --- Drag and Drop Handlers ---

// Dragging a BOOK from the list OVER a category container/placeholder
function handleBookDragOverCategory(e) {
    if (draggedItemInfo?.type === 'book') {
        e.preventDefault(); // Allow drop
        e.dataTransfer.dropEffect = 'copy'; // Indicate copying
        // Add visual feedback to the target container
        e.currentTarget.classList.add('drag-over-books');
        currentDragOverElement = e.currentTarget;
    }
}

// Leaving a category container/placeholder while dragging a BOOK
function handleBookDragLeaveCategory(e) {
    // Check if leaving the element itself, not just moving over a child
    if (currentDragOverElement === e.currentTarget && !e.currentTarget.contains(e.relatedTarget)) {
        e.currentTarget.classList.remove('drag-over-books');
        currentDragOverElement = null;
    }
}

// Dropping a BOOK onto a category container/placeholder
async function handleBookDropInCategory(e) {
    if (draggedItemInfo?.type !== 'book') return; // Only handle book drops

    e.preventDefault();
    e.stopPropagation(); // Prevent drop event from bubbling further

    const target = e.currentTarget;
    target.classList.remove('drag-over-books'); // Remove visual feedback
    currentDragOverElement = null;

    // Find the target category ID
    const categoryElement = target.closest('.tracker-category'); // Might be container or placeholder inside
    const categoryId = categoryElement?.dataset.categoryId || target.dataset.categoryId; // Check container/placeholder dataset

    if (!categoryId) {
        console.warn("[Tracker UI] Book drop failed: Could not determine target category ID.");
        clearDraggedItemInfo();
        return;
    }

    // Find the category index in the data model
    const categoryIndex = trackerData.findIndex(c => c.id === categoryId);
    if (categoryIndex === -1) {
        console.error(`[Tracker UI] Book drop failed: Target category ${categoryId} not found.`);
        clearDraggedItemInfo();
        return;
    }

    // Get book data from dragged item info or dataTransfer
    let bookData;
    try {
        bookData = draggedItemInfo.data || JSON.parse(e.dataTransfer.getData('application/json'));
    } catch (err) {
        console.error("[Tracker UI] Book drop failed: Could not parse book data.", err);
        clearDraggedItemInfo();
        return;
    }

    // Validate essential book data (link)
    if (!bookData || !bookData.link) {
        console.warn("[Tracker UI] Book drop failed: Invalid or missing book link in data.");
        clearDraggedItemInfo();
        return;
    }

    // Prevent adding duplicates
    if (isDuplicateTrackedItem(bookData.link)) {
        alert(`"${bookData.title || 'This book'}" is already being tracked.`);
        clearDraggedItemInfo();
        return;
    }

    // Prepare book object to add (exclude unnecessary fields like full specs)
    const bookToAdd = {
        link: bookData.link,
        title: bookData.title,
        current_price: bookData.current_price,
        old_price: bookData.old_price,
        voucher_price: bookData.voucher_price,
        voucher_code: bookData.voucher_code,
        local_image_filename: bookData.local_image_filename,
        priceHistory: [] // Start with empty history for new tracked item
    };

    // Add book to the target category in the data model
    trackerData[categoryIndex].books.push(bookToAdd);

    // Re-render the books within the target category
    const booksContainer = categoryElement?.querySelector('.category-books-container');
    if (booksContainer) {
         renderCategoryBooks(booksContainer, trackerData[categoryIndex].books, categoryId, trackerData[categoryIndex].color);
    } else {
         renderCategoriesAndBooks(); // Fallback re-render all
    }

    // Save the updated tracker data
    await saveTrackerData('add book');
    applyTrackerColorsToBookList(); // Update main book list borders
    clearDraggedItemInfo(); // Clear drag state
}

// Dragging a tracked NODE (book inside tracker) START
function handleNodeDragStart(e) {
    const node = e.target.closest('.tracker-node');
    const sourceCategoryId = node?.dataset.categoryId;
    const sourceLink = node?.dataset.link;
    const sourceNodeIndex = parseInt(node?.dataset.nodeIndex, 10);

    if (!node || !sourceCategoryId || !sourceLink || isNaN(sourceNodeIndex)) {
        console.warn("[Tracker UI] Node drag start prevented: Missing data attributes.");
        e.preventDefault();
        return;
    }

    // Find the category and node data
    const sourceCategory = trackerData.find(c => c.id === sourceCategoryId);
    if (!sourceCategory || sourceNodeIndex < 0 || sourceNodeIndex >= sourceCategory.books.length) {
        console.warn("[Tracker UI] Node drag start prevented: Source category or node index invalid.");
        e.preventDefault();
        return;
    }

    // Set global drag info
    setDraggedItemInfo({
        type: 'node',
        link: sourceLink,
        sourceCategoryId: sourceCategoryId,
        sourceNodeIndex: sourceNodeIndex,
        data: { ...sourceCategory.books[sourceNodeIndex] } // Copy node data
    });

    e.dataTransfer.effectAllowed = 'move'; // Indicate moving is allowed
    try {
        // Set minimal data for external compatibility (optional)
        e.dataTransfer.setData('text/plain', sourceLink);
    } catch (err) {
         console.warn("[Tracker UI] Error setting text/plain dataTransfer for node drag:", err);
    }

    // Add dragging class after a short delay for visual feedback
    setTimeout(() => node.classList.add('dragging'), 0);
}

// Dragging a tracked NODE END
function handleNodeDragEnd(e) {
    clearNodeDropZoneStyles(); // Remove highlights from drop zones
    // Remove dragging class from the original node
    if (draggedItemInfo?.type === 'node' && draggedItemInfo.link) {
        // Need to query the DOM again as the element reference might be stale
        const node = window.trackerCategoriesContainer?.querySelector(`.tracker-node[data-link="${CSS.escape(draggedItemInfo.link)}"]`);
        node?.classList.remove('dragging');
    }
    clearDraggedItemInfo(); // Clear global drag state
}

// Clear highlighting from all node drop zones
function clearNodeDropZoneStyles() {
    if (!window.trackerCategoriesContainer) return;
    window.trackerCategoriesContainer.querySelectorAll('.drop-zone.node-drop-zone.drag-over').forEach(zone => {
        zone.classList.remove('drag-over');
    });
    currentDragOverElement = null;
}

// Dragging a NODE OVER a node drop zone or books container
function handleNodeDragOver(e) {
    if (draggedItemInfo?.type !== 'node') return; // Only handle node drags

    const dropZone = e.target.closest('.drop-zone.node-drop-zone');

    // If dragging over a valid drop zone *within the same category*
    if (dropZone && dropZone.dataset.categoryId === draggedItemInfo.sourceCategoryId) {
        e.preventDefault(); // Allow drop
        e.dataTransfer.dropEffect = 'move';

        // Highlight the target drop zone
        if (currentDragOverElement !== dropZone) {
            clearNodeDropZoneStyles(); // Clear previous highlight
            dropZone.classList.add('drag-over');
            currentDragOverElement = dropZone;
        }
    } else {
        // If dragging over the books container but not a specific zone, or wrong category
        clearNodeDropZoneStyles(); // Ensure no drop zone is highlighted
    }
}

// Leaving a NODE drop zone
function handleNodeDragLeave(e) {
    if (draggedItemInfo?.type !== 'node') return;
    const zone = e.target.closest('.drop-zone.node-drop-zone');
    // Check if leaving the highlighted zone itself
    if (zone && zone === currentDragOverElement && !zone.contains(e.relatedTarget)) {
        zone.classList.remove('drag-over');
        currentDragOverElement = null;
    }
}

// Dropping a NODE onto a node drop zone
async function handleNodeDrop(e) {
    if (draggedItemInfo?.type !== 'node') return; // Only handle node drops

    e.preventDefault();
    e.stopPropagation(); // Prevent bubbling

    const dropZone = e.target.closest('.drop-zone.node-drop-zone');
    clearNodeDropZoneStyles(); // Clear highlighting

    if (!dropZone) {
        console.warn("[Tracker UI] Node drop occurred outside a valid drop zone.");
        clearDraggedItemInfo();
        return;
    }

    // Get target info
    const targetCategoryId = dropZone.dataset.categoryId;
    const targetIndex = parseInt(dropZone.dataset.insertAtIndex, 10);

    // Get source info from stored drag data
    const sourceCategoryId = draggedItemInfo.sourceCategoryId;
    const sourceNodeIndex = draggedItemInfo.sourceNodeIndex;
    const sourceLink = draggedItemInfo.link; // For identifying the item

    // --- Validation ---
    if (!sourceLink || sourceCategoryId !== targetCategoryId || isNaN(targetIndex) || isNaN(sourceNodeIndex)) {
        console.error("[Tracker UI] Node drop failed: Invalid source/target data.", { sourceLink, sourceCategoryId, targetCategoryId, sourceNodeIndex, targetIndex });
        clearDraggedItemInfo();
        return;
    }

    // Find the category in the data model
    const categoryIndex = trackerData.findIndex(c => c.id === sourceCategoryId);
    if (categoryIndex === -1) {
        console.error(`[Tracker UI] Node drop failed: Category ${sourceCategoryId} not found.`);
        clearDraggedItemInfo();
        return;
    }
    const category = trackerData[categoryIndex];

    // Validate source index
    if (sourceNodeIndex < 0 || sourceNodeIndex >= category.books.length) {
        console.error(`[Tracker UI] Node drop failed: Invalid source index ${sourceNodeIndex}.`);
        clearDraggedItemInfo();
        return;
    }
    // Validate target index (can be equal to length for appending)
     if (targetIndex < 0 || targetIndex > category.books.length) {
          console.error(`[Tracker UI] Node drop failed: Invalid target index ${targetIndex}.`);
          clearDraggedItemInfo();
          return;
     }

    // --- Reorder Logic ---
    // Remove the item from its original position
    const [movedItem] = category.books.splice(sourceNodeIndex, 1);

    if (!movedItem || movedItem.link !== sourceLink) {
        console.error("[Tracker UI] Node drop failed: Item mismatch after splice.");
        // Attempt to restore original order? Difficult. Re-render might be safest.
        renderCategoriesAndBooks();
        clearDraggedItemInfo();
        return;
    }

    // Calculate the correct insertion index *after* removal
    const actualInsertIndex = (sourceNodeIndex < targetIndex) ? targetIndex - 1 : targetIndex;

    // Insert the item at the new position
    category.books.splice(actualInsertIndex, 0, movedItem);

    // --- Update UI and Save ---
    // Re-render the books within the affected category
    const booksContainer = window.trackerCategoriesContainer?.querySelector(`.tracker-category[data-category-id="${sourceCategoryId}"] .category-books-container`);
    if (booksContainer) {
        renderCategoryBooks(booksContainer, category.books, sourceCategoryId, category.color);
    } else {
        renderCategoriesAndBooks(); // Fallback re-render all
    }

    await saveTrackerData('reorder book'); // Save the new order
    clearDraggedItemInfo(); // Clear drag state
}


// --- Category Drag/Drop ---

// Dragging a CATEGORY START
function handleCategoryDragStart(e) {
    // Ensure drag doesn't start from interactive elements within the header
    if (e.target.closest('button, input')) {
        e.preventDefault();
        return;
    }

    const header = e.target.closest('.category-header');
    const categoryElement = header?.closest('.tracker-category');
    const sourceCategoryId = categoryElement?.dataset.categoryId;
    const sourceIndex = parseInt(categoryElement?.dataset.categoryIndex, 10);

    if (!header || !categoryElement || !sourceCategoryId || isNaN(sourceIndex)) {
        console.warn("[Tracker UI] Category drag start prevented: Missing data attributes.");
        e.preventDefault();
        return;
    }

    resetAllDeleteConfirmations(); // Clear confirms when starting drag

    // Set global drag info
    setDraggedItemInfo({
        type: 'category',
        sourceCategoryId: sourceCategoryId,
        sourceIndex: sourceIndex
    });

    e.dataTransfer.effectAllowed = 'move';
    try {
        // Set minimal data (optional)
        e.dataTransfer.setData('text/plain', `category-${sourceCategoryId}`);
    } catch (err) {
        console.warn("[Tracker UI] Error setting text/plain dataTransfer for category drag:", err);
    }

    // Make category drop zones visible
    if (window.trackerCategoriesContainer) {
        window.trackerCategoriesContainer.querySelectorAll('.drop-zone.category-drop-zone').forEach(zone => {
            zone.classList.add('visible');
        });
    }

    // Add dragging class for visual feedback (slight delay)
    setTimeout(() => {
        categoryElement.classList.add('dragging');
        header.classList.add('dragging'); // Style header too if needed
    }, 0);
}

// Dragging a CATEGORY END
function handleCategoryDragEnd(e) {
    // Remove dragging class from the source category
    if (draggedItemInfo?.type === 'category') {
        const sourceId = draggedItemInfo.sourceCategoryId;
        if (window.trackerCategoriesContainer) {
            const categoryElement = window.trackerCategoriesContainer.querySelector(`.tracker-category[data-category-id="${sourceId}"]`);
            categoryElement?.classList.remove('dragging');
            categoryElement?.querySelector('.category-header')?.classList.remove('dragging');
        }
    }
    clearCategoryDropZoneStyles(); // Hide and unhighlight all category drop zones
    clearDraggedItemInfo(); // Clear global drag state
}

// Clear styling from all category drop zones
function clearCategoryDropZoneStyles() {
    if (!window.trackerCategoriesContainer) return;
    window.trackerCategoriesContainer.querySelectorAll('.drop-zone.category-drop-zone').forEach(zone => {
        zone.classList.remove('visible', 'drop-target-highlight'); // Remove visibility and highlight
    });
    currentDragOverElement = null;
}

// Dragging a CATEGORY OVER a category drop zone
function handleCategoryDragOverContainer(e) {
    if (draggedItemInfo?.type !== 'category') return;

    // Find the nearest visible category drop zone
    const zone = e.target.closest('.drop-zone.category-drop-zone.visible');

    if (zone) {
        e.preventDefault(); // Allow drop
        e.dataTransfer.dropEffect = 'move';

        // Highlight the target drop zone
        if (currentDragOverElement !== zone) {
            // Remove highlight from previous zone if any
            if (currentDragOverElement) currentDragOverElement.classList.remove('drop-target-highlight');
            // Add highlight to current zone
            zone.classList.add('drop-target-highlight');
            currentDragOverElement = zone;
        }
    } else {
        // If not over a valid zone, remove any existing highlight
        if (currentDragOverElement) {
            currentDragOverElement.classList.remove('drop-target-highlight');
            currentDragOverElement = null;
        }
    }
}

// Leaving a CATEGORY drop zone
function handleCategoryDragLeaveContainer(e) {
    if (draggedItemInfo?.type !== 'category') return;

    const zone = e.target.closest('.drop-zone.category-drop-zone.visible');
    // Find related target (where the mouse moved to)
    const relatedTargetZone = e.relatedTarget ? e.relatedTarget.closest('.drop-zone.category-drop-zone.visible') : null;

    // If leaving the currently highlighted zone, and not entering another zone immediately
    if (currentDragOverElement && currentDragOverElement === zone && currentDragOverElement !== relatedTargetZone) {
        currentDragOverElement.classList.remove('drop-target-highlight');
        currentDragOverElement = null;
    }
}

// Dropping a CATEGORY onto a category drop zone
async function handleCategoryDrop(e) {
    if (draggedItemInfo?.type !== 'category') return;

    e.preventDefault();
    e.stopPropagation();

    const dropZone = e.target.closest('.drop-zone.category-drop-zone.visible');
    clearCategoryDropZoneStyles(); // Hide zones and remove highlights

    if (!dropZone) {
        console.warn("[Tracker UI] Category drop occurred outside a valid drop zone.");
        clearDraggedItemInfo();
        return;
    }

    // Get target index from drop zone
    const targetIndex = parseInt(dropZone.dataset.insertAtIndex, 10);
    // Get source info from stored drag data
    const sourceIndex = draggedItemInfo.sourceIndex;
    const sourceId = draggedItemInfo.sourceCategoryId; // For validation/logging

    // --- Validation ---
    if (isNaN(targetIndex) || sourceIndex == null || isNaN(sourceIndex) || !sourceId) {
        console.error("[Tracker UI] Category drop failed: Invalid source/target index.", { sourceId, sourceIndex, targetIndex });
        clearDraggedItemInfo();
        return;
    }
    // If dropping in the same place or the position immediately following itself, no change needed
    if (targetIndex === sourceIndex || targetIndex === sourceIndex + 1) {
         console.debug("[Tracker UI] Category drop resulted in no change of order.");
         renderCategoriesAndBooks(); // Re-render to ensure visual consistency if needed
         clearDraggedItemInfo();
         return;
    }

    // --- Reorder Logic ---
    // Remove the category from its original position in the data model
    const [movedCategory] = trackerData.splice(sourceIndex, 1);

    if (!movedCategory || movedCategory.id !== sourceId) {
        console.error("[Tracker UI] Category drop failed: Category mismatch after splice.");
        // Attempt to restore? Difficult. Re-render might be safest.
        renderCategoriesAndBooks();
        clearDraggedItemInfo();
        return;
    }

    // Calculate the correct insertion index *after* removal
    const actualInsertIndex = (sourceIndex < targetIndex) ? targetIndex - 1 : targetIndex;

    // Insert the category at the new position
    trackerData.splice(actualInsertIndex, 0, movedCategory);

    // --- Update UI and Save ---
    renderCategoriesAndBooks(); // Re-render the entire category list with the new order
    await saveTrackerData('reorder category'); // Save the new order
    clearDraggedItemInfo(); // Clear drag state
}

// Helper to set the global dragged item info
function setDraggedItemInfo(info) {
    // console.debug("[Drag State] Setting dragged item:", info);
    draggedItemInfo = info;
}
// Helper to clear the global dragged item info
function clearDraggedItemInfo() {
     // console.debug("[Drag State] Clearing dragged item.");
    draggedItemInfo = null;
}


// --- Price Checking Logic ---

/** Fetches prices and specs for a single book using IPC */
async function fetchBookPricesAndSpecs(bookLink, bookTitle = 'book') {
    if (!bookLink || typeof bookLink !== 'string' || !bookLink.startsWith('http')) {
        console.warn(`[Tracker Price Check] Invalid link for price check: ${bookLink}`);
        return null; // Cannot fetch without a valid link
    }
    if (!window.electronAPI?.fetchDetailData) {
         console.error("[Tracker Price Check] Cannot fetch: electronAPI.fetchDetailData unavailable.");
         return { fetchError: "IPC API unavailable" };
    }

    console.info(`[Tracker Price Check] Fetching prices/specs for: "${bookTitle}" (${bookLink})`);
    try {
        const webviewId = window.AppRuntime?.primaryWebviewId;
        if (!webviewId) {
            throw new Error("Primary webview ID not set for price check.");
        }

        // Call IPC to get details (which includes prices)
        // Use bookLink which is the parameter passed to this function
        const result = await window.electronAPI.fetchDetailData(webviewId, bookLink);

        if (!result.success) {
            throw new Error(result.error || 'IPC fetchDetailData failed for price/spec check');
        }

        // Ensure prices and details are objects, even if empty
        const prices = (typeof result.prices === 'object' && result.prices !== null) ? result.prices : {};
        const specs = (typeof result.details === 'object' && result.details !== null) ? result.details : {};

        // console.info(`[Tracker Price Check] Data received via IPC for "${bookTitle}":`, { prices, specs });

        // Update specs cache immediately
        bookSpecsCache.set(bookLink, specs);

        // Return prices for the update cycle
        return prices;

    } catch (error) {
        console.error(`[Tracker Price Check] Error fetching price/spec data for ${bookLink}:`, error);
        // Return error object so the caller knows it failed
        return { fetchError: error.message || 'Unknown fetch error' };
    }
}

/** Main price check cycle function */
async function performPriceCheckCycle() {
    if (isCurrentlyCheckingPrices) {
        console.warn("[Tracker] Price check cycle skipped, previous cycle still running.");
        return;
    }
    if (!trackerData || trackerData.length === 0) {
        console.log("[Tracker] No tracked items to check prices for.");
        scheduleNextPriceCheck(); // Schedule next check even if nothing to do now
        return;
    }

    isCurrentlyCheckingPrices = true;
    const startTime = Date.now();
    let itemsChecked = 0;
    let updatesFound = false;
    let errorsEncountered = 0;

    console.log("[Tracker] Starting price check cycle...");
    if (window.statusBar) window.statusBar.textContent = 'Checking tracked item prices...';

    // Use a simple loop for sequential checking (easier to manage logs/rate limiting)
    // Consider parallel with concurrency limit for performance later if needed.
    for (const category of trackerData) {
        if (category.books && category.books.length > 0) {
            for (const book of category.books) {
                if (book && book.link) {
                    itemsChecked++;
                    const fetchedPrices = await fetchBookPricesAndSpecs(book.link, book.title);
                    await new Promise(r => setTimeout(r, 300)); // Small delay between requests

                    if (fetchedPrices && !fetchedPrices.fetchError) {
                        // Check if prices actually changed
                        // Note: The fetched price keys might be different (e.g., currentPrice vs current_price)
                        // Adjust the comparison based on the keys returned by fetchDetailData
                        const priceChanged = book.current_price !== fetchedPrices.currentPrice || // Check against returned keys
                                             book.old_price !== fetchedPrices.oldPrice ||         // Check against returned keys
                                             book.voucher_price !== fetchedPrices.voucherPrice || // Check against returned keys
                                             book.voucher_code !== fetchedPrices.voucherCode;     // Check against returned keys

                        if (priceChanged) {
                            console.log(`[Tracker] Price change detected for "${book.title || book.link}"`);
                            updatesFound = true;
                            // Update book object using the correct keys from fetchedPrices
                            book.current_price = fetchedPrices.currentPrice;
                            book.old_price = fetchedPrices.oldPrice;
                            book.voucher_price = fetchedPrices.voucherPrice;
                            book.voucher_code = fetchedPrices.voucherCode;
                        }

                        // Always add to price history (even if no change detected by simple check)
                         if (!Array.isArray(book.priceHistory)) book.priceHistory = [];
                         book.priceHistory.push({
                             timestamp: Date.now(),
                             // Use the keys from the fetchedPrices object
                             currentPrice: fetchedPrices.currentPrice,
                             oldPrice: fetchedPrices.oldPrice,
                             voucherPrice: fetchedPrices.voucherPrice,
                             voucherCode: fetchedPrices.voucherCode
                         });
                         // Optional: Limit history length per book
                         // if (book.priceHistory.length > 100) book.priceHistory.shift();

                    } else {
                        errorsEncountered++;
                        console.warn(`[Tracker] Failed to fetch prices for "${book.title || book.link}". Error: ${fetchedPrices?.fetchError || 'Unknown error'}`);
                        // Optionally add an error entry to price history?
                        // book.priceHistory.push({ timestamp: Date.now(), error: fetchedPrices?.fetchError || 'Fetch failed' });
                    }
                }
            } // End loop through books
        }
    } // End loop through categories

    const duration = Date.now() - startTime;
    console.log(`[Tracker] Price check cycle finished in ${duration / 1000}s. Checked: ${itemsChecked}. Updates: ${updatesFound}. Errors: ${errorsEncountered}.`);

    // Save data only if updates were found
    if (updatesFound) {
        console.log("[Tracker] Price updates found, saving data...");
        await saveTrackerData('update prices');
        // Re-render tracker UI to show new prices (optional, might be too frequent)
        // renderCategoriesAndBooks();
    } else {
        if (window.statusBar) window.statusBar.textContent = `Price check complete (${itemsChecked} items, no changes).`;
    }

    isCurrentlyCheckingPrices = false;
    scheduleNextPriceCheck(); // Schedule the next run
}


/** Schedules the next price check based on time since app start */
function scheduleNextPriceCheck() {
    // Clear existing timer if any
    if (priceCheckIntervalId) {
        clearTimeout(priceCheckIntervalId);
        priceCheckIntervalId = null;
    }

    const timeSinceStart = Date.now() - appStartTime;
    let intervalMs;
    let intervalType;

    // Use boost interval for the first BOOST_DURATION_MS
    if (timeSinceStart < BOOST_DURATION_MS) {
        intervalMs = BOOST_INTERVAL_MS;
        intervalType = 'Boost';
    } else {
        intervalMs = NORMAL_INTERVAL_MS;
        intervalType = 'Normal';
    }

    console.log(`[Tracker] Scheduling next price check in ${intervalMs / 1000 / 60} minutes (${intervalType} interval).`);

    // Set the timeout for the next cycle
    priceCheckIntervalId = setTimeout(() => {
        performPriceCheckCycle();
    }, intervalMs);
}

/** Starts the price checking interval (called once on init) */
function startPriceCheckingInterval() {
    console.log("[Tracker] Initializing price check schedule...");
    stopPriceCheckingInterval(); // Ensure no duplicate intervals
    appStartTime = Date.now(); // Reset start time reference
    isCurrentlyCheckingPrices = false; // Reset flag

    // Perform the first check shortly after initialization
    // Use a slightly longer initial delay to allow UI to settle
    const initialDelay = 10 * 1000; // 10 seconds
    console.log(`[Tracker] Performing initial price check in ${initialDelay / 1000} seconds...`);
    priceCheckIntervalId = setTimeout(() => {
         performPriceCheckCycle(); // Start the first cycle
    }, initialDelay);
}

/** Stops the currently scheduled price check interval */
function stopPriceCheckingInterval() {
    if (priceCheckIntervalId) {
        clearTimeout(priceCheckIntervalId);
        priceCheckIntervalId = null;
        console.log("[Tracker] Price checking interval stopped.");
    }
    isCurrentlyCheckingPrices = false; // Reset flag when stopping
}

/** Sets up initial event listeners for the tracker UI */
function setupTrackerEventListeners() {
    if (!window.addCategoryBtn) {
        console.error("[Tracker UI] Cannot setup listeners - Add Category Button missing.");
        return;
    }
    // Add new category button
    window.addCategoryBtn.addEventListener('click', handleAddCategory);

    // Add global listener to reset delete confirmations when clicking outside delete buttons
    // Use capture phase to catch clicks early
    document.body.addEventListener('click', (e) => {
        // If the click was not on a delete button itself
        if (!e.target.closest('.delete-category-btn')) {
            resetAllDeleteConfirmations();
        }
    }, true);

    console.log("[Tracker UI] Tracker event listeners setup.");
}

// --- Initialization and Export ---
window.AppTrackerUI = {
    // Initialization function called by renderer.js
    initialize: async () => {
        console.log("[Tracker UI] Initializing...");
        createPersistentLottie();
        setupTrackerEventListeners();
        // Load data, render UI, and start price checks
        await loadAndDisplayTrackedItems(); // This now starts price checks on success
        console.log("[Tracker UI] Initialization complete.");
    },

    // Expose data and functions needed by other modules
    trackerData, // Direct access (use with caution)
    bookSpecsCache, // Access to the specs cache
    saveTrackerData, // Allow manual save trigger if needed
    loadAndDisplayTrackedItems, // Allow manual reload if needed
    applyTrackerColorsToBookList, // Needed by book list manager
    setDraggedItemInfo, // Needed for drag/drop coordination
    clearDraggedItemInfo, // Needed for drag/drop coordination
    stopPriceChecking: stopPriceCheckingInterval // Allow stopping checks (e.g., on error)
};

console.log("[Tracker UI] Module loaded.");
