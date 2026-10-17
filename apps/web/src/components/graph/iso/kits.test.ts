import { describe, expect, it } from 'vitest';

import type { GraphModel, GraphView } from '@/lib/graph-model';

import type { GraphKit, KitHost } from '../graph-kit';
import { LineArtKits } from './kits';

/** A kit for one view that records what it is asked. */
function fake(view: GraphView, engine: boolean) {
  const calls: string[] = [];
  const kit = new Proxy({} as GraphKit, {
    get: (_, key) => {
      if (key === 'handles') return (v: GraphView) => v === view;
      if (key === 'usesEngine') return () => engine;
      if (key === 'growthStatus') return () => ({ at: 0, count: view.length });
      return (...args: unknown[]) => {
        calls.push(`${String(key)}${args[4] ? ` ${String(args[4])}` : ''}`);
        return key === 'up' || key === 'key';
      };
    },
  });
  return { kit, calls };
}

const host = {} as KitHost;
const model = {} as GraphModel;
const vp = { width: 800, height: 600 };

describe('LineArtKits', () => {
  it('draws each view with its own kit, the Network one made the first time it is drawn', () => {
    const map = fake('territories', false);
    const board = fake('network', true);
    let made = 0;
    const kits = new LineArtKits(map.kit, () => {
      made++;
      return board.kit;
    });
    expect(kits.handles('territories')).toBe(true);
    expect(kits.handles('network')).toBe(true);
    expect(kits.handles('brain')).toBe(false);
    expect(made).toBe(0);
    kits.enter(host, model, vp, 1, 'territories');
    expect(kits.usesEngine()).toBe(false);
    kits.frame({} as never);
    expect(map.calls).toEqual(['enter territories', 'frame']);
    // Another view: the one drawing leaves, the other enters.
    kits.enter(host, model, vp, 1, 'network');
    expect(made).toBe(1);
    expect(map.calls.at(-1)).toBe('leave');
    expect(board.calls).toEqual(['enter network']);
    expect(kits.usesEngine()).toBe(true);
    expect(kits.growthStatus()).toEqual({ at: 0, count: 7 });
    expect(kits.key({} as KeyboardEvent)).toBe(true);
    kits.pointerDown({} as PointerEvent, 1, 2);
    expect(board.calls.at(-1)).toBe('pointerDown');
    expect(map.calls).not.toContain('pointerDown');
    // A new model reaches both, each laying it out when it next draws.
    kits.setModel(model);
    expect(map.calls.at(-1)).toBe('setModel');
    expect(board.calls.at(-1)).toBe('setModel');
    // Left, nothing answers but with nothing.
    kits.leave();
    expect(kits.usesEngine()).toBe(false);
    expect(kits.growthStatus()).toBeNull();
    expect(kits.up()).toBe(false);
    kits.dispose();
    expect(map.calls.at(-1)).toBe('dispose');
    expect(board.calls.at(-1)).toBe('dispose');
    expect(made).toBe(1);
  });
});
