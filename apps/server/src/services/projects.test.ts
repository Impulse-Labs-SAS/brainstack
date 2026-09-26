import { describe, expect, it } from 'vitest';

import { projectTagOf, resolveProjects, type ProjectNote } from './projects.js';

const n = (path: string, tags: string[] = [], title = path): ProjectNote => ({
  id: path,
  path,
  ownerId: null,
  title,
  tags,
});

describe('projectTagOf', () => {
  it('returns the single project tag', () => {
    expect(projectTagOf(['ia', 'proyecto/atlas'])).toBe('proyecto/atlas');
  });

  it('returns nothing for no project tag, or for several', () => {
    expect(projectTagOf(['ia'])).toBeNull();
    expect(projectTagOf(['proyecto/uncuyo', 'proyecto/dmyte'])).toBeNull();
  });
});

describe('resolveProjects', () => {
  it('prefers the project tag, labelled by the MOC that carries it', () => {
    const projects = resolveProjects([
      n('Pablo/proyectos/sd/_sd.md', ['proyecto/seek-and-destroy', 'tipo/moc'], 'Seek & Destroy'),
      n('Pablo/proyectos/sd/arquitectura.md', ['proyecto/seek-and-destroy']),
    ]);
    expect(projects.get('Pablo/proyectos/sd/arquitectura.md')).toEqual({
      id: 'tag:|proyecto/seek-and-destroy',
      label: 'Seek & Destroy',
    });
  });

  it('puts an untagged note with its tagged MOC’s project', () => {
    const projects = resolveProjects([
      n('Pablo/proyectos/sd/_sd.md', ['proyecto/seek-and-destroy'], 'Seek & Destroy'),
      n('Pablo/proyectos/sd/suelta.md'),
    ]);
    expect(projects.get('Pablo/proyectos/sd/suelta.md')!.id).toBe('tag:|proyecto/seek-and-destroy');
  });

  it('falls back to the nearest MOC folder, walking up', () => {
    const projects = resolveProjects([
      n('Uncuyo/Fing/_Fing.md', [], 'Facultad'),
      n('Uncuyo/Fing/tramites/panel.md'),
    ]);
    expect(projects.get('Uncuyo/Fing/tramites/panel.md')).toEqual({
      id: 'folder:|Uncuyo/Fing',
      label: 'Facultad',
    });
  });

  it('falls back to the top-level folder, then the root', () => {
    const projects = resolveProjects([n('Demo/a.md'), n('suelta.md')]);
    expect(projects.get('Demo/a.md')).toEqual({ id: 'folder:|Demo', label: 'Demo' });
    expect(projects.get('suelta.md')).toEqual({ id: 'root:', label: 'raíz' });
  });

  it('does not assign a note with several project tags to any of them', () => {
    const projects = resolveProjects([
      n('Pablo/life/perfil.md', ['proyecto/uncuyo', 'proyecto/dmyte']),
    ]);
    expect(projects.get('Pablo/life/perfil.md')!.id).toBe('folder:|Pablo');
  });

  it('keeps same-named folders of different owners apart', () => {
    const projects = resolveProjects([
      { ...n('Zuno/a.md'), id: 'alice/Zuno/a.md', ownerId: 'alice' },
      { ...n('Zuno/a.md'), id: 'bob/Zuno/a.md', ownerId: 'bob' },
    ]);
    expect(projects.get('alice/Zuno/a.md')!.id).not.toBe(projects.get('bob/Zuno/a.md')!.id);
  });
});
