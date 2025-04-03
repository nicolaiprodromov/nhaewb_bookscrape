// src/renderer/logic/details-overlay.js
// Assumes Chart.js and date-fns adapter are loaded globally

// ... (keep existing imports/assumptions) ...

let isFetchingSpecs = false;
let currentDetailLink = null; // Track the link of the book currently shown
let currentChartInstance = null; // Hold the Chart.js instance

/** Fetches book specifications if needed (no changes needed here) */
async function fetchBookSpecsIfNeeded(bookLink, bookTitle = 'book') {
    const cache = window.AppTrackerUI?.bookSpecsCache; if (!cache) { console.error("[Details Overlay] Book specs cache not found!"); return { fetchError: "Internal error: Specs cache unavailable" }; }
    if (!bookLink || typeof bookLink !== 'string' || !bookLink.startsWith('http')) { console.warn("[Details Overlay] Invalid book link for spec fetch:", bookLink); return null; }
    if (cache.has(bookLink)) { return cache.get(bookLink); }
    if (isFetchingSpecs) { console.warn(`[Details Overlay] Skipping concurrent spec fetch for: ${bookLink}`); return null; }
    console.log(`[Details Overlay] Fetching specs required for: ${bookLink}`); isFetchingSpecs = true; if(window.statusBar) window.statusBar.textContent = `Fetching details for "${bookTitle}"...`;
    try {
        const webviewId = window.AppRuntime?.primaryWebviewId; if (!webviewId) { throw new Error("Primary webview ID not configured."); }
        const result = await window.electronAPI.fetchDetailData(webviewId, bookLink);
        if (!result.success) { throw new Error(result.error || `IPC fetchDetailData failed for ${bookLink}`); }
        const fetchedSpecs = result.details || {}; const fetchedPrices = result.prices || {};
        console.log(`[Details Overlay] Specs received via IPC for ${bookLink}:`, fetchedSpecs);
        cache.set(bookLink, fetchedSpecs);
        if(window.statusBar) window.statusBar.textContent = `Details fetched for "${bookTitle}".`;
        return fetchedSpecs;
    } catch (error) {
        console.error(`[Details Overlay] Error fetching specs for ${bookLink} via IPC:`, error); if(window.statusBar) window.statusBar.textContent = `Error fetching details for "${bookTitle}"!`;
        const errorData = { fetchError: error.message || 'Unknown fetch error' }; cache.set(bookLink, errorData); return errorData;
    } finally {
        isFetchingSpecs = false;
        setTimeout(() => { const currentStatus = window.statusBar?.textContent || ''; if (currentStatus.includes(`Fetching details for "${bookTitle}"`) || currentStatus.includes(`Error fetching details for "${bookTitle}"`)) { window.statusBar.textContent = "Status idle."; } }, 3000);
    }
}

/** Formats book specification details into HTML string (no changes needed here) */
function formatBookSpecsHtml(specs) {
    if (!specs || typeof specs !== 'object') return '<p>No specific details available.</p>';
    if (specs.fetchError) return `<p class="error-message">Could not load specifications: ${specs.fetchError}</p>`;
    const items = [
        { label: 'ISBN', value: specs.isbn }, { label: 'Author', value: specs.author, url: specs.authorUrl },
        { label: 'Publisher', value: specs.publisher, url: specs.publisherUrl }, { label: 'Year', value: specs.publishYear },
        { label: 'Pages', value: specs.pages }, { label: 'Binding', value: specs.binding },
        { label: 'Language', value: specs.language }, { label: 'Category', value: specs.category }
    ];
    let specHtml = '';
    items.forEach(item => {
        if (item.value) {
            specHtml += `<p><strong>${item.label}:</strong> ${item.value}`;
            if (item.url) { specHtml += ` (<a href="${item.url}" target="_blank" rel="noopener noreferrer" title="Visit ${item.label}'s page">link</a>)`; }
            specHtml += `</p>`;
        }
    });
    return specHtml || '<p>No specific details found in the provided data.</p>';
}

