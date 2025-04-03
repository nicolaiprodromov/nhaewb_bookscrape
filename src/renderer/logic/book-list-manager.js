// src/renderer/logic/book-list-manager.js

// Assumes necessary DOM elements (window.*) and electronAPI are globally available via renderer.js
// Assumes AppRuntime, AppUIUtils, AppTrackerUI, AppDetailsOverlay are globally available

let lastLoadedPage = 0;
let isFetching = false;
let reachedEndOfPages = false;
let firstPageDataString = null; // Used to detect repeating page 1 content at the end
let currentSearchTerm = '';
let scrollDebounceTimer = null;
const SCROLL_DEBOUNCE_MS = 150; // Slightly increased debounce
let searchDebounceTimer = null;
const SEARCH_DEBOUNCE_MS = 300; // Slightly increased debounce

/** Renders book data into a new page container element */
function createBookListElement(books, pageNumber) {
    const pageContainer = document.createElement('div');
    pageContainer.className = 'page-content-block';
    pageContainer.dataset.page = pageNumber;

    // Add separator for pages > 1
    if (pageNumber > 1) {
        const sep = document.createElement('hr');
        sep.className = 'page-separator';
        sep.dataset.pageNumber = `Page ${pageNumber}`;
        pageContainer.appendChild(sep);
    }

    if (!books || books.length === 0) {
        const msg = document.createElement('p');
        msg.className = 'info-message';
        msg.style.textAlign = 'center';
        msg.textContent = pageNumber === 1 ? 'No books found for this view.' : 'No more books found.';
        pageContainer.appendChild(msg);
        return pageContainer;
    }

    const list = document.createElement('ul');
    list.className = 'book-list';

    // Pre-compile SVG icon string
    const svgIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" fill="none" stroke-linecap="round" stroke-linejoin="round"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M11 4h8v8" /><path d="M19 4l-15 15" /></svg>`;

    books.forEach((book, index) => {
        if (!book || typeof book !== 'object') {
            console.warn(`[Book List] Skipping invalid book data at index ${index}, page ${pageNumber}:`, book);
            return; // Skip this invalid book entry
        }

        const item = document.createElement('li');
        item.className = 'book-item';
        item.draggable = true;

        // Use meaningful defaults if data is missing
        const bookLink = book.link || `no-link-${Date.now()}-${index}`;
        const bookTitle = book.title || 'Unknown Title';
        item.dataset.bookLink = bookLink;
        item.dataset.bookTitle = bookTitle;

        try {
            // Include only essential data needed for drag/drop or click details initially
            const essentialData = {
                link: book.link,
                title: book.title,
                current_price: book.current_price,
                old_price: book.old_price,
                voucher_price: book.voucher_price,
                voucher_code: book.voucher_code,
                local_image_filename: book.local_image_filename
                // Avoid embedding full specs/history in dataset initially for performance
            };
            item.dataset.bookData = JSON.stringify(essentialData);
        } catch (e) {
            console.error(`[Book List] Failed to stringify book data for ${bookTitle}:`, e);
            item.dataset.bookData = '{}'; // Set empty object on failure
        }

        // Event Listeners
        item.addEventListener('dragstart', handleBookDragStart);
        item.addEventListener('dragend', handleBookDragEnd);
        item.addEventListener('mouseenter', handleBookMouseEnter);
        item.addEventListener('mouseleave', handleBookMouseLeave);
        // Ensure click doesn't fire if the external link icon is clicked
        item.addEventListener('click', (e) => {
            if (!e.target.closest('a.book-view-icon')) {
                handleBookClick(e);
            }
        });

        // Image Container
        const imgCont = document.createElement('div');
        imgCont.className = 'book-image';
        const phText = document.createElement('span'); // Placeholder text span
        phText.className = 'placeholder-text';
        phText.style.display = 'none'; // Hide initially

        if (book.local_image_filename) {
            // Use the custom protocol for local images
            const imageUrl = `localimg://${encodeURIComponent(book.local_image_filename)}`;
            const img = document.createElement('img');
            img.src = imageUrl;
            img.alt = bookTitle ? `Cover for ${bookTitle}` : 'Book Cover';
            img.loading = 'lazy'; // Enable lazy loading
            img.onerror = function() {
                console.error(`[Book List] Failed to load image: "${bookTitle}". File: ${book.local_image_filename}`);
                this.style.display = 'none'; // Hide broken image
                phText.textContent = 'Load Error';
                phText.style.display = 'flex'; // Show placeholder text
            };
            imgCont.appendChild(img);
        } else {
            phText.textContent = 'No Image';
            phText.style.display = 'flex'; // Show placeholder if no image filename
        }
        imgCont.appendChild(phText); // Add placeholder span (might be hidden)

        // Details Container
        const detDiv = document.createElement('div');
        detDiv.className = 'book-details';
        // Use textContent for title to prevent potential XSS if title had HTML
        const titleDiv = document.createElement('div');
        titleDiv.className = 'book-title';
        titleDiv.textContent = bookTitle;
        titleDiv.title = bookTitle; // Tooltip with full title
        detDiv.appendChild(titleDiv);

        // Meta Container (Link + Prices/Voucher)
        const metaDiv = document.createElement('div');
        metaDiv.className = 'book-meta';

        // External Link Icon (conditionally added)
        if (book.link) {
            const lnk = document.createElement('a');
            lnk.href = book.link;
            lnk.target = '_blank'; // Open in default browser
            lnk.rel = 'noopener noreferrer';
            lnk.className = 'book-view-icon';
            lnk.title = `View on website (opens browser)\n${book.link}`;
            lnk.innerHTML = svgIcon; // Use pre-compiled SVG
            metaDiv.appendChild(lnk);
        }

        // Prices & Voucher Info
        const pricesVoucherDiv = document.createElement('div');
        pricesVoucherDiv.className = 'book-meta-prices';
        let priceHtml = '';
        if (book.current_price) {
             priceHtml += `<span class="book-price">${book.current_price}</span>`;
        }
        if (book.old_price) {
            priceHtml += `<span class="book-old-price">${book.old_price}</span>`;
        }
        if (book.voucher_price) {
            const voucherBox = `<div class="voucher-price-box"><span class="book-voucher-price">${book.voucher_price}</span></div>`;
            const voucherCode = book.voucher_code ? `<span class="voucher-code-text">${book.voucher_code}</span>` : '';
            priceHtml += `<div class="voucher-info">${voucherBox}${voucherCode}</div>`; // Wrap voucher info
        }
         if (!book.current_price && !book.old_price && !book.voucher_price) {
            priceHtml = `<span class="book-no-price"></span>`; // Indicate no price
        }
        pricesVoucherDiv.innerHTML = priceHtml;
        metaDiv.appendChild(pricesVoucherDiv);

        detDiv.appendChild(metaDiv); // Add meta (link/prices) to details
        item.appendChild(imgCont); // Add image to item
        item.appendChild(detDiv); // Add details to item
        list.appendChild(item); // Add item to list
    });

    pageContainer.appendChild(list);
    return pageContainer;
}

