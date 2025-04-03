// src/main/tracker-persistence.js
const fs = require('fs').promises; // Use promises version of fs
const path = require('path');
const { dialog } = require('electron'); // For showing errors

// Default structure if file doesn't exist or is invalid
const DEFAULT_TRACKER_DATA = [{ id: `default_${Date.now()}`, name: "Untitled", books: [], isCollapsed: false, color: null }];

// Determine path (now in project_root/data/)
const TRACKED_BOOKS_FILENAME = 'tracked_books.json';
const trackedBooksPath = path.join(__dirname, '../../data', TRACKED_BOOKS_FILENAME); // Path updated
console.log(`[Tracker Persistence] Data path: ${trackedBooksPath}`);

async function loadTrackedBooksData() {
    console.log(`[Tracker Persistence] Attempting load from ${trackedBooksPath}`);
    try {
        // Check existence AND readability first
        await fs.access(trackedBooksPath, fs.constants.R_OK);
        const data = await fs.readFile(trackedBooksPath, 'utf-8');
        const loadedData = JSON.parse(data);

        if (!Array.isArray(loadedData)) {
            console.error(`[Tracker Persistence] Invalid format (not array). File corrupted?`);
            dialog.showErrorBox('Data Load Error', `Tracked books file is not in the expected array format.\n${trackedBooksPath}\n\nUsing default data.`);
            return structuredClone(DEFAULT_TRACKER_DATA); // Use structuredClone for deep copy
        }

        // Basic format validation (array of objects with id/name/books)
         const isValidFormat = loadedData.every(cat =>
             cat && typeof cat === 'object' &&
             typeof cat.id === 'string' &&
             typeof cat.name === 'string' &&
             Array.isArray(cat.books)
             // Optional checks for isCollapsed, color etc. can be added
         );

        if (isValidFormat) {
            console.log(`[Tracker Persistence] Loaded ${loadedData.length} categories.`);
            // Ensure default fields exist if missing from saved data (simple migration)
            return loadedData.map(cat => ({
                 ...cat, // Spread existing properties
                 id: cat.id || `migrated_${Date.now()}_${Math.random().toString(16).slice(2)}`, // Ensure ID
                 name: cat.name || "Untitled",
                 books: cat.books || [],
                 isCollapsed: cat.isCollapsed === true, // Default to false if missing/invalid
                 color: cat.color || null // Keep null if missing
            }));
        } else {
            console.warn(`[Tracker Persistence] Loaded data is array but has invalid category structure. Using default.`);
            dialog.showErrorBox('Data Load Error', `Tracked books file contains invalid category data.\n${trackedBooksPath}\n\nUsing default data.`);
            return structuredClone(DEFAULT_TRACKER_DATA);
        }

    } catch (error) {
        if (error.code === 'ENOENT') {
            console.log(`[Tracker Persistence] File not found. Returning default.`);
            // Optionally, save the default structure immediately
            // await saveTrackedBooksData(structuredClone(DEFAULT_TRACKER_DATA));
            return structuredClone(DEFAULT_TRACKER_DATA);
        } else if (error instanceof SyntaxError) {
             console.error(`[Tracker Persistence] JSON Parse error:`, error);
             dialog.showErrorBox('Data Load Error', `Failed to parse tracked books file (JSON error).\n${trackedBooksPath}\n\nUsing default data.`);
             return structuredClone(DEFAULT_TRACKER_DATA);
        } else {
            console.error(`[Tracker Persistence] Load/Access error:`, error);
             dialog.showErrorBox('Data Load Error', `Failed to load tracked books file.\n${trackedBooksPath}\n\nError: ${error.message}\n\nUsing default data.`);
            return structuredClone(DEFAULT_TRACKER_DATA);
        }
    }
}

async function saveTrackedBooksData(categoryList) {
    const count = categoryList?.length ?? 0;
    console.log(`[Tracker Persistence] Attempting to save ${count} categories.`);

    if (!Array.isArray(categoryList)) {
        console.error('[Tracker Persistence] Invalid data provided (not array). Save aborted.');
         dialog.showErrorBox('Data Save Error', `Attempted to save invalid data (not an array) to tracked books file.`);
        return false;
    }

    // Add more validation if needed (e.g., check structure of each category)

    console.log(`[Tracker Persistence] Writing to: ${trackedBooksPath}`);
    try {
        const dataToSave = JSON.stringify(categoryList, null, 2); // Pretty-print JSON
        await fs.writeFile(trackedBooksPath, dataToSave, 'utf-8');
        console.log(`[Tracker Persistence] ${count} categories saved successfully.`);
        return true;
    } catch (error) {
        console.error(`[Tracker Persistence] File Write error:`, error);
        dialog.showErrorBox('Data Save Error', `Failed to save tracker data.\n${trackedBooksPath}\n\nError: ${error.message}`);
        return false;
    }
}

module.exports = {
    loadTrackedBooksData,
    saveTrackedBooksData
    // trackedBooksPath // No longer exporting path, keep it internal
};