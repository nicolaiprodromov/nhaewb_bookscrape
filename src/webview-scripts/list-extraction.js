// src/webview-scripts/list-extraction.js
// NOTE: This file should contain ONLY the JavaScript code to be executed in the webview.
// It's read by server.js and injected.

(async () => {
    console.log('[Webview JS - List] Starting data extraction script...');
    const delayMs = 1500;
    console.log(`[Webview JS - List] Waiting ${delayMs}ms...`);
    await new Promise(resolve => setTimeout(resolve, delayMs));

    console.log('[Webview JS - List] Querying DOM for book cards...');

    function getPriceFromSpans(priceDiv) {
        if (!priceDiv) return null;
        try {
            const i = priceDiv.querySelector('span.m_int')?.innerText; const d = priceDiv.querySelector('span.m_dec')?.innerText; const c = priceDiv.querySelector('span.m_cur')?.innerText;
            if (i && d && c) { return `${i.trim()}${d.trim()} ${c.trim()}`; }
            else { let text = priceDiv.innerText?.trim() || ''; text = text.replace(/PreÈ›|Pret vechi:/gi, '').trim(); return text || null; }
        } catch (e) { console.warn("[Webview JS - List] Error parsing price:", e); return priceDiv.innerText?.trim() || null; }
    }

    function getVoucherPrice(priceElement) {
        if (!priceElement) return null;
        try {
            const textNode = Array.from(priceElement.childNodes).find(n => n.nodeType === Node.TEXT_NODE);
            const i = textNode ? textNode.textContent.trim() : '';
            const sup = priceElement.querySelector('sup');
            const d = sup ? sup.innerText?.trim().replace(',', '') : ''; // Clean comma if present
            const currencyMatch = priceElement.innerText?.match(/lei|ron/i); // Find currency
            const c = currencyMatch ? currencyMatch[0] : '';
            if (i && d) {
                // ** FIX: Add comma between integer and decimal, include currency **
                return `${i},${d} ${c}`.trim();
            }
            // Fallback if structure differs
            return priceElement.innerText?.trim() || null;
        } catch (e) { console.warn("[Webview JS - List] Error parsing voucher price:", e); return priceElement.innerText?.trim() || null; }
    }

    const books = [];
    const cards = document.querySelectorAll('.product_card.product_card_grid');
    console.log(`[Webview JS - List] Found ${cards.length} product cards.`);

    for (const card of cards) {
        const book = { title: null, link: null, image_url: null, current_price: null, old_price: null, voucher_price: null, voucher_code: null };
        try {
            book.title = card.querySelector('div.name h2.title')?.innerText?.trim() || null;
            book.link = card.querySelector('div.name a[href]')?.href || null;
            const imgElement = card.querySelector('div.figure img[src]');
            if (imgElement) { try { book.image_url = new URL(imgElement.src, document.baseURI).href; } catch { book.image_url = imgElement.src; } }
            const priceContainer = card.querySelector('div.price > div.__i');
            if (priceContainer) { book.current_price = getPriceFromSpans(priceContainer.querySelector('div.new_price')); const oldPriceDiv = priceContainer.querySelector('div.old_price_pre:not(.hidden)') || priceContainer.querySelector('div.old_price_post:not(.hidden)'); book.old_price = getPriceFromSpans(oldPriceDiv); }
            const voucherDiv = card.querySelector('div[style*="grid-template-columns:7fr 6fr 6fr"]');
            if (voucherDiv) {
                 const children = voucherDiv.querySelectorAll(':scope > div');
                 if (children.length === 3 && children[1]?.innerText?.toLowerCase().includes('voucher')) {
                     book.voucher_price = getVoucherPrice(children[0]); // Use updated function
                     book.voucher_code = children[2]?.innerText?.trim() || null;
                 }
            }
            if (book.title || book.link) { books.push(book); }
        } catch (cardError) { console.error('[Webview JS - List] Error processing a card:', cardError); }
    }

    console.log(`[Webview JS - List] Successfully extracted ${books.length} book entries.`);
    return { success: true, data: books };

})().catch(err => { console.error('[Webview JS - List] Top-level execution error:', err); return { success: false, error: err.message || String(err), stack: err.stack }; });
