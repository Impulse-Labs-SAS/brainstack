/* eslint-env node */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'prettier',
  ],
  env: {
    node: true,
    es2022: true,
  },
  rules: {
    '@typescript-eslint/no-unused-vars': [
      'error',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
    ],
    '@typescript-eslint/consistent-type-imports': 'warn',
    // gray-matter runs a `---js` block through eval() and re-parses bodies on
    // stringify. Frontmatter goes through packages/core/src/parser/frontmatter.ts.
    'no-restricted-imports': [
      'error',
      {
        paths: [
          {
            name: 'gray-matter',
            message: 'Use extractFrontmatter / serializeNote from @brainstack/core.',
          },
        ],
      },
    ],
  },
  ignorePatterns: ['dist/', 'build/', '.next/', 'node_modules/', '*.cjs'],
};
