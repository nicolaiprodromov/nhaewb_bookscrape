// src/renderer/logic/book-list-manager.js
// Assumes necessary DOM elements (window.*) and electronAPI are globally available via renderer.js
// Assumes AppRuntime, AppUIUtils, AppTrackerUI, AppDetailsOverlay are globally available

let lastLoadedPage = 0, isFetching = false, reachedEndOfPages = false; let firstPageDataString = null, currentSearchTerm = '', scrollDebounceTimer = null, searchDebounceTimer = null; const SCROLL_DEBOUNCE_MS = 150, SEARCH_DEBOUNCE_MS = 300;

function createBookListElement(books, pageNumber) {
    const pageContainer = document.createElement('div'); pageContainer.className = 'page-content-block'; pageContainer.dataset.page = pageNumber;
    if (pageNumber > 1) { const sep = document.createElement('hr'); sep.className = 'page-separator'; sep.dataset.pageNumber = `Page ${pageNumber}`; pageContainer.appendChild(sep); }
    if (!books || books.length === 0) { pageContainer.innerHTML += `<p class="info-message" style="text-align: center;">${pageNumber === 1 ? 'No books found for this view.' : 'No more books found.'}</p>`; return pageContainer; }

    const list = document.createElement('ul'); list.className = 'book-list';
    const svgIconHtml = window.AppRuntime?.uiConfig?.icons?.bookViewLink?.value || ''; // Get SVG from config

    books.forEach((book, index) => {
        if (!book || typeof book !== 'object') { console.warn(`[Book List] Skipping invalid book data at index ${index}, page ${pageNumber}:`, book); return; }
        const item = document.createElement('li'); item.className = 'book-item'; item.draggable = true;
        const bookLink = book.link || `no-link-${Date.now()}-${index}`; const bookTitle = book.title || 'Unknown Title';
        item.dataset.bookLink = bookLink; item.dataset.bookTitle = bookTitle;
        try { item.dataset.bookData = JSON.stringify({ link: book.link, title: book.title, current_price: book.current_price, old_price: book.old_price, voucher_price: book.voucher_price, voucher_code: book.voucher_code, local_image_filename: book.local_image_filename }); } catch (e) { console.error(`[Book List] Failed to stringify book data for ${bookTitle}:`, e); item.dataset.bookData = '{}'; }

        const imgSrc = book.local_image_filename ? `localimg://${encodeURIComponent(book.local_image_filename)}` : '';
        const imgAlt = bookTitle ? `Cover for ${bookTitle}` : 'Book Cover';
        const imgHtml = imgSrc ? `<img src="${imgSrc}" alt="${imgAlt}" loading="lazy" style="display: block;" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex'; this.nextElementSibling.textContent='Load Error'; console.error('Failed image: ${book.local_image_filename}')">` : '';
        const placeholderText = !imgSrc ? 'No Image' : '';

        let priceHtml = '';
        if (book.current_price) priceHtml += `<span class="book-price">${book.current_price}</span>`;
        if (book.old_price) priceHtml += `<span class="book-old-price">${book.old_price}</span>`;
        if (book.voucher_price) { const voucherBox = `<div class="voucher-price-box"><span class="book-voucher-price">${book.voucher_price}</span></div>`; const voucherCode = book.voucher_code ? `<span class="voucher-code-text">${book.voucher_code}</span>` : ''; priceHtml += `<div class="voucher-info">${voucherBox}${voucherCode}</div>`; }
        if (!priceHtml) priceHtml = `<span class="book-no-price"></span>`;

        const linkIconHtml = book.link && svgIconHtml ? `<a href="${book.link}" target="_blank" rel="noopener noreferrer" class="book-view-icon" title="View on website (opens browser)\n${book.link}">${svgIconHtml}</a>` : '';

        item.innerHTML = `<div class="book-image">${imgHtml}<span class="placeholder-text" style="display: ${placeholderText ? 'flex' : 'none'};">${placeholderText}</span></div><div class="book-details"><div class="book-title" title="${bookTitle}">${bookTitle}</div><div class="book-meta">${linkIconHtml}<div class="book-meta-prices">${priceHtml}</div></div></div>`;
        item.addEventListener('dragstart', handleBookDragStart); item.addEventListener('dragend', handleBookDragEnd); item.addEventListener('mouseenter', handleBookMouseEnter); item.addEventListener('mouseleave', handleBookMouseLeave); item.addEventListener('click', (e) => { if (!e.target.closest('a.book-view-icon')) handleBookClick(e); });
        list.appendChild(item);
    });
    pageContainer.appendChild(list); return pageContainer;
}
function handleBookDragStart(event) { try { const bookDataJson = event.currentTarget.dataset.bookData; if (!bookDataJson || bookDataJson === '{}') { console.warn("[Book List] Drag start: Missing or empty book data."); event.preventDefault(); return; } const bookData = JSON.parse(bookDataJson); event.dataTransfer.setData('application/json', bookDataJson); event.dataTransfer.setData('text/plain', bookData.link || bookData.title || 'Book Item'); event.dataTransfer.effectAllowed = 'copy'; event.currentTarget.classList.add('dragging'); if(window.AppTrackerUI?.setDraggedItemInfo) window.AppTrackerUI.setDraggedItemInfo({ type: 'book', data: bookData, link: bookData.link, sourceCategoryIndex: null }); } catch (err) { console.error("[Book List] Error during drag start:", err); event.preventDefault(); } }
function handleBookDragEnd(event) { event.currentTarget.classList.remove('dragging'); if(window.AppTrackerUI?.clearDraggedItemInfo) window.AppTrackerUI.clearDraggedItemInfo(); }
function handleBookMouseEnter(event) { event.currentTarget.classList.add('is-hovered'); const prev = event.currentTarget.previousElementSibling, next = event.currentTarget.nextElementSibling; if (prev?.classList.contains('book-item')) prev.classList.add('shrink-neighbor'); if (next?.classList.contains('book-item')) next.classList.add('shrink-neighbor'); }
function handleBookMouseLeave(event) { event.currentTarget.classList.remove('is-hovered'); const prev = event.currentTarget.previousElementSibling, next = event.currentTarget.nextElementSibling; if(prev) prev.classList.remove('shrink-neighbor'); if(next) next.classList.remove('shrink-neighbor'); }
function handleBookClick(event) { try { const bookDataJson = event.currentTarget.dataset.bookData; if (!bookDataJson || bookDataJson === '{}') { console.warn("[Book List] Click: Missing or empty book data."); alert("Details are currently unavailable for this item."); return; } const bookData = JSON.parse(bookDataJson); if(window.AppDetailsOverlay?.showDetailsOverlay) window.AppDetailsOverlay.showDetailsOverlay(bookData); else { console.error("[Book List] AppDetailsOverlay.showDetailsOverlay is not available."); alert("Could not display book details function."); } } catch(err) { console.error("[Book List] Error handling book click:", err); alert("An error occurred while trying to show book details."); } }
function addOrUpdateQueryParam(urlStr, paramName, paramValue) { if (!urlStr) { console.error("[URL Util] Base URL string is empty."); return null; } try { const parsedUrl = new URL(urlStr); parsedUrl.searchParams.set(paramName, paramValue.toString()); return parsedUrl.toString(); } catch (e) { console.error(`[URL Util] Error manipulating URL '${urlStr}': ${e}`); return urlStr; } }
async function fetchAndAppendPageData(pageNumber) {
    if (isFetching || reachedEndOfPages) return; isFetching = true;
    if(window.scrollLoader) window.scrollLoader.style.display = 'flex';
    if(window.endOfContentMessage) window.endOfContentMessage.style.display = 'none';
    if(window.statusBar) window.statusBar.textContent = `Fetching page ${pageNumber}...`;
    if (pageNumber === 1 && window.initialLoader) window.initialLoader.style.display = 'none';
    try {
        const webviewId = window.AppRuntime?.primaryWebviewId; const baseListUrl = window.AppRuntime?.primaryWebviewBaseListUrl;
        if (!webviewId || !baseListUrl) throw new Error("Primary webview ID or Base List URL not configured.");
        const targetUrl = addOrUpdateQueryParam(baseListUrl, 'page', pageNumber); if (!targetUrl) throw new Error("Failed to construct target URL.");
        console.log(`[Book List] Requesting page ${pageNumber} via IPC for WV:${webviewId}, URL:${targetUrl}`);
        const result = await window.electronAPI.fetchListData(webviewId, targetUrl);
        if (!result.success) throw new Error(result.error || `IPC fetchListData failed for page ${pageNumber}`);
        const fetchedBooks = result.data; const fetchedCount = fetchedBooks?.length || 0;
        console.log(`[Book List] Page ${pageNumber} received ${fetchedCount} items via IPC.`);
        if ((fetchedCount === 0 && pageNumber > 1) || (fetchedCount === 0 && pageNumber === 1)) { console.log(`[Book List] End detected: 0 items received on page ${pageNumber}.`); reachedEndOfPages = true; }
        else if (fetchedCount > 0) { const currentPageDataString = JSON.stringify(fetchedBooks); if (pageNumber === 1) firstPageDataString = currentPageDataString; else if (firstPageDataString !== null && currentPageDataString === firstPageDataString) { console.log(`[Book List] End detected: Page ${pageNumber} content matches page 1.`); reachedEndOfPages = true; } }
        if (!reachedEndOfPages && fetchedCount > 0) { const listElement = createBookListElement(fetchedBooks, pageNumber); if(window.tabContentContainer) window.tabContentContainer.appendChild(listElement); lastLoadedPage = pageNumber; filterBooks(); if(window.AppTrackerUI?.applyTrackerColorsToBookList) window.AppTrackerUI.applyTrackerColorsToBookList(); }
        if(reachedEndOfPages) { if(window.endOfContentMessage) window.endOfContentMessage.style.display = 'block'; if(window.statusBar) window.statusBar.textContent = `All pages loaded. ${lastLoadedPage} pages total.`; }
        else if (fetchedCount > 0) { if(window.statusBar) window.statusBar.textContent = `Page ${pageNumber} loaded (${fetchedCount} items). Scroll for more.`; }
        else { if(window.statusBar) window.statusBar.textContent = `No books found.`; }
    } catch (error) {
        console.error(`[Book List] Error fetching or processing page ${pageNumber}:`, error); if(window.statusBar) window.statusBar.textContent = `Error loading page ${pageNumber}!`;
        if(window.endOfContentMessage) { window.endOfContentMessage.textContent = `Error loading page ${pageNumber}. Scroll down to retry?`; window.endOfContentMessage.style.display = 'block'; window.endOfContentMessage.classList.add('error-message'); }
    } finally { isFetching = false; if(window.scrollLoader) window.scrollLoader.style.display = 'none'; }
}
function handleScroll() { if (!window.contentScrollContainer) return; clearTimeout(scrollDebounceTimer); scrollDebounceTimer = setTimeout(() => { if (isFetching || reachedEndOfPages) return; const { scrollTop, scrollHeight, clientHeight } = window.contentScrollContainer; if (scrollHeight - scrollTop <= clientHeight + 450) { console.log("[Book List] Scroll threshold reached, fetching next page..."); if(window.endOfContentMessage?.classList.contains('error-message')) { window.endOfContentMessage.style.display='none'; window.endOfContentMessage.classList.remove('error-message'); window.endOfContentMessage.textContent='no more books here'; } fetchAndAppendPageData(lastLoadedPage + 1); } }, SCROLL_DEBOUNCE_MS); }
function filterBooks() { const term = currentSearchTerm.toLowerCase().trim(); if (!window.tabContentContainer) return; const items = window.tabContentContainer.querySelectorAll('.book-item'); items.forEach(item => { const title = (item.dataset.bookTitle || '').toLowerCase(); item.classList.toggle('hidden-by-search', !(term === '' || title.includes(term))); }); }
function handleSearchInput(event) { currentSearchTerm = event.target.value; clearTimeout(searchDebounceTimer); searchDebounceTimer = setTimeout(filterBooks, SEARCH_DEBOUNCE_MS); }
function setupBookListEventListeners() { if (!window.contentScrollContainer || !window.bookSearchInput) { console.error("[Book List] Cannot setup listeners - essential elements missing."); return; } window.contentScrollContainer.addEventListener('scroll', handleScroll); window.bookSearchInput.addEventListener('input', handleSearchInput); window.bookSearchInput.addEventListener('search', handleSearchInput); console.log("[Book List] Event listeners setup (scroll, search)."); }
async function initializeBookListManager() {
    console.log("[Book List] Initializing Book List Manager..."); setupBookListEventListeners();
    lastLoadedPage = 0; isFetching = false; reachedEndOfPages = false; firstPageDataString = null; currentSearchTerm = '';
    if (window.bookSearchInput) window.bookSearchInput.value = ''; if (window.tabContentContainer) window.tabContentContainer.innerHTML = '';
    if (window.initialLoader) window.initialLoader.style.display = 'flex'; if (window.endOfContentMessage) window.endOfContentMessage.style.display = 'none'; if (window.scrollLoader) window.scrollLoader.style.display = 'none';
    await fetchAndAppendPageData(1); if(window.initialLoader) window.initialLoader.style.display = 'none';
    if(reachedEndOfPages && window.endOfContentMessage) window.endOfContentMessage.style.display = 'block'; filterBooks();
    if(window.AppTrackerUI?.applyTrackerColorsToBookList) window.AppTrackerUI.applyTrackerColorsToBookList(); console.log("[Book List] Initialization complete.");
}
window.AppBookListManager = { initialize: initializeBookListManager, filterBooks };
console.log("[Book List Manager] Module loaded and ready.");
