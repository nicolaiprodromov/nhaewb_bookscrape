// src/renderer/logic/ui-utils.js
/** Creates an HSLA color string */
function createHslaColor(hslBase, alpha) { if (!hslBase || typeof hslBase.h !== 'number' || typeof hslBase.s !== 'number' || typeof hslBase.l !== 'number') return `hsla(0, 0%, 50%, ${alpha ?? 0.5})`; return `hsla(${hslBase.h}, ${hslBase.s}%, ${hslBase.l}%, ${alpha ?? 1})`; }
/** Generates a simple unique enough ID */
function generateUniqueId() { return `id_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 9)}`; }
/** Generates a simple hash from a string */
function simpleHash(str) { let hash = 0; if (!str || str.length === 0) return hash; for (let i = 0; i < str.length; i++) { const char = str.charCodeAt(i); hash = ((hash << 5) - hash) + char; hash |= 0; } return Math.abs(hash); }

/**
 * Applies an icon defined in ui-config.json to a DOM element, including size class.
 * @param {HTMLElement} element The target DOM element (often the container).
 * @param {string} iconKey The key of the icon in ui-config.json.
 * @param {string} [fallbackText=''] Text to display if icon loading fails.
 */
function applyIcon(element, iconKey, fallbackText = '') {
    if (!element || !iconKey) return;
    const uiConfig = window.AppRuntime?.uiConfig;
    const iconConfig = uiConfig?.icons?.[iconKey];

    if (!iconConfig) { console.warn(`[UI Utils] Icon config not found for key: ${iconKey}`); element.textContent = fallbackText; return; }

    // --- Size Handling ---
    // Remove existing size classes and add the new one
    element.classList.remove('icon-size-small', 'icon-size-medium', 'icon-size-big');
    const size = (iconConfig.size || 'MEDIUM').toUpperCase(); // Default to MEDIUM
    const sizeClass = `icon-size-${size.toLowerCase()}`;
    element.classList.add(sizeClass);
    // --- End Size Handling ---

    element.innerHTML = ''; // Clear existing content before adding new

    try {
        switch (iconConfig.type) {
            case 'lottie':
                // Create player and add it to the container (element)
                const player = document.createElement('dotlottie-player');
                player.setAttribute('src', iconConfig.value);
                player.setAttribute('autoplay', ''); player.setAttribute('loop', '');
                player.setAttribute('background', 'transparent'); player.setAttribute('speed', '1');
                // Lottie player should fill its container, size controlled by CSS on the container
                player.style.width = '100%'; player.style.height = '100%';
                element.appendChild(player);
                break;
            case 'svg':
                // Insert SVG string directly into the container
                element.innerHTML = iconConfig.value;
                // Ensure SVG scales with container size (set by size class)
                const svgElement = element.querySelector('svg');
                if (svgElement) {
                    svgElement.style.width = '100%'; svgElement.style.height = '100%';
                    svgElement.style.display = 'block'; // Ensure proper layout
                }
                break;
            case 'png': // Example: Set as background or insert <img>
                // Option 1: Background Image (size controlled by background-size in CSS)
                 element.style.backgroundImage = `url('${iconConfig.value}')`;
                 element.style.backgroundRepeat = 'no-repeat';
                 element.style.backgroundPosition = 'center';
                 element.style.backgroundSize = 'contain'; // Or 'cover', or specific size
                // Option 2: Insert <img> tag (size controlled by CSS on the img inside the container)
                // const img = document.createElement('img');
                // img.src = iconConfig.value;
                // img.alt = iconConfig.description || iconKey;
                // img.style.width = '100%'; img.style.height = '100%'; // Fill container
                // img.style.objectFit = 'contain'; // Or 'cover'
                // element.appendChild(img);
                break;
            case 'char':
                // Set text content and let CSS handle font-size via the size class
                element.textContent = iconConfig.value;
                break;
            default:
                console.warn(`[UI Utils] Unknown icon type "${iconConfig.type}" for key: ${iconKey}`);
                element.textContent = fallbackText;
        }
    } catch (error) {
        console.error(`[UI Utils] Error applying icon "${iconKey}":`, error);
        element.textContent = fallbackText;
    }
}

window.AppUIUtils = { createHslaColor, generateUniqueId, simpleHash, applyIcon };
console.log("[UI Utils] Module loaded.");
