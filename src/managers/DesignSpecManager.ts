/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * Author: Baha Abunojaim <baha@deepmyst.com>
 * Website: https://www.deepmyst.com/mysti
 *
 * This file is part of Mysti, licensed under the Apache License, Version 2.0.
 * See the LICENSE file in the project root for full license terms.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

import * as crypto from 'crypto';
import type {
  DesignSpec,
  DesignNode,
  DesignTheme,
  DesignAssetRef,
  DesignLayout,
  DesignStyle,
  DesignNodeType
} from '../types';

/**
 * Manages the DesignSpec tree: node CRUD, theme resolution, asset registry.
 * Pure data operations — no UI or AI calls.
 */
export class DesignSpecManager {

  // ========================================================================
  // Creation
  // ========================================================================

  createSpec(name: string, theme?: Partial<DesignTheme>): DesignSpec {
    const resolved = theme
      ? this._mergeTheme(DesignSpecManager.getDefaultTheme(), theme)
      : DesignSpecManager.getDefaultTheme();
    return {
      id: crypto.randomUUID(),
      version: 1,
      name,
      theme: resolved,
      rootNodes: [],
      assets: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }

  // ========================================================================
  // Tree operations
  // ========================================================================

  addNode(spec: DesignSpec, parentId: string | null, node: DesignNode): void {
    spec.updatedAt = Date.now();
    if (!parentId) {
      spec.rootNodes.push(node);
      return;
    }
    const parent = this.findNode(spec, parentId);
    if (!parent) {
      console.warn(`[Mysti] DesignSpecManager.addNode: parent ${parentId} not found, adding to root`);
      spec.rootNodes.push(node);
      return;
    }
    node.parentId = parentId;
    if (!parent.children) { parent.children = []; }
    parent.children.push(node);
  }

  removeNode(spec: DesignSpec, nodeId: string): void {
    spec.updatedAt = Date.now();
    const idx = spec.rootNodes.findIndex(n => n.id === nodeId);
    if (idx !== -1) {
      spec.rootNodes.splice(idx, 1);
      return;
    }
    this._removeFromChildren(spec.rootNodes, nodeId);
  }

  moveNode(spec: DesignSpec, nodeId: string, newParentId: string | null): void {
    const node = this.findNode(spec, nodeId);
    if (!node) { return; }
    this.removeNode(spec, nodeId);
    node.parentId = newParentId ?? undefined;
    this.addNode(spec, newParentId, node);
  }

  updateNode(spec: DesignSpec, nodeId: string, patch: Partial<DesignNode>): void {
    const node = this.findNode(spec, nodeId);
    if (!node) { return; }
    Object.assign(node, patch, { id: node.id });
    spec.updatedAt = Date.now();
  }

  findNode(spec: DesignSpec, nodeId: string): DesignNode | null {
    return this._findInList(spec.rootNodes, nodeId);
  }

  getAncestors(spec: DesignSpec, nodeId: string): DesignNode[] {
    const ancestors: DesignNode[] = [];
    let current = this.findNode(spec, nodeId);
    while (current?.parentId) {
      const parent = this.findNode(spec, current.parentId);
      if (!parent) { break; }
      ancestors.unshift(parent);
      current = parent;
    }
    return ancestors;
  }

  flattenTree(spec: DesignSpec): DesignNode[] {
    const result: DesignNode[] = [];
    const walk = (nodes: DesignNode[]) => {
      for (const node of nodes) {
        result.push(node);
        if (node.children) { walk(node.children); }
      }
    };
    walk(spec.rootNodes);
    return result;
  }

  // ========================================================================
  // Theme
  // ========================================================================

  applyTheme(spec: DesignSpec, theme: DesignTheme): void {
    spec.theme = theme;
    spec.updatedAt = Date.now();
  }

  resolveToken(value: string, theme: DesignTheme): string {
    if (!value) { return value; }
    // Direct color token
    if (theme.colors[value]) { return theme.colors[value]; }
    // Shadow token
    if (value in theme.shadows) { return (theme.shadows as any)[value]; }
    // Radius token
    if (value in theme.radii) { return `${(theme.radii as any)[value]}px`; }
    // Already a literal value
    return value;
  }

  static getDefaultTheme(): DesignTheme {
    return {
      colors: {
        primary: '#3B82F6',
        secondary: '#6366F1',
        accent: '#F59E0B',
        background: '#FFFFFF',
        surface: '#F9FAFB',
        text: '#111827',
        textSecondary: '#6B7280',
        border: '#E5E7EB',
        error: '#EF4444',
        success: '#10B981',
      },
      typography: {
        fontFamily: 'Inter, system-ui, sans-serif',
        scale: [12, 14, 16, 20, 24, 32, 48],
        lineHeight: 1.5,
        weights: { regular: 400, medium: 500, bold: 700 },
      },
      spacing: { unit: 4, scale: [1, 2, 3, 4, 6, 8, 12, 16] },
      radii: { sm: 4, md: 8, lg: 16, full: 9999 },
      shadows: {
        sm: '0 1px 2px rgba(0,0,0,0.05)',
        md: '0 4px 6px rgba(0,0,0,0.1)',
        lg: '0 10px 15px rgba(0,0,0,0.1)',
      },
    };
  }

  // ========================================================================
  // Assets
  // ========================================================================

  addAsset(spec: DesignSpec, asset: DesignAssetRef): void {
    spec.assets.push(asset);
    spec.updatedAt = Date.now();
  }

  removeAsset(spec: DesignSpec, assetId: string): void {
    spec.assets = spec.assets.filter(a => a.id !== assetId);
    // Also remove references from nodes
    for (const node of this.flattenTree(spec)) {
      if (node.assets) {
        node.assets = node.assets.filter(a => a.id !== assetId);
      }
    }
    spec.updatedAt = Date.now();
  }

  linkAsset(spec: DesignSpec, assetId: string, nodeId: string): void {
    const asset = spec.assets.find(a => a.id === assetId);
    const node = this.findNode(spec, nodeId);
    if (!asset || !node) { return; }
    if (!node.assets) { node.assets = []; }
    if (!node.assets.find(a => a.id === assetId)) {
      node.assets.push(asset);
    }
    spec.updatedAt = Date.now();
  }

  getUnlinkedAssets(spec: DesignSpec): DesignAssetRef[] {
    const linkedIds = new Set<string>();
    for (const node of this.flattenTree(spec)) {
      if (node.assets) {
        for (const a of node.assets) { linkedIds.add(a.id); }
      }
    }
    return spec.assets.filter(a => !linkedIds.has(a.id));
  }

  collectUnresolvedAssets(spec: DesignSpec): DesignAssetRef[] {
    const unresolved: DesignAssetRef[] = [];
    for (const node of this.flattenTree(spec)) {
      if (node.assets) {
        for (const a of node.assets) {
          if (!a.src && a.prompt) { unresolved.push(a); }
        }
      }
    }
    return unresolved;
  }

  // ========================================================================
  // Conversion helpers
  // ========================================================================

  /**
   * Convert DesignNodes into flat fabric frame data for canvas rendering.
   * Each node becomes a rect with metadata pointers.
   */
  designNodesToFabricFrames(
    nodes: DesignNode[],
    parentOffset: { x: number; y: number } = { x: 0, y: 0 }
  ): Array<{
    id: string;
    left: number;
    top: number;
    width: number;
    height: number;
    label: string;
    nodeType: DesignNodeType;
    parentId?: string;
    depth: number;
  }> {
    const result: Array<any> = [];
    const walk = (list: DesignNode[], ox: number, oy: number, depth: number) => {
      for (const node of list) {
        result.push({
          id: node.id,
          left: ox + node.x,
          top: oy + node.y,
          width: node.width,
          height: node.height,
          label: node.name,
          nodeType: node.type,
          parentId: node.parentId,
          depth,
        });
        if (node.children) {
          walk(node.children, ox + node.x, oy + node.y, depth + 1);
        }
      }
    };
    walk(nodes, parentOffset.x, parentOffset.y, 0);
    return result;
  }

  /**
   * Create a minimal DesignNode from a fabric frame object (for legacy migration).
   */
  fabricFrameToDesignNode(frame: {
    id?: string;
    left: number;
    top: number;
    width: number;
    height: number;
    label?: string;
    description?: string;
    metadata?: Record<string, string>;
  }): DesignNode {
    return {
      id: frame.id || crypto.randomUUID(),
      type: 'section',
      name: frame.label || 'Untitled',
      description: frame.description,
      x: frame.left,
      y: frame.top,
      width: frame.width,
      height: frame.height,
      layout: { display: 'flex', direction: 'column' },
      style: {},
      metadata: frame.metadata,
    };
  }

  // ========================================================================
  // Private helpers
  // ========================================================================

  private _findInList(nodes: DesignNode[], id: string): DesignNode | null {
    for (const node of nodes) {
      if (node.id === id) { return node; }
      if (node.children) {
        const found = this._findInList(node.children, id);
        if (found) { return found; }
      }
    }
    return null;
  }

  private _removeFromChildren(nodes: DesignNode[], id: string): boolean {
    for (const node of nodes) {
      if (node.children) {
        const idx = node.children.findIndex(c => c.id === id);
        if (idx !== -1) {
          node.children.splice(idx, 1);
          return true;
        }
        if (this._removeFromChildren(node.children, id)) { return true; }
      }
    }
    return false;
  }

  private _mergeTheme(base: DesignTheme, partial: Partial<DesignTheme>): DesignTheme {
    return {
      colors: { ...base.colors, ...partial.colors },
      typography: { ...base.typography, ...partial.typography } as DesignTheme['typography'],
      spacing: partial.spacing || base.spacing,
      radii: { ...base.radii, ...partial.radii } as DesignTheme['radii'],
      shadows: { ...base.shadows, ...partial.shadows } as DesignTheme['shadows'],
    };
  }
}