// --- Event Handlers for Book Items ---
function handleBookDragStart(event) {
    try {
        const bookDataJson = event.currentTarget.dataset.bookData;
        if (!bookDataJson || bookDataJson === '{}') {
            console.warn("[Book List] Drag start: Missing or empty book data.");
            event.preventDefault();
            return;
        }
        const bookData = JSON.parse(bookDataJson);
        // Set data for dropping (application specific)
        event.dataTransfer.setData('application/json', bookDataJson);
        // Set data for external drops (e.g., text)
        event.dataTransfer.setData('text/plain', bookData.link || bookData.title || 'Book Item');
        event.dataTransfer.effectAllowed = 'copy'; // Indicate copying is the intended operation
        event.currentTarget.classList.add('dragging');

        // Notify Tracker UI about the drag start (if available)
        if(window.AppTrackerUI?.setDraggedItemInfo) {
            window.AppTrackerUI.setDraggedItemInfo({
                type: 'book',
                data: bookData, // Pass parsed data
                link: bookData.link,
                sourceCategoryIndex: null // Not from tracker initially
            });
        }
    } catch (err) {
        console.error("[Book List] Error during drag start:", err);
        event.preventDefault(); // Prevent drag if error occurs
    }
}

function handleBookDragEnd(event) {
    event.currentTarget.classList.remove('dragging');
    // Notify Tracker UI about drag end (if available)
    if(window.AppTrackerUI?.clearDraggedItemInfo) {
        window.AppTrackerUI.clearDraggedItemInfo();
    }
}

