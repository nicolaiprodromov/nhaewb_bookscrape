// electron_app/main_process/tracker-persistence.js
const fs = require('fs').promises; // Use promises version of fs
const path = require('path');
const { dialog } = require('electron'); // For showing errors

// Default structure if file doesn't exist or is invalid
const DEFAULT_TRACKER_DATA = [{ name: "Untitled", books: [] }];

// Determine path (relative to this file, assuming it's in main_process)
const TRACKED_BOOKS_FILENAME = 'tracked_books.json';
const trackedBooksPath = path.join(__dirname, '..', TRACKED_BOOKS_FILENAME); // Up one level from main_process
console.log(`[Tracker Persistence] Data path: ${trackedBooksPath}`);

async function loadTrackedBooksData() {
    console.log(`[Tracker Persistence] Attempting load from ${trackedBooksPath}`);
    try {
        await fs.access(trackedBooksPath); // Check existence
        const data = await fs.readFile(trackedBooksPath, 'utf-8');
        const loadedData = JSON.parse(data);

        if (Array.isArray(loadedData)) {
             // Basic format validation (array of objects with name/books)
             const isValidFormat = loadedData.length === 0 ||
                                  (loadedData[0] && typeof loadedData[0] === 'object' &&
                                   typeof loadedData[0].name === 'string' && Array.isArray(loadedData[0].books));

            if (isValidFormat) {
                console.log(`[Tracker Persistence] Loaded ${loadedData.length} categories.`);
                return loadedData;
            } else {
                console.warn(`[Tracker Persistence] Loaded data is array but wrong structure. Migrating.`);
                // Simple migration: wrap old flat array into a single category
                return [{ name: "Imported Trackers", books: loadedData }];
            }
        } else {
             console.error(`[Tracker Persistence] Invalid format (not array). File corrupted?`);
             dialog.showErrorBox('Data Load Error', `Tracked books file not in expected format.\n${trackedBooksPath}\n\nUsing default.`);
             return structuredClone(DEFAULT_TRACKER_DATA);
        }

    } catch (error) {
        if (error.code === 'ENOENT') {
            console.log(`[Tracker Persistence] File not found. Returning default.`);
            return structuredClone(DEFAULT_TRACKER_DATA);
        } else if (error instanceof SyntaxError) {
             console.error(`[Tracker Persistence] Parse error:`, error);
             dialog.showErrorBox('Data Load Error', `Failed to parse tracked books (JSON error).\n${trackedBooksPath}\n\nUsing default.`);
             return structuredClone(DEFAULT_TRACKER_DATA);
        } else {
            console.error(`[Tracker Persistence] Load error:`, error);
             dialog.showErrorBox('Data Load Error', `Failed to load tracked books.\n${trackedBooksPath}\n\nError: ${error.message}`);
            return structuredClone(DEFAULT_TRACKER_DATA);
        }
    }
}

async function saveTrackedBooksData(categoryList) {
    console.log(`[Tracker Persistence] Saving ${categoryList?.length ?? 0} categories.`);
    if (!Array.isArray(categoryList)) {
        console.error('[Tracker Persistence] Invalid data (not array). Save aborted.');
        return false;
    }
    // Basic validation could be added here

    console.log(`[Tracker Persistence] Writing to: ${trackedBooksPath}`);
    try {
        const dataToSave = JSON.stringify(categoryList, null, 2); // Pretty-print
        await fs.writeFile(trackedBooksPath, dataToSave, 'utf-8');
        console.log(`[Tracker Persistence] Write successful.`);
        return true;
    } catch (error) {
        console.error(`[Tracker Persistence] Write error:`, error);
        dialog.showErrorBox('Data Save Error', `Failed to save tracker data.\n${trackedBooksPath}\n\nError: ${error.message}`);
        return false;
    }
}

module.exports = {
    loadTrackedBooksData,
    saveTrackedBooksData,
    trackedBooksPath // Export path if needed elsewhere (though unlikely)
};