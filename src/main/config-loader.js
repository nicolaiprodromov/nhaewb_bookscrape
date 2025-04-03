// src/main/config-loader.js
const fs = require('fs');
const path = require('path');
const { URL } = require('url'); // Ensure URL is required

/**
 * Validates the loaded configuration object.
 * Throws an error if the configuration is invalid.
 */
function validateConfig(config) {
    if (!config || typeof config !== 'object') throw new Error("Config is not a valid object.");

    // Validate webviews (required)
    if (!Array.isArray(config.webviews) || config.webviews.length === 0) {
        throw new Error("Invalid config: Requires a non-empty 'webviews' array.");
    }
    for (let i = 0; i < config.webviews.length; i++) {
        const wv = config.webviews[i];
        if (!wv || typeof wv !== 'object') throw new Error(`Invalid config: Webview at index ${i} is not an object.`);
        if (!wv.id || typeof wv.id !== 'string') throw new Error(`Invalid config: Webview at index ${i} requires a string 'id'.`);
        if (!wv.initialUrl || typeof wv.initialUrl !== 'string') throw new Error(`Invalid config: Webview at index ${i} requires a string 'initialUrl'.`);
        try { new URL(wv.initialUrl); } catch (e) { throw new Error(`Invalid config: Webview "${wv.id}" has an invalid 'initialUrl': ${e.message}`); }
        // partition is optional
        if (wv.partition && typeof wv.partition !== 'string') throw new Error(`Invalid config: Webview "${wv.id}" 'partition' must be a string if present.`);
        // description is optional
        if (wv.description && typeof wv.description !== 'string') throw new Error(`Invalid config: Webview "${wv.id}" 'description' must be a string if present.`);
        // listDataBaseUrl is optional but recommended for the primary fetcher
        if (wv.listDataBaseUrl && typeof wv.listDataBaseUrl !== 'string') throw new Error(`Invalid config: Webview "${wv.id}" 'listDataBaseUrl' must be a string if present.`);
        if (wv.listDataBaseUrl) try { new URL(wv.listDataBaseUrl); } catch (e) { throw new Error(`Invalid config: Webview "${wv.id}" has an invalid 'listDataBaseUrl': ${e.message}`); }
    }

    // Validate timeouts (optional, but structure if present)
    if (config.timeouts && typeof config.timeouts !== 'object') {
         throw new Error("Invalid config: 'timeouts' must be an object if present.");
    }
    if (config.timeouts) {
         const validTimeoutKeys = ['navigation', 'listExtraction', 'detailExtraction', 'postNavigationDelay'];
         for (const key in config.timeouts) {
             if (!validTimeoutKeys.includes(key)) throw new Error(`Invalid config: Unknown timeout key "${key}".`);
             if (typeof config.timeouts[key] !== 'number' || config.timeouts[key] < 0) {
                 throw new Error(`Invalid config: Timeout "${key}" must be a non-negative number.`);
             }
         }
    }

    // Validate imageDownloadConcurrency (optional)
    if (config.imageDownloadConcurrency && (typeof config.imageDownloadConcurrency !== 'number' || !Number.isInteger(config.imageDownloadConcurrency) || config.imageDownloadConcurrency <= 0)) {
        throw new Error("Invalid config: 'imageDownloadConcurrency' must be a positive integer if present.");
    }

    console.log("[Config Loader] Configuration validation passed.");
}

/**
 * Loads and validates the configuration from a JSON file.
 * The path is passed from the main process.
 */
function loadConfig(configPath) {
    console.log(`[Config Loader] Attempting to load config from: ${configPath}`);
    let rawData;
    try {
        rawData = fs.readFileSync(configPath, 'utf8');
    } catch (err) {
        console.error(`[Config Loader] Error reading config file ${configPath}:`, err);
        throw new Error(`Failed to read config file: ${err.message}`);
    }

    let parsedConfig;
    try {
        parsedConfig = JSON.parse(rawData);
    } catch (err) {
        console.error(`[Config Loader] Error parsing JSON from ${configPath}:`, err);
        throw new Error(`Failed to parse config JSON: ${err.message}`);
    }

    try {
        validateConfig(parsedConfig);
    } catch (validationError) {
        // Log here, but let the main process handle the ultimate consequence
        console.error(`[Config Loader] Config validation failed: ${validationError.message}`);
        throw validationError; // Re-throw validation error
    }

    console.log("[Config Loader] Config loaded and validated successfully.");
    return parsedConfig;
}

module.exports = { loadConfig };