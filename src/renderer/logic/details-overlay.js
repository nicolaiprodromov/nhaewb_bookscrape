// src/renderer/logic/details-overlay.js

// Assumes necessary DOM elements (window.*) and electronAPI are globally available via renderer.js
// Assumes AppRuntime, AppUIUtils, AppTrackerUI are globally available

let isFetchingSpecs = false; // Prevent concurrent spec fetches for the *same* link

/**
 * Fetches book specifications (details) from the main process via IPC if not already cached.
 * @param {string} bookLink - The unique URL of the book.
 * @param {string} [bookTitle='book'] - The title of the book for status messages.
 * @returns {Promise<object|null>} Specs object, object with fetchError, or null.
 */
async function fetchBookSpecsIfNeeded(bookLink, bookTitle = 'book') {
    // Ensure the central cache from TrackerUI is available
    const cache = window.AppTrackerUI?.bookSpecsCache;
    if (!cache) {
        console.error("[Details Overlay] Book specs cache (window.AppTrackerUI.bookSpecsCache) not found!");
        return { fetchError: "Internal error: Specs cache unavailable" };
    }

    if (!bookLink || typeof bookLink !== 'string' || !bookLink.startsWith('http')) {
        console.warn("[Details Overlay] Invalid book link provided for spec fetch:", bookLink);
        return null; // Cannot fetch without a valid link
    }

    // 1. Check cache first
    if (cache.has(bookLink)) {
        // console.debug(`[Details Overlay] Specs cache hit for: ${bookLink}`);
        return cache.get(bookLink); // Return cached data (could be specs or error object)
    }

    // 2. Prevent concurrent fetches for the same link (simple lock)
    if (isFetchingSpecs) {
        console.warn(`[Details Overlay] Skipping concurrent spec fetch request for: ${bookLink}`);
        // Return null to indicate fetch was skipped, let caller decide how to handle
        return null;
    }

    console.log(`[Details Overlay] Fetching specs required for: ${bookLink}`);
    isFetchingSpecs = true; // Set lock
    if(window.statusBar) window.statusBar.textContent = `Fetching details for "${bookTitle}"...`;

    try {
        const webviewId = window.AppRuntime?.primaryWebviewId;
        if (!webviewId) {
            throw new Error("Primary webview ID not configured in AppRuntime.");
        }

        // Call main process via IPC to fetch details
        const result = await window.electronAPI.fetchDetailData(webviewId, bookLink);

        if (!result.success) {
            // Throw error to be caught locally, includes error message from main process
            throw new Error(result.error || `IPC fetchDetailData failed for ${bookLink}`);
        }

        // Extract specs (details) and prices from the result
        const fetchedSpecs = result.details || {}; // Default to empty object if missing
        const fetchedPrices = result.prices || {}; // Also get prices to update main book data if needed

        console.log(`[Details Overlay] Specs received via IPC for ${bookLink}:`, fetchedSpecs);

        // Update the central cache with the fetched specs
        cache.set(bookLink, fetchedSpecs);

        if(window.statusBar) window.statusBar.textContent = `Details fetched for "${bookTitle}".`;

        // Return the fetched specs
        return fetchedSpecs;

    } catch (error) {
        console.error(`[Details Overlay] Error fetching specs for ${bookLink} via IPC:`, error);
        if(window.statusBar) window.statusBar.textContent = `Error fetching details for "${bookTitle}"!`;

        // Cache the error state so we don't repeatedly try fetching a failing link
        const errorData = { fetchError: error.message || 'Unknown fetch error' };
        cache.set(bookLink, errorData);

        // Return the error object
        return errorData;

    } finally {
        isFetchingSpecs = false; // Release lock
         // Clear status bar message after a delay
         setTimeout(() => {
             const currentStatus = window.statusBar?.textContent || '';
             if (currentStatus.includes(`Fetching details for "${bookTitle}"`) || currentStatus.includes(`Error fetching details for "${bookTitle}"`)) {
                 window.statusBar.textContent = "Status idle."; // Or a more relevant status
             }
         }, 3000); // Increased delay
    }
}

