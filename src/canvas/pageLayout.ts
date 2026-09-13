/** Mysti — SPDX-License-Identifier: Apache-2.0
 * Default page placement, shared by migration and Canvas variants.
 */

/** Horizontal pitch between artboards on the board, in design px. */
export const BOARD_COLUMN_PITCH = 1600;
/** Vertical pitch between artboard rows, in design px. */
export const BOARD_ROW_PITCH = 1200;
/** Artboards per board row before wrapping. */
export const BOARD_COLUMNS = 4;

/** Default board position for the page at `index`, laid out left-to-right. */
export function boardPosForIndex(index: number): { x: number; y: number } {
  const i = Number.isFinite(index) && index > 0 ? Math.floor(index) : 0;
  return {
    x: (i % BOARD_COLUMNS) * BOARD_COLUMN_PITCH,
    y: Math.floor(i / BOARD_COLUMNS) * BOARD_ROW_PITCH,
  };
}

