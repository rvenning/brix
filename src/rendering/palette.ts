// Colour and shape identity for the eight block types, and the board materials.
// Every type differs in silhouette as well as colour, so no player needs colour to tell them apart.

export type Glyph = 'circle' | 'triangle' | 'star' | 'diamond' | 'hexagon' | 'heart' | 'cross' | 'crescent';

export interface BlockStyle {
  name: string;
  glyph: Glyph;
  light: string;
  base: string;
  dark: string;
  ink: string;
}

export const BLOCKS: Record<number, BlockStyle> = {
  1: { name: 'Ruby', glyph: 'circle', light: '#ff9aae', base: '#ff4d6d', dark: '#b3143f', ink: '#ffffff' },
  2: { name: 'Amber', glyph: 'triangle', light: '#ffc77a', base: '#ff9a1f', dark: '#c2650a', ink: '#ffffff' },
  3: { name: 'Sun', glyph: 'star', light: '#fff38a', base: '#ffd41f', dark: '#c79a00', ink: '#5c4300' },
  4: { name: 'Leaf', glyph: 'diamond', light: '#98f5c0', base: '#34d981', dark: '#138a4b', ink: '#ffffff' },
  5: { name: 'Aqua', glyph: 'hexagon', light: '#9af0ff', base: '#22cfee', dark: '#0a8aa6', ink: '#ffffff' },
  6: { name: 'Grape', glyph: 'heart', light: '#cdb3ff', base: '#9a66ff', dark: '#5f2fcc', ink: '#ffffff' },
  7: { name: 'Rose', glyph: 'cross', light: '#ffb6ec', base: '#ff5fcf', dark: '#b82b91', ink: '#ffffff' },
  8: { name: 'Pearl', glyph: 'crescent', light: '#ffffff', base: '#dfe6f3', dark: '#8f9bb5', ink: '#3d4866' },
};

export const MATERIAL = {
  floor: '#0d1226',
  floorDot: 'rgba(140, 160, 255, 0.07)',
  frameBase: '#252d4d',
  frameLight: '#3b4675',
  frameDark: '#121730',
  wallBase: '#4b5680',
  wallLight: '#6d7aab',
  wallDark: '#2c3457',
  elevatorBase: '#f4b73e',
  elevatorLight: '#ffe29a',
  elevatorDark: '#a86b0b',
  track: 'rgba(244, 183, 62, 0.16)',
  cursor: '#ffffff',
  cursorCarry: '#ffd84a',
};