/** Formats book specification details into HTML string */
function formatBookSpecsHtml(specs) {
    if (!specs || typeof specs !== 'object') return '<p>No specific details available.</p>';
    if (specs.fetchError) return `<p class="error-message">Could not load specifications: ${specs.fetchError}</p>`;

    const items = [
        { label: 'ISBN', value: specs.isbn },
        { label: 'Author', value: specs.author, url: specs.authorUrl },
        { label: 'Publisher', value: specs.publisher, url: specs.publisherUrl }, // Assuming publisher might have a URL
        { label: 'Year', value: specs.publishYear },
        { label: 'Pages', value: specs.pages },
        { label: 'Binding', value: specs.binding },
        { label: 'Language', value: specs.language },
        { label: 'Category', value: specs.category } // Assuming category might be present
    ];

    let specHtml = '';
    items.forEach(item => {
        if (item.value) { // Only display if value exists
            specHtml += `<p><strong>${item.label}:</strong> ${item.value}`;
            if (item.url) {
                specHtml += ` (<a href="${item.url}" target="_blank" rel="noopener noreferrer" title="Visit ${item.label}'s page">link</a>)`;
            }
            specHtml += `</p>`;
        }
    });

    return specHtml || '<p>No specific details found in the provided data.</p>'; // Fallback if no values were present
}

/** Formats book pricing details into HTML string */
function formatBookPricingHtml(book) {
     let pricingHtml = '';
     if (book.current_price) {
         pricingHtml += `<p><strong>Current Price:</strong> <span class="book-price">${book.current_price}</span></p>`;
     }
     if (book.old_price) {
         pricingHtml += `<p><strong>Old Price:</strong> <span class="book-old-price">${book.old_price}</span></p>`;
     }
     if (book.voucher_price) {
         pricingHtml += `<p><strong>Voucher Price:</strong> <span class="book-voucher-price">${book.voucher_price}</span>`;
         if (book.voucher_code) {
            pricingHtml += ` (Code: <span class="voucher-code-text">${book.voucher_code}</span>)`;
         }
         pricingHtml += `</p>`;
     }
     if (!pricingHtml) { // No prices found
         pricingHtml = '<p>No pricing information available.</p>';
     }
     return pricingHtml;
}


/**
 * Shows the details overlay populated with book or category data.
 * Fetches specs dynamically if showing book details.
 */
