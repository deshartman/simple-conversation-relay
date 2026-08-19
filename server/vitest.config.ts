import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
        include: ['tests/**/*.test.ts'],
        coverage: {
            provider: 'v8',
            reporter: ['text', 'json', 'html'],
            exclude: [
                'node_modules/',
                'tests/',
                'dist/',
                '**/*.d.ts',
                '**/*.config.*',
                '**/mockData',
                '**/interfaces'
            ]
        },
        setupFiles: ['./tests/setup.ts']
    },
    resolve: {
        alias: {
            '@': path.resolve(__dirname, './src')
        }
    }
});
