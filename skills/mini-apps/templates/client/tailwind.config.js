/** @type {import('tailwindcss').Config} */
// Tailwind 3 config. (Tailwind 4 uses a different, CSS-first setup; the
// templates are pinned to v3 on purpose.)
export default {
  content: ['./index.html', './src/**/*.{js,jsx,ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Pick a palette per app. Two Pans used warm cream/tomato,
        // the newsfeed a dark slate.
        surface: '#FFF8F0',
        ink: {
          400: '#8A8078',
          500: '#6B6259',
          800: '#2B2622',
        },
        accent: {
          400: '#FB7A50',
          500: '#EF5A2C',
          600: '#D8441C',
        },
      },
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', 'Roboto', 'Helvetica', 'Arial', 'sans-serif'],
      },
      boxShadow: {
        card: '0 1px 2px rgba(43, 38, 34, 0.06), 0 4px 16px rgba(43, 38, 34, 0.06)',
      },
    },
  },
  plugins: [],
}
