// electron_app/preload.js
const { contextBridge, ipcRenderer } = require('electron');

console.log('[Preload] Script loading.');

contextBridge.exposeInMainWorld('electronAPI', {
  // --- Renderer to Main (Invoke/Handle Pattern) ---

  /** Loads the list of tracked books from the main process. */
  loadTrackedBooks: () => ipcRenderer.invoke('load-tracked-books'),

  /** Saves the provided list of tracked books in the main process. */
  saveTrackedBooks: (trackedList) => ipcRenderer.invoke('save-tracked-books', trackedList),

  /**
   * Triggers fetching list data for a specific page URL in a given webview.
   * @param {string} webviewId - The ID of the target webview (e.g., "anticexlibrisFetcher").
   * @param {string} pageUrl - The full URL of the list page to load and scrape.
   * @returns {Promise<{success: boolean, data?: Array<object>, error?: string}>} Result object.
   */
  fetchListData: (webviewId, pageUrl) => ipcRenderer.invoke('fetch-list-data', webviewId, pageUrl),

  /**
   * Triggers fetching details and prices for a specific book URL in a given webview.
   * @param {string} webviewId - The ID of the target webview.
   * @param {string} bookUrl - The full URL of the book's detail page.
   * @returns {Promise<{success: boolean, details?: object, prices?: object, error?: string}>} Result object.
   */
  fetchDetailData: (webviewId, bookUrl) => ipcRenderer.invoke('fetch-detail-data', webviewId, bookUrl),

});

console.log('[Preload] electronAPI exposed with webview control methods.');
