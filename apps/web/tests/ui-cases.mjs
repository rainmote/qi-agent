// Reviewed UI case catalog. IDs and assertion names are part of acceptance.
export const composerSpecs = [
  { id: 'trusted-empty-1250x760', width: 1250, height: 760, trust: 'allow' },
  { id: 'trusted-empty-1280x840', width: 1280, height: 840, trust: 'allow' },
  { id: 'restricted-empty-1024x600', width: 1024, height: 600, trust: 'deny' },
  { id: 'trusted-empty-minimum', width: 360, height: 480, trust: 'allow' },
  { id: 'trusted-running-900x600', width: 900, height: 600, trust: 'allow', phase: 'model' },
  { id: 'trusted-long-minimum', width: 900, height: 480, trust: 'allow', long: true },
  { id: 'trusted-long-phone', width: 390, height: 844, trust: 'allow', long: true },
  { id: 'trusted-pending-900x600', width: 900, height: 600, trust: 'allow', phase: 'tool', approval: true },
  { id: 'trusted-resize-1280to480', width: 1280, height: 840, trust: 'allow', long: true, resize: true },
  { id: 'trusted-height-only', width: 900, height: 840, trust: 'allow', long: true, resize: true },
  { id: 'trusted-running-expand', width: 900, height: 480, trust: 'allow', long: true, phase: 'model', expand: true },
];

export const composerAssertions = [
  "main and session stay inside viewport",
  "composer has at least 28px below card",
  "summary is fully visible with bottom inset",
  "composer wrap stays in viewport",
  "footer fully inside card",
  "all footer buttons in viewport",
  "trust stays above input card",
  "no horizontal page overflow",
  "empty placeholder cannot create scrollbar",
  "long drafts remain scrollable",
  "approval retained",
  "no mutation"
];

const common = ['no horizontal overflow', 'no runtime mutation'];
const density = ['all replies retained once', 'all seven calls accessible once', 'dense tool rows', 'bounded process panels', 'keyboard disclosure', 'tool details retained on group reopen'];
export const transcriptSpecs = [
  ...[1440, 320].flatMap(width => [false, true].map(live => ({
    id: `transcript-command-summary-${live ? 'live' : 'history'}-${width}`, width, height: 1000,
    mode: live ? 'detailed' : 'standard', kind: 'summary', live,
    assertions: ['natural language summaries', 'no raw command in collapsed rows or tooltips',
      'legacy command has neutral fallback', 'raw output hidden until disclosure',
      'keyboard reveals exact command and output', 'collapse hides raw details',
      'summaries survive reload', ...common],
  }))),
  ...[1440, 390, 320].flatMap(width => ['compact', 'standard', 'detailed', 'verbose'].map(mode => ({
    id: `transcript-${mode}-${width}`, width, height: 1000, mode, kind: 'density', assertions: [...density, ...common],
  }))),
  { id: 'transcript-default-live', width: 1440, height: 1000, kind: 'default',
    assertions: ['default detailed', 'live process flat', 'all seven calls accessible once', ...common] },
  { id: 'transcript-failure-recovery-320', width: 320, height: 844, mode: 'standard', kind: 'failure',
    assertions: ['failure retained in turn', 'failure retained in group', 'failed command visible', 'failed raw output in details', 'all eight calls accessible once', 'success does not erase failure', ...common] },
  { id: 'transcript-focus-settlement', width: 390, height: 844, mode: 'detailed', kind: 'focus',
    assertions: ['focused control survives settlement', 'outer collapse resets details', 'group header keeps focus', 'reopened details accessible', ...common] },
  { id: 'transcript-scroll-cap-320', width: 320, height: 600, mode: 'standard', kind: 'scroll',
    assertions: ['overflowing group is scrollable', 'panel capped at half viewport', 'last tool reachable', ...common] },
];
export const suites = {
  composer: { script: 'composer-browser.mjs', specs: composerSpecs.map(spec => ({ ...spec, assertions: composerAssertions })) },
  transcript: { script: 'transcript-browser.mjs', specs: transcriptSpecs },
};
