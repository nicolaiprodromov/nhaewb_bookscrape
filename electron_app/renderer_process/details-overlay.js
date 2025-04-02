// electron_app/renderer_process/details-overlay.js

// Assumes necessary DOM elements, electronAPI, and AppRuntime are globally available
// Requires: AppUIUtils, AppTrackerUI (for cache)

let isFetchingSpecs = false;

/** Fetches book specifications from main process via IPC if not already cached */
async function fetchBookSpecsIfNeeded(bookLink, bookTitle = 'book') {
    const cache = window.AppTrackerUI?.bookSpecsCache;
    if (!cache) { console.error("[Details Overlay] Book specs cache (window.AppTrackerUI.bookSpecsCache) not found!"); return { fetchError: "Internal error: Cache unavailable" }; }
    if (!bookLink || typeof bookLink !== 'string') return null;
    if (cache.has(bookLink)) return cache.get(bookLink);
    if (isFetchingSpecs) { console.warn("[Details Overlay] Skipping concurrent spec fetch for:", bookLink); return null; }

    console.log(`[Details Overlay] Fetching specs required for: ${bookLink}`);
    isFetchingSpecs = true; if(window.statusBar) window.statusBar.textContent = `Fetching details for ${bookTitle}...`;

    try {
        const webviewId = window.AppRuntime?.primaryWebviewId;
        if (!webviewId) throw new Error("Primary webview ID not configured in AppRuntime.");
        // *** MODIFIED: Call electronAPI ***
        const result = await window.electronAPI.fetchDetailData(webviewId, bookLink);
        if (!result.success) throw new Error(result.error || 'IPC fetchDetailData failed');

        const fetchedSpecs = result.details || {}; // Specs are under 'details' key
        console.log("[Details Overlay] Specs received via IPC:", fetchedSpecs);
        cache.set(bookLink, fetchedSpecs); // Update central cache
        if(window.statusBar) window.statusBar.textContent = `Details fetched for ${bookTitle}.`;
        isFetchingSpecs = false;
        return fetchedSpecs;
    } catch (error) {
        console.error(`[Details Overlay] Error fetching specs for ${bookLink} via IPC:`, error);
        if(window.statusBar) window.statusBar.textContent = `Error fetching details for ${bookTitle}!`;
        const errorData = { fetchError: error.message };
        cache.set(bookLink, errorData);
        isFetchingSpecs = false;
        return errorData;
    } finally {
         // Clear status bar after delay (unchanged)
         setTimeout(() => { if(window.statusBar && (window.statusBar.textContent?.startsWith(`Fetching details for ${bookTitle}`) || window.statusBar.textContent?.startsWith(`Error fetching details for ${bookTitle}`))) { window.statusBar.textContent="Details loaded/error."; } }, 2000);
    }
}

