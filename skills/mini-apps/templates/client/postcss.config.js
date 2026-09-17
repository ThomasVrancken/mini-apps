// REQUIRED. Without this file Tailwind's @tailwind directives pass through as
// literal CSS, the build still succeeds, and the app renders completely unstyled.
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
}
