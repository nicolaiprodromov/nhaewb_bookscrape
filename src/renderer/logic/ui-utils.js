// electron_app/renderer_process/ui-utils.js
/** Creates an HSLA color string */
function createHslaColor(hslBase, alpha) {
    if (!hslBase || typeof hslBase.h !== 'number' || typeof hslBase.s !== 'number' || typeof hslBase.l !== 'number') {
        // Fallback color if base is invalid
        return `hsla(0, 0%, 50%, ${alpha ?? 0.5})`;
    }
    return `hsla(${hslBase.h}, ${hslBase.s}%, ${hslBase.l}%, ${alpha ?? 1})`;
}

/** Generates a simple unique enough ID */
function generateUniqueId() {
    return `id_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 9)}`;
}

/** Generates a simple hash from a string (for color palette indexing) */
function simpleHash(str) {
    let hash = 0;
    if (!str || str.length === 0) return hash;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash |= 0; // Convert to 32bit integer
    }
    return Math.abs(hash);
}

// Export functions to be used by other renderer modules
// Using a simple object export for compatibility with potential non-module script loading
window.AppUIUtils = {
    createHslaColor,
    generateUniqueId,
    simpleHash
};
console.log("[UI Utils] Module loaded.");