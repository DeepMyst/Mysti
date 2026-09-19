// Node 18.17 exposes these Web APIs, but its contemporary @types/node omitted
// their global declarations. Use the types from its actual bundled Undici.
// Do not import lib.dom: it would admit unavailable host globals such as File.
import * as web from './undici/fetch';
import * as streams from 'node:stream/web';

declare global {
  var fetch: typeof web.fetch;
  var Headers: typeof web.Headers;
  type Headers = web.Headers;
  type HeadersInit = web.HeadersInit;
  var Request: typeof web.Request;
  type Request = web.Request;
  type RequestInit = web.RequestInit;
  var Response: typeof web.Response;
  type Response = web.Response;
  type ResponseInit = web.ResponseInit;
  type ReadableStreamDefaultReader<R = any> = streams.ReadableStreamDefaultReader<R>;
  class DOMException extends Error {
    constructor(message?: string, name?: string);
    readonly code: number;
  }
}
