// electron_app/main_process/config-loader.js
const fs = require('fs');
const path = require('path');

function loadConfig(configPath) {
    try {
        console.log(`[Config Loader] Attempting to load config from: ${configPath}`);
        const configFileContent = fs.readFileSync(configPath, 'utf-8'); // Sync read during startup
        const config = JSON.parse(configFileContent);

        // --- Validation ---
        if (!config.electronServerPort || typeof config.electronServerPort !== 'number') {
            throw new Error('Invalid config: Requires numeric "electronServerPort".');
        }
        if (!config.webviews || !Array.isArray(config.webviews) || config.webviews.length === 0) {
            throw new Error('Invalid config: Requires non-empty "webviews" array.');
        }
        if (!config.webviews.every(wv => wv && typeof wv.id === 'string' && wv.id.length > 0)) {
            throw new Error('Invalid config: Webview entries need non-empty string "id".');
        }
        if (config.timeouts && typeof config.timeouts !== 'object') {
            console.warn('[Config Loader] Config warning: "timeouts" key is not an object. Ignoring.');
            delete config.timeouts; // Remove invalid timeouts
        }
        // Could add timeout key validation too (navigation, extraction are numbers)

        console.log('[Config Loader] Configuration loaded successfully.');
        console.log(`[Config Loader]   - Server Port: ${config.electronServerPort}`);
        console.log(`[Config Loader]   - Webview IDs: ${config.webviews.map(wv => wv.id).join(', ')}`);
        return config;
    } catch (err) {
        console.error(`[Config Loader] FATAL ERROR loading/parsing config from ${configPath}:`, err.message);
        // Re-throw to be handled by main.js startup logic
        throw err;
    }
}

module.exports = { loadConfig };