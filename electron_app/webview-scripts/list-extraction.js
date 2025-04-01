// electron_app/webview-scripts/list-extraction.js
// NOTE: This file should contain ONLY the JavaScript code to be executed in the webview.
// It's read by server.js and injected.

(async () => {
    console.log('[Webview JS - List] Starting data extraction script...');
    // Add a small delay for potentially dynamic content loading
    const delayMs = 1500; // Adjust if needed
    console.log(`[Webview JS - List] Waiting ${delayMs}ms...`);
    await new Promise(resolve => setTimeout(resolve, delayMs));

    console.log('[Webview JS - List] Querying DOM for book cards...');

    function getPriceFromSpans(priceDiv) {
        if (!priceDiv) return null;
        try {
            const i = priceDiv.querySelector('span.m_int')?.innerText;
            const d = priceDiv.querySelector('span.m_dec')?.innerText;
            const c = priceDiv.querySelector('span.m_cur')?.innerText;
            if (i && d && c) {
                // Normalize price format slightly if possible (remove extra spaces)
                return `${i.trim()}${d.trim()} ${c.trim()}`;
            } else {
                // Fallback to text content if spans aren't found
                let text = priceDiv.innerText?.trim() || '';
                text = text.replace(/Preț|Pret vechi:/gi, '').trim(); // Clean common prefixes
                return text || null;
            }
        } catch (e) {
            console.warn("[Webview JS - List] Error parsing price:", e);
            // Last resort fallback
            return priceDiv.innerText?.trim() || null;
        }
    }

    function getVoucherPrice(priceElement) {
        if (!priceElement) return null;
        try {
            // Try finding the main price part from text node, superscript for decimal
            const textNode = Array.from(priceElement.childNodes).find(n => n.nodeType === Node.TEXT_NODE);
            const i = textNode ? textNode.textContent.trim() : '';
            const sup = priceElement.querySelector('sup');
            const d = sup ? sup.innerText?.trim() : '';
            if (i && d) {
                return `${i}${d}`; // e.g., "14" + "99" -> "1499" (or adjust if needs comma)
            }
            // Fallback if structure differs
            return priceElement.innerText?.trim() || null;
        } catch (e) {
            console.warn("[Webview JS - List] Error parsing voucher price:", e);
            return priceElement.innerText?.trim() || null;
        }
    }

    const books = [];
    const cards = document.querySelectorAll('.product_card.product_card_grid');
    console.log(`[Webview JS - List] Found ${cards.length} product cards.`);

    for (const card of cards) {
        const book = {
            title: null,
            link: null,
            image_url: null, // Will be downloaded by Electron server
            current_price: null,
            old_price: null,
            voucher_price: null,
            voucher_code: null
        };

        try {
            // Extract Title
            book.title = card.querySelector('div.name h2.title')?.innerText?.trim() || null;

            // Extract Link
            book.link = card.querySelector('div.name a[href]')?.href || null;

            // Extract Image URL (absolute URL if possible)
            const imgElement = card.querySelector('div.figure img[src]');
            if (imgElement) {
                 // Ensure URL is absolute
                 try { book.image_url = new URL(imgElement.src, document.baseURI).href; }
                 catch { book.image_url = imgElement.src; /* fallback to original src */ }
            }

            // Extract Prices
            const priceContainer = card.querySelector('div.price > div.__i');
            if (priceContainer) {
                book.current_price = getPriceFromSpans(priceContainer.querySelector('div.new_price'));
                // Handle potential variations in old price class/structure
                const oldPriceDiv = priceContainer.querySelector('div.old_price_pre:not(.hidden)') || priceContainer.querySelector('div.old_price_post:not(.hidden)');
                book.old_price = getPriceFromSpans(oldPriceDiv);
            }

            // Extract Voucher Info (adjust selector if structure varies)
            const voucherDiv = card.querySelector('div[style*="grid-template-columns:7fr 6fr 6fr"]'); // This selector seems fragile
            if (voucherDiv) {
                 const children = voucherDiv.querySelectorAll(':scope > div'); // Direct children divs
                 // Assume structure: [Price], [Label contains 'voucher'], [Code]
                 if (children.length === 3 && children[1]?.innerText?.toLowerCase().includes('voucher')) {
                     book.voucher_price = getVoucherPrice(children[0]);
                     book.voucher_code = children[2]?.innerText?.trim() || null;
                 }
            }

            // Only add if essential data (like title or link) is present
            if (book.title || book.link) {
                books.push(book);
            } else {
                 // console.warn('[Webview JS - List] Card skipped - missing title and link.');
            }
        } catch (cardError) {
            console.error('[Webview JS - List] Error processing a card:', cardError);
            // Optionally add a placeholder or skip the card
        }
    }

    console.log(`[Webview JS - List] Successfully extracted ${books.length} book entries.`);
    return { success: true, data: books }; // Return data wrapped in success object

})().catch(err => {
    // Catch top-level errors in the async function
    console.error('[Webview JS - List] Top-level execution error:', err);
    return { success: false, error: err.message || String(err), stack: err.stack };
});