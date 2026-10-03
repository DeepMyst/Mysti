import { describe, expect, it, vi } from 'vitest';
import { StitchService } from '../../src/services/StitchService';

describe('Stitch SDK loading', () => {
  it('loads and caches the real SDK exports without making a service call', async () => {
    const service = new StitchService();
    // Exercise module loading only: no key, client, connection or paid operation.
    const sdk = await service['_loadSdk']();
    expect(sdk.Stitch).toBeTypeOf('function');
    expect(sdk.StitchToolClient).toBeTypeOf('function');
    expect(sdk.StitchError).toBeTypeOf('function');
    expect(await service['_loadSdk']()).toBe(sdk);
  });
});

function serviceWithResponse(response: unknown) {
  const service = new StitchService();
  service.setApiKey('test-key');
  const callTool = vi.fn(async () => response);
  Object.defineProperty(service, '_getToolClient', { value: async () => ({ callTool }) });
  return { service, callTool };
}

describe('Stitch response boundary', () => {
  const screenFiles = {
    htmlCode: { downloadUrl: 'https://example.com/screen.html' },
    screenshot: { downloadUrl: 'https://example.com/screen.png' },
  };
  it.each([
    ['flat id', { id: 'screen', ...screenFiles }],
    ['flat screenId', { screenId: 'screen', ...screenFiles }],
    ['direct design', { design: { screens: [{ id: 'screen', ...screenFiles }] } }],
    ['top-level screens', { screens: [{ screenId: 'screen', ...screenFiles }] }],
    ['named screen in direct design', { design: { screens: [{ name: 'projects/p/screens/screen', ...screenFiles }] } }],
    ['output component', { outputComponents: [{ design: { screens: [{ id: 'screen', ...screenFiles }] } }] }],
    ['top-level fallback after a design system', { outputComponents: [{ designSystem: {} }], screens: [{ id: 'screen', ...screenFiles }] }],
  ])('preserves the supported %s response format', async (_name, response) => {
    const { service } = serviceWithResponse(response);
    await expect(service.generateScreenWithRaw('p', 'Build a page')).resolves.toEqual({
      ref: {
        projectId: 'p', screenId: 'screen',
        htmlUrl: screenFiles.htmlCode.downloadUrl, imageUrl: screenFiles.screenshot.downloadUrl,
      },
      raw: response,
    });
  });

  it('accepts a project resource name and returns its normalized ID', async () => {
    const { service } = serviceWithResponse({ name: 'projects/project-id', title: 'App' });
    await expect(service.createProject('App')).resolves.toEqual({ id: 'project-id', name: 'projects/project-id', title: 'App' });
  });

  it('keeps the validated project ID when the response also contains a malformed id', async () => {
    const { service } = serviceWithResponse({ projectId: 'valid', id: 42 });
    await expect(service.createProject('App')).resolves.toEqual({ projectId: 'valid', id: 'valid' });
  });

  it.each([null, [], 'project', { id: 42 }, { name: [] }])('rejects malformed project identifiers: %j', async response => {
    const { service } = serviceWithResponse(response);
    await expect(service.createProject('App')).rejects.toThrow('Stitch did not return a project ID');
  });

  it('finds a valid screen after malformed components and skips malformed download URLs', async () => {
    const response = { outputComponents: [null, { designSystem: {} }, { design: { screens: [
      null, { id: 42 }, { name: 'projects/p/screens/s', htmlCode: { downloadUrl: [] }, screenshot: { downloadUrl: 'https://example.com/s.png' } },
    ] } }] };
    const { service } = serviceWithResponse(response);
    await expect(service.generateScreen('p', 'App')).resolves.toEqual({
      projectId: 'p', screenId: 's', htmlUrl: undefined, imageUrl: 'https://example.com/s.png',
    });
  });

  it.each([null, { outputComponents: {} }, { screens: [{ id: {} }] }])('rejects responses without a valid screen: %j', async response => {
    const { service } = serviceWithResponse(response);
    await expect(service.generateScreen('p', 'App')).rejects.toThrow('could not extract screen ID');
  });

  it('returns only valid variant identifiers', async () => {
    const { service } = serviceWithResponse({ outputComponents: [{ design: { screens: [
      null, { id: 42 }, { id: 'a' }, { screenId: 'b' },
    ] } }] });
    const refs = await service.generateVariants({ projectId: 'p', screenId: 's' }, 'Edit', {
      variantCount: 2, creativeRange: 'EXPLORE', aspects: [],
    });
    expect(refs.map(ref => ref.screenId)).toEqual(['a', 'b']);
  });

  it('filters non-object project and screen list entries', async () => {
    const { service } = serviceWithResponse({ projects: [null, 42, { id: 'p' }], screens: 'invalid' });
    await expect(service.listProjects()).resolves.toEqual([{ id: 'p' }]);
    await expect(service.listScreens('p')).resolves.toEqual([]);
  });

  it('does not return malformed design metadata as typed text', () => {
    const { service } = serviceWithResponse(null);
    expect(service.extractDesignSystemFromRaw({ outputComponents: [{ designSystem: {
      displayName: {}, theme: { bodyFont: ['Inter'], designMd: '# Design' },
    } }] })).toEqual({
      displayName: undefined, designMd: '# Design', colorMode: undefined,
      customColor: undefined, bodyFont: undefined,
    });
  });

  it('treats a non-object design DNA response as unavailable', async () => {
    const { service } = serviceWithResponse(['invalid']);
    await expect(service.extractDesignDna({ projectId: 'p', screenId: 's' })).resolves.toEqual({});
  });
});
