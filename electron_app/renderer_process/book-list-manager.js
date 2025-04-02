// electron_app/renderer_process/book-list-manager.js

// Assumes necessary DOM elements and electronAPI are globally available
// Requires: AppRuntime (for webviewId, baseListUrl), AppUIUtils, AppTrackerUI, AppDetailsOverlay

// **REMOVED:** No longer need Node's require('url'), use browser's native URL
// const { URL } = require('url');

let lastLoadedPage = 0;
let isFetching = false;
let reachedEndOfPages = false;
let firstPageDataString = null;
let currentSearchTerm = '';
let scrollDebounceTimer = null;
const SCROLL_DEBOUNCE_MS = 100;
let searchDebounceTimer = null;
const SEARCH_DEBOUNCE_MS = 250;

/** Renders book data into a new page container element */
function createBookListElement(books, pageNumber) {
    const pageContainer = document.createElement('div');
    pageContainer.className = 'page-content-block';
    pageContainer.dataset.page = pageNumber;
    if (pageNumber > 1) { const sep=document.createElement('hr'); sep.className='page-separator'; sep.dataset.pageNumber=`Page ${pageNumber}`; pageContainer.appendChild(sep); }
    if (!books || books.length === 0) { const msg=document.createElement('p'); msg.className='info-message'; msg.style.textAlign='center'; msg.textContent=pageNumber===1?'No books found.':'No more books.'; pageContainer.appendChild(msg); return pageContainer; }
    const list = document.createElement('ul'); list.className = 'book-list';
    const svgIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" fill="none" stroke-linecap="round" stroke-linejoin="round"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M11 4h8v8" /><path d="M19 4l-15 15" /></svg>`;
    books.forEach((book, index) => {
        if (!book || typeof book !== 'object') { console.warn(`[Book List] Skipping invalid book data at index ${index}, page ${pageNumber}`); return; }
        const item = document.createElement('li'); item.className = 'book-item'; item.draggable = true;
        item.dataset.bookLink = book.link || `no-link-${Date.now()}-${index}`; item.dataset.bookTitle = book.title || 'Unknown';
        try { item.dataset.bookData = JSON.stringify(book); } catch (e) { console.error("Failed stringify book:", book, e); item.dataset.bookData = '{}'; }
        item.addEventListener('dragstart', handleBookDragStart); item.addEventListener('dragend', handleBookDragEnd); item.addEventListener('mouseenter', handleBookMouseEnter); item.addEventListener('mouseleave', handleBookMouseLeave);
        item.addEventListener('click', (e) => { if (!e.target.closest('a.book-view-icon')) handleBookClick(e); });
        const imgCont = document.createElement('div'); imgCont.className = 'book-image';
        const phText = document.createElement('span'); phText.className = 'placeholder-text'; phText.style.display = 'none';
        if (book.local_image_filename) {
            const imageUrl = `localimg://${encodeURIComponent(book.local_image_filename)}`;
            const img = document.createElement('img'); img.src = imageUrl; img.alt = book.title ? `${book.title}` : 'Cover'; img.loading = 'lazy';
            img.onerror = function() { console.error(`[Book List] Failed load image: "${book.title||'?'}". File: ${book.local_image_filename}`); this.style.display='none'; phText.textContent='Load Error'; phText.style.display='flex'; };
            imgCont.appendChild(img);
        } else { phText.textContent = 'No Image'; phText.style.display = 'flex'; }
        imgCont.appendChild(phText);
        const detDiv = document.createElement('div'); detDiv.className = 'book-details'; detDiv.innerHTML = `<div class="book-title" title="${book.title || ''}">${book.title || 'N/A'}</div>`;
        const metaDiv = document.createElement('div'); metaDiv.className = 'book-meta'; metaDiv.style="display:flex;flex-direction:column;align-items:center;justify-content:start;margin-top:0px;"
        if (book.link) { const lnk=document.createElement('a'); lnk.href=book.link; lnk.target='_blank'; lnk.rel='noopener noreferrer'; lnk.className='book-view-icon'; lnk.title='View Product (opens browser)'; lnk.innerHTML=svgIcon; metaDiv.appendChild(lnk); }
        const pricesVoucherDiv = document.createElement('div'); pricesVoucherDiv.className = 'book-meta-prices';
        const phtml = book.current_price ? `<span class="book-price">${book.current_price}</span>` : ''; const ophtml = book.old_price ? `<span class="book-old-price">${book.old_price}</span>` : '';
        let vhtml = ''; if (book.voucher_price) { const box = `<div class="voucher-price-box"><span class="book-voucher-price">${book.voucher_price}</span></div>`; const code = book.voucher_code ? `<span class="voucher-code-text">${book.voucher_code}</span>` : ''; vhtml = `<div>${box}${code}</div>`; }
        pricesVoucherDiv.innerHTML = `${phtml}${ophtml}${vhtml}`; metaDiv.appendChild(pricesVoucherDiv);
        detDiv.appendChild(metaDiv); item.appendChild(imgCont); item.appendChild(detDiv); list.appendChild(item);
    });
    pageContainer.appendChild(list); return pageContainer;
}
function handleBookDragStart(event) { try { const json = event.currentTarget.dataset.bookData; if (!json) throw new Error("Missing book data"); const data=JSON.parse(json); event.dataTransfer.setData('application/json', json); event.dataTransfer.setData('text/plain', data.link||data.title||'book'); event.dataTransfer.effectAllowed='copy'; event.currentTarget.classList.add('dragging'); if(window.AppTrackerUI?.setDraggedItemInfo) window.AppTrackerUI.setDraggedItemInfo({type:'book', data:data, link:data.link, sourceCategoryIndex:null}); } catch (err) { console.error("[Book List] Error drag start:", err); event.preventDefault(); } }
function handleBookDragEnd(event) { event.currentTarget.classList.remove('dragging'); if(window.AppTrackerUI?.clearDraggedItemInfo) window.AppTrackerUI.clearDraggedItemInfo(); }
function handleBookMouseEnter(event) { event.currentTarget.classList.add('is-hovered'); const prev=event.currentTarget.previousElementSibling, next=event.currentTarget.nextElementSibling; if (prev?.classList.contains('book-item')) prev.classList.add('shrink-neighbor'); if (next?.classList.contains('book-item')) next.classList.add('shrink-neighbor'); }
function handleBookMouseLeave(event) { event.currentTarget.classList.remove('is-hovered'); const prev=event.currentTarget.previousElementSibling, next=event.currentTarget.nextElementSibling; if(prev)prev.classList.remove('shrink-neighbor'); if(next)next.classList.remove('shrink-neighbor'); }
function handleBookClick(event) { try { const data=JSON.parse(event.currentTarget.dataset.bookData||'{}'); if(window.AppDetailsOverlay?.showDetailsOverlay) window.AppDetailsOverlay.showDetailsOverlay(data); else alert("Details unavailable."); } catch(err) { console.error("Error parse book data click:", err); alert("Error loading details."); } }

