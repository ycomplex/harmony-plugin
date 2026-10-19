// B-929 / B-1170: the ONE place the default worker image name is written. Lives in its own module so
// both src/config/deployment-config.ts (which re-exports it, keeping every existing import working) and
// src/config/conductor-config.ts can use it without importing each other.
export const WORKER_IMAGE_DEFAULT = 'harmony-build-env';