/** Shows the details overlay populated with book or category data */
async function showDetailsOverlay(data) {
    if (!data || !window.detailsOverlay || !window.detailsTitle || !window.detailsBody) return;
    let title = data.type === 'category' ? `Stack: ${data.name || 'Unnamed'}` : (data.title || 'Book Details');
    window.detailsTitle.textContent = title;
    window.detailsBody.innerHTML = '<div class="loading-indicator lottie-loading-container"><p>Loading...</p></div>';
    window.detailsOverlay.classList.add('active');
    if(window.detailsOverlayContent) window.detailsOverlayContent.scrollTop = 0;
    let finalHtml = '';
    try {
        if (data.type === 'category') {
            finalHtml = `<h3>Books (${data.books?.length || 0}):</h3>`;
            if (data.books && data.books.length > 0) {
                finalHtml += '<ul>';
                for (const book of data.books) {
                    window.detailsBody.innerHTML = `${finalHtml}<li><i>Fetching details for ${book.title || 'book'}...</i></li></ul>`;
                    const specs = await fetchBookSpecsIfNeeded(book.link, book.title);
                    let specStr = specs?.fetchError ? ` (<span class="error-message">Details error!</span>)` : (specs ? ` (ISBN: ${specs.isbn||'N/A'})` : ' (Details pending...)');
                    finalHtml += `<li>${book.title || 'Untitled'} ${book.link ? `(<a href="${book.link}" target="_blank">link</a>)`:''}${specStr}</li>`;
                } finalHtml += '</ul>';
            } else { finalHtml += '<p>No books in this stack.</p>'; }
            finalHtml += `<hr><h3>Stack Info:</h3><pre>${JSON.stringify({id:data.id, name:data.name, count:data.books?.length}, null, 2)}</pre>`;
        } else { // Assume book
            const book = data; finalHtml = `<p><strong>Title:</strong> ${book.title||'N/A'}</p>`;
            if(book.link) finalHtml += `<p><strong>Link:</strong> <a href="${book.link}" target="_blank">${book.link}</a></p>`;
            finalHtml += `<hr><h3>Pricing:</h3>`;
            if(book.current_price) finalHtml += `<p><strong>Current:</strong> ${book.current_price}</p>`;
            if(book.old_price) finalHtml += `<p><strong>Old:</strong> <span style="text-decoration:line-through;">${book.old_price}</span></p>`;
            if(book.voucher_price) finalHtml += `<p><strong>Voucher:</strong> ${book.voucher_price} ${book.voucher_code?`(Code: ${book.voucher_code})`:''}</p>`;
            if(!book.current_price&&!book.old_price&&!book.voucher_price) finalHtml += `<p>No price info.</p>`;
            finalHtml += `<hr><h3>Specifications:</h3>`; window.detailsBody.innerHTML = finalHtml + `<p><i>Fetching specs...</i></p>`;
            const specs = await fetchBookSpecsIfNeeded(book.link, book.title);
            if (specs && !specs.fetchError) {
                const items = [ {l:'ISBN',v:specs.isbn}, {l:'Author',v:specs.author,u:specs.authorUrl}, {l:'Publisher',v:specs.publisher,u:specs.publisherUrl}, {l:'Year',v:specs.publishYear}, {l:'Pages',v:specs.pages}, {l:'Binding',v:specs.binding}, {l:'Language',v:specs.language}, {l:'Category',v:specs.category} ];
                let specHtml = ''; items.forEach(i => { if(i.v) { specHtml += `<p><strong>${i.l}:</strong> ${i.v}`; if(i.u) specHtml += ` (<a href="${i.u}" target="_blank">link</a>)`; specHtml += `</p>`; } });
                finalHtml += specHtml || '<p>No specific details found.</p>';
            } else if (specs?.fetchError) { finalHtml += `<p class="error-message">Specs Error: ${specs.fetchError}</p>`; }
            else { finalHtml += `<p>Specs could not be loaded${specs===null?' (skipped)':''}.</p>`; }
            finalHtml += `<hr><h3>Raw Data:</h3><pre>${JSON.stringify(book, null, 2)}</pre>`;
            if(specs && !specs.fetchError) finalHtml += `<pre>--- Specs ---\n${JSON.stringify(specs, null, 2)}</pre>`;
        }
        window.detailsBody.innerHTML = finalHtml; if(window.statusBar) window.statusBar.textContent="Details loaded.";
    } catch (error) { console.error("[Details Overlay] Error generating content:", error); window.detailsBody.innerHTML = `<p class="error-message">Error display: ${error.message}</p><pre>${JSON.stringify(data,null,2)}</pre>`; if(window.statusBar) window.statusBar.textContent="Error loading details."; }
}

function hideDetailsOverlay() { if (window.detailsOverlay) window.detailsOverlay.classList.remove('active'); }
function setupDetailsOverlayEventListeners() { if (!window.detailsOverlay || !window.detailsCloseBtn) { console.error("[Details Overlay] Cannot setup listeners."); return; } window.detailsCloseBtn.addEventListener('click', hideDetailsOverlay); window.detailsOverlay.addEventListener('click', (e) => { if (e.target === window.detailsOverlay) hideDetailsOverlay(); }); document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && window.detailsOverlay?.classList.contains('active')) hideDetailsOverlay(); }); console.log("[Details Overlay] Listeners setup."); }

window.AppDetailsOverlay = { initialize: setupDetailsOverlayEventListeners, showDetailsOverlay, hideDetailsOverlay, fetchBookSpecsIfNeeded };
console.log("[Details Overlay] Module loaded.");
