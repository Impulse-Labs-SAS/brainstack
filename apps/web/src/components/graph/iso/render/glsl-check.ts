// What a ShaderMaterial's GLSL ES 3.00 gets wrong that only a compile would otherwise say:
// a uniform the code sets but the shader never declares (three skips it without a word), an
// attribute or a varying whose two ends disagree, a reserved word, an int where a float must
// be. Node has no WebGL, so the tests read the shaders as text with this. Tests only.

import { GLSL3, Vector2, Vector3, type BufferGeometry, type ShaderMaterial } from 'three';

export interface Declaration {
  storage: 'uniform' | 'in' | 'out';
  flat: boolean;
  type: string;
  name: string;
  /** The array length, for an array. */
  length: number | null;
}

/** What three declares ahead of a ShaderMaterial's own code: declaring any of them again fails the compile. */
const THREE_BUILT_INS = new Set([
  'position',
  'normal',
  'uv',
  'modelMatrix',
  'modelViewMatrix',
  'projectionMatrix',
  'viewMatrix',
  'normalMatrix',
  'cameraPosition',
  'isOrthographic',
]);
const THREE_ATTRIBUTES = new Set(['position', 'normal', 'uv']);

/** Words GLSL ES 3.00 keeps for itself, or for later: none may name anything. */
const RESERVED = new Set(
  (
    'attribute varying coherent volatile restrict readonly writeonly resource atomic_uint ' +
    'noperspective patch sample subroutine common partition active asm class union enum ' +
    'typedef template this goto inline noinline public static extern external interface long ' +
    'short double half fixed unsigned superp input output hvec2 hvec3 hvec4 dvec2 dvec3 ' +
    'dvec4 fvec2 fvec3 fvec4 filter sizeof cast namespace using'
  ).split(' '),
);

/** The shader as the compiler reads it: no comments. */
const code = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

export function declarations(source: string): Declaration[] {
  const out: Declaration[] = [];
  const re =
    /(?:^|[;\n])\s*(?:layout\s*\([^)]*\)\s*)?(flat\s+)?(uniform|in|out)\s+(?:(?:highp|mediump|lowp)\s+)?(\w+)\s+(\w+)\s*(?:\[\s*(\d+)\s*\])?\s*;/g;
  for (const m of code(source).matchAll(re)) {
    out.push({
      storage: m[2] as Declaration['storage'],
      flat: Boolean(m[1]),
      type: m[3]!,
      name: m[4]!,
      length: m[5] ? Number(m[5]) : null,
    });
  }
  return out;
}

/** The GLSL type a uniform's value uploads as. */
function uniformType(value: unknown): { type: string; length: number | null } | null {
  if (typeof value === 'number') return { type: 'float', length: null };
  if (value instanceof Vector2) return { type: 'vec2', length: null };
  if (value instanceof Vector3) return { type: 'vec3', length: null };
  if (Array.isArray(value) && value.length > 0) {
    const inner = uniformType(value[0]);
    return inner && inner.length === null ? { type: inner.type, length: value.length } : null;
  }
  return null;
}

const ATTRIBUTE_TYPES = ['', 'float', 'vec2', 'vec3', 'vec4'];

/** An int literal where GLSL ES 3.00 wants a float: it converts nothing implicitly. */
function intMixes(source: string): string[] {
  // Float literals out of the way first, exponents and all, so only ints are left as numbers.
  const text = code(source).replace(/(?:\d+\.\d*|\.\d+|\d+)[eE][-+]?\d+|\d+\.\d*|\.\d+/g, 'F');
  const int = /(?<![\w.])\d+(?![\w.])/;
  const found: string[] = [];
  const arithmetic = new RegExp(`${int.source}\\s*[-+*/](?!=)|[-+*/]\\s*${int.source}`, 'g');
  for (const m of text.matchAll(arithmetic)) found.push(m[0]);
  for (const m of text.matchAll(/\bfloat\s+\w+\s*=\s*-?\d+\s*;/g)) found.push(m[0]);
  const floatCalls =
    /\b(?:smoothstep|step|mix|mod|pow|min|max|length|dot)\s*\(((?:[^()]|\([^()]*\))*)\)/g;
  for (const m of text.matchAll(floatCalls)) {
    if (int.test(m[1]!.replace(/\[[^\]]*\]/g, ''))) found.push(m[0]);
  }
  return found;
}

/**
 * Everything `material`'s shaders get wrong against `geometry` and against the uniforms the
 * code sets, as sentences; none when they agree.
 */
