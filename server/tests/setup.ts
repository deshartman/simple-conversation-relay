/**
 * Global test setup file
 * Runs before all tests
 */

import { beforeEach, afterEach } from 'vitest';

// Store original environment variables
const originalEnv = { ...process.env };

// Reset environment variables before each test
beforeEach(() => {
    // Restore original env vars
    process.env = { ...originalEnv };
});

// Clean up after each test
afterEach(() => {
    // Restore original env vars
    process.env = { ...originalEnv };
});
