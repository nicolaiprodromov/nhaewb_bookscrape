// src/renderer/logic/details-overlay.js
// Assumes Chart.js and date-fns adapter are loaded globally, AppUIUtils available

let isFetchingSpecs = false; let currentDetailLink = null; let currentChartInstance = null;

async function fetchBookSpecsIfNeeded(bookLink, bookTitle = 'book') {
    const cache = window.AppTrackerUI?.bookSpecsCache; if (!cache) { console.error("[Details Overlay] Book specs cache not found!"); return { fetchError: "Internal error: Specs cache unavailable" }; }
    if (!bookLink || typeof bookLink !== 'string' || !bookLink.startsWith('http')) { console.warn("[Details Overlay] Invalid book link for spec fetch:", bookLink); return null; }
    if (cache.has(bookLink)) { return cache.get(bookLink); }
    if (isFetchingSpecs) { console.warn(`[Details Overlay] Skipping concurrent spec fetch for: ${bookLink}`); return null; }
    console.log(`[Details Overlay] Fetching specs required for: ${bookLink}`); isFetchingSpecs = true; if(window.statusBar) window.statusBar.textContent = `Fetching details for "${bookTitle}"...`;
    try {
        // *** Use the dedicated detail fetcher ID ***
        const webviewId = window.AppRuntime?.primaryDetailFetcherId;
        if (!webviewId) {
            throw new Error("Detail Fetcher webview ID (primaryDetailFetcherId) not configured in AppRuntime.");
        }

        const result = await window.electronAPI.fetchDetailData(webviewId, bookLink);
        if (!result.success) { throw new Error(result.error || `IPC fetchDetailData failed for ${bookLink}`); }
        const fetchedSpecs = result.details || {}; cache.set(bookLink, fetchedSpecs); if(window.statusBar) window.statusBar.textContent = `Details fetched for "${bookTitle}".`;
        return fetchedSpecs;
    } catch (error) { console.error(`[Details Overlay] Error fetching specs for ${bookLink} via IPC:`, error); if(window.statusBar) window.statusBar.textContent = `Error fetching details for "${bookTitle}"!`; const errorData = { fetchError: error.message || 'Unknown fetch error' }; cache.set(bookLink, errorData); return errorData; } finally { isFetchingSpecs = false; setTimeout(() => { const currentStatus = window.statusBar?.textContent || ''; if (currentStatus.includes(`Fetching details for "${bookTitle}"`) || currentStatus.includes(`Error fetching details for "${bookTitle}"`)) { window.statusBar.textContent = "Status idle."; } }, 3000); }
}
function formatBookSpecsHtml(specs) { if (!specs || typeof specs !== 'object') return '<p>No specific details available.</p>'; if (specs.fetchError) return `<p class="error-message">Could not load specifications: ${specs.fetchError}</p>`; const items = [{ label: 'ISBN', value: specs.isbn }, { label: 'Author', value: specs.author, url: specs.authorUrl }, { label: 'Publisher', value: specs.publisher, url: specs.publisherUrl }, { label: 'Year', value: specs.publishYear }, { label: 'Pages', value: specs.pages }, { label: 'Binding', value: specs.binding }, { label: 'Language', value: specs.language }, { label: 'Category', value: specs.category }]; let specHtml = ''; items.forEach(item => { if (item.value) { specHtml += `<p><strong>${item.label}:</strong> ${item.value}`; if (item.url) { specHtml += ` (<a href="${item.url}" target="_blank" rel="noopener noreferrer" title="Visit ${item.label}'s page">link</a>)`; } specHtml += `</p>`; } }); return specHtml || '<p>No specific details found in the provided data.</p>'; }
function formatBookPricingHtml(book) { let pricingHtml = ''; if (book.current_price) { pricingHtml += `<p><strong>Current Price:</strong> <span class="book-price">${book.current_price}</span></p>`; } if (book.old_price) { pricingHtml += `<p><strong>Old Price:</strong> <span class="book-old-price">${book.old_price}</span></p>`; } if (book.voucher_price) { pricingHtml += `<p><strong>Voucher Price:</strong> <span class="book-voucher-price">${book.voucher_price}</span>`; if (book.voucher_code) { pricingHtml += ` (Code: <span class="voucher-code-text">${book.voucher_code}</span>)`; } pricingHtml += `</p>`; } if (!pricingHtml) { pricingHtml = '<p>No pricing information available.</p>'; } return pricingHtml; }
function parsePrice(priceString) { if (typeof priceString !== 'string' || !priceString) return null; try { const cleaned = priceString.replace(/lei|ron|\s/gi, '').replace(',', '.'); const value = parseFloat(cleaned); return isNaN(value) ? null : value; } catch (e) { console.warn(`[Details Overlay] Error parsing price string "${priceString}":`, e); return null; } }
function renderPriceChart(priceHistory, canvasId) {
    const canvas = document.getElementById(canvasId); if (!canvas) { console.error(`[Details Overlay] Chart canvas #${canvasId} not found.`); return; }
    const ctx = canvas.getContext('2d'); if (currentChartInstance) { currentChartInstance.destroy(); currentChartInstance = null; }
    if (!Array.isArray(priceHistory) || priceHistory.length === 0) {
        canvas.style.display = 'none'; const container = document.getElementById('details-chart-container');
        if (container && !container.querySelector('.no-chart-data')) { const p = document.createElement('p'); p.className = 'info-message no-chart-data'; p.textContent = 'No price history recorded yet.'; p.style.textAlign = 'center'; container.appendChild(p); } return;
    } else { canvas.style.display = 'block'; const existingMsg = document.querySelector('#details-chart-container .no-chart-data'); if (existingMsg) existingMsg.remove(); }
    const labels = priceHistory.map(entry => entry.timestamp); const currentPriceData = priceHistory.map(entry => parsePrice(entry.currentPrice)); const oldPriceData = priceHistory.map(entry => parsePrice(entry.oldPrice)); const voucherPriceData = priceHistory.map(entry => parsePrice(entry.voucherPrice)); const datasets = [];
    if (currentPriceData.some(p => p !== null)) datasets.push({ label: 'Current Price', data: currentPriceData, borderColor: 'rgb(75, 192, 192)', tension: 0.1, fill: false, spanGaps: true });
    if (oldPriceData.some(p => p !== null)) datasets.push({ label: 'Old Price', data: oldPriceData, borderColor: 'rgb(255, 99, 132)', tension: 0.1, fill: false, spanGaps: true, borderDash: [5, 5] });
    if (voucherPriceData.some(p => p !== null)) datasets.push({ label: 'Voucher Price', data: voucherPriceData, borderColor: 'rgb(255, 205, 86)', tension: 0.1, fill: false, spanGaps: true });
    currentChartInstance = new Chart(ctx, { type: 'line', data: { labels: labels, datasets: datasets }, options: { responsive: true, maintainAspectRatio: false, scales: { x: { type: 'time', time: { unit: 'day', tooltipFormat: 'PPpp', displayFormats: { day: 'PP' } }, title: { display: true, text: 'Date' }, ticks: { color: 'var(--text-secondary)' }, grid: { color: 'var(--border-color)' } }, y: { beginAtZero: false, title: { display: true, text: 'Price (lei)' }, ticks: { color: 'var(--text-secondary)', callback: (value) => `${value.toFixed(2)} lei` }, grid: { color: 'var(--border-color)' } } }, plugins: { legend: { position: 'top', labels: { color: 'var(--text-primary)' } }, tooltip: { mode: 'index', intersect: false, callbacks: { label: (context) => `${context.dataset.label}: ${context.parsed.y.toFixed(2)} lei` } } }, interaction: { mode: 'nearest', axis: 'x', intersect: false } } }); console.log("[Details Overlay] Price chart rendered.");
}
function updatePriceChart(newPriceHistory) {
    if (!currentChartInstance) { console.warn("[Details Overlay] Cannot update chart: No chart instance exists."); renderPriceChart(newPriceHistory, 'price-history-chart'); return; }
    if (!Array.isArray(newPriceHistory)) { console.warn("[Details Overlay] Cannot update chart: Invalid newPriceHistory provided."); return; }
    console.log("[Details Overlay] Updating chart with new price history."); currentChartInstance.data.labels = newPriceHistory.map(entry => entry.timestamp);
    const datasetsMap = { 'Current Price': newPriceHistory.map(entry => parsePrice(entry.currentPrice)), 'Old Price': newPriceHistory.map(entry => parsePrice(entry.oldPrice)), 'Voucher Price': newPriceHistory.map(entry => parsePrice(entry.voucherPrice)) };
    currentChartInstance.data.datasets.forEach(dataset => { if (datasetsMap[dataset.label]) { dataset.data = datasetsMap[dataset.label]; } }); currentChartInstance.update();
}
async function showDetailsOverlay(data) {
    if (!window.detailsOverlay || !window.detailsTitle || !window.detailsBody || !document.getElementById('details-info-section') || !document.getElementById('details-chart-container') || !document.getElementById('details-raw-data-section')) { console.error("[Details Overlay] Cannot show overlay - core elements missing."); return; }
    if (currentChartInstance) { currentChartInstance.destroy(); currentChartInstance = null; } currentDetailLink = null;
    const infoSection = document.getElementById('details-info-section'); const chartContainer = document.getElementById('details-chart-container'); const rawDataSection = document.getElementById('details-raw-data-section'); const canvas = document.getElementById('price-history-chart');
    if (!data || typeof data !== 'object') { console.error("[Details Overlay] Invalid data provided to showDetailsOverlay:", data); window.detailsTitle.textContent = 'Error'; infoSection.innerHTML = '<p class="error-message">Invalid data received for details view.</p>'; chartContainer.style.display = 'none'; rawDataSection.innerHTML = ''; window.detailsOverlay.classList.add('active'); return; }
    let title = 'Details'; if (data.type === 'category') { title = `Stack: ${data.name || 'Unnamed Stack'}`; } else if (data.title) { title = data.title; currentDetailLink = data.link; }
    window.detailsTitle.textContent = title; infoSection.innerHTML = '<div class="loading-indicator lottie-loading-container" style="min-height: 150px;"><p>Loading details...</p></div>'; chartContainer.style.display = 'none'; canvas.style.display = 'none'; rawDataSection.innerHTML = ''; window.detailsOverlay.classList.add('active'); if(window.detailsOverlayContent) window.detailsOverlayContent.scrollTop = 0;
    let infoHtml = '', rawDataHtml = '', priceHistoryData = null;
    try {
        if (data.type === 'category') {
            currentDetailLink = null; infoHtml = `<h3>Books in Stack (${data.books?.length || 0}):</h3>`;
            if (data.books && data.books.length > 0) { infoHtml += '<ul>'; for (const book of data.books) { infoHtml += `<li>${book.title || 'Untitled Book'} ${book.link ? `(<a href="${book.link}" target="_blank" title="View Book">link</a>)`: ''}</li>`; } infoHtml += '</ul>'; } else { infoHtml += '<p>No books currently in this stack.</p>'; }
            rawDataHtml = `<h3>Stack Info:</h3><pre>${JSON.stringify({id: data.id, name: data.name, count: data.books?.length}, null, 2)}</pre>`; chartContainer.style.display = 'none';
        } else {
            const book = data; infoHtml = `<h3>Book Information:</h3>`; infoHtml += `<p><strong>Title:</strong> ${book.title || 'N/A'}</p>`; if (book.link) { infoHtml += `<p><strong>Link:</strong> <a href="${book.link}" target="_blank" rel="noopener noreferrer" title="Visit product page">${book.link}</a></p>`; }
            infoHtml += `<hr class="details-separator"><h3>Current Pricing:</h3>`; infoHtml += formatBookPricingHtml(book); infoHtml += `<hr class="details-separator"><h3>Specifications:</h3>`; infoSection.innerHTML = infoHtml + `<p><i>Fetching specifications...</i></p>`;
            const specs = await fetchBookSpecsIfNeeded(book.link, book.title); infoHtml += formatBookSpecsHtml(specs);
            rawDataHtml += `<h3>Raw Data:</h3>`; rawDataHtml += `<pre>${JSON.stringify(book, (key, value) => key === 'priceHistory' ? `[${value?.length || 0} entries]` : value, 2)}</pre>`; if (specs && !specs.fetchError) { rawDataHtml += `<h4>--- Fetched Specs ---</h4><pre>${JSON.stringify(specs, null, 2)}</pre>`; }
            priceHistoryData = book.priceHistory; chartContainer.style.display = 'block';
        }
        infoSection.innerHTML = infoHtml; rawDataSection.innerHTML = rawDataHtml; if (priceHistoryData) { renderPriceChart(priceHistoryData, 'price-history-chart'); }
        if(window.statusBar) window.statusBar.textContent = "Details loaded.";
    } catch (error) { console.error("[Details Overlay] Error generating content:", error); infoSection.innerHTML = `<p class="error-message">Error displaying details: ${error.message}</p>`; rawDataSection.innerHTML = `<pre>Data: ${JSON.stringify(data, null, 2)}</pre>`; chartContainer.style.display = 'none'; if(window.statusBar) window.statusBar.textContent = "Error loading details!"; }
}
function hideDetailsOverlay() { if (window.detailsOverlay) { window.detailsOverlay.classList.remove('active'); if (currentChartInstance) { currentChartInstance.destroy(); currentChartInstance = null; console.log("[Details Overlay] Chart instance destroyed."); } currentDetailLink = null; } }
function handlePriceUpdateEvent(event) {
    if (!window.detailsOverlay?.classList.contains('active')) return; const { link, bookData, error } = event.detail;
    if (link && link === currentDetailLink) { console.log(`[Details Overlay] Received price update for currently displayed book: ${link}`);
        if (error) { console.warn(`[Details Overlay] Price update for ${link} contained an error: ${error}`); }
        else if (bookData && bookData.priceHistory) { updatePriceChart(bookData.priceHistory);
            const infoSection = document.getElementById('details-info-section'); if (infoSection) { let existingHtml = infoSection.innerHTML; const priceSectionStart = existingHtml.indexOf('<hr class="details-separator"><h3>Current Pricing:</h3>'); const specSectionStart = existingHtml.indexOf('<hr class="details-separator"><h3>Specifications:</h3>'); if (priceSectionStart !== -1 && specSectionStart !== -1) { const beforePrice = existingHtml.substring(0, priceSectionStart); const afterPrice = existingHtml.substring(specSectionStart); infoSection.innerHTML = beforePrice + '<hr class="details-separator"><h3>Current Pricing:</h3>' + formatBookPricingHtml(bookData) + afterPrice; } }
        }
    }
}
function setupDetailsOverlayEventListeners() {
    if (!window.detailsOverlay || !window.detailsCloseBtn || !window.detailsOverlayContent) { console.error("[Details Overlay] Cannot setup listeners - essential overlay elements missing."); return; }
    if (window.AppUIUtils?.applyIcon) window.AppUIUtils.applyIcon(window.detailsCloseBtn, 'detailsClose', 'X');
    window.detailsCloseBtn.addEventListener('click', hideDetailsOverlay);
    window.detailsOverlay.addEventListener('click', (e) => { if (e.target === window.detailsOverlay) { hideDetailsOverlay(); } });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && window.detailsOverlay?.classList.contains('active')) { hideDetailsOverlay(); } });
    document.addEventListener('priceUpdate', handlePriceUpdateEvent); console.log("[Details Overlay] Event listeners setup (including priceUpdate).");
}
window.AppDetailsOverlay = { initialize: setupDetailsOverlayEventListeners, showDetailsOverlay, hideDetailsOverlay };
console.log("[Details Overlay] Module loaded.");
