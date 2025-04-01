# python_client/backend_app.py
import os
import logging
from flask import Flask, jsonify, request, Response, send_file, abort
from flask_cors import CORS
# ** Ensure driver is imported correctly **
from driver import ElectronBridgeDriver
from urllib.parse import urlparse, parse_qs, urlencode, urlunparse, unquote
import time # Import time for potential delays if needed

# --- Configure Logging ---
log_format = '%(asctime)s [%(levelname)s] [BackendApp] %(message)s (%(filename)s:%(lineno)d)'
logging.basicConfig(level=logging.INFO, format=log_format, datefmt='%Y-%m-%d %H:%M:%S')
log = logging.getLogger(__name__)

# --- Flask App Setup ---
app = Flask(__name__)
CORS(app)
log.info("Flask app created and CORS enabled.")

# --- Configuration & Driver Initialization ---
backend_script_dir = os.path.dirname(os.path.abspath(__file__))
DRIVER_CONFIG_PATH = os.path.join(backend_script_dir, "config.json")
ELECTRON_APP_DIR = os.path.abspath(os.path.join(backend_script_dir, '..', 'electron_app'))
IMAGE_DOWNLOAD_DIR = os.path.join(ELECTRON_APP_DIR, 'downloaded_images')

log.info(f"Backend script directory: {backend_script_dir}")
log.info(f"Expecting driver config at: {DRIVER_CONFIG_PATH}")
log.info(f"Calculated Electron app directory: {ELECTRON_APP_DIR}")
log.info(f"Expecting local images in: {IMAGE_DOWNLOAD_DIR}")

if not os.path.isfile(DRIVER_CONFIG_PATH):
     log.critical(f"Driver config file not found at {DRIVER_CONFIG_PATH}. Backend cannot start.")
     exit(f"Driver config missing: {DRIVER_CONFIG_PATH}")
if not os.path.isdir(os.path.dirname(IMAGE_DOWNLOAD_DIR)):
     log.warning(f"Base directory for Electron app not found at calculated path: {ELECTRON_APP_DIR}. Image serving might fail.")

try:
    driver = ElectronBridgeDriver(config_path=DRIVER_CONFIG_PATH)
    if not driver.is_ready():
        log.critical("Electron Bridge Driver failed to initialize properly.")
        exit("Driver initialization failed. Exiting backend.")
    log.info("Electron Bridge Driver initialized successfully.")
except Exception as e:
    log.exception("Critical error during Driver initialization.")
    exit(f"Failed to initialize driver: {e}")


# --- Default URLs and Settings ---
DEFAULT_TARGET_URL = "https://www.anticexlibris.ro/carti-de-literatura-contemporana-in-engleza?filter=-2/l/1"
DEFAULT_POST_NAV_DELAY_S = 2

# --- URL Helper ---
def _add_or_update_query_param(url_str, param_name, param_value):
    """Safely adds or updates a query parameter in a URL string."""
    try:
        parsed_url = urlparse(url_str)
        query_params = parse_qs(parsed_url.query)
        query_params[param_name] = [str(param_value)]
        new_query_string = urlencode(query_params, doseq=True)
        return urlunparse((
            parsed_url.scheme, parsed_url.netloc, parsed_url.path,
            parsed_url.params, new_query_string, parsed_url.fragment
        ))
    except Exception as e:
        log.error(f"Error manipulating URL '{url_str}': {e}")
        return url_str


# --- API Endpoints ---

@app.route('/fetch-page-data', methods=['GET'])
def fetch_page_data():
    """Fetches book list data for a given page number."""
    page_str = request.args.get('page', default='1', type=str)
    base_url = request.args.get('base_url', default=DEFAULT_TARGET_URL, type=str)

    try:
        page_number = int(page_str)
        if page_number <= 0: page_number = 1
    except ValueError:
        log.warning(f"Invalid 'page' parameter '{page_str}'. Defaulting to 1.")
        page_number = 1

    log.info(f"Request received for book list page {page_number} (Base URL: {base_url})")

    if not driver or not driver.is_ready() or not driver.default_webview_id:
         log.error("Driver not available for '/fetch-page-data'.")
         return jsonify({"success": False, "error": "Backend driver service unavailable"}), 503

    webview_id = driver.default_webview_id
    target_url = _add_or_update_query_param(base_url, 'page', page_number)

    log.info(f"Navigating webview '{webview_id}' to page {page_number}: {target_url}")
    navigation_ok = driver.navigate(webview_id, target_url)
    if not navigation_ok:
        log.error(f"Navigation failed for page {page_number} URL: {target_url}")
        return jsonify({"success": False, "error": f"Navigation failed for page {page_number}"}), 500

    log.info(f"Extracting list data for page {page_number}...")
    extracted_data = driver.extract_list_data(
        webview_id,
        post_nav_delay_seconds=DEFAULT_POST_NAV_DELAY_S
    )

    if extracted_data is None:
        log.error(f"List data extraction failed for page {page_number} URL: {target_url}")
        return jsonify({"success": False, "error": f"Data extraction failed for page {page_number}"}), 500

    log.info(f"Successfully extracted {len(extracted_data)} items for page {page_number}.")
    return jsonify({"success": True, "page": page_number, "data": extracted_data}), 200


