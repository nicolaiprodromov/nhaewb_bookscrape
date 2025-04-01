// electron_app/renderer_process/details-overlay.js
// Assumes necessary DOM elements are globally available or passed in
// Requires: detailsOverlay, detailsOverlayContent, detailsTitle, detailsBody, detailsCloseBtn, statusBar
// Requires access to: AppUIUtils, AppTrackerUI.bookSpecsCache (or similar central cache), PYTHON_BACKEND_URL

let isFetchingSpecs = false; // Prevent concurrent spec fetches for the overlay

/**
 * Fetches book specifications from the backend if not already cached.
 * Updates the central cache (e.g., AppTrackerUI.bookSpecsCache). // Updated comment
 */
async function fetchBookSpecsIfNeeded(bookLink, bookTitle = 'book') {
    // *** FIX: Access cache directly from AppTrackerUI ***
    const cache = window.AppTrackerUI?.bookSpecsCache; // Changed access path

    if (!cache) {
        console.error("[Details Overlay] Book specs cache (window.AppTrackerUI.bookSpecsCache) not found!"); // Updated error message
        return { fetchError: "Internal error: Cache unavailable" };
    }

    // ... rest of fetchBookSpecsIfNeeded remains the same ...
    if (!bookLink || typeof bookLink !== 'string') return null; // No link, nothing to fetch
    if (cache.has(bookLink)) {
        // console.debug(`[Details Overlay] Specs cache hit for: ${bookLink}`);
        return cache.get(bookLink); // Return cached data (could be specs object or error object)
    }
    if (isFetchingSpecs) {
        console.warn("[Details Overlay] Already fetching specs, skipping concurrent request for:", bookLink);
        return null; // Indicate fetch in progress or skipped
    }

    console.log(`[Details Overlay] Fetching specs required for: ${bookLink}`);
    isFetchingSpecs = true;
    if(window.statusBar) window.statusBar.textContent = `Fetching details for ${bookTitle}...`;

    try {
        // Construct URL using PYTHON_BACKEND_URL (should be globally available)
        if (!window.PYTHON_BACKEND_URL) throw new Error("Backend URL not configured.");
        const encodedUrl = encodeURIComponent(bookLink);
        // *** Endpoint Name from Refactored backend_app.py ***
        const fetchUrl = `${window.PYTHON_BACKEND_URL}/fetch-book-details?url=${encodedUrl}`;
        const response = await fetch(fetchUrl);

        if (!response.ok) {
            let errorMsg = `HTTP error ${response.status}`;
            try { const errData = await response.json(); errorMsg += `: ${errData.error || 'Unknown backend error'}`; } catch { /* ignore json parse error */ }
            throw new Error(errorMsg);
        }

        const result = await response.json();
        if (!result.success) {
            throw new Error(result.error || 'Backend reported failure');
        }

        const fetchedSpecs = result.details || {}; // Use details field from response
        console.log("[Details Overlay] Specs received:", fetchedSpecs);
        cache.set(bookLink, fetchedSpecs); // Update central cache
        if(window.statusBar) window.statusBar.textContent = `Details fetched for ${bookTitle}.`;
        return fetchedSpecs;

    } catch (error) {
        console.error(`[Details Overlay] Error fetching specs for ${bookLink}:`, error);
        if(window.statusBar) window.statusBar.textContent = `Error fetching details for ${bookTitle}!`;
        const errorData = { fetchError: error.message };
        cache.set(bookLink, errorData); // Store error state in cache
        return errorData; // Indicate failure

    } finally {
        isFetchingSpecs = false;
        // Optionally reset status bar after a short delay
         setTimeout(() => {
            // Only clear status if it still shows the fetching message for this action
            if(window.statusBar && window.statusBar.textContent?.startsWith(`Fetching details for ${bookTitle}`)) {
                window.statusBar.textContent = "Details loaded."; // Or back to Ready/Idle state
            } else if (window.statusBar && window.statusBar.textContent?.startsWith(`Error fetching details for ${bookTitle}`)) {
                 window.statusBar.textContent = "Error loading details."; // Keep error message
            }
         }, 2000);
    }
}


