// Compiled only by the minimum-host project. Positive controls verify the
// required Node/Web APIs; unused expect-error directives expose accidental
// inclusion of newer Node or browser declarations.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { inspect } from 'node:util';

createHash('sha256').update(Buffer.from('minimum'));
void inspect({ minimum: true });
void readFile('fixture');
void fetch('http://127.0.0.1/', { signal: AbortSignal.timeout(1), headers: new Headers() });
void new Response('ok').body?.getReader();
void Readable.toWeb(Readable.from(['ok']));
void new DOMException('stopped', 'AbortError');

// @ts-expect-error util.styleText was introduced after Node 18.17.1.
import { styleText } from 'node:util';
void styleText;
// @ts-expect-error Global File is not available in Node 18.17.1.
void new File([], 'not-in-minimum');
// @ts-expect-error Browser globals must not enter the extension-host project.
void document.createElement('div');