function handleBookMouseEnter(event) {
    event.currentTarget.classList.add('is-hovered');
    // Find adjacent siblings and apply shrink effect
    const prev = event.currentTarget.previousElementSibling;
    const next = event.currentTarget.nextElementSibling;
    if (prev?.classList.contains('book-item')) {
        prev.classList.add('shrink-neighbor');
    }
    if (next?.classList.contains('book-item')) {
        next.classList.add('shrink-neighbor');
    }
}

function handleBookMouseLeave(event) {
    event.currentTarget.classList.remove('is-hovered');
     // Find adjacent siblings and remove shrink effect
    const prev = event.currentTarget.previousElementSibling;
    const next = event.currentTarget.nextElementSibling;
     if(prev) prev.classList.remove('shrink-neighbor');
     if(next) next.classList.remove('shrink-neighbor');
}

function handleBookClick(event) {
    try {
        const bookDataJson = event.currentTarget.dataset.bookData;
        if (!bookDataJson || bookDataJson === '{}') {
            console.warn("[Book List] Click: Missing or empty book data.");
            alert("Details are currently unavailable for this item.");
            return;
        }
        const bookData = JSON.parse(bookDataJson);

        // Show details overlay (if available)
        if(window.AppDetailsOverlay?.showDetailsOverlay) {
            // Pass the basic data. The overlay will fetch full specs if needed.
            window.AppDetailsOverlay.showDetailsOverlay(bookData);
        } else {
            console.error("[Book List] AppDetailsOverlay.showDetailsOverlay is not available.");
            alert("Could not display book details function.");
        }
    } catch(err) {
        console.error("[Book List] Error handling book click:", err);
        alert("An error occurred while trying to show book details.");
    }
}


/** Adds or updates a query parameter in a URL string */
function addOrUpdateQueryParam(urlStr, paramName, paramValue) {
    if (!urlStr) {
        console.error("[URL Util] Base URL string is empty.");
        return null; // Return null or throw error
    }
    try {
        const parsedUrl = new URL(urlStr); // Use browser's built-in URL
        parsedUrl.searchParams.set(paramName, paramValue.toString());
        return parsedUrl.toString();
    } catch (e) {
        console.error(`[URL Util] Error manipulating URL '${urlStr}': ${e}`);
        return urlStr; // Return original string on error
    }
}

