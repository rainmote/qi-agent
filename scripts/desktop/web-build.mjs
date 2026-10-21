import { build } from 'vite';

// Packaging must not read a workstation's ignored .env or .env.* files.
// The parent also supplies a minimal environment without VITE_* overrides.
await build({ envDir: false, build: { sourcemap: false } });