/** Adds or updates a query parameter in a URL string */
function addOrUpdateQueryParam(urlStr, paramName, paramValue) { try { const parsedUrl = new URL(urlStr); parsedUrl.searchParams.set(paramName, paramValue); return parsedUrl.toString(); } catch (e) { console.error(`Error manipulating URL '${urlStr}': ${e}`); return urlStr; } }

/** Fetch and append page data using IPC */
async function fetchAndAppendPageData(pageNumber) {
    if (isFetching || reachedEndOfPages) return;
    isFetching = true;
    if(window.scrollLoader) window.scrollLoader.style.display = 'flex';
    if(window.endOfContentMessage) window.endOfContentMessage.style.display = 'none';
    if(window.statusBar) window.statusBar.textContent = `Fetching page ${pageNumber}...`;
    if (pageNumber === 1 && window.initialLoader) window.initialLoader.style.display = 'none';

    try {
        const webviewId = window.AppRuntime?.primaryWebviewId;
        const baseListUrl = window.AppRuntime?.primaryWebviewBaseListUrl;
        if (!webviewId || !baseListUrl) throw new Error("Primary webview ID or Base List URL not configured in AppRuntime.");
        const targetUrl = addOrUpdateQueryParam(baseListUrl, 'page', pageNumber);
        console.log(`[Book List] Requesting page ${pageNumber} via IPC for WV:${webviewId}, URL:${targetUrl}`);
        // Call electronAPI
        const result = await window.electronAPI.fetchListData(webviewId, targetUrl);
        if (!result.success) throw new Error(result.error || 'IPC fetchListData failed');

        const fetchedBooks = result.data;
        const fetchedCount = fetchedBooks?.length || 0;
        console.log(`[Book List] Page ${pageNumber} received ${fetchedCount} items via IPC.`);
        if (fetchedCount === 0 && pageNumber > 1) { console.log(`[Book List] End detected: 0 items on page ${pageNumber}.`); reachedEndOfPages = true; }
        else { const str=JSON.stringify(fetchedBooks); if(pageNumber===1) firstPageDataString=str; else if(firstPageDataString!==null && str===firstPageDataString) { console.log(`[Book List] End detected: Page ${pageNumber} matches page 1.`); reachedEndOfPages=true; } }
        if (!reachedEndOfPages && fetchedCount > 0) { const elem=createBookListElement(fetchedBooks, pageNumber); if(window.tabContentContainer) window.tabContentContainer.appendChild(elem); lastLoadedPage = pageNumber; filterBooks(); if(window.AppTrackerUI?.applyTrackerColorsToBookList) window.AppTrackerUI.applyTrackerColorsToBookList(); }
        if(reachedEndOfPages) { if(window.endOfContentMessage) window.endOfContentMessage.style.display='block'; if(window.statusBar) window.statusBar.textContent=`All pages loaded.`; }
        else { if(window.statusBar) window.statusBar.textContent=`Page ${pageNumber} loaded (${fetchedCount} items).`; }
    } catch (error) {
        console.error(`[Book List] Error fetching page ${pageNumber} via IPC:`, error); if(window.statusBar) window.statusBar.textContent=`Error loading page ${pageNumber}!`;
        if(window.endOfContentMessage) { window.endOfContentMessage.textContent=`Error loading page ${pageNumber}. Scroll to retry?`; window.endOfContentMessage.style.display='block'; window.endOfContentMessage.classList.add('error-message'); }
    } finally { isFetching = false; if(window.scrollLoader) window.scrollLoader.style.display = 'none'; }
}

