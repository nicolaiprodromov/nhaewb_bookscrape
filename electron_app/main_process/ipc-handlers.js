// electron_app/main_process/ipc-handlers.js
const { ipcMain } = require('electron');
const { loadTrackedBooksData, saveTrackedBooksData } = require('./tracker-persistence');
const { URL } = require('url'); // For URL manipulation

// Module is passed in during setup
let webviewControllerInstance = null;

function setupIpcHandlers(controller) {
    console.log('[IPC Setup] Registering IPC handlers...');
    webviewControllerInstance = controller;

    // --- Tracker Persistence Handlers ---
    ipcMain.handle('load-tracked-books', async () => {
        console.log(`[IPC] Received 'load-tracked-books'.`);
        return await loadTrackedBooksData();
    });
    ipcMain.handle('save-tracked-books', async (event, categoryList) => {
        console.log(`[IPC] Received 'save-tracked-books'.`);
        return await saveTrackedBooksData(categoryList);
    });

    // --- NEW Webview Control Handlers ---

    /** Handles fetching list data for a given page URL */
    ipcMain.handle('fetch-list-data', async (event, webviewId, pageUrl) => {
        console.log(`[IPC] Received 'fetch-list-data' for WV:${webviewId}, URL:${pageUrl}`);
        if (!webviewControllerInstance) return { success: false, error: "Webview Controller not initialized" };
        try {
            // Validate URL basic structure
            new URL(pageUrl);
            return await webviewControllerInstance.fetchListData(webviewId, pageUrl);
        } catch (error) {
            console.error(`[IPC Error] 'fetch-list-data' failed: ${error.message}`);
            return { success: false, error: error.message || "Failed to fetch list data" };
        }
    });

    /** Handles fetching detail/price data for a specific book URL */
    ipcMain.handle('fetch-detail-data', async (event, webviewId, bookUrl) => {
        console.log(`[IPC] Received 'fetch-detail-data' for WV:${webviewId}, URL:${bookUrl}`);
        if (!webviewControllerInstance) return { success: false, error: "Webview Controller not initialized" };
        try {
             // Validate URL basic structure
             new URL(bookUrl);
            return await webviewControllerInstance.fetchDetailData(webviewId, bookUrl);
        } catch (error) {
            console.error(`[IPC Error] 'fetch-detail-data' failed: ${error.message}`);
            return { success: false, error: error.message || "Failed to fetch detail data" };
        }
    });

    // Add more handlers here if needed in the future

    console.log('[IPC Setup] IPC handlers registered.');
}

module.exports = { setupIpcHandlers };
