import {
  getEscapeTemplatesControllerCreateSamplesUrl,
  getEscapeTemplatesControllerPublishUrl,
} from '../../../api/generated/escape-templates/escape-templates';
import type { EscapeTemplateListItemDto } from '../../../api/generated/model';
import { customFetch } from '../../../api/http';

/**
 * The picker's template writes, answered as list items (`?view=summary`): the host
 * console never receives a template's content, so never its answers (owner question 1).
 */

/** Adds the sample rooms (as drafts); the ones the host already has are skipped. */
export async function addSampleRooms(): Promise<EscapeTemplateListItemDto[]> {
  const res = await customFetch<{ data: EscapeTemplateListItemDto[] }>(
    getEscapeTemplatesControllerCreateSamplesUrl({ view: 'summary' }),
    { method: 'POST' },
  );
  return res.data;
}

/** Publishes a draft; refused with `escape_template.invalid` when it cannot be finished. */
export async function publishRoom(id: string): Promise<EscapeTemplateListItemDto> {
  const res = await customFetch<{ data: EscapeTemplateListItemDto }>(
    getEscapeTemplatesControllerPublishUrl(id, { view: 'summary' }),
    { method: 'POST' },
  );
  return res.data;
}

/** A template the picker can open: published, with content the server can read. */
export function canLaunch(t: Pick<EscapeTemplateListItemDto, 'status' | 'mode'>): boolean {
  return t.status === 'published' && t.mode !== null;
}
