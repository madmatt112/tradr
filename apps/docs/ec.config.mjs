// Expressive Code (code block) theming for the docs — see docs.css for the
// palette it plugs into: mono on near-black, one step BELOW the page
// background, inside a hairline 10px-radius frame. The var() references
// resolve against tokens.css per theme at render time.
//
// This lives in ec.config.mjs rather than Starlight's `expressiveCode` option
// for two reasons, both found the hard way:
//
// - `customizeTheme` is a function, and options set in astro.config must be
//   JSON-serializable for starlight-openapi's `<Code>` component to render —
//   the config file is Expressive Code's own remedy (it is loaded directly at
//   render time).
// - starlight-openapi's config:setup rebuilds the `expressiveCode` key from
//   scratch (it reads the key off its own fresh update object, not the user
//   config) and Starlight merges plugin config updates shallowly, so anything
//   set on the Starlight option is silently replaced. Options here merge at a
//   layer that plugin cannot touch.
//
// `customizeTheme` (not `styleOverrides`) carries the frame backgrounds
// because Starlight's default `useStarlightUiThemeColors` writes THEME-level
// frame styleOverrides, which outrank config-level ones; the hook runs after
// Starlight's own theme mutation.
export default {
  styleOverrides: {
    borderRadius: '0.625rem',
    borderColor: 'var(--hairline)',
  },
  customizeTheme: (theme) => {
    theme.styleOverrides.frames = {
      ...theme.styleOverrides.frames,
      editorBackground: 'var(--tradr-code-bg)',
      terminalBackground: 'var(--tradr-code-bg)',
      editorActiveTabBackground: 'var(--tradr-code-bg)',
    };
    theme.colors['titleBar.activeBackground'] = 'var(--popover)';
    theme.colors['editorGroupHeader.tabsBackground'] = 'var(--popover)';
    return theme;
  },
};
