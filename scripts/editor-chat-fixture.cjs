/* Loopback model fixture started BEFORE the editor can probe provider availability. */
const http = require('node:http');

exports.startEditorChatFixture = async function () {
  const records = [];
  const server = http.createServer(async (request, response) => {
    if (request.url === '/api/tags') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ models: [{ name: 'qwen3-coder' }] }));
      return;
    }
    if (request.url === '/__fixture/requests' && request.method === 'GET') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(records.map(({ marker, prompt, closed }) => ({ marker, prompt, closed }))));
      return;
    }
    if (request.url === '/__fixture/reset' && request.method === 'POST') {
      for (const record of records) { record.response.destroy(); }
      records.length = 0;
      response.end('ok');
      return;
    }
    if (request.method !== 'POST' || request.url !== '/api/chat') { response.writeHead(404).end(); return; }
    try {
      let body = '';
      for await (const part of request) {
        body += part;
        if (body.length > 1024 * 1024) { response.writeHead(413).end(); return; }
      }
      const payload = JSON.parse(body);
      const prompt = payload.messages.map(message => message.content).join('\n');
      const markers = [...prompt.matchAll(/MYSTI_FIXTURE:([a-z-]+)/g)];
      const marker = markers[markers.length - 1]?.[1] ?? 'unknown';
      const record = { marker, prompt, closed: false, response };
      records.push(record);
      response.once('close', () => { record.closed = true; });
      if (marker === 'service-error') { response.writeHead(503).end('Fixture service unavailable'); return; }
      response.setHeader('Content-Type', 'application/x-ndjson');
      response.write(JSON.stringify({ message: { content: `Fixture answer ${marker}.` }, done: false }) + '\n');
      if (!marker.startsWith('hold-')) {
        response.end(JSON.stringify({ done: true, prompt_eval_count: 10, eval_count: 5 }) + '\n');
      }
    } catch {
      if (!response.headersSent) { response.writeHead(400); }
      response.end();
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  server.unref();
  return `http://127.0.0.1:${server.address().port}`;
};
