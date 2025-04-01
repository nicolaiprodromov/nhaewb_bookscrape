// electron_app/webview-scripts/detail-extraction.js
// NOTE: This file should contain ONLY the JavaScript code to be executed in the webview.
// It's read by server.js and injected.

(async () => {
    console.log('[Webview JS - Details] Starting book detail extraction...');
    const details = {}; // Object to hold extracted specs

    // Find the specifications section
    const specsSection = document.querySelector('.product_section.product_section_specs');
    if (!specsSection) {
        console.warn('[Webview JS - Details] Specifications section (.product_section_specs) not found.');
        // Return success with empty data if the whole section is missing - page might be different
        return { success: true, data: {} };
    }

    // Find the table within the section
    const table = specsSection.querySelector('table.product_tab_table_specs');
    if (!table) {
        console.warn('[Webview JS - Details] Specs table (.product_tab_table_specs) not found within section.');
        // Return success with empty data if table is missing but section exists
        return { success: true, data: {} };
    }

    try {
        const rows = table.querySelectorAll('tbody tr');
        console.log(`[Webview JS - Details] Found ${rows.length} rows in specs table.`);

        for (const row of rows) {
            const cells = row.querySelectorAll('td');
            if (cells.length === 2) {
                const labelElement = cells[0];
                const valueElement = cells[1];

                // Get text, trim, normalize label to lowercase
                const label = labelElement?.innerText?.trim().toLowerCase();
                let value = valueElement?.innerText?.trim(); // Get combined text content initially

                // --- Specific Handling for Linked Values (Author/Publisher) ---
                const linkElement = valueElement.querySelector('a[href]');
                if (linkElement) {
                    const linkText = linkElement.innerText?.trim();
                    const linkHref = linkElement.href;

                    if (label === 'autor' && linkText) {
                       value = linkText; // Prefer link text for author
                       details['authorUrl'] = linkHref; // Capture URL
                    } else if (label === 'de aceeasi editura' && linkText) { // Assuming this means publisher
                        value = linkText; // Prefer link text for publisher
                        details['publisherUrl'] = linkHref; // Capture URL
                    }
                    // Add more 'else if' for other linked fields if necessary
                }
                // --- End Specific Handling ---

                if (label && value) {
                    // Map normalized labels to consistent keys
                    switch (label) {
                        case 'anul publicarii': details.publishYear = value; break;
                        case 'isbn': details.isbn = value; break;
                        case 'format coperta': details.binding = value; break;
                        case 'numar pagini': details.pages = value; break;
                        case 'limba': details.language = value; break;
                        case 'domeniul': details.category = value; break; // Or maybe 'genre'? Choose one.
                        case 'autor':
                            // Only set if not already set by the link handling above
                            if (!details.author) details.author = value;
                            break;
                        case 'de aceeasi editura': // Publisher
                             // Only set if not already set by the link handling above
                            if (!details.publisher) details.publisher = value;
                            break;
                        // Add more mappings here for other fields like 'traducator', 'dimensiuni', etc.
                        // Example: case 'traducator': details.translator = value; break;
                        default:
                            // Optionally store unmapped fields if useful, but often noisy
                            // console.log(`[Webview JS - Details] Unmapped Field: '${label}' = '${value}'`);
                            // details[`unmapped_${label.replace(/\s+/g, '_')}`] = value; // Example storage
                            break;
                    }
                }
            } else {
                 // console.warn('[Webview JS - Details] Row skipped, expected 2 cells, found:', cells.length);
            }
        }
        console.log('[Webview JS - Details] Extraction finished successfully:', details);
        return { success: true, data: details }; // Return extracted data

    } catch (err) {
        console.error('[Webview JS - Details] Error during table row processing:', err);
        // Return failure state with error details
        return { success: false, error: err.message || String(err), stack: err.stack };
    }
})(); // Immediately invoke the async function