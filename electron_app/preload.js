// electron_app/preload.js
const { contextBridge, ipcRenderer } = require('electron');

console.log('[Preload] Script loaded.'); // Log to confirm preload is running

contextBridge.exposeInMainWorld('electronAPI', {
  // --- Renderer to Main (Invoke/Handle Pattern) ---
  // Used when the renderer needs to trigger an action in main AND get a response back.

  /**
   * Loads the list of tracked books from the main process.
   * @returns {Promise<Array<object>>} A promise that resolves with the array of tracked books.
   */
  loadTrackedBooks: () => ipcRenderer.invoke('load-tracked-books'),

  /**
   * Saves the provided list of tracked books in the main process.
   * @param {Array<object>} trackedList - The complete list of books currently being tracked.
   * @returns {Promise<boolean>} A promise that resolves with true on success, false on failure.
   */
  saveTrackedBooks: (trackedList) => ipcRenderer.invoke('save-tracked-books', trackedList),

  // --- Optional: Main to Renderer (Send/On Pattern) ---
  // Can be useful if the main process needs to proactively send updates
  // Example: onFileChanged: (callback) => ipcRenderer.on('tracked-books-updated', callback)
  // Note: If using 'on', remember to return a cleanup function:
  // return () => ipcRenderer.removeListener('tracked-books-updated', callback);

  // --- Optional: Renderer to Main (One-Way Send) ---
  // Used when the renderer just needs to notify main without needing a direct response.
  // Example: notifyMain: (message) => ipcRenderer.send('some-notification', message)

  // --- Basic Alert (Example of exposing another Electron module securely) ---
  // We'll use standard browser alert for simplicity now, but this shows the pattern.
  // showAlert: (message) => ipcRenderer.invoke('show-alert', message)
});

console.log('[Preload] electronAPI exposed.');