/** Formats book pricing details into HTML string (no changes needed here) */
function formatBookPricingHtml(book) {
     let pricingHtml = '';
     if (book.current_price) { pricingHtml += `<p><strong>Current Price:</strong> <span class="book-price">${book.current_price}</span></p>`; }
     if (book.old_price) { pricingHtml += `<p><strong>Old Price:</strong> <span class="book-old-price">${book.old_price}</span></p>`; }
     if (book.voucher_price) {
         pricingHtml += `<p><strong>Voucher Price:</strong> <span class="book-voucher-price">${book.voucher_price}</span>`;
         if (book.voucher_code) { pricingHtml += ` (Code: <span class="voucher-code-text">${book.voucher_code}</span>)`; }
         pricingHtml += `</p>`;
     }
     if (!pricingHtml) { pricingHtml = '<p>No pricing information available.</p>'; }
     return pricingHtml;
}

/** Helper to extract numeric value from price string (e.g., "149,99 lei" -> 149.99) */
function parsePrice(priceString) {
    if (typeof priceString !== 'string' || !priceString) return null;
    try {
        // Remove currency, spaces, replace comma with dot
        const cleaned = priceString.replace(/lei|ron|\s/gi, '').replace(',', '.');
        const value = parseFloat(cleaned);
        return isNaN(value) ? null : value;
    } catch (e) {
        console.warn(`[Details Overlay] Error parsing price string "${priceString}":`, e);
        return null;
    }
}

/** Renders the price history chart */
function renderPriceChart(priceHistory, canvasId) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) { console.error(`[Details Overlay] Chart canvas #${canvasId} not found.`); return; }
    const ctx = canvas.getContext('2d');

    // Destroy previous chart instance if it exists
    if (currentChartInstance) {
        currentChartInstance.destroy();
        currentChartInstance = null;
    }

    if (!Array.isArray(priceHistory) || priceHistory.length === 0) {
        canvas.style.display = 'none'; // Hide canvas if no data
        // Optionally display a message
        const container = document.getElementById('details-chart-container');
        if (container && !container.querySelector('.no-chart-data')) {
            const p = document.createElement('p');
            p.className = 'info-message no-chart-data';
            p.textContent = 'No price history recorded yet.';
            p.style.textAlign = 'center';
            container.appendChild(p);
        }
        return;
    } else {
        canvas.style.display = 'block'; // Show canvas if data exists
        const existingMsg = document.querySelector('#details-chart-container .no-chart-data');
        if (existingMsg) existingMsg.remove();
    }

    // Prepare data for Chart.js
    const labels = priceHistory.map(entry => entry.timestamp); // Use timestamps directly
    const currentPriceData = priceHistory.map(entry => parsePrice(entry.currentPrice));
    const oldPriceData = priceHistory.map(entry => parsePrice(entry.oldPrice));
    const voucherPriceData = priceHistory.map(entry => parsePrice(entry.voucherPrice));

    // Filter out datasets with no valid points
    const datasets = [];
    if (currentPriceData.some(p => p !== null)) datasets.push({
        label: 'Current Price', data: currentPriceData, borderColor: 'rgb(75, 192, 192)', tension: 0.1, fill: false, spanGaps: true
    });
    if (oldPriceData.some(p => p !== null)) datasets.push({
        label: 'Old Price', data: oldPriceData, borderColor: 'rgb(255, 99, 132)', tension: 0.1, fill: false, spanGaps: true, borderDash: [5, 5] // Dashed line
    });
    if (voucherPriceData.some(p => p !== null)) datasets.push({
        label: 'Voucher Price', data: voucherPriceData, borderColor: 'rgb(255, 205, 86)', tension: 0.1, fill: false, spanGaps: true
    });

    currentChartInstance = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels, // Timestamps
            datasets: datasets
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                x: {
                    type: 'time', // Use time scale
                    time: { unit: 'day', tooltipFormat: 'PPpp', displayFormats: { day: 'PP' } }, // Date-fns formats
                    title: { display: true, text: 'Date' },
                     ticks: { color: 'var(--text-secondary)' }, grid: { color: 'var(--border-color)' }
                },
                y: {
                    beginAtZero: false, // Don't force y-axis to start at 0
                    title: { display: true, text: 'Price (lei)' },
                    ticks: { color: 'var(--text-secondary)', callback: (value) => `${value.toFixed(2)} lei` }, // Format ticks
                    grid: { color: 'var(--border-color)' }
                }
            },
            plugins: {
                legend: { position: 'top', labels: { color: 'var(--text-primary)' } },
                tooltip: { mode: 'index', intersect: false, callbacks: { label: (context) => `${context.dataset.label}: ${context.parsed.y.toFixed(2)} lei` } } // Format tooltip
            },
            interaction: { mode: 'nearest', axis: 'x', intersect: false }
        }
    });
     console.log("[Details Overlay] Price chart rendered.");
}


