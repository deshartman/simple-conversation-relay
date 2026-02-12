# Test Suite

Comprehensive test suite for the Conversation Relay server, focusing on Phase 1 IoC refactoring with centralized configuration.

## Structure

```
tests/
├── unit/                    # Unit tests for individual components
│   ├── config/             # ServerConfig tests
│   │   └── ServerConfig.test.ts
│   └── services/           # Service tests
│       ├── TwilioService.test.ts
│       └── OpenAIResponseService.test.ts
├── integration/            # Integration tests
│   └── server-initialization.test.ts
├── fixtures/               # Test fixtures and mock data
│   ├── .env.test-complete    # Complete test environment
│   ├── .env.test-minimal     # Minimal test environment
│   └── .env.test-incomplete  # Incomplete (for validation tests)
├── setup.ts               # Global test setup
└── README.md             # This file
```

## Running Tests

### Run all tests
```bash
npm test
```

### Watch mode (re-runs tests on file changes)
```bash
npm run test:watch
```

### Interactive UI
```bash
npm run test:ui
```

### Coverage report
```bash
npm run test:coverage
```

## Test Coverage

### ServerConfig Tests
- ✅ Environment variable loading
- ✅ Required field validation
- ✅ Environment-specific file selection (.env.dev, .env.prod)
- ✅ Default values for optional fields
- ✅ Test configuration factory (`forTesting()`)
- ✅ Partial overrides in test config
- ✅ Type safety (port as number)
- ✅ Immutability of config properties

### Service Tests

#### TwilioService
- ✅ Initialization with ServerConfig
- ✅ Config values preferred over environment variables
- ✅ Edge and region configuration
- ✅ Backwards compatibility (works without config)
- ✅ Service initialization flow

#### OpenAIResponseService
- ✅ Initialization with ServerConfig
- ✅ Model selection from config
- ✅ Listen mode configuration
- ✅ Backwards compatibility
- ✅ Multiple service instances with different configs

### Integration Tests
- ✅ Complete server initialization flow
- ✅ Fail-fast validation
- ✅ Initialization order: Config → Services → Server
- ✅ Environment-specific configuration loading
- ✅ Configuration consistency across services
- ✅ Test configuration scenarios

## Writing New Tests

### Unit Test Template

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { YourService } from '../../../src/services/YourService.js';
import { ServerConfig } from '../../../src/config/ServerConfig.js';

describe('YourService', () => {
    beforeEach(() => {
        // Clean up before each test
    });

    describe('Feature group', () => {
        it('should do something specific', () => {
            const config = ServerConfig.forTesting();
            const service = new YourService(config);

            expect(service).toBeDefined();
        });
    });
});
```

### Integration Test Template

```typescript
import { describe, it, expect } from 'vitest';
import { ServerConfig } from '../../src/config/ServerConfig.js';

describe('Feature Integration', () => {
    it('should work end-to-end', () => {
        const config = ServerConfig.forTesting();

        // Test complete flow
        expect(config).toBeDefined();
    });
});
```

## Test Fixtures

### .env.test-complete
Complete environment configuration with all optional fields.

### .env.test-minimal
Minimal environment with only required fields.

### .env.test-incomplete
Incomplete environment for testing validation errors.

## Best Practices

1. **Isolation**: Each test should be independent
2. **Clean up**: Use `beforeEach` to reset state
3. **Descriptive names**: Test names should describe what they verify
4. **Single assertion**: Each test should verify one thing
5. **Use fixtures**: Reuse test data from fixtures directory
6. **Test edge cases**: Include validation, error cases, and boundaries
7. **Mock external dependencies**: Use `vi.mock()` for external services

## Mocking

External dependencies are mocked to ensure tests are:
- Fast (no network calls)
- Reliable (no external service failures)
- Isolated (test only your code)

Example:
```typescript
vi.mock('twilio', () => {
    return {
        default: vi.fn(() => ({
            calls: { create: vi.fn() }
        }))
    };
});
```

## Continuous Integration

These tests are designed to run in CI/CD pipelines:
- No external dependencies required
- Fast execution (< 5 seconds)
- Clear failure messages
- Exit codes for pipeline integration

## Coverage Goals

- **Unit tests**: 80%+ coverage of business logic
- **Integration tests**: Critical paths covered
- **Config validation**: 100% coverage (fail-fast is critical)

## Troubleshooting

### Tests fail with "Cannot find module"
Ensure you've built the project:
```bash
npm run build
```

### Environment variable conflicts
Tests use `beforeEach` to reset env vars. If tests interfere with each other, check the setup.ts file.

### Mock not working
Verify the mock path matches the import path exactly:
```typescript
vi.mock('twilio', () => { ... });  // Correct
vi.mock('./twilio', () => { ... }); // Wrong if imported as 'twilio'
```

## Future Test Areas

As the IoC refactoring progresses:

- **Phase 2**: Tests for external client injection
- **Phase 3**: Tests for tool factory pattern
- **Phase 4**: Tests for IoC container

Each phase will add new test files following this structure.