async function showDetailsOverlay(data) {
    // Ensure overlay elements exist
    if (!window.detailsOverlay || !window.detailsTitle || !window.detailsBody) {
        console.error("[Details Overlay] Cannot show overlay - core elements missing.");
        return;
    }

    if (!data || typeof data !== 'object') {
        console.error("[Details Overlay] Invalid data provided to showDetailsOverlay:", data);
        window.detailsTitle.textContent = 'Error';
        window.detailsBody.innerHTML = '<p class="error-message">Invalid data received for details view.</p>';
        window.detailsOverlay.classList.add('active');
        return;
    }

    // Determine title based on data type
    let title = 'Details';
    if (data.type === 'category') {
        title = `Stack: ${data.name || 'Unnamed Stack'}`;
    } else if (data.title) {
        title = data.title; // Assume book if 'title' exists and not 'category' type
    }

    window.detailsTitle.textContent = title;
    // Show loading indicator immediately
    window.detailsBody.innerHTML = '<div class="loading-indicator lottie-loading-container" style="min-height: 150px;"><p>Loading details...</p></div>';
    window.detailsOverlay.classList.add('active');
    if(window.detailsOverlayContent) window.detailsOverlayContent.scrollTop = 0; // Scroll to top

    let finalHtml = '';

    try {
        // --- Category Details ---
        if (data.type === 'category') {
            finalHtml = `<h3>Books in Stack (${data.books?.length || 0}):</h3>`;
            if (data.books && data.books.length > 0) {
                finalHtml += '<ul>';
                // Fetch specs for each book in the category sequentially for status updates
                for (const book of data.books) {
                    // Update list incrementally
                    const currentListHtml = finalHtml + `<li>${book.title || 'Untitled Book'}... <i>fetching details...</i></li></ul>`;
                    window.detailsBody.innerHTML = currentListHtml; // Update UI

                    const specs = await fetchBookSpecsIfNeeded(book.link, book.title);
                    let specStr = '';
                    if (specs === null) {
                        specStr = ' (<span class="info-message">Details fetch skipped</span>)';
                    } else if (specs?.fetchError) {
                        specStr = ` (<span class="error-message">Details Error</span>)`;
                    } else if (specs && Object.keys(specs).length > 0) {
                        specStr = ` (ISBN: ${specs.isbn || 'N/A'})`;
                    } else {
                        specStr = ' (No details found)';
                    }
                    // Add final list item for this book
                    finalHtml += `<li>${book.title || 'Untitled Book'} ${book.link ? `(<a href="${book.link}" target="_blank" title="View Book">link</a>)`: ''}${specStr}</li>`;
                }
                finalHtml += '</ul>'; // Close the list tag
            } else {
                finalHtml += '<p>No books currently in this stack.</p>';
            }
            // Add raw category info at the end
            finalHtml += `<hr><h3>Stack Info:</h3><pre>${JSON.stringify({id: data.id, name: data.name, count: data.books?.length}, null, 2)}</pre>`;

        // --- Book Details ---
        } else { // Assume it's a book if not explicitly 'category'
            const book = data;
            // Basic Info
            finalHtml = `<p><strong>Title:</strong> ${book.title || 'N/A'}</p>`;
            if (book.link) {
                finalHtml += `<p><strong>Link:</strong> <a href="${book.link}" target="_blank" rel="noopener noreferrer" title="Visit product page">${book.link}</a></p>`;
            }

            // Pricing Section
            finalHtml += `<hr><h3>Pricing:</h3>`;
            finalHtml += formatBookPricingHtml(book);

            // Specifications Section (Fetch required)
            finalHtml += `<hr><h3>Specifications:</h3>`;
            // Show temporary fetching message while specs load
            window.detailsBody.innerHTML = finalHtml + `<p><i>Fetching specifications...</i></p>`;

            const specs = await fetchBookSpecsIfNeeded(book.link, book.title);
            // Now add the formatted specs (or error) to the finalHtml
            finalHtml += formatBookSpecsHtml(specs);

            // Raw Data Section (for debugging)
            finalHtml += `<hr><h3>Raw Data:</h3>`;
            // Display the book data passed initially
            finalHtml += `<pre>${JSON.stringify(book, null, 2)}</pre>`;
            // Display the fetched specs data if available and not an error
            if (specs && !specs.fetchError) {
                 finalHtml += `<h4>--- Fetched Specs ---</h4><pre>${JSON.stringify(specs, null, 2)}</pre>`;
            }
        }

        // Update the details body with the final generated HTML
        window.detailsBody.innerHTML = finalHtml;
        if(window.statusBar) window.statusBar.textContent = "Details loaded.";

    } catch (error) {
        console.error("[Details Overlay] Error generating content:", error);
        window.detailsBody.innerHTML = `<p class="error-message">Error displaying details: ${error.message}</p><pre>Data: ${JSON.stringify(data, null, 2)}</pre>`;
        if(window.statusBar) window.statusBar.textContent = "Error loading details!";
    }
}

/** Hides the details overlay */
function hideDetailsOverlay() {
    if (window.detailsOverlay) {
        window.detailsOverlay.classList.remove('active');
    }
}

/** Sets up event listeners for the details overlay */
function setupDetailsOverlayEventListeners() {
    if (!window.detailsOverlay || !window.detailsCloseBtn || !window.detailsOverlayContent) {
        console.error("[Details Overlay] Cannot setup listeners - essential overlay elements missing.");
        return;
    }
    // Close button
    window.detailsCloseBtn.addEventListener('click', hideDetailsOverlay);

    // Click outside the content area to close
    window.detailsOverlay.addEventListener('click', (e) => {
        // Check if the click target is the overlay background itself, not the content
        if (e.target === window.detailsOverlay) {
            hideDetailsOverlay();
        }
    });

    // Escape key to close
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && window.detailsOverlay?.classList.contains('active')) {
            hideDetailsOverlay();
        }
    });

    console.log("[Details Overlay] Event listeners setup.");
}

// --- Initialization and Export ---
window.AppDetailsOverlay = {
    initialize: setupDetailsOverlayEventListeners,
    showDetailsOverlay,
    hideDetailsOverlay,
    fetchBookSpecsIfNeeded // Expose spec fetching if needed elsewhere (though unlikely)
};

console.log("[Details Overlay] Module loaded.");