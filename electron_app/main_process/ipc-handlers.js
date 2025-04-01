// electron_app/main_process/ipc-handlers.js
const { ipcMain } = require('electron');
const { loadTrackedBooksData, saveTrackedBooksData } = require('./tracker-persistence');

function setupIpcHandlers() {
    console.log('[IPC Setup] Registering IPC handlers...');

    // Handle request to load tracked books
    ipcMain.handle('load-tracked-books', async () => {
        console.log(`[IPC] Received 'load-tracked-books' request.`);
        return await loadTrackedBooksData();
    });

    // Handle request to save tracked books (expects array of category objects)
    ipcMain.handle('save-tracked-books', async (event, categoryList) => {
        console.log(`[IPC] Received 'save-tracked-books' request.`);
        return await saveTrackedBooksData(categoryList);
    });

    // Add more handlers here if needed in the future

    console.log('[IPC Setup] IPC handlers registered.');
}

module.exports = { setupIpcHandlers };