@app.route('/fetch-book-details-and-prices', methods=['GET']) # Renamed endpoint
def fetch_book_details_and_prices():
    """Navigates to a book URL and extracts specs and prices."""
    book_url_encoded = request.args.get('url')
    if not book_url_encoded:
        log.warning("'/fetch-book-details-and-prices' called without 'url' parameter.")
        abort(400, description="Missing required 'url' query parameter.")

    try:
        book_url = unquote(book_url_encoded)
        parsed = urlparse(book_url)
        if not parsed.scheme or not parsed.netloc: raise ValueError("Invalid URL structure")
    except Exception as decode_err:
        log.error(f"Invalid or undecodable 'url' parameter provided: '{book_url_encoded}'. Error: {decode_err}")
        abort(400, description=f"Invalid 'url' parameter format or encoding: {decode_err}")

    log.info(f"Request received to fetch details & prices for URL: {book_url}")

    if not driver or not driver.is_ready() or not driver.default_webview_id:
         log.error("Driver not available for '/fetch-book-details-and-prices'.")
         return jsonify({"success": False, "error": "Backend driver service unavailable"}), 503

    webview_id = driver.default_webview_id

    log.info(f"Navigating webview '{webview_id}' to book detail/price page: {book_url}")
    navigation_ok = driver.navigate(webview_id, book_url)
    if not navigation_ok:
        log.error(f"Navigation failed for book detail/price URL: {book_url}")
        return jsonify({"success": False, "error": "Navigation failed for book page"}), 500

    # Add a small delay AFTER navigation succeeds, before extraction
    post_nav_delay = 1.0 # seconds - adjust as needed
    log.info(f"Waiting {post_nav_delay}s post-navigation before detail/price extraction...")
    time.sleep(post_nav_delay)

    log.info(f"Extracting specification & price details from: {book_url}")
    # Call the new combined driver method
    extracted_data = driver.extract_book_details_and_prices(webview_id)

    if extracted_data is None:
        log.error(f"Detail/Price extraction failed for book URL: {book_url}")
        return jsonify({"success": False, "error": "Data extraction failed for book page"}), 500
    else:
        log.info(f"Successfully extracted details & prices for book URL: {book_url}")
        # Return both specs and prices under their respective keys
        return jsonify({
            "success": True,
            "details": extracted_data.get("details", {}), # Keep details for cache compatibility
            "prices": extracted_data.get("prices", {}) # Main payload for tracker
        }), 200


@app.route('/local-image', methods=['GET'])
def serve_local_image():
    """Serves previously downloaded images stored locally by Electron."""
    filename = request.args.get('filename')
    if not filename:
        log.warning("'/local-image' called without 'filename' parameter.")
        abort(400, description="Missing 'filename' query parameter.")

    if '/' in filename or '\\' in filename or '..' in filename:
        log.warning(f"Attempted path traversal in '/local-image': {filename}")
        abort(400, description="Invalid characters detected in filename.")

    try:
        image_path = os.path.abspath(os.path.normpath(os.path.join(IMAGE_DOWNLOAD_DIR, filename)))
        base_dir = os.path.abspath(os.path.normpath(IMAGE_DOWNLOAD_DIR))

        if not image_path.startswith(base_dir):
             log.error(f"Forbidden access attempt for image outside base directory: {image_path}")
             abort(403, description="Access denied: Filename resolves outside allowed directory.")

        if not os.path.isfile(image_path):
             log.warning(f"Requested local image not found: {image_path}")
             abort(404, description="Image not found on server.")

        log.debug(f"Serving local image: {image_path}")
        return send_file(image_path, mimetype=None, as_attachment=False)

    except Exception as e:
        log.exception(f"Error processing request for local image '{filename}': {e}")
        abort(500, description="Internal server error while processing image request.")


# --- Flask App Execution ---
if __name__ == '__main__':
    if not driver or not driver.is_ready():
        log.critical("Cannot start Flask server: Electron driver failed post-initialization check.")
    else:
        log.info(f"Starting Python Backend Server on http://localhost:5000...")
        log.info(f"Local image directory configured at: {IMAGE_DOWNLOAD_DIR}")
        if not os.path.isdir(IMAGE_DOWNLOAD_DIR):
             log.warning(f"Local image directory DOES NOT EXIST: {IMAGE_DOWNLOAD_DIR}. Image serving will fail.")
        app.run(host='localhost', port=5000, debug=False)
