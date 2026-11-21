'use strict';
/* On Cloudflare Workers the AWS SDK's default Node https handler hangs, so the
   Worker is killed (error 1101, no CORS headers, browser sees "Failed to fetch").
   There, S3 clients must send their requests with fetch(). On Node (Render, local)
   the default handler is kept. */
const onWorkers = typeof navigator !== 'undefined' && navigator.userAgent === 'Cloudflare-Workers';

function r2RequestHandler() {
    if (!onWorkers) return {};
    const { FetchHttpHandler } = require('@smithy/fetch-http-handler');
    // The SDK's own collectors need Node streams or FileReader; Workers have neither.
    const streamCollector = async body => new Uint8Array(await new Response(body).arrayBuffer());
    return { requestHandler: new FetchHttpHandler(), streamCollector };
}

module.exports = { r2RequestHandler };
