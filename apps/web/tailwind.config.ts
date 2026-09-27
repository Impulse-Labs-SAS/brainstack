import type { Config } from 'tailwindcss';
import reactAriaPlugin from 'tailwindcss-react-aria-components';

const config: Config = {
  darkMode: 'class',
  content: ['./src/**/*.{ts,tsx,mdx}'],
  theme: {
    extend: {
      colors: {
        bg: {
          base: 'var(--bg-base)',
          surface: 'var(--bg-surface)',
          elevated: 'var(--bg-elevated)',
          hover: 'var(--bg-hover)',
        },
        fg: {
          primary: 'var(--fg-primary)',
          body: 'var(--fg-body)',
          secondary: 'var(--fg-secondary)',
          muted: 'var(--fg-muted)',
          disabled: 'var(--fg-disabled)',
        },
        border: {
          subtle: 'var(--border-subtle)',
          DEFAULT: 'var(--border-default)',
          strong: 'var(--border-strong)',
        },
        // Channels rather than a hex, so opacity modifiers (`bg-accent/20`)
        // work: with a plain var() Tailwind cannot mix in the alpha and
        // silently generates nothing.
        accent: {
          DEFAULT: 'rgb(var(--accent-rgb) / <alpha-value>)',
          hover: 'rgb(var(--accent-hover-rgb) / <alpha-value>)',
          fg: 'var(--accent-fg)',
        },
        success: 'var(--success)',
        warning: 'var(--warning)',
        danger: 'var(--danger)',
        info: 'var(--info)',
      },
      fontFamily: {
        sans: ['var(--font-sans)', 'system-ui', 'sans-serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'monospace'],
      },
      fontSize: {
        xs: ['11px', '16px'],
        sm: ['13px', '18px'],
        base: ['14px', '20px'],
        lg: ['16px', '24px'],
        xl: ['20px', '28px'],
        '2xl': ['24px', '32px'],
        '3xl': ['32px', '40px'],
      },
      borderRadius: {
        sm: '4px',
        DEFAULT: '6px',
        md: '6px',
        lg: '8px',
      },
      transitionDuration: {
        instant: '100ms',
        fast: '150ms',
        normal: '200ms',
        slow: '300ms',
      },
      transitionTimingFunction: {
        default: 'cubic-bezier(0.16, 1, 0.3, 1)',
      },
    },
  },
  plugins: [reactAriaPlugin()],
};

export default config;
