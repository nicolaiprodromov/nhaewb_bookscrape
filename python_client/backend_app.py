# python_client/backend_app.py
import os
import logging
from flask import Flask, jsonify, request, Response, send_file, abort
from flask_cors import CORS
from driver import ElectronBridgeDriver
from urllib.parse import urlparse, parse_qs, urlencode, urlunparse, unquote

# --- Configure Logging ---
# Use a more detailed format for backend logs
log_format = '%(asctime)s [%(levelname)s] [BackendApp] %(message)s (%(filename)s:%(lineno)d)'
logging.basicConfig(level=logging.INFO, format=log_format, datefmt='%Y-%m-%d %H:%M:%S')
log = logging.getLogger(__name__)

# --- Flask App Setup ---
app = Flask(__name__)
# Allow requests from the Electron app's origin (file://) or specific localhost port if needed
# For development, allowing all origins is often easiest.
CORS(app)
log.info("Flask app created and CORS enabled.")

# --- Configuration & Driver Initialization ---
# Determine paths relative to this script file
backend_script_dir = os.path.dirname(os.path.abspath(__file__))
# Assume config.json is in the same directory as backend_app.py for the driver
# If config is elsewhere, adjust this path
DRIVER_CONFIG_PATH = os.path.join(backend_script_dir, "config.json")
# Electron app dir calculation (assuming standard project structure)
ELECTRON_APP_DIR = os.path.abspath(os.path.join(backend_script_dir, '..', 'electron_app'))
IMAGE_DOWNLOAD_DIR = os.path.join(ELECTRON_APP_DIR, 'downloaded_images')

log.info(f"Backend script directory: {backend_script_dir}")
log.info(f"Expecting driver config at: {DRIVER_CONFIG_PATH}")
log.info(f"Calculated Electron app directory: {ELECTRON_APP_DIR}")
log.info(f"Expecting local images in: {IMAGE_DOWNLOAD_DIR}")

# Check if critical paths exist
if not os.path.isfile(DRIVER_CONFIG_PATH):
     log.critical(f"Driver config file not found at {DRIVER_CONFIG_PATH}. Backend cannot start.")
     exit(f"Driver config missing: {DRIVER_CONFIG_PATH}")
if not os.path.isdir(os.path.dirname(IMAGE_DOWNLOAD_DIR)): # Check parent of image dir
     log.warning(f"Base directory for Electron app not found at calculated path: {ELECTRON_APP_DIR}. Image serving might fail.")

# Initialize the driver
try:
    driver = ElectronBridgeDriver(config_path=DRIVER_CONFIG_PATH)
    if not driver.is_ready():
        # Driver constructor logs details, just add a critical message here
        log.critical("Electron Bridge Driver failed to initialize properly.")
        exit("Driver initialization failed. Exiting backend.")
    log.info("Electron Bridge Driver initialized successfully.")
except Exception as e:
    log.exception("Critical error during Driver initialization.") # Log full traceback
    exit(f"Failed to initialize driver: {e}")


# --- Default URLs and Settings ---
# Consider moving these to a config file if they change often
DEFAULT_TARGET_URL = "https://www.anticexlibris.ro/carti-de-literatura-contemporana-in-engleza?filter=-2/l/1"
DEFAULT_POST_NAV_DELAY_S = 2 # Default delay after nav before extraction

# --- URL Helper ---
def _add_or_update_query_param(url_str, param_name, param_value):
    """Safely adds or updates a query parameter in a URL string."""
    try:
        parsed_url = urlparse(url_str)
        query_params = parse_qs(parsed_url.query)
        query_params[param_name] = [str(param_value)] # Ensure value is string, allows overwriting
        new_query_string = urlencode(query_params, doseq=True) # Handle multi-value params if needed
        # Reconstruct the URL
        return urlunparse((
            parsed_url.scheme, parsed_url.netloc, parsed_url.path,
            parsed_url.params, new_query_string, parsed_url.fragment
        ))
    except Exception as e:
        log.error(f"Error manipulating URL '{url_str}': {e}")
        return url_str # Return original URL on error


# --- API Endpoints ---

@app.route('/fetch-page-data', methods=['GET'])
def fetch_page_data():
    """Fetches book list data for a given page number."""
    page_str = request.args.get('page', default='1', type=str)
    base_url = request.args.get('base_url', default=DEFAULT_TARGET_URL, type=str)

    try:
        page_number = int(page_str)
        if page_number <= 0: page_number = 1 # Ensure page is positive
    except ValueError:
        log.warning(f"Invalid 'page' parameter '{page_str}'. Defaulting to 1.")
        page_number = 1

    log.info(f"Request received for book list page {page_number} (Base URL: {base_url})")

    if not driver or not driver.is_ready() or not driver.default_webview_id:
         log.error("Driver not available for '/fetch-page-data'.")
         # 503 Service Unavailable is appropriate if backend dependency isn't ready
         return jsonify({"success": False, "error": "Backend driver service unavailable"}), 503

    webview_id = driver.default_webview_id
    target_url = _add_or_update_query_param(base_url, 'page', page_number)

    log.info(f"Navigating webview '{webview_id}' to page {page_number}: {target_url}")
    navigation_ok = driver.navigate(webview_id, target_url) # Uses default nav timeout from driver
    if not navigation_ok:
        log.error(f"Navigation failed for page {page_number} URL: {target_url}")
        return jsonify({"success": False, "error": f"Navigation failed for page {page_number}"}), 500 # Internal Server Error

    log.info(f"Extracting list data for page {page_number}...")
    # Use the specific method for list extraction
    extracted_data = driver.extract_list_data(
        webview_id,
        post_nav_delay_seconds=DEFAULT_POST_NAV_DELAY_S # Use configured delay
        # Uses default list extraction timeout from driver
    )

    if extracted_data is None:
        log.error(f"List data extraction failed for page {page_number} URL: {target_url}")
        return jsonify({"success": False, "error": f"Data extraction failed for page {page_number}"}), 500

    log.info(f"Successfully extracted {len(extracted_data)} items for page {page_number}.")
    return jsonify({"success": True, "page": page_number, "data": extracted_data}), 200


