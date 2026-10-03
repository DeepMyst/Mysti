import WebSocket, { WebSocketServer } from 'ws';

/** VS Code 1.86's Electron cannot configure browser downloads through CDP.
 * Canvas tests never download files. Leave that setting untouched while
 * forwarding every target/frame/evaluation command to the real editor.
 */
export async function legacyCdp(endpoint: string): Promise<{ endpoint: string; close(): Promise<void> }> {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const sockets = new Set<WebSocket>();
  server.on('connection', client => {
    const upstream = new WebSocket(endpoint);
    sockets.add(client); sockets.add(upstream);
    const queued: string[] = [];
    client.on('message', bytes => {
      const raw = bytes.toString();
      const message = JSON.parse(raw);
      if (message.method === 'Browser.setDownloadBehavior') {
        client.send(JSON.stringify({ id: message.id, result: {} }));
      } else if (upstream.readyState === WebSocket.OPEN) { upstream.send(raw); }
      else { queued.push(raw); }
    });
    upstream.on('open', () => queued.splice(0).forEach(raw => upstream.send(raw)));
    upstream.on('message', bytes => { if (client.readyState === WebSocket.OPEN) { client.send(bytes.toString()); } });
    const close = () => { client.terminate(); upstream.terminate(); sockets.delete(client); sockets.delete(upstream); };
    client.on('error', close); upstream.on('error', close);
    client.on('close', close); upstream.on('close', close);
  });
  const address = server.address();
  if (!address || typeof address === 'string') { throw new Error('Unable to bind legacy editor inspection'); }
  return { endpoint: `ws://127.0.0.1:${address.port}`, close: async () => {
    sockets.forEach(socket => socket.terminate());
    await new Promise<void>(resolve => server.close(() => resolve()));
  } };
}