/** Fetch and append page data using IPC */
async function fetchAndAppendPageData(pageNumber) {
    if (isFetching || reachedEndOfPages) {
        // console.debug(`[Book List] Fetch skipped: Fetching=${isFetching}, EndReached=${reachedEndOfPages}`);
        return;
    }
    isFetching = true;
    if(window.scrollLoader) window.scrollLoader.style.display = 'flex';
    if(window.endOfContentMessage) window.endOfContentMessage.style.display = 'none';
    if(window.statusBar) window.statusBar.textContent = `Fetching page ${pageNumber}...`;
    // Hide initial loader only when starting the first fetch
    if (pageNumber === 1 && window.initialLoader) {
         window.initialLoader.style.display = 'none';
    }

    try {
        const webviewId = window.AppRuntime?.primaryWebviewId;
        const baseListUrl = window.AppRuntime?.primaryWebviewBaseListUrl;
        if (!webviewId) throw new Error("Primary webview ID is not configured.");
        if (!baseListUrl) throw new Error("Base List URL is not configured for the primary webview.");

        const targetUrl = addOrUpdateQueryParam(baseListUrl, 'page', pageNumber);
        if (!targetUrl) throw new Error("Failed to construct target URL.");

        console.log(`[Book List] Requesting page ${pageNumber} via IPC for WV:${webviewId}, URL:${targetUrl}`);

        // Call electronAPI to trigger main process fetch
        const result = await window.electronAPI.fetchListData(webviewId, targetUrl);

        if (!result.success) {
            // Throw error to be caught by the catch block below
            throw new Error(result.error || `IPC fetchListData failed for page ${pageNumber}`);
        }

        const fetchedBooks = result.data; // Assumes main process handled image downloads
        const fetchedCount = fetchedBooks?.length || 0;
        console.log(`[Book List] Page ${pageNumber} received ${fetchedCount} items via IPC.`);

        // --- End Of Pages Detection ---
        // Condition 1: Fetched 0 books on a page > 1
        if (fetchedCount === 0 && pageNumber > 1) {
            console.log(`[Book List] End detected: 0 items received on page ${pageNumber}.`);
            reachedEndOfPages = true;
        }
        // Condition 2: Fetched data matches the first page's data (potential loop/end)
        if (fetchedCount > 0) {
            const currentPageDataString = JSON.stringify(fetchedBooks);
            if (pageNumber === 1) {
                firstPageDataString = currentPageDataString; // Store first page data
            } else if (firstPageDataString !== null && currentPageDataString === firstPageDataString) {
                console.log(`[Book List] End detected: Page ${pageNumber} content matches page 1.`);
                reachedEndOfPages = true;
            }
        }
        // Condition 3: Explicitly received 0 books on page 1
        if (fetchedCount === 0 && pageNumber === 1) {
            console.log(`[Book List] End detected: 0 items received on page 1.`);
            reachedEndOfPages = true; // No books at all
        }

        // --- Append Content ---
        if (!reachedEndOfPages && fetchedCount > 0) {
            const listElement = createBookListElement(fetchedBooks, pageNumber);
            if(window.tabContentContainer) {
                 window.tabContentContainer.appendChild(listElement);
            }
            lastLoadedPage = pageNumber; // Update last successfully loaded page
            filterBooks(); // Apply current search filter to new items
            if(window.AppTrackerUI?.applyTrackerColorsToBookList) {
                window.AppTrackerUI.applyTrackerColorsToBookList(); // Apply tracker borders
            }
        }

        // --- Update UI Status ---
        if(reachedEndOfPages) {
            if(window.endOfContentMessage) window.endOfContentMessage.style.display = 'block';
            if(window.statusBar) window.statusBar.textContent = `All pages loaded. ${lastLoadedPage} pages total.`;
        } else {
            if(window.statusBar) window.statusBar.textContent = `Page ${pageNumber} loaded (${fetchedCount} items). Scroll for more.`;
        }

    } catch (error) {
        console.error(`[Book List] Error fetching or processing page ${pageNumber}:`, error);
        if(window.statusBar) window.statusBar.textContent = `Error loading page ${pageNumber}!`;
        // Show error message in the status area, allow retry on scroll
        if(window.endOfContentMessage) {
            window.endOfContentMessage.textContent = `Error loading page ${pageNumber}. Scroll down to retry?`;
            window.endOfContentMessage.style.display = 'block';
            window.endOfContentMessage.classList.add('error-message');
        }
        // Do not set reachedEndOfPages = true on error, allow retries
    } finally {
        isFetching = false; // Allow next fetch attempt
        if(window.scrollLoader) window.scrollLoader.style.display = 'none'; // Hide loader
    }
}

/** Handle Scroll Events with Debouncing */
function handleScroll() {
    if (!window.contentScrollContainer) return;

    clearTimeout(scrollDebounceTimer); // Clear previous timer
    scrollDebounceTimer = setTimeout(() => {
        if (isFetching || reachedEndOfPages) return; // Don't fetch if already fetching or end reached

        const { scrollTop, scrollHeight, clientHeight } = window.contentScrollContainer;
        // Trigger load slightly earlier (e.g., 450px from bottom)
        const threshold = 450;

        if (scrollHeight - scrollTop <= clientHeight + threshold) {
            console.log("[Book List] Scroll threshold reached, fetching next page...");
            // Reset error message if present before fetching next page
            if(window.endOfContentMessage && window.endOfContentMessage.classList.contains('error-message')) {
                 window.endOfContentMessage.style.display='none';
                 window.endOfContentMessage.classList.remove('error-message');
                 window.endOfContentMessage.textContent='no more books here';
            }
            fetchAndAppendPageData(lastLoadedPage + 1);
        }
    }, SCROLL_DEBOUNCE_MS);
}