@app.route('/fetch-book-details', methods=['GET'])
def fetch_book_details():
    """Navigates to a book URL and extracts specification details."""
    book_url_encoded = request.args.get('url')
    if not book_url_encoded:
        log.warning("'/fetch-book-details' called without 'url' parameter.")
        abort(400, description="Missing required 'url' query parameter.")

    try:
        book_url = unquote(book_url_encoded) # Decode URL
        # Basic URL validation
        parsed = urlparse(book_url)
        if not parsed.scheme or not parsed.netloc:
             raise ValueError("Invalid URL structure (missing scheme or netloc).")
    except Exception as decode_err:
        log.error(f"Invalid or undecodable 'url' parameter provided: '{book_url_encoded}'. Error: {decode_err}")
        abort(400, description=f"Invalid 'url' parameter format or encoding: {decode_err}")

    log.info(f"Request received to fetch details for URL: {book_url}")

    if not driver or not driver.is_ready() or not driver.default_webview_id:
         log.error("Driver not available for '/fetch-book-details'.")
         return jsonify({"success": False, "error": "Backend driver service unavailable"}), 503

    webview_id = driver.default_webview_id

    log.info(f"Navigating webview '{webview_id}' to book detail page: {book_url}")
    navigation_ok = driver.navigate(webview_id, book_url) # Uses default nav timeout
    if not navigation_ok:
        log.error(f"Navigation failed for book detail URL: {book_url}")
        return jsonify({"success": False, "error": "Navigation failed for book details page"}), 500

    log.info(f"Extracting specification details from: {book_url}")
    # Use the specific method for detail extraction
    extracted_details = driver.extract_book_details(
        webview_id
        # Uses default detail extraction timeout from driver
    )

    if extracted_details is None:
        log.error(f"Detail extraction failed for book URL: {book_url}")
        # Decide on response: failure or success with empty data? Failure seems more accurate.
        return jsonify({"success": False, "error": "Data extraction failed for book details page"}), 500
    else:
        log.info(f"Successfully extracted details for book URL: {book_url}")
        # Return details nested under a 'details' key for consistency
        return jsonify({"success": True, "details": extracted_details}), 200


@app.route('/local-image', methods=['GET'])
def serve_local_image():
    """Serves previously downloaded images stored locally by Electron."""
    filename = request.args.get('filename')
    if not filename:
        log.warning("'/local-image' called without 'filename' parameter.")
        abort(400, description="Missing 'filename' query parameter.")

    # Security: Prevent path traversal attacks
    if '/' in filename or '\\' in filename or '..' in filename:
        log.warning(f"Attempted path traversal in '/local-image': {filename}")
        abort(400, description="Invalid characters detected in filename.")

    try:
        # Securely join path and normalize
        image_path = os.path.abspath(os.path.normpath(os.path.join(IMAGE_DOWNLOAD_DIR, filename)))
        base_dir = os.path.abspath(os.path.normpath(IMAGE_DOWNLOAD_DIR))

        # Double-check the path is within the intended directory
        if not image_path.startswith(base_dir):
             log.error(f"Forbidden access attempt for image outside base directory: {image_path}")
             abort(403, description="Access denied: Filename resolves outside allowed directory.")

        # Check if file exists and is readable before sending
        if not os.path.isfile(image_path):
             log.warning(f"Requested local image not found: {image_path}")
             abort(404, description="Image not found on server.")

        log.debug(f"Serving local image: {image_path}")
        # Use send_file for appropriate headers (mime type detection, caching etc.)
        return send_file(image_path, mimetype=None, as_attachment=False) # Let send_file guess mimetype

    except Exception as e:
        # Catch potential errors during path manipulation or file access
        log.exception(f"Error processing request for local image '{filename}': {e}") # Log stack trace
        abort(500, description="Internal server error while processing image request.")


# --- Flask App Execution ---
if __name__ == '__main__':
    # Final check if driver is ready before starting server
    if not driver or not driver.is_ready():
        log.critical("Cannot start Flask server: Electron driver failed post-initialization check.")
    else:
        log.info(f"Starting Python Backend Server on http://localhost:5000...")
        log.info(f"Local image directory configured at: {IMAGE_DOWNLOAD_DIR}")
        if not os.path.isdir(IMAGE_DOWNLOAD_DIR):
             log.warning(f"Local image directory DOES NOT EXIST: {IMAGE_DOWNLOAD_DIR}. Image serving will fail.")
        # Run Flask app - disable debug mode for production/stability
        # Use waitress or gunicorn for a more robust production server if needed
        app.run(host='localhost', port=5000, debug=False)
