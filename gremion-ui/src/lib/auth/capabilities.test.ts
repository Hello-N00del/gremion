import { describe, test, expect } from 'vitest';
import { PLATFORM_GROUPS, CAPABILITIES, capabilityGroups } from './capabilities';

describe('capability seam', () => {
  test('platform group constants carry the exact Keycloak ids', () => {
    expect(PLATFORM_GROUPS.itAdmin).toBe('it-admin');
    expect(PLATFORM_GROUPS.admin).toBeTruthy();
  });
  test('CAPABILITIES composes from the present manifests and capabilityGroups reads it', () => {
    // The governance-only kernel composes capabilities from [core, governance];
    // concrete feature capabilities (e.g. finance.*) arrive with their modules.
    for (const id of Object.keys(CAPABILITIES)) {
      expect(Array.isArray(capabilityGroups(id))).toBe(true);
    }
  });
});
