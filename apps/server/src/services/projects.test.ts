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
      n('Frodo/proyectos/tba/_tba.md', ['proyecto/there-and-back-again', 'tipo/moc'], 'There & Back Again'),
      n('Frodo/proyectos/tba/arquitectura.md', ['proyecto/there-and-back-again']),
    ]);
    expect(projects.get('Frodo/proyectos/tba/arquitectura.md')).toEqual({
      id: 'tag:|proyecto/there-and-back-again',
      label: 'There & Back Again',
    });
  });

  it('puts an untagged note with its tagged MOC’s project', () => {
    const projects = resolveProjects([
      n('Frodo/proyectos/tba/_tba.md', ['proyecto/there-and-back-again'], 'There & Back Again'),
      n('Frodo/proyectos/tba/suelta.md'),
    ]);
    expect(projects.get('Frodo/proyectos/tba/suelta.md')!.id).toBe('tag:|proyecto/there-and-back-again');
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
      n('Frodo/life/perfil.md', ['proyecto/uncuyo', 'proyecto/dmyte']),
    ]);
    expect(projects.get('Frodo/life/perfil.md')!.id).toBe('folder:|Frodo');
  });

  it('keeps same-named folders of different owners apart', () => {
    const projects = resolveProjects([
      { ...n('Erebor/a.md'), id: 'alice/Erebor/a.md', ownerId: 'alice' },
      { ...n('Erebor/a.md'), id: 'bob/Erebor/a.md', ownerId: 'bob' },
    ]);
    expect(projects.get('alice/Erebor/a.md')!.id).not.toBe(projects.get('bob/Erebor/a.md')!.id);
  });
});
