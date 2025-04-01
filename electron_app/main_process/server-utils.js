// electron_app/main_process/server-utils.js

/** Sends a JSON error response */
function sendError(res, statusCode, message) {
    console.error(`[HTTP Srv Err ${statusCode}] ${message}`);
    try {
        if (!res.headersSent) {
            res.writeHead(statusCode, {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*' // Keep CORS header
            });
        } else {
            console.warn(`[HTTP Srv Warn] Headers already sent before error ${statusCode}: ${message}`);
        }
        res.end(JSON.stringify({ success: false, error: message }));
    } catch (err) {
        console.error(`[HTTP Srv CRIT] Error sending error response: ${err}`);
    }
}

/** Sends a JSON success response */
function sendSuccess(res, data) {
    // Ensure the response always has a 'success: true' field if data doesn't
    const responsePayload = (typeof data === 'object' && data !== null && typeof data.success !== 'undefined')
        ? data
        : { success: true, ...data };

    try {
        if (!res.headersSent) {
            res.writeHead(200, {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*' // Keep CORS header
            });
        } else {
             console.warn(`[HTTP Srv Warn] Headers already sent before success response.`);
        }
        res.end(JSON.stringify(responsePayload));
    } catch (err) {
        console.error(`[HTTP Srv Err] Error sending success response: ${err}`);
        // Attempt to send an error if we failed to send success and headers weren't already sent
        if (!res.headersSent) {
            sendError(res, 500, 'Internal Server Error: Failed to serialize success response.');
        }
    }
}

module.exports = {
    sendError,
    sendSuccess
};