/** Handle Scroll Events */
function handleScroll() { if (!window.contentScrollContainer) return; clearTimeout(scrollDebounceTimer); scrollDebounceTimer = setTimeout(() => { if (isFetching || reachedEndOfPages) return; const { scrollTop, scrollHeight, clientHeight } = window.contentScrollContainer; const threshold = 350; if (scrollHeight - scrollTop <= clientHeight + threshold) { console.log("[Book List] Scroll threshold reached, fetching next..."); if(window.endOfContentMessage) { window.endOfContentMessage.style.display='none'; window.endOfContentMessage.classList.remove('error-message'); window.endOfContentMessage.textContent='no more books here'; } fetchAndAppendPageData(lastLoadedPage + 1); } }, SCROLL_DEBOUNCE_MS); }

/** Filter Books by Search Term */
function filterBooks() { const term = currentSearchTerm.toLowerCase().trim(); if (!window.tabContentContainer) return; const items = window.tabContentContainer.querySelectorAll('.book-item'); let visibleCount = 0; items.forEach(item => { const title = (item.dataset.bookTitle || '').toLowerCase(); const isMatch = term === '' || title.includes(term); if (isMatch) { item.classList.remove('hidden-by-search'); visibleCount++; } else { item.classList.add('hidden-by-search'); } }); }
function handleSearchInput(event) { currentSearchTerm = event.target.value; clearTimeout(searchDebounceTimer); searchDebounceTimer = setTimeout(filterBooks, SEARCH_DEBOUNCE_MS); }

/** Setup Event Listeners */
function setupBookListEventListeners() { if (!window.contentScrollContainer || !window.bookSearchInput) { console.error("[Book List] Cannot setup listeners - elements missing."); return; } window.contentScrollContainer.addEventListener('scroll', handleScroll); window.bookSearchInput.addEventListener('input', handleSearchInput); window.bookSearchInput.addEventListener('search', handleSearchInput); console.log("[Book List] Event listeners setup."); }

window.AppBookListManager = {
    initialize: async () => {
        setupBookListEventListeners(); console.log("[Book List] Initializing - loading page 1...");
        lastLoadedPage=0; isFetching=false; reachedEndOfPages=false; firstPageDataString=null; currentSearchTerm='';
        if(window.bookSearchInput) window.bookSearchInput.value=''; if(window.tabContentContainer) window.tabContentContainer.innerHTML='';
        if(window.initialLoader) window.initialLoader.style.display='flex'; if(window.endOfContentMessage) window.endOfContentMessage.style.display='none';
        await fetchAndAppendPageData(1);
        if(window.initialLoader) window.initialLoader.style.display = 'none';
        if(reachedEndOfPages && window.endOfContentMessage) { console.log("[Book List] End reached on page 1."); window.endOfContentMessage.style.display = 'block'; }
        filterBooks(); if(window.AppTrackerUI?.applyTrackerColorsToBookList) window.AppTrackerUI.applyTrackerColorsToBookList();
    },
    filterBooks, fetchAndAppendPageData
};
console.log("[Book List Manager] Module loaded."); // This should now log successfully
