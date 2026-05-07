import { describe, expect, it } from 'vitest';

import {
  buildReplyTree,
  countReplyTree,
  MAX_REPLY_TREE_DEPTH,
} from './index';

describe('status reply tree helpers', () => {
  it('normalizes self-parented descendants to the thread root', () => {
    expect(buildReplyTree(['1', '2'], { '1': '1', '2': '1' }, 'root')).toEqual({
      root: ['1'],
      1: ['2'],
    });
  });

  it('counts cyclic reply graphs without recursing forever', () => {
    const childrenMap = {
      root: ['1'],
      1: ['2'],
      2: ['1'],
    };

    expect(countReplyTree('root', childrenMap)).toBe(2);
  });

  it('bounds very deep reply chains by traversal depth', () => {
    const childrenMap: Record<string, string[]> = {};
    const depth = 10_000;

    for (let i = 0; i < depth; i++) {
      childrenMap[String(i)] = [String(i + 1)];
    }

    expect(() => countReplyTree('0', childrenMap)).not.toThrow();
    expect(countReplyTree('0', childrenMap)).toBe(MAX_REPLY_TREE_DEPTH);
  });

  it('bounds broad reply trees by visited node count', () => {
    const childrenMap = {
      root: ['1', '2', '3', '4'],
    };

    expect(countReplyTree('root', childrenMap, { maxNodes: 2 })).toBe(2);
  });
});