/** Updates the existing chart with new data */
function updatePriceChart(newPriceHistory) {
    if (!currentChartInstance) {
        console.warn("[Details Overlay] Cannot update chart: No chart instance exists.");
        // Attempt to re-render if canvas exists
        renderPriceChart(newPriceHistory, 'price-history-chart');
        return;
    }
    if (!Array.isArray(newPriceHistory)) {
        console.warn("[Details Overlay] Cannot update chart: Invalid newPriceHistory provided.");
        return;
    }

    console.log("[Details Overlay] Updating chart with new price history.");

    // Update labels and data for each dataset
    currentChartInstance.data.labels = newPriceHistory.map(entry => entry.timestamp);

    const datasetsMap = {
        'Current Price': newPriceHistory.map(entry => parsePrice(entry.currentPrice)),
        'Old Price': newPriceHistory.map(entry => parsePrice(entry.oldPrice)),
        'Voucher Price': newPriceHistory.map(entry => parsePrice(entry.voucherPrice))
    };

    currentChartInstance.data.datasets.forEach(dataset => {
        if (datasetsMap[dataset.label]) {
            dataset.data = datasetsMap[dataset.label];
        }
    });

    currentChartInstance.update(); // Update the chart display
}

/**
 * Shows the details overlay populated with book or category data.
 * Fetches specs dynamically if showing book details.
 */