export function shaderProblems(material: ShaderMaterial, geometry: BufferGeometry): string[] {
  const problems: string[] = [];
  const vs = material.vertexShader;
  const fs = material.fragmentShader;
  if (material.glslVersion !== GLSL3) problems.push('glslVersion is not GLSL3');
  for (const [stage, source] of [
    ['vertex', vs],
    ['fragment', fs],
  ] as const) {
    const text = code(source);
    if (!/\bvoid\s+main\s*\(\s*\)/.test(text)) problems.push(`${stage}: no main()`);
    for (const word of ['#version', 'gl_FragColor', 'texture2D']) {
      if (text.includes(word)) {
        problems.push(`${stage}: ${word} is not GLSL ES 3.00 as written here`);
      }
    }
    for (const m of text.matchAll(/\b[A-Za-z_]\w*\b/g)) {
      if (RESERVED.has(m[0])) problems.push(`${stage}: reserved word ${m[0]}`);
    }
    for (const d of declarations(source)) {
      if (THREE_BUILT_INS.has(d.name)) problems.push(`${stage}: declares three's own ${d.name}`);
      const varying = d.storage === (stage === 'vertex' ? 'out' : 'in');
      if (varying && /^(u?int|[iu]vec)/.test(d.type) && !d.flat) {
        problems.push(`${stage}: integer varying ${d.name} must be flat`);
      }
    }
    for (const mix of intMixes(source)) {
      problems.push(`${stage}: int literal in float maths: ${mix}`);
    }
  }

  const vsDecl = declarations(vs);
  const fsDecl = declarations(fs);

  // Uniforms: what the code sets is declared, with the type its value uploads as, and every
  // one declared is set.
  const declared = new Map<string, Declaration>();
  for (const d of [...vsDecl, ...fsDecl].filter((x) => x.storage === 'uniform')) {
    const seen = declared.get(d.name);
    if (seen && (seen.type !== d.type || seen.length !== d.length)) {
      problems.push(`uniform ${d.name} is declared differently in the two shaders`);
    }
    declared.set(d.name, d);
  }
  for (const [name, uniform] of Object.entries(material.uniforms)) {
    const d = declared.get(name);
    if (!d) {
      problems.push(`uniform ${name} is set but never declared`);
      continue;
    }
    const want = uniformType(uniform.value);
    if (!want) problems.push(`uniform ${name}: a value this check cannot type`);
    else if (want.type !== d.type || want.length !== d.length) {
      problems.push(
        `uniform ${name}: declared ${d.type}${d.length ? `[${d.length}]` : ''}, set as ${want.type}${want.length ? `[${want.length}]` : ''}`,
      );
    }
  }
  for (const name of declared.keys()) {
    if (!(name in material.uniforms)) problems.push(`uniform ${name} is declared but never set`);
  }

  // Attributes: each of the geometry's own is an `in` of the vertex shader, of its size.
  const ins = new Map(vsDecl.filter((d) => d.storage === 'in').map((d) => [d.name, d]));
  for (const [name, attribute] of Object.entries(geometry.attributes)) {
    if (THREE_ATTRIBUTES.has(name)) continue;
    const d = ins.get(name);
    if (!d) problems.push(`attribute ${name} is never declared`);
    else if (d.type !== ATTRIBUTE_TYPES[attribute.itemSize]) {
      problems.push(`attribute ${name}: declared ${d.type}, given ${attribute.itemSize} floats`);
    }
  }
  for (const name of ins.keys()) {
    if (!(name in geometry.attributes))
      problems.push(`attribute ${name} is declared but not given`);
  }

  // Varyings: the vertex shader's outs are the fragment shader's ins, alike.
  const outs = vsDecl.filter((d) => d.storage === 'out');
  const fsIns = new Map(fsDecl.filter((d) => d.storage === 'in').map((d) => [d.name, d]));
  for (const o of outs) {
    const i = fsIns.get(o.name);
    if (!i) problems.push(`varying ${o.name} is never read`);
    else if (i.type !== o.type || i.flat !== o.flat) {
      problems.push(`varying ${o.name} differs between the shaders`);
    }
  }
  for (const name of fsIns.keys()) {
    if (!outs.some((o) => o.name === name)) problems.push(`varying ${name} is never written`);
  }
  const fsOuts = fsDecl.filter((d) => d.storage === 'out');
  if (fsOuts.length !== 1 || fsOuts[0]!.type !== 'vec4') {
    problems.push('the fragment shader must write one vec4');
  }
  return problems;
}
