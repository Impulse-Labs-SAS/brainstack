// Which backlink read a caller gets, decided once so every transport (tRPC,
// MCP) makes the same call rather than each remembering separately that a
// cross-owner read needs masking that an own-vault read does not.
//
// `NoteService.listLinks` never checks who is asking — it is owner-scoped,
// not permission-aware, per its own contract. That is fine when the caller
// *is* the owner. When it is not (viewing a folder somebody else shared),
// every backlink's source must be checked individually: a folder can be
// shared only in part, so a source sitting in an ungranted sibling folder
// must not be named. `CrossOwnerReader.backlinksForOwner` is the one place
// that check happens.

import type { Backlink } from '@brainstack/core/pg';

import type { CrossOwnerReader } from '../services/CrossOwnerReader.js';
import type { NoteService } from '../services/NoteService.js';

export async function listBacklinksSafely(
  callerId: string,
  ownerId: string,
  path: string,
  deps: { notes: NoteService; crossOwner: CrossOwnerReader },
): Promise<Backlink[]> {
  if (callerId === ownerId) {
    return deps.notes.listLinks(ownerId, path);
  }
  return deps.crossOwner.backlinksForOwner(callerId, ownerId, path);
}