async function showDetailsOverlay(data) {
    // Ensure overlay elements exist
    if (!window.detailsOverlay || !window.detailsTitle || !window.detailsBody ||
        !document.getElementById('details-info-section') ||
        !document.getElementById('details-chart-container') ||
        !document.getElementById('details-raw-data-section')) {
        console.error("[Details Overlay] Cannot show overlay - core elements missing.");
        return;
    }

    // Clear previous chart instance when showing new details
    if (currentChartInstance) {
        currentChartInstance.destroy();
        currentChartInstance = null;
    }
    currentDetailLink = null; // Reset current link

    // Get references to the sections
    const infoSection = document.getElementById('details-info-section');
    const chartContainer = document.getElementById('details-chart-container');
    const rawDataSection = document.getElementById('details-raw-data-section');
    const canvas = document.getElementById('price-history-chart');

    if (!data || typeof data !== 'object') {
        console.error("[Details Overlay] Invalid data provided to showDetailsOverlay:", data);
        window.detailsTitle.textContent = 'Error';
        infoSection.innerHTML = '<p class="error-message">Invalid data received for details view.</p>';
        chartContainer.style.display = 'none'; // Hide chart section
        rawDataSection.innerHTML = ''; // Clear raw data section
        window.detailsOverlay.classList.add('active');
        return;
    }

    // Determine title and set current link for books
    let title = 'Details';
    if (data.type === 'category') {
        title = `Stack: ${data.name || 'Unnamed Stack'}`;
    } else if (data.title) {
        title = data.title; // Assume book
        currentDetailLink = data.link; // Store the link for price updates
    }

    window.detailsTitle.textContent = title;
    // Show loading indicator immediately only in the info section
    infoSection.innerHTML = '<div class="loading-indicator lottie-loading-container" style="min-height: 150px;"><p>Loading details...</p></div>';
    chartContainer.style.display = 'none'; // Hide chart initially
    canvas.style.display = 'none'; // Ensure canvas is hidden
    rawDataSection.innerHTML = ''; // Clear raw data
    window.detailsOverlay.classList.add('active');
    if(window.detailsOverlayContent) window.detailsOverlayContent.scrollTop = 0;

    let infoHtml = '';
    let rawDataHtml = '';
    let priceHistoryData = null; // To hold price history for the chart

    try {
        // --- Category Details ---
        if (data.type === 'category') {
            currentDetailLink = null; // No specific book link for categories
            infoHtml = `<h3>Books in Stack (${data.books?.length || 0}):</h3>`;
            if (data.books && data.books.length > 0) {
                infoHtml += '<ul>';
                // Fetch specs sequentially only if needed for display here
                for (const book of data.books) {
                    infoHtml += `<li>${book.title || 'Untitled Book'} ${book.link ? `(<a href="${book.link}" target="_blank" title="View Book">link</a>)`: ''}</li>`;
                    // Don't fetch specs here unless necessary for category view
                }
                infoHtml += '</ul>';
            } else {
                infoHtml += '<p>No books currently in this stack.</p>';
            }
            rawDataHtml = `<h3>Stack Info:</h3><pre>${JSON.stringify({id: data.id, name: data.name, count: data.books?.length}, null, 2)}</pre>`;
            chartContainer.style.display = 'none'; // No chart for categories

        // --- Book Details ---
        } else { // Assume book
            const book = data;
            infoHtml = `<h3>Book Information:</h3>`;
            infoHtml += `<p><strong>Title:</strong> ${book.title || 'N/A'}</p>`;
            if (book.link) { infoHtml += `<p><strong>Link:</strong> <a href="${book.link}" target="_blank" rel="noopener noreferrer" title="Visit product page">${book.link}</a></p>`; }

            // Pricing Section
            infoHtml += `<hr class="details-separator"><h3>Current Pricing:</h3>`;
            infoHtml += formatBookPricingHtml(book);

            // Specifications Section (Fetch required)
            infoHtml += `<hr class="details-separator"><h3>Specifications:</h3>`;
            // Show temporary fetching message for specs
            infoSection.innerHTML = infoHtml + `<p><i>Fetching specifications...</i></p>`; // Update intermediate UI

            const specs = await fetchBookSpecsIfNeeded(book.link, book.title);
            infoHtml += formatBookSpecsHtml(specs); // Add formatted specs

            // Raw Data Section
            rawDataHtml += `<h3>Raw Data:</h3>`;
            rawDataHtml += `<pre>${JSON.stringify(book, (key, value) => key === 'priceHistory' ? `[${value?.length || 0} entries]` : value, 2)}</pre>`; // Show history length only initially
            if (specs && !specs.fetchError) { rawDataHtml += `<h4>--- Fetched Specs ---</h4><pre>${JSON.stringify(specs, null, 2)}</pre>`; }

            // Price History Data for Chart
            priceHistoryData = book.priceHistory; // Get history from the passed data
            chartContainer.style.display = 'block'; // Show chart section for books
        }

        // Update the details body sections with final generated HTML
        infoSection.innerHTML = infoHtml;
        rawDataSection.innerHTML = rawDataHtml;

        // Render chart if data is available
        if (priceHistoryData) {
            renderPriceChart(priceHistoryData, 'price-history-chart');
        }

        if(window.statusBar) window.statusBar.textContent = "Details loaded.";

    } catch (error) {
        console.error("[Details Overlay] Error generating content:", error);
        infoSection.innerHTML = `<p class="error-message">Error displaying details: ${error.message}</p>`;
        rawDataSection.innerHTML = `<pre>Data: ${JSON.stringify(data, null, 2)}</pre>`;
        chartContainer.style.display = 'none'; // Hide chart on error
        if(window.statusBar) window.statusBar.textContent = "Error loading details!";
    }
}