/** Shows the details overlay populated with book or category data */
async function showDetailsOverlay(data) {
    if (!data || !window.detailsOverlay || !window.detailsTitle || !window.detailsBody) return;

    let title = 'Details';
    let bodyContent = '<div class="loading-indicator lottie-loading-container"><p>Loading...</p></div>'; // Simple loading text initially

    // Set title based on data type
    if (data.type === 'category') { title = `Stack Details: ${data.name || 'Unnamed Stack'}`; }
    else { title = data.title || 'Book Details'; } // Assume book otherwise
    window.detailsTitle.textContent = title;

    // Show overlay with initial loading state
    window.detailsBody.innerHTML = bodyContent;
    window.detailsOverlay.classList.add('active');
    if(window.detailsOverlayContent) window.detailsOverlayContent.scrollTop = 0; // Scroll to top

    // --- Generate the actual content asynchronously ---
    let finalHtml = '';
    try {
        if (data.type === 'category') {
            finalHtml = `<h3>Books (${data.books?.length || 0}):</h3>`;
            if (data.books && data.books.length > 0) {
                finalHtml += '<ul>';
                // Sequentially fetch/display details for books in the category
                for (const book of data.books) {
                    // Update loading state within the overlay
                    window.detailsBody.innerHTML = `${finalHtml}<li><i>Fetching details for ${book.title || 'book'}...</i></li></ul>`;

                    const specs = await fetchBookSpecsIfNeeded(book.link, book.title); // Await the fetch/cache lookup

                    // Build list item content with fetched/cached specs
                    let specString = '(No details available)';
                    if (specs && !specs.fetchError) {
                         specString = ` (ISBN: ${specs.isbn || 'N/A'}, Pgs: ${specs.pages || 'N/A'})`; // Example spec display
                    } else if (specs?.fetchError) {
                         specString = ` (<span class="error-message">Details error!</span>)`;
                    } else if (specs === null) {
                         specString = ` (Details fetch pending...)`; // If fetch was skipped due to concurrency
                    }

                    finalHtml += `<li>${book.title || 'Untitled'} ${book.link ? `(<a href="${book.link}" target="_blank" title="Open product page">link</a>)` : ''}${specString}</li>`;
                }
                finalHtml += '</ul>';
            } else {
                finalHtml += '<p>No books in this stack.</p>';
            }
            // Add raw stack info if desired
            finalHtml += `<hr><h3>Stack Info:</h3><pre>${JSON.stringify({ id: data.id, name: data.name, bookCount: data.books?.length }, null, 2)}</pre>`;

        } else { // Assume it's a book
            const book = data; // Rename for clarity
            finalHtml = `<p><strong>Title:</strong> ${book.title || 'N/A'}</p>`;
            if (book.link) finalHtml += `<p><strong>Link:</strong> <a href="${book.link}" target="_blank" title="Open product page">${book.link}</a></p>`;

            // Display Prices
            finalHtml += `<hr><h3>Pricing:</h3>`;
            if (book.current_price) finalHtml += `<p><strong>Current Price:</strong> ${book.current_price}</p>`;
            if (book.old_price) finalHtml += `<p><strong>Old Price:</strong> <span style="text-decoration: line-through;">${book.old_price}</span></p>`;
            if (book.voucher_price) finalHtml += `<p><strong>Voucher Price:</strong> ${book.voucher_price} ${book.voucher_code ? `(Code: ${book.voucher_code})` : ''}</p>`;
            if (!book.current_price && !book.old_price && !book.voucher_price) finalHtml += `<p>No price information available.</p>`

            // Fetch and display Specs
            finalHtml += `<hr><h3>Specifications:</h3>`;
            window.detailsBody.innerHTML = finalHtml + `<p><i>Fetching specifications...</i></p>`; // Update loading status

            const specs = await fetchBookSpecsIfNeeded(book.link, book.title);

            if (specs && !specs.fetchError) {
                // Dynamically build specs list
                const specItems = [
                    { label: 'ISBN', value: specs.isbn },
                    { label: 'Author', value: specs.author, url: specs.authorUrl },
                    { label: 'Publisher', value: specs.publisher, url: specs.publisherUrl },
                    { label: 'Year', value: specs.publishYear },
                    { label: 'Pages', value: specs.pages },
                    { label: 'Binding', value: specs.binding },
                    { label: 'Language', value: specs.language },
                    { label: 'Category', value: specs.category },
                     // Add other specs from detail-extraction.js mapping here
                ];
                let specHtml = '';
                specItems.forEach(item => {
                    if (item.value) {
                        specHtml += `<p><strong>${item.label}:</strong> ${item.value}`;
                        if (item.url) specHtml += ` (<a href="${item.url}" target="_blank" title="View related items">link</a>)`;
                        specHtml += `</p>`;
                    }
                });
                if (!specHtml) specHtml = '<p>No specific details found.</p>';
                 finalHtml += specHtml;
            } else if (specs?.fetchError) {
                finalHtml += `<p class="error-message">Could not fetch specifications: ${specs.fetchError}</p>`;
            } else {
                 finalHtml += `<p>Specifications could not be loaded${specs === null ? ' (fetch skipped)' : ''}.</p>`;
            }

            // Optional Raw Data section
            finalHtml += `<hr><h3>Raw Data:</h3><pre>${JSON.stringify(book, null, 2)}</pre>`; // Display original book data
             if(specs && !specs.fetchError) finalHtml += `<pre>--- Specs ---\n${JSON.stringify(specs, null, 2)}</pre>`; // Display fetched specs
        }

        // Update the body with the final generated content
        window.detailsBody.innerHTML = finalHtml;
        if(window.statusBar) window.statusBar.textContent = "Details loaded."; // Reset status bar

    } catch (error) {
        console.error("[Details Overlay] Error generating details content:", error);
        window.detailsBody.innerHTML = `<p class="error-message">Error displaying details: ${error.message}</p><pre>${JSON.stringify(data, null, 2)}</pre>`;
         if(window.statusBar) window.statusBar.textContent = "Error loading details.";
    }
}


/** Hides the details overlay */
function hideDetailsOverlay() {
    if (window.detailsOverlay) {
        window.detailsOverlay.classList.remove('active');
    }
}

/** Setup event listeners for the details overlay */
function setupDetailsOverlayEventListeners() {
     if (!window.detailsOverlay || !window.detailsCloseBtn) {
         console.error("[Details Overlay] Cannot setup listeners - essential elements missing.");
         return;
     }
    window.detailsCloseBtn.addEventListener('click', hideDetailsOverlay);
    // Close if clicking outside the content area
    window.detailsOverlay.addEventListener('click', (event) => {
        if (event.target === window.detailsOverlay) {
            hideDetailsOverlay();
        }
    });
    // Close on Escape key
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && window.detailsOverlay?.classList.contains('active')) { // Add safe check
            hideDetailsOverlay();
        }
    });
     console.log("[Details Overlay] Event listeners setup.");
}

// Export functions/state if needed
window.AppDetailsOverlay = {
    initialize: setupDetailsOverlayEventListeners,
    showDetailsOverlay,
    hideDetailsOverlay,
    fetchBookSpecsIfNeeded // Expose if needed by other modules, e.g., tracker UI
};
console.log("[Details Overlay] Module loaded.");