/** Filter Books by Search Term */
function filterBooks() {
    const term = currentSearchTerm.toLowerCase().trim();
    if (!window.tabContentContainer) return;

    const items = window.tabContentContainer.querySelectorAll('.book-item');
    let visibleCount = 0;
    items.forEach(item => {
        // Check dataset.bookTitle for the search term
        const title = (item.dataset.bookTitle || '').toLowerCase();
        const isMatch = term === '' || title.includes(term);

        if (isMatch) {
            item.classList.remove('hidden-by-search');
            visibleCount++;
        } else {
            item.classList.add('hidden-by-search');
        }
    });
    // console.debug(`[Book List] Filter applied: "${term}". Visible items: ${visibleCount}`);
    // Optionally update status bar or show a message if no results match
    // if (visibleCount === 0 && term !== '') { ... }
}

/** Handle Search Input with Debouncing */
function handleSearchInput(event) {
    currentSearchTerm = event.target.value; // Update the search term state
    clearTimeout(searchDebounceTimer); // Clear previous timer
    // Apply filter after a short delay to avoid filtering on every keystroke
    searchDebounceTimer = setTimeout(filterBooks, SEARCH_DEBOUNCE_MS);
}

/** Setup Event Listeners */
function setupBookListEventListeners() {
    if (!window.contentScrollContainer || !window.bookSearchInput) {
        console.error("[Book List] Cannot setup listeners - essential scroll container or search input missing.");
        return;
    }
    window.contentScrollContainer.addEventListener('scroll', handleScroll);
    window.bookSearchInput.addEventListener('input', handleSearchInput);
    // Handle clearing the search input (e.g., clicking the 'x')
    window.bookSearchInput.addEventListener('search', handleSearchInput);
    console.log("[Book List] Event listeners setup (scroll, search).");
}

// --- Initialization Function ---
async function initializeBookListManager() {
    console.log("[Book List] Initializing Book List Manager...");
    setupBookListEventListeners();

    // Reset state variables
    lastLoadedPage = 0;
    isFetching = false;
    reachedEndOfPages = false;
    firstPageDataString = null;
    currentSearchTerm = '';
    if (window.bookSearchInput) window.bookSearchInput.value = ''; // Clear search input visually
    if (window.tabContentContainer) window.tabContentContainer.innerHTML = ''; // Clear previous content
    if (window.initialLoader) window.initialLoader.style.display = 'flex'; // Show initial loader
    if (window.endOfContentMessage) window.endOfContentMessage.style.display = 'none'; // Hide end message
    if (window.scrollLoader) window.scrollLoader.style.display = 'none'; // Hide scroll loader

    // Fetch the first page of data
    await fetchAndAppendPageData(1);

    // Hide initial loader after first fetch attempt (even if it failed)
    if(window.initialLoader) window.initialLoader.style.display = 'none';

    // Final checks after first load
    if(reachedEndOfPages && window.endOfContentMessage) {
        console.log("[Book List] End reached on the very first page.");
        window.endOfContentMessage.style.display = 'block';
    }

    filterBooks(); // Apply empty filter initially
    if(window.AppTrackerUI?.applyTrackerColorsToBookList) {
        window.AppTrackerUI.applyTrackerColorsToBookList(); // Apply colors if tracker is ready
    }
    console.log("[Book List] Initialization complete.");
}


// Expose public methods via window object
window.AppBookListManager = {
    initialize: initializeBookListManager, // Use the async initialization function
    filterBooks // Expose filter function if needed externally (e.g., for tracker updates)
    // fetchAndAppendPageData // Could be exposed for manual refresh, but scroll handles it now
};

console.log("[Book List Manager] Module loaded and ready.");