/** Hides the details overlay */
function hideDetailsOverlay() {
    if (window.detailsOverlay) {
        window.detailsOverlay.classList.remove('active');
        // Destroy chart instance when hiding
        if (currentChartInstance) {
            currentChartInstance.destroy();
            currentChartInstance = null;
            console.log("[Details Overlay] Chart instance destroyed.");
        }
        currentDetailLink = null; // Clear current link
    }
}

/** Handles the priceUpdate custom event */
function handlePriceUpdateEvent(event) {
    if (!window.detailsOverlay?.classList.contains('active')) return; // Only update if overlay is active

    const { link, bookData, error } = event.detail;

    // Check if the update is for the currently displayed book
    if (link && link === currentDetailLink) {
        console.log(`[Details Overlay] Received price update for currently displayed book: ${link}`);
        if (error) {
             console.warn(`[Details Overlay] Price update for ${link} contained an error: ${error}`);
             // Optionally display error near the chart?
        } else if (bookData && bookData.priceHistory) {
            // Update the chart with the new history
            updatePriceChart(bookData.priceHistory);
             // Optionally update the pricing info section as well
             const infoSection = document.getElementById('details-info-section');
             if (infoSection) {
                 // Find and replace the pricing part (or re-render info section)
                 // This is a bit crude, might need more robust update logic
                 let existingHtml = infoSection.innerHTML;
                 const priceSectionStart = existingHtml.indexOf('<hr class="details-separator"><h3>Current Pricing:</h3>');
                 const specSectionStart = existingHtml.indexOf('<hr class="details-separator"><h3>Specifications:</h3>');
                 if (priceSectionStart !== -1 && specSectionStart !== -1) {
                     const beforePrice = existingHtml.substring(0, priceSectionStart);
                     const afterPrice = existingHtml.substring(specSectionStart);
                     infoSection.innerHTML = beforePrice +
                                             '<hr class="details-separator"><h3>Current Pricing:</h3>' +
                                             formatBookPricingHtml(bookData) + // Update with new data
                                             afterPrice;
                 } else { // Fallback: Re-render potentially losing spec fetch status
                    // infoSection.innerHTML = ... re-render based on bookData ...
                 }
             }
        }
    }
}


/** Sets up event listeners for the details overlay */
function setupDetailsOverlayEventListeners() {
    if (!window.detailsOverlay || !window.detailsCloseBtn || !window.detailsOverlayContent) {
        console.error("[Details Overlay] Cannot setup listeners - essential overlay elements missing.");
        return;
    }
    window.detailsCloseBtn.addEventListener('click', hideDetailsOverlay);
    window.detailsOverlay.addEventListener('click', (e) => { if (e.target === window.detailsOverlay) { hideDetailsOverlay(); } });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && window.detailsOverlay?.classList.contains('active')) { hideDetailsOverlay(); } });

    // Listen for price updates dispatched by tracker-ui
    document.addEventListener('priceUpdate', handlePriceUpdateEvent);

    console.log("[Details Overlay] Event listeners setup (including priceUpdate).");
}

// --- Initialization and Export ---
window.AppDetailsOverlay = {
    initialize: setupDetailsOverlayEventListeners,
    showDetailsOverlay,
    hideDetailsOverlay
    // No need to expose fetchBookSpecsIfNeeded or chart functions directly
};

console.log("[Details Overlay] Module loaded.");
