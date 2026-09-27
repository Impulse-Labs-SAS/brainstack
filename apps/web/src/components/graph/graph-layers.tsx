'use client';

// What the graph draws, like the layers button of a map: whether shared
// vaults are loaded at all, which vaults show, which kinds of connection,
// whether topics become nodes, whether the map shows every route. Replaces
// the four old connection modes.

import { Check, Layers, Users } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button, Checkbox, Dialog, DialogTrigger, Popover } from 'react-aria-components';

import type { GraphLayers, GraphModel, GraphView } from '@/lib/graph-model';
import { cn } from '@/lib/utils';

import { GLASS } from './graph-preview';

interface GraphLayersMenuProps {
  model: GraphModel;
  layers: GraphLayers;
  onChange(layers: GraphLayers): void;
  /** Some layers only mean something in one view; the others show them disabled. */
  view: GraphView;
  /** Whether shared vaults are fetched at all; null when sharing is off on this deployment. */
  includeShared: boolean | null;
  onIncludeSharedChange(include: boolean): void;
}

function Row({
  isSelected,
  isDisabled,
  onChange,
  glyph,
  children,
  trailing,
}: {
  isSelected: boolean;
  isDisabled?: boolean;
  onChange(value: boolean): void;
  glyph: ReactNode;
  children: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 rounded px-1.5 py-1 hover:bg-bg-hover">
      <Checkbox
        isSelected={isSelected}
        isDisabled={isDisabled}
        onChange={onChange}
        className="group flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 outline-none disabled:cursor-default"
      >
        {({ isSelected: on }) => (
          <>
            <span
              className={cn(
                'flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm border',
                on ? 'border-accent bg-accent text-accent-fg' : 'border-border-strong',
                'group-focus-visible:ring-2 group-focus-visible:ring-accent/40 group-disabled:opacity-50',
              )}
            >
              {on && <Check size={10} strokeWidth={3} />}
            </span>
            {glyph}
            <span className={cn('min-w-0 flex-1 truncate', on && !isDisabled ? 'text-fg-primary' : 'text-fg-muted')}>{children}</span>
          </>
        )}
      </Checkbox>
      {trailing}
    </div>
  );
}

const Heading = ({ children }: { children: ReactNode }) => (
  <div className="px-1.5 pb-1 pt-2 font-mono text-[10.5px] uppercase tracking-wider text-fg-muted first:pt-0.5">{children}</div>
);

