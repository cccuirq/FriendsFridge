import type { CollectionSchema } from 'deepspace/schema'

const noWrites = { create: false, update: false, delete: false } as const
const privateReadOnly = {
  '*': { read: false, ...noWrites },
  viewer: { read: false, ...noWrites },
  member: { read: 'own', ...noWrites },
  admin: { read: 'own', ...noWrites },
} as const
const owner = {
  name: 'ownerId', storage: 'text', interpretation: 'plain',
  required: true, immutable: true, userBound: true,
} as const
const t = (name: string) => ({ name, storage: 'text' as const, interpretation: 'plain' as const })
const n = (name: string) => ({ ...t(name), storage: 'number' as const })
const j = (name: string) => ({ ...t(name), interpretation: { kind: 'json' as const } })

export const mfSchemas: CollectionSchema[] = [
  {
    name: 'mf-conversations', ownerField: 'ownerId', permissions: privateReadOnly,
    uniqueOn: ['ownerId', 'importDay', 'importSlot'],
    columns: [owner, t('title'), t('surface'), t('selectedModel'), t('modelVersion'), t('provider'), t('taskType'),
      t('importState'), t('createdAt'), t('importDay'), n('importSlot'), n('turnCount')],
  },
  {
    name: 'mf-turns', ownerField: 'ownerId', permissions: privateReadOnly,
    columns: [owner, t('conversationId'), n('ordinal'), t('role'), t('content'), t('state'), t('sourceRevision')],
  },
  {
    name: 'mf-drafts', ownerField: 'ownerId', permissions: privateReadOnly,
    columns: [owner, t('conversationId'), j('selectedTurnIds'), t('sourceDigest'),
      j('candidates'), j('warnings'), t('reviewStatus'), t('createdAt'), t('modelId'), t('policyVersion'), t('parentCheckpointId')],
  },
  {
    name: 'mf-checkpoints', ownerField: 'ownerId', permissions: privateReadOnly,
    uniqueOn: ['ownerId', 'draftId'],
    columns: [owner, t('conversationId'), t('draftId'), t('parentCheckpointId'), t('sourceDigest'),
      j('selectedTurnIds'), j('facts'), t('handoffText'), t('approvedAt'), t('previewDigest')],
  },
  {
    name: 'mf-benchmark-questions', ownerField: 'ownerId', permissions: privateReadOnly,
    columns: [owner, t('conversationId'), t('threadId'), t('parentQuestionId'), j('selectedTurnIds'), t('sourceDigest'),
      j('generated'), j('candidate'), t('status'), t('createdAt'), t('approvedAt'), t('approvalDigest')],
  },
  {
    name: 'mf-model-profiles',
    permissions: { '*': { read: true, ...noWrites } },
    columns: [t('modelId'), t('modelVersion'), t('provider'), t('surface'),
      t('protocolId'), t('taskType'), t('subtaskType'), n('baselineTokens'), n('relativeThreshold'),
      j('buckets'), t('measuredAt')],
  },
]
