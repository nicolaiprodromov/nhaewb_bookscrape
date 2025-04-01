// electron_app/webview-scripts/detail-extraction.js
// NOTE: This file should contain ONLY the JavaScript code to be executed in the webview.
// It's read by server.js and injected.

(async () => {
    console.log('[Webview JS - Details] Starting price & detail extraction...');

    function getPriceFromSpans(priceDiv) {
        // Reuse logic similar to list extraction if structure matches
        if (!priceDiv) return null;
        try {
            const i = priceDiv.querySelector('span.m_int')?.innerText;
            const d = priceDiv.querySelector('span.m_dec')?.innerText;
            const c = priceDiv.querySelector('span.m_cur')?.innerText;
            if (i && d && c) {
                return `${i.trim()}${d.trim()} ${c.trim()}`;
            }
            // Fallback if spans aren't standard
            let text = priceDiv.innerText?.trim() || '';
            text = text.replace(/PreÈ›|Pret vechi:/gi, '').trim();
            return text || null;
        } catch (e) {
            console.warn("[Webview JS - Details] Error parsing price spans:", e);
            return priceDiv.innerText?.trim() || null;
        }
    }

    function getVoucherPriceAndCode(voucherDiv) {
        if (!voucherDiv) return { voucherPrice: null, voucherCode: null };
        let voucherPrice = null;
        let voucherCode = null;
        try {
            // Extract Price (e.g., 16<sup>,99</sup> lei)
            const priceElement = voucherDiv.querySelector('div[style*="font-size:1.8rem"]');
            if (priceElement) {
                const textNode = Array.from(priceElement.childNodes).find(n => n.nodeType === Node.TEXT_NODE);
                const i = textNode ? textNode.textContent.trim() : '';
                const sup = priceElement.querySelector('sup');
                const d = sup ? sup.innerText?.trim() : '';
                 const currencyElement = priceElement.innerText?.match(/lei/i); // Find currency
                 const c = currencyElement ? currencyElement[0] : '';
                if (i && d) {
                     // Combine, remove comma if present in decimal, add currency
                     voucherPrice = `${i}${d.replace(',', '')} ${c}`.trim();
                } else {
                    voucherPrice = priceElement.innerText?.trim() || null; // Fallback
                }
            }

            // Extract Code (e.g., Aplicati codul de voucher 514M...)
            const codeMatch = voucherDiv.innerText?.match(/codul de voucher\s*(\w+)/i);
            if (codeMatch && codeMatch[1]) {
                voucherCode = codeMatch[1].trim();
            }

        } catch (e) {
            console.warn("[Webview JS - Details] Error parsing voucher div:", e);
            voucherPrice = voucherDiv.querySelector('div[style*="font-size:1.8rem"]')?.innerText?.trim() || null; // Fallback price
            voucherCode = null; // Cannot reliably get code on error
        }
        return { voucherPrice, voucherCode };
    }

    const results = {
        specs: {}, // Keep existing specs extraction
        prices: { // Add a dedicated prices object
            currentPrice: null,
            oldPrice: null,
            voucherPrice: null,
            voucherCode: null
        }
    };

    // --- Price Extraction ---
    const priceBox = document.querySelector('.price_box');
    if (priceBox) {
        console.log('[Webview JS - Details] Found price_box.');
        // Current Price
        const newPriceDiv = priceBox.querySelector('#ctl11_ctl00_product_ctl00_pnlNewPrice.new_price'); // Use specific ID if stable
        if(newPriceDiv) {
             results.prices.currentPrice = getPriceFromSpans(newPriceDiv.querySelector('.money_expanded'));
        } else {
             console.warn('[Webview JS - Details] New price div not found.');
        }

        // Old Price (Look for common patterns, may need adjustment)
        const oldPriceDiv = priceBox.querySelector('.old_price_pre:not(.hidden)') || priceBox.querySelector('.old_price_post:not(.hidden)') || priceBox.querySelector('.old_price'); // Add common class too
         if(oldPriceDiv) {
              results.prices.oldPrice = getPriceFromSpans(oldPriceDiv);
         } else {
              // console.debug('[Webview JS - Details] Old price div not found.'); // Less critical?
         }

        // Voucher Price & Code
        const voucherDiv = priceBox.querySelector('.voucher_dependent_product_page');
         if(voucherDiv) {
             const { voucherPrice, voucherCode } = getVoucherPriceAndCode(voucherDiv);
             results.prices.voucherPrice = voucherPrice;
             results.prices.voucherCode = voucherCode;
         } else {
             // console.debug('[Webview JS - Details] Voucher div not found.');
         }

        console.log('[Webview JS - Details] Prices extracted:', results.prices);
    } else {
        console.warn('[Webview JS - Details] price_box element not found.');
    }


    // --- Specs Extraction (Keep Existing Logic) ---
    const specsSection = document.querySelector('.product_section.product_section_specs');
    if (specsSection) {
        const table = specsSection.querySelector('table.product_tab_table_specs');
        if (table) {
            try {
                const rows = table.querySelectorAll('tbody tr');
                for (const row of rows) {
                    const cells = row.querySelectorAll('td');
                    if (cells.length === 2) {
                        const labelElement = cells[0];
                        const valueElement = cells[1];
                        const label = labelElement?.innerText?.trim().toLowerCase();
                        let value = valueElement?.innerText?.trim();
                        const linkElement = valueElement.querySelector('a[href]');

                        if (linkElement) {
                            const linkText = linkElement.innerText?.trim();
                            const linkHref = linkElement.href;
                            if (label === 'autor' && linkText) { value = linkText; results.specs['authorUrl'] = linkHref; }
                            else if (label === 'de aceeasi editura' && linkText) { value = linkText; results.specs['publisherUrl'] = linkHref; }
                        }

                        if (label && value) {
                            switch (label) {
                                case 'anul publicarii': results.specs.publishYear = value; break;
                                case 'isbn': results.specs.isbn = value; break;
                                case 'format coperta': results.specs.binding = value; break;
                                case 'numar pagini': results.specs.pages = value; break;
                                case 'limba': results.specs.language = value; break;
                                case 'domeniul': results.specs.category = value; break;
                                case 'autor': if (!results.specs.author) results.specs.author = value; break;
                                case 'de aceeasi editura': if (!results.specs.publisher) results.specs.publisher = value; break;
                            }
                        }
                    }
                }
                 console.log('[Webview JS - Details] Specs extracted:', results.specs);
            } catch (err) {
                console.error('[Webview JS - Details] Error processing specs table:', err);
                // Don't fail the whole operation for spec errors, prices might still be valid
            }
        } else {
            console.warn('[Webview JS - Details] Specs table not found within section.');
        }
    } else {
         console.warn('[Webview JS - Details] Specs section not found.');
    }

    console.log('[Webview JS - Details] Extraction finished.');
    return { success: true, data: results }; // Return combined results

})().catch(err => {
    // Catch top-level errors in the async function
    console.error('[Webview JS - Details] Top-level execution error:', err);
    return { success: false, error: err.message || String(err), stack: err.stack };
});
