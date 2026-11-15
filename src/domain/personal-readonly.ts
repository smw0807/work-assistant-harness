import type { ReadonlyEntryIdentity, ReadonlyParentIdentity, ReadonlyRange, ReadonlyRequest, ReadonlySnapshot } from './readonly-investigation.js';
import type { ReadonlyRelayPayload, ReadonlyRelayPlan } from './readonly-relay.js';

export const PERSONAL_READONLY_POLICY = 'personal-readonly-investigation-v1' as const;
export const PERSONAL_READONLY_INPUT_POLICY = 'personal-readonly-input-v1' as const;

/** Private local registration. Only the question and explicitly selected evidence may be transmitted. */
export interface PersonalReadonlyRegistration {
  version: 'personal-readonly-registration-v1';
  repoId: string;
  sourceRoot: string;
  baseCommit: string;
  question: string;
  readRanges: ReadonlyRange[];
  transferPaths: string[];
}

/** Selected worktree files and Git identity; unrelated working files are outside this observation scope. */
export interface PersonalReadonlyRepository {
  id: string;
  kind: 'personal-git';
  repoId: string;
  sourceRoot: string;
  baseCommit: string;
  sourceManifestHash: string;
  identityHash: string;
  manifest: ReadonlyEntryIdentity[];
  parents: ReadonlyParentIdentity[];
  readAllowedFiles: string[];
  gitEntries: ReadonlyEntryIdentity[];
  headRef: string | null;
}

export interface PersonalReadonlyRequest extends Omit<ReadonlyRequest, 'id'> { id: 'personal-question' }
export interface PersonalReadonlySnapshot extends Omit<ReadonlySnapshot, 'policy'> { policy: typeof PERSONAL_READONLY_POLICY }
export interface PersonalReadonlyPayload extends Omit<ReadonlyRelayPayload, 'repository' | 'request' | 'context' | 'profileId'> {
  repository: PersonalReadonlyRepository;
  registration: PersonalReadonlyRegistration;
  request: PersonalReadonlyRequest;
  context: PersonalReadonlySnapshot;
  profileId: 'codex-chatgpt-relay-v2';
}

/** Approval snapshots bind private identities by hash and never include the source root or filesystem manifest. */
export interface PersonalReadonlyPlan extends Omit<ReadonlyRelayPlan, 'policy' | 'fixtureId' | 'requestId' | 'profileId'> {
  policy: typeof PERSONAL_READONLY_POLICY;
  sourceKind: 'personal-git';
  registrationHash: string;
  inputPolicyVersion: typeof PERSONAL_READONLY_INPUT_POLICY;
  requestId: 'personal-question';
  profileId: 'codex-chatgpt-relay-v2';
}
