/**
 * CanvasManager tests — unified prompt parsing, renderPage, and session CRUD.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { clearMockConfig, setMockConfig } from '../helpers/mockVscode';
import { CanvasManager } from '../../src/managers/CanvasManager';
import type { CanvasStreamChunk } from '../../src/types';

// Mock extension context with minimal globalState
function createMockContext(): any {
  return {
    globalState: {
      get: () => undefined,
      update: () => Promise.resolve(),
    },
    subscriptions: [],
  };
}

// Collect all chunks from an async generator
async function collectChunks(gen: AsyncGenerator<CanvasStreamChunk>): Promise<CanvasStreamChunk[]> {
  const chunks: CanvasStreamChunk[] = [];
  for await (const chunk of gen) {
    chunks.push(chunk);
  }
  return chunks;
}

describe('CanvasManager', () => {
  let manager: CanvasManager;

  beforeEach(() => {
    clearMockConfig();
    manager = new CanvasManager(createMockContext());
  });

  // =========================================================================
  // parseUnifiedPrompt — slash command parsing
  // =========================================================================
  describe('parseUnifiedPrompt', () => {
    it('should parse /render with URL', () => {
      const result = CanvasManager.parseUnifiedPrompt('/render http://localhost:3000');
      expect(result.action).toBe('render');
      expect(result.argument).toBe('http://localhost:3000');
    });

    it('should parse /render with https URL', () => {
      const result = CanvasManager.parseUnifiedPrompt('/render https://example.com/page');
      expect(result.action).toBe('render');
      expect(result.argument).toBe('https://example.com/page');
    });

    it('should parse /render with no argument (auto-detect)', () => {
      const result = CanvasManager.parseUnifiedPrompt('/render');
      expect(result.action).toBe('render');
      expect(result.argument).toBe('');
    });

    it('should parse /render with CSS class selector', () => {
      const result = CanvasManager.parseUnifiedPrompt('/render .hero-section');
      expect(result.action).toBe('render');
      expect(result.argument).toBe('.hero-section');
    });

    it('should parse /render with CSS id selector', () => {
      const result = CanvasManager.parseUnifiedPrompt('/render #main-content');
      expect(result.action).toBe('render');
      expect(result.argument).toBe('#main-content');
    });

    it('should parse /render with attribute selector', () => {
      const result = CanvasManager.parseUnifiedPrompt('/render [data-testid="hero"]');
      expect(result.action).toBe('render');
      expect(result.argument).toBe('[data-testid="hero"]');
    });

    it('should parse /generate with description', () => {
      const result = CanvasManager.parseUnifiedPrompt('/generate a modern SaaS landing page');
      expect(result.action).toBe('generate');
      expect(result.argument).toBe('a modern SaaS landing page');
    });

    it('should parse /generate with no description', () => {
      const result = CanvasManager.parseUnifiedPrompt('/generate');
      expect(result.action).toBe('generate');
      expect(result.argument).toBe('');
    });

    it('should parse /reimagine with no argument', () => {
      const result = CanvasManager.parseUnifiedPrompt('/reimagine');
      expect(result.action).toBe('reimagine');
      expect(result.argument).toBe('');
    });

    it('should parse /reimagine with guidance text', () => {
      const result = CanvasManager.parseUnifiedPrompt('/reimagine make it darker and more modern');
      expect(result.action).toBe('reimagine');
      expect(result.argument).toBe('make it darker and more modern');
    });

    it('should treat plain text as prompt action', () => {
      const result = CanvasManager.parseUnifiedPrompt('make the header background blue');
      expect(result.action).toBe('prompt');
      expect(result.argument).toBe('make the header background blue');
    });

    it('should treat text not starting with known slash as prompt', () => {
      const result = CanvasManager.parseUnifiedPrompt('what colors are used in this design?');
      expect(result.action).toBe('prompt');
      expect(result.argument).toBe('what colors are used in this design?');
    });

    it('should handle leading/trailing whitespace', () => {
      const result = CanvasManager.parseUnifiedPrompt('  /render http://localhost:3000  ');
      expect(result.action).toBe('render');
      expect(result.argument).toBe('http://localhost:3000');
    });

    it('should handle empty string as prompt', () => {
      const result = CanvasManager.parseUnifiedPrompt('');
      expect(result.action).toBe('prompt');
      expect(result.argument).toBe('');
    });

    it('should handle /render with localhost:port format', () => {
      const result = CanvasManager.parseUnifiedPrompt('/render localhost:5173');
      expect(result.action).toBe('render');
      expect(result.argument).toBe('localhost:5173');
    });
  });

  // =========================================================================
  // renderPage — headless browser screenshot flow
  // =========================================================================
  describe('renderPage', () => {
    function createMockBrowserManager() {
      const mockPage = {
        url: () => 'http://localhost:3000',
        waitForTimeout: vi.fn().mockResolvedValue(undefined),
        screenshot: vi.fn().mockResolvedValue(Buffer.from('fake-png-data')),
        $: vi.fn().mockResolvedValue({
          screenshot: vi.fn().mockResolvedValue(Buffer.from('element-png-data')),
        }),
      };
      return {
        launch: vi.fn().mockResolvedValue(mockPage),
        close: vi.fn().mockResolvedValue(undefined),
        getPage: vi.fn().mockReturnValue(mockPage),
        _mockPage: mockPage,
      };
    }

    function createMockScreenshotService() {
      return {
        capture: vi.fn().mockResolvedValue({
          id: 'screenshot-1',
          iteration: 0,
          timestamp: Date.now(),
          filePath: '/tmp/screenshot.png',
          base64Data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQABNjN9GQA=',
          label: 'canvas-render',
          url: 'http://localhost:3000',
        }),
      };
    }

    function createMockDevServerManager(running = false, url = 'http://localhost:3000') {
      return {
        isRunning: vi.fn().mockReturnValue(running),
        getUrl: vi.fn().mockReturnValue(running ? url : null),
        start: vi.fn().mockResolvedValue({ url, pid: 12345 }),
        stop: vi.fn().mockResolvedValue(undefined),
        detectDevCommand: vi.fn(),
      };
    }

    it('should render page with explicit URL', async () => {
      const browserMgr = createMockBrowserManager();
      const screenshotSvc = createMockScreenshotService();
      const devServerMgr = createMockDevServerManager();

      const chunks = await collectChunks(
        manager.renderPage(
          'canvas-1',
          'panel-1',
          'http://localhost:3000',
          browserMgr as any,
          screenshotSvc as any,
          devServerMgr as any
        )
      );

      // Should have started, progressed, and completed
      expect(chunks.length).toBeGreaterThanOrEqual(3);
      expect(chunks[0].type).toBe('canvas_render_started');
      expect(chunks[chunks.length - 1].type).toBe('canvas_render_complete');
      expect(chunks[chunks.length - 1].imageBase64).toBeTruthy();

      // Browser should have been launched and closed
      expect(browserMgr.launch).toHaveBeenCalledOnce();
      expect(browserMgr.close).toHaveBeenCalledOnce();

      // Screenshot service should have been called
      expect(screenshotSvc.capture).toHaveBeenCalledOnce();
      const captureArgs = screenshotSvc.capture.mock.calls[0][1];
      expect(captureArgs.mode).toBe('viewport');
    });

    it('should render element with CSS selector', async () => {
      const browserMgr = createMockBrowserManager();
      const screenshotSvc = createMockScreenshotService();
      const devServerMgr = createMockDevServerManager(true);

      const chunks = await collectChunks(
        manager.renderPage(
          'canvas-1',
          'panel-1',
          '.hero-section',
          browserMgr as any,
          screenshotSvc as any,
          devServerMgr as any
        )
      );

      expect(chunks[chunks.length - 1].type).toBe('canvas_render_complete');

      // Should use element mode
      const captureArgs = screenshotSvc.capture.mock.calls[0][1];
      expect(captureArgs.mode).toBe('element');
      expect(captureArgs.elementSelector).toBe('.hero-section');
    });

    it('should render element with ID selector', async () => {
      const browserMgr = createMockBrowserManager();
      const screenshotSvc = createMockScreenshotService();
      const devServerMgr = createMockDevServerManager(true);

      const chunks = await collectChunks(
        manager.renderPage(
          'canvas-1',
          'panel-1',
          '#main-content',
          browserMgr as any,
          screenshotSvc as any,
          devServerMgr as any
        )
      );

      expect(chunks[chunks.length - 1].type).toBe('canvas_render_complete');
      const captureArgs = screenshotSvc.capture.mock.calls[0][1];
      expect(captureArgs.mode).toBe('element');
      expect(captureArgs.elementSelector).toBe('#main-content');
    });

    it('should auto-detect running dev server when no URL given', async () => {
      const browserMgr = createMockBrowserManager();
      const screenshotSvc = createMockScreenshotService();
      const devServerMgr = createMockDevServerManager(true, 'http://localhost:5173');

      const chunks = await collectChunks(
        manager.renderPage(
          'canvas-1',
          'panel-1',
          '',  // no URL — auto-detect
          browserMgr as any,
          screenshotSvc as any,
          devServerMgr as any
        )
      );

      expect(chunks[chunks.length - 1].type).toBe('canvas_render_complete');
      expect(devServerMgr.isRunning).toHaveBeenCalledWith('panel-1');

      // Should have used the detected URL
      const launchArgs = browserMgr.launch.mock.calls[0][1];
      expect(launchArgs.url).toBe('http://localhost:5173');
    });

    it('should yield error when no dev server and no URL', async () => {
      const browserMgr = createMockBrowserManager();
      const screenshotSvc = createMockScreenshotService();
      const devServerMgr = createMockDevServerManager(false);

      const chunks = await collectChunks(
        manager.renderPage(
          'canvas-1',
          'panel-1',
          '',
          browserMgr as any,
          screenshotSvc as any,
          devServerMgr as any
        )
      );

      const errorChunk = chunks.find(c => c.type === 'canvas_error');
      expect(errorChunk).toBeDefined();
      expect(errorChunk!.error).toContain('No dev server found');

      // Browser should NOT have been launched
      expect(browserMgr.launch).not.toHaveBeenCalled();
    });

    it('should handle browser launch failure gracefully', async () => {
      const browserMgr = createMockBrowserManager();
      browserMgr.launch.mockRejectedValue(new Error('Failed to launch chromium'));
      const screenshotSvc = createMockScreenshotService();
      const devServerMgr = createMockDevServerManager();

      const chunks = await collectChunks(
        manager.renderPage(
          'canvas-1',
          'panel-1',
          'http://localhost:3000',
          browserMgr as any,
          screenshotSvc as any,
          devServerMgr as any
        )
      );

      const errorChunk = chunks.find(c => c.type === 'canvas_error');
      expect(errorChunk).toBeDefined();
      expect(errorChunk!.error).toContain('Render failed');

      // Should still try to close browser on error
      expect(browserMgr.close).toHaveBeenCalled();
    });

    it('should show Playwright install hint when playwright is missing', async () => {
      const browserMgr = createMockBrowserManager();
      browserMgr.launch.mockRejectedValue(new Error('Cannot find module playwright'));
      const screenshotSvc = createMockScreenshotService();
      const devServerMgr = createMockDevServerManager();

      const chunks = await collectChunks(
        manager.renderPage(
          'canvas-1',
          'panel-1',
          'http://localhost:3000',
          browserMgr as any,
          screenshotSvc as any,
          devServerMgr as any
        )
      );

      const errorChunk = chunks.find(c => c.type === 'canvas_error');
      expect(errorChunk).toBeDefined();
      expect(errorChunk!.error).toContain('Playwright not installed');
      expect(errorChunk!.error).toContain('npm install playwright');
    });

    it('should handle screenshot capture failure', async () => {
      const browserMgr = createMockBrowserManager();
      const screenshotSvc = createMockScreenshotService();
      screenshotSvc.capture.mockRejectedValue(new Error('Element not found: .missing'));
      const devServerMgr = createMockDevServerManager();

      const chunks = await collectChunks(
        manager.renderPage(
          'canvas-1',
          'panel-1',
          'http://localhost:3000',
          browserMgr as any,
          screenshotSvc as any,
          devServerMgr as any
        )
      );

      const errorChunk = chunks.find(c => c.type === 'canvas_error');
      expect(errorChunk).toBeDefined();
      expect(errorChunk!.error).toContain('Element not found');
    });

    it('should prepend http:// to localhost URLs', async () => {
      const browserMgr = createMockBrowserManager();
      const screenshotSvc = createMockScreenshotService();
      const devServerMgr = createMockDevServerManager();

      await collectChunks(
        manager.renderPage(
          'canvas-1',
          'panel-1',
          'localhost:5173',
          browserMgr as any,
          screenshotSvc as any,
          devServerMgr as any
        )
      );

      const launchArgs = browserMgr.launch.mock.calls[0][1];
      expect(launchArgs.url).toBe('http://localhost:5173');
    });

    it('should include label and URL in completion chunk', async () => {
      const browserMgr = createMockBrowserManager();
      const screenshotSvc = createMockScreenshotService();
      const devServerMgr = createMockDevServerManager();

      const chunks = await collectChunks(
        manager.renderPage(
          'canvas-1',
          'panel-1',
          'http://localhost:3000',
          browserMgr as any,
          screenshotSvc as any,
          devServerMgr as any
        )
      );

      const complete = chunks.find(c => c.type === 'canvas_render_complete');
      expect(complete).toBeDefined();
      expect(complete!.label).toContain('Render:');
      expect(complete!.url).toBe('http://localhost:3000');
    });
  });

  // =========================================================================
  // Session CRUD
  // =========================================================================
  describe('createSession', () => {
    it('should create a session with a UUID and timestamp', () => {
      const session = manager.createSession('Test Canvas');
      expect(session.id).toBeTruthy();
      expect(session.name).toBe('Test Canvas');
      expect(session.createdAt).toBeGreaterThan(0);
      expect(session.updatedAt).toBeGreaterThan(0);
      expect(session.canvasJson).toContain('"objects":[]');
      expect(session.assetPaths).toEqual([]);
    });

    it('should generate unique IDs', () => {
      const s1 = manager.createSession('A');
      const s2 = manager.createSession('B');
      expect(s1.id).not.toBe(s2.id);
    });
  });

  // =========================================================================
  // Snapshot building
  // =========================================================================
  describe('buildSnapshot', () => {
    it('should build snapshot from empty canvas', () => {
      const snapshot = manager.buildSnapshot(
        { version: '6.0.0', objects: [] },
        'base64image'
      );
      expect(snapshot.imageBase64).toBe('base64image');
      expect(snapshot.sceneDescription).toBe('Empty canvas.');
      expect(snapshot.objects).toEqual([]);
      expect(snapshot.selectedRegion).toBeUndefined();
    });

    it('should describe objects in scene description', () => {
      const canvasJson = {
        version: '6.0.0',
        objects: [
          { type: 'i-text', left: 10, top: 20, width: 100, height: 30, text: 'Hello World' },
          { type: 'path', left: 50, top: 60, width: 200, height: 150 },
        ],
      };
      const snapshot = manager.buildSnapshot(canvasJson, 'img');
      expect(snapshot.objects).toHaveLength(2);
      expect(snapshot.objects[0].type).toBe('text');
      expect(snapshot.objects[0].content).toBe('Hello World');
      expect(snapshot.objects[1].type).toBe('path');
      expect(snapshot.sceneDescription).toContain('2 object(s)');
      expect(snapshot.sceneDescription).toContain('Hello World');
    });

    it('should include selected region when provided', () => {
      const canvasJson = {
        version: '6.0.0',
        objects: [
          { type: 'rect', left: 10, top: 10, width: 100, height: 100 },
          { type: 'rect', left: 500, top: 500, width: 50, height: 50 },
        ],
      };
      const snapshot = manager.buildSnapshot(canvasJson, 'img', {
        imageBase64: 'regionimg',
        bounds: { left: 0, top: 0, width: 200, height: 200 },
      });
      expect(snapshot.selectedRegion).toBeDefined();
      expect(snapshot.selectedRegion!.imageBase64).toBe('regionimg');
      // First rect is within bounds, second is not
      expect(snapshot.selectedRegion!.objects).toHaveLength(1);
    });

    it('should handle image objects with src', () => {
      const canvasJson = {
        version: '6.0.0',
        objects: [
          { type: 'image', left: 0, top: 0, width: 200, height: 150, src: 'data:image/png;base64,abc' },
        ],
      };
      const snapshot = manager.buildSnapshot(canvasJson, 'img');
      expect(snapshot.objects[0].type).toBe('image');
      expect(snapshot.objects[0].imagePath).toBe('data:image/png;base64,abc');
      expect(snapshot.sceneDescription).toContain('image');
    });

    it('should handle group objects with children', () => {
      const canvasJson = {
        version: '6.0.0',
        objects: [
          {
            type: 'group',
            left: 0,
            top: 0,
            width: 300,
            height: 200,
            objects: [
              { id: 'child-1', type: 'rect' },
              { id: 'child-2', type: 'i-text' },
            ],
          },
        ],
      };
      const snapshot = manager.buildSnapshot(canvasJson, 'img');
      expect(snapshot.objects[0].type).toBe('group');
      expect(snapshot.objects[0].children).toEqual(['child-1', 'child-2']);
      expect(snapshot.sceneDescription).toContain('2 children');
    });
  });
});
