// electron_app/renderer_process/book-list-manager.js

// Assumes necessary DOM elements are globally available or passed in
// Requires: tabContentContainer, contentScrollContainer, initialLoader, infiniteScrollStatus, scrollLoader, endOfContentMessage, bookSearchInput, statusBar
// Requires access to: AppUI.utils, AppUI.trackerUI (for coloring, state), AppUI.detailsOverlay.showDetailsOverlay, PYTHON_BACKEND_URL

let lastLoadedPage = 0;
let isFetching = false;
let reachedEndOfPages = false;
let firstPageDataString = null; // To detect repeating content
let currentSearchTerm = '';

// Debounce timer ID for scroll handling
let scrollDebounceTimer = null;
const SCROLL_DEBOUNCE_MS = 100;

// Debounce timer ID for search input
let searchDebounceTimer = null;
const SEARCH_DEBOUNCE_MS = 250;

/** Renders book data into a new page container element */
function createBookListElement(books, pageNumber) {
    const pageContainer = document.createElement('div');
    pageContainer.className = 'page-content-block';
    pageContainer.dataset.page = pageNumber;

    // Add separator for pages > 1
    if (pageNumber > 1) {
        const separator = document.createElement('hr');
        separator.className = 'page-separator';
        separator.dataset.pageNumber = `Page ${pageNumber}`;
        pageContainer.appendChild(separator);
    }

    if (!books || books.length === 0) {
        const message = document.createElement('p');
        message.className = 'info-message'; // Use a generic info class
        message.style.textAlign = 'center';
        message.textContent = pageNumber === 1 ? 'No books found matching criteria.' : `No more books found (Page ${pageNumber}).`;
        pageContainer.appendChild(message);
        return pageContainer;
    }

    const list = document.createElement('ul');
    list.className = 'book-list';

    const externalLinkSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" fill="none" stroke-linecap="round" stroke-linejoin="round"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M11 4h8v8" /><path d="M19 4l-15 15" /></svg>`;

    books.forEach((book, index) => {
        if (!book || typeof book !== 'object') {
            console.warn(`[Book List] Skipping invalid book data at index ${index}, page ${pageNumber}`);
            return;
        }

        const item = document.createElement('li');
        item.className = 'book-item';
        item.draggable = true; // For dragging to tracker

        // Store essential data directly for easy access
        item.dataset.bookLink = book.link || `no-link-${Date.now()}-${index}`; // Use link as primary identifier
        item.dataset.bookTitle = book.title || 'Unknown Title';
        // Store all data as JSON for drag/details overlay
        try { item.dataset.bookData = JSON.stringify(book); } catch (e) { console.error("Failed stringify book data:", book, e); item.dataset.bookData = '{}'; }


        // --- Event Listeners for Book Item ---
        item.addEventListener('dragstart', handleBookDragStart);
        item.addEventListener('dragend', handleBookDragEnd);
        item.addEventListener('mouseenter', handleBookMouseEnter);
        item.addEventListener('mouseleave', handleBookMouseLeave);
        // Click to open details (ignore clicks on the explicit external link icon)
        item.addEventListener('click', (e) => {
            if (!e.target.closest('a.book-view-icon')) { // Check if the click was on the link icon
                 handleBookClick(e);
            }
         });

        // --- Book Image ---
        const imageContainer = document.createElement('div');
        imageContainer.className = 'book-image';
        const placeholderText = document.createElement('span');
        placeholderText.className = 'placeholder-text';
        placeholderText.style.display = 'none'; // Hide initially

        if (book.local_image_filename) {
            // Construct URL using PYTHON_BACKEND_URL
             const imageUrl = `${window.PYTHON_BACKEND_URL}/local-image?filename=${encodeURIComponent(book.local_image_filename)}`;
             const img = document.createElement('img');
             img.src = imageUrl;
             img.alt = book.title ? `${book.title} cover` : 'Book cover';
             img.loading = 'lazy'; // Lazy load images
             img.onerror = function() {
                 console.error(`[Book List] Failed to load image: "${book.title || '?'}", Filename: ${book.local_image_filename}`);
                 this.style.display = 'none'; // Hide broken image
                 placeholderText.textContent = 'Load Error';
                 placeholderText.style.display = 'flex'; // Show placeholder
             };
             imageContainer.appendChild(img);
        } else {
             placeholderText.textContent = 'No Image';
             placeholderText.style.display = 'flex';
        }
        imageContainer.appendChild(placeholderText);

        // --- Book Details (Title, Meta) ---
        const detailsDiv = document.createElement('div');
        detailsDiv.className = 'book-details';
        detailsDiv.innerHTML = `<div class="book-title" title="${book.title || ''}">${book.title || 'N/A'}</div>`; // Add title attribute for overflow

        const metaDiv = document.createElement('div');
        metaDiv.className = 'book-meta';

        // External Link Icon (if link exists)
        if (book.link) {
            const linkIcon = document.createElement('a');
            linkIcon.href = book.link;
            linkIcon.target = '_blank'; // Open in default browser
            linkIcon.rel = 'noopener noreferrer'; // Security best practice
            linkIcon.className = 'book-view-icon';
            linkIcon.title = 'View Product Page (opens browser)';
            linkIcon.innerHTML = externalLinkSvg;
            metaDiv.appendChild(linkIcon);
        }

        // Prices and Voucher Info
        const pricesVoucherDiv = document.createElement('div');
        pricesVoucherDiv.className = 'book-meta-prices';
        const priceHtml = book.current_price ? `<span class="book-price">${book.current_price}</span>` : '';
        const oldPriceHtml = book.old_price ? `<span class="book-old-price">${book.old_price}</span>` : '';
        let voucherHtml = '';
        if (book.voucher_price) {
            const priceBox = `<div class="voucher-price-box"><span class="book-voucher-price">${book.voucher_price}</span></div>`;
            const codeText = book.voucher_code ? `<span class="voucher-code-text">${book.voucher_code}</span>` : '';
            voucherHtml = `<div>${priceBox}${codeText}</div>`; // Wrap voucher in its own div for layout
        }
        pricesVoucherDiv.innerHTML = `${priceHtml}${oldPriceHtml}${voucherHtml}`;
        metaDiv.appendChild(pricesVoucherDiv);

        detailsDiv.appendChild(metaDiv);

        // --- Assemble Book Item ---
        item.appendChild(imageContainer);
        item.appendChild(detailsDiv);
        list.appendChild(item);
    });

    pageContainer.appendChild(list);
    return pageContainer;
}

// --- Book Item Event Handlers ---
function handleBookDragStart(event) {
    try {
        const bookDataJson = event.currentTarget.dataset.bookData;
        if (!bookDataJson) throw new Error("Missing book data for drag");
        const dragData = JSON.parse(bookDataJson);

        // Set data for tracker drop handler
        event.dataTransfer.setData('application/json', bookDataJson);
        event.dataTransfer.setData('text/plain', dragData.link || dragData.title || 'book-item'); // Fallback text
        event.dataTransfer.effectAllowed = 'copy'; // Indicate copying to tracker

        event.currentTarget.classList.add('dragging');

        // Set global drag info (handled by tracker-ui.js)
        if (window.AppTrackerUI && typeof window.AppTrackerUI.setDraggedItemInfo === 'function') {
             window.AppTrackerUI.setDraggedItemInfo({ type: 'book', data: dragData, link: dragData.link, sourceCategoryIndex: null });
        } else {
             console.warn("Cannot set global drag info - AppTrackerUI missing?");
        }

    } catch (err) {
        console.error("[Book List] Error starting book drag:", err);
        event.preventDefault(); // Prevent drag if data is bad
    }
}

function handleBookDragEnd(event) {
    event.currentTarget.classList.remove('dragging');
    // Clear global drag info (handled by tracker-ui.js)
     if (window.AppTrackerUI && typeof window.AppTrackerUI.clearDraggedItemInfo === 'function') {
         window.AppTrackerUI.clearDraggedItemInfo();
     }
}

function handleBookMouseEnter(event) {
    event.currentTarget.classList.add('is-hovered');
    // Add shrink effect to neighbors for visual focus
    const prev = event.currentTarget.previousElementSibling;
    const next = event.currentTarget.nextElementSibling;
    if (prev?.classList.contains('book-item')) prev.classList.add('shrink-neighbor');
    if (next?.classList.contains('book-item')) next.classList.add('shrink-neighbor');
}

function handleBookMouseLeave(event) {
    event.currentTarget.classList.remove('is-hovered');
    // Remove shrink effect from neighbors
    const prev = event.currentTarget.previousElementSibling;
    const next = event.currentTarget.nextElementSibling;
    if (prev) prev.classList.remove('shrink-neighbor');
    if (next) next.classList.remove('shrink-neighbor');
}

function handleBookClick(event) {
     try {
         const bookData = JSON.parse(event.currentTarget.dataset.bookData || '{}');
         // Call the centralized show details function
         if (window.AppDetailsOverlay && typeof window.AppDetailsOverlay.showDetailsOverlay === 'function') {
             window.AppDetailsOverlay.showDetailsOverlay(bookData);
         } else {
              console.error("Cannot show details - AppDetailsOverlay missing?");
              alert("Cannot show details at the moment.");
         }
     } catch(err) {
         console.error("[Book List] Error parsing book data for details click:", err);
         alert("Error loading book details.");
     }
}

// --- Page Fetching Logic ---
async function fetchAndAppendPageData(pageNumber) {
    if (isFetching || reachedEndOfPages) return;

    isFetching = true;
    // Show loading indicator in a fixed position at the bottom of the screen
    if(window.scrollLoader) {
        window.scrollLoader.style.display = 'flex';
        
        // Make sure the loader is visible in the viewport
        if (window.contentScrollContainer) {
            // Ensure it's visible within the scroll container viewport
            const scrollRect = window.contentScrollContainer.getBoundingClientRect();
            const loaderBottom = scrollRect.bottom - 100; // Position loader near the bottom
            
            // Adjust loader position to always be visible
            window.scrollLoader.style.bottom = '10px';
        }
    }
    
    if(window.endOfContentMessage) window.endOfContentMessage.style.display = 'none';
    if(window.statusBar) window.statusBar.textContent = `Fetching page ${pageNumber}...`;
    if (pageNumber === 1 && window.initialLoader) window.initialLoader.style.display = 'none'; // Hide initial loader only on first fetch

    try {
        // Construct URL using PYTHON_BACKEND_URL
        if (!window.PYTHON_BACKEND_URL) throw new Error("Backend URL not configured.");
        const fetchUrl = `${window.PYTHON_BACKEND_URL}/fetch-page-data?page=${pageNumber}`; // Assuming default base URL is handled by backend
        console.log(`[Book List] Fetching: ${fetchUrl}`);

        const response = await fetch(fetchUrl);
        if (!response.ok) {
            let errorMsg = `HTTP error ${response.status}`;
            try { const errData = await response.json(); errorMsg += `: ${errData.error || 'Unknown backend error'}`; } catch { /* ignore */ }
            throw new Error(errorMsg);
        }

        const result = await response.json();
        if (!result.success) {
            throw new Error(result.error || 'Backend reported failure');
        }

        const fetchedBooks = result.data;
        const fetchedCount = fetchedBooks?.length || 0;
        console.log(`[Book List] Page ${pageNumber} fetched with ${fetchedCount} items.`);

        // --- End of Content Detection ---
        // 1. If backend explicitly signals end (future enhancement?)
        // 2. If fewer books than expected are returned (less reliable)
        // 3. If the content hash matches the first page (for sites that loop)
        if (fetchedCount === 0 && pageNumber > 1) {
             console.log(`[Book List] End detected: 0 items on page ${pageNumber}.`);
             reachedEndOfPages = true;
        } else {
             const fetchedDataString = JSON.stringify(fetchedBooks);
             if (pageNumber === 1) {
                 firstPageDataString = fetchedDataString;
             } else if (firstPageDataString !== null && fetchedDataString === firstPageDataString) {
                 console.log(`[Book List] End detected: Page ${pageNumber} content matches page 1.`);
                 reachedEndOfPages = true;
             }
        }
        // --- End Detection ---


        if (!reachedEndOfPages && fetchedCount > 0) {
            const pageElement = createBookListElement(fetchedBooks, pageNumber);
            if (window.tabContentContainer) window.tabContentContainer.appendChild(pageElement);
            lastLoadedPage = pageNumber;
             // Apply search filter and tracker colors to the newly added items
             filterBooks();
             if (window.AppTrackerUI && typeof window.AppTrackerUI.applyTrackerColorsToBookList === 'function') {
                 window.AppTrackerUI.applyTrackerColorsToBookList();
             }
        }

        if (reachedEndOfPages) {
             if(window.endOfContentMessage) window.endOfContentMessage.style.display = 'block';
             if(window.statusBar) window.statusBar.textContent = `All pages loaded.`;
        } else {
             if(window.statusBar) window.statusBar.textContent = `Page ${pageNumber} loaded (${fetchedCount} items).`;
        }

    } catch (error) {
        console.error(`[Book List] Error fetching page ${pageNumber}:`, error);
        if(window.statusBar) window.statusBar.textContent = `Error loading page ${pageNumber}!`;
        if(window.endOfContentMessage) {
            window.endOfContentMessage.textContent = `Error loading page ${pageNumber}. Scroll to retry?`; // Give user hint
            window.endOfContentMessage.style.display = 'block';
            window.endOfContentMessage.classList.add('error-message'); // Style as error
        }
        // Don't set reachedEndOfPages=true on error, allow retry on scroll
        // reachedEndOfPages = true;
    } finally {
        isFetching = false;
        if(window.scrollLoader) window.scrollLoader.style.display = 'none';
    }
}

// --- Scroll Handling ---
function handleScroll() {
    if (!window.contentScrollContainer) return;
    // Debounce scroll handler
    clearTimeout(scrollDebounceTimer);
    scrollDebounceTimer = setTimeout(() => {
        if (isFetching || reachedEndOfPages) return;

        const { scrollTop, scrollHeight, clientHeight } = window.contentScrollContainer;
        // Load next page when reaching near the bottom (adjust threshold as needed)
        const scrollThreshold = 350; // Pixels from bottom
        if (scrollHeight - scrollTop <= clientHeight + scrollThreshold) {
            console.log("[Book List] Scroll threshold reached, fetching next page...");
            // Clear potential error message before fetching next page
            if(window.endOfContentMessage) {
                 window.endOfContentMessage.style.display = 'none';
                 window.endOfContentMessage.classList.remove('error-message');
                 window.endOfContentMessage.textContent = 'no more books here'; // Reset text
            }
            fetchAndAppendPageData(lastLoadedPage + 1);
        }
    }, SCROLL_DEBOUNCE_MS);
}

// --- Search Functionality ---
function filterBooks() {
    const term = currentSearchTerm.toLowerCase().trim();
     if (!window.tabContentContainer) return;
    const items = window.tabContentContainer.querySelectorAll('.book-item');
    let visibleCount = 0;

    items.forEach(item => {
        // Match against title (add more fields if needed, e.g., author, ISBN from specs if loaded)
        const title = (item.dataset.bookTitle || '').toLowerCase();
        // Basic search: check if title includes the term
        const isMatch = term === '' || title.includes(term);

        if (isMatch) {
            item.classList.remove('hidden-by-search');
            visibleCount++;
        } else {
            item.classList.add('hidden-by-search');
        }
    });

    // console.log(`[Book List] Filtered by "${term}". Visible: ${visibleCount}/${items.length}`);
    // Update status bar or provide feedback if no results found?
     if (term !== '' && visibleCount === 0 && items.length > 0) {
        // Maybe show a "No results found" message within the container?
         // console.log("[Book List] Search returned no results.");
     }
}

function handleSearchInput(event) {
    currentSearchTerm = event.target.value;
    // Debounce the filtering function
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(filterBooks, SEARCH_DEBOUNCE_MS);
}

/** Setup event listeners related to book list, scrolling, and search */
function setupBookListEventListeners() {
     if (!window.contentScrollContainer || !window.bookSearchInput) {
         console.error("[Book List] Cannot setup listeners - essential elements missing.");
         return;
     }
    window.contentScrollContainer.addEventListener('scroll', handleScroll);
    // Use 'input' for real-time filtering, 'search' for clearing via 'x' button
    window.bookSearchInput.addEventListener('input', handleSearchInput);
    window.bookSearchInput.addEventListener('search', handleSearchInput); // Handles clearing
    console.log("[Book List] Event listeners setup.");
}

// Export functions/state if needed
window.AppBookListManager = {
    initialize: async () => {
        setupBookListEventListeners();
        console.log("[Book List] Initializing - loading page 1...");
        // Reset state for potential re-initialization
        lastLoadedPage = 0;
        isFetching = false;
        reachedEndOfPages = false;
        firstPageDataString = null;
        currentSearchTerm = '';
        if(window.bookSearchInput) window.bookSearchInput.value = '';
         if(window.tabContentContainer) window.tabContentContainer.innerHTML = ''; // Clear previous content
         if(window.initialLoader) window.initialLoader.style.display = 'flex'; // Show initial loader
         if(window.endOfContentMessage) window.endOfContentMessage.style.display = 'none';

        await fetchAndAppendPageData(1); // Load the first page

        // Final checks after initial load
         if (window.initialLoader) window.initialLoader.style.display = 'none';
         if (reachedEndOfPages && window.endOfContentMessage) {
             console.log("[Book List] End reached immediately on page 1.");
             window.endOfContentMessage.style.display = 'block';
         }
         filterBooks(); // Apply initial (empty) filter
         if (window.AppTrackerUI?.applyTrackerColorsToBookList) {
             window.AppTrackerUI.applyTrackerColorsToBookList(); // Apply colors
         }
    },
    filterBooks, // Expose if needed externally
    fetchAndAppendPageData // Expose for manual refresh?
};
console.log("[Book List Manager] Module loaded.");