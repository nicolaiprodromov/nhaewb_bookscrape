# python_client/driver.py
import requests
import json
import sys
import os
from urllib.parse import quote
import time
import logging

logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] [Driver] %(message)s', datefmt='%Y-%m-%d %H:%M:%S')
log = logging.getLogger(__name__)
DEFAULT_CONFIG_PATH = 'config.json' # Assumes config.json is in the same dir or CWD

class ElectronBridgeDriver:
    def __init__(self, config_path=DEFAULT_CONFIG_PATH):
        self.config, self.server_url, self.default_webview_id, self.timeouts = None, None, None, {}
        # Load config relative to the driver file's directory if path is relative
        if not os.path.isabs(config_path):
             script_dir = os.path.dirname(os.path.abspath(__file__))
             config_path = os.path.join(script_dir, config_path)

        if self._load_config(config_path):
            self.server_url = f"http://localhost:{self.config['electronServerPort']}"
            self.timeouts = self.config.get('timeouts', {})
            log.info(f"Driver Init OK. Server URL: {self.server_url}")
            log.info(f"  Timeouts(ms): Nav={self.timeouts.get('navigation')}, Extract={self.timeouts.get('extraction')}, DetailExtract={self.timeouts.get('detailExtraction')}") # Log detail timeout too
        else:
            log.critical("Driver initialization FAILED. Cannot connect to Electron backend.")
            # Consider raising an exception here to prevent using an uninitialized driver

    def _load_config(self, abs_config_path):
        try:
            log.info(f"Loading driver config from: {abs_config_path}")
            with open(abs_config_path, 'r', encoding='utf-8') as f:
                self.config = json.load(f)

            # --- Config Validation ---
            if not isinstance(self.config, dict): raise ValueError("Config root is not an object.")
            if 'electronServerPort' not in self.config or not isinstance(self.config.get('electronServerPort'), int):
                raise ValueError("Missing or invalid 'electronServerPort' (must be integer).")
            if 'webviews' not in self.config or not isinstance(self.config['webviews'], list) or not self.config['webviews']:
                raise ValueError("Missing, invalid, or empty 'webviews' array.")
            if not all(isinstance(wv, dict) and isinstance(wv.get('id'), str) and wv.get('id') for wv in self.config['webviews']):
                raise ValueError("Invalid webview entry: Each must be an object with a non-empty string 'id'.")
            # Validate timeouts structure and types
            if 'timeouts' in self.config:
                 if not isinstance(self.config['timeouts'], dict):
                     log.warning("'timeouts' key exists but is not an object. Ignoring.")
                     del self.config['timeouts'] # Remove invalid structure
                 else:
                     for key, value in self.config['timeouts'].items():
                         if not isinstance(value, int):
                             log.warning(f"Invalid timeout value for '{key}' (must be integer). Removing.")
                             del self.config['timeouts'][key]

            log.info("Driver config loaded and validated successfully.")
            # Set default webview ID (first one in the list)
            self.default_webview_id = self.config['webviews'][0].get('id')
            log.info(f"Default webview ID set to: {self.default_webview_id}")
            return True

        except FileNotFoundError: log.error(f"Config file NOT FOUND: {abs_config_path}")
        except json.JSONDecodeError as e: log.error(f"Config JSON parsing ERROR: {abs_config_path}: {e}")
        except ValueError as e: log.error(f"Config validation FAILED: {e}")
        except Exception as e: log.exception(f"Unexpected error loading config {abs_config_path}: {e}") # Use log.exception for stack trace
        self.config = None # Ensure config is None on failure
        return False

    def is_ready(self):
        """Checks if the driver was initialized successfully."""
        return self.config is not None and self.server_url is not None

    def get_webview_ids(self):
        """Returns a list of configured webview IDs."""
        return [wv.get('id') for wv in self.config.get('webviews', [])] if self.is_ready() else []

    def _make_request(self, endpoint, params, client_timeout_seconds):
        """Internal helper to make GET requests to the Electron server."""
        if not self.is_ready():
            log.error("Driver not ready, cannot make request.")
            return None

        req_url = f"{self.server_url}{endpoint}"
        log.info(f"Requesting {req_url} (Client Timeout: {client_timeout_seconds:.1f}s)")
        log.debug(f"  Params: {params}")
        response = None
        try:
            response = requests.get(req_url, params=params, timeout=client_timeout_seconds)
            response.raise_for_status() # Raise HTTPError for bad responses (4xx or 5xx)
            log.info(f"--> Server responded OK {response.status_code} for {endpoint}")
            # Try to parse JSON, handle potential errors gracefully
            try:
                return response.json()
            except json.JSONDecodeError:
                 log.error(f"Failed to decode JSON response from {endpoint}. Status: {response.status_code}, Body: {response.text[:200]}...")
                 return None # Treat non-JSON response as failure
        except requests.exceptions.ConnectionError as e:
            log.error(f"Connection Error connecting to Electron server at {self.server_url}: {e}")
        except requests.exceptions.Timeout:
            log.error(f"Request Timeout Error after {client_timeout_seconds:.1f}s for {endpoint}")
        except requests.exceptions.HTTPError as e:
            log.error(f"HTTP Error for {endpoint}: {e}")
            if response is not None:
                log.error(f"    Status Code: {response.status_code}")
                # Try to get error message from JSON body, otherwise use text
                try: log.error(f"    Error Body: {response.json().get('error', response.text[:200])}")
                except json.JSONDecodeError: log.error(f"    Response Body (non-JSON): {response.text[:200]}...")
        except requests.exceptions.RequestException as e:
            log.error(f"General Request Failed for {endpoint}: {e}")
        except Exception as e:
            log.exception(f"Unexpected error during request to {endpoint}: {e}") # Log full stack trace
        return None # Return None on any failure

    def navigate(self, webview_id, target_url, timeout_ms=None):
        """Navigates a specified webview to a target URL."""
        # Use provided timeout, fallback to config, fallback to a safe default
        default_nav_timeout = self.timeouts.get('navigation', 90000)
        nav_timeout_ms = timeout_ms if timeout_ms is not None else default_nav_timeout
        server_timeout_seconds = nav_timeout_ms / 1000
        client_timeout_seconds = server_timeout_seconds + 5 # Client waits a bit longer

        encoded_url = quote(target_url, safe='') # Ensure URL is properly encoded
        params = {
            'id': webview_id,
            'url': encoded_url,
            'timeout': int(server_timeout_seconds) # Pass server-side timeout
        }

        result = self._make_request("/navigate", params, client_timeout_seconds)

        if result is None: return False # Request failed
        if result.get('success'):
            log.info(f"--> Navigation successful for {webview_id}. Final URL: {result.get('loadedUrl', 'N/A')}")
            return True
        else:
            log.error(f"--> Electron server reported navigation failure for {webview_id}: {result.get('error', 'Unknown error')}")
            return False

    def extract_list_data(self, webview_id, post_nav_delay_seconds=2, exec_timeout_ms=None):
        """Extracts book list data using the list extraction script."""
        # Use provided timeout, fallback to config, fallback to default
        default_exec_timeout = self.timeouts.get('extraction', 75000)
        exec_timeout_ms_actual = exec_timeout_ms if exec_timeout_ms is not None else default_exec_timeout
        server_timeout_seconds = exec_timeout_ms_actual / 1000
        client_timeout_seconds = server_timeout_seconds + 5

        log.info(f"Waiting {post_nav_delay_seconds}s post-navigation before list extraction...")
        time.sleep(post_nav_delay_seconds)

        params = {
            'id': webview_id,
            'exec_timeout': int(server_timeout_seconds)
        }

        result = self._make_request("/execute-fetch", params, client_timeout_seconds) # Endpoint for list fetch

        if result is None: return None # Request failed
        if result.get('success'):
            data_list = result.get('data')
            if isinstance(data_list, list):
                log.info(f"--> List data extraction successful for {webview_id}. Found {len(data_list)} items.")
                return data_list
            else:
                 log.error(f"--> List extraction reported success, but 'data' field is not a list (Type: {type(data_list)}). Check list JS script.")
                 return None # Treat unexpected format as failure
        else:
            log.error(f"--> Electron server reported list extraction failure for {webview_id}: {result.get('error', 'Unknown error')}")
            return None

    def extract_book_details(self, webview_id, exec_timeout_ms=None):
        """Extracts book detail data using the detail extraction script."""
        # Use provided timeout, fallback to config (detail specific if exists), fallback to general extraction default
        default_detail_timeout = self.timeouts.get('detailExtraction', self.timeouts.get('extraction', 45000)) # Use specific or general
        exec_timeout_ms_actual = exec_timeout_ms if exec_timeout_ms is not None else default_detail_timeout
        server_timeout_seconds = exec_timeout_ms_actual / 1000
        client_timeout_seconds = server_timeout_seconds + 5

        params = {
            'id': webview_id,
            'exec_timeout': int(server_timeout_seconds)
        }

        log.info(f"Requesting book detail extraction for '{webview_id}'...")
        # Use the specific endpoint for detail extraction
        result = self._make_request("/execute-book-detail-fetch", params, client_timeout_seconds)

        if result is None: return None # Request failed
        if result.get('success'):
            extracted_details = result.get('details') # Expecting 'details' key based on server.js refactor
            if isinstance(extracted_details, dict):
                log.info(f"--> Book detail extraction successful for {webview_id}.")
                return extracted_details # Return the details dictionary
            else:
                log.error(f"--> Detail extraction reported success, but 'details' field is not a dictionary (Type: {type(extracted_details)}). Check detail JS script and server endpoint.")
                return None # Treat unexpected format as failure
        else:
            log.error(f"--> Electron server reported book detail extraction failure for {webview_id}: {result.get('error', 'Unknown error')}")
            return None

# --- Optional Test Block ---
if __name__ == '__main__':
    print("--- Testing ElectronBridgeDriver ---")
    # Assumes config.json is findable from the script's location
    driver = ElectronBridgeDriver()

    if driver.is_ready():
        print(f"Driver Initialized. Server URL: {driver.server_url}")
        wv_ids = driver.get_webview_ids()
        print(f"Configured WebView IDs: {wv_ids}")
        print(f"Default WebView ID: {driver.default_webview_id}")
        print(f"Configured Timeouts (ms): {driver.timeouts}")

        # --- Example Test Calls (Requires Electron App Running) ---
        if driver.default_webview_id:
            test_wv_id = driver.default_webview_id
            print(f"\n--- Attempting tests with default webview: {test_wv_id} ---")

            # 1. Test Navigation
            # target_site = "https://httpbin.org/get" # Simple test site
            # print(f"Attempting navigation to: {target_site}")
            # nav_success = driver.navigate(test_wv_id, target_site)
            # print(f"Navigation Result: {'Success' if nav_success else 'Failed'}")

            # 2. Test List Extraction (Navigate first if needed)
            test_list_url = "https://www.anticexlibris.ro/carti?limit=12" # Example list page
            print(f"\nAttempting list extraction from: {test_list_url}")
            print("  Navigating first...")
            if driver.navigate(test_wv_id, test_list_url):
                print("  Navigation OK, extracting list data...")
                list_data = driver.extract_list_data(test_wv_id, post_nav_delay_seconds=3) # Allow time for page load
                if list_data is not None:
                    print(f"  List Extraction SUCCESS. Found {len(list_data)} items.")
                    # print(f"  First item: {list_data[0] if list_data else 'N/A'}")
                else:
                    print("  List Extraction FAILED.")
            else:
                print("  Navigation failed, cannot test list extraction.")


            # 3. Test Detail Extraction (Navigate first)
            test_detail_url = "https://www.anticexlibris.ro/carte/ready-player-one-ernest-cline" # Example detail page
            print(f"\nAttempting detail extraction from: {test_detail_url}")
            print("  Navigating first...")
            if driver.navigate(test_wv_id, test_detail_url):
                print("  Navigation OK, extracting detail data...")
                detail_data = driver.extract_book_details(test_wv_id)
                if detail_data is not None:
                    print(f"  Detail Extraction SUCCESS: {detail_data}")
                else:
                    print("  Detail Extraction FAILED.")
            else:
                print("  Navigation failed, cannot test detail extraction.")

        else:
            print("\nNo default webview ID configured, cannot run tests.")

    else:
        print("Driver initialization failed. Cannot run tests.")

    print("\n--- Driver Test Complete ---")