export function GraphLayersMenu({ model, layers, onChange, view, includeShared, onIncludeSharedChange }: GraphLayersMenuProps) {
  const hidden = new Set(layers.hiddenVaults);
  const visibleVaults = model.vaults.filter((v) => !hidden.has(v.id));
  const shown = new Map<string, number>();
  for (const n of model.nodes) if (n.kind === 'note') shown.set(n.vault, (shown.get(n.vault) ?? 0) + 1);
  // A layer that belongs to one view is only offered there: shown disabled
  // elsewhere, a ticked box could not be unticked. Its choice is kept for when
  // you come back, and only counts as a change where it can be seen.
  const onMap = view === 'territories';
  const isDefault =
    includeShared !== false &&
    !layers.hiddenVaults.length &&
    layers.affinity &&
    layers.indexes &&
    !(onMap ? layers.routes : layers.topics);

  const setVault = (id: string, visible: boolean) =>
    onChange({ ...layers, hiddenVaults: visible ? layers.hiddenVaults.filter((v) => v !== id) : [...layers.hiddenVaults, id] });
  const solo = (id: string) => {
    const alone = visibleVaults.length === 1 && visibleVaults[0]!.id === id;
    onChange({ ...layers, hiddenVaults: alone ? [] : model.vaults.filter((v) => v.id !== id).map((v) => v.id) });
  };

  return (
    <DialogTrigger>
      <Button
        className={cn(
          GLASS,
          'pointer-events-auto flex h-9 items-center gap-2 rounded-lg px-3 text-sm text-fg-primary outline-none',
          'hover:bg-bg-hover focus-visible:ring-2 focus-visible:ring-accent/40 pressed:bg-bg-elevated',
        )}
      >
        <Layers size={14} />
        Layers
        {!isDefault && <span aria-label="(changed)" className="h-1.5 w-1.5 rounded-full bg-accent" />}
      </Button>
      <Popover placement="bottom start" offset={6} className={cn(GLASS, 'w-[272px] rounded-lg p-2 text-sm shadow-2xl outline-none')}>
        <Dialog aria-label="Graph layers" className="outline-none">
          <Heading>Vaults</Heading>
          {includeShared !== null && (
            <Row
              isSelected={includeShared}
              onChange={onIncludeSharedChange}
              glyph={<Users size={12} aria-hidden className="shrink-0 text-fg-secondary" />}
            >
              Include shared vaults
            </Row>
          )}
          {model.vaults.map((v) => {
            const alone = visibleVaults.length === 1 && !v.hidden;
            return (
              <Row
                key={v.id}
                isSelected={!v.hidden}
                // The last visible vault stays: an empty graph answers nothing.
                isDisabled={alone}
                onChange={(on) => setVault(v.id, on)}
                glyph={<span aria-hidden className="h-2 w-2 shrink-0 rounded-full" style={{ background: v.color.hue, boxShadow: `0 0 6px ${v.color.hue}` }} />}
                trailing={
                  <>
                    <span className="font-mono text-[11px] text-fg-muted">{v.hidden ? v.total : (shown.get(v.id) ?? 0)}</span>
                    {model.vaults.length > 1 && (
                      <Button
                        onPress={() => solo(v.id)}
                        className="rounded px-1 text-[11px] text-fg-muted outline-none hover:text-fg-primary focus-visible:ring-2 focus-visible:ring-accent/40"
                      >
                        {alone ? 'all' : 'only'}
                      </Button>
                    )}
                  </>
                }
              >
                <span className="block truncate" title={v.label}>
                  {v.label}
                </span>
                {/* Who shared it, as the file tree shows it: the menu is too narrow for both on one line. */}
                {v.owner && (
                  <span className="block truncate font-mono text-[10px] text-fg-muted" title={`Shared by ${v.owner}`}>
                    @{v.owner}
                  </span>
                )}
              </Row>
            );
          })}
          <div className="my-1 h-px bg-border-subtle" />
          <Heading>Connections</Heading>
          <Row
            isSelected={layers.affinity}
            onChange={(on) => onChange({ ...layers, affinity: on })}
            glyph={<span aria-hidden className="w-4 shrink-0 border-t-2 border-dotted border-fg-secondary" />}
          >
            Shared topics
          </Row>
          <Row
            isSelected={layers.indexes}
            onChange={(on) => onChange({ ...layers, indexes: on })}
            glyph={<span aria-hidden className="h-2 w-2 shrink-0 rounded-[2px] bg-fg-secondary" />}
          >
            Indexes (MOC)
          </Row>
          {onMap ? (
            // Routes are how the map shows links; the other views draw every link anyway.
            <Row
              isSelected={layers.routes}
              onChange={(on) => onChange({ ...layers, routes: on })}
              glyph={<span aria-hidden className="w-4 shrink-0 border-t border-fg-secondary" />}
            >
              All routes
            </Row>
          ) : (
            // A topic belongs to no project, so it has no place on the map.
            <>
              <div className="my-1 h-px bg-border-subtle" />
              <Heading>Nodes</Heading>
              <Row
                isSelected={layers.topics}
                onChange={(on) => onChange({ ...layers, topics: on })}
                glyph={<span aria-hidden className="shrink-0 text-[11px] leading-none text-fg-secondary">⬡</span>}
              >
                Topics as nodes
              </Row>
            </>
          )}
        </Dialog>
      </Popover>
    </DialogTrigger>
  );
}
