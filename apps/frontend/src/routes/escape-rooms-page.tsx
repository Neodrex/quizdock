import { useTranslation } from 'react-i18next';
import { PageTitle } from '@/components/ui/page-title';

/** /escape: the host's escape templates and "Create room" (M5). A stub until Task 5.8. */
export function EscapeRoomsPage() {
  const { t } = useTranslation('escape');
  return <PageTitle>{t('host.nav')}</PageTitle